/**
 * Cloudflare Worker — Email Cache Proxy
 * 
 * Features:
 * - Validates session tokens (HMAC-SHA256)
 * - Multi-KV namespace support (EMAIL_CACHE_V2 -> EMAIL_CACHE fallback)
 * - Supabase fetch-emails proxy + KV cache support
 * - Proper error logging for KV failures
 * 
 * Runtime configuration:
 *   Supabase URL + anon key are public and built in so this Worker can run on
 *   any Cloudflare account without manual env/secrets injection. Optional env
 *   vars still override them for forks/custom projects.
 * 
 * KV Namespace Bindings:
 *   EMAIL_CACHE (primary), EMAIL_CACHE_V2 (optional secondary)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token, X-Pending-Token, X-Cron-Secret, X-Worker-Config-Secret, Cache-Control",
};

const DEFAULT_SUPABASE_URL = "https://jsqchutnfdeljajkxmly.supabase.co";
const DEFAULT_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA";

function supabaseUrl(env) {
  return env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
}

function supabaseKey(env) {
  return env.SUPABASE_KEY || env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_KEY;
}

// Keep the original unversioned keys so already-cached worker emails remain visible.
const CACHE_SCHEMA_VERSION = "classic";
const LEGACY_CACHE_SCHEMA_VERSIONS = ["v3", "v2", "v1"];
const CACHE_KEY = "emails_list";
const CACHE_TIMESTAMP_KEY = "emails_timestamp";
const WORKER_CONFIG_KEY = "inbox_worker_config:v1";
const STALE_SECONDS = 3;

// --- KV helpers: use V2 if available, fallback to V1 ---
function getKV(env) {
  return env.EMAIL_CACHE_V2 || env.EMAIL_CACHE || null;
}

async function kvGet(env, key) {
  const kv = getKV(env);
  if (!kv) return null;
  try {
    return await kv.get(key);
  } catch (err) {
    console.error(`KV read error (key=${key}):`, err.message || err);
    return null;
  }
}

async function kvPut(env, key, value) {
  const kv = getKV(env);
  if (!kv) return false;
  try {
    await kv.put(key, value);
    return true;
  } catch (err) {
    console.error(`KV write error (key=${key}):`, err.message || err);
    // Try the other KV if V2 failed
    if (env.EMAIL_CACHE_V2 && env.EMAIL_CACHE) {
      try {
        await env.EMAIL_CACHE.put(key, value);
        console.log(`KV fallback write succeeded for key=${key}`);
        return true;
      } catch (err2) {
        console.error(`KV fallback write also failed:`, err2.message || err2);
      }
    }
    return false;
  }
}

// --- Session verification ---
async function verifySessionToken(token, secret) {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function hydrateSessionFromSupabase(env, token, request) {
  if (!token) return null;
  const key = supabaseKey(env);
  try {
    const res = await fetch(`${supabaseUrl(env)}/functions/v1/manage-app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
        "apikey": key,
        "X-Session-Token": token,
        ...(request?.headers?.get("user-agent") ? { "User-Agent": request.headers.get("user-agent") } : {}),
      },
      body: JSON.stringify({ action: "me" }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const user = data?.user;
    if (!user?.id) return null;
    return {
      userId: user.id,
      role: user.role,
      assignedAccounts: Array.isArray(user.assignedAccounts) ? user.assignedAccounts : [],
      isFree: !!user.isFree,
      impersonated: user.impersonated === true,
      adminId: user.adminId || null,
    };
  } catch {
    return null;
  }
}

function parseEmailList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.emails)) return parsed.emails;
    return [];
  } catch {
    return null;
  }
}

function hasRawMimeMarkers(raw) {
  return /Content-Transfer-Encoding|quoted-printable|MIME-Version:|Content-Type:|=_Part_|--[A-Za-z0-9'_()+,./:=?-]{8,}/i.test(String(raw || ""));
}

function cachePrefixes() {
  return [
    { list: CACHE_KEY, ts: CACHE_TIMESTAMP_KEY },
    ...LEGACY_CACHE_SCHEMA_VERSIONS.map((version) => ({ list: `emails_list:${version}`, ts: `emails_timestamp:${version}` })),
  ];
}

// SECURITY: only ever probe cache keys scoped to the SAME userAccountsKey.
// Never fall back to `:all` or any other user's scope — cross-scope reads
// leaked other accounts' emails (password resets, payments, etc.) to a
// fresh profile that had no cache entry of its own yet.
function candidateCacheKeys(userAccountsKey, limit) {
  return cachePrefixes().flatMap(({ list }) => [
    `${list}:${userAccountsKey}:limit:${limit}`,
    `${list}:${userAccountsKey}:limit:200`,
    `${list}:${userAccountsKey}:limit:50`,
    `${list}:${userAccountsKey}:limit:3`,
    `${list}:${userAccountsKey}`,
  ]).filter((key, index, arr) => arr.indexOf(key) === index);
}

async function readBestCachedRaw(env, userAccountsKey, limit, skipKey = "") {
  for (const key of candidateCacheKeys(userAccountsKey, limit)) {
    if (key === skipKey) continue;
    const raw = await kvGet(env, key);
    if (raw) return { key, raw };
  }
  return null;
}

const DEFAULT_EMAIL_FILTERS = { showSignInCodes: true, showPasswordResets: true, showAccountUpdates: true };
const WORKER_ACCOUNT_UPDATE_RE = /(attention|action (needed|required)|account (information|info|details) (was |has been )?(changed|updated)|changes? to your account|email (address )?(was |has been )?(changed|updated)|new email address|email verification|verification email|verify (your )?(email address|phone number|mobile number|account)|confirm (your )?(email address|phone number|mobile number|account change|account)|membership (was |has been )?(cancell?ed|updated|paused)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold)|we[’']re sorry to see you go|payment (received|method|was|has been|declined|failed|updated|changed)|mobile (number )?(confirm|confirmed|verify|verified|update|updated)|phone (number )?(confirm|confirmed|verify|verified|update|updated)|verify (your )?(phone|mobile|email)|verify your email address|action needed: verify|request to make a change|update your account|make (a |any )?(change|changes) to your account)/i;
const WORKER_PASSWORD_RESET_RE = /(password (was |has been )?(changed|reset|updated)|reset your password|forgot password|password reset|new password|account recovery)/i;
const WORKER_SIGNIN_RE = /(sign[\s-]?in code|new sign[\s-]?in|new device|temporary access code|is using your account|access your account|verification code|login code|enter this code|otp)/i;

function normalizeEmailFilters(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    showSignInCodes: v.showSignInCodes === false ? false : true,
    showPasswordResets: v.showPasswordResets === false ? false : true,
    showAccountUpdates: v.showAccountUpdates === false ? false : true,
  };
}

async function readWorkerEmailFilters(env, rawToken = "") {
  if (rawToken) {
    try {
      const key = supabaseKey(env);
      const res = await fetch(`${supabaseUrl(env)}/functions/v1/manage-app`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
          "apikey": key,
          "X-Session-Token": rawToken,
        },
        body: JSON.stringify({ action: "get_settings", key: "email_filters" }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        return normalizeEmailFilters(data?.value);
      }
    } catch {}
  }
  try {
    const raw = await kvGet(env, WORKER_CONFIG_KEY);
    if (!raw) return DEFAULT_EMAIL_FILTERS;
    const config = JSON.parse(raw);
    return normalizeEmailFilters(config?.email_filters);
  } catch {
    return DEFAULT_EMAIL_FILTERS;
  }
}

function classifyWorkerEmail(email) {
  const text = `${email?.subject || ""} ${email?.preview || ""}`;
  if (WORKER_ACCOUNT_UPDATE_RE.test(text)) return "account_update";
  if (WORKER_PASSWORD_RESET_RE.test(text)) return "password_reset";
  if (email?.otp || WORKER_SIGNIN_RE.test(text)) return "signin";
  return "other";
}

function applyWorkerFilters(list, filters, session) {
  if (!Array.isArray(list) || !session || session.role === "admin") return list;
  const normalized = normalizeEmailFilters(filters);
  const hideSignin = normalized.showSignInCodes === false;
  const hideReset = normalized.showPasswordResets !== true;
  const hideAccountUpdate = normalized.showAccountUpdates !== true;
  return list.filter((email) => {
    const cat = classifyWorkerEmail(email);
    if (hideSignin && cat === "signin") return false;
    if (hideReset && cat === "password_reset") return false;
    if (hideAccountUpdate && cat === "account_update") return false;
    if (hideReset && hideAccountUpdate && cat === "other") return false;
    return true;
  });
}

// Defence-in-depth: even if a cache entry somehow contains cross-account
// rows (legacy KV writes, admin-scope entries, corrupted merges), strip
// anything outside the caller's assigned accounts before returning.
function enforceScopeOnRaw(raw, session, filters = DEFAULT_EMAIL_FILTERS) {
  if (!raw || !session || session.role === "admin") return raw;
  const allowed = Array.isArray(session.assignedAccounts) ? session.assignedAccounts : [];
  const allowSet = new Set(allowed.map((s) => String(s || "").trim()).filter(Boolean));
  const list = parseEmailList(raw);
  if (!Array.isArray(list)) return raw;
  const scoped = list.filter((e) => {
    const label = String(e?.account_label || "").trim();
    // If the row has no label we cannot verify ownership → drop it.
    if (!label) return false;
    return allowSet.has(label);
  });
  const filtered = applyWorkerFilters(scoped, filters, session);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.emails)) {
      return JSON.stringify({ ...parsed, emails: filtered, totalFetched: filtered.length });
    }
  } catch {}
  return JSON.stringify(filtered);
}

function mergeEmailPayloads(existingRaw, incomingRaw) {
  if (!existingRaw) return null;
  const existingEmails = parseEmailList(existingRaw);
  const incomingEmails = parseEmailList(incomingRaw);

  if (!existingEmails || !incomingEmails) return null;

  const emailMap = new Map();
  for (const email of [...incomingEmails, ...existingEmails]) {
    if (email?.id) emailMap.set(email.id, email);
  }

  return JSON.stringify(
    Array.from(emailMap.values()).sort(
      (a, b) => new Date(b?.date || 0).getTime() - new Date(a?.date || 0).getTime()
    )
  );
}

// --- Main handler ---
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const sessionToken = request.headers.get("X-Session-Token") || request.headers.get("x-session-token");
    let session = null;

    // F5: prefer the dedicated SESSION_SIGNING_SECRET; fall back to legacy
    // SESSION_SECRET (which used to be the Supabase service-role key) so
    // sessions issued before the rotation still verify until they expire.
    const signingPrimary = env.SESSION_SIGNING_SECRET || env.SESSION_SECRET;
    const signingLegacy = env.SESSION_SECRET;
    const hasSigning = !!signingPrimary;

    if (url.pathname === "/api/config/update" && request.method === "POST") {
      const provided = request.headers.get("X-Worker-Config-Secret") || request.headers.get("x-worker-config-secret") || "";
      if (!signingPrimary || provided !== signingPrimary) {
        return new Response(JSON.stringify({ success: false, error: "Forbidden" }), {
          status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      if (!getKV(env)) {
        return new Response(JSON.stringify({ success: false, error: "KV is not configured" }), {
          status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      let body = null;
      try { body = await request.json(); } catch {}
      if (!body || typeof body !== "object") {
        return new Response(JSON.stringify({ success: false, error: "Invalid config" }), {
          status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      await kvPut(env, WORKER_CONFIG_KEY, JSON.stringify({ ...body, savedAt: Date.now() }));
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (sessionToken && signingPrimary) {
      session = await verifySessionToken(sessionToken, signingPrimary);
      if (!session && signingLegacy && signingLegacy !== signingPrimary) {
        session = await verifySessionToken(sessionToken, signingLegacy);
      }
    }

    // Universal Cloudflare mode: if signing secrets were not injected, validate
    // the token through Supabase instead of failing local HMAC verification.
    if (sessionToken && !session) {
      session = await hydrateSessionFromSupabase(env, sessionToken, request);
    }

    if ((url.pathname === "/api/emails" || url.pathname === "/api/emails/sync") && !session) {
      if (sessionToken) {
        return new Response(JSON.stringify({ error: "Invalid session" }), {
          status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }


    if (url.pathname === "/api/emails" && request.method === "GET") {
      const bust = url.searchParams.get("bust") === "1" || url.searchParams.get("bust") === "true";
      const limit = clampLimit(url.searchParams.get("limit"), 3, 200);
      const accountLabels = url.searchParams.getAll("accountLabel").map(v => v.trim()).filter(Boolean);
      return handleGetEmails(env, session, sessionToken, { bust, limit, accountLabels });
    }

    if (url.pathname === "/api/emails/sync" && request.method === "POST") {
      let reqBody = {};
      try { reqBody = await request.clone().json(); } catch {}
      return handleSync(env, session, sessionToken, reqBody, ctx);
    }

    if (url.pathname === "/api/cache/purge" && request.method === "POST") {
      return handleCachePurge(env, session);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response(JSON.stringify({
        ok: true,
        version: CACHE_SCHEMA_VERSION,
        kv: !!getKV(env),
        signing: !!(env.SESSION_SIGNING_SECRET || env.SESSION_SECRET),
        ts: Date.now(),
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    // F6: /api/debug removed. It disclosed whether SESSION_SECRET / KV bindings
    // were configured, which helped attackers detect when worker auth was off.
    // If you need it back for local debugging, gate it behind env.DEBUG_TOKEN.




    // Immutable-HTML cache: single most impactful egress cut. Email HTML never
    // changes after IMAP ingest, so we can KV-cache forever. Authz enforced
    // via session.assignedAccounts / role on cache HIT; MISS forwards to
    // Supabase manage-app (X-Cron-Secret marks trusted-proxy for plaintext).
    if (url.pathname === "/api/inbox/html" && request.method === "POST") {
      return handleInboxHtml(request, env, session, sessionToken, ctx);
    }

    // Notifications list — per-user KV cache (60s TTL). Cuts Supabase
    // invocations ~95% at 5000 users. Etag-aware so mid-cache-window changes
    // still surface via 304-equivalent path on cache expiry.
    if (url.pathname === "/api/notifications/list" && request.method === "POST") {
      return handleNotificationsList(request, env, session, sessionToken, ctx);
    }

    // Cache buster called after any mark/read/delete write — invalidates
    // the user's KV entry so the next poll picks up the change immediately.
    if (url.pathname === "/api/notifications/invalidate" && request.method === "POST") {
      return handleNotificationsInvalidate(env, session);
    }

    // Public bootstrap — cached at the edge with ETag. This is the highest-
    // volume DB read in the project (~470k calls / audit window). Serving it
    // from KV + 304 responses collapses DB reads to a single fetch per TTL
    // window regardless of concurrent client count.
    if (url.pathname === "/api/bootstrap" && (request.method === "GET" || request.method === "POST")) {
      return handleBootstrapPublic(request, env, ctx);
    }

    // Inbox list_delta — per-user KV cache (30s TTL). Cursor-based diffs so
    // steady-state polling collapses to an empty {rows:[],removedIds:[]} body
    // served from KV, cutting cached_emails DB reads by ~97%.
    if (url.pathname === "/api/inbox/list" && request.method === "POST") {
      return handleInboxList(request, env, session, sessionToken, ctx);
    }





    // Proxy manage-app and other edge functions through worker
    if (url.pathname.startsWith("/api/fn/") && request.method === "POST") {
      const fnName = url.pathname.replace("/api/fn/", "");
      return handleFunctionProxy(request, env, fnName);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },

  // Cron/scheduled handler — same as the uploaded worker: proxy sync to Supabase, then refresh KV.
  async scheduled(event, env, ctx) {
    console.log("[cron] Scheduled sync triggered at", new Date().toISOString());
    try {
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey(env)}`,
        "apikey": supabaseKey(env),
        ...(env.CRON_SHARED_SECRET ? { "X-Cron-Secret": env.CRON_SHARED_SECRET } : {}),
      };

      const res = await fetch(`${supabaseUrl(env)}/functions/v1/fetch-emails`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "sync", source: "cron" }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("[cron] Sync failed:", res.status, text);
        return;
      }

      const cacheRes = await fetch(`${supabaseUrl(env)}/functions/v1/fetch-emails`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "cache" }),
      });

      if (cacheRes.ok) {
        const cacheData = await cacheRes.text();
        await Promise.all([
          kvPut(env, `${CACHE_KEY}:all`, cacheData),
          kvPut(env, `${CACHE_TIMESTAMP_KEY}:all`, Date.now().toString()),
        ]);
        console.log("[cron] Cache updated successfully");
      }
    } catch (err) {
      console.error("[cron] Error:", err);
    }
  },
};

function diagHeaders(extra = {}) {
  const base = {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Cache-Version": CACHE_SCHEMA_VERSION,
    "Access-Control-Expose-Headers": "X-Cache-Status, X-Cache-Age, X-Cache-Version, X-Worker-Endpoint, X-Cache-Key",
  };
  return { ...base, ...extra };
}

function clampLimit(value, fallback = 3, max = 50) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function handleGetEmails(env, session, rawToken, opts = {}) {
  const hasKV = !!getKV(env);
  const bust = !!opts.bust;
  const limit = clampLimit(opts.limit, 3, 200);
  const accountLabels = Array.isArray(opts.accountLabels) ? opts.accountLabels : [];
  const filters = await readWorkerEmailFilters(env, rawToken);

  if (!hasKV) {
    return fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
  }

  const scopedLabels = accountLabels.length > 0 ? accountLabels : (session?.assignedAccounts || []);
  // SECURITY: without a verified session we cannot enforce per-user scope
  // — refuse rather than fall back to the shared `:all` bucket.
  if (!session) {
    return new Response(JSON.stringify({ error: "auth required" }), {
      status: 401, headers: diagHeaders(),
    });
  }
  // Non-admin with zero assigned accounts must never share the `:all` KV
  // bucket (which is populated by the cron job with ADMIN-scope emails
  // from every account). Return an empty list immediately.
  if (session.role !== "admin" && scopedLabels.length === 0) {
    return new Response("[]", { headers: diagHeaders({ "X-Cache-Status": "EMPTY_SCOPE" }) });
  }
  const userAccountsKey = scopedLabels.length > 0 ? JSON.stringify([...scopedLabels].sort()) : "all";
  const cacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`;
  const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

  // bust=1 → skip KV read, reload the existing Supabase cache, write back, return with BYPASS status.
  if (bust) {
    const result = await fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
    if (result.status === 200) {
      const body = enforceScopeOnRaw(await result.clone().text(), session, filters);
      await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, Date.now().toString())]);
      return new Response(body, { status: 200, headers: diagHeaders({ "X-Cache-Status": "BYPASS", "X-Cache-Key": cacheKey }) });
    }
    return result;
  }

  const [cached, timestamp] = await Promise.all([kvGet(env, cacheKey), kvGet(env, tsKey)]);
  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  if (!cached) {
    const fallback = await readBestCachedRaw(env, userAccountsKey, limit, cacheKey);
    if (fallback?.raw) {
      const safeRaw = enforceScopeOnRaw(fallback.raw, session, filters);
      await Promise.all([kvPut(env, cacheKey, safeRaw), kvPut(env, tsKey, Date.now().toString())]);
      if (hasRawMimeMarkers(safeRaw)) {
        const result = await fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
        if (result.status === 200) {
          const body = enforceScopeOnRaw(await result.clone().text(), session, filters);
          await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, Date.now().toString())]);
          return new Response(body, { status: 200, headers: diagHeaders({ "X-Cache-Status": "BYPASS_RAW_MIME", "X-Cache-Key": cacheKey }) });
        }
      }
      return new Response(safeRaw, { headers: diagHeaders({ "X-Cache-Status": "FALLBACK_HIT", "X-Cache-Key": fallback.key }) });
    }
    const result = await fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
    if (result.status === 200) {
      const body = enforceScopeOnRaw(await result.clone().text(), session, filters);
      await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, now.toString())]);
      return new Response(body, { status: 200, headers: diagHeaders({ "X-Cache-Status": "MISS", "X-Cache-Key": cacheKey }) });
    }
    return result;
  }

  let status = "HIT";
  if (age > STALE_SECONDS) {
    status = "STALE";
    refreshFromSupabase(env, session, rawToken, cacheKey, tsKey, { accountLabels, limit }).catch(err => console.error("BG refresh error:", err));
  }

  if (hasRawMimeMarkers(cached)) {
    const result = await fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
    if (result.status === 200) {
      const body = enforceScopeOnRaw(await result.clone().text(), session, filters);
      await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, Date.now().toString())]);
      return new Response(body, {
        headers: diagHeaders({ "X-Cache-Status": "BYPASS_RAW_MIME", "X-Cache-Age": Math.round(age).toString(), "X-Cache-Key": cacheKey }),
      });
    }
  }

  return new Response(enforceScopeOnRaw(cached, session, filters), {
    headers: diagHeaders({ "X-Cache-Status": status, "X-Cache-Age": Math.round(age).toString(), "X-Cache-Key": cacheKey }),
  });
}

async function handleCachePurge(env, session) {
  if (!session) {
    return new Response(JSON.stringify({ error: "auth required" }), { status: 401, headers: diagHeaders() });
  }
  const kv = getKV(env);
  if (!kv) return new Response(JSON.stringify({ ok: true, purged: 0, reason: "no_kv" }), { headers: diagHeaders() });
  const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
  const keys = candidateCacheKeys(userAccountsKey, 200);
  const tsKeys = cachePrefixes().map(({ ts }) => `${ts}:${userAccountsKey}`);
  let htmlPurged = 0;
  try {
    await Promise.all([...keys, ...tsKeys].map((key) => kv.delete(key)));
    // Admin-only: also flush the cross-user email-HTML cache. Bulk-lists both
    // the legacy v1 prefix (raw addresses) and the current v2 prefix and
    // deletes every match. list() paginates in 1000-key batches.
    if (session.role === "admin") {
      for (const prefix of ["email_html:v1:", "email_html:v2:", "inbox:v1:user:", "notifs:v1:user:", "bootstrap:snap:"]) {
        let cursor = undefined;
        for (let i = 0; i < 20; i++) {
          const page = await kv.list({ prefix, cursor, limit: 1000 });
          if (page.keys?.length) {
            await Promise.all(page.keys.map((k) => kv.delete(k.name)));
            htmlPurged += page.keys.length;
          }
          if (page.list_complete || !page.cursor) break;
          cursor = page.cursor;
        }
      }
    }
    return new Response(JSON.stringify({ ok: true, purged: keys.length + tsKeys.length, htmlPurged, keys }), { headers: diagHeaders({ "X-Cache-Status": "PURGED" }) });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, htmlPurged }), { status: 500, headers: diagHeaders() });
  }
}

async function handleSync(env, session, rawToken, requestBody, ctx) {
  try {
    if (!session) {
      return new Response(JSON.stringify({ success: false, error: "auth required" }), {
        status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const limit = clampLimit(requestBody?.limit, 200, 200);
    const requestedLabels = Array.isArray(requestBody?.accountLabels) ? requestBody.accountLabels : [];
    if (session.role !== "admin" && (!Array.isArray(session.assignedAccounts) || session.assignedAccounts.length === 0)) {
      return new Response(JSON.stringify({ success: true, accepted: true, emails: [], message: "No accounts assigned" }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseKey(env)}`,
      "apikey": supabaseKey(env),
    };
    if (rawToken) headers["X-Session-Token"] = rawToken;

    const syncPayload = {
      mode: requestBody?.mode || "sync",
      source: requestBody?.source || "worker",
      limit,
    };
    if (requestedLabels.length > 0) syncPayload.accountLabels = requestedLabels;

    const res = await fetch(`${supabaseUrl(env)}/functions/v1/fetch-emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(syncPayload),
    });
    const responseText = await res.text();

    if (!res.ok) {
      let errorMsg = "Sync failed";
      try {
        const parsed = JSON.parse(responseText);
        errorMsg = parsed?.error || errorMsg;
      } catch {}
      return new Response(JSON.stringify({ success: false, error: errorMsg }), {
        status: res.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Update KV cache after successful sync without blocking the user response.
    if (getKV(env)) {
      const scopedLabels = requestedLabels.length > 0 ? requestedLabels : (session?.assignedAccounts || []);
      const userAccountsKey = scopedLabels.length > 0 ? JSON.stringify([...scopedLabels].sort()) : "all";
      const cacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`;
      const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

      const cacheWork = refreshFromSupabase(env, session, rawToken, cacheKey, tsKey, { accountLabels: requestedLabels, limit })
        .catch((err) => console.error("[sync] async KV update failed:", err.message || err));
      if (ctx?.waitUntil) ctx.waitUntil(cacheWork);
    }

    const filters = await readWorkerEmailFilters(env, rawToken);
    const safeResponseText = enforceScopeOnRaw(responseText, session, filters);
    return new Response(safeResponseText, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message || "Sync request failed" }), {
      status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

// handleDebug removed (F6). Route no longer exposed.


async function fetchDirectFromSupabase(env, session, rawToken, opts = {}) {
  try {
    const accountLabels = Array.isArray(opts.accountLabels) ? opts.accountLabels : [];
    const bodyPayload = { mode: "cache", limit: clampLimit(opts.limit, 500, 500) };
    if (accountLabels.length > 0) bodyPayload.accountLabels = accountLabels;
    else if (session?.assignedAccounts) bodyPayload.accountLabels = session.assignedAccounts;

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseKey(env)}`,
      "apikey": supabaseKey(env),
    };
    if (rawToken) headers["X-Session-Token"] = rawToken;

    const res = await fetch(`${supabaseUrl(env)}/functions/v1/fetch-emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
    });

    const data = await res.text();
    return new Response(data, {
      status: res.status,
      headers: diagHeaders({ "X-Cache-Status": "BYPASS" }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Worker cannot reach backend: " + (err.message || "Unknown") }), {
      status: 502,
      headers: diagHeaders(),
    });
  }
}

async function refreshFromSupabase(env, session, rawToken, cacheKey, tsKey, opts = {}) {
  try {
    const result = await fetchDirectFromSupabase(env, session, rawToken, opts);
    if (!result.ok) {
      console.error("Supabase cache fetch failed:", result.status);
      return;
    }
    const filters = await readWorkerEmailFilters(env, rawToken);
    const data = enforceScopeOnRaw(await result.text(), session, filters);
    await Promise.all([
      kvPut(env, cacheKey, data),
      kvPut(env, tsKey, Date.now().toString()),
    ]);
  } catch (err) {
    console.error("Refresh from Supabase error:", err);
  }
}

// --- IP helpers ---
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.") || ip.startsWith("100.64.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  return false;
}
// Cloudflare's own IP ranges (Warp/proxy). If cf-connecting-ip returns one of these,
// the *real* user is likely behind Warp — but a forwarded IPv4 might still be better.
function isCloudflareIp(ip) {
  if (!ip) return false;
  if (ip.startsWith("2a06:98c") || ip.startsWith("2606:4700") || ip.startsWith("2803:f800")
    || ip.startsWith("2405:b500") || ip.startsWith("2405:8100") || ip.startsWith("2c0f:f248")
    || ip.startsWith("2a06:98d")) return true;
  // Common IPv4 CF ranges (partial list)
  if (/^(104\.16\.|104\.17\.|104\.18\.|104\.19\.|172\.6[4-7]\.|172\.68\.|172\.69\.|172\.70\.|172\.71\.|173\.245\.4[8-9]\.|173\.245\.5\d\.|103\.21\.244\.|103\.22\.200\.|103\.31\.4\.|141\.101\.6[4-9]\.|141\.101\.7\d\.|141\.101\.12[0-7]\.|108\.162\.19[2-9]\.|108\.162\.2\d\d\.|190\.93\.240\.|190\.93\.24[1-9]\.|190\.93\.25[0-5]\.|188\.114\.9[6-9]\.|197\.234\.240\.|198\.41\.12[8-9]\.|198\.41\.1[3-9]\d\.|198\.41\.2\d\d\.|162\.158\.)/.test(ip)) return true;
  return false;
}

function normalizeIp(raw) {
  if (!raw) return "";
  let ip = String(raw).trim().replace(/^"|"$/g, "");
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const bracket = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return bracket[1].trim();
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  return ip.trim();
}

function isKnownEdgeIp(ip) {
  // AWS Global Accelerator / Vercel-style edge IPs often appear in XFF when the
  // request chain is browser → hosting/CDN → Supabase. They are not the user's ISP.
  return /^(13\.248\.|76\.223\.|75\.2\.)/.test(ip || "");
}

function isPublic(ip) {
  return !!ip && !isPrivateIp(ip);
}

function isRealPublicClientIp(ip) {
  return isPublic(ip) && !isCloudflareIp(ip) && !isKnownEdgeIp(ip);
}

// --- Proxy any Supabase edge function through the worker ---
async function handleFunctionProxy(request, env, fnName) {
  try {
    const body = await request.text();
    const sessionToken = request.headers.get("X-Session-Token") || request.headers.get("x-session-token");
    const pendingToken = request.headers.get("X-Pending-Token") || request.headers.get("x-pending-token");

    // Collect ALL possible client-IP signals, in preference order.
    const rawCandidates = [];
    const push = (label, val) => {
      const ip = normalizeIp(val);
      if (ip) rawCandidates.push({ label, ip });
    };
    push("cf-connecting-ip", request.headers.get("cf-connecting-ip"));
    push("true-client-ip", request.headers.get("true-client-ip"));
    push("x-real-ip", request.headers.get("x-real-ip"));
    const xff = request.headers.get("x-forwarded-for") || "";
    xff.split(",").forEach((p, i) => push(`xff[${i}]`, p));

    // Deduplicate while preserving order.
    const seen = new Set();
    const candidates = rawCandidates.filter(c => c.ip && !seen.has(c.ip) && seen.add(c.ip));

    // Selection priority: when traffic is really behind Cloudflare, CF-Connecting-IP
    // is the browser's visible client IP. Do not skip it in favor of an AWS/Vercel
    // X-Forwarded-For hop, because that is how Portland/edge IPs leaked into alerts.
    let selected = candidates.find(c => c.label === "cf-connecting-ip" && isRealPublicClientIp(c.ip))
      || candidates.find(c => c.label === "true-client-ip" && isRealPublicClientIp(c.ip))
      || candidates.find(c => c.label === "x-real-ip" && isRealPublicClientIp(c.ip))
      || candidates.find(c => c.label.startsWith("xff[") && isRealPublicClientIp(c.ip))
      || candidates.find(c => isRealPublicClientIp(c.ip));
    const clientIp = selected?.ip || "";
    const clientIpSource = selected?.label || "unknown";
    const cfCountry = request.headers.get("cf-ipcountry") || "";
    const cfRay = request.headers.get("cf-ray") || "";

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseKey(env)}`,
      "apikey": supabaseKey(env),
    };
    if (sessionToken) headers["X-Session-Token"] = sessionToken;
    if (pendingToken) headers["X-Pending-Token"] = pendingToken;
    if (clientIp) headers["X-Client-IP"] = clientIp;
    const ua = request.headers.get("user-agent") || "";
    const acceptLanguage = request.headers.get("accept-language") || "";
    const chPlatform = request.headers.get("sec-ch-ua-platform") || "";
    if (ua) headers["X-Client-User-Agent"] = ua;
    if (acceptLanguage) headers["X-Client-Accept-Language"] = acceptLanguage;
    if (chPlatform) headers["X-Client-Platform"] = chPlatform;
    // Full trace (compact JSON) so backend can log & display which header we picked.
    try {
      headers["X-IP-Trace"] = JSON.stringify({
        selected: clientIp,
        selectedFrom: clientIpSource,
        cfCountry,
        cfRay,
        candidates: candidates.map(c => ({ h: c.label, ip: c.ip })),
      }).slice(0, 1800);
    } catch {}

    const res = await fetch(`${supabaseUrl(env)}/functions/v1/${fnName}`, {
      method: "POST",
      headers,
      body,
    });

    const responseText = await res.text();

    return new Response(responseText, {
      status: res.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy error: " + (err.message || "Unknown") }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

// ------------------------------------------------------------------
// Email HTML cache — 1 year TTL (immutable content)
// ------------------------------------------------------------------
// Only requires: SUPABASE_URL + SUPABASE_KEY (anon).
// All auth is delegated to the dedicated `email-html` Supabase edge function
// which verifies session tokens internally.
//
// KV key:  email_html:v1:<emailId> → JSON { html, account_label, at }
// Flow:
//   - HIT:  send a tiny authz_only=true request to Supabase (~80 byte
//           response). If allowed, serve cached HTML from Cloudflare edge.
//   - MISS: full request to Supabase, cache 1 year, return.
//
// User impact: none. Emails render identically. Egress drops ~95% because the
// heavy HTML body (50–500 KB) only leaves Supabase on the first-ever open.

// v2 = post-recipient-redaction. Bumping the prefix instantly makes every
// legacy v1 entry (which may still hold un-redacted recipient addresses)
// unreachable; v1 keys expire naturally over their remaining TTL.
const EMAIL_HTML_KEY_PREFIX = "email_html:v2:";
const EMAIL_HTML_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year
const EMAIL_HTML_FUNCTION = "email-html";

function inboxHtmlHeaders(extra = {}) {
  return {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Expose-Headers": "X-Cache-Status, X-Cache-Age",
    ...extra,
  };
}

async function callEmailHtmlFn(env, rawToken, payload) {
  const res = await fetch(`${supabaseUrl(env)}/functions/v1/${EMAIL_HTML_FUNCTION}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseKey(env)}`,
      "apikey": supabaseKey(env),
      "X-Session-Token": rawToken || "",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, text, json };
}

async function handleInboxHtml(request, env, _session, rawToken, ctx) {
  if (!supabaseUrl(env) || !supabaseKey(env)) {
    return new Response(JSON.stringify({ success: false, error: "Worker not configured (Supabase config missing)" }), {
      status: 500, headers: inboxHtmlHeaders(),
    });
  }
  if (!rawToken) {
    return new Response(JSON.stringify({ success: false, error: "session required" }), {
      status: 401, headers: inboxHtmlHeaders(),
    });
  }

  let body = null;
  try { body = await request.json(); } catch {}
  const id = body && typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return new Response(JSON.stringify({ success: false, error: "id required" }), {
      status: 400, headers: inboxHtmlHeaders(),
    });
  }

  const kv = getKV(env);
  const cacheKey = `${EMAIL_HTML_KEY_PREFIX}${id}`;

  // ---- Cache lookup ----
  if (kv) {
    const raw = await kvGet(env, cacheKey);
    if (raw) {
      let cached = null;
      try { cached = JSON.parse(raw); } catch { cached = null; }
      if (cached && typeof cached.html === "string" && cached.html.length > 0) {
        // Tiny authz check — Supabase verifies session + assigned_accounts.
        // Response is ~80 bytes vs 50-500 KB of HTML. Massive egress win.
        const authz = await callEmailHtmlFn(env, rawToken, { id, authz_only: true });
        if (authz.ok && authz.json?.success && authz.json?.allowed) {
          const age = cached.at ? Math.max(0, Math.round((Date.now() - cached.at) / 1000)) : 0;
          return new Response(
            JSON.stringify({ success: true, id, html: cached.html, account_label: cached.account_label || "" }),
            { headers: inboxHtmlHeaders({ "X-Cache-Status": "HIT", "X-Cache-Age": String(age) }) },
          );
        }
        if (authz.status === 401 || authz.status === 403) {
          return new Response(authz.text || JSON.stringify({ success: false, error: "Not authorized" }), {
            status: authz.status, headers: inboxHtmlHeaders({ "X-Cache-Status": "HIT_DENY" }),
          });
        }
        // Any other error → fall through to full MISS path.
      }
    }
  }

  // ---- Cache miss: fetch full HTML from Supabase ----

  try {
    const upstream = await callEmailHtmlFn(env, rawToken, { id });
    if (!upstream.ok) {
      return new Response(upstream.text || JSON.stringify({ success: false, error: "upstream error" }), {
        status: upstream.status,
        headers: inboxHtmlHeaders({ "X-Cache-Status": "MISS_ERR" }),
      });
    }
    if (upstream.json?.success && typeof upstream.json?.html === "string" && upstream.json.html.length > 0 && kv) {
      const payload = {
        html: upstream.json.html,
        account_label: upstream.json.account_label || "",
        at: Date.now(),
      };
      const writeWork = (async () => {
        try {
          const primaryKV = env.EMAIL_CACHE_V2 || env.EMAIL_CACHE;
          if (primaryKV) {
            await primaryKV.put(cacheKey, JSON.stringify(payload), { expirationTtl: EMAIL_HTML_TTL_SECONDS });
          }
        } catch (err) {
          console.error("[inbox-html] KV write failed:", err.message || err);
        }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(writeWork); else await writeWork;
    }
    return new Response(upstream.text, {
      status: 200,
      headers: inboxHtmlHeaders({ "X-Cache-Status": "MISS" }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Worker upstream failed: " + (err.message || "Unknown") }), {
      status: 502, headers: inboxHtmlHeaders({ "X-Cache-Status": "MISS_ERR" }),
    });
  }
}

// ==================== Notifications cache ====================
// Per-user KV cache in front of the notifications-list edge function.
// TTL 60 s, invalidated on any mark_read / delete client-side write.
const NOTIF_KEY_PREFIX = "notifs:v1:user:";
const NOTIF_TTL_SECONDS = 60;

function notifHeaders(extra = {}) {
  return {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Expose-Headers": "X-Cache-Status, X-Cache-Age",
    ...extra,
  };
}

async function handleNotificationsList(request, env, session, rawToken, ctx) {
  if (!supabaseUrl(env) || !supabaseKey(env)) {
    return new Response(JSON.stringify({ success: false, error: "Worker not configured" }), {
      status: 500, headers: notifHeaders(),
    });
  }
  if (!session?.userId || !rawToken) {
    return new Response(JSON.stringify({ success: false, error: "session required" }), {
      status: 401, headers: notifHeaders(),
    });
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const clientEtag = typeof body?.if_etag === "string" ? body.if_etag : null;

  const kv = getKV(env);
  const cacheKey = `${NOTIF_KEY_PREFIX}${session.userId}`;

  // ---- Cache lookup ----
  if (kv) {
    const raw = await kvGet(env, cacheKey);
    if (raw) {
      let cached = null;
      try { cached = JSON.parse(raw); } catch {}
      if (cached && cached.body && cached.at) {
        const age = Math.round((Date.now() - cached.at) / 1000);
        if (age < NOTIF_TTL_SECONDS) {
          // If client already has the cached etag, return unchanged (~80 B).
          if (clientEtag && cached.etag && clientEtag === cached.etag) {
            return new Response(
              JSON.stringify({ success: true, unchanged: true, etag: cached.etag }),
              { headers: notifHeaders({ "X-Cache-Status": "HIT_304", "X-Cache-Age": String(age) }) },
            );
          }
          return new Response(cached.body, {
            headers: notifHeaders({ "X-Cache-Status": "HIT", "X-Cache-Age": String(age) }),
          });
        }
      }
    }
  }

  // ---- MISS: forward to notifications-list edge function ----
  try {
    const upstream = await fetch(`${supabaseUrl(env)}/functions/v1/notifications-list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey(env)}`,
        "apikey": supabaseKey(env),
        "X-Session-Token": rawToken,
      },
      body: JSON.stringify(clientEtag ? { if_etag: clientEtag } : {}),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return new Response(text, {
        status: upstream.status,
        headers: notifHeaders({ "X-Cache-Status": "MISS_ERR" }),
      });
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    // Only cache the full payload (not unchanged responses). Store the etag
    // separately so subsequent same-etag requests can short-circuit.
    if (kv && parsed?.success && !parsed.unchanged) {
      const store = { body: text, etag: parsed.etag || null, at: Date.now() };
      const write = (async () => {
        try {
          const primary = env.EMAIL_CACHE_V2 || env.EMAIL_CACHE;
          if (primary) await primary.put(cacheKey, JSON.stringify(store), { expirationTtl: NOTIF_TTL_SECONDS + 30 });
        } catch (err) { console.error("[notifs] KV write failed:", err.message || err); }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
    }
    return new Response(text, {
      headers: notifHeaders({ "X-Cache-Status": parsed?.unchanged ? "MISS_304" : "MISS" }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Upstream failed: " + (err.message || "unknown") }), {
      status: 502, headers: notifHeaders({ "X-Cache-Status": "MISS_ERR" }),
    });
  }
}

async function handleNotificationsInvalidate(env, session) {
  if (!session?.userId) {
    return new Response(JSON.stringify({ success: false, error: "session required" }), {
      status: 401, headers: notifHeaders(),
    });
  }
  const primary = env.EMAIL_CACHE_V2 || env.EMAIL_CACHE;
  if (primary) {
    try { await primary.delete(`${NOTIF_KEY_PREFIX}${session.userId}`); } catch {}
  }
  return new Response(JSON.stringify({ success: true }), { headers: notifHeaders() });
}


// ---------- Public bootstrap KV cache ----------
// The bootstrap payload (profiles + settings + worker URLs) is identical for
// every anonymous visitor. Caching it at the worker turns thousands of
// concurrent cold loads into a single upstream fetch per TTL window plus
// cheap 304s for repeat visitors that already hold the current ETag.
const BOOTSTRAP_KEY = "bootstrap:snap:v1";
const BOOTSTRAP_TTL_SECONDS = 60;

function bootstrapHeaders(extra = {}) {
  return {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    "Access-Control-Expose-Headers": "ETag, X-Cache-Status, X-Cache-Age",
    ...extra,
  };
}

async function handleBootstrapPublic(request, env, ctx) {
  if (!supabaseUrl(env) || !supabaseKey(env)) {
    return new Response(JSON.stringify({ success: false, error: "Worker not configured" }), {
      status: 500, headers: bootstrapHeaders(),
    });
  }

  const clientEtag = (request.headers.get("If-None-Match") || "").replace(/^W\//, "").replace(/^"|"$/g, "");
  const kv = getKV(env);

  // ---- Cache lookup ----
  if (kv) {
    const raw = await kvGet(env, BOOTSTRAP_KEY);
    if (raw) {
      let cached = null;
      try { cached = JSON.parse(raw); } catch {}
      if (cached && cached.body && cached.at) {
        const age = Math.round((Date.now() - cached.at) / 1000);
        if (age < BOOTSTRAP_TTL_SECONDS) {
          if (clientEtag && cached.etag && clientEtag === cached.etag) {
            return new Response(null, {
              status: 304,
              headers: bootstrapHeaders({ ETag: `"${cached.etag}"`, "X-Cache-Status": "HIT_304", "X-Cache-Age": String(age) }),
            });
          }
          return new Response(cached.body, {
            headers: bootstrapHeaders({ ...(cached.etag ? { ETag: `"${cached.etag}"` } : {}), "X-Cache-Status": "HIT", "X-Cache-Age": String(age) }),
          });
        }
      }
    }
  }

  // ---- MISS: forward to manage-app plaintext ----
  try {
    const upstream = await fetch(`${supabaseUrl(env)}/functions/v1/manage-app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey(env)}`,
        "apikey": supabaseKey(env),
        ...(clientEtag ? { "If-None-Match": `"${clientEtag}"` } : {}),
      },
      body: JSON.stringify({ action: "bootstrap_public" }),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return new Response(text, {
        status: upstream.status,
        headers: bootstrapHeaders({ "X-Cache-Status": "MISS_ERR" }),
      });
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const upstreamEtag = (upstream.headers.get("etag") || "").replace(/^W\//, "").replace(/^"|"$/g, "") || (parsed?.etag || "");

    if (kv && parsed?.success && !parsed.unchanged) {
      const store = { body: text, etag: upstreamEtag || null, at: Date.now() };
      const write = (async () => {
        try {
          const primary = env.EMAIL_CACHE_V2 || env.EMAIL_CACHE;
          if (primary) await primary.put(BOOTSTRAP_KEY, JSON.stringify(store), { expirationTtl: BOOTSTRAP_TTL_SECONDS + 60 });
        } catch (err) { console.error("[bootstrap] KV write failed:", err.message || err); }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
    }

    if (clientEtag && parsed?.unchanged && upstreamEtag && clientEtag === upstreamEtag) {
      return new Response(null, {
        status: 304,
        headers: bootstrapHeaders({ ETag: `"${upstreamEtag}"`, "X-Cache-Status": "MISS_304" }),
      });
    }

    return new Response(text, {
      headers: bootstrapHeaders({ ...(upstreamEtag ? { ETag: `"${upstreamEtag}"` } : {}), "X-Cache-Status": "MISS" }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Upstream failed: " + (err.message || "unknown") }), {
      status: 502, headers: bootstrapHeaders({ "X-Cache-Status": "MISS_ERR" }),
    });
  }
}

// ==================== Inbox list_delta cache (Operation #2) ====================
// Per-user KV cache in front of manage-app.list_delta. Cursor-based diffs
// mean 99% of foreground polls return an empty {rows:[],removedIds:[]} body
// served from KV within 30s. New mail arriving flips the cursor, so the next
// poll misses cache and pulls the fresh diff; there is no coherency risk
// beyond the 30-second TTL.
const INBOX_KEY_PREFIX = "inbox:v1:user:";
const INBOX_TTL_SECONDS = 30;

function inboxListHeaders(extra = {}) {
  return {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Expose-Headers": "X-Cache-Status, X-Cache-Age",
    ...extra,
  };
}

async function handleInboxList(request, env, session, rawToken, ctx) {
  if (!supabaseUrl(env) || !supabaseKey(env)) {
    return new Response(JSON.stringify({ success: false, error: "Worker not configured" }), {
      status: 500, headers: inboxListHeaders(),
    });
  }
  if (!session?.userId || !rawToken) {
    return new Response(JSON.stringify({ success: false, error: "session required" }), {
      status: 401, headers: inboxListHeaders(),
    });
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const since = Number.isFinite(Number(body?.since)) ? Number(body.since) : 0;
  const limit = Math.min(200, Math.max(1, Number(body?.limit) || 50));
  const baseline = body?.baseline === true;

  const kv = getKV(env);
  const cacheKey = `${INBOX_KEY_PREFIX}${session.userId}:s${since}:b${baseline ? 1 : 0}:l${limit}`;

  if (kv) {
    const raw = await kvGet(env, cacheKey);
    if (raw) {
      let cached = null;
      try { cached = JSON.parse(raw); } catch {}
      if (cached?.body && cached.at) {
        const age = Math.round((Date.now() - cached.at) / 1000);
        if (age < INBOX_TTL_SECONDS) {
          return new Response(cached.body, {
            headers: inboxListHeaders({ "X-Cache-Status": "HIT", "X-Cache-Age": String(age) }),
          });
        }
      }
    }
  }

  try {
    const upstream = await fetch(`${supabaseUrl(env)}/functions/v1/manage-app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey(env)}`,
        "apikey": supabaseKey(env),
        "X-Session-Token": rawToken,
      },
      body: JSON.stringify({ action: "list_delta", since, limit, baseline }),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return new Response(text, {
        status: upstream.status,
        headers: inboxListHeaders({ "X-Cache-Status": "MISS_ERR" }),
      });
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (kv && parsed?.success) {
      const store = { body: text, at: Date.now() };
      const write = (async () => {
        try {
          const primary = env.EMAIL_CACHE_V2 || env.EMAIL_CACHE;
          if (primary) await primary.put(cacheKey, JSON.stringify(store), { expirationTtl: INBOX_TTL_SECONDS + 30 });
        } catch (err) { console.error("[inbox-list] KV write failed:", err.message || err); }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
    }
    return new Response(text, {
      headers: inboxListHeaders({ "X-Cache-Status": "MISS" }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Upstream failed: " + (err.message || "unknown") }), {
      status: 502, headers: inboxListHeaders({ "X-Cache-Status": "MISS_ERR" }),
    });
  }
}
