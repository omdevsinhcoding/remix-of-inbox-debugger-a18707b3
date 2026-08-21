// Shared AES-256-GCM binary transport used by edge functions.
// Wire format (v1):
//   Encrypted request  : [ver(1)][sessionId(16)][iv(12)][ciphertext+tag(N)]
//   Encrypted response : [ver(1)][iv(12)][ciphertext+tag(N)]
//
// Phase A hardening (v2 envelope, still inside the same binary frame):
//   plaintext JSON = { __v:2, n:<b64 16-byte nonce>, t:<unix_ms>, o:<hex sha256(origin)>, b:<original body> }
//   Server validates:
//     - timestamp within ±30s
//     - nonce unique per session (crypto_nonces table)
//     - origin_hash matches value bound at handshake
//
// Plaintext requests are REJECTED with 426 Upgrade Required unless the caller
// opts-in via `allowPlaintext` (used only by cron/server-to-server callers
// authenticating with x-cron-secret).

import { createClient } from "npm:@supabase/supabase-js@2";

const VERSION = 0x01;
// Response version 0x02 = payload was gzipped before AES-GCM encryption.
// Server only emits 0x02 when the client advertised gzip support via the
// `x-accept-encoding: gzip` request header. Older clients keep receiving 0x01.
const VERSION_GZIP = 0x02;
const SESSION_ID_BYTES = 16;
const IV_BYTES = 12;
const REPLAY_WINDOW_MS = 5 * 60_000;
// Only gzip payloads above this size — small responses (auth, empty deltas)
// don't benefit and pay the CPU cost.
const GZIP_MIN_BYTES = 512;

const CT_BINARY = "application/octet-stream";

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const cryptoCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-session-token, x-pending-token, x-crypto-session, x-cron-secret, x-accept-encoding",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-server-time",
};

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function uuidBytesToString(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function uuidStringToBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function pgByteaToBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") {
    let s = v;
    if (s.startsWith("\\x") || s.startsWith("\\X")) s = s.slice(2);
    else if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
      const out = new Uint8Array(s.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
      return out;
    }
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error("invalid bytea");
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return bytesToHex(h);
}

// ---------- Op#3: L3 (Deno isolate memory) session cache ----------
// crypto_sessions are read on EVERY encrypted request (~O(pageviews)) and
// never mutate after insert (aes_key + origin_hash frozen at handshake).
// Cache them in warm-isolate memory with TTL so Postgres becomes last-resort.
interface CachedSession { key: CryptoKey; origin_hash: string | null; expires_at: number }
const SESSION_CACHE = new Map<string, CachedSession>();
const SESSION_CACHE_MAX = 5000;

function pruneSessionCache() {
  const now = Date.now();
  for (const [id, s] of SESSION_CACHE) if (s.expires_at < now) SESSION_CACHE.delete(id);
  if (SESSION_CACHE.size > SESSION_CACHE_MAX) {
    // simple FIFO eviction — Map preserves insertion order
    const drop = SESSION_CACHE.size - SESSION_CACHE_MAX;
    let i = 0;
    for (const id of SESSION_CACHE.keys()) { if (i++ >= drop) break; SESSION_CACHE.delete(id); }
  }
}

async function loadSession(sessionId: string): Promise<{ key: CryptoKey; origin_hash: string | null } | null> {
  const cached = SESSION_CACHE.get(sessionId);
  const now = Date.now();
  if (cached && cached.expires_at > now) {
    return { key: cached.key, origin_hash: cached.origin_hash };
  }
  const sb = admin();
  const { data, error } = await sb
    .from("crypto_sessions")
    .select("aes_key, expires_at, origin_hash")
    .eq("id", sessionId)
    .maybeSingle();
  if (error || !data) return null;
  const exp = new Date((data as any).expires_at).getTime();
  if (exp < now) return null;
  const raw = pgByteaToBytes((data as any).aes_key);
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const origin_hash = (data as any).origin_hash ?? null;
  SESSION_CACHE.set(sessionId, { key, origin_hash, expires_at: exp });
  if (SESSION_CACHE.size > SESSION_CACHE_MAX) pruneSessionCache();
  return { key, origin_hash };
}

// ---------- Op#3: in-memory nonce dedupe (fast-reject before DB) ----------
// DB (crypto_nonces) remains authoritative across isolates. In-memory bloom-ish
// Set catches the common intra-isolate replay case in O(1) without a DB round
// trip. Cap per-session to keep memory bounded.
const NONCE_CACHE = new Map<string, Set<string>>();
const NONCE_PER_SESSION_CAP = 512;
function noncePreCheck(sessionId: string, nonce: string): boolean {
  let s = NONCE_CACHE.get(sessionId);
  if (!s) { s = new Set(); NONCE_CACHE.set(sessionId, s); }
  if (s.has(nonce)) return false;
  if (s.size >= NONCE_PER_SESSION_CAP) {
    // drop oldest half
    const it = s.values();
    for (let i = 0; i < NONCE_PER_SESSION_CAP / 2; i++) { const v = it.next(); if (v.done) break; s.delete(v.value); }
  }
  s.add(nonce);
  return true;
}

