/**
 * POST /api/bookmark — write a "Want to Try" bookmark to the user's Beli account.
 *
 * Body (JSON):
 *   name     (required) e.g. "Table Mercato"
 *   city     optional, e.g. "New York, NY" — narrows Beli search
 *   dry_run  optional bool — resolve the match but don't write
 *
 * Auth: Authorization: Bearer <API_KEY> (API_KEY env var).
 * Beli creds: BELI_EMAIL / BELI_PASSWORD env vars (server-side only).
 *
 * Pipeline:
 *   1. GET /api/user/logged-in/            -> user uuid
 *   2. GET /api/get-bookmark/              -> existing bookmark ids (dedup)
 *   3. GET /api/search-app/?term=&city=    -> candidate businesses
 *   4. Confidence gate: only an exact/near-exact normalized name match proceeds.
 *      Anything else returns status "ambiguous" with candidates — no write.
 *   5. POST /api/add-bookmark/ {user_id, business_id}
 *
 * Statuses: "bookmarked" | "already_bookmarked" | "would_bookmark" (dry_run)
 *           | "ambiguous" | "no_results" | error
 */
import { beliApiWithReauth, resultsOf } from "../lib/beli";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Lowercase alphanumeric only: "Table Mercato" -> "tablemercato". */
const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");

const first = (v: any) => (Array.isArray(v) ? v[0] : v);

/**
 * Confidence gate. Returns the matched business or null.
 * Accepts: exact normalized equality, or one normalized name containing the
 * other when the length ratio is sane (handles "Lucali" vs "Lucali Bk").
 */
function confidentMatch(
  searchName: string,
  businesses: any[]
): { business: any; score: number } | null {
  const target = norm(searchName);
  if (!target) return null;
  let best: { business: any; score: number } | null = null;
  for (const b of businesses) {
    const cand = norm(b?.name);
    if (!cand) continue;
    let score = 0;
    if (cand === target) score = 1;
    else if (
      (cand.includes(target) || target.includes(cand)) &&
      Math.min(cand.length, target.length) / Math.max(cand.length, target.length) >=
        0.6
    )
      score = 0.7;
    if (score > (best?.score ?? 0)) best = { business: b, score };
  }
  return best && best.score >= 0.7 ? best : null;
}

export default async function handler(req: any, res: any) {
  try {
    if (String(req.method ?? "").toUpperCase() !== "POST") {
      res.status(405).json({ error: "method not allowed; use POST" });
      return;
    }
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

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body ?? {};
    const name = String(first(body.name) ?? "").trim();
    const city = String(first(body.city) ?? "").trim() || undefined;
    const dryRun = body.dry_run === true || body.dry_run === "true";
    if (!name) {
      res.status(400).json({ error: "missing required field: name" });
      return;
    }

    const call = (path: string, opts?: { method?: "GET" | "POST"; body?: unknown }) =>
      beliApiWithReauth(path, email, password, opts);

    // user uuid
    const me = await call("/api/user/logged-in/");
    const meObj = resultsOf(me)[0] ?? me;
    const userUuid: string | undefined = meObj?.uuid ?? meObj?.id;
    if (!userUuid) {
      res.status(500).json({ error: "could not resolve logged-in user uuid" });
      return;
    }

    // existing bookmarks (dedup)
    const bmRaw = await call(`/api/get-bookmark/?user=${userUuid}&category=RES`);
    const bookmarkedIds = new Set(
      resultsOf(bmRaw)
        .map((item: any) => item?.business?.id ?? item?.business_id ?? item?.id)
        .filter((id: any) => id !== undefined && id !== null)
    );

    // search Beli (Google Places typeahead; predictions optionally carry a
    // Beli business id)
    const params = new URLSearchParams({ term: name, user: userUuid });
    if (city) params.set("city", city);
    const searchRaw = await call(`/api/search-app/?${params.toString()}`);
    const predictions: any[] = Array.isArray((searchRaw as any)?.predictions)
      ? (searchRaw as any).predictions
      : [];
    const named = predictions
      .map((p: any) => ({
        ...p,
        name: String(
          p?.structured_formatting?.main_text ?? p?.name ?? ""
        ).trim(),
        detail: String(
          p?.structured_formatting?.secondary_text ?? ""
        ).trim() || null,
      }))
      .filter((p: any) => p.name);
    if (!named.length) {
      res.status(200).json({ status: "no_results", name, city: city ?? null });
      return;
    }

    const match = confidentMatch(name, named);
    if (!match) {
      res.status(200).json({
        status: "ambiguous",
        name,
        city: city ?? null,
        candidates: named.slice(0, 5).map((p: any) => ({
          name: p.name,
          detail: p.detail,
        })),
      });
      return;
    }

    // resolve the winning prediction to a Beli business id
    const pred: any = match.business;
    let bizId: number | undefined =
      typeof pred.business === "number" ? pred.business : undefined;
    let bizName: string = pred.name;
    let bizNeighborhood: string | null = null;
    if (bizId === undefined && pred.place_id && !dryRun) {
      // get-or-create the Beli business from the Google place (real bookmark path)
      const created = await call(
        `/api/business/?place_id=${encodeURIComponent(pred.place_id)}`
      );
      const c0 = resultsOf(created)[0] ?? {};
      const full = (c0 as any)?.business ?? c0;
      bizId = full?.id;
      bizName = full?.name ?? pred.name;
      bizNeighborhood = full?.neighborhood ?? null;
    } else if (bizId !== undefined) {
      try {
        const d = await call(`/api/business/?id=${bizId}`);
        const d0 = resultsOf(d)[0] ?? {};
        const full = (d0 as any)?.business ?? d0;
        if (full?.id) {
          bizName = full?.name ?? pred.name;
          bizNeighborhood = full?.neighborhood ?? null;
        }
      } catch {
        /* keep prediction name */
      }
    }

    if (dryRun) {
      res.status(200).json({
        status: "would_bookmark",
        name,
        business: bizId
          ? { id: bizId, name: bizName, neighborhood: bizNeighborhood }
          : { name: pred.name, detail: pred.detail, place_id: pred.place_id },
      });
      return;
    }
    if (!bizId) {
      res.status(500).json({ error: "could not resolve a Beli business id" });
      return;
    }

    if (bookmarkedIds.has(bizId)) {
      res.status(200).json({
        status: "already_bookmarked",
        name,
        business: { id: bizId, name: bizName },
      });
      return;
    }

    await call("/api/add-bookmark/", {
      method: "POST",
      body: { user_id: userUuid, business_id: bizId },
    });
    res.status(200).json({
      status: "bookmarked",
      name,
      business: {
        id: bizId,
        name: bizName,
        neighborhood: bizNeighborhood,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "unknown error" });
  }
}
