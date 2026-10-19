/**
 * Google Analytics 4 reports for /admin, read with the GA4 Data API as a service account.
 * GA answers what Thread's own numbers can't: who visited the website, from where, and which
 * pages led to a download. Thread's own counts stay the source of truth for downloads, installs
 * and retention (see growth.ts); GA is attribution.
 *
 * Off until both are set on the API host:
 *   GA_PROPERTY_ID            the numeric property id (GA Admin > Property details), not G-XXXX
 *   GA_SERVICE_ACCOUNT_JSON   the service account key file's JSON; that account must be added to
 *                             the property as a Viewer
 * No SDK: a signed JWT is exchanged for an access token (RS256 via WebCrypto), cached ~50 min;
 * report results are cached 10 minutes.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface GaReport {
  connected: boolean;
  error: string | null;
  windowDays: number;
  totals: { users: number; newUsers: number; sessions: number; engagedSessions: number; downloadClicks: number; avgEngagementSeconds: number } | null;
  byDay: { day: string; users: number; sessions: number; downloadClicks: number }[];
  sources: { source: string; medium: string; sessions: number; users: number; downloadClicks: number }[];
  landingPages: { page: string; sessions: number; downloadClicks: number }[];
  countries: { country: string; users: number }[];
  devices: { device: string; users: number }[];
  fetchedAt: string | null;
}

const DOWNLOAD_EVENT = "file_download";

function config(): { propertyId: string; account: ServiceAccount } | null {
  const propertyId = process.env.GA_PROPERTY_ID?.trim();
  const raw = process.env.GA_SERVICE_ACCOUNT_JSON?.trim();
  if (!propertyId || !raw) return null;
  try {
    const account = JSON.parse(raw) as ServiceAccount;
    if (!account.client_email || !account.private_key) return null;
    return { propertyId: propertyId.replace(/^properties\//, ""), account };
  } catch {
    return null;
  }
}

export function gaConfigured(): boolean {
  return config() !== null;
}

const b64url = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? b : b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

let token: { value: string; until: number } | null = null;

async function accessToken(account: ServiceAccount, fetcher: typeof fetch): Promise<string> {
  if (token && Date.now() < token.until) return token.value;
  const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Buffer.from(pem, "base64"), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }),
  )}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, until: Date.now() + (body.expires_in - 600) * 1000 };
  return token.value;
}

interface Row { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }

async function runReport(propertyId: string, bearer: string, body: object, fetcher: typeof fetch): Promise<Row[]> {
  const res = await fetcher(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
    throw new Error(`GA ${res.status}${msg ? `: ${msg}` : ""}`);
  }
  return ((await res.json()) as { rows?: Row[] }).rows ?? [];
}

const num = (r: Row, i: number) => Number(r.metricValues?.[i]?.value ?? 0);
const dim = (r: Row, i: number) => r.dimensionValues?.[i]?.value ?? "";

let cache: { key: string; at: number; data: GaReport } | null = null;

export async function gaReport(windowDays = 30, fetcher: typeof fetch = fetch): Promise<GaReport> {
  const base: GaReport = { connected: false, error: null, windowDays, totals: null, byDay: [], sources: [], landingPages: [], countries: [], devices: [], fetchedAt: null };
  const cfg = config();
  if (!cfg) return base;
  const key = `${cfg.propertyId}|${windowDays}`;
  if (cache && cache.key === key && Date.now() - cache.at < 10 * 60_000) return cache.data;
  try {
    const bearer = await accessToken(cfg.account, fetcher);
    const dateRanges = [{ startDate: `${windowDays}daysAgo`, endDate: "today" }];
    const downloads = { filter: { fieldName: "eventName", stringFilter: { value: DOWNLOAD_EVENT } } };
    const run = (body: object) => runReport(cfg.propertyId, bearer, { dateRanges, ...body }, fetcher);
    const [totals, dlTotal, byDay, dlByDay, sources, dlBySource, pages, dlByPage, countries, devices] = await Promise.all([
      run({ metrics: [{ name: "totalUsers" }, { name: "newUsers" }, { name: "sessions" }, { name: "engagedSessions" }, { name: "userEngagementDuration" }] }),
      run({ metrics: [{ name: "eventCount" }], dimensionFilter: downloads }),
      run({ dimensions: [{ name: "date" }], metrics: [{ name: "totalUsers" }, { name: "sessions" }], orderBys: [{ dimension: { dimensionName: "date" } }] }),
      run({ dimensions: [{ name: "date" }], metrics: [{ name: "eventCount" }], dimensionFilter: downloads }),
      run({ dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 15 }),
      run({ dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }], metrics: [{ name: "eventCount" }], dimensionFilter: downloads, limit: 50 }),
      run({ dimensions: [{ name: "landingPagePlusQueryString" }], metrics: [{ name: "sessions" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 12 }),
      run({ dimensions: [{ name: "landingPagePlusQueryString" }], metrics: [{ name: "eventCount" }], dimensionFilter: downloads, limit: 50 }),
      run({ dimensions: [{ name: "country" }], metrics: [{ name: "totalUsers" }], orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }], limit: 12 }),
      run({ dimensions: [{ name: "deviceCategory" }], metrics: [{ name: "totalUsers" }], orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }] }),
    ]);
    const t = totals[0];
    const dlDay = new Map(dlByDay.map((r) => [dim(r, 0), num(r, 0)]));
    const dlSrc = new Map(dlBySource.map((r) => [`${dim(r, 0)}|${dim(r, 1)}`, num(r, 0)]));
    const dlPage = new Map(dlByPage.map((r) => [dim(r, 0), num(r, 0)]));
    const isoDay = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const data: GaReport = {
      connected: true,
      error: null,
      windowDays,
      totals: t
        ? {
            users: num(t, 0), newUsers: num(t, 1), sessions: num(t, 2), engagedSessions: num(t, 3),
            downloadClicks: dlTotal[0] ? num(dlTotal[0], 0) : 0,
            avgEngagementSeconds: num(t, 0) ? Math.round(num(t, 4) / num(t, 0)) : 0,
          }
        : null,
      byDay: byDay.map((r) => ({ day: isoDay(dim(r, 0)), users: num(r, 0), sessions: num(r, 1), downloadClicks: dlDay.get(dim(r, 0)) ?? 0 })),
      sources: sources.map((r) => ({ source: dim(r, 0), medium: dim(r, 1), sessions: num(r, 0), users: num(r, 1), downloadClicks: dlSrc.get(`${dim(r, 0)}|${dim(r, 1)}`) ?? 0 })),
      landingPages: pages.map((r) => ({ page: dim(r, 0), sessions: num(r, 0), downloadClicks: dlPage.get(dim(r, 0)) ?? 0 })),
      countries: countries.map((r) => ({ country: dim(r, 0), users: num(r, 0) })),
      devices: devices.map((r) => ({ device: dim(r, 0), users: num(r, 0) })),
      fetchedAt: new Date().toISOString(),
    };
    cache = { key, at: Date.now(), data };
    return data;
  } catch (e) {
    return { ...base, connected: true, error: e instanceof Error ? e.message : String(e) };
  }
}