export interface EncryptedRequestContext {
  sessionId: string;
  key: CryptoKey;
  acceptGzip: boolean;
}

export class PlaintextRejectedError extends Error {
  constructor() { super("plaintext rejected"); this.name = "PlaintextRejectedError"; }
}
export class TransportError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; this.name = "TransportError"; }
}

function getClientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for") || "";
  const ip = xf.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
  return ip.slice(0, 64);
}

function checkSecFetchSite(req: Request) {
  const sfs = req.headers.get("sec-fetch-site");
  if (!sfs) return; // non-browser client (curl, cron) — skip
  // The edge function is hosted on supabase.co while the app is on a different
  // origin (lovableproject.com / customer domain). "cross-site" is therefore
  // the normal case. Origin binding (sha256(Origin) captured at handshake and
  // echoed in every v2 envelope) is what actually prevents CSRF. Only reject
  // explicitly malformed values.
  if (sfs !== "same-origin" && sfs !== "same-site" && sfs !== "cross-site" && sfs !== "none") {
    throw new TransportError("bad sec-fetch-site", 403);
  }
}

interface ReadOptions {
  allowPlaintext?: boolean;
}

export async function readRequest(
  req: Request,
  opts: ReadOptions = {},
): Promise<
  | { encrypted: false; body: any; ctx: null }
  | { encrypted: true; body: any; ctx: EncryptedRequestContext }
> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes(CT_BINARY)) {
    checkSecFetchSite(req);
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.length < 1 + SESSION_ID_BYTES + IV_BYTES + 16) throw new TransportError("short frame");
    if (buf[0] !== VERSION) throw new TransportError("bad version");
    const sidBytes = buf.slice(1, 1 + SESSION_ID_BYTES);
    const sessionId = uuidBytesToString(sidBytes);
    const iv = buf.slice(1 + SESSION_ID_BYTES, 1 + SESSION_ID_BYTES + IV_BYTES);
    const ct2 = buf.slice(1 + SESSION_ID_BYTES + IV_BYTES);
    const sess = await loadSession(sessionId);
    if (!sess) throw new TransportError("unknown session", 401);
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sess.key, ct2));
    } catch {
      throw new TransportError("decrypt failed", 400);
    }
    const text = new TextDecoder().decode(plain);
    const parsed = text.length ? JSON.parse(text) : null;

    // v2 envelope validation
    let body: any = parsed;
    if (parsed && typeof parsed === "object" && parsed.__v === 2) {
      const now = Date.now();
      const t = Number(parsed.t);
      if (!Number.isFinite(t) || Math.abs(now - t) > REPLAY_WINDOW_MS) {
        throw new TransportError("stale request", 400);
      }
      if (typeof parsed.n !== "string" || parsed.n.length < 16) {
        throw new TransportError("bad nonce", 400);
      }
      if (sess.origin_hash) {
        if (typeof parsed.o !== "string" || parsed.o !== sess.origin_hash) {
          throw new TransportError("origin mismatch", 403);
        }
      }
      // Op#3: L3 fast-reject on in-isolate replay; DB is authoritative safety
      // net across isolates but fires async so hot path stays sub-millisecond.
      if (!noncePreCheck(sessionId, parsed.n)) {
        throw new TransportError("replay", 400);
      }
      const sb = admin();
      const nonceHex = "\\x" + Array.from(atob(parsed.n), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      sb.from("crypto_nonces")
        .insert({ session_id: sessionId, nonce: nonceHex })
        .then(({ error: nErr }: any) => {
          if (nErr && (nErr as any).code !== "23505") {
            console.warn("nonce insert error:", nErr.message);
          }
        });
      body = parsed.b ?? null;
    }

    const acceptGzip = /\bgzip\b/i.test(req.headers.get("x-accept-encoding") || "");
    return { encrypted: true, body, ctx: { sessionId, key: sess.key, acceptGzip } };
  }
  // plaintext path
  if (!opts.allowPlaintext) {
    throw new PlaintextRejectedError();
  }
  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  return { encrypted: false, body, ctx: null };
}

export function plaintextRejectedResponse(): Response {
  return new Response(
    JSON.stringify({ error: "encrypted transport required" }),
    {
      status: 426,
      headers: {
        ...cryptoCorsHeaders,
        "Content-Type": "application/json",
        "Upgrade": "lovable-transport/1",
      },
    },
  );
}

export function transportErrorResponse(err: unknown): Response {
  const te = err instanceof TransportError ? err : new TransportError("bad request", 400);
  return new Response(JSON.stringify({ error: te.message }), {
    status: te.status,
    headers: { ...cryptoCorsHeaders, "Content-Type": "application/json" },
  });
}

export async function encryptResponse(payload: any, ctx: EncryptedRequestContext, status = 200): Promise<Response> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const raw = new TextEncoder().encode(JSON.stringify(payload ?? null));
  const useGzip = ctx.acceptGzip && raw.length >= GZIP_MIN_BYTES;
  const plain = useGzip ? await gzipBytes(raw) : raw;
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ctx.key, plain));
  const out = new Uint8Array(1 + IV_BYTES + cipher.length);
  out[0] = useGzip ? VERSION_GZIP : VERSION;
  out.set(iv, 1);
  out.set(cipher, 1 + IV_BYTES);
  return new Response(out, {
    status,
    headers: { ...cryptoCorsHeaders, "Content-Type": CT_BINARY },
  });
}

