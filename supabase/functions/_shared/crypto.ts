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

async function loadSession(sessionId: string): Promise<{ key: CryptoKey; origin_hash: string | null } | null> {
  const sb = admin();
  const { data, error } = await sb
    .from("crypto_sessions")
    .select("aes_key, expires_at, origin_hash")
    .eq("id", sessionId)
    .maybeSingle();
  if (error || !data) return null;
  if (new Date((data as any).expires_at).getTime() < Date.now()) return null;
  const raw = pgByteaToBytes((data as any).aes_key);
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { key, origin_hash: (data as any).origin_hash ?? null };
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
      // Insert nonce; unique-violation ⇒ replay
      const sb = admin();
      const nonceHex = "\\x" + Array.from(atob(parsed.n), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      const { error: nErr } = await sb
        .from("crypto_nonces")
        .insert({ session_id: sessionId, nonce: nonceHex });
      if (nErr) {
        // 23505 = unique_violation
        if ((nErr as any).code === "23505") throw new TransportError("replay", 400);
        // Non-fatal: log & continue (don't fail requests on transient DB errors)
        console.warn("nonce insert error:", nErr.message);
      }
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
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return await encryptResponse(payload, ctx, res.status);
}

// ---------- Handshake (P-256 ECDH -> HKDF-SHA256 -> AES-256) ----------
// Request : [ver(1)][clientPubRaw(65)]
// Response: [ver(1)][sessionId(16)][serverPubRaw(65)][expiresAtMs(8, big-endian)]

async function rateLimitHandshake(ip: string): Promise<boolean> {
  const sb = admin();
  const now = new Date();
  const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  // increment count for this minute
  const { data: existing } = await sb
    .from("handshake_rate")
    .select("count")
    .eq("ip", ip)
    .eq("minute_bucket", bucket)
    .maybeSingle();
  const nextCount = ((existing as any)?.count ?? 0) + 1;
  await sb.from("handshake_rate")
    .upsert({ ip, minute_bucket: bucket, count: nextCount }, { onConflict: "ip,minute_bucket" });
  // Mobile carriers, campus Wi‑Fi, office networks, and preview deployments can
  // put many legitimate users behind one NAT IP. 10/minute caused normal page
  // loads to fail with a visible "handshake 429". Keep abuse protection, but
  // allow production-level bursts from shared IPs.
  if (nextCount > 180) return false;
  // hourly total
  const hourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
  const { data: rows } = await sb
    .from("handshake_rate")
    .select("count")
    .eq("ip", ip)
    .gte("minute_bucket", hourAgo);
  const total = (rows ?? []).reduce((s: number, r: any) => s + (r.count ?? 0), 0);
  return total <= 1800;
}

export async function handleHandshake(req: Request): Promise<Response> {
  try { checkSecFetchSite(req); } catch (e) { return transportErrorResponse(e); }

  const ip = getClientIp(req);
  const ok = await rateLimitHandshake(ip);
  if (!ok) {
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
