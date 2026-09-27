/**
 * Minimal read-only Beli API client.
 *
 * Mirrors the behavior of the unofficial beli-api SDK (ProjectBarks/beli-api,
 * MIT) which is reverse-engineered from the Beli mobile app's traffic:
 *  - every request carries a realistic browser User-Agent and
 *    `Origin: capacitor://localhost` (the API 403s requests without them)
 *  - requests are spaced >=350ms apart (the API throttles bursts)
 *  - SimpleJWT auth: POST /api/token/ {email|phone_no, password} -> {access, refresh}
 *    access tokens last ~20 min; refresh tokens last 7 days and are not rotated.
 *
 * Tokens are cached in module scope so warm serverless invocations skip login.
 */

const API_HOST = "https://backoffice-service-t57o3dxfca-nn.a.run.app";
const ONBOARD_HOST =
  "https://backoffice-service-onboarding-t57o3dxfca-nn.a.run.app";
const ORIGIN = "capacitor://localhost";
const MIN_GAP_MS = 350;

const USER_AGENTS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 16; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.91 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
];
const randomUA = () =>
  USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// --- request pacing ---------------------------------------------------------
let lastCallAt = 0;
async function pace(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// --- token management -------------------------------------------------------
type TokenState = { access: string; refresh: string; accessExpMs: number };
let tokens: TokenState | null = null;

function jwtExpMs(jwt: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString("utf8")
    );
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function onboard(
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<any> {
  await pace();
  const res = await fetch(`${ONBOARD_HOST}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": randomUA(),
      Origin: ORIGIN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Beli ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Returns a valid access token, logging in or refreshing as needed. */
export async function ensureAccessToken(
  email: string,
  password: string
): Promise<string> {
  const now = Date.now();
  if (tokens && tokens.accessExpMs - now > 60_000) return tokens.access;

  if (tokens?.refresh) {
    try {
      const data = await onboard("/api/token/refresh/", "POST", {
        refresh: tokens.refresh,
      });
      const access: string = data.access;
      tokens = {
        access,
        refresh: tokens.refresh,
        accessExpMs: jwtExpMs(access) ?? now + 20 * 60_000,
      };
      return access;
    } catch {
      tokens = null; // refresh died; fall through to full login
    }
  }

  // Beli's token endpoint accepts either {email, password} or {phone_no, password}.
  const idTrimmed = email.trim();
  const isPhone =
    /^\+?[\d\s\-().]{7,20}$/.test(idTrimmed) && /\d/.test(idTrimmed) &&
    !idTrimmed.includes("@");
  const loginBody = isPhone
    ? { phone_no: idTrimmed, password }
    : { email: idTrimmed, password };
  const data = await onboard("/api/token/", "POST", loginBody);
  tokens = {
    access: data.access,
    refresh: data.refresh,
    accessExpMs: jwtExpMs(data.access) ?? now + 20 * 60_000,
  };
  return tokens.access;
}

/** Authenticated request against the main API host. */
export async function beliApi(
  path: string,
  accessToken: string,
  opts: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<any> {
  await pace();
  const res = await fetch(`${API_HOST}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": randomUA(),
      Origin: ORIGIN,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401) {
    const err: any = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Beli ${opts.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`
    );
  }
  return res.json();
}

/** Same as beliApi but retries once after re-auth on 401. */
export async function beliApiWithReauth(
  path: string,
  email: string,
  password: string,
  opts: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<any> {
  let access = await ensureAccessToken(email, password);
  try {
    return await beliApi(path, access, opts);
  } catch (e: any) {
    if (e?.status === 401) {
      tokens = null;
      access = await ensureAccessToken(email, password);
      return await beliApi(path, access, opts);
    }
    throw e;
  }
}

/** Unwrap Beli's {results: [...]} envelopes (or pass through raw arrays). */
export function resultsOf(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}