export async function maybeEncryptResponse(
  res: Response,
  ctx: EncryptedRequestContext | null,
): Promise<Response> {
  if (!ctx) return res;
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return res;
  // Never encrypt error responses. Error messages ("Authentication required",
  // "bad request", validation errors, etc.) carry no sensitive data, and
  // encrypting them means any client-side decrypt hiccup (stale session key
  // after handshake reset, transport downgrade, proxy content-type rewrite)
  // surfaces to the user as raw binary garbage instead of a readable message.
  if (!res.ok) return res;
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return await encryptResponse(payload, ctx, res.status);
}

// ---------- Handshake (P-256 ECDH -> HKDF-SHA256 -> AES-256) ----------
// Request : [ver(1)][clientPubRaw(65)]
// Response: [ver(1)][sessionId(16)][serverPubRaw(65)][expiresAtMs(8, big-endian)]

// Op#3: Pure in-memory rate limiter. `handshake_rate` DB writes are eliminated
// on the hot path. Per-isolate counters reset on cold start (acceptable for an
// abuse guard — cold starts are rare and legitimate bursts recover instantly).
interface RateBucket { minute: number; count: number; hourStart: number; hourCount: number }
const RATE_CACHE = new Map<string, RateBucket>();
const RATE_CACHE_MAX = 20_000;

function rateLimitHandshakeSync(ip: string): boolean {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  let b = RATE_CACHE.get(ip);
  if (!b || b.minute !== minute) {
    const hourStart = b && (now - b.hourStart) < 3_600_000 ? b.hourStart : now;
    const hourCount = b && (now - b.hourStart) < 3_600_000 ? b.hourCount : 0;
    b = { minute, count: 0, hourStart, hourCount };
    RATE_CACHE.set(ip, b);
  }
  b.count += 1;
  b.hourCount += 1;
  if (RATE_CACHE.size > RATE_CACHE_MAX) {
    // FIFO drop
    const drop = RATE_CACHE.size - RATE_CACHE_MAX;
    let i = 0;
    for (const k of RATE_CACHE.keys()) { if (i++ >= drop) break; RATE_CACHE.delete(k); }
  }
  if (b.count > 180) return false;
  if (b.hourCount > 1800) return false;
  return true;
}


export async function handleHandshake(req: Request): Promise<Response> {
  try { checkSecFetchSite(req); } catch (e) { return transportErrorResponse(e); }

  const ip = getClientIp(req);
  if (!rateLimitHandshakeSync(ip)) {
    return new Response("rate limited", { status: 429, headers: cryptoCorsHeaders });
  }


  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length !== 1 + 65 || buf[0] !== VERSION) {
    return new Response("bad handshake", { status: 400, headers: cryptoCorsHeaders });
  }
  const clientPubRaw = buf.slice(1);
  const clientPub = await crypto.subtle.importKey(
    "raw", clientPubRaw, { name: "ECDH", namedCurve: "P-256" }, true, [],
  );
  const serverKp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientPub }, serverKp.privateKey, 256,
  ));
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const aesRaw = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode("lovable-transport-v1") },
    hkdfKey,
    256,
  ));
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKp.publicKey));

  const origin = req.headers.get("origin") || "";
  const originHash = origin ? await sha256Hex(origin) : null;
  const expiresAt = new Date(Date.now() + 15 * 60_000);

  const sb = admin();
  const hex = "\\x" + Array.from(aesRaw).map((b) => b.toString(16).padStart(2, "0")).join("");
  const { data, error } = await sb
    .from("crypto_sessions")
    .insert({ aes_key: hex, origin_hash: originHash, ip, expires_at: expiresAt.toISOString() })
    .select("id")
    .single();
  if (error || !data) {
    return new Response("session store failed", { status: 500, headers: cryptoCorsHeaders });
  }
  // Op#3: warm L3 immediately so first encrypted request skips Postgres.
  try {
    const aesKey = await crypto.subtle.importKey("raw", aesRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    SESSION_CACHE.set(data.id, { key: aesKey, origin_hash: originHash, expires_at: expiresAt.getTime() });
    if (SESSION_CACHE.size > SESSION_CACHE_MAX) pruneSessionCache();
  } catch { /* non-fatal */ }
  const sidBytes = uuidStringToBytes(data.id);
  const expMs = BigInt(expiresAt.getTime());
  const out = new Uint8Array(1 + 16 + 65 + 8);
  out[0] = VERSION;
  out.set(sidBytes, 1);
  out.set(serverPubRaw, 1 + 16);
  // 8-byte big-endian expiresAt ms
  const dv = new DataView(out.buffer, out.byteOffset + 1 + 16 + 65, 8);
  dv.setBigUint64(0, expMs, false);
  return new Response(out, {
    status: 200,
    headers: { ...cryptoCorsHeaders, "Content-Type": CT_BINARY, "x-server-time": String(Date.now()) },
  });
}
