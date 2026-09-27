/**
 * GET /api/recs — read-only Beli restaurant recommendations.
 *
 * Query params:
 *   neighborhood  (required) e.g. "Greenwich Village"
 *   day           YYYY-MM-DD or English day name ("Saturday"); default: today (ET)
 *   time          "19:00" / "7pm" / "7:30 PM"; optional — checks open status at that time
 *   table_size    default 2
 *   limit         default 10, max 20
 *
 * Auth: Authorization: Bearer <API_KEY> (API_KEY env var).
 * Beli creds: BELI_EMAIL / BELI_PASSWORD env vars (server-side only).
 *
 * Pipeline: bookmarks (ranked by your scores) first, then Beli trending to fill.
 * Each rec carries hours for the day, open-at-time status, and real reservation
 * slots + platforms from Beli's availability endpoint.
 */
import { beliApiWithReauth, resultsOf } from "../lib/beli";

const TZ = "America/New_York";

// --- tiny utils ---------------------------------------------------------------
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const norm = (s: unknown) => String(s ?? "").toLowerCase().trim();
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

/** Wall-clock "now" in ET as a Date whose getDay()/getHours() are ET-based. */
function etNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}
function etDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY_NAMES = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];
function resolveDay(dayParam: string | undefined): string {
  const now = etNow();
  if (!dayParam) return etDateString(now);
  const m = dayParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return dayParam;
  const idx = DAY_NAMES.indexOf(norm(dayParam).slice(0, 9));
  if (idx === -1) throw new Error(`Unrecognized day: ${dayParam}`);
  const delta = (idx - now.getDay() + 7) % 7; // today if it matches
  const d = new Date(now);
  d.setDate(d.getDate() + delta);
  return etDateString(d);
}

function parseTimeToMins(t: string | undefined): number | null {
  if (!t) return null;
  const m = norm(t).match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] ?? "0", 10);
  const ap = m[3];
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + min;
}
function fmtMins(mins: number): string {
  let h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

// --- hours --------------------------------------------------------------------
type Hours = {
  open_day: number;
  close_day: number;
  open_time: string;
  close_time: string;
};
// NOTE: day numbering assumed 0=Sunday..6=Saturday (JS/Capacitor convention).
// Calibrated against live data during testing.

function entryCovers(
  e: Hours,
  dayIdx: number,
  mins: number | null
): boolean {
  const open = parseTimeToMins(e.open_time);
  const close = parseTimeToMins(e.close_time);
  if (open === null || close === null) return false;
  const overnight = close <= open || e.close_day !== e.open_day;
  if (mins === null) return e.open_day === dayIdx || (overnight && e.close_day === dayIdx);
  if (!overnight) return e.open_day === dayIdx && mins >= open && mins < close;
  // overnight: open evening of open_day, or early morning of close_day
  return (
    (e.open_day === dayIdx && mins >= open) ||
    (e.close_day === dayIdx && mins < close)
  );
}

function hoursSummary(
  sets: Hours[],
  dayIdx: number,
  mins: number | null
): { label: string | null; open: boolean | null } {
  if (!sets.length) return { label: null, open: null };
  const todays = sets.filter((e) => e.open_day === dayIdx);
  const label = todays.length
    ? todays
        .map((e) => {
          const o = parseTimeToMins(e.open_time);
          const c = parseTimeToMins(e.close_time);
          return o !== null && c !== null ? `${fmtMins(o)} – ${fmtMins(c)}` : null;
        })
        .filter(Boolean)
        .join(", ") || null
    : null;
  const open =
    mins === null
      ? todays.length > 0 || sets.some((e) => e.close_day === dayIdx && (parseTimeToMins(e.close_time) ?? 0) > (parseTimeToMins(e.open_time) ?? 0))
      : sets.some((e) => entryCovers(e, dayIdx, mins));
  return { label, open };
}

// --- availability parsing (defensive: shape not pinned in spec) ----------------
function collectTimeLikes(node: any, out: string[]): void {
  if (typeof node === "string") {
    if (/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(node.trim())) out.push(node.trim());
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectTimeLikes(v, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectTimeLikes(v, out);
  }
}
function slotsForBusiness(payload: any, businessId: number): string[] {
  const out: string[] = [];
  const idStr = String(businessId);
  const scan = (node: any) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const s = JSON.stringify(item);
        if (s.includes(idStr)) collectTimeLikes(item, out);
      }
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k.includes(idStr)) collectTimeLikes(v, out);
        else scan(v);
      }
    }
  };
  scan(payload);
  return [...new Set(out)].slice(0, 12);
}

// --- handler ------------------------------------------------------------------
export default async function handler(req: any, res: any) {
  try {
    const apiKey = process.env.API_KEY ?? "";
    const auth = String(req.headers?.authorization ?? "");
    if (!apiKey || !safeEqual(auth.replace(/^Bearer\s+/i, ""), apiKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const email = process.env.BELI_EMAIL ?? "";
    const password = process.env.BELI_PASSWORD ?? "";
    if (!email || !password) {
      res.status(500).json({
        error: "Beli credentials not configured (set BELI_EMAIL / BELI_PASSWORD env vars)",
      });
      return;
    }

    const q = req.query ?? {};
    const neighborhood = first(q.neighborhood as any);
    if (!neighborhood) {
      res.status(400).json({ error: "missing required param: neighborhood" });
      return;
    }
    const dateStr = resolveDay(first(q.day as any));
    const timeStr = first(q.time as any) ?? null;
    const timeMins = parseTimeToMins(timeStr ?? undefined);
    const tableSize = Math.max(1, parseInt(first(q.table_size as any) ?? "2", 10) || 2);
    const limit = Math.min(20, Math.max(1, parseInt(first(q.limit as any) ?? "10", 10) || 10));

    const call = (path: string, opts?: { method?: "GET" | "POST"; body?: unknown }) =>
      beliApiWithReauth(path, email, password, opts);

    // user uuid (for trending)
    const me = await call("/api/user/logged-in/");
    const meObj = resultsOf(me)[0] ?? me;
    const userUuid: string | undefined = meObj?.uuid ?? meObj?.id;

    // bookmarks + trending in parallel-ish (sequential w/ pacing inside client)
    const [bmRaw, trRaw] = await Promise.all([
      call("/api/get-bookmark/"),
      userUuid ? call(`/api/trending/${userUuid}/`) : Promise.resolve({ results: [] }),
    ]);
    const bookmarkItems = resultsOf(bmRaw);
    const trendingItems = resultsOf(trRaw);

    const bizOf = (item: any) => item?.business ?? item;
    const scoreOf = (item: any) =>
      item?.score ?? item?.rank_score ?? item?.rating ?? item?.business?.score ?? 0;

    const nq = norm(neighborhood);
    const inArea = (b: any) =>
      [b?.neighborhood, b?.borough, b?.city].some((f) => {
        const nf = norm(f);
        return nf && (nf.includes(nq) || nq.includes(nf));
      });

    const bookmarked = bookmarkItems
      .map((item) => ({ item, b: bizOf(item) }))
      .filter(({ b }) => b?.id && inArea(b))
      .sort((a, b2) => scoreOf(b2.item) - scoreOf(a.item));

    const seen = new Set(bookmarked.map(({ b }) => b.id));
    const trending = trendingItems
      .map((item) => ({ item, b: bizOf(item) }))
      .filter(({ b }) => b?.id && inArea(b) && !seen.has(b.id));

    const finalists = [...bookmarked, ...trending].slice(0, limit);

    // day index for hours (0=Sunday..6=Saturday, ET)
    const [yy, mm, dd] = dateStr.split("-").map(Number);
    const dayIdx = new Date(yy, mm - 1, dd).getDay();

    // fill in hours where the list item didn't embed them
    for (const f of finalists) {
      if (!f.b?.businesshours_set?.length && f.b?.id) {
        try {
          const detail = await call(`/api/business/?id=${f.b.id}`);
          const d = resultsOf(detail)[0] ?? {};
          f.b = { ...f.b, ...(d.business ?? d) };
        } catch {
          /* keep going without hours */
        }
      }
    }

    // bulk reservation availability for the date
    let availPayload: any = null;
    try {
      const body: any = {
        business_ids: finalists.map((f) => f.b.id),
        date: dateStr,
        table_size: tableSize,
      };
      if (timeStr) body.time = timeStr;
      availPayload = await call("/api/businesses-res-availability/", {
        method: "POST",
        body,
      });
    } catch {
      /* availability optional; recs still useful without it */
    }

    const recs = finalists.map(({ item, b }, i) => {
      const sets: Hours[] = b.businesshours_set ?? [];
      const { label, open } = hoursSummary(sets, dayIdx, timeMins);
      const platforms = b.reservation_platforms
        ? Object.keys(b.reservation_platforms)
        : [];
      return {
        name: b.name,
        id: b.id,
        source: i < bookmarked.length ? "bookmark" : "trending",
        neighborhood: b.neighborhood ?? null,
        borough: b.borough ?? null,
        cuisines: b.cuisines ?? [],
        price: b.price ?? null,
        hours_today: label,
        open_at_time: open,
        reservation: {
          has_links: Boolean(b.has_res_links ?? platforms.length > 0),
          platforms,
          slots: availPayload ? slotsForBusiness(availPayload, b.id) : [],
        },
      };
    });

    res.status(200).json({
      neighborhood,
      date: dateStr,
      time: timeStr,
      table_size: tableSize,
      recs,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "unknown error" });
  }
}
