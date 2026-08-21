import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticator } from "npm:otplib@12.0.1";
import sodium from "https://esm.sh/libsodium-wrappers@0.7.13";
import { readRequest, maybeEncryptResponse, EncryptedRequestContext, PlaintextRejectedError, plaintextRejectedResponse, TransportError, transportErrorResponse } from "../_shared/crypto.ts";
import { getSetting, invalidateSetting, invalidateAllSettings, readSettingRow } from "../_shared/settingsCache.ts";
// build-marker: tv-runner-observability v22 (2026-07-25) — stale-run cleanup + VPS fallback URL

// Wrap `app_settings` writes so the shared TTL cache is invalidated the moment
// an admin changes a value. Prevents 30-second staleness on toggles.
async function upsertSetting(supabase: any, key: string, value: any) {
  const res = await supabase.from("app_settings").upsert({ key, value }, { onConflict: "key" });
  invalidateSetting(key);
  return res;
}
// last_seen_at throttle: don't rewrite on every request — WAL/IO amplifier.
const SESSION_TOUCH_MS = 60_000;
const __sessionTouchMemo = new Map<string, number>();
function shouldTouchSession(id: string): boolean {
  const last = __sessionTouchMemo.get(id) || 0;
  const now = Date.now();
  if (now - last < SESSION_TOUCH_MS) return false;
  __sessionTouchMemo.set(id, now);
  // Cap memo size to avoid unbounded growth in long-lived isolates.
  if (__sessionTouchMemo.size > 2000) {
    const cutoff = now - SESSION_TOUCH_MS;
    for (const [k, v] of __sessionTouchMemo) if (v < cutoff) __sessionTouchMemo.delete(k);
  }
  return true;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token, x-pending-token, x-client-ip, x-crypto-session, x-accept-encoding, x-cron-secret",
};

// Strict UUID guard. Used before any id is interpolated into a PostgREST
// filter string (e.g. `.or("target_user_id.eq.<id>")`) so a malformed value can
// never widen a query's scope.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`invalid ${label}`);
  return value;
}



// Warm-instance memo for bootstrap_public. Deno edge instances stay warm for
// ~15 min; 10-second TTL means at 5k concurrent users we serve most calls from
// this in-memory cache, dropping DB reads + egress on the public bootstrap
// path by ~99%. Invalidated on any admin write to app_users / app_settings
// (see bumpBootstrapVersion below).
let __bootstrapCache: { at: number; payload: any } | null = null;
const BOOTSTRAP_TTL_MS = 10_000;
function invalidateBootstrapCache() { __bootstrapCache = null; }

const TV_RUNNER_START_TIMEOUT_MS = 30_000;
const TV_GITHUB_START_TIMEOUT_MS = 120_000;
const TV_RUNNER_RESULT_TIMEOUT_MS = 55_000;
const TV_GITHUB_RESULT_TIMEOUT_MS = 90_000;
const TV_RUNNER_DISPATCH_TIMEOUT_MS = 3_500;

type EmailVisibilityFilters = { showSignInCodes?: boolean; showPasswordResets?: boolean; showAccountUpdates?: boolean };
function publicProfilePrefs(value: any) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const explicitLocationOverride = v.locationRequiredOverride === true;
  return {
    avatarId: typeof v.avatarId === "string" ? v.avatarId : null,
    // Default: GPS required. A stored false only counts after admin explicitly toggles it.
    locationRequired: explicitLocationOverride && v.locationRequired === false ? false : true,
    locationRequiredOverride: explicitLocationOverride,
  };
}
function isGlobalLocationRequired(value: any) {
  return !(value && typeof value === "object" && value.required === false);
}
async function loadGlobalLocationRequired(supabase: any): Promise<boolean> {
  try {
    const value = await getSetting(supabase, "location_policy");
    return isGlobalLocationRequired(value);
  } catch {
    return true;
  }
}
async function loadTvFeatureEnabled(supabase: any): Promise<boolean> {
  try {
    const value: any = await getSetting(supabase, "tv_feature");
    return value?.enabled !== false;
  } catch {
    return true;
  }
}
type UserFeatures = { gmail: boolean; tv: boolean; link: boolean };
function pickFeatures(u: any): UserFeatures {
  return {
    gmail: u?.feature_gmail !== false,
    tv:    u?.feature_tv    !== false,
    link:  u?.feature_link  === true,
  };
}
function publicVpsConfig(value: any) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const ip = typeof v.ip === "string" && v.ip.trim() ? v.ip.trim() : "140.238.226.213";
  const runnerUrl = typeof v.runnerUrl === "string" && v.runnerUrl.trim() ? v.runnerUrl.trim().replace(/\/+$/g, "") : "";
  const rawMode = typeof v.mode === "string" ? v.mode.trim().toLowerCase() : "";
  const mode: "vps" | "github" = rawMode === "github" ? "github" : "vps";
  return {
    ip,
    runnerUrl,
    mode,
    keyFilename: typeof v.keyFilename === "string" && v.keyFilename.trim() ? v.keyFilename.trim() : "vps-private-key.pem",
    keyObjectKey: typeof v.keyObjectKey === "string" ? v.keyObjectKey : "",
    keyUploadedAt: typeof v.keyUploadedAt === "string" ? v.keyUploadedAt : "",
    keySize: Number.isFinite(Number(v.keySize)) ? Number(v.keySize) : 0,
    hasKey: typeof v.keyObjectKey === "string" && v.keyObjectKey.length > 0,
  };
}
function effectiveTvRunnerUrl(vpsCfgValue: any): string {
  const cfg = publicVpsConfig(vpsCfgValue);
  if (cfg.runnerUrl) return cfg.runnerUrl;
  const env = (Deno.env.get("TV_FAST_RUNNER_URL") || "").trim().replace(/\/+$/g, "");
  if (env) return env;
  return cfg.ip ? `http://${cfg.ip}:8788` : "";
}
function isProfileLocationRequired(user: any, globalRequired = true) {
  if (!user) return false;
  const prefs = user.profile_prefs && typeof user.profile_prefs === "object" && !Array.isArray(user.profile_prefs) ? user.profile_prefs : {};
  const override = prefs.locationRequiredOverride === true;
  // Admins default to GPS OFF, but an explicit admin-card Location toggle ON
  // must be enforced even if the global user-location policy is disabled, and
  // must include rich Telegram location details on successful sign-in.
  if (user.role === "admin") return override ? prefs.locationRequired === true : false;
  if (!globalRequired) return false;
  return !(override && prefs.locationRequired === false);
}
const VIS_PASSWORD_RESET_RE = /(password (was |has been )?(changed|reset|updated)|reset your password|forgot password|password reset|new password|account recovery)/i;
const VIS_SIGNIN_RE = /(sign[\s-]?in code|new sign[\s-]?in|new device|temporary access code|is using your account|access your account|verification code|login code|enter this code|otp)/i;
const DEFAULT_EMAIL_FILTERS = { showSignInCodes: true, showPasswordResets: true, showAccountUpdates: true };
function normalizeEmailFilters(value: any): Required<EmailVisibilityFilters> {
  const v = value && typeof value === "object" ? value : {};
  return {
    showSignInCodes: v.showSignInCodes === false ? false : true,
    showPasswordResets: v.showPasswordResets === false ? false : true,
    showAccountUpdates: v.showAccountUpdates === false ? false : true,
  };
}
function normalizeEmailAddress(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}
function extractEmailAddresses(value: string | null | undefined): string[] {
  const s = normalizeEmailAddress(value);
  if (!s) return [];
  const matches = s.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return matches.map(normalizeEmailAddress);
}
function normalizeRecipientFilters(raw: any): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  return Array.from(new Set(values.flatMap((v: any) => extractEmailAddresses(String(v || "")))));
}
function isPlusAliasAddress(email: string): boolean {
  // Gmail-style plus-alias: local+tag@domain (tag is non-empty).
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at);
  const plus = local.indexOf("+");
  return plus > 0 && plus < local.length - 1;
}
function recipientMatches(toRaw: string | null | undefined, filters?: string[]): boolean {
  const recipients = extractEmailAddresses(toRaw);
  if (recipients.length === 0) return !filters || filters.length === 0;
  if (!filters || filters.length === 0) {
    // No explicit filters: treat every plus-alias (foo+tag@domain) as a
    // separate mailbox that must be explicitly assigned. Base-address mail
    // stays visible so existing setups keep working.
    return recipients.some((email) => !isPlusAliasAddress(email));
  }
  const allowed = new Set(filters.map(normalizeEmailAddress).filter(Boolean));
  return recipients.some((email) => allowed.has(email));
}
const VIS_ACCOUNT_UPDATE_RE = /(attention|action (needed|required)|account (information|info|details) (was |has been )?(changed|updated)|changes? to your account|email (address )?(was |has been )?(changed|updated)|new email address|email verification|verification email|verify (your )?(email address|phone number|mobile number|account)|confirm (your )?(email address|phone number|mobile number|account change|account)|membership (was |has been )?(cancell?ed|updated|paused)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold)|we[’']re sorry to see you go|payment (received|method|was|has been|declined|failed|updated|changed)|mobile (number )?(confirm|confirmed|verify|verified|update|updated)|phone (number )?(confirm|confirmed|verify|verified|update|updated)|verify (your )?(phone|mobile|email)|verify your email address|action needed: verify|request to make a change|update your account|make (a |any )?(change|changes) to your account)/i;

// ============================================================================
// ⚠️  DO NOT TOUCH — HARD BLOCK: Netflix account-change emails ⚠️
// ----------------------------------------------------------------------------
// Netflix sends a mail whenever ANYONE modifies the account: email address
// change, phone number add/update/remove, password change, profile
// add/remove/rename, payment-method update, membership pause/cancel,
// "Confirm your account change with this code: XXXXXX", "Confirm your email
// address change", "Your account information was updated", etc.
//
// These MUST NEVER reach the end user — chahe admin toggle ON ho ya OFF,
// chahe mail ke andar OTP ho ya link ho, chahe kisi bhi wording mein aaye.
// Only the admin sees them. This is a hard product rule — no filter, no
// override, no "showAccountUpdates" toggle. If you're tempted to add an
// exception here, DON'T — talk to the product owner first.
//
// The strong regex below matches every known Netflix account-change subject
// line (researched from Netflix Help Center + real user reports). It runs
// BEFORE OTP/signin detection so account-change mails with a code (like
// email-change confirmation codes) are still classified as account_update
// and hard-blocked.
// ============================================================================
const VIS_ACCOUNT_CHANGE_STRONG_RE = /(confirm (your )?(account change|email address change|change to your account|new email|phone (number )?change)|your (account (information|info|details)|email address|phone number|password) (was |has been |is )?(changed|updated|added|removed|reset)|(email address|phone number|password|payment method|payment info|billing info|account information) (was |has been )?(changed|updated|added|removed|reset|verified)|changes? to your account (was|has been|were) (made|updated)|make (a |any )?(change|changes) to your account|request to make a change|password (was |has been )?(changed|reset|updated)|(a )?new profile (was |has been )?(added|created)|profile (was |has been )?(added|created|removed|deleted|renamed|updated|modified)|(a )?profile (has been|was) (added|removed|deleted|renamed)|added a (new )?(phone|mobile|email|profile)|(mobile|phone) number (was |has been )?(added|updated|changed|removed|verified|confirmed)|membership (was |has been )?(cancell?ed|updated|paused|on hold|restarted|resumed|reactivated)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold|reactivated)|we[’']re sorry to see you go|payment (method|info|information) (was |has been )?(updated|changed|added|removed)|update your account (information|info|details)|action needed: (verify|update|confirm))/i;

// Netflix household / new-device / "is this you?" emails — link-based (no OTP)
// but MUST reach the user so they can complete verification.
const VIS_HOUSEHOLD_RE = /(netflix household|your household|update your household|household (has been|was|is) (confirmed|updated)|part of your (netflix )?household|watching on a tv|traveling|travelling|new device|new sign[\s-]?in|signed in on|is this you|confirm (this|your) device|approve (this|your) device|watch instead|yes,? this was me)/i;

function emailVisibilityCategory(row: any): "household" | "signin" | "password_reset" | "account_update" | "other" {
  const subject = String(row?.subject || "");
  const preview = String(row?.preview || "");
  const combined = `${subject} ${preview}`;
  // 1. Household verification is an access/sign-in action. It must outrank
  //    broad account-update wording such as "update your account".
  if (VIS_HOUSEHOLD_RE.test(combined)) return "household";
  // 2. HARD-BLOCK zone (see banner above): any Netflix account-modification mail
  //    is classified as account_update and later hard-hidden from users. This
  //    runs BEFORE the OTP shortcut so "Confirm your account change with this
  //    code: XXXXXX" is caught even though it contains a 6-digit code.
  if (VIS_ACCOUNT_CHANGE_STRONG_RE.test(combined)) return "account_update";
  // 3. Emails with an OTP (not account-change) are sign-in / household-verify.
  if (row?.otp) return "signin";
  // 4. Sign-in / new-device / temporary-access-code copy without an OTP field.
  if (VIS_SIGNIN_RE.test(combined)) return "signin";
  // 5. Broader account-update surface (membership paused, payment failed, etc.).
  if (VIS_ACCOUNT_UPDATE_RE.test(combined)) return "account_update";
  if (VIS_PASSWORD_RESET_RE.test(combined)) return "password_reset";
  return "other";
}

function shouldExposeEmailToUser(row: any, filters: EmailVisibilityFilters, _isFree: boolean) {
  const hideSignin = filters.showSignInCodes === false;
  const category = emailVisibilityCategory(row);
  // Only two categories are hidden from users:
  //   1. account_update — Netflix account-change mails (email/phone/payment change, membership cancel)
  //   2. password_reset — password reset / recovery mails
  // Everything else (household approval, sign-in codes, promotional, signup
  // "Finish Signing Up" welcome mails, and any uncategorized "other") is
  // ALWAYS shown to the user. The showSignInCodes admin toggle can still
  // hide sign-in-code mails if the admin explicitly turns it off.
  if (category === "account_update") return false;
  if (category === "password_reset") return false;
  if (hideSignin && category === "signin") return false;
  return true;
}



// --- Crypto helpers ---
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$2")) return password === stored;
  if (!stored.startsWith("pbkdf2:")) return password === stored;
  const [, saltHex, hashHex] = stored.split(":");
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computedHex === hashHex;
}

// --- Session Token (HMAC-SHA256) ---
async function createSessionToken(payload: Record<string, any>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = JSON.stringify(payload);
  const dataB64 = btoa(data);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(dataB64));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${dataB64}.${sigHex}`;
}

async function verifySessionToken(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function verifySessionTokenAllowExpired(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    return JSON.parse(atob(dataB64));
  } catch { return null; }
}

// Verify with the new signing secret first, then fall back to the legacy secret
// so sessions issued before the rotation still work until they expire naturally.
async function verifySessionTokenDual(token: string, primary: string, legacy: string): Promise<Record<string, any> | null> {
  const p = await verifySessionToken(token, primary);
  if (p) return p;
  if (legacy && legacy !== primary) return await verifySessionToken(token, legacy);
  return null;
}

async function verifySessionTokenDualAllowExpired(token: string, primary: string, legacy: string): Promise<Record<string, any> | null> {
  const p = await verifySessionTokenAllowExpired(token, primary);
  if (p) return p;
  if (legacy && legacy !== primary) return await verifySessionTokenAllowExpired(token, legacy);
  return null;
}


async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeAccountLabels(raw: any, available: string[] = []): string[] {
  const allowed = Array.from(new Set(available.map((s) => String(s || "").trim()).filter(Boolean)));
  const out: string[] = [];
  const add = (label: string) => {
    const clean = String(label || "").trim();
    if (clean && (!allowed.length || allowed.includes(clean)) && !out.includes(clean)) out.push(clean);
  };
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const value of values) {
    const clean = String(value || "").trim();
    if (!clean) continue;
    if (!allowed.length || allowed.includes(clean)) {
      add(clean);
      continue;
    }
    for (const label of allowed) {
      const re = new RegExp(`(^|\\s)${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "i");
      if (re.test(clean)) add(label);
    }
  }
  return out;
}

function normalizedAssignedAccountsEqual(a: string[] | null, b: string[] | null): boolean {
  const aa = Array.isArray(a) ? [...a].sort() : [];
  const bb = Array.isArray(b) ? [...b].sort() : [];
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

async function normalizeAssignedAccounts(supabase: any, raw: any): Promise<string[] | null> {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const labels = await loadAvailableAccountLabels(supabase);
  const normalized = normalizeAccountLabels(raw, labels);
  return normalized.length > 0 ? normalized : null;
}

async function loadAvailableAccountLabels(supabase: any): Promise<string[]> {
  const value = await getSetting<any[]>(supabase, "email_accounts");
  return (Array.isArray(value) ? value : []).map((acc: any) => String(acc?.label || acc?.user || "").trim()).filter(Boolean);
}

async function loadRecipientFiltersByLabel(supabase: any): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const value = await getSetting<any[]>(supabase, "email_accounts");
    if (Array.isArray(value)) {
      for (const acc of value) {
        const label = String(acc?.label || acc?.user || "").trim();
        if (!label) continue;
        out.set(label, normalizeRecipientFilters(acc.recipientFilters || acc.recipientFilter || acc.allowedRecipients));
      }
    }
  } catch {}
  return out;
}

async function verifyRecaptchaToken(secretKey: string, token: string, ip?: string): Promise<boolean> {
  const body = new URLSearchParams();
  body.set("secret", secretKey);
  body.set("response", token);
  if (ip && ip !== "unknown") body.set("remoteip", ip);

  const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => null) as any;
  return data?.success === true;
}

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32ToBytes(input: string): Uint8Array {
  const clean = String(input || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  const out: number[] = [];
  for (const ch of clean) {
    const value = BASE32_ALPHABET.indexOf(ch);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, "0");
    while (bits.length >= 8) {
      out.push(parseInt(bits.slice(0, 8), 2));
      bits = bits.slice(8);
    }
  }
  return new Uint8Array(out);
}

function counterToBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let n = BigInt(Math.max(0, Math.floor(counter)));
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

async function hotpSha1(secretBytes: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterToBytes(counter)));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24)
    | ((signature[offset + 1] & 0xff) << 16)
    | ((signature[offset + 2] & 0xff) << 8)
    | (signature[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

async function verifyTotpWithGrace(code: string, secret: string): Promise<boolean> {
  const normalized = String(code || "").replace(/\D/g, "").slice(0, TOTP_DIGITS);
  if (normalized.length !== TOTP_DIGITS) return false;
  // Keep otplib's normal validation as the first path, then add a controlled
  // ±1-step grace window so a just-expired Authenticator code still works.
  try {
    if (authenticator.check(normalized, secret)) return true;
  } catch {}
  const secretBytes = base32ToBytes(secret);
  if (!secretBytes.length) return false;
  const currentCounter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  for (const drift of [-1, 0, 1]) {
    if (await hotpSha1(secretBytes, currentCounter + drift) === normalized) return true;
  }
  return false;
}

// --- AES-256-GCM encryption for IMAP credentials ---
async function deriveEncKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("imap-enc-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptValue(plaintext: string, secret: string): Promise<string> {
  const key = await deriveEncKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  const ctHex = Array.from(new Uint8Array(ciphertext)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `enc:${ivHex}:${ctHex}`;
}

async function decryptValue(encrypted: string, secret: string): Promise<string> {
  if (!encrypted.startsWith("enc:")) return encrypted; // plain text fallback
  const [, ivHex, ctHex] = encrypted.split(":");
  const key = await deriveEncKey(secret);
  const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

const SECRET_MASK = "••••••••";

function maskSavedSecret(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? SECRET_MASK : "";
}

async function maskEmailAccountsForAdmin(value: any, encryptionSecret: string): Promise<any[]> {
  if (!Array.isArray(value)) return [];
  // Admin sees the REAL password (decrypted). Transport is already E2E encrypted.
  return await Promise.all(value.map(async (acc: any) => {
    let pw = acc?.password || "";
    if (typeof pw === "string" && pw.startsWith("enc:")) {
      try { pw = await decryptValue(pw, encryptionSecret); } catch { pw = ""; }
    }
    return { ...acc, password: pw };
  }));
}

function findExistingAccountForSecret(existingAccounts: any[], acc: any, index: number): any | null {
  const sameIndex = existingAccounts[index];
  if (sameIndex && String(sameIndex.label || "") === String(acc?.label || "") && String(sameIndex.user || "") === String(acc?.user || "")) return sameIndex;
  return existingAccounts.find((x: any) => String(x?.label || "") === String(acc?.label || "") && String(x?.user || "") === String(acc?.user || ""))
    || existingAccounts.find((x: any) => String(x?.label || "") === String(acc?.label || ""))
    || existingAccounts.find((x: any) => String(x?.user || "") === String(acc?.user || ""))
    || sameIndex
    || null;
}

async function processConfigSecrets(value: any, previous: any, encryptionSecret: string) {
  const config = value && typeof value === "object" ? { ...value } : {};
  const prior = previous && typeof previous === "object" ? previous : {};
  // Store REAL plaintext IMAP password in DB (admin visibility). Legacy enc: values are decrypted.
  if (config.IMAP_PASSWORD === SECRET_MASK) {
    const saved = prior.IMAP_PASSWORD || "";
    config.IMAP_PASSWORD = typeof saved === "string" && saved.startsWith("enc:")
      ? await decryptValue(saved, encryptionSecret).catch(() => "")
      : saved;
  } else if (typeof config.IMAP_PASSWORD === "string" && config.IMAP_PASSWORD.startsWith("enc:")) {
    config.IMAP_PASSWORD = await decryptValue(config.IMAP_PASSWORD, encryptionSecret).catch(() => "");
  }
  return config;
}

async function processEmailAccountSecrets(value: any[], existingAccounts: any[], encryptionSecret: string) {
  return await Promise.all(value.map(async (acc: any, i: number) => {
    let password = acc.password;
    if (password === SECRET_MASK) {
      const existing = findExistingAccountForSecret(existingAccounts, acc, i);
      const saved = existing?.password || "";
      password = typeof saved === "string" && saved.startsWith("enc:")
        ? await decryptValue(saved, encryptionSecret).catch(() => "")
        : saved;
    } else if (typeof password === "string" && password.startsWith("enc:")) {
      password = await decryptValue(password, encryptionSecret).catch(() => "");
    }
    return { ...acc, password: password || "" };
  }));
}

async function maskConfigForAdmin(value: any, encryptionSecret: string) {
  const config = value && typeof value === "object" ? { ...value } : {};
  // Admin sees the REAL IMAP password (decrypted). Transport is already E2E encrypted.
  const pw = config.IMAP_PASSWORD;
  if (typeof pw === "string" && pw.startsWith("enc:")) {
    try { config.IMAP_PASSWORD = await decryptValue(pw, encryptionSecret); } catch { config.IMAP_PASSWORD = ""; }
  } else {
    config.IMAP_PASSWORD = pw || "";
  }
  return config;
}

let __plaintextMigrationDone = false;
async function migrateEncPasswordsToPlaintext(supabase: any, encryptionSecret: string) {
  if (__plaintextMigrationDone) return;
  __plaintextMigrationDone = true;
  try {
    const { data: rows } = await supabase
      .from("app_settings")
      .select("key,value")
      .in("key", ["config", "email_accounts"]);
    for (const row of rows || []) {
      const v = row.value;
      let changed = false;
      let out: any = v;
      if (row.key === "config" && v && typeof v === "object") {
        out = { ...v };
        if (typeof out.IMAP_PASSWORD === "string" && out.IMAP_PASSWORD.startsWith("enc:")) {
          out.IMAP_PASSWORD = await decryptValue(out.IMAP_PASSWORD, encryptionSecret).catch(() => "");
          changed = true;
        }
      } else if (row.key === "email_accounts" && Array.isArray(v)) {
        out = await Promise.all(v.map(async (acc: any) => {
          if (typeof acc?.password === "string" && acc.password.startsWith("enc:")) {
            changed = true;
            return { ...acc, password: await decryptValue(acc.password, encryptionSecret).catch(() => "") };
          }
          return acc;
        }));
      }
      if (changed) {
        await supabase.from("app_settings").upsert({ key: row.key, value: out }, { onConflict: "key" });
        invalidateAllSettings();
      }
    }
  } catch (e) {
    console.warn("[plaintext-migration] skipped:", (e as Error)?.message || e);
    __plaintextMigrationDone = false; // allow retry next isolate
  }
}

async function ensureSettingsSecretsEncrypted(supabase: any, key: string, value: any, encryptionSecret: string): Promise<any> {
  try {
    if (key === "config" && value && typeof value === "object") {
      const processed = await processConfigSecrets(value, value, encryptionSecret);
      if (JSON.stringify(processed) !== JSON.stringify(value)) {
        await supabase.from("app_settings").upsert({ key, value: processed }, { onConflict: "key" });
        invalidateAllSettings();
      }
      return processed;
    }
    if (key === "email_accounts" && Array.isArray(value)) {
      const processed = await processEmailAccountSecrets(value, value, encryptionSecret);
      if (JSON.stringify(processed) !== JSON.stringify(value)) {
        await supabase.from("app_settings").upsert({ key, value: processed }, { onConflict: "key" });
        invalidateAllSettings();
      }
      return processed;
    }
  } catch (e) {
    console.warn("[secrets] self-heal encryption skipped:", (e as Error)?.message || e);
  }
  return value;
}

// --- Audit logging (D.3: enriched with user_agent + optional result) ---
async function auditLog(
  supabase: any,
  action: string,
  actorId: string | null,
  targetId: string | null,
  details: any,
  ip: string,
  extras?: { userAgent?: string | null; result?: string | null },
) {
  try {
    await supabase.from("audit_logs").insert({
      action,
      actor_id: actorId,
      target_id: targetId,
      details,
      ip,
      user_agent: extras?.userAgent ?? null,
      result: extras?.result ?? null,
    });
  } catch (e) { console.error("Audit log error:", e); }
}


// Fires a one-shot "Plan expired" Telegram alert to the admin and marks
// plan_end_notified_at so neither this helper nor the plan-reminders cron
// re-sends. Safe to call fire-and-forget from any request path that
// detects mid-session expiry — races are settled by a conditional update
// that only succeeds when the column is still null.
async function notifyPlanExpiredOnce(supabase: any, user: any) {
  try {
    // Claim the notification slot atomically. If some other request
    // (or the cron) already set the column, .select() returns 0 rows
    // and we bail without sending a duplicate message.
    const { data: claimed } = await supabase
      .from("app_users")
      .update({ plan_end_notified_at: new Date().toISOString() })
      .eq("id", user.id)
      .is("plan_end_notified_at", null)
      .select("id")
      .maybeSingle();
    if (!claimed) return;

    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
    if (!botToken || !chatId) return;
    const fmt = (iso: any) => { try { return new Date(iso).toISOString().replace("T", " ").replace(/\..+/, " UTC"); } catch { return String(iso || ""); } };
    const startedLine = user.plan_starts_at ? `\nStarted: ${fmt(user.plan_starts_at)}` : "";
    const text = [
      "🛑 <b>Plan expired</b>",
      `User: ${user.name || user.username || user.id}${startedLine}`,
      `Ended: ${fmt(user.plan_ends_at)}`,
      `<i>Detected mid-session — user was signed out.</i>`,
    ].join("\n");
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    }).catch(() => {});
  } catch (e) { console.error("notifyPlanExpiredOnce error:", e); }
}



function isPrivateIp(ip: string): boolean {
  if (!ip || ip === "unknown") return true;
  if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.") || ip.startsWith("100.64.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  return false;
}

// Cloudflare's own proxy/Warp ranges. Prefer non-CF candidates when available.
function isCloudflareIp(ip: string): boolean {
  if (!ip) return false;
  if (ip.startsWith("2a06:98c") || ip.startsWith("2606:4700") || ip.startsWith("2803:f800")
    || ip.startsWith("2405:b500") || ip.startsWith("2405:8100") || ip.startsWith("2c0f:f248")
    || ip.startsWith("2a06:98d")) return true;
  if (/^(104\.1[6-9]\.|172\.6[4-9]\.|172\.7[01]\.|173\.245\.[45]\d\.|103\.21\.244\.|103\.22\.200\.|103\.31\.4\.|141\.101\.(6[4-9]|7\d|12[0-7])\.|108\.162\.(19[2-9]|2\d\d)\.|190\.93\.(240|24[1-9]|25[0-5])\.|188\.114\.9[6-9]\.|197\.234\.240\.|198\.41\.(12[8-9]|1[3-9]\d|2\d\d)\.|162\.158\.)/.test(ip)) return true;
  return false;
}

function normalizeIp(raw: string | null | undefined): string {
  if (!raw) return "";
  let ip = String(raw).trim().replace(/^"|"$/g, "");
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const bracket = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return bracket[1].trim();
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  return ip.trim();
}

function isPlausibleIp(ip: string): boolean {
  if (!ip) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every(part => {
      const n = Number(part);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return /^[0-9a-f:]+$/i.test(ip) && ip.includes(":") && ip.length <= 45;
}

function isKnownEdgeIp(ip: string): boolean {
  // AWS Global Accelerator / Vercel-style edge ranges commonly show up as an
  // intermediate XFF hop. They are infrastructure, not the user's residential IP.
  return /^(13\.248\.|76\.223\.|75\.2\.)/.test(ip || "");
}

function isPublicIp(ip: string): boolean {
  return !!ip && ip !== "unknown" && isPlausibleIp(ip) && !isPrivateIp(ip);
}

function isRealPublicClientIp(ip: string): boolean {
  return isPublicIp(ip) && !isCloudflareIp(ip) && !isKnownEdgeIp(ip);
}

function pickClientIp(candidates: { label: string; ip: string }[]): { ip: string; label: string } {
  const clean = candidates
    .map(c => ({ label: c.label, ip: normalizeIp(c.ip) }))
    .filter(c => c.ip);
  const sel = clean.find(c => c.label === "cf-connecting-ip" && isRealPublicClientIp(c.ip))
    || clean.find(c => c.label === "true-client-ip" && isRealPublicClientIp(c.ip))
    || clean.find(c => c.label === "x-real-ip" && isRealPublicClientIp(c.ip))
    || clean.find(c => c.label === "x-client-ip" && isRealPublicClientIp(c.ip))
    || clean.find(c => c.label === "x-forwarded-for" && isRealPublicClientIp(c.ip))
    || clean.find(c => isRealPublicClientIp(c.ip))
    || clean[0];
  return sel || { ip: "unknown", label: "none" };
}

function collectIpCandidates(req: Request): { label: string; ip: string }[] {
  const out: { label: string; ip: string }[] = [];
  const push = (label: string, val: string | null | undefined) => {
    if (!val) return;
    for (const raw of String(val).split(",")) {
      const ip = normalizeIp(raw);
      if (ip) out.push({ label, ip });
    }
  };
  push("x-client-ip", req.headers.get("x-client-ip"));
  push("cf-connecting-ip", req.headers.get("cf-connecting-ip"));
  push("true-client-ip", req.headers.get("true-client-ip"));
  push("x-real-ip", req.headers.get("x-real-ip"));
  push("x-forwarded-for", req.headers.get("x-forwarded-for"));
  return out;
}

function getClientIp(req: Request): string {
  const picked = pickClientIp(collectIpCandidates(req));
  return isRealPublicClientIp(picked.ip) ? picked.ip : "unknown";
}

function getClientIpTrace(req: Request): { ip: string; source: string; candidates: { label: string; ip: string }[]; cfCountry: string; cfRay: string; workerTrace: any } {
  const candidates = collectIpCandidates(req);
  const picked = pickClientIp(candidates);
  let workerTrace: any = null;
  try {
    const raw = req.headers.get("x-ip-trace");
    if (raw) workerTrace = JSON.parse(raw);
  } catch {}
  const workerCandidates = Array.isArray(workerTrace?.candidates)
    ? workerTrace.candidates.map((c: any) => ({ label: String(c?.h || c?.label || "worker"), ip: normalizeIp(c?.ip) })).filter((c: any) => c.ip)
    : [];
  const combined = [...candidates, ...workerCandidates];
  const best = pickClientIp(combined);
  const safeBest = isRealPublicClientIp(best.ip) ? best : { ip: "unknown", label: "none" };
  return {
    ip: safeBest.ip,
    source: safeBest.label,
    candidates: combined,
    cfCountry: req.headers.get("cf-ipcountry") || workerTrace?.cfCountry || "",
    cfRay: req.headers.get("cf-ray") || workerTrace?.cfRay || "",
    workerTrace,
  };
}

function esc(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanR2Text(value: any): string {
  return typeof value === "string"
    ? value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim()
    : "";
}

function normalizeR2AccessKeyId(value: any): { value: string; warnings: string[]; error?: string } {
  const warnings: string[] = [];
  const raw = cleanR2Text(value);
  const cleaned = raw.replace(/\s+/g, "");
  if (raw && raw !== cleaned) {
    warnings.push("Access Key ID contained whitespace; spaces/newlines were removed.");
  }
  if (/[Oo]/.test(cleaned)) {
    warnings.push("Access Key ID contains the letter O. It is being used exactly as entered — verify Cloudflare shows O, not zero 0.");
  }
  if (cleaned && !/^[A-Za-z0-9]{16,128}$/.test(cleaned)) {
    return {
      value: cleaned,
      warnings,
      error: "Access Key ID looks invalid. Paste the R2 S3 Access Key ID exactly as Cloudflare shows it, without spaces.",
    };
  }
  if (cleaned && cleaned.length !== 32) {
    warnings.push("R2 Access Key IDs are usually 32 characters. The exact value entered is being used for the test.");
  }
  return { value: cleaned, warnings };
}

function normalizeR2Config(raw: any, previousSecret = "") {
  const warnings: string[] = [];
  const errors: string[] = [];
  const accountId = cleanR2Text(raw?.accountId).replace(/\s+/g, "").toLowerCase();
  if (accountId && !/^[a-f0-9]{32}$/.test(accountId)) {
    errors.push("Account ID must be the 32-character Cloudflare Account ID, not a Zone ID.");
  }

  const access = normalizeR2AccessKeyId(raw?.accessKeyId);
  warnings.push(...access.warnings);
  if (access.error) errors.push(access.error);

  const secretAccessKey = (cleanR2Text(raw?.secretAccessKey).replace(/\s+/g, "") || previousSecret || "");
  if (secretAccessKey && !/^[a-f0-9]{64}$/i.test(secretAccessKey)) {
    warnings.push("Secret Access Key does not look like Cloudflare's 64-character R2 S3 secret. If test fails, recreate the R2 API token.");
  }

  const bucket = cleanR2Text(raw?.bucket).replace(/^\/+|\/+$/g, "");
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    errors.push("Bucket name looks invalid. Use the exact R2 bucket name, case-sensitive, without slashes.");
  }

  const publicBaseUrl = cleanR2Text(raw?.publicBaseUrl).replace(/\s+/g, "").replace(/\/+$/, "");
  if (publicBaseUrl && !/^https:\/\//i.test(publicBaseUrl)) {
    warnings.push("Public Base URL should start with https:// for browser image loading.");
  }

  let pathPrefix = cleanR2Text(raw?.pathPrefix) || "notifications/";
  pathPrefix = pathPrefix.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (pathPrefix && !pathPrefix.endsWith("/")) pathPrefix += "/";

  return {
    config: {
      accountId,
      accessKeyId: access.value,
      secretAccessKey,
      bucket,
      publicBaseUrl,
      pathPrefix: pathPrefix || "notifications/",
      enabled: raw?.enabled === true,
    },
    warnings,
    errors,
  };
}

function r2FailureMessage(status: number, body: string, warnings: string[]): string {
  const compactBody = body.replace(/\s+/g, " ").trim().slice(0, 220);
  const xmlTag = (tag: string) => {
    const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return m?.[1]?.replace(/\s+/g, " ").trim() || "";
  };
  const cfCode = xmlTag("Code");
  const cfMessage = xmlTag("Message");
  const responseText = cfCode
    ? `Cloudflare response: ${cfCode}${cfMessage ? ` — ${cfMessage}` : ""}`
    : compactBody ? `Cloudflare response: ${compactBody}` : "";
  if (status === 401) {
    return [
      `PUT 401 Unauthorized from Cloudflare R2.`,
      "This means R2 rejected the Access Key ID / Secret Access Key / Account ID combination before upload.",
      warnings.length ? `Note: ${warnings.join(" ")}` : "",
      responseText,
    ].filter(Boolean).join(" ");
  }
  if (status === 403) {
    if (/SignatureDoesNotMatch/i.test(cfCode)) {
      return [
        `PUT 403 Forbidden from Cloudflare R2.`,
        "SignatureDoesNotMatch means the Secret Access Key does not match this Access Key ID, or one value was copied/rotated incorrectly. The app now signs using the exact Access Key ID you entered; recreate one R2 API token and paste both values from the same token.",
        warnings.length ? `Note: ${warnings.join(" ")}` : "",
        responseText,
      ].filter(Boolean).join(" ");
    }
    if (/AccessDenied|InvalidAccessKeyId|Unauthorized/i.test(cfCode + " " + cfMessage)) {
      return [
        `PUT 403 Forbidden from Cloudflare R2.`,
        "Cloudflare accepted the request format but rejected access. Check that this token has Object Read & Write permission for this exact bucket.",
        warnings.length ? `Note: ${warnings.join(" ")}` : "",
        responseText,
      ].filter(Boolean).join(" ");
    }
    return [
      `PUT 403 Forbidden from Cloudflare R2.`,
      "Cloudflare rejected the signed upload request.",
      warnings.length ? `Note: ${warnings.join(" ")}` : "",
      responseText,
    ].filter(Boolean).join(" ");
  }
  return `PUT ${status}: ${compactBody}`;
}

// Cache Telegram config in-memory (per-isolate) for 60s to avoid a DB
// round-trip on every alert/OTP send.
let __tgCfgCache: { at: number; cfg: { botToken: string; chatId: string } | null } | null = null;
async function getTelegramConfig(supabase: any): Promise<{ botToken: string; chatId: string } | null> {
  if (__tgCfgCache && Date.now() - __tgCfgCache.at < 60_000) return __tgCfgCache.cfg;
  let cfg: { botToken: string; chatId: string } | null = null;
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "config").single();
    const c = data?.value as any;
    if (c?.TELEGRAM_BOT_TOKEN && c?.TELEGRAM_CHAT_ID) {
      cfg = { botToken: c.TELEGRAM_BOT_TOKEN, chatId: c.TELEGRAM_CHAT_ID };
    }
  } catch {}
  if (!cfg) {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
    if (botToken && chatId) cfg = { botToken, chatId };
  }
  __tgCfgCache = { at: Date.now(), cfg };
  return cfg;
}

// Timeout-guarded Telegram sendMessage. Prevents a stalled Telegram edge
// (occasional 20-30s hangs) from blocking the whole edge-function response.
async function postTelegram(
  tg: { botToken: string; chatId: string },
  payload: Record<string, unknown>,
  timeoutMs = 6000,
): Promise<Response> {
  return await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tg.chatId, parse_mode: "HTML", disable_web_page_preview: true, ...payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
// Fire-and-forget wrapper for non-critical alerts. Uses EdgeRuntime.waitUntil
// so the response can return immediately while the alert flushes in the bg.
function postTelegramBg(tg: { botToken: string; chatId: string }, payload: Record<string, unknown>) {
  const p = postTelegram(tg, payload, 6000).then(() => {}).catch((e) => console.error("[tg bg] failed:", e));
  const wu = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof wu === "function") wu(p); else void p;
}

function runInBackground(task: Promise<unknown>) {
  const guarded = task.catch((e) => console.error("[background task] failed:", e));
  const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof waitUntil === "function") waitUntil(guarded); else void guarded;
}

// --- Multi-provider IP geolocation (parallel, timeout-guarded) with VPN/proxy detection ---
type LocResult = {
  provider: string;
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  postal?: string;
  lat?: number;
  lng?: number;
  isp?: string;
  org?: string;
  asn?: string;
  timezone?: string;
  flag?: string;
  // Threat / anonymizer signals
  proxy?: boolean;
  vpn?: boolean;
  tor?: boolean;
  hosting?: boolean;
  threatScore?: number; // 0-100
};

type DeviceFingerprint = {
  userAgent?: string;
  platform?: string;
  vendor?: string;
  deviceName?: string;
  deviceModel?: string;
  deviceVendor?: string;
  deviceType?: string;
  deviceInfoSource?: string;
  deviceInfoConfidence?: string;
  osName?: string;
  osVersion?: string;
  browserName?: string;
  browserVersion?: string;
  language?: string;
  languages?: string[];
  screen?: { width: number; height: number; dpr: number; availWidth?: number; availHeight?: number; colorDepth?: number; pixelDepth?: number };
  viewport?: { width: number; height: number };
  orientation?: string;
  timezone?: string;
  utcOffsetMinutes?: number;
  touchPoints?: number;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  cookieEnabled?: boolean;
  onLine?: boolean;
  pdfViewerEnabled?: boolean;
  mobile?: boolean;
  uaBrands?: { brand: string; version: string }[];
  uaPlatform?: string;
  uaPlatformVersion?: string;
  uaModel?: string;
  uaArchitecture?: string;
  uaBitness?: string;
  uaFullVersion?: string;
  network?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  battery?: { level?: number; charging?: boolean; chargingTime?: number; dischargingTime?: number };
  colorScheme?: string;
  reducedMotion?: boolean;
  hdr?: boolean;
  webglVendor?: string;
  webglRenderer?: string;
  canvasHash?: string;
  webdriver?: boolean;
  fingerprintHash?: string;
};

type ClientGeoPayload = {
  status?: string;
  permissionState?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp?: number;
  error?: string;
  publicIp?: string;
  publicIpSource?: string;
  device?: DeviceFingerprint;
};

function compactClientGeoForPending(raw: ClientGeoPayload | null): ClientGeoPayload | null {
  if (!raw) return null;
  const device = raw.device;
  return {
    status: raw.status,
    permissionState: raw.permissionState,
    latitude: raw.latitude,
    longitude: raw.longitude,
    accuracy: raw.accuracy,
    altitude: raw.altitude,
    heading: raw.heading,
    speed: raw.speed,
    timestamp: raw.timestamp,
    error: raw.error,
    publicIp: raw.publicIp,
    publicIpSource: raw.publicIpSource,
    device: device ? {
      userAgent: device.userAgent,
      platform: device.platform,
      vendor: device.vendor,
      deviceName: device.deviceName,
      deviceModel: device.deviceModel,
      deviceVendor: device.deviceVendor,
      deviceType: device.deviceType,
      deviceInfoSource: device.deviceInfoSource,
      deviceInfoConfidence: device.deviceInfoConfidence,
      osName: device.osName,
      osVersion: device.osVersion,
      browserName: device.browserName,
      browserVersion: device.browserVersion,
      language: device.language,
      screen: device.screen,
      viewport: device.viewport,
      timezone: device.timezone,
      utcOffsetMinutes: device.utcOffsetMinutes,
      touchPoints: device.touchPoints,
      deviceMemory: device.deviceMemory,
      hardwareConcurrency: device.hardwareConcurrency,
      mobile: device.mobile,
      uaPlatform: device.uaPlatform,
      uaPlatformVersion: device.uaPlatformVersion,
      uaModel: device.uaModel,
      uaFullVersion: device.uaFullVersion,
      network: device.network,
      webdriver: device.webdriver,
      fingerprintHash: device.fingerprintHash,
    } : undefined,
  };
}

function sanitizeDevice(raw: any): DeviceFingerprint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const str = (v: any, max = 240) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const bool = (v: any) => (typeof v === "boolean" ? v : undefined);
  const d: DeviceFingerprint = {
    userAgent: str(raw.userAgent, 512),
    platform: str(raw.platform, 64),
    vendor: str(raw.vendor, 64),
    deviceName: str(raw.deviceName, 160),
    deviceModel: str(raw.deviceModel, 128),
    deviceVendor: str(raw.deviceVendor, 64),
    deviceType: str(raw.deviceType, 32),
    deviceInfoSource: str(raw.deviceInfoSource, 32),
    deviceInfoConfidence: str(raw.deviceInfoConfidence, 32),
    osName: str(raw.osName, 48),
    osVersion: str(raw.osVersion, 64),
    browserName: str(raw.browserName, 48),
    browserVersion: str(raw.browserVersion, 64),
    language: str(raw.language, 32),
    languages: Array.isArray(raw.languages) ? raw.languages.filter((l: any) => typeof l === "string").slice(0, 6).map((l: string) => l.slice(0, 32)) : undefined,
    timezone: str(raw.timezone, 64),
    utcOffsetMinutes: num(raw.utcOffsetMinutes),
    touchPoints: num(raw.touchPoints),
    deviceMemory: num(raw.deviceMemory),
    hardwareConcurrency: num(raw.hardwareConcurrency),
    cookieEnabled: bool(raw.cookieEnabled),
    onLine: bool(raw.onLine),
    pdfViewerEnabled: bool(raw.pdfViewerEnabled),
    mobile: bool(raw.mobile),
    uaPlatform: str(raw.uaPlatform, 64),
    uaPlatformVersion: str(raw.uaPlatformVersion, 64),
    uaModel: str(raw.uaModel, 128),
    uaArchitecture: str(raw.uaArchitecture, 32),
    uaBitness: str(raw.uaBitness, 8),
    uaFullVersion: str(raw.uaFullVersion, 64),
    colorScheme: str(raw.colorScheme, 24),
    reducedMotion: bool(raw.reducedMotion),
    hdr: bool(raw.hdr),
    webglVendor: str(raw.webglVendor, 128),
    webglRenderer: str(raw.webglRenderer, 200),
    canvasHash: str(raw.canvasHash, 128),
    webdriver: bool(raw.webdriver),
    fingerprintHash: str(raw.fingerprintHash, 128),
    orientation: str(raw.orientation, 32),
  };
  if (raw.screen && typeof raw.screen === "object") {
    const w = num(raw.screen.width), h = num(raw.screen.height), dpr = num(raw.screen.dpr);
    if (w && h) d.screen = {
      width: w, height: h, dpr: dpr || 1,
      availWidth: num(raw.screen.availWidth), availHeight: num(raw.screen.availHeight),
      colorDepth: num(raw.screen.colorDepth), pixelDepth: num(raw.screen.pixelDepth),
    };
  }
  if (raw.viewport && typeof raw.viewport === "object") {
    const w = num(raw.viewport.width), h = num(raw.viewport.height);
    if (w && h) d.viewport = { width: w, height: h };
  }
  if (raw.network && typeof raw.network === "object") {
    d.network = { type: str(raw.network.type, 32), effectiveType: str(raw.network.effectiveType, 16), downlink: num(raw.network.downlink), rtt: num(raw.network.rtt), saveData: bool(raw.network.saveData) };
  }
  if (raw.battery && typeof raw.battery === "object") {
    d.battery = { level: num(raw.battery.level), charging: bool(raw.battery.charging), chargingTime: num(raw.battery.chargingTime), dischargingTime: num(raw.battery.dischargingTime) };
  }
  if (Array.isArray(raw.uaBrands)) {
    d.uaBrands = raw.uaBrands
      .filter((b: any) => b && typeof b.brand === "string")
      .slice(0, 6)
      .map((b: any) => ({ brand: b.brand.slice(0, 64), version: typeof b.version === "string" ? b.version.slice(0, 32) : "" }));
  }
  return d;
}



function sanitizeClientGeo(input: unknown): ClientGeoPayload | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["granted", "denied", "timeout", "unavailable", "unsupported", "error"]);
  const status = typeof raw.status === "string" && allowed.has(raw.status) ? raw.status : "error";
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  const accuracy = Number(raw.accuracy);
  const publicIp = normalizeIp(typeof raw.publicIp === "string" ? raw.publicIp : "");
  const granted = status === "granted"
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  // Bound every client-controlled numeric so a hostile payload cannot produce
  // NaN/Infinity/absurd values that break formatting or DB inserts downstream.
  const rawTs = Number(raw.timestamp);
  const now = Date.now();
  // Login telemetry must describe this login, not a replayed day-old position.
  // Some Android Chromium/WebView builds return a monotonic or clock-skewed
  // GeolocationPosition.timestamp even with fresh, valid coordinates. The
  // encrypted transport already rejects replayed request nonces, so stamp a
  // granted fix at server receipt time when the browser timestamp is unusable.
  const tsValid = Number.isFinite(rawTs) && rawTs > now - 300_000 && rawTs < now + 60_000;
  const bounded = (v: unknown, min: number, max: number): number | null => {
    const n = Number(v);
    return typeof v === "number" && Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  return {
    status: granted ? "granted" : status,
    permissionState: typeof raw.permissionState === "string" ? raw.permissionState.slice(0, 24) : undefined,
    latitude: granted ? latitude : undefined,
    longitude: granted ? longitude : undefined,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(1_000_000, Math.round(accuracy)) : undefined,
    altitude: bounded(raw.altitude, -12_000, 100_000),
    heading: bounded(raw.heading, 0, 360),
    speed: bounded(raw.speed, 0, 100_000),
    timestamp: granted ? (tsValid ? rawTs : now) : undefined,
    error: typeof raw.error === "string" ? raw.error.slice(0, 180) : undefined,
    publicIp: isRealPublicClientIp(publicIp) ? publicIp : undefined,
    device: sanitizeDevice((raw as any).device),
  };

}

function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal, ...(init || {}) })
    .finally(() => clearTimeout(t));
}

function countryToFlag(cc?: string): string {
  const code = (cc || "").trim().toUpperCase();
  if (code.length !== 2) return "🌐";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + code.charCodeAt(0) - 65, A + code.charCodeAt(1) - 65);
}

async function providerIpapiCo(ip: string): Promise<LocResult | null> {
  try {
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
    const r = await fetchWithTimeout(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.error) return null;
    return {
      provider: "ipapi.co",
      ip: d.ip,
      country: d.country_name, countryCode: d.country_code,
      region: d.region, city: d.city, postal: d.postal,
      lat: typeof d.latitude === "number" ? d.latitude : undefined,
      lng: typeof d.longitude === "number" ? d.longitude : undefined,
      isp: d.org, org: d.org, asn: d.asn,
      timezone: d.timezone,
      flag: countryToFlag(d.country_code),
    };
  } catch { return null; }
}

async function providerIpinfoIo(ip: string): Promise<LocResult | null> {
  try {
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
    const r = await fetchWithTimeout(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.error) return null;
    const [latStr, lngStr] = typeof d.loc === "string" ? d.loc.split(",") : [];
    return {
      provider: "ipinfo.io",
      ip: d.ip,
      country: d.country, countryCode: d.country,
      region: d.region, city: d.city, postal: d.postal,
      lat: latStr ? Number(latStr) : undefined,
      lng: lngStr ? Number(lngStr) : undefined,
      isp: d.org, org: d.org,
      timezone: d.timezone,
      flag: countryToFlag(d.country),
      // ipinfo's free tier hints "hosting/vpn" in the org string
      hosting: typeof d.org === "string" && /hosting|datacenter|cloud|server|vpn|proxy/i.test(d.org),
    };
  } catch { return null; }
}

async function providerFreeIpApi(ip: string): Promise<LocResult | null> {
  try {
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
    const r = await fetchWithTimeout(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || (!d.ipAddress && !d.countryName)) return null;
    return {
      provider: "freeipapi.com",
      ip: d.ipAddress,
      country: d.countryName, countryCode: d.countryCode,
      region: d.regionName, city: d.cityName, postal: d.zipCode,
      lat: typeof d.latitude === "number" ? d.latitude : undefined,
      lng: typeof d.longitude === "number" ? d.longitude : undefined,
      timezone: d.timeZone,
      flag: countryToFlag(d.countryCode),
    };
  } catch { return null; }
}

async function reverseGpsLocation(geo: ClientGeoPayload): Promise<LocResult | null> {
  if (geo.status !== "granted" || typeof geo.latitude !== "number" || typeof geo.longitude !== "number") return null;
  const lat = geo.latitude, lng = geo.longitude;

  // Provider 1: BigDataCloud (fast, generous free tier, no key)
  const tryBdc = async (): Promise<LocResult | null> => {
    try {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
      const r = await fetchWithTimeout(url, 3500);
      if (!r.ok) return null;
      const d = await r.json();
      const countryCode = d.countryCode || d.principalSubdivisionCode?.split("-")?.[0];
      const city = d.city || d.locality || d.localityInfo?.administrative?.[3]?.name || d.localityInfo?.administrative?.[2]?.name;
      if (!city && !d.principalSubdivision && !d.countryName) return null;
      return {
        provider: "device-gps",
        country: d.countryName, countryCode,
        region: d.principalSubdivision,
        city,
        postal: d.postcode,
        lat, lng,
        timezone: d.localityInfo?.informative?.find?.((x: any) => x?.description === "time zone")?.name,
        flag: countryToFlag(countryCode),
      };
    } catch { return null; }
  };

  // Provider 2: OpenStreetMap Nominatim (very accurate, free, requires UA)
  const tryNominatim = async (): Promise<LocResult | null> => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
      const r = await fetchWithTimeout(url, 4000, { headers: { "User-Agent": "netflix-otp-manager/1.0 (login-alerts)", "Accept-Language": "en" } as any });
      if (!r.ok) return null;
      const d = await r.json();
      const a = d.address || {};
      const city = a.city || a.town || a.village || a.municipality || a.suburb || a.county || a.state_district;
      const countryCode = (a.country_code || "").toUpperCase();
      if (!city && !a.state && !a.country) return null;
      return {
        provider: "device-gps",
        country: a.country, countryCode,
        region: a.state || a.region,
        city, postal: a.postcode,
        lat, lng,
        flag: countryToFlag(countryCode),
      };
    } catch { return null; }
  };

  // Try both in parallel; prefer whichever returns a city first.
  const [a, b] = await Promise.all([tryBdc(), tryNominatim()]);
  const pick = (a?.city ? a : (b?.city ? b : (a || b)));
  if (pick) return pick;

  return { provider: "device-gps", lat, lng, flag: "📍" };
}


// Dedicated VPN/proxy detector (proxycheck.io — 1000/day free without key)
async function detectAnonymizer(ip: string): Promise<{ proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null> {
  try {
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
    const r = await fetchWithTimeout(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=1&asn=1&risk=1`, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    const node = d?.[ip];
    if (!node) return null;
    const type = (node.type || "").toLowerCase(); // "VPN","TOR","PUB","Hosting","Business","Residential"
    return {
      proxy: node.proxy === "yes",
      vpn: /vpn/.test(type),
      tor: /tor/.test(type),
      hosting: /hosting|server|datacenter/.test(type),
      type: node.type,
      provider: node.provider,
    };
  } catch { return null; }
}

// Reject responses that clearly geolocate our own infrastructure (Supabase/Deno edge
// in Oregon/Portland, or a Cloudflare datacenter) — happens when a provider is called
// without a valid client IP and falls back to the CALLER's IP.
function isInfraResponse(r: LocResult): boolean {
  const org = `${r.isp || ""} ${r.org || ""}`.toLowerCase();
  if (/cloudflare|amazon|aws|google|microsoft|azure|digitalocean|hetzner|ovh|linode|oracle|fastly|akamai|deno|supabase|datacenter|hosting/.test(org)) return true;
  const city = (r.city || "").toLowerCase();
  const region = (r.region || "").toLowerCase();
  // Supabase edge in us-west-2 geolocates to Portland/Boardman, Oregon
  if (city === "portland" && /oregon|or/.test(region)) return true;
  if (city === "boardman") return true;
  return false;
}

async function resolveLocation(ip: string): Promise<{
  merged: LocResult; confidence: "high" | "medium" | "low"; agreed: number; results: LocResult[];
  anonymizer: { proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null;
}> {
  // HARD GUARD: never call geo providers without a real, public, non-CF client IP.
  // Otherwise every provider falls back to the CALLER (Supabase edge = Portland, OR).
  if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) {
    console.warn("[resolveLocation] refusing lookup — invalid client IP:", JSON.stringify({ ip, reason: !ip || ip === "unknown" ? "missing" : isPrivateIp(ip) ? "private" : isCloudflareIp(ip) ? "cloudflare-edge" : "hosting-edge-hop" }));
    return { merged: { provider: "none", ip: ip || "unknown" }, confidence: "low", agreed: 0, results: [], anonymizer: null };
  }

  const providers: Array<Promise<LocResult | null>> = [
    providerIpapiCo(ip),
    providerIpinfoIo(ip),
    providerFreeIpApi(ip),
  ];
  const [settled, anonymizer] = await Promise.all([
    Promise.allSettled(providers),
    detectAnonymizer(ip),
  ]);
  let results = settled.map(s => s.status === "fulfilled" ? s.value : null).filter(Boolean) as LocResult[];

  // Drop any provider result that geolocates OUR infra (Portland/CF/AWS/etc.) —
  // that indicates the provider ignored our IP and geolocated the caller.
  const filtered = results.filter(r => !isInfraResponse(r));
  if (filtered.length > 0) results = filtered;

  if (results.length === 0) {
    console.warn("[resolveLocation] all providers returned infra/no data for ip=", ip);
    return { merged: { provider: "none", ip }, confidence: "low", agreed: 0, results: [], anonymizer };
  }
  const buckets = new Map<string, LocResult[]>();
  for (const r of results) {
    const k = `${(r.countryCode || r.country || "").toLowerCase()}|${(r.city || "").toLowerCase()}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(r);
  }
  const priority = ["ipapi.co", "ipinfo.io", "freeipapi.com"];
  let bestBucket: LocResult[] = [];
  let bestSize = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length > bestSize) { bestBucket = bucket; bestSize = bucket.length; }
  }
  bestBucket.sort((a, b) => priority.indexOf(a.provider) - priority.indexOf(b.provider));
  const primary = bestBucket[0];
  const merged: LocResult = { ...primary };
  for (const r of results) {
    for (const key of ["country","countryCode","region","city","postal","lat","lng","isp","org","asn","timezone","flag","ip","proxy","hosting"] as const) {
      if (merged[key] === undefined || merged[key] === null || merged[key] === "") {
        (merged as any)[key] = (r as any)[key];
      }
    }
  }
  merged.flag = merged.flag || countryToFlag(merged.countryCode);
  if (anonymizer) {
    merged.proxy = merged.proxy || anonymizer.proxy;
    merged.vpn = anonymizer.vpn;
    merged.tor = anonymizer.tor;
    merged.hosting = merged.hosting || anonymizer.hosting;
  }
  const agreed = bestSize;
  const confidence: "high" | "medium" | "low" =
    agreed >= 3 ? "high" : agreed >= 2 ? "medium" : "low";
  return { merged, confidence, agreed, results, anonymizer };
}

function parseUserAgent(ua: string): { browser: string; browserVersion?: string; os: string; osVersion?: string } {
  const s = ua || "";
  let browser = "Unknown"; let browserVersion: string | undefined;
  const m = (re: RegExp) => { const r = s.match(re); return r?.[1]; };
  if (/Edg\//.test(s)) { browser = "Edge"; browserVersion = m(/Edg\/([\d.]+)/); }
  else if (/OPR\/|Opera/.test(s)) { browser = "Opera"; browserVersion = m(/OPR\/([\d.]+)/); }
  else if (/SamsungBrowser\//.test(s)) { browser = "Samsung Internet"; browserVersion = m(/SamsungBrowser\/([\d.]+)/); }
  else if (/MiuiBrowser\//.test(s)) { browser = "Mi Browser"; browserVersion = m(/MiuiBrowser\/([\d.]+)/); }
  else if (/Chrome\//.test(s) && !/Edg\//.test(s)) { browser = "Chrome"; browserVersion = m(/Chrome\/([\d.]+)/); }
  else if (/Firefox\//.test(s)) { browser = "Firefox"; browserVersion = m(/Firefox\/([\d.]+)/); }
  else if (/Safari\//.test(s) && !/Chrome\//.test(s)) { browser = "Safari"; browserVersion = m(/Version\/([\d.]+)/); }
  let os = "Unknown"; let osVersion: string | undefined;
  if (/Windows NT/.test(s)) { os = "Windows"; const v = m(/Windows NT ([\d.]+)/); const map: Record<string,string> = {"10.0":"10/11","6.3":"8.1","6.2":"8","6.1":"7"}; osVersion = v ? (map[v] || v) : undefined; }
  else if (/Android/.test(s)) { os = "Android"; osVersion = m(/Android ([\d.]+)/); }
  else if (/iPhone|iPad|iPod/.test(s)) { os = /iPad/.test(s) ? "iPadOS" : "iOS"; osVersion = (m(/OS ([\d_]+)/) || "").replace(/_/g, "."); }
  else if (/Mac OS X/.test(s)) { os = "macOS"; osVersion = (m(/Mac OS X ([\d_.]+)/) || "").replace(/_/g, "."); }
  else if (/CrOS/.test(s)) { os = "ChromeOS"; }
  else if (/Linux/.test(s)) { os = "Linux"; }
  return { browser, browserVersion, os, osVersion };
}

function normalizedVersion(value?: string) {
  const v = String(value || "").trim();
  if (!v) return "";
  const parts = v.split(".").filter(Boolean);
  if (parts.length >= 2 && parts.slice(1).every((p) => p === "0")) return parts[0];
  return parts.slice(0, 3).join(".");
}

function isReliableDeviceModel(model?: string) {
  const m = String(model || "").trim();
  return !!m && m.length >= 2 && !/^(k|android|mobile|linux|build|wv|unknown|generic)$/i.test(m);
}

function normalizeDeviceIdentity(ua: string, device?: DeviceFingerprint): { model: string; type: string; vendor: string; source: string; confidence: string } {
  const inferred = inferDeviceModel(ua, device);
  const model = isReliableDeviceModel(device?.deviceModel) ? device!.deviceModel! : isReliableDeviceModel(device?.uaModel) ? device!.uaModel! : inferred.model;
  const type = device?.deviceType || inferred.type;
  const vendor = device?.deviceVendor || inferred.vendor;
  const source = device?.deviceInfoSource || (isReliableDeviceModel(device?.uaModel) ? "ua-ch" : "ua/fallback");
  const confidence = device?.deviceInfoConfidence || (isReliableDeviceModel(device?.uaModel) ? "high" : isReliableDeviceModel(model) ? "medium" : "low");
  return { model, type, vendor, source, confidence };
}

function inferDeviceModel(ua: string, device?: DeviceFingerprint): { model: string; type: string; vendor: string } {
  const s = ua || "";
  let model = isReliableDeviceModel(device?.uaModel) ? device!.uaModel! : "";
  let vendor = "";
  let type = "Desktop";
  const mobile = device?.mobile ?? /Mobi|Android|iPhone|iPod/.test(s);
  const tablet = /iPad|Tablet|Nexus 7|Nexus 10|SM-T\d/.test(s);
  type = tablet ? "Tablet" : mobile ? "Mobile" : "Desktop";
  if (!model) {
    if (/iPhone/.test(s)) { model = "iPhone"; vendor = "Apple"; }
    else if (/iPad/.test(s)) { model = "iPad"; vendor = "Apple"; }
    else if (/iPod/.test(s)) { model = "iPod"; vendor = "Apple"; }
    else {
      const andm = s.match(/Android[^;]*;\s*[^;]*;\s*([^;)]+)\s+Build/) || s.match(/;\s*([^;)]+)\)\s+AppleWebKit/);
      if (andm) model = andm[1].trim();
      const m2 = s.match(/;\s*([A-Z]{1,4}-[A-Z0-9]+)\s/i); if (m2 && !model) model = m2[1];
    }
  }
  if (!vendor) {
    if (/Samsung|SM-|GT-/.test(s + " " + model)) vendor = "Samsung";
    else if (/Xiaomi|Redmi|MI |POCO/i.test(s + " " + model)) vendor = "Xiaomi";
    else if (/OnePlus/i.test(s + " " + model)) vendor = "OnePlus";
    else if (/Pixel/i.test(s + " " + model)) vendor = "Google";
    else if (/HUAWEI|Honor/i.test(s + " " + model)) vendor = "Huawei";
    else if (/Realme/i.test(s + " " + model)) vendor = "Realme";
    else if (/OPPO/i.test(s + " " + model)) vendor = "Oppo";
    else if (/Vivo/i.test(s + " " + model)) vendor = "Vivo";
    else if (/Motorola|Moto /i.test(s + " " + model)) vendor = "Motorola";
    else if (/Apple|iPhone|iPad|Macintosh/.test(s)) vendor = "Apple";
    else if (/Windows/.test(s)) vendor = "PC";
  }
  if (!model && device?.uaPlatform && device.uaPlatform !== "Android") model = `${device.uaPlatform}${device.uaPlatformVersion ? " " + normalizedVersion(device.uaPlatformVersion) : ""}`;
  if (!model) model = type;
  return { model, type, vendor };
}

async function sendPrimaryLoginAlert(
  supabase: any, req: Request, user: any, status: "success" | "failed", ip: string,
  loc: LocResult, ipLoc: LocResult, confidence: string, agreed: number,
  anonymizer: { proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null,
  totalProviders: number,
  clientGeo: ClientGeoPayload | null,
  ipTrace: { ip: string; source: string; candidates: { label: string; ip: string }[]; cfCountry: string; cfRay: string; workerTrace: any } | null,
) {
  const tg = await getTelegramConfig(supabase);
  if (!tg) return;
  const forwardedUa = clientGeo?.device?.userAgent || req.headers.get("x-client-user-agent") || req.headers.get("user-agent") || "";
  const parsedUa = parseUserAgent(forwardedUa);
  const identity = normalizeDeviceIdentity(forwardedUa, clientGeo?.device);
  const browser = clientGeo?.device?.browserName || parsedUa.browser;
  const browserVersion = clientGeo?.device?.browserVersion || parsedUa.browserVersion;
  const os = clientGeo?.device?.osName || parsedUa.os;
  const osVersion = clientGeo?.device?.osVersion || parsedUa.osVersion;
  const browserStr = `${browser}${browserVersion ? " " + normalizedVersion(browserVersion) : ""}`;
  const osStr = `${os}${osVersion ? " " + normalizedVersion(osVersion) : ""}`;
  const deviceStr = `${identity.vendor ? identity.vendor + " " : ""}${identity.model}${identity.model !== identity.type ? ` (${identity.type})` : ""}`;
  const deviceConfidenceLine = identity.confidence !== "high"
    ? `ℹ️ Device model exact name hidden by browser privacy; showing best stable value (${esc(identity.source)} · ${esc(identity.confidence)}).`
    : `✅ Device model verified by browser Client Hints (${esc(identity.source)}).`;
  const displayName = user?.name || user?.username || "Unknown";
  const role = user?.role || "user";
  const isGps = loc.provider === "device-gps";

  // GPS wins entirely for map + coords when granted.
  const gpsLat = clientGeo?.status === "granted" ? clientGeo.latitude : undefined;
  const gpsLng = clientGeo?.status === "granted" ? clientGeo.longitude : undefined;
  const mapLat = typeof gpsLat === "number" ? gpsLat : (typeof loc.lat === "number" ? loc.lat : undefined);
  const mapLng = typeof gpsLng === "number" ? gpsLng : (typeof loc.lng === "number" ? loc.lng : undefined);
  const mapLink = (typeof mapLat === "number" && typeof mapLng === "number")
    ? `https://www.google.com/maps?q=${mapLat},${mapLng}` : null;

  const flag = loc.flag || countryToFlag(loc.countryCode);
  const locLine = isGps && typeof loc.lat === "number" && typeof loc.lng === "number"
    ? `${[loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "GPS coordinates"} (${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)})`
    : [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "Unknown location";
  const isp = ipLoc.isp || ipLoc.org || loc.isp || loc.org || "Unknown ISP";
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
  const statusEmoji = status === "success" ? "✅" : "❌";

  const isInvalidEdgeIp = !ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip);
  const isAnon = !isGps && !!(ipLoc.vpn || ipLoc.proxy || ipLoc.tor || ipLoc.hosting || anonymizer?.vpn || anonymizer?.proxy || anonymizer?.tor || anonymizer?.hosting);
  const anonBadge = (ipLoc.tor || anonymizer?.tor) ? "🧅 TOR" : (ipLoc.vpn || anonymizer?.vpn) ? "🛡 VPN" : (ipLoc.proxy || anonymizer?.proxy) ? "🎭 PROXY" : (ipLoc.hosting || anonymizer?.hosting) ? "🖥 HOSTING/DC" : "";
  const anonNote = isAnon
    ? `⚠️ <b>Network IP is masked</b> — ${anonBadge}${anonymizer?.provider ? ` · <i>${esc(anonymizer.provider)}</i>` : ""}\n<i>No device GPS was available, so IP location may be only a VPN/proxy exit-node.</i>`
    : "";

  const gpsLine = clientGeo?.status === "granted"
    ? `🛰 <b>GPS:</b> granted · accuracy ${clientGeo.accuracy ? `±${esc(String(clientGeo.accuracy))}m` : "unknown"}${clientGeo.timestamp ? ` · fix ${esc(new Date(clientGeo.timestamp).toISOString())}` : ""}`
    : `🛰 <b>GPS:</b> ${esc(clientGeo?.status || "not sent")}${clientGeo?.permissionState ? ` · permission ${esc(clientGeo.permissionState)}` : ""}${clientGeo?.error ? ` · ${esc(clientGeo.error)}` : ""}`;

  const locationSource = isGps ? "Device GPS (exact)" : "IP lookup (approximate — may be VPN/proxy)";

  const networkIpLine = isInvalidEdgeIp
    ? `🌐 <b>Network IP:</b> <code>unavailable</code> <i>(only edge/proxy hop seen${ip && ip !== "unknown" ? `: ${esc(ip)}` : ""})</i>`
    : `🌐 <b>Network IP:</b> <code>${esc(ip)}</code>`;
  const ipTraceLine = ipTrace ? `🧭 <b>IP source:</b> <code>${esc(ipTrace.source)}</code>${ipTrace.cfCountry ? ` · CF ${esc(ipTrace.cfCountry)}` : ""}${ipTrace.candidates?.length ? ` · checked ${ipTrace.candidates.length}` : ""}` : "";

  const statusBanner = status === "success"
    ? `✅ <b>LOGIN SUCCESS</b>`
    : `❌ <b>LOGIN FAILED</b>`;
  const roleBadge = role === "admin" ? "👑 ADMIN" : "👤 USER";
  const cityLine = [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "Unknown";
  const coordsLine = (typeof mapLat === "number" && typeof mapLng === "number")
    ? `<code>${mapLat.toFixed(6)}, ${mapLng.toFixed(6)}</code>` : "<code>—</code>";
  const screenLine = clientGeo?.device?.screen ? `${clientGeo.device.screen.width}×${clientGeo.device.screen.height} @${clientGeo.device.screen.dpr}x` : "";

  const headline = status === "success"
    ? `🟢  <b>SIGN-IN SUCCESS</b>`
    : `🔴  <b>SIGN-IN BLOCKED</b>`;
  const roleChip = role === "admin" ? "👑 Admin" : "👤 Member";
  // GPS coords are client-supplied, so cross-check them against the IP-derived
  // position. A large gap means the "GPS lock" cannot be trusted at face value
  // (spoofed coords, or a VPN/relay on the network side).
  const gpsIpKm = (isGps && typeof gpsLat === "number" && typeof gpsLng === "number"
    && typeof ipLoc.lat === "number" && typeof ipLoc.lng === "number")
    ? haversineKm({ lat: ipLoc.lat, lng: ipLoc.lng }, { lat: gpsLat, lng: gpsLng })
    : null;
  const gpsIpFar = typeof gpsIpKm === "number" && gpsIpKm > 500;
  // Browser GPS is client-reported telemetry, not cryptographic proof. Only
  // present it as corroborated when it is geographically plausible beside the
  // independently observed network IP; never show a false top-level TRUSTED.
  const gpsBadge = isGps
    ? (gpsIpFar ? "⚠️ <b>GPS/IP MISMATCH</b>" : "🎯 <b>GPS REPORTED</b>")
    : "📡 <b>IP APPROX</b>";
  const trustBadge = isGps
    ? (gpsIpFar
        ? `🟠 <b>REVIEW</b> · GPS/IP ${Math.round(gpsIpKm!)} km apart`
        : `🟢 <b>CORROBORATED</b> · GPS ±${esc(String(clientGeo?.accuracy || "?"))}m`)
    : (isAnon ? `🔴 <b>MASKED</b> · ${anonBadge}` : `🟡 <b>NETWORK ONLY</b>`);
  const trustLabel = isGps
    ? (gpsIpFar
        ? `🟠 GPS/IP mismatch <i>· ${Math.round(gpsIpKm!)} km apart</i>`
        : `🟢 Trusted <i>· GPS ±${esc(String(clientGeo?.accuracy || "?"))}m</i>`)
    : (isAnon ? `🔴 Masked <i>· ${anonBadge}</i>` : `🟡 Network only`);
  const sourceLabel = isGps ? (gpsIpFar ? "🎯 GPS Lock ⚠️" : "🎯 GPS Lock") : "📡 IP Approx";

  const ispRaw = (ipLoc.isp || ipLoc.org || loc.isp || loc.org || "Unknown ISP").slice(0, 60);
  const asnRaw = ((ipLoc.asn || loc.asn) || "").toString().split(" ")[0] || "";
  const tzRaw = loc.timezone || clientGeo?.device?.timezone || "";
  const coordsRaw = (typeof mapLat === "number" && typeof mapLng === "number")
    ? `${mapLat.toFixed(6)}, ${mapLng.toFixed(6)}` : "";
  const div = `<i>────────────────────</i>`;
  const bar = "▎";

  // Copy-friendly one-liner in a <pre> block (Telegram shows a copy icon on <pre>).
  const summaryOneLiner =
    `${displayName} @${user?.username || ""}\n` +
    `IP  : ${ip || "n/a"}\n` +
    `ISP : ${ispRaw}${asnRaw ? "  (" + asnRaw + ")" : ""}\n` +
    `Geo : ${cityLine}${coordsRaw ? "  [" + coordsRaw + "]" : ""}\n` +
    `Dev : ${deviceStr} [${identity.confidence}]\n` +
    `UA  : ${browserStr} · ${osStr}\n` +
    `Time: ${time}`;

  // Optional expandable raw details (UA + trace) for power users.
  const rawDetails =
    `User-Agent:\n${forwardedUa || "n/a"}\n\n` +
    `IP trace source: ${ipTrace?.source || "n/a"}\n` +
    `Candidates checked: ${ipTrace?.candidates?.length || 0}\n` +
    (ipTrace?.cfCountry ? `CF country: ${ipTrace.cfCountry}\n` : "") +
    (ipTrace?.cfRay ? `CF ray: ${ipTrace.cfRay}\n` : "") +
    `GPS status: ${clientGeo?.status || "not sent"}` +
    (clientGeo?.permissionState ? ` (permission ${clientGeo.permissionState})` : "") +
    (typeof gpsIpKm === "number" ? `\nGPS vs IP distance: ${Math.round(gpsIpKm)} km${gpsIpFar ? "  ⚠️ implausible" : ""}` : "");


  const text = [
    headline,
    ``,
    `${roleChip}  <b>${esc(displayName)}</b>  <i>@${esc(user?.username || "")}</i>`,
    `🕐 <i>${esc(time)}</i>`,
    ``,
    ``,
    `${bar} 📍 <b>LOCATION</b>   <i>· ${sourceLabel}</i>`,
    ``,
    `${flag}  <b>${esc(cityLine)}</b>${loc.postal ? ` <i>· ${esc(loc.postal)}</i>` : ""}`,
    coordsRaw ? `` : null,
    coordsRaw ? `🧭  <code>${esc(coordsRaw)}</code>` : null,
    mapLink ? `` : null,
    mapLink ? `🗺  <a href="${mapLink}"><b>Open in Google Maps →</b></a>` : null,
    ``,
    ``,
    `${bar} 🌐 <b>NETWORK</b>   <i>· ${trustLabel}</i>`,
    ``,
    isInvalidEdgeIp
      ? `IP     <i>unavailable (edge hop${ip && ip !== "unknown" ? ": " + esc(ip) : ""})</i>`
      : `IP     <code>${esc(ip)}</code>`,
    ``,
    `ISP    ${esc(ispRaw)}`,
    asnRaw || tzRaw ? `` : null,
    asnRaw ? `ASN    <code>${esc(asnRaw)}</code>${tzRaw ? `   <i>· ${esc(tzRaw)}</i>` : ""}` : (tzRaw ? `TZ     <i>${esc(tzRaw)}</i>` : null),
    ``,
    ``,
    `${bar} 📱 <b>DEVICE</b>`,
    ``,
    `<b>${esc(deviceStr)}</b>`,
    `<i>${deviceConfidenceLine}</i>`,
    ``,
    `🌐 ${esc(browserStr)}    💻 ${esc(osStr)}`,
    screenLine ? `` : null,
    screenLine ? `🖥 <i>${screenLine}</i>` : null,
    anonNote ? `` : null,
    anonNote ? `⚠️ <b>Anonymizer detected</b> — ${anonBadge}${anonymizer?.provider ? ` <i>· ${esc(anonymizer.provider)}</i>` : ""}` : null,
    anonNote ? `<i>No device GPS available — IP may be a VPN/proxy exit-node.</i>` : null,
    ``,
    ``,
    `${bar} 📋 <b>QUICK COPY</b>  <i>· tap the block below to copy</i>`,
    ``,
    `<pre>${esc(summaryOneLiner)}</pre>`,
    ``,
    `<blockquote expandable><b>🔎 Raw technical details</b>\n${esc(rawDetails)}</blockquote>`,
  ].filter((l) => l !== null).join("\n");


  try {
    const tgRes = await postTelegram(tg, { text });
    if (!tgRes.ok) console.error("[tg primary alert] failed:", await tgRes.text());
  } catch (e) { console.error("[tg primary alert] error:", e); }
}

// Minimal Telegram alert used when admin disabled the location policy.
// No reverse-geocoding, no IP lookup, no VPN detection — only profile,
// device/browser/OS, timestamp, raw IP.
async function sendMinimalLoginAlert(
  supabase: any,
  req: Request,
  user: any,
  status: "success" | "failed",
  ip: string,
  clientGeo: ClientGeoPayload | null,
) {
  const tg = await getTelegramConfig(supabase);
  if (!tg) return;
  const forwardedUa = clientGeo?.device?.userAgent || req.headers.get("x-client-user-agent") || req.headers.get("user-agent") || "";
  const parsedUa = parseUserAgent(forwardedUa);
  const identity = normalizeDeviceIdentity(forwardedUa, clientGeo?.device);
  const browser = clientGeo?.device?.browserName || parsedUa.browser;
  const browserVersion = clientGeo?.device?.browserVersion || parsedUa.browserVersion;
  const os = clientGeo?.device?.osName || parsedUa.os;
  const osVersion = clientGeo?.device?.osVersion || parsedUa.osVersion;
  const browserStr = `${browser}${browserVersion ? " " + normalizedVersion(browserVersion) : ""}`;
  const osStr = `${os}${osVersion ? " " + normalizedVersion(osVersion) : ""}`;
  const deviceStr = `${identity.vendor ? identity.vendor + " " : ""}${identity.model}${identity.model !== identity.type ? ` (${identity.type})` : ""}`;
  const displayName = user?.name || user?.username || "Unknown";
  const role = user?.role || "user";
  const roleChip = role === "admin" ? "👑 Admin" : (user?.is_free ? "🆓 Free" : "👤 Member");
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
  const headline = status === "success" ? "🟢  <b>SIGN-IN SUCCESS</b>" : "🔴  <b>SIGN-IN BLOCKED</b>";
  const ipLine = ip && ip !== "unknown" ? `<code>${esc(ip)}</code>` : "<i>unavailable</i>";
  const text = [
    headline,
    ``,
    `${roleChip}  <b>${esc(displayName)}</b>${user?.username ? `  <i>@${esc(user.username)}</i>` : ""}`,
    `🕐 <i>${esc(time)}</i>`,
    ``,
    `📱 <b>${esc(deviceStr)}</b>`,
    `🌐 ${esc(browserStr)}    💻 ${esc(osStr)}`,
    `🌐 IP  ${ipLine}`,
    ``,
    `<i>Location tracking is disabled by admin.</i>`,
  ].join("\n");
  try {
    const tgRes = await postTelegram(tg, { text });
    if (!tgRes.ok) console.error("[tg minimal alert] failed:", await tgRes.text());
  } catch (e) { console.error("[tg minimal alert] error:", e); }
}




async function sendLoginNotification(
  supabase: any,
  req: Request,
  user: any,
  status: "success" | "failed",
  rawClientGeo?: unknown,
  opts?: { locationRequired?: boolean },
) {
  try {
    if (!user) return;
    const headerIpTrace = getClientIpTrace(req);
    const clientGeo = sanitizeClientGeo(rawClientGeo);
    // Never let caller-controlled telemetry replace the network-observed IP.
    // GPS/device fields are useful context, but request headers remain the
    // authoritative source for IP, ASN, proxy checks, and login-event storage.
    const ipTrace = headerIpTrace;
    const ip = ipTrace.ip;

    // Resolve location policy (fallback re-read if caller didn't pass it).
    let locationRequired = opts?.locationRequired;
    if (locationRequired === undefined) {
      try {
        const { data: locRow } = await readSettingRow(supabase, "location_policy");
        const v: any = locRow?.value;
        locationRequired = !(v && typeof v === "object" && v.required === false);
      } catch { locationRequired = true; }
    }

    // When admin disabled the location policy, send a minimal Telegram alert
    // (device + browser + timestamp + raw IP only) — no geocoding, no IP lookup.
    if (!locationRequired) {
      try { await sendMinimalLoginAlert(supabase, req, user, status, ip, clientGeo); }
      catch (e) { console.error("[tg minimal alert] error:", e); }
      try {
        await persistLoginEvent(supabase, req, user, status, ip, ipTrace, clientGeo,
          { provider: "disabled", ip } as any, null, null);
      } catch (e) { console.error("[login_events] insert failed:", e); }
      return;
    }

    // ---- Explicit debug block (per spec) ----
    const hdr = (n: string) => req.headers.get(n) || "";
    console.log(
      "\n=== [login-notify] IP TRACE ===\n" +
      "Detected Headers:\n" +
      `  CF-Connecting-IP: ${hdr("cf-connecting-ip")}\n` +
      `  True-Client-IP:   ${hdr("true-client-ip")}\n` +
      `  X-Forwarded-For:  ${hdr("x-forwarded-for")}\n` +
      `  X-Real-IP:        ${hdr("x-real-ip")}\n` +
      `  X-Client-IP:      ${hdr("x-client-ip")} (from Cloudflare Worker)\n` +
      `Selected Client IP: ${ip}   (source: ${ipTrace.source})\n` +
      `Browser Public IP: ${clientGeo?.publicIp || "not sent"}   (source: ${clientGeo?.publicIpSource || "none"})\n` +
      `CF Country: ${ipTrace.cfCountry}   CF Ray: ${ipTrace.cfRay}\n` +
      `Worker Trace: ${JSON.stringify(ipTrace.workerTrace || {})}\n` +
      `Client GPS: ${clientGeo?.status || "none"}${clientGeo?.status === "granted" ? ` (${clientGeo.latitude},${clientGeo.longitude})` : ""}\n` +
      "==============================="
    );


    const [locRes, gpsLoc] = await Promise.all([
      resolveLocation(ip),
      clientGeo?.status === "granted" ? reverseGpsLocation(clientGeo) : Promise.resolve(null),
    ]);
    const { merged, confidence, agreed, anonymizer } = locRes;
    const totalProviders = 3;
    const displayLoc = gpsLoc || merged;

    await sendPrimaryLoginAlert(
      supabase, req, user, status,
      merged.ip || ip, displayLoc, merged, confidence, agreed, anonymizer,
      totalProviders, clientGeo, ipTrace,
    );

    // ----- Persist rich login event -----
    try {
      await persistLoginEvent(supabase, req, user, status, ip, ipTrace, clientGeo, merged, gpsLoc, anonymizer);
    } catch (e) {
      console.error("[login_events] insert failed:", e);
    }
  } catch (err) {
    console.error("[notification] login notify failed:", err);
  }
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function persistLoginEvent(
  supabase: any, req: Request, user: any, status: "success" | "failed",
  ip: string, ipTrace: any, clientGeo: ClientGeoPayload | null,
  merged: LocResult, gpsLoc: LocResult | null,
  anonymizer: { proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null,
) {
  const dev = clientGeo?.device || {};
  const forwardedUa = dev.userAgent || req.headers.get("x-client-user-agent") || req.headers.get("user-agent") || "";
  const parsedUa = parseUserAgent(forwardedUa);
  const identity = normalizeDeviceIdentity(forwardedUa, dev);
  const browser = dev.browserName || parsedUa.browser;
  const browserVersion = dev.browserVersion || parsedUa.browserVersion;
  const os = dev.osName || parsedUa.os;
  const osVersion = dev.osVersion || parsedUa.osVersion;
  const fpHash = dev.fingerprintHash || null;

  // is_new_device: fingerprint (or user_agent) not seen for this user in past 90d
  let isNewDevice = true;
  try {
    if (user?.id && fpHash) {
      const { data: prev } = await supabase.from("login_events")
        .select("id").eq("user_id", user.id).eq("fingerprint_hash", fpHash).limit(1);
      isNewDevice = !prev || prev.length === 0;
    }
  } catch {}

  // impossible_travel: compare against last successful login within 12h
  let impossibleTravel = false;
  try {
    if (user?.id && clientGeo?.status === "granted" && typeof clientGeo.latitude === "number") {
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const { data: last } = await supabase.from("login_events")
        .select("gps_lat, gps_lon, ip_lat, ip_lon, created_at")
        .eq("user_id", user.id).eq("event", "login_success")
        .gte("created_at", since).order("created_at", { ascending: false }).limit(1);
      const prev = last?.[0];
      if (prev) {
        const lat = prev.gps_lat ?? prev.ip_lat, lon = prev.gps_lon ?? prev.ip_lon;
        if (typeof lat === "number" && typeof lon === "number") {
          const km = haversineKm({ lat, lng: lon }, { lat: clientGeo.latitude!, lng: clientGeo.longitude! });
          const hours = (Date.now() - new Date(prev.created_at).getTime()) / 3600000;
          if (hours > 0 && km / hours > 900) impossibleTravel = true;
        }
      }
    }
  } catch {}

  const isGps = clientGeo?.status === "granted";
  const reasons: string[] = [];
  if (anonymizer?.vpn || merged.vpn) reasons.push("vpn");
  if (anonymizer?.proxy || merged.proxy) reasons.push("proxy");
  if (anonymizer?.tor || merged.tor) reasons.push("tor");
  if (anonymizer?.hosting || merged.hosting) reasons.push("hosting");
  if (dev.webdriver) reasons.push("webdriver");
  if (isNewDevice) reasons.push("new_device");
  if (impossibleTravel) reasons.push("impossible_travel");
  if (status === "failed") reasons.push("auth_failed");

  let risk: "safe" | "medium" | "high" | "critical" = "safe";
  if (impossibleTravel || reasons.includes("tor")) risk = "critical";
  else if (reasons.includes("vpn") || reasons.includes("proxy") || reasons.includes("webdriver")) risk = "high";
  else if (reasons.includes("hosting") || (isNewDevice && !isGps)) risk = "medium";

  const row: Record<string, any> = {
    user_id: user.id, username: user.username, role: user.role,
    event: status === "success" ? "login_success" : "login_failed",
    ip: ip || null, ip_source: ipTrace?.source || null,
    isp: merged.isp || null, asn: merged.asn || null, org: merged.org || null,
    country: merged.country || null, country_code: merged.countryCode || null,
    region: merged.region || null, city: merged.city || null, zip: merged.postal || null,
    ip_lat: typeof merged.lat === "number" ? merged.lat : null,
    ip_lon: typeof merged.lng === "number" ? merged.lng : null,
    timezone: merged.timezone || dev.timezone || null,
    utc_offset: typeof dev.utcOffsetMinutes === "number" ? String(dev.utcOffsetMinutes) : null,
    is_proxy: !!(merged.proxy || anonymizer?.proxy), is_vpn: !!(merged.vpn || anonymizer?.vpn),
    is_tor: !!(merged.tor || anonymizer?.tor), is_hosting: !!(merged.hosting || anonymizer?.hosting),
    gps_lat: isGps ? clientGeo!.latitude : null, gps_lon: isGps ? clientGeo!.longitude : null,
    gps_accuracy: isGps ? clientGeo!.accuracy : null,
    gps_altitude: isGps ? (clientGeo!.altitude ?? null) : null,
    gps_heading: isGps ? (clientGeo!.heading ?? null) : null,
    gps_speed: isGps ? (clientGeo!.speed ?? null) : null,
    gps_captured_at: isGps && clientGeo!.timestamp ? new Date(clientGeo!.timestamp).toISOString() : null,
    device_type: identity.type || null, device_brand: identity.vendor || null, device_model: identity.model || null,
    os_name: os || null, os_version: osVersion ? normalizedVersion(osVersion) : null,
    browser_name: browser || null, browser_version: browserVersion ? normalizedVersion(browserVersion) : null,
    user_agent: forwardedUa || null, platform: dev.platform || null,
    languages: Array.isArray(dev.languages) ? dev.languages : null,
    hardware_concurrency: typeof dev.hardwareConcurrency === "number" ? dev.hardwareConcurrency : null,
    device_memory: typeof dev.deviceMemory === "number" ? dev.deviceMemory : null,
    screen_w: dev.screen?.width ?? null, screen_h: dev.screen?.height ?? null,
    viewport_w: dev.viewport?.width ?? null, viewport_h: dev.viewport?.height ?? null,
    color_depth: dev.screen?.colorDepth ?? null,
    pixel_ratio: dev.screen?.dpr ?? null,
    orientation: dev.orientation || null,
    network_type: dev.network?.effectiveType || dev.network?.type || null,
    downlink: dev.network?.downlink ?? null, rtt: dev.network?.rtt ?? null,
    save_data: dev.network?.saveData ?? null,
    battery_level: dev.battery?.level ?? null, battery_charging: dev.battery?.charging ?? null,
    fingerprint_hash: fpHash, is_new_device: isNewDevice, impossible_travel: impossibleTravel,
    risk_score: risk, risk_reasons: reasons.length ? reasons : null,
    raw: { clientGeo, ipTrace, merged, anonymizer, dev },
  };
  const { error } = await supabase.from("login_events").insert(row);
  if (error) console.error("[login_events] insert error:", error.message);

  // If new device and login success, notify admin via notifications table
  if (status === "success" && isNewDevice) {
    try {
      const body = `${identity.vendor || ""} ${identity.model || identity.type || "device"} · ${browser || "browser"} on ${os || "OS"} · ${merged.city || ""} ${merged.country || ""} · IP ${ip || "?"}`.trim();
      await supabase.from("notifications").insert({
        title: `🆕 New device login: ${user.username}`,
        body,
        audience: "admins",
        target_user_id: null,
        created_by: user.id,
      });
    } catch (e) { console.warn("[login_events] new-device notify failed:", e); }
  }
}



async function loadWorkerUrls(supabase: any): Promise<string[]> {
  const workerUrls: string[] = [];
  try {
    const [primaryCfUrls, emailAccounts] = await Promise.all([
      getSetting<any[]>(supabase, "primary_cloudflare_urls"),
      getSetting<any[]>(supabase, "email_accounts"),
    ]);
    if (Array.isArray(primaryCfUrls)) {
      for (const u of primaryCfUrls) if (typeof u === "string" && u.length > 0 && !workerUrls.includes(u)) workerUrls.push(u);
    }
    if (Array.isArray(emailAccounts)) {
      for (const acct of emailAccounts) {
        if (Array.isArray(acct.cloudflareUrls)) {
          for (const u of acct.cloudflareUrls) if (typeof u === "string" && u.length > 0 && !workerUrls.includes(u)) workerUrls.push(u);
        }
      }
    }
  } catch (e) {
    console.error("Failed to fetch worker URLs:", e);
  }
  return workerUrls;
}

async function reencryptForWorker(value: any, sourceSecret: string, workerSecret: string) {
  if (!value || typeof value !== "string") return value || "";
  const plain = value.startsWith("enc:") ? await decryptValue(value, sourceSecret) : value;
  return await encryptValue(plain, workerSecret);
}

async function buildInboxWorkerConfig(supabase: any, workerSecret: string, sourceSecret: string) {
  const keys = ["config", "email_accounts", "email_filters", "email_visibility", "primary_cloudflare_urls"];
  const { data } = await supabase.from("app_settings").select("key,value").in("key", keys);
  const settings = new Map<string, any>();
  for (const row of data || []) settings.set(row.key, row.value);
  const rawConfig = settings.get("config") || {};
  const config = { ...rawConfig };
  if (config.IMAP_PASSWORD) config.IMAP_PASSWORD = await reencryptForWorker(config.IMAP_PASSWORD, sourceSecret, workerSecret);
  const rawAccounts = Array.isArray(settings.get("email_accounts")) ? settings.get("email_accounts") : [];
  const emailAccounts = await Promise.all(rawAccounts.map(async (acc: any) => ({
    ...acc,
    password: acc?.password ? await reencryptForWorker(acc.password, sourceSecret, workerSecret) : acc?.password,
  })));
  return {
    config,
    email_accounts: emailAccounts,
    email_filters: normalizeEmailFilters(settings.get("email_filters")),
    email_visibility: settings.get("email_visibility") || {},
    primary_cloudflare_urls: Array.isArray(settings.get("primary_cloudflare_urls")) ? settings.get("primary_cloudflare_urls") : [],
  };
}

async function pushInboxConfigToWorkers(supabase: any, signingSecret: string, encryptionSecret: string) {
  if (!signingSecret) return;
  const workerUrls = await loadWorkerUrls(supabase);
  const config = await buildInboxWorkerConfig(supabase, signingSecret, encryptionSecret);
  const urls = Array.from(new Set(workerUrls.map((u) => String(u || "").trim().replace(/\/+$/, "")).filter(Boolean)));
  if (urls.length === 0) return;
  await Promise.allSettled(urls.map(async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch(`${base}/api/config/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Worker-Config-Secret": signingSecret },
        body: JSON.stringify(config),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }));
}

Deno.serve(async (originalReq) => {
  if (originalReq.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // One-shot: decrypt any legacy enc: IMAP passwords in app_settings so DB
  // holds plaintext (admin visibility). Runs once per isolate; idempotent.
  try {
    const _sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await migrateEncPasswordsToPlaintext(_sb, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  } catch { /* ignore */ }


  // ---- transport encryption boundary ----
  // Browser callers must use encrypted transport. Server-to-server callers
  // (Cloudflare worker with a verified app session token) may POST plaintext
  // for narrow internal reads like email_filters.
  // Additionally: a small allowlist of PUBLIC actions (no session, no user
  // data) may be POSTed as plaintext so the Cloudflare worker can front them
  // with KV + ETag caching. bootstrap_public is the highest-volume such call
  // (~470k reads/window) — worker cache turns it into a 304 hit.
  const SESSION_TOKEN_FOR_TRANSPORT = originalReq.headers.get("x-session-token") || "";
  const SEC_FETCH_SITE_FOR_TRANSPORT = originalReq.headers.get("sec-fetch-site") || "";
  const allowServerPlaintext = !!SESSION_TOKEN_FOR_TRANSPORT && !SEC_FETCH_SITE_FOR_TRANSPORT;
  const PUBLIC_PLAINTEXT_ACTIONS = new Set(["bootstrap_public", "tv_login_fetch_job", "tv_login_report"]);
  let __ctx: EncryptedRequestContext | null = null;
  let __parsedBody: any = null;
  try {
    // Always attempt plaintext parse; enforce per-action below so we can
    // whitelist bootstrap_public without weakening any other action.
    const __r = await readRequest(originalReq, { allowPlaintext: true });
    __parsedBody = __r.body ?? {};
    __ctx = __r.encrypted ? __r.ctx : null;
    if (!__ctx && !allowServerPlaintext && !PUBLIC_PLAINTEXT_ACTIONS.has(__parsedBody?.action)) {
      return plaintextRejectedResponse();
    }
  } catch (e) {
    if (e instanceof PlaintextRejectedError) return plaintextRejectedResponse();
    if (e instanceof TransportError) return transportErrorResponse(e);
    console.warn("[manage-app] request_parse_failed", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ success: false, error: "bad request" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const req = new Request(originalReq.url, {
    method: originalReq.method,
    headers: originalReq.headers,
    body: JSON.stringify(__parsedBody ?? {}),
  });



  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ---- GitHub Actions setup: DB-first config with env fallback -------------
  async function loadGithubConfig(): Promise<{ pat: string; repo: string; hmacKey: string; updatedAt: string | null }> {
    try {
      const { data } = await supabase.from("github_config").select("pat, repo, hmac_key, updated_at").eq("id", 1).maybeSingle();
      return {
        pat: (data?.pat && String(data.pat)) || Deno.env.get("GITHUB_DISPATCH_PAT") || "",
        repo: (data?.repo && String(data.repo)) || Deno.env.get("GITHUB_REPO") || "",
        hmacKey: (data?.hmac_key && String(data.hmac_key)) || Deno.env.get("TV_REPORT_HMAC_KEY") || "",
        updatedAt: data?.updated_at ? String(data.updated_at) : null,
      };
    } catch {
      return {
        pat: Deno.env.get("GITHUB_DISPATCH_PAT") || "",
        repo: Deno.env.get("GITHUB_REPO") || "",
        hmacKey: Deno.env.get("TV_REPORT_HMAC_KEY") || "",
        updatedAt: null,
      };
    }
  }
  async function saveGithubConfig(patch: { pat?: string; repo?: string; hmac_key?: string; updated_by?: string | null }) {
    const row: any = { id: 1, updated_at: new Date().toISOString() };
    if (typeof patch.pat === "string") row.pat = patch.pat;
    if (typeof patch.repo === "string") row.repo = patch.repo;
    if (typeof patch.hmac_key === "string") row.hmac_key = patch.hmac_key;
    if (patch.updated_by) row.updated_by = patch.updated_by;
    const { error } = await supabase.from("github_config").upsert(row, { onConflict: "id" });
    if (error) throw new Error(`Failed to save github_config: ${error.message}`);
  }
  async function ghApi(pat: string, path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string }> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text().catch(() => "");
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, text };
  }
  async function pushGithubActionsSecret(pat: string, repo: string, name: string, value: string) {
    const pk = await ghApi(pat, `/repos/${repo}/actions/secrets/public-key`);
    if (pk.status !== 200 || !pk.json?.key || !pk.json?.key_id) {
      throw new Error(`Could not read GitHub public key (${pk.status}). Ensure PAT has "Secrets: write" and repo access.`);
    }
    await sodium.ready;
    const keyBytes = sodium.from_base64(String(pk.json.key), sodium.base64_variants.ORIGINAL);
    const messageBytes = sodium.from_string(value);
    const encrypted = sodium.crypto_box_seal(messageBytes, keyBytes);
    const encryptedB64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
    const put = await ghApi(pat, `/repos/${repo}/actions/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ encrypted_value: encryptedB64, key_id: String(pk.json.key_id) }),
    });
    if (put.status !== 201 && put.status !== 204) {
      throw new Error(`GitHub secret PUT failed (${put.status}): ${(put.text || "").slice(0, 200)}`);
    }
  }

  function githubPermissionMessage(status: number, body: string, mode: "setup" | "test" | "run" = "run") {
    const text = String(body || "");
    if (status === 403 && /not accessible by personal access token/i.test(text)) {
      return "GitHub PAT permission missing hai. Token edit karo → Repository access me correct repo select karo → Repository permissions me Actions: Read and write, Secrets: Read and write, Metadata: Read-only rakho. Contents permission ab required nahi hai.";
    }
    if (status === 404) {
      return "GitHub repo/workflow access nahi mil raha. Repo field owner/name format me daalo, token me wahi repo selected hona chahiye, aur .github/workflows/tv-login.yml repo me present hona chahiye.";
    }
    if (status === 422 && /workflow_dispatch/i.test(text)) {
      return "GitHub workflow_dispatch enabled nahi mila. Latest code GitHub me sync hone do, phir Admin → TV → Rotate/Sync dabao.";
    }
    const prefix = mode === "test" ? "GitHub runner test failed" : mode === "setup" ? "GitHub setup failed" : "GitHub Actions dispatch failed";
    return text.slice(0, 300) || `${prefix} (${status}).`;
  }

  async function dispatchGithubWorkflow(pat: string, repo: string, payload: Record<string, string>) {
    return await fetch(`https://api.github.com/repos/${repo}/actions/workflows/tv-login.yml/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: payload }),
      signal: AbortSignal.timeout(5000),
    });
  }


  // F5: split signing key (session tokens) from encryption key (IMAP passwords).
  // ENCRYPTION_SECRET must remain SUPABASE_SERVICE_ROLE_KEY so existing AES-GCM
  // ciphertexts in app_settings.email_accounts can still be decrypted.
  const ENCRYPTION_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SIGNING_SECRET = Deno.env.get("SESSION_SIGNING_SECRET") || ENCRYPTION_SECRET;
  const LEGACY_SIGNING = ENCRYPTION_SECRET;
  const IMPERSONATION_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

  const ip = getClientIp(req);

  // C.3 device binding: sha256(ua + accept-language + ip/24). /24 (not /32) so
  // mobile carrier NAT doesn't invalidate legitimate sessions.
  async function computeBindingHash(r: Request): Promise<string> {
    const ua = (r.headers.get("user-agent") || "").trim();
    const al = (r.headers.get("accept-language") || "").split(",")[0]?.trim() || "";
    const rawIp = getClientIp(r) || "";
    let ipPrefix = rawIp;
    const v4 = rawIp.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
    if (v4) ipPrefix = `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
    // IPv6: keep first 4 groups (/64) as coarse binding
    else if (rawIp.includes(":")) ipPrefix = rawIp.split(":").slice(0, 4).join(":") + "::/64";
    return await sha256Hex(`${ua}|${al}|${ipPrefix}`);
  }

  // --- Persist a session row in DB (source of truth for logged-in status) ---
  async function persistSession(userId: string, role: string, token: string, expiresAtMs: number) {
    const tokenHash = await sha256Hex(token);
    const ua = req.headers.get("user-agent") || null;
    const bindingHash = await computeBindingHash(req);
    await supabase.from("app_sessions").insert({
      user_id: userId,
      role,
      token_hash: tokenHash,
      expires_at: new Date(expiresAtMs).toISOString(),
      ip,
      user_agent: ua,
      binding_hash: bindingHash,
    });
    // Best-effort cleanup of expired rows for this user
    supabase.from("app_sessions").delete().lt("expires_at", new Date().toISOString()).eq("user_id", userId).then(() => {});
  }

  // Realtime Broadcast — instant remote logout. Sends one WebSocket-delivered
  // message (~50 bytes) to `session-family-<uuid>` channels so old devices log
  // out within ~1s. No polling, no DB egress spike.
  async function broadcastSessionRevoked(familyIds: string[], reason: string): Promise<void> {
    if (!familyIds.length) return;
    const url = `${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const messages = familyIds.map((fid) => ({
      topic: `session-family-${fid}`,
      event: "revoked",
      payload: { reason, at: Date.now() },
      private: false,
    }));
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify({ messages }),
      });
    } catch (e) {
      console.warn("[broadcast] failed:", (e as any)?.message || e);
    }
  }


  // C.2 refresh-token rotation: mint access+refresh pair inside one session
  // family. Access TTL 15 min, refresh TTL 12 h. Refresh rotates on every use;
  // reuse of a rotated refresh token revokes the whole family (see refresh_session action).
  function b64url(bytes: Uint8Array): string {
    let s = ""; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function mintSessionPair(
    userId: string,
    role: string,
    accessPayload: Record<string, any>,
    opts?: { familyId?: string; parentSessionId?: string | null; ttlOverrideMs?: number; refreshTtlOverrideMs?: number },
  ): Promise<{ accessToken: string; accessExpMs: number; refreshToken: string; refreshExpMs: number; familyId: string; sessionRowId: string }> {
    const DEFAULT_ACCESS_TTL_MS = 15 * 60 * 1000;
    const DEFAULT_REFRESH_TTL_MS = 12 * 60 * 60 * 1000;
    // When ttlOverrideMs is set (e.g. free-profile admin-set session length),
    // BOTH access and refresh use that value so the whole session auto-expires
    // at that mark — no silent refresh loophole.
    const ACCESS_TTL_MS = opts?.ttlOverrideMs && opts.ttlOverrideMs > 0 ? opts.ttlOverrideMs : DEFAULT_ACCESS_TTL_MS;
    const REFRESH_TTL_MS = opts?.ttlOverrideMs && opts.ttlOverrideMs > 0
      ? opts.ttlOverrideMs
      : (opts?.refreshTtlOverrideMs && opts.refreshTtlOverrideMs > 0 ? opts.refreshTtlOverrideMs : DEFAULT_REFRESH_TTL_MS);
    const now = Date.now();
    const accessExpMs = now + ACCESS_TTL_MS;
    const refreshExpMs = now + REFRESH_TTL_MS;
    const familyId = opts?.familyId || crypto.randomUUID();
    const refreshToken = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const accessToken = await createSessionToken({ ...accessPayload, exp: accessExpMs }, SIGNING_SECRET);
    const [accessHash, refreshHash, bindingHash] = await Promise.all([
      sha256Hex(accessToken),
      sha256Hex(refreshToken),
      computeBindingHash(req),
    ]);
    const { data: row, error } = await supabase.from("app_sessions").insert({
      user_id: userId,
      role,
      token_hash: accessHash,
      expires_at: new Date(accessExpMs).toISOString(),
      refresh_token_hash: refreshHash,
      refresh_expires_at: new Date(refreshExpMs).toISOString(),
      family_id: familyId,
      parent_session_id: opts?.parentSessionId ?? null,
      ip,
      user_agent: req.headers.get("user-agent") || null,
      binding_hash: bindingHash,
    }).select("id").single();
    if (error || !row) throw new Error(`Failed to persist session: ${error?.message || "insert failed"}`);
    // Best-effort cleanup of expired rows for this user
    supabase.from("app_sessions").delete().lt("expires_at", new Date().toISOString()).eq("user_id", userId).then(() => {});
    return { accessToken, accessExpMs, refreshToken, refreshExpMs, familyId, sessionRowId: row.id };
  }

  // Helper to verify session from header AND ensure a live DB row exists
  async function requireSession(req: Request): Promise<Record<string, any>> {
    const token = req.headers.get("x-session-token");
    if (!token) throw new Error("Authentication required");
    let session = await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING);
    if (!session) {
      session = await verifySessionTokenDualAllowExpired(token, SIGNING_SECRET, LEGACY_SIGNING);
      if (!session) throw new Error("Session expired or invalid");
    }
    const tokenHash = await sha256Hex(token);
    const { data: row } = await supabase
      .from("app_sessions")
      .select("id, expires_at, refresh_expires_at, binding_hash, user_id, role, parent_session_id, revoked_at, revoked_reason, family_id")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!row) {
      if (session.impersonated === true && typeof session.adminId === "string") {
        session.impersonationAccessExpired = true;
        return session;
      }
      throw new Error("Session revoked. Please sign in again.");
    }
    if (row.revoked_at) {
      const rotatedGrace = /^rotated/i.test(String(row.revoked_reason || ""))
        && Date.now() - new Date(row.revoked_at).getTime() < 2 * 60 * 1000;
      if (!rotatedGrace && !(session.impersonated === true && typeof session.adminId === "string")) {
        throw new Error("Session revoked. Please sign in again.");
      }
    }
    const nowMs = Date.now();
    const accessExpired = new Date(row.expires_at).getTime() < nowMs || (Number(session.exp) > 0 && Number(session.exp) < nowMs);
    if (accessExpired) {
      let allowExpiredImpersonation = false;
      if (row.parent_session_id && row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() > nowMs) {
        const { data: parentForExpiry } = await supabase
          .from("app_sessions")
          .select("role, revoked_at")
          .eq("id", row.parent_session_id)
          .maybeSingle();
        allowExpiredImpersonation = parentForExpiry
          ? (parentForExpiry.role === "admin" && !parentForExpiry.revoked_at)
          : (session.impersonated === true && typeof session.adminId === "string");
      }
      if (allowExpiredImpersonation) {
        session.impersonationAccessExpired = true;
      } else {
        // Do NOT delete the row just because the short-lived access token
        // expired. The refresh token lives on the same app_sessions row; deleting
        // it here turns a recoverable stale access token into "session revoked"
        // and breaks admin impersonation / inbox refresh after idle tabs.
        const refreshStillValid = row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() > nowMs;
        if (!refreshStillValid) {
          await supabase.from("app_sessions").delete().eq("id", row.id);
        }
        throw new Error("Access token expired. Please sign in again.");
      }
    }
    // C.3 device-binding check. Only enforce when a binding is stored (soft
    // rollout: legacy sessions with null binding_hash pass through).
    if (row.binding_hash) {
      const current = await computeBindingHash(req);
      if (current !== row.binding_hash) {
        supabase.from("security_events").insert({
          type: "session_binding_mismatch",
          severity: "medium",
          uid: row.user_id,
          ip,
          ua: req.headers.get("user-agent") || null,
          meta: { session_id: row.id, action: "allowed_soft_binding" },
        }).then(() => {});
      }
    }

    session.sessionRowId = row.id;
    session.sessionParentSessionId = row.parent_session_id || null;

    // Server-side impersonation source of truth: impersonated sessions keep the
    // original admin session row as parent_session_id. This survives page
    // refreshes and token refreshes without relying on client backup storage.
    if (row.parent_session_id && session.role !== "admin") {
      try {
        const { data: parent } = await supabase
          .from("app_sessions")
          .select("id, user_id, role, revoked_at")
          .eq("id", row.parent_session_id)
          .maybeSingle();
        if (parent?.role === "admin" && !parent.revoked_at) {
          session.impersonated = true;
          session.adminId = parent.user_id;
          session.adminSessionId = parent.id;
        }
      } catch {}
    }

    // Fire-and-forget touch, throttled to once per SESSION_TOUCH_MS per session
    // to eliminate write amplification on last_seen_at (was a top WAL source).
    if (shouldTouchSession(row.id)) {
      supabase.from("app_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", row.id).then(() => {});
    }
    return session;
  }




  async function requireAdmin(req: Request): Promise<Record<string, any>> {
    const session = await requireSession(req);
    if (session.role !== "admin") throw new Error("Admin access required");
    return session;
  }

  async function requirePendingAdmin(req: Request, userId?: string): Promise<{ pending: Record<string, any>; token: string; tokenHash: string; state: any }> {
    const token = req.headers.get("x-pending-token") || req.headers.get("x-session-token");
    if (!token) throw new Error("Pending admin verification required");
    const pending = await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING);
    if (!pending || pending.role !== "admin" || pending.pending !== true) throw new Error("Invalid or expired pending admin token");
    if (userId && pending.userId !== userId) throw new Error("Pending token does not match this admin");
    const tokenHash = await sha256Hex(token);
    const { data: state, error } = await supabase
      .from("app_admin_2fa_state")
      .select("*")
      .eq("token_hash", tokenHash)
      .eq("user_id", pending.userId)
      .gte("expires_at", new Date().toISOString())
      .single();
    if (error || !state) throw new Error("Pending admin verification expired");
    return { pending, token, tokenHash, state };
  }

  const __run = async (): Promise<Response> => {
  try {
    const { action, ...params } = await req.json();

    // --- Public actions (no session needed) ---

    // Bootstrap: returns profiles, recaptcha config, and worker URLs for fresh browsers.
    // Supports ETag / If-None-Match. On match returns {success:true, unchanged:true, etag}
    // with an ETag response header so the Cloudflare worker (and browsers) can serve 304s
    // and never re-download the ~10 KB payload for the same version.
    if (action === "bootstrap_public") {
      const ifNoneMatch = (originalReq.headers.get("if-none-match") || "").replace(/^W\//, "").replace(/^"|"$/g, "");

      // Warm-instance cache: 5000 concurrent users all hitting this on load
      // otherwise re-runs the SELECTs and repays the egress. 10s TTL keeps
      // profile picker feeling live while removing 99% of DB reads.
      const now = Date.now();
      if (__bootstrapCache && (now - __bootstrapCache.at) < BOOTSTRAP_TTL_MS) {
        const cachedEtag = (__bootstrapCache.payload as any)?.etag || "";
        if (cachedEtag && ifNoneMatch && ifNoneMatch === cachedEtag) {
          return new Response(JSON.stringify({ success: true, unchanged: true, etag: cachedEtag }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json", ETag: `"${cachedEtag}"`, "Cache-Control": "public, max-age=30, stale-while-revalidate=60", "Access-Control-Expose-Headers": "ETag" },
          });
        }
        return new Response(JSON.stringify(__bootstrapCache.payload), {
          headers: { ...corsHeaders, "Content-Type": "application/json", ...(cachedEtag ? { ETag: `"${cachedEtag}"`, "Cache-Control": "public, max-age=30, stale-while-revalidate=60", "Access-Control-Expose-Headers": "ETag" } : {}) },
        });
      }
      // Public profile picker — only non-admin users, minimal fields.
      // Order: pinned first, then admin-defined sort_order, then creation time.
      const usersP = supabase
        .from("app_users")
        .select("id, username, name, role, profile_prefs, is_free, pinned, sort_order, expires_at, tv_override, feature_gmail, feature_tv, feature_link")
        .neq("role", "admin")
        .order("pinned", { ascending: false })
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });

      const settingsP = supabase
        .from("app_settings")
        .select("key,value")
        .in("key", ["recaptcha", "primary_cloudflare_urls", "email_filters", "maintenance", "r2_storage", "location_policy", "free_avatar_cooldown", "free_avatar_last_change", "tv_feature", "contact_info", "developer_links"]);

      const [{ data: users, error: usersErr }, { data: settingRows }] = await Promise.all([usersP, settingsP]);
      if (usersErr) throw usersErr;

      const settings = new Map((settingRows || []).map((row: any) => [row.key, row.value]));

      let recaptcha = null;
      const rcData: any = settings.get("recaptcha");
      if (rcData?.enabled === true && rcData?.siteKey) {
        recaptcha = { enabled: true, siteKey: rcData.siteKey };
      }

      const pcf: any = settings.get("primary_cloudflare_urls");
      const workerUrls: string[] = Array.isArray(pcf)
        ? pcf.filter((u: any) => typeof u === "string" && u.length > 0)
        : [];

      const emailFilters: any = normalizeEmailFilters(settings.get("email_filters"));
      const globalLocationRequired = isGlobalLocationRequired(settings.get("location_policy"));

      let maintenance: any = { enabled: false };
      try {
        const mData: any = settings.get("maintenance");
        if (mData && typeof mData === "object") {
          const v: any = mData;
          const startsAt = typeof v.startsAt === "string" ? v.startsAt : null;
          const endsAt = typeof v.endsAt === "string" ? v.endsAt : null;
          // Auto-expire: if endsAt is in the past, treat as disabled.
          const expired = !!(endsAt && Date.parse(endsAt) > 0 && Date.parse(endsAt) <= Date.now());
          // Not-yet-started: if startsAt is in the future, suppress activation.
          const notYet = !!(startsAt && Date.parse(startsAt) > Date.now());
          // Auto-activate: if both startsAt and endsAt are set and NOW is inside that window,
          // treat the site as in maintenance even if the admin never toggled the switch.
          const withinWindow = !!(
            startsAt && endsAt &&
            Date.parse(startsAt) <= Date.now() &&
            Date.parse(endsAt) > Date.now()
          );
          maintenance = {
            enabled: (!!v.enabled || withinWindow) && !expired && !notYet,
            title: typeof v.title === "string" ? v.title : "",
            message: typeof v.message === "string" ? v.message : "",
            eta: typeof v.eta === "string" ? v.eta : "",
            startsAt,
            endsAt,
            versionFrom: typeof v.versionFrom === "string" ? v.versionFrom : "",
            versionTo: typeof v.versionTo === "string" ? v.versionTo : "",
            updated_at: v.updated_at || null,
          };
          // If we auto-expired, persist the disable so admins see it too.
          if (expired && v.enabled) {
            try {
              await upsertSetting(
                supabase,
                "maintenance",
                { ...v, enabled: false, updated_at: new Date().toISOString() },
              );
            } catch {}
          }
        }
      } catch {}

      let avatarBaseUrl = "";
      try {
        const r2 = normalizeR2Config(settings.get("r2_storage") || {}).config;
        avatarBaseUrl = r2.publicBaseUrl || "";
      } catch {}

      const nowMs = Date.now();
      const mappedUsers = (users || [])
        .filter((u: any) => !(u.is_free && u.expires_at && Date.parse(u.expires_at) <= nowMs))
        .map((u: any) => ({
          id: u.id,
          username: u.username,
          name: u.name,
          role: u.role,
          profileAvatar: u.profile_prefs?.avatarId || null,
          profilePrefs: publicProfilePrefs(u.profile_prefs),
          locationRequired: isProfileLocationRequired(u, globalLocationRequired),
          isFree: !!u.is_free,
          pinned: !!u.pinned,
          sortOrder: u.sort_order ?? null,
          expiresAt: u.expires_at || null,
          tvOverride: u.tv_override === "on" || u.tv_override === "off" ? u.tv_override : null,
          feature_gmail: u.feature_gmail !== false,
          feature_tv: u.feature_tv !== false,
          feature_link: u.feature_link === true,
          features: pickFeatures(u),
        }));
      const cdMinutesRaw = Number((settings.get("free_avatar_cooldown") as any)?.minutes);
      const freeAvatarCooldown = {
        minutes: Number.isFinite(cdMinutesRaw) && cdMinutesRaw > 0 ? Math.floor(cdMinutesRaw) : 5,
        lastAt: (settings.get("free_avatar_last_change") as any)?.at || null,
      };
      const tvFeatureRaw: any = settings.get("tv_feature");
      const tvFeature = { enabled: tvFeatureRaw?.enabled !== false };
      const contactInfoRaw: any = settings.get("contact_info") || null;
      const contactInfo = contactInfoRaw && typeof contactInfoRaw === "object"
        ? {
            telegram: typeof contactInfoRaw.telegram === "string" ? contactInfoRaw.telegram : "",
            whatsapp: typeof contactInfoRaw.whatsapp === "string" ? contactInfoRaw.whatsapp : "",
            email: typeof contactInfoRaw.email === "string" ? contactInfoRaw.email : "",
            note: typeof contactInfoRaw.note === "string" ? contactInfoRaw.note : "",
          }
        : { telegram: "", whatsapp: "", email: "", note: "" };
      const devLinksRaw: any = settings.get("developer_links");
      const developerLinks = Array.isArray(devLinksRaw?.links)
        ? devLinksRaw.links
            .filter((l: any) => l && typeof l === "object" && typeof l.url === "string" && /^https?:\/\//i.test(l.url.trim()))
            .slice(0, 24)
            .map((l: any, i: number) => ({
              id: String(l.id || `dev_${i}`),
              label: String(l.label || "Developer").slice(0, 60),
              url: String(l.url).trim().slice(0, 600),
              role: String(l.role || "").slice(0, 80),
              description: String(l.description || "").slice(0, 240),
              avatar: String(l.avatar || "").slice(0, 600),
            }))
        : [];
      const developerButtonLabel = String(devLinksRaw?.buttonLabel || "Developer").slice(0, 24);
      const basePayload: any = { success: true, users: mappedUsers, recaptcha, workerUrls, emailFilters, maintenance, avatarBaseUrl, locationPolicy: { required: globalLocationRequired }, freeAvatarCooldown, tvFeature, contactInfo, developerLinks, developerButtonLabel };
      // Compute a stable etag from the content. 16 hex chars (~64 bits) is
      // enough uniqueness to catch any real content change without paying
      // for the full 64-char hash in every response header.
      const etagBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(basePayload)));
      const etag = Array.from(new Uint8Array(etagBuf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
      // serverNow is added outside the etag so caching still works.
      const payload = { ...basePayload, etag, serverNow: new Date().toISOString() };
      __bootstrapCache = { at: now, payload };
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(JSON.stringify({ success: true, unchanged: true, etag, serverNow: payload.serverNow }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json", ETag: `"${etag}"`, "Cache-Control": "public, max-age=30, stale-while-revalidate=60", "Access-Control-Expose-Headers": "ETag" },
        });
      }
      return new Response(JSON.stringify(payload), {
        headers: { ...corsHeaders, "Content-Type": "application/json", ETag: `"${etag}"`, "Cache-Control": "public, max-age=30, stale-while-revalidate=60", "Access-Control-Expose-Headers": "ETag" },
      });
    }



    if (action === "list") {
      // Admin dashboard only
      await requireAdmin(req);
      const { data, error } = await supabase
        .from("app_users")
        .select("id, username, name, role, assigned_accounts, profile_prefs, session_limit, is_free, pinned, sort_order, expires_at, auto_delete, tv_override, feature_gmail, feature_tv, feature_link, last_workflow_view, plan_starts_at, plan_ends_at")
        .order("pinned", { ascending: false })
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      if (error) throw error;
      const [availableAccountLabelsForList, globalLocationRequired] = await Promise.all([
        loadAvailableAccountLabels(supabase),
        loadGlobalLocationRequired(supabase),
      ]);
      const mappedData = (data || []).map((u: any) => ({
        ...u,
        assignedAccounts: normalizeAccountLabels(u.assigned_accounts || [], availableAccountLabelsForList).length > 0 ? normalizeAccountLabels(u.assigned_accounts || [], availableAccountLabelsForList) : null,
        profileAvatar: u.profile_prefs?.avatarId || null,
        profilePrefs: publicProfilePrefs(u.profile_prefs),
        locationRequired: isProfileLocationRequired(u, globalLocationRequired),
        isFree: !!u.is_free,
        pinned: !!u.pinned,
        sortOrder: u.sort_order ?? null,
        expiresAt: u.expires_at || null,
        autoDelete: u.auto_delete !== false,
        tvOverride: u.tv_override === "on" || u.tv_override === "off" ? u.tv_override : null,
        features: pickFeatures(u),
        planStartsAt: u.plan_starts_at || null,
        planEndsAt: u.plan_ends_at || null,
      }));
      return new Response(JSON.stringify({ success: true, users: mappedData }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_location_policy") {
      const username = typeof params.username === "string" ? params.username.trim() : "";
      if (!username) {
        return new Response(JSON.stringify({ success: true, required: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: adminRow } = await supabase
        .from("app_users")
        .select("id, role, profile_prefs")
        .eq("username", username)
        .maybeSingle();
      const required = adminRow?.role === "admin"
        ? isProfileLocationRequired(adminRow, await loadGlobalLocationRequired(supabase))
        : false;
      return new Response(JSON.stringify({ success: true, required }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "login") {
      const { username, password, clientGeo, captchaToken } = params;
      if (!username || !password) throw new Error("Username and password required");

      const { data: recaptchaSetting } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "recaptcha")
        .maybeSingle();
      const recaptchaCfg: any = recaptchaSetting?.value || null;
      if (recaptchaCfg?.enabled === true) {
        if (!recaptchaCfg?.secretKey) throw new Error("CAPTCHA is misconfigured. Contact admin.");
        if (!captchaToken || typeof captchaToken !== "string") throw new Error("CAPTCHA required. Refresh and try again.");
        const captchaOk = await verifyRecaptchaToken(recaptchaCfg.secretKey, captchaToken, ip);
        if (!captchaOk) throw new Error("CAPTCHA verification failed. Refresh and try again.");
      }

      const verifiedClientGeo = sanitizeClientGeo(clientGeo);
      const { data: user, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("username", username)
        .single();

      if (error || !user) {
        await auditLog(supabase, "login_failed", null, null, { username }, ip);
        throw new Error("Invalid username or password");
      }

      const globalLocationRequired = await loadGlobalLocationRequired(supabase);
      const locationRequired = isProfileLocationRequired(user, globalLocationRequired);
      if (locationRequired && verifiedClientGeo?.permissionState !== "granted" && verifiedClientGeo?.status !== "granted") {
        const status = verifiedClientGeo?.status || "missing";
        const errDetail = verifiedClientGeo?.error ? ` (${verifiedClientGeo.error})` : "";
        if (status === "denied") throw new Error("GPS permission denied. Allow location for this site, then try again.");
        if (status === "unsupported") throw new Error("This browser/device does not support GPS location.");
        throw new Error(`Location permission is required (status=${status})${errDetail}.`);
      }

      const passwordMatch = await verifyPassword(password, user.password);
      if (!passwordMatch) {
        await auditLog(supabase, "login_failed", user.id, null, { username }, ip);
        ((globalThis as any).EdgeRuntime?.waitUntil?.(sendLoginNotification(supabase, req, user, "failed", verifiedClientGeo, { locationRequired })) ?? sendLoginNotification(supabase, req, user, "failed", verifiedClientGeo, { locationRequired }).catch(() => {}));
        throw new Error("Invalid username or password");
      }

      // Authentication already succeeded. Upgrade legacy hashes in background
      // so migration work never delays this successful session response.
      if (!user.password.startsWith("pbkdf2:")) {
        const upgradeLegacyHash = (async () => {
          const hashed = await hashPassword(password);
          const { error: upgradeError } = await supabase.from("app_users").update({ password: hashed }).eq("id", user.id);
          if (upgradeError) console.warn("[login] password hash upgrade failed:", upgradeError.message);
        })();
        (globalThis as any).EdgeRuntime?.waitUntil?.(upgradeLegacyHash) ?? upgradeLegacyHash.catch(() => {});
      }

      // Plan-expiry gate: paid non-admin users whose plan_ends_at has passed
      // cannot obtain a session. Free profiles and admin are unaffected.
      if (user.role !== "admin" && !user.is_free && user.plan_ends_at) {
        const endMs = Date.parse(String(user.plan_ends_at));
        if (Number.isFinite(endMs) && endMs <= Date.now()) {
          let contactInfo: any = null;
          try {
            const { data: ci } = await readSettingRow(supabase, "contact_info");
            contactInfo = ci?.value || null;
          } catch {}
          await auditLog(supabase, "login_blocked_plan_finished", user.id, null, { username, planEndsAt: user.plan_ends_at }, ip);
          // Fire an instant "Plan expired" Telegram alert if the cron hasn't
          // already sent one. This closes the gap where a user's session
          // hits expiry between cron ticks and the admin is left in the dark.
          if (!(user as any).plan_end_notified_at) {
            ((globalThis as any).EdgeRuntime?.waitUntil?.(notifyPlanExpiredOnce(supabase, user)) ?? notifyPlanExpiredOnce(supabase, user).catch(() => {}));
          }
          return new Response(JSON.stringify({ success: false, error: "plan_finished", planEndsAt: user.plan_ends_at, contactInfo }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const successAudit = auditLog(supabase, "login_success", user.id, null, { username, role: user.role }, ip);
      (globalThis as any).EdgeRuntime?.waitUntil?.(successAudit) ?? successAudit.catch(() => {});
      if (user.role !== "admin") {
        ((globalThis as any).EdgeRuntime?.waitUntil?.(sendLoginNotification(supabase, req, user, "success", verifiedClientGeo, { locationRequired })) ?? sendLoginNotification(supabase, req, user, "success", verifiedClientGeo, { locationRequired }).catch(() => {}));
      }

      if (user.role === "admin") {
        const pendingPayload = { userId: user.id, username: user.username, role: "admin", pending: true, clientGeo: compactClientGeoForPending(verifiedClientGeo), locationRequired, exp: Date.now() + 15 * 60 * 1000 };
        const pendingToken = await createSessionToken(pendingPayload, SIGNING_SECRET);
        const tokenHash = await sha256Hex(pendingToken);
        await supabase.from("app_admin_2fa_state").delete().eq("user_id", user.id);
        const { error: stateErr } = await supabase.from("app_admin_2fa_state").insert({
          token_hash: tokenHash,
          user_id: user.id,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });
        if (stateErr) throw stateErr;
        return new Response(JSON.stringify({
          success: true,
          pendingToken,
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            profilePrefs: publicProfilePrefs(user.profile_prefs),
            profileAvatar: user.profile_prefs?.avatarId || null,
            locationRequired,
            totpConfigured: !!user.totp_secret,
            mustChangePassword: user.must_change_password,
          },
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Enforce admin-configured concurrent session cap per user.
      // Default: unlimited (0). When set, revoke oldest families so only
      // (maxPerUser - 1) remain active — the new login becomes the Nth session.
      try {
        const { data: limitRow } = await readSettingRow(supabase, "session_limits");
        const globalLimit = Math.max(0, Math.floor(Number((limitRow?.value as any)?.maxPerUser) || 0));
        // Per-user override wins when set (non-null). 0 = unlimited for this user even if a global cap exists.
        const perUser = (user as any).session_limit;
        const maxPerUser = (perUser === null || perUser === undefined) ? globalLimit : Math.max(0, Math.floor(Number(perUser) || 0));
        if (maxPerUser > 0) {


          const { data: activeRows } = await supabase
            .from("app_sessions")
            .select("id, family_id, created_at")
            .eq("user_id", user.id)
            .is("revoked_at", null)
            .or(`refresh_expires_at.gt.${nowIso},expires_at.gt.${nowIso}`)
            .order("created_at", { ascending: false });
          const seenFamily = new Set<string>();
          const families: { family_id: string; created_at: string }[] = [];
          for (const r of activeRows || []) {
            const fid = r.family_id || r.id;
            if (seenFamily.has(fid)) continue;
            seenFamily.add(fid);
            families.push({ family_id: fid, created_at: r.created_at });
          }
          // Keep newest (maxPerUser - 1) families; revoke the rest so the
          // brand-new session slots in as the Nth.
          const keep = Math.max(0, maxPerUser - 1);
          const toRevoke = families.slice(keep).map((f) => f.family_id);
          if (toRevoke.length) {
            await supabase.from("app_sessions")
              .update({ revoked_at: nowIso })
              .in("family_id", toRevoke)
              .is("revoked_at", null);
            await auditLog(supabase, "session_limit_enforced", user.id, null, { revokedFamilies: toRevoke.length, maxPerUser }, ip);
            // Instant kick — push a Realtime Broadcast to each revoked family so
            // the old device logs out within ~1s over its persistent WebSocket
            // (no polling, ~50 bytes egress per revoke).
            const runBroadcast = broadcastSessionRevoked(toRevoke, "new_login");
            (globalThis as any).EdgeRuntime?.waitUntil?.(runBroadcast) ?? runBroadcast.catch(() => {});
          }

        }
      } catch (e) {
        console.warn("[login] session-limit enforcement skipped:", (e as any)?.message || e);
      }

      // These independent reads run beside account normalization instead of
      // serially extending the successful-login response path.
      const workerUrlsPromise = loadWorkerUrls(supabase);
      const tvFeaturePromise = loadTvFeatureEnabled(supabase);
      const normalizedAssignedAccounts = await normalizeAssignedAccounts(supabase, user.assigned_accounts);
      if (!normalizedAssignedAccountsEqual(normalizedAssignedAccounts, Array.isArray(user.assigned_accounts) ? user.assigned_accounts : null)) {
        const persistNormalizedAccounts = supabase.from("app_users").update({ assigned_accounts: normalizedAssignedAccounts }).eq("id", user.id)
          .then(({ error: persistError }: any) => {
            if (persistError) console.warn("[login] assigned-account normalization failed:", persistError.message);
          });
        (globalThis as any).EdgeRuntime?.waitUntil?.(persistNormalizedAccounts) ?? persistNormalizedAccounts.catch(() => {});
        invalidateBootstrapCache();
      }
      // C.2: mint access (15 min) + refresh (12 h) rotating pair
      const pair = await mintSessionPair(user.id, user.role, {
        userId: user.id,
        username: user.username,
        role: user.role,
        assignedAccounts: normalizedAssignedAccounts,
      });

      // Ship the admin-configured auto-logout length with the login response so
      // the client countdown never has to guess a default before its settings
      // fetch resolves (that guess was the "5 min vs configured 7 min" bug).
      let sessionTimeoutMinutes = 0;
      try {
        const { data: cfgRow } = await readSettingRow(supabase, user.role === "admin" ? "admin_session_config" : "session_config");
        const m = Number((cfgRow?.value as any)?.timeoutMinutes);
        if (Number.isFinite(m) && m > 0) sessionTimeoutMinutes = Math.floor(m);
      } catch {}

      const [workerUrls, tvFeatureEnabled] = await Promise.all([workerUrlsPromise, tvFeaturePromise]);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
        sessionFamilyId: pair.familyId,
        sessionTimeoutMinutes,
        workerUrls,

        user: {
          id: user.id, username: user.username, name: user.name, role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: normalizedAssignedAccounts,
          profilePrefs: publicProfilePrefs(user.profile_prefs),
          profileAvatar: user.profile_prefs?.avatarId || null,
          isFree: !!user.is_free,
          expiresAt: user.expires_at || null,
          autoDelete: (user as any).auto_delete !== false,
          locationRequired,
          tvOverride: user.tv_override === "on" || user.tv_override === "off" ? user.tv_override : null,
          tvFeatureEnabled,
          features: pickFeatures(user),
          planStartsAt: (user as any).plan_starts_at || null,
          planEndsAt: (user as any).plan_ends_at || null,
          lastWorkflowView: ((): string | null => {
            const v = (user as any).last_workflow_view;
            return v === "gmail" || v === "tv" || v === "link" ? v : null;
          })(),
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });


    }

    if (action === "create") {
      const { username, password, name, role, assigned_accounts, is_free, expires_at, tv_override, plan_starts_at, plan_ends_at } = params;
      const isFree = !!is_free;
      if (!name) throw new Error("Name required");
      if (!isFree && (!username || !password)) throw new Error("Username and password required");

      // Only free profiles may have an expiry. Validate + normalize.
      let expiresAtIso: string | null = null;
      if (expires_at) {
        if (!isFree) throw new Error("Only free profiles can have an expiry");
        const t = Date.parse(String(expires_at));
        if (!Number.isFinite(t)) throw new Error("Invalid expiry date");
        if (t <= Date.now()) throw new Error("Expiry must be in the future");
        expiresAtIso = new Date(t).toISOString();
      }

      // Optionally require admin session for creating users
      let bootstrapCreate = false;
      let actorId: string | null = null;
      try {
        const admin = await requireAdmin(req);
        actorId = admin.userId;
      } catch {
        // Allow first user creation without session (bootstrap)
        const { data: existing } = await supabase.from("app_users").select("id").limit(1);
        if (existing && existing.length > 0) throw new Error("Admin session required to create users");
        bootstrapCreate = true;
      }

      // Bootstrap (first user) can never be a free profile — must be admin.
      if (bootstrapCreate && isFree) throw new Error("First user must be admin");

      // Free profile: passwordless one-tap entry. Username is optional/manual only
      // (never generated); paid/admin profile still requires username + password.
      const cleanedUsername = typeof username === "string" && username.trim() ? username.trim() : null;
      const finalUsername = isFree ? cleanedUsername : username;
      const finalRole = isFree ? "user" : (role || "user");
      const normalizedAssignedAccounts = await normalizeAssignedAccounts(supabase, assigned_accounts);
      const normalizedTvOverride = tv_override === "on" || tv_override === "off" ? tv_override : null;
      const insertPayload: any = {
        username: finalUsername,
        password: isFree ? null : await hashPassword(password),
        name,
        role: finalRole,
        assigned_accounts: normalizedAssignedAccounts,
        is_free: isFree,
        expires_at: expiresAtIso,
        // Force password reset on first login for regular (non-free, non-bootstrap-admin) users.
        must_change_password: !isFree && !bootstrapCreate,
        // Default GPS required = true for every non-admin profile; admin can turn it off per profile.
        profile_prefs: { avatarId: null, locationRequired: finalRole !== "admin" },
        tv_override: normalizedTvOverride,
      };

      // Paid users can have plan dates. Admin/free rows have them nulled by trigger.
      if (!isFree && finalRole !== "admin") {
        if (plan_starts_at) {
          const t = Date.parse(String(plan_starts_at));
          if (!Number.isFinite(t)) throw new Error("Invalid plan start date");
          insertPayload.plan_starts_at = new Date(t).toISOString();
        }
        if (plan_ends_at) {
          const t = Date.parse(String(plan_ends_at));
          if (!Number.isFinite(t)) throw new Error("Invalid plan end date");
          insertPayload.plan_ends_at = new Date(t).toISOString();
        }
      }

      const { data, error } = await supabase
        .from("app_users")
        .insert(insertPayload)
        .select("id, username, name, role, assigned_accounts, profile_prefs, is_free, pinned, sort_order, expires_at, tv_override, plan_starts_at, plan_ends_at")
        .single();
      if (error) throw error;
      invalidateBootstrapCache();

      await auditLog(supabase, bootstrapCreate ? "bootstrap_admin_created" : (isFree ? "free_user_created" : "user_created"), actorId, data.id, { username: finalUsername, role: finalRole, isFree, expiresAt: expiresAtIso, tvOverride: normalizedTvOverride }, ip);

      return new Response(JSON.stringify({
        success: true,
        user: {
          ...data,
          assignedAccounts: normalizeAccountLabels(data.assigned_accounts || [], normalizedAssignedAccounts || []),
          profileAvatar: data.profile_prefs?.avatarId || null,
          profilePrefs: publicProfilePrefs(data.profile_prefs),
          locationRequired: isProfileLocationRequired(data, await loadGlobalLocationRequired(supabase)),
          isFree: !!data.is_free,
          pinned: !!data.pinned,
          sortOrder: data.sort_order ?? null,
          expiresAt: data.expires_at || null,
          tvOverride: data.tv_override === "on" || data.tv_override === "off" ? data.tv_override : null,
          planStartsAt: (data as any).plan_starts_at || null,
          planEndsAt: (data as any).plan_ends_at || null,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete") {
      const session = await requireAdmin(req);
      const { id } = params;
      const { error } = await supabase.from("app_users").delete().eq("id", id);
      if (error) throw error;
      invalidateBootstrapCache();
      await auditLog(supabase, "user_deleted", session.userId, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "change_password") {
      const { id, current_password, new_password } = params;
      if (!id || !new_password) throw new Error("ID and new password required");
      if (new_password.length < 6) throw new Error("Password must be at least 6 characters");

      const { data: user, error: fetchErr } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", id)
        .single();
      if (fetchErr || !user) throw new Error("User not found");

      let isAdminReset = false;
      let clearForcedReset = false;
      if (current_password) {
        // Normal self-change: verify current password
        const match = await verifyPassword(current_password, user.password);
        if (!match) throw new Error("Current password is incorrect");
      } else {
        // Either admin reset OR forced first-time password set
        const token = req.headers.get("x-session-token");
        if (!token) throw new Error("Authentication required to change password");
        const session = await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING);
        if (!session) throw new Error("Session expired or invalid");

        if (session.role === "admin" && session.userId !== id) {
          // Admin resetting another user's password — force them to change on next login
          isAdminReset = true;
        } else if (session.role === "admin") {
          // Admin changing own password — allowed
        } else if (session.userId === id && user.must_change_password) {
          // First-time forced password set — allowed
          clearForcedReset = true;
        } else {
          throw new Error("Provide your current password or contact an admin");
        }
      }

      const hashed = await hashPassword(new_password);
      const { error } = await supabase.from("app_users").update({ password: hashed, must_change_password: isAdminReset && !clearForcedReset }).eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "password_changed", id, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_profile_prefs") {
      const session = await requireSession(req);
      const { profile_prefs } = params;
      if (!profile_prefs || typeof profile_prefs !== "object" || Array.isArray(profile_prefs)) {
        throw new Error("Profile settings are invalid");
      }

      // Users can only edit their avatar. hiddenBefore/hiddenEmailIds are
      // rejected — end-user email hiding is fully disabled; only admins can
      // suppress emails (via `destroyed=true`).
      const cleanPrefs = {
        avatarId: typeof profile_prefs.avatarId === "string" ? profile_prefs.avatarId : null,
        locationRequired: false,
        locationRequiredOverride: false,
        hiddenBefore: null as string | null,
        hiddenEmailIds: [] as string[],
      };

      // Load current user row for cooldown + prefs merge.
      const { data: currentRow } = await supabase
        .from("app_users")
        .select("profile_prefs, is_free")
        .eq("id", session.userId)
        .maybeSingle();
      try {
        const existingPrefs = publicProfilePrefs(currentRow?.profile_prefs);
        cleanPrefs.locationRequired = existingPrefs.locationRequired;
        cleanPrefs.locationRequiredOverride = existingPrefs.locationRequiredOverride;
      } catch {}

      // === Global cooldown for free-profile avatar changes ===
      const prevAvatar: string | null = (currentRow?.profile_prefs as any)?.avatarId || null;
      const avatarChanged = (cleanPrefs.avatarId || null) !== prevAvatar;
      const isFree = !!currentRow?.is_free;
      if (isFree && avatarChanged) {
        const { data: cdRows } = await supabase
          .from("app_settings")
          .select("key,value")
          .in("key", ["free_avatar_cooldown", "free_avatar_last_change"]);
        const cdMap = new Map((cdRows || []).map((r: any) => [r.key, r.value]));
        const minutesRaw = Number((cdMap.get("free_avatar_cooldown") as any)?.minutes);
        const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? Math.floor(minutesRaw) : 5;
        const lastAtStr = (cdMap.get("free_avatar_last_change") as any)?.at || null;
        const lastAtMs = lastAtStr ? Date.parse(lastAtStr) : 0;
        const elapsedMs = Date.now() - (Number.isFinite(lastAtMs) ? lastAtMs : 0);
        const windowMs = minutes * 60_000;
        if (lastAtMs && elapsedMs < windowMs) {
          const retryAfterSec = Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));
          return new Response(JSON.stringify({
            success: false,
            code: "AVATAR_COOLDOWN",
            error: `Profile icon was recently updated. Try again in ${retryAfterSec}s.`,
            retryAfterSec,
            minutes,
            lastAt: lastAtStr,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      invalidateBootstrapCache();
      const { error } = await supabase
        .from("app_users")
        .update({ profile_prefs: cleanPrefs })
        .eq("id", session.userId);
      if (error) throw error;

      let cooldownNow: { minutes: number; lastAt: string | null } | null = null;
      if (isFree && avatarChanged) {
        const nowIso = new Date().toISOString();
        await upsertSetting(supabase, "free_avatar_last_change", { at: nowIso, byUserId: session.userId });
        const { data: cdRow } = await readSettingRow(supabase, "free_avatar_cooldown");
        const minutesRaw = Number((cdRow?.value as any)?.minutes);
        const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? Math.floor(minutesRaw) : 5;
        cooldownNow = { minutes, lastAt: nowIso };
      }

      await auditLog(supabase, "profile_prefs_updated", session.userId, session.userId, { avatarId: cleanPrefs.avatarId, hiddenBefore: cleanPrefs.hiddenBefore }, ip);
      return new Response(JSON.stringify({ success: true, profilePrefs: cleanPrefs, freeAvatarCooldown: cooldownNow }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_totp") {
      const { user_id } = params;
      const { pending } = await requirePendingAdmin(req, user_id);
      const { data: existing, error: exErr } = await supabase
        .from("app_users").select("id, username, totp_secret").eq("id", pending.userId).single();
      if (exErr) throw exErr;
      if (existing?.totp_secret) throw new Error("TOTP is already configured");
      const secret = authenticator.generateSecret();
      const otpauthUrl = authenticator.keyuri(existing.username, "AdminPanel", secret);
      const { error } = await supabase.from("app_users").update({ totp_secret: secret }).eq("id", pending.userId);
      if (error) throw error;
      await auditLog(supabase, "totp_setup_created", pending.userId, pending.userId, {}, ip);
      return new Response(JSON.stringify({ success: true, secret, otpauthUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // NOTE: The insecure `create_otp` action was removed. OTPs are generated
    // server-side by `request_admin_otp` and never accepted from the client.

    if (action === "request_admin_otp") {
      const { user_id } = params;
      if (!user_id) throw new Error("user_id required");
      await requirePendingAdmin(req, user_id);

      // Generate OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

      // Kick off DB write (delete+insert) and Telegram-config lookup in parallel
      // so we spend one round-trip on both, not two sequentially.
      const dbWrite = (async () => {
        await supabase.from("app_otps").delete().eq("user_id", user_id);
        const { error } = await supabase.from("app_otps").insert({ user_id, otp: otpCode });
        if (error) throw error;
      })();
      const cfgLookup = getTelegramConfig(supabase);

      const [tgConfig] = await Promise.all([cfgLookup, dbWrite]);
      if (!tgConfig) {
        throw new Error("Telegram not configured. Set bot token and chat ID in admin settings.");
      }

      // Send OTP via Telegram with a hard 6s timeout so a slow Telegram edge
      // can't stall the whole response for 20-30s.
      let telegramRes: Response;
      try {
        telegramRes = await postTelegram(tgConfig, {
          text: `🛡 Admin 3FA OTP: <code>${otpCode}</code>\nValid for 5 minutes.`,
        }, 6000);
      } catch (e) {
        console.error("Telegram send timeout/error:", e);
        throw new Error("Telegram is slow to respond. Try again in a moment.");
      }

      if (!telegramRes.ok) {
        const errText = await telegramRes.text();
        console.error("Telegram API error:", errText);
        throw new Error("Failed to send OTP via Telegram. Check bot token and chat ID.");
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_otp") {
      const { pending, tokenHash } = await requirePendingAdmin(req, params.user_id);
      const { user_id, otp } = params;
      const { data, error } = await supabase
        .from("app_otps")
        .select("*")
        .eq("user_id", user_id)
        .eq("otp", otp)
        .gte("expires_at", new Date().toISOString())
        .single();

      if (error || !data) throw new Error("Invalid or expired OTP");
      await supabase.from("app_otps").delete().eq("id", data.id);
      await supabase.from("app_admin_2fa_state").update({ otp_verified_at: new Date().toISOString() }).eq("token_hash", tokenHash).eq("user_id", pending.userId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_totp") {
      const { pending, tokenHash } = await requirePendingAdmin(req, params.user_id);
      const { code } = params;
      if (!code || String(code).length < 6) throw new Error("TOTP code required");
      const { data: user, error } = await supabase.from("app_users").select("totp_secret").eq("id", pending.userId).single();
      if (error || !user?.totp_secret) throw new Error("TOTP is not configured");
      if (!(await verifyTotpWithGrace(String(code), user.totp_secret))) throw new Error("Invalid Google Authenticator code");
      await supabase.from("app_admin_2fa_state").update({ totp_verified_at: new Date().toISOString() }).eq("token_hash", tokenHash).eq("user_id", pending.userId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "finalize_admin_session") {
      const { pending, tokenHash, state } = await requirePendingAdmin(req, params.user_id);
      const now = Date.now();
      const otpAt = state.otp_verified_at ? new Date(state.otp_verified_at).getTime() : 0;
      const totpAt = state.totp_verified_at ? new Date(state.totp_verified_at).getTime() : 0;
      if (!otpAt || now - otpAt > 15 * 60_000) throw new Error("Telegram OTP proof expired");
      if (!totpAt || now - totpAt > 15 * 60_000) throw new Error("Authenticator proof expired");

      const { data: user, error } = await supabase.from("app_users").select("*").eq("id", pending.userId).single();
      if (error || !user || user.role !== "admin") throw new Error("Admin not found");
      const normalizedAssignedAccounts = await normalizeAssignedAccounts(supabase, user.assigned_accounts);
      let adminSessionTtlMs = 60 * 60_000;
      try {
        const { data: sessionCfg } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "admin_session_config")
          .maybeSingle();
        const minutes = Number((sessionCfg?.value as any)?.timeoutMinutes);
        if (Number.isFinite(minutes) && minutes > 0) adminSessionTtlMs = Math.max(1, Math.min(24 * 60, Math.floor(minutes))) * 60_000;
      } catch {}
      const pair = await mintSessionPair(user.id, "admin", {
        userId: user.id,
        username: user.username,
        role: "admin",
        assignedAccounts: normalizedAssignedAccounts,
      }, { ttlOverrideMs: adminSessionTtlMs });
      const workerUrls = await loadWorkerUrls(supabase);
      await supabase.from("app_admin_2fa_state").delete().eq("token_hash", tokenHash);
      await auditLog(supabase, "admin_2fa_finalized", user.id, user.id, {}, ip);
      const adminLocationRequired = isProfileLocationRequired(user, await loadGlobalLocationRequired(supabase));
      const pendingClientGeo = sanitizeClientGeo((pending as any).clientGeo);
      const alertGeo = pendingClientGeo?.status === "granted" ? pendingClientGeo : null;
      const adminAlert = sendLoginNotification(supabase, req, user, "success", alertGeo, { locationRequired: adminLocationRequired });
      (globalThis as any).EdgeRuntime?.waitUntil?.(adminAlert) ?? adminAlert.catch(() => {});
      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
        sessionFamilyId: pair.familyId,
        sessionTimeoutMinutes: Math.floor(adminSessionTtlMs / 60_000),
        workerUrls,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: normalizedAssignedAccounts,
          profilePrefs: publicProfilePrefs(user.profile_prefs),
          profileAvatar: user.profile_prefs?.avatarId || null,
          locationRequired: adminLocationRequired,
          tvOverride: user.tv_override === "on" || user.tv_override === "off" ? user.tv_override : null,
          tvFeatureEnabled: await loadTvFeatureEnabled(supabase),
          features: pickFeatures(user),
          lastWorkflowView: user.last_workflow_view === "gmail" || user.last_workflow_view === "tv" || user.last_workflow_view === "link" ? user.last_workflow_view : null,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    if (action === "get_settings") {
      const { key } = params;
      let session: Record<string, any> | null = null;

      // Fully admin-only keys
      const adminOnlyKeys = ["config", "cron_config", "vps_config", "r2_storage"];
      if (adminOnlyKeys.includes(key)) {
        session = await requireAdmin(req);
      }

      // Keys that any authenticated user can read (with masked sensitive data)
      const authenticatedKeys = ["primary_cloudflare_urls", "email_accounts", "recaptcha", "email_filters", "session_config", "admin_session_config", "session_limits", "location_policy", "free_session_minutes", "tv_feature", "contact_info", "developer_links"];
      if (!session && authenticatedKeys.includes(key)) {
        session = await requireSession(req);
      }

      // Default-deny settings access: only explicitly listed keys are readable.
      // This prevents newly-added secret settings (for example storage/API
      // credentials) from becoming public through this generic endpoint.
      const publicKeys = ["maintenance", "developer_links"];
      if (!session && !publicKeys.includes(key)) {
        throw new Error("Settings key is not public");
      }

      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", key)
        .single();

      let value = key === "email_filters" ? normalizeEmailFilters(data?.value) : (data?.value || null);
      value = await ensureSettingsSecretsEncrypted(supabase, key, value, ENCRYPTION_SECRET);

      if (key === "tv_feature") {
        value = { enabled: value?.enabled !== false };
      }

      if (key === "r2_storage") {
        const normalized = normalizeR2Config(value || {});
        const hasSecret = typeof normalized.config.secretAccessKey === "string" && normalized.config.secretAccessKey.length > 0;
        value = {
          accountId: normalized.config.accountId,
          accessKeyId: normalized.config.accessKeyId,
          secretAccessKey: "",
          bucket: normalized.config.bucket,
          publicBaseUrl: normalized.config.publicBaseUrl,
          pathPrefix: normalized.config.pathPrefix,
          enabled: normalized.config.enabled,
          secretAccessKeySet: hasSecret,
        };
      }

      if (key === "config" && value && session?.role === "admin") {
        value = await maskConfigForAdmin(value, ENCRYPTION_SECRET);
      }

      // Admin gets REAL decrypted IMAP passwords (transport is E2E encrypted).
      // Non-admin users only see cloudflare URLs and label; password is masked.
      if (key === "email_accounts" && Array.isArray(value)) {
        const isAdmin = session?.role === "admin";
        value = isAdmin
          ? await maskEmailAccountsForAdmin(value, ENCRYPTION_SECRET)
          : value.map((acc: any) => ({
              ...acc,
              password: SECRET_MASK,
              // Non-admin users only see cloudflare URLs and label
              host: undefined,
              port: undefined,
              user: undefined,
            }));
      }

      if (key === "recaptcha" && value && session?.role !== "admin") {
        const { secretKey, ...safeValue } = value;
        value = safeValue;
      }

      return new Response(JSON.stringify({ success: true, value }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_get_vps_config") {
      await requireAdmin(req);
      const { data } = await readSettingRow(supabase, "vps_config");
      return new Response(JSON.stringify({ success: true, value: publicVpsConfig(data?.value) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_save_vps_access") {
      const session = await requireAdmin(req);
      const nextIp = String(params?.ip || "").trim() || "140.238.226.213";
      if (!/^[A-Za-z0-9:.[\]-]{3,255}$/.test(nextIp)) throw new Error("Enter a valid VPS IP or hostname");
      let nextRunnerUrl = String(params?.runnerUrl || "").trim().replace(/\/+$/g, "");
      if (nextRunnerUrl) {
        try {
          const u = new URL(nextRunnerUrl);
          if (!/^https?:$/.test(u.protocol)) throw new Error("bad proto");
          nextRunnerUrl = u.toString().replace(/\/+$/g, "");
        } catch {
          throw new Error("Runner URL must be like http://IP:8788");
        }
      }
      const { data } = await readSettingRow(supabase, "vps_config");
      const prev = publicVpsConfig(data?.value);
      const rawMode = String(params?.mode || "").trim().toLowerCase();
      const nextMode: "vps" | "github" = rawMode === "github" ? "github" : "vps";
      const value = { ...prev, ip: nextIp, runnerUrl: nextRunnerUrl, mode: nextMode };
      const { error } = await supabase.from("app_settings").upsert({ key: "vps_config", value }, { onConflict: "key" });
      invalidateAllSettings();
      if (error) throw error;
      await auditLog(supabase, "vps_access_updated", session.userId, null, { ip: nextIp, runnerUrl: nextRunnerUrl || null, mode: nextMode }, ip);
      return new Response(JSON.stringify({ success: true, value: publicVpsConfig(value) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_test_vps_runner") {
      await requireAdmin(req);
      const { data } = await readSettingRow(supabase, "vps_config");
      const url = effectiveTvRunnerUrl(data?.value);
      if (!url) {
        return new Response(JSON.stringify({ success: false, ok: false, message: "Runner URL is not configured." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const started = Date.now();
      try {
        const r = await fetch(`${url}/health`, { method: "GET", signal: AbortSignal.timeout(5000) });
        const txt = await r.text().catch(() => "");
        let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch {}
        const ms = Date.now() - started;
        return new Response(JSON.stringify({
          success: true,
          ok: r.ok,
          status: r.status,
          latencyMs: ms,
          url,
          body: body ?? txt.slice(0, 400),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e: any) {
        return new Response(JSON.stringify({
          success: true,
          ok: false,
          status: 0,
          latencyMs: Date.now() - started,
          url,
          message: e?.message || String(e),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (action === "admin_github_status") {
      await requireAdmin(req);
      const cfg = await loadGithubConfig();
      const reveal = !!(params as any)?.reveal;
      return new Response(JSON.stringify({
        success: true,
        configured: !!(cfg.pat && cfg.repo && cfg.hmacKey),
        repo: cfg.repo || "",
        hasPat: !!cfg.pat,
        hasHmac: !!cfg.hmacKey,
        updatedAt: cfg.updatedAt,
        pat: reveal ? (cfg.pat || "") : undefined,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_github_setup") {
      const admin = await requireAdmin(req);
      const p = (params || {}) as any;
      const patInput = String(p?.pat || "").trim();
      const repoInput = String(p?.repo || "").trim();
      const existing = await loadGithubConfig();
      const pat = patInput || existing.pat;
      if (!pat) throw new Error("A GitHub Personal Access Token is required.");

      // 1) Validate PAT and get login
      const me = await ghApi(pat, "/user");
      if (me.status !== 200 || !me.json?.login) {
        throw new Error(`GitHub token invalid (${me.status}). Create a fine-grained PAT with Actions: read+write, Secrets: read+write, Metadata: read.`);
      }
      const login = String(me.json.login);

      // 2) Resolve repo: user-provided, existing config, or auto-detect
      const candidates: string[] = [];
      if (repoInput) candidates.push(repoInput.includes("/") ? repoInput : `${login}/${repoInput}`);
      if (existing.repo) candidates.push(existing.repo);
      candidates.push(`${login}/remix-of-inbox-debugger`, `${login}/inbox-debugger`);

      let chosenRepo = "";
      let checkedWorkflow = false;
      for (const cand of candidates) {
        const wf = await ghApi(pat, `/repos/${cand}/actions/workflows/tv-login.yml`);
        if (wf.status === 200) { chosenRepo = cand; checkedWorkflow = true; break; }
      }
      // Fallback: scan user's repos for the workflow file (first page only)
      if (!chosenRepo) {
        const list = await ghApi(pat, `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator`);
        const repos: any[] = Array.isArray(list.json) ? list.json : [];
        for (const r of repos) {
          const full = String(r?.full_name || "");
          if (!full) continue;
          const wf = await ghApi(pat, `/repos/${full}/actions/workflows/tv-login.yml`);
          if (wf.status === 200) { chosenRepo = full; checkedWorkflow = true; break; }
        }
      }
      if (!chosenRepo) {
        throw new Error("Could not find the TV workflow. Repo field me exact owner/name daalo, token me wahi repo selected rakho, aur repo me .github/workflows/tv-login.yml present hona chahiye.");
      }

      // 3) Generate a fresh HMAC key
      const hmacBytes = new Uint8Array(32);
      crypto.getRandomValues(hmacBytes);
      const hmacKey = Array.from(hmacBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

      // 4) Push it as a GitHub Actions secret. TV_REPORT_URL is intentionally
      // not a secret anymore; the workflow contains the public Edge Function
      // URL inline so missing repo secrets cannot leave events stuck queued.
      await pushGithubActionsSecret(pat, chosenRepo, "TV_REPORT_HMAC_KEY", hmacKey);

      // 5) Save all three in DB
      await saveGithubConfig({ pat, repo: chosenRepo, hmac_key: hmacKey, updated_by: (admin as any)?.id || null });

      return new Response(JSON.stringify({
        success: true,
        ok: true,
        repo: chosenRepo,
        login,
        workflowVerified: checkedWorkflow,
        message: `Synced with ${chosenRepo}. HMAC key rotated and pushed to GitHub Actions secrets.`,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_test_github_runner") {
      await requireAdmin(req);
      const cfg = await loadGithubConfig();
      const repo = cfg.repo;
      const pat = cfg.pat;
      if (!repo || !pat) {
        return new Response(JSON.stringify({ success: true, ok: false, status: 0, message: "GitHub repo/token is not configured. Use the GitHub Setup card." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const testId = `tv-test-${Date.now()}`;
      const headers = {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      };
      const started = Date.now();
      const dispatch = await dispatchGithubWorkflow(pat, repo, { test_id: testId });
      if (dispatch.status !== 204) {
        const body = await dispatch.text().catch(() => "");
        const msg = githubPermissionMessage(dispatch.status, body, "test");
        return new Response(JSON.stringify({ success: true, ok: false, status: dispatch.status, message: msg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let found: any = null;
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, i === 0 ? 700 : 1200));
        const runs = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/tv-login.yml/runs?event=workflow_dispatch&per_page=10`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(5000),
        });
        const text = await runs.text().catch(() => "");
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        const list = Array.isArray(json?.workflow_runs) ? json.workflow_runs : [];
        found = list.find((r: any) => {
          const created = Date.parse(String(r?.created_at || ""));
          return Number.isFinite(created) && created >= started - 30_000;
        }) || null;
        if (found && found.status !== "queued") break;
      }

      const elapsed = Date.now() - started;
      if (!found) {
        return new Response(JSON.stringify({ success: true, ok: true, status: 204, githubStatus: "dispatched", latencyMs: elapsed, message: "GitHub accepted the test dispatch. If it does not appear in Actions, check repo Actions permissions.", testId }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const ghStatus = String(found.status || "unknown");
      const conclusion = String(found.conclusion || "");
      const ok = ghStatus === "in_progress" || ghStatus === "completed";
      const message = ghStatus === "queued"
        ? "GitHub accepted it, but the workflow is still queued. Check Actions runner availability."
        : ghStatus === "completed"
          ? `GitHub workflow executed${conclusion ? ` (${conclusion})` : ""}.`
          : "GitHub workflow started.";
      return new Response(JSON.stringify({ success: true, ok, status: 204, githubStatus: ghStatus, conclusion, latencyMs: elapsed, runUrl: found.html_url || "", message, testId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_reveal_session_signing_secret") {
      const session = await requireAdmin(req);
      const explicitValue = Deno.env.get("SESSION_SIGNING_SECRET") || "";
      const value = explicitValue || SIGNING_SECRET;
      const source = explicitValue ? "SESSION_SIGNING_SECRET" : "legacy_fallback";
      await auditLog(supabase, "session_signing_secret_inspected", session.userId, null, { length: value.length, source }, ip);
      // SECURITY: never return the raw signing key. Return metadata only.
      // A leaked signing key allows permanent session-token forgery.
      return new Response(JSON.stringify({
        success: true,
        name: "SESSION_SIGNING_SECRET",
        present: !!value,
        length: value.length,
        source,
        // Non-reversible fingerprint so admins can confirm rotation without
        // ever exposing the secret itself.
        fingerprint: value ? (await sha256Hex(value)).slice(0, 12) : "",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "set_tv_feature") {
      const session = await requireAdmin(req);
      const enabled = params?.enabled !== false;
      invalidateBootstrapCache();
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key: "tv_feature", value: { enabled } }, { onConflict: "key" });
      if (error) throw error;
      // Global switch is TOP priority: flipping it wipes every per-user override
      // so the new global value truly applies to everyone. Admins can then
      // manually re-flip individuals afterwards.
      const { error: clearErr } = await supabase
        .from("app_users")
        .update({ tv_override: null })
        .not("tv_override", "is", null);
      if (clearErr) console.warn("tv_override bulk clear failed", clearErr);
      await auditLog(supabase, "settings_changed", session.userId, null, { key: "tv_feature", enabled, cleared_overrides: true }, ip);
      return new Response(JSON.stringify({ success: true, value: { enabled }, cleared_overrides: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "save_contact_info") {
      const session = await requireAdmin(req);
      const raw = ((params as any)?.value && typeof (params as any).value === "object") ? (params as any).value : (params || {});
      const trim = (v: any, max = 240) => typeof v === "string" ? v.trim().slice(0, max) : "";
      const arr = (v: any, max = 240, limit = 10): string[] => {
        if (!Array.isArray(v)) return [];
        const out: string[] = [];
        const seen = new Set<string>();
        for (const it of v) {
          const s = trim(it, max);
          if (!s || seen.has(s)) continue;
          seen.add(s);
          out.push(s);
          if (out.length >= limit) break;
        }
        return out;
      };
      const telegrams = arr(raw.telegrams);
      const whatsapps = arr(raw.whatsapps);
      const emails = arr(raw.emails);
      // Legacy singular fields — if arrays given, first entry wins; else keep singular.
      const telegram = telegrams[0] || trim(raw.telegram);
      const whatsapp = whatsapps[0] || trim(raw.whatsapp);
      const email = emails[0] || trim(raw.email);
      const value = {
        telegram, whatsapp, email,
        telegrams: telegrams.length ? telegrams : (telegram ? [telegram] : []),
        whatsapps: whatsapps.length ? whatsapps : (whatsapp ? [whatsapp] : []),
        emails: emails.length ? emails : (email ? [email] : []),
        note: trim(raw.note, 500),
      };
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key: "contact_info", value }, { onConflict: "key" });
      if (error) throw error;
      invalidateBootstrapCache();
      await auditLog(supabase, "settings_changed", session.userId, null, { key: "contact_info" }, ip);
      return new Response(JSON.stringify({ success: true, value }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "save_developer_links") {
      const session = await requireAdmin(req);
      const raw = ((params as any)?.value && typeof (params as any).value === "object") ? (params as any).value : (params || {});
      const trim = (v: any, max = 240) => typeof v === "string" ? v.trim().slice(0, max) : "";
      const rawLinks = Array.isArray(raw.links) ? raw.links : [];
      const links: any[] = [];
      const seen = new Set<string>();
      for (const item of rawLinks) {
        if (!item || typeof item !== "object") continue;
        const url = trim(item.url, 600);
        if (!url || !/^https?:\/\//i.test(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        links.push({
          id: trim(item.id, 40) || `dev_${links.length}_${Date.now().toString(36)}`,
          label: trim(item.label, 60) || "Developer",
          url,
          role: trim(item.role, 80),
          description: trim(item.description, 240),
          avatar: trim(item.avatar, 600),
        });
        if (links.length >= 24) break;
      }
      const value = { links, buttonLabel: trim(raw.buttonLabel, 24) || "Developer" };
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key: "developer_links", value }, { onConflict: "key" });
      if (error) throw error;
      invalidateBootstrapCache();
      await auditLog(supabase, "settings_changed", session.userId, null, { key: "developer_links", count: links.length }, ip);
      return new Response(JSON.stringify({ success: true, value }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }





    if (action === "set_settings") {
      const session = await requireAdmin(req);
      const { key, value } = params;
      // Any change to keys that feed bootstrap_public must drop the cache so
      // profile picker/maintenance banner update within a second, not 10s.
      invalidateBootstrapCache();

      let processedValue = value;

      if (key === "tv_feature") {
        processedValue = { enabled: value?.enabled !== false };
      }

      if (key === "config" && value && typeof value === "object") {
        const { data: existingData } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "config")
          .maybeSingle();
        processedValue = await processConfigSecrets(value, existingData?.value || {}, ENCRYPTION_SECRET);
      }

      // Maintenance: enforce upgrade-only version bumps + valid time window.
      if (key === "maintenance" && value && typeof value === "object") {
        const v: any = value;
        // Validate schedule window: startsAt must be strictly before endsAt.
        const sAt = typeof v.startsAt === "string" && v.startsAt ? Date.parse(v.startsAt) : NaN;
        const eAt = typeof v.endsAt === "string" && v.endsAt ? Date.parse(v.endsAt) : NaN;
        if (Number.isFinite(sAt) && Number.isFinite(eAt)) {
          if (sAt >= eAt) {
            throw new Error("Maintenance window is invalid: end time must be after start time.");
          }
          if (eAt - sAt < 60 * 1000) {
            throw new Error("Maintenance window is too short: keep at least 1 minute between start and end.");
          }
        }
        const cmpVer = (a: string, b: string): number => {
          const pa = String(a || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
          const pb = String(b || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
          const len = Math.max(pa.length, pb.length);
          for (let i = 0; i < len; i++) {
            const x = Number.isFinite(pa[i]) ? pa[i] : 0;
            const y = Number.isFinite(pb[i]) ? pb[i] : 0;
            if (x !== y) return x - y;
          }
          return 0;
        };
        try {
          const { data: prev } = await supabase.from("app_settings").select("value").eq("key", "maintenance").single();
          const prevTo = prev?.value?.versionTo || "";
          const nextTo = v.versionTo || "";
          if (prevTo && nextTo && cmpVer(nextTo, prevTo) < 0) {
            throw new Error(`Version downgrade blocked: current is ${prevTo}, cannot set to ${nextTo}.`);
          }
        } catch (e) {
          if (e instanceof Error && (e.message.startsWith("Version downgrade") || e.message.startsWith("Maintenance window"))) throw e;
        }
      }



      // Encrypt IMAP passwords in email_accounts
      if (key === "email_accounts" && Array.isArray(value)) {
        // Get existing accounts to preserve encrypted passwords when masked
        const { data: existingData } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "email_accounts")
          .maybeSingle();
        const existingAccounts = existingData?.value || [];
        processedValue = await processEmailAccountSecrets(value, Array.isArray(existingAccounts) ? existingAccounts : [], ENCRYPTION_SECRET);
      }

      if (key === "email_filters") {
        processedValue = normalizeEmailFilters(processedValue);
      }

      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value: processedValue }, { onConflict: "key" });
      if (error) throw error;
      if (["config", "email_accounts", "primary_cloudflare_urls", "email_filters", "email_visibility"].includes(key)) {
        await pushInboxConfigToWorkers(supabase, SIGNING_SECRET, ENCRYPTION_SECRET).catch((e) => console.warn("[worker-config] push failed:", e?.message || e));
      }
      await auditLog(supabase, "settings_changed", session.userId, null, { key }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_user") {
      const session = await requireAdmin(req);
      const { id, assigned_accounts, session_limit, pinned, is_free, name, username, expires_at, location_required, auto_delete, plan_starts_at, plan_ends_at } = params;
      const tvOverrideProvided = params.tv_override !== undefined || params.tvOverride !== undefined;
      const tvOverrideValue = params.tv_override !== undefined ? params.tv_override : params.tvOverride;
      if (!id) throw new Error("User ID required");
      const patch: Record<string, any> = {};
      if (assigned_accounts !== undefined) patch.assigned_accounts = await normalizeAssignedAccounts(supabase, assigned_accounts);
      if (typeof name === "string" && name.trim()) patch.name = name.trim();
      if (username !== undefined) {
        const cleanUsername = typeof username === "string" && username.trim() ? username.trim() : null;
        if (!cleanUsername) {
          const { data: existingUser } = await supabase.from("app_users").select("is_free").eq("id", id).maybeSingle();
          if (!existingUser?.is_free) throw new Error("Username required");
        }
        patch.username = cleanUsername;
      }
      if (pinned !== undefined) patch.pinned = !!pinned;
      if (is_free !== undefined) patch.is_free = !!is_free;
      if (location_required !== undefined) {
        const { data: existingUser } = await supabase.from("app_users").select("profile_prefs, is_free, role").eq("id", id).maybeSingle();
        const existingPrefs = existingUser?.profile_prefs && typeof existingUser.profile_prefs === "object" && !Array.isArray(existingUser.profile_prefs) ? existingUser.profile_prefs : {};
        // Admin AND user rows both get an explicit override. Admin default is
        // OFF, user default is ON — flipping the toggle records that intent.
        patch.profile_prefs = { ...existingPrefs, locationRequired: location_required === true, locationRequiredOverride: true };
      }
      if (expires_at !== undefined) {
        if (expires_at === null || expires_at === "") {
          patch.expires_at = null;
        } else {
          const t = Date.parse(String(expires_at));
          if (!Number.isFinite(t)) throw new Error("Invalid expiry date");
          patch.expires_at = new Date(t).toISOString();
        }
      }
      if (auto_delete !== undefined) patch.auto_delete = !!auto_delete;
      if (tvOverrideProvided) {
        // null/undefined string -> clear (inherit global). "on"|"off" -> force.
        if (tvOverrideValue === null || tvOverrideValue === "" || tvOverrideValue === "inherit") {
          patch.tv_override = null;
        } else if (tvOverrideValue === "on" || tvOverrideValue === "off") {
          patch.tv_override = tvOverrideValue;
        } else {
          throw new Error("Invalid tv_override");
        }
      }
      if (session_limit !== undefined) {
        // null | "" -> clear (fall back to global). Otherwise clamp to a sane non-negative int.
        if (session_limit === null || session_limit === "") {
          patch.session_limit = null;
        } else {
          const n = Math.max(0, Math.min(50, Math.floor(Number(session_limit) || 0)));
          patch.session_limit = n;
        }
      }
      if (params?.features && typeof params.features === "object") {
        const f = params.features as any;
        if (typeof f.gmail === "boolean") patch.feature_gmail = f.gmail;
        if (typeof f.tv === "boolean")    patch.feature_tv    = f.tv;
        if (typeof f.link === "boolean")  patch.feature_link  = f.link;
      }
      // Plan dates: allowed only for paid non-admin users; trigger enforces this too.
      if (plan_starts_at !== undefined) {
        if (plan_starts_at === null || plan_starts_at === "") {
          patch.plan_starts_at = null;
        } else {
          const t = Date.parse(String(plan_starts_at));
          if (!Number.isFinite(t)) throw new Error("Invalid plan start date");
          patch.plan_starts_at = new Date(t).toISOString();
        }
      }
      if (plan_ends_at !== undefined) {
        if (plan_ends_at === null || plan_ends_at === "") {
          patch.plan_ends_at = null;
        } else {
          const t = Date.parse(String(plan_ends_at));
          if (!Number.isFinite(t)) throw new Error("Invalid plan end date");
          patch.plan_ends_at = new Date(t).toISOString();
        }
        // Reset reminder throttles so admin extending a plan will re-arm reminders.
        patch.plan_last_reminder_at = null;
      }
      if (Object.keys(patch).length === 0) {
        return new Response(JSON.stringify({ success: true, noop: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: updatedUser, error } = await supabase
        .from("app_users")
        .update(patch)
        .eq("id", id)
        .select("id, feature_gmail, feature_tv, feature_link, tv_override, plan_starts_at, plan_ends_at")
        .maybeSingle();
      if (error) throw error;
      invalidateBootstrapCache();
      await auditLog(supabase, "user_updated", session.userId, id, patch, ip);
      return new Response(JSON.stringify({ success: true, user: updatedUser ? { ...updatedUser, features: pickFeatures(updatedUser), tvOverride: updatedUser.tv_override === "on" || updatedUser.tv_override === "off" ? updatedUser.tv_override : null, planStartsAt: updatedUser.plan_starts_at || null, planEndsAt: updatedUser.plan_ends_at || null } : null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "reorder_users") {
      const session = await requireAdmin(req);
      const orderedIds = Array.isArray(params?.orderedIds) ? params.orderedIds.filter((s: any) => typeof s === "string") : [];
      if (orderedIds.length === 0) throw new Error("orderedIds required");
      // Bulk update: sort_order = index in provided array (0-based).
      const updates = orderedIds.map((id: string, idx: number) =>
        supabase.from("app_users").update({ sort_order: idx }).eq("id", id)
      );
      const results = await Promise.all(updates);
      const firstErr = results.find((r) => r.error);
      if (firstErr?.error) throw firstErr.error;
      invalidateBootstrapCache();
      await auditLog(supabase, "users_reordered", session.userId, null, { count: orderedIds.length }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "login_free") {
      // Passwordless entry for admin-created "free" profiles. Everyone can
      // enter — GPS is still enforced by default unless admin disabled it.
      const { user_id, clientGeo: freeClientGeo, captchaToken } = params;
      if (!user_id || typeof user_id !== "string") throw new Error("user_id required");

      // Same CAPTCHA gate as paid login: if admin enabled reCAPTCHA globally,
      // free profile entry also requires a solved captcha token.
      const { data: recaptchaSettingFree } = await readSettingRow(supabase, "recaptcha");
      const recaptchaCfgFree: any = recaptchaSettingFree?.value || null;
      if (recaptchaCfgFree?.enabled === true) {
        if (!recaptchaCfgFree?.secretKey) throw new Error("CAPTCHA is misconfigured. Contact admin.");
        if (!captchaToken || typeof captchaToken !== "string") throw new Error("CAPTCHA required. Refresh and try again.");
        const captchaOk = await verifyRecaptchaToken(recaptchaCfgFree.secretKey, captchaToken, ip);
        if (!captchaOk) throw new Error("CAPTCHA verification failed. Refresh and try again.");
      }
      const { data: user, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", user_id)
        .eq("is_free", true)
        .neq("role", "admin")
        .single();
      if (error || !user) throw new Error("Free profile not found");

      // Hard safety: only actual free profiles reach this branch. Never grant
      // a session to a paid/admin account through this endpoint.
      if (!user.is_free || user.role === "admin") throw new Error("Not a free profile");

      // Enforce expiry — and clean up expired free profiles opportunistically.
      if (user.expires_at && Date.parse(user.expires_at) <= Date.now()) {
        try { await supabase.from("app_users").delete().eq("id", user.id).eq("is_free", true); } catch {}
        invalidateBootstrapCache();
        throw new Error("This free profile has expired");
      }

      const freeLocationRequired = isProfileLocationRequired(user, await loadGlobalLocationRequired(supabase));
      const verifiedFreeClientGeo = sanitizeClientGeo(freeClientGeo);
      if (freeLocationRequired && verifiedFreeClientGeo?.permissionState !== "granted" && verifiedFreeClientGeo?.status !== "granted") {
        const status = verifiedFreeClientGeo?.status || "missing";
        const errDetail = verifiedFreeClientGeo?.error ? ` (${verifiedFreeClientGeo.error})` : "";
        if (status === "denied") throw new Error("GPS permission denied. Allow location for this site, then try again.");
        if (status === "unsupported") throw new Error("This browser/device does not support GPS location.");
        throw new Error(`Location permission is required (status=${status})${errDetail}.`);
      }

      await auditLog(supabase, "login_free", user.id, null, { username: user.username }, ip);

      // Free-profile session length. Uses the same session_config.timeoutMinutes
      // as paid users so the client SessionCountdown and the server token TTL
      // stay in sync — each login gets its own countdown from its own login time.
      let freeMinutes = 0;
      try {
        const { data: fsRow } = await readSettingRow(supabase, "session_config");
        const m = Number((fsRow?.value as any)?.timeoutMinutes);
        if (Number.isFinite(m) && m > 0) freeMinutes = Math.floor(m);
      } catch {}

      const normalizedAssignedAccounts = await normalizeAssignedAccounts(supabase, user.assigned_accounts);
      if (!normalizedAssignedAccountsEqual(normalizedAssignedAccounts, Array.isArray(user.assigned_accounts) ? user.assigned_accounts : null)) {
        await supabase.from("app_users").update({ assigned_accounts: normalizedAssignedAccounts }).eq("id", user.id);
        invalidateBootstrapCache();
      }
      const pair = await mintSessionPair(user.id, user.role, {
        userId: user.id,
        username: user.username,
        role: user.role,
        assignedAccounts: normalizedAssignedAccounts,
      }, freeMinutes > 0 ? { ttlOverrideMs: freeMinutes * 60_000 } : undefined);

      // Best-effort Telegram alert so admin still knows who logged into a free
      // profile. Includes GPS when required; minimal alert when admin disabled it.
      ((globalThis as any).EdgeRuntime?.waitUntil?.(sendLoginNotification(supabase, req, user, "success", verifiedFreeClientGeo, { locationRequired: freeLocationRequired })) ?? sendLoginNotification(supabase, req, user, "success", verifiedFreeClientGeo, { locationRequired: freeLocationRequired }).catch(() => {}));

      const workerUrls = await loadWorkerUrls(supabase);
      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
        sessionFamilyId: pair.familyId,
        sessionTimeoutMinutes: freeMinutes,
        workerUrls,
        user: {
          id: user.id, username: user.username, name: user.name, role: user.role,
          mustChangePassword: false,
          assignedAccounts: normalizedAssignedAccounts,
          profilePrefs: publicProfilePrefs(user.profile_prefs),
          profileAvatar: user.profile_prefs?.avatarId || null,
          isFree: true,
          expiresAt: user.expires_at || null,
          autoDelete: (user as any).auto_delete !== false,
          locationRequired: freeLocationRequired,
          tvOverride: user.tv_override === "on" || user.tv_override === "off" ? user.tv_override : null,
          tvFeatureEnabled: await loadTvFeatureEnabled(supabase),
          features: pickFeatures(user),
          planStartsAt: (user as any).plan_starts_at || null,
          planEndsAt: (user as any).plan_ends_at || null,
          lastWorkflowView: user.last_workflow_view === "gmail" || user.last_workflow_view === "tv" || user.last_workflow_view === "link" ? user.last_workflow_view : null,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    if (action === "impersonate") {
      const session = await requireAdmin(req);
      const { target_user_id } = params;
      if (!target_user_id) throw new Error("Target user ID required");

      const { data: targetUser, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", target_user_id)
        .single();
      if (error || !targetUser) throw new Error("User not found");

      const normalizedAssignedAccounts = await normalizeAssignedAccounts(supabase, targetUser.assigned_accounts);
      if (!normalizedAssignedAccountsEqual(normalizedAssignedAccounts, Array.isArray(targetUser.assigned_accounts) ? targetUser.assigned_accounts : null)) {
        await supabase.from("app_users").update({ assigned_accounts: normalizedAssignedAccounts }).eq("id", targetUser.id);
        invalidateBootstrapCache();
      }
      const pair = await mintSessionPair(targetUser.id, "user", {
        userId: targetUser.id,
        username: targetUser.username,
        role: "user",
        assignedAccounts: normalizedAssignedAccounts,
        impersonated: true,
        adminId: session.userId,
      }, { parentSessionId: session.sessionRowId || null, ttlOverrideMs: IMPERSONATION_SESSION_TTL_MS });

      await auditLog(supabase, "impersonate", session.userId, targetUser.id, { targetUsername: targetUser.username }, ip);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
        sessionFamilyId: pair.familyId,
        user: {
          id: targetUser.id, username: targetUser.username, name: targetUser.name, role: "user",
          assignedAccounts: normalizedAssignedAccounts, mustChangePassword: false,
          profilePrefs: publicProfilePrefs(targetUser.profile_prefs),
          profileAvatar: targetUser.profile_prefs?.avatarId || null,
          isFree: !!targetUser.is_free,
          locationRequired: isProfileLocationRequired(targetUser, await loadGlobalLocationRequired(supabase)),
          tvOverride: targetUser.tv_override === "on" || targetUser.tv_override === "off" ? targetUser.tv_override : null,
          tvFeatureEnabled: await loadTvFeatureEnabled(supabase),
          features: pickFeatures(targetUser),
          planStartsAt: (targetUser as any).plan_starts_at || null,
          planEndsAt: (targetUser as any).plan_ends_at || null,
          lastWorkflowView: targetUser.last_workflow_view === "gmail" || targetUser.last_workflow_view === "tv" || targetUser.last_workflow_view === "link" ? targetUser.last_workflow_view : null,
          impersonated: true,
          adminId: session.userId,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Server-side "Back to Admin" — swaps the current impersonated session for
    // a fresh admin session using the adminId captured when impersonation was
    // minted. No client-side backup of admin tokens is required.
    if (action === "back_to_admin") {
      const token = req.headers.get("x-session-token");
      if (!token) throw new Error("Authentication required");
      // Accept expired tokens too: back_to_admin is a recovery path — an admin
      // viewing a user account must be able to return to admin even if the
      // impersonated access/refresh window lapsed while they were reviewing.
      const session = (await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING))
        || (await verifySessionTokenDualAllowExpired(token, SIGNING_SECRET, LEGACY_SIGNING));
      if (!session) throw new Error("Session expired or invalid");
      const tokenHash = await sha256Hex(token);
      const { data: currentRow } = await supabase
        .from("app_sessions")
        .select("id, user_id, role, parent_session_id, binding_hash, refresh_expires_at, revoked_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      // Do NOT throw "Session revoked" here. If the row is gone/rotated/revoked
      // we still try to recover as long as the token payload proves this was
      // an impersonated session and the parent admin still exists.
      if (currentRow?.binding_hash) {
        const current = await computeBindingHash(req);
        if (current !== currentRow.binding_hash) {
          supabase.from("security_events").insert({
            type: "back_to_admin_binding_mismatch",
            severity: "medium",
            uid: session.adminId || currentRow.user_id,
            ip,
            ua: req.headers.get("user-agent") || null,
            meta: { session_id: currentRow.id, action: "allowed_recovery" },
          }).then(() => {});
        }
      }
      if (currentRow?.parent_session_id && !session.adminId) {
        const { data: parent } = await supabase
          .from("app_sessions")
          .select("user_id, role, revoked_at")
          .eq("id", currentRow.parent_session_id)
          .maybeSingle();
        if (parent?.role === "admin" && !parent.revoked_at) {
          session.impersonated = true;
          session.adminId = parent.user_id;
        }
      }
      if (session.impersonated !== true || !session.adminId) {
        throw new Error("Not an impersonated session");
      }
      const { data: adminUser, error: adminErr } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", session.adminId)
        .single();
      if (adminErr || !adminUser || adminUser.role !== "admin") {
        throw new Error("Original admin account is no longer available");
      }

      // Revoke the current impersonated session row (may already be gone).
      if (currentRow?.id) {
        try { await supabase.from("app_sessions").delete().eq("id", currentRow.id); } catch {}
      }

      const normalizedAssignedAccounts = await normalizeAssignedAccounts(supabase, adminUser.assigned_accounts);
      const pair = await mintSessionPair(adminUser.id, "admin", {
        userId: adminUser.id,
        username: adminUser.username,
        role: "admin",
        assignedAccounts: normalizedAssignedAccounts,
      });
      const workerUrls = await loadWorkerUrls(supabase);
      await auditLog(supabase, "impersonate_return", adminUser.id, session.userId, {}, ip);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
        sessionFamilyId: pair.familyId,
        workerUrls,
        user: {
          id: adminUser.id,
          username: adminUser.username,
          name: adminUser.name,
          role: adminUser.role,
          mustChangePassword: adminUser.must_change_password,
          assignedAccounts: normalizedAssignedAccounts,
          profilePrefs: publicProfilePrefs(adminUser.profile_prefs),
          profileAvatar: adminUser.profile_prefs?.avatarId || null,
          locationRequired: isProfileLocationRequired(adminUser, await loadGlobalLocationRequired(supabase)),
          lastWorkflowView: adminUser.last_workflow_view === "gmail" || adminUser.last_workflow_view === "tv" || adminUser.last_workflow_view === "link" ? adminUser.last_workflow_view : null,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    // C.2: refresh access token — rotates refresh token, detects reuse.
    // Body: { refreshToken: string }
    if (action === "refresh_session") {
      const { refreshToken } = params;
      if (!refreshToken || typeof refreshToken !== "string") throw new Error("refreshToken required");
      const refreshHash = await sha256Hex(refreshToken);
      const { data: row } = await supabase
        .from("app_sessions")
        .select("id, user_id, role, family_id, refresh_expires_at, revoked_at, revoked_reason, binding_hash, parent_session_id")
        .eq("refresh_token_hash", refreshHash)
        .maybeSingle();
      if (!row) throw new Error("Invalid refresh token");

      // REUSE DETECTION: presenting an already-rotated refresh token means
      // either the legitimate user's browser is racing (rare) or an attacker
      // stole a refresh token and is trying to use it after we rotated it.
      // Kill the entire session family and alert.
      if (row.revoked_at) {
        const benignRotationRetry = /^rotated/i.test(String(row.revoked_reason || ""))
          && Date.now() - new Date(row.revoked_at).getTime() < 2 * 60 * 1000;
        if (benignRotationRetry) {
          console.warn("[refresh] recovering from repeated rotated refresh token for family", row.family_id);
        } else {
        await supabase.from("app_sessions").update({
          revoked_at: new Date().toISOString(),
          revoked_reason: "refresh_reuse_family_kill",
        }).eq("family_id", row.family_id).is("revoked_at", null);
        await supabase.from("app_sessions").delete().eq("family_id", row.family_id);

        supabase.from("security_events").insert({
          type: "refresh_token_reuse",
          severity: "critical",
          uid: row.user_id,
          ip,
          ua: req.headers.get("user-agent") || null,
          meta: { family_id: row.family_id, original_reason: row.revoked_reason },
        }).then(() => {});

        // Telegram alert — fire-and-forget so we don't block the response
        // that's about to throw "Session family revoked".
        try {
          const tg = await getTelegramConfig(supabase);
          if (tg) {
            const text = [
              `🚨 <b>Refresh-token reuse detected</b>`,
              `<b>User ID:</b> <code>${row.user_id}</code>`,
              `<b>IP:</b> <code>${ip}</code>`,
              `<b>Family:</b> <code>${row.family_id}</code>`,
              `<i>All sessions in this family have been revoked.</i>`,
            ].join("\n");
            postTelegramBg(tg, { text });
          }
        } catch {}

        throw new Error("Session family revoked. Please sign in again.");
        }
      }

      if (!row.refresh_expires_at || new Date(row.refresh_expires_at).getTime() < Date.now()) {
        await supabase.from("app_sessions").delete().eq("id", row.id);
        throw new Error("Refresh token expired. Please sign in again.");
      }

      // Device binding still enforced on refresh
      if (row.binding_hash) {
        const current = await computeBindingHash(req);
        if (current !== row.binding_hash) {
          supabase.from("security_events").insert({
            type: "refresh_binding_mismatch",
            severity: "medium",
            uid: row.user_id,
            ip,
            ua: req.headers.get("user-agent") || null,
            meta: { family_id: row.family_id, action: "allowed_soft_binding" },
          }).then(() => {});
        }
      }

      // Load current user data so JWT stays fresh (role changes propagate on refresh)
      const { data: user, error: uerr } = await supabase.from("app_users").select("*").eq("id", row.user_id).single();
      if (uerr || !user) throw new Error("User not found");

      const normalizedAssignedAccounts = await normalizeAssignedAccounts(supabase, user.assigned_accounts);
      let parentAdminId: string | null = null;
      if (row.role !== "admin") {
        if (row.parent_session_id) {
          const { data: parent } = await supabase
            .from("app_sessions")
            .select("user_id, role, revoked_at")
            .eq("id", row.parent_session_id)
            .maybeSingle();
          if (parent?.role === "admin" && !parent.revoked_at) parentAdminId = parent.user_id;
        }
        if (!parentAdminId) {
          const accessToken = req.headers.get("x-session-token") || "";
          const accessPayload = accessToken
            ? await verifySessionTokenDualAllowExpired(accessToken, SIGNING_SECRET, LEGACY_SIGNING)
            : null;
          if (accessPayload?.impersonated === true && typeof accessPayload.adminId === "string") {
            parentAdminId = accessPayload.adminId;
          }
        }
      }
      // Mint new pair inside the same family, linked to parent row
      const pair = await mintSessionPair(user.id, row.role, {
        userId: user.id,
        username: user.username,
        role: row.role,
        assignedAccounts: normalizedAssignedAccounts,
        ...(parentAdminId ? { impersonated: true, adminId: parentAdminId } : {}),
      }, {
        familyId: row.family_id,
        parentSessionId: parentAdminId ? (row.parent_session_id || null) : null,
        ttlOverrideMs: parentAdminId ? IMPERSONATION_SESSION_TTL_MS : undefined,
      });

      // Mark old row revoked (kept in DB briefly for reuse detection; expires_at cleanup will remove it)
      await supabase.from("app_sessions").update({
        revoked_at: new Date().toISOString(),
        revoked_reason: "rotated",
      }).eq("id", row.id);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
        sessionFamilyId: pair.familyId,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    }



    // Decrypt IMAP passwords (internal use for fetch-emails)
    if (action === "get_decrypted_accounts") {
      // Only allow from internal edge functions (check for service role key in auth header)
      const authHeader = req.headers.get("authorization") || "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      if (!authHeader.includes(serviceKey)) throw new Error("Unauthorized");

      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "email_accounts")
        .single();

      if (!data?.value || !Array.isArray(data.value)) {
        return new Response(JSON.stringify({ success: true, accounts: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const decrypted = await Promise.all(data.value.map(async (acc: any) => ({
        ...acc,
        password: acc.password ? await decryptValue(acc.password, ENCRYPTION_SECRET) : "",
      })));

      return new Response(JSON.stringify({ success: true, accounts: decrypted }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_session") {
      const token = params.token || req.headers.get("x-session-token");
      if (!token) throw new Error("No token provided");
      const session = await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING);
      if (!session) throw new Error("Invalid or expired session");
      return new Response(JSON.stringify({ success: true, session }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Hydrate the logged-in user from the DB. Used on page load / refresh so
    // localStorage cannot be trusted for who the user is or their role.
    if (action === "me") {
      const session = await requireSession(req);
      const { data: user, error } = await supabase
        .from("app_users")
        .select("id, username, name, role, must_change_password, assigned_accounts, profile_prefs, is_free, expires_at, auto_delete, tv_override, feature_gmail, feature_tv, feature_link, last_workflow_view, plan_starts_at, plan_ends_at, plan_end_notified_at")
        .eq("id", session.userId)
        .single();
      if (error || !user) throw new Error("Account not found");

      // Enforce plan expiry mid-session: if the plan ended after login, revoke.
      if (user.role !== "admin" && !user.is_free && user.plan_ends_at) {
        const endMs = Date.parse(String(user.plan_ends_at));
        if (Number.isFinite(endMs) && endMs <= Date.now()) {
          let contactInfo: any = null;
          try {
            const { data: ci } = await readSettingRow(supabase, "contact_info");
            contactInfo = ci?.value || null;
          } catch {}
          // Instant "Plan expired" TG alert if cron hasn't sent one yet.
          if (!(user as any).plan_end_notified_at) {
            ((globalThis as any).EdgeRuntime?.waitUntil?.(notifyPlanExpiredOnce(supabase, user)) ?? notifyPlanExpiredOnce(supabase, user).catch(() => {}));
          }
          return new Response(JSON.stringify({ success: false, error: "plan_finished", planEndsAt: user.plan_ends_at, contactInfo }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({
        success: true,
        serverNow: new Date().toISOString(),
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: await normalizeAssignedAccounts(supabase, user.assigned_accounts),
          profilePrefs: publicProfilePrefs(user.profile_prefs),
          profileAvatar: user.profile_prefs?.avatarId || null,
          isFree: !!user.is_free,
          expiresAt: user.expires_at || null,
          autoDelete: (user as any).auto_delete !== false,
          locationRequired: isProfileLocationRequired(user, await loadGlobalLocationRequired(supabase)),
          tvOverride: user.tv_override === "on" || user.tv_override === "off" ? user.tv_override : null,
          tvFeatureEnabled: await loadTvFeatureEnabled(supabase),
          features: pickFeatures(user),
          planStartsAt: (user as any).plan_starts_at || null,
          planEndsAt: (user as any).plan_ends_at || null,
          lastWorkflowView: ((): string | null => {
            const v = (user as any).last_workflow_view;
            return v === "gmail" || v === "tv" || v === "link" ? v : null;
          })(),
          impersonated: session.impersonated === true,
          adminId: session.impersonated === true ? (session.adminId || null) : null,
        },

      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "set_workflow_view") {
      const session = await requireSession(req);
      const raw = String((params || {}).view || "").toLowerCase();
      if (raw !== "gmail" && raw !== "tv" && raw !== "link") {
        throw new Error("Invalid workflow view");
      }
      // Verify the user actually has that feature enabled before persisting.
      const { data: u } = await supabase
        .from("app_users")
        .select("feature_gmail, feature_tv, feature_link")
        .eq("id", session.userId)
        .maybeSingle();
      const allowed = raw === "gmail" ? (u?.feature_gmail !== false)
        : raw === "tv" ? (u?.feature_tv !== false)
        : (u?.feature_link === true);
      if (!allowed) throw new Error("Workflow not available for this account");
      const { error } = await supabase
        .from("app_users")
        .update({ last_workflow_view: raw })
        .eq("id", session.userId);
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, lastWorkflowView: raw }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "logout") {
      const token = req.headers.get("x-session-token");
      if (token) {
        const tokenHash = await sha256Hex(token);
        await supabase.from("app_sessions").delete().eq("token_hash", tokenHash);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Instant Inbox: delta sync (list-only, no HTML) ----------
    if (action === "list_delta") {
      const session = await requireSession(req);
      const { since, limit, baseline } = (params || {}) as { since?: number; limit?: number; baseline?: boolean };
      const cursor = Math.max(0, Number(since) || 0);
      const cap = Math.min(Math.max(Number(limit) || 500, 1), 1000);
      const baselineMode = baseline === true || cursor <= 0;

      const { data: u, error: uErr } = await supabase
        .from("app_users")
        .select("assigned_accounts, role, is_free, feature_gmail")
        .eq("id", session.userId)
        .single();
      if (uErr || !u) throw new Error("User not found");
      if (u.role !== "admin" && u.feature_gmail === false) {
        return new Response(JSON.stringify({ success: true, emails: [], deleted_ids: [], next_since: cursor, feature_disabled: "gmail" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const isAdmin = u.role === "admin";
      const labels: string[] | null = Array.isArray(u.assigned_accounts) && u.assigned_accounts.length > 0
        ? ((await normalizeAssignedAccounts(supabase, u.assigned_accounts)) || [])
        : (isAdmin ? null : []);
      const recipientFiltersByLabel = isAdmin ? new Map<string, string[]>() : await loadRecipientFiltersByLabel(supabase);

      if (labels && labels.length === 0) {
        return new Response(JSON.stringify({ success: true, rows: [], removedIds: [], newCursor: cursor, hasMore: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let visibilityFilters: EmailVisibilityFilters = DEFAULT_EMAIL_FILTERS;
      if (!isAdmin) {
        try {
          const { data: filterRow } = await readSettingRow(supabase, "email_filters");
          visibilityFilters = normalizeEmailFilters(filterRow?.value);
        } catch {}
      }

      let dateCutoff: string | null = null;
      if (!isAdmin) {
        const { data: visRow } = await readSettingRow(supabase, "email_visibility");
        const vis = (visRow?.value || {}) as { enabled?: boolean; days?: number };
        if (vis?.enabled && Number(vis.days) > 0) {
          const cut = new Date();
          cut.setDate(cut.getDate() - Number(vis.days));
          dateCutoff = cut.toISOString();
        }
      }

      let q = supabase
        .from("cached_emails")
        .select("id, subject, from_address, to_address, date, otp, preview, account_label, modseq, destroyed")
        .limit(baselineMode && !isAdmin ? Math.min(cap * 5, 1000) : cap);
      if (baselineMode) {
        q = q.eq("destroyed", false).order("date", { ascending: false });
      } else {
        q = q.gt("modseq", cursor).order("modseq", { ascending: true });
      }
      if (labels && labels.length > 0) q = q.in("account_label", labels);
      if (dateCutoff) q = q.gte("date", dateCutoff);

      const { data, error } = await q;
      if (error) throw error;

      const rows: any[] = [];
      const removedIds: string[] = [];
      let maxModseq = cursor;
      for (const r of (data || [])) {
        if (Number(r.modseq) > maxModseq) maxModseq = Number(r.modseq);
        if (r.destroyed) {
          removedIds.push(r.id);
        } else if ((isAdmin || recipientMatches(r.to_address, recipientFiltersByLabel.get(String(r.account_label || "").trim()))) && (isAdmin || shouldExposeEmailToUser(r, visibilityFilters, !!u.is_free))) {
          rows.push({
            id: r.id,
            subject: r.subject,
            from: r.from_address,
            to: r.to_address,
            date: r.date,
            otp: r.otp,
            preview: r.preview,
            account_label: r.account_label,
            modseq: Number(r.modseq),
          });
          if (baselineMode && rows.length >= cap) break;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        rows,
        removedIds,
        newCursor: maxModseq,
        hasMore: !baselineMode && (data?.length || 0) >= cap,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- Instant Inbox: lazy full-HTML fetch ----------
    if (action === "get_email_html") {
      const session = await requireSession(req);
      const { id } = (params || {}) as { id?: string };
      if (!id || typeof id !== "string") throw new Error("id required");

      const { data: u } = await supabase
        .from("app_users").select("assigned_accounts, role, is_free").eq("id", session.userId).single();
      const isAdmin = u?.role === "admin";
      const labels: string[] | null = Array.isArray(u?.assigned_accounts) && u.assigned_accounts.length > 0
        ? ((await normalizeAssignedAccounts(supabase, u.assigned_accounts)) || [])
        : (isAdmin ? null : []);
      const recipientFiltersByLabel = isAdmin ? new Map<string, string[]>() : await loadRecipientFiltersByLabel(supabase);
      let visibilityFilters: EmailVisibilityFilters = DEFAULT_EMAIL_FILTERS;
      if (!isAdmin) {
        try {
          const { data: filterRow } = await readSettingRow(supabase, "email_filters");
          visibilityFilters = normalizeEmailFilters(filterRow?.value);
        } catch {}
      }

      const { data: row, error } = await supabase
        .from("cached_emails")
        .select("id, subject, preview, otp, html, account_label, to_address, destroyed")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!row || row.destroyed) throw new Error("Email not found");
      if (labels && labels.length > 0 && !labels.includes(row.account_label || "")) {
        throw new Error("Not authorized");
      }
      if (labels && labels.length === 0 && !isAdmin) throw new Error("Not authorized");
      if (!isAdmin && !recipientMatches((row as any).to_address, recipientFiltersByLabel.get(String(row.account_label || "").trim()))) throw new Error("Not authorized");
      if (!isAdmin && !shouldExposeEmailToUser(row, visibilityFilters, !!u?.is_free)) throw new Error("Email not found");

      // Include account_label so the Cloudflare worker cache can enforce
      // per-user authz on cache hits without a round-trip.
      return new Response(JSON.stringify({ success: true, id: row.id, html: row.html || "", account_label: row.account_label || "" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- User: clear own inbox (hide-only) ----------

    if (action === "clear_user_inbox") {
      // Fully disabled. Users must never delete or hide emails — admin-only.
      await requireSession(req);
      return new Response(JSON.stringify({ success: false, error: "User email deletion is disabled" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Admin: suppress inbox rows globally ----------
    if (action === "admin_clear_inbox") {
      const session = await requireAdmin(req);
      const { mode, accountLabel, days, confirm } = params as any;
      let q = supabase.from("cached_emails").update({ destroyed: true, html: null, preview: null, otp: null, cached_at: new Date().toISOString() });
      let details: any = { mode };
      if (mode === "all") {
        if (confirm !== "DELETE ALL") throw new Error("Confirmation phrase required");
        q = q.neq("id", "__nonexistent__");
      } else if (mode === "label") {
        if (!accountLabel) throw new Error("accountLabel required");
        q = q.eq("account_label", accountLabel);
        details.accountLabel = accountLabel;
      } else if (mode === "days") {
        const n = Number(days);
        if (!Number.isFinite(n) || n < 0) throw new Error("Valid days required");
        const cutoff = new Date(Date.now() - n * 86400_000).toISOString();
        q = q.lt("date", cutoff);
        details.days = n;
      } else {
        throw new Error("Invalid mode");
      }
      q = q.eq("destroyed", false);
      const { error } = await q;
      if (error) throw error;
      details.completed = true;
      await auditLog(supabase, "admin_clear_inbox", session.userId, null, details, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Notifications: user side ----------
    if (action === "list_notifications") {
      const session = await requireSession(req);
      const nowIso = new Date().toISOString();
      const clientEtag = typeof (params as any)?.if_etag === "string" ? (params as any).if_etag : null;

      // ---- Etag pre-check (~2 tiny aggregate queries, no row payload) ----
      // If the aggregate signature matches the client-sent etag, we return
      // `{success:true, unchanged:true, etag}` — response body ~80 bytes vs
      // ~6 KB for the full list. This is the primary egress lever.
      const [aggN, aggR] = clientEtag ? await Promise.all([
        supabase
          .from("notifications")
          .select("id, created_at, updated_at, sort_order, expires_at, publish_at")
          .or(`audience.eq.all,target_user_id.eq.${assertUuid(session.userId, "session user")}`),
        supabase
          .from("notification_reads")
          .select("read_at, seen_at, deleted_at, snoozed_until, dismissed_at, archived_at")
          .eq("user_id", session.userId),
      ]) : [{ data: null, error: null }, { data: null, error: null }];
      let etagStr: string | null = null;
      if (clientEtag && !aggN.error && !aggR.error) {
        let cn = 0;
        let mxN = 0;
        for (const n of aggN.data || []) {
          if (n.expires_at && n.expires_at <= nowIso) continue;
          if (n.publish_at && n.publish_at > nowIso) continue;
          cn++;
          const t = Math.max(
            n.created_at ? new Date(n.created_at).getTime() : 0,
            (n as any).updated_at ? new Date((n as any).updated_at).getTime() : 0,
            typeof (n as any).sort_order === "number" ? (n as any).sort_order : 0,
          );
          if (t > mxN) mxN = t;
        }
        let mxR = 0;
        for (const r of aggR.data || []) {
          for (const k of ["read_at", "seen_at", "deleted_at", "snoozed_until", "dismissed_at", "archived_at"]) {
            const v = (r as any)[k];
            const t = v ? new Date(v).getTime() : 0;
            if (t > mxR) mxR = t;
          }
        }
        etagStr = `${cn}:${mxN}:${mxR}`;
        if (clientEtag && clientEtag === etagStr) {
          return new Response(JSON.stringify({ success: true, unchanged: true, etag: etagStr }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const { data: notes, error: nErr } = await supabase
        .from("notifications")
        .select("id, title, body, description, body_markdown, image_url, category, icon, platform_icon, kind, sub_kind, locked, show_frequency, mode, action_url, action_label, action2_url, action2_label, audience, target_user_id, created_at, updated_at, sort_order, expires_at, publish_at, group_key")
        .or(`audience.eq.all,target_user_id.eq.${assertUuid(session.userId, "session user")}`)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(100);
      if (nErr) throw nErr;
      const active = (notes || []).filter((n: any) => {
        if (n.expires_at && n.expires_at <= nowIso) return false;
        if (n.publish_at && n.publish_at > nowIso) return false;
        return true;
      });
      const ids = active.map((n: any) => n.id);
      const readSet = new Set<string>();
      const seenSet = new Set<string>();
      const snoozeMap = new Map<string, string>();
      if (ids.length) {
        const { data: reads } = await supabase
          .from("notification_reads")
          .select("notification_id, read_at, seen_at, deleted_at, snoozed_until")
          .in("notification_id", ids)
          .eq("user_id", session.userId);
        for (const r of reads || []) {
          if (r.read_at) readSet.add(r.notification_id);
          if (r.seen_at) seenSet.add(r.notification_id);
          if (r.snoozed_until) snoozeMap.set(r.notification_id, r.snoozed_until);
        }
      }
      // Legacy user-delete rows are history only. Active global notifications
      // remain visible according to audience, publish time and expiry.
      const payload = active.map((n: any) => ({
          id: n.id, title: n.title, body: n.body,
          description: n.description, body_markdown: n.body_markdown, image_url: n.image_url,
          category: n.category, icon: n.icon,
          sort_order: n.sort_order ?? null, updated_at: n.updated_at || null,
          platform_icon: n.platform_icon, kind: n.kind, sub_kind: n.sub_kind,
          locked: !!n.locked, show_frequency: n.show_frequency, mode: n.mode,
          action_url: n.action_url, action_label: n.action_label,
          action2_url: n.action2_url, action2_label: n.action2_label,
          audience: n.audience,
          created_at: n.created_at, expires_at: n.expires_at, publish_at: n.publish_at,
          read: readSet.has(n.id),
          seen: seenSet.has(n.id),
          snoozed_until: snoozeMap.get(n.id) || null,
        }));
      return new Response(JSON.stringify({ success: true, notifications: payload, etag: etagStr }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }



    if (action === "mark_notification_read") {
      const session = await requireSession(req);
      const { notification_id } = params as { notification_id?: string };
      assertUuid(notification_id, "notification_id");
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("notification_reads").upsert(
        { notification_id, user_id: session.userId, read_at: nowIso, seen_at: nowIso },
        { onConflict: "notification_id,user_id" },
      );
      if (error) throw error;
      await supabase.from("notification_events").insert({
        notification_id, user_id: session.userId, event: "read",
      });
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "mark_notifications_seen") {
      const session = await requireSession(req);
      const { ids } = params as { ids?: string[] };
      if (!Array.isArray(ids) || !ids.length) {
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const nowIso = new Date().toISOString();
      for (const id of ids.slice(0, 200)) assertUuid(id, "notification id");
      const rows = ids.slice(0, 200).map((id: string) => ({ notification_id: id, user_id: session.userId, seen_at: nowIso }));
      const { error } = await supabase.from("notification_reads").upsert(rows, { onConflict: "notification_id,user_id" });
      if (error) throw error;
      const eventRows = ids.slice(0, 200).map((id: string) => ({ notification_id: id, user_id: session.userId, event: "seen" }));
      await supabase.from("notification_events").insert(eventRows);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "mark_all_notifications_read") {
      const session = await requireSession(req);
      const nowIso = new Date().toISOString();
      const { data: notes } = await supabase
        .from("notifications")
        .select("id, expires_at")
        .or(`audience.eq.all,target_user_id.eq.${assertUuid(session.userId, "session user")}`);
      const ids = (notes || []).filter((n: any) => !n.expires_at || n.expires_at > nowIso).map((n: any) => n.id);
      if (ids.length) {
        const rows = ids.map((id: string) => ({ notification_id: id, user_id: session.userId, read_at: nowIso, seen_at: nowIso }));
        const { error } = await supabase.from("notification_reads").upsert(rows, { onConflict: "notification_id,user_id" });
        if (error) throw error;
      }
      return new Response(JSON.stringify({ success: true, count: ids.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // snooze_notification removed — Snooze is no longer a supported user action.


    if (action === "user_delete_notification") {
      const session = await requireSession(req);
      const { notification_id } = params as { notification_id?: string };
      assertUuid(notification_id, "notification_id");
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("notification_reads").upsert(
        { notification_id, user_id: session.userId, deleted_at: nowIso, seen_at: nowIso },
        { onConflict: "notification_id,user_id" },
      );
      if (error) throw error;
      await supabase.from("notification_events").insert({ notification_id, user_id: session.userId, event: "dismissed", meta: { deleted: true } });
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    if (action === "log_notification_event") {
      const session = await requireSession(req);
      const { notification_id, event, meta } = params as { notification_id?: string; event?: string; meta?: any };
      assertUuid(notification_id, "notification_id");
      if (!event) throw new Error("event required");
      const allowed = ["delivered", "seen", "read", "clicked", "dismissed"];
      if (!allowed.includes(event)) throw new Error("invalid event");
      await supabase.from("notification_events").insert({ notification_id, user_id: session.userId, event, meta: meta || null });
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- Notifications: admin side ----------
    if (action === "admin_create_notification") {
      const session = await requireAdmin(req);
      const p = params as any;
      if (!p?.title || !p?.body) throw new Error("Title and body required");
      const audience = p.audience || "all";
      if (!["all", "user"].includes(audience)) throw new Error("Invalid audience");
      if (audience === "user" && !p.target_user_id) throw new Error("target_user_id required for user audience");
      const category = ["announcement","update","security","maintenance","promo","billing"].includes(p.category) ? p.category : "announcement";
      const kind = "flash";
      const mode = ["popup","silent","banner"].includes(p.mode) ? p.mode : "popup";
      const show_frequency = p.show_frequency === "once" ? "once" : "session";
      const sort_order = p.sort_order === null || p.sort_order === undefined || p.sort_order === ""
        ? null
        : Math.max(0, Math.min(9999, Number(p.sort_order) || 0));
      const platform_icon = p.platform_icon ? String(p.platform_icon).slice(0, 40) : null;
      const expires_at = p.expiresInDays && Number(p.expiresInDays) > 0
        ? new Date(Date.now() + Number(p.expiresInDays) * 86400_000).toISOString()
        : null;
      const publish_at = p.publish_at ? new Date(p.publish_at).toISOString() : null;
      const row: Record<string, any> = {
        title: String(p.title).slice(0, 200),
        body: String(p.body).slice(0, 4000),
        description: p.description ? String(p.description).slice(0, 8000) : null,
        body_markdown: null,
        image_url: p.image_url ? String(p.image_url).slice(0, 2048) : null,
        category, kind, mode, show_frequency, platform_icon, sort_order,
        sub_kind: p.sub_kind ? String(p.sub_kind).slice(0, 40) : null,
        locked: !!p.locked,
        icon: p.icon ? String(p.icon).slice(0, 64) : null,
        action_url: p.action_url ? String(p.action_url).slice(0, 2048) : null,
        action_label: p.action_label ? String(p.action_label).slice(0, 80) : null,
        action2_url: p.action2_url ? String(p.action2_url).slice(0, 2048) : null,
        action2_label: p.action2_label ? String(p.action2_label).slice(0, 80) : null,
        
        audience,
        target_user_id: audience === "user" ? p.target_user_id : null,
        created_by: session.userId,
        expires_at,
        publish_at,
        dedupe_key: p.dedupe_key ? String(p.dedupe_key).slice(0, 200) : null,
        group_key: p.group_key ? String(p.group_key).slice(0, 200) : null,
      };

      const { data, error } = await supabase.from("notifications").insert(row).select("id").single();
      if (error) throw error;
      await auditLog(supabase, "notification_created", session.userId, data?.id || null, { audience, target_user_id: p.target_user_id, category }, ip);
      return new Response(JSON.stringify({ success: true, id: data?.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_list_notifications") {
      await requireAdmin(req);
      const notesP = supabase
        .from("notifications")
        .select("id, title, body, description, image_url, category, icon, platform_icon, kind, sub_kind, locked, show_frequency, mode, action_url, action_label, action2_url, action2_label, audience, target_user_id, created_at, updated_at, sort_order, expires_at, publish_at, group_key, pinned")
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(200);
      const totalUsersP = supabase.from("app_users").select("id", { count: "planned", head: true }).neq("role", "admin");
      const [{ data: notes, error }, { count: totalUsers }] = await Promise.all([notesP, totalUsersP]);
      if (error) throw error;
      const payload = (notes || []).map((n: any) => ({
        ...n,
        readCount: 0,
        seenCount: 0,
        clickCount: 0,
        deletedCount: 0,
        totalRecipients: n.audience === "all" ? (totalUsers || 0) : 1,
      }));
      return new Response(JSON.stringify({ success: true, notifications: payload }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_notification_recipients") {
      await requireAdmin(req);
      const { notification_id } = params as { notification_id?: string };
      assertUuid(notification_id, "notification_id");
      const { data: note, error: nErr } = await supabase
        .from("notifications")
        .select("id, audience, target_user_id")
        .eq("id", notification_id)
        .maybeSingle();
      if (nErr) throw nErr;
      if (!note) throw new Error("Notification not found");

      let usersQ = supabase.from("app_users").select("id, username, name, role, profile_prefs").neq("role", "admin");
      if (note.audience === "user" && note.target_user_id) {
        usersQ = supabase.from("app_users").select("id, username, name, role, profile_prefs").eq("id", note.target_user_id);
      }
      const { data: recipients, error: uErr } = await usersQ;
      if (uErr) throw uErr;

      const userIds = (recipients || []).map((u: any) => u.id);
      const readsMap = new Map<string, any>();
      const clickedMap = new Map<string, string>();
      if (userIds.length) {
        const [readsRes, evsRes] = await Promise.all([
          supabase
            .from("notification_reads")
            .select("user_id, read_at, seen_at, deleted_at")
            .eq("notification_id", notification_id)
            .in("user_id", userIds),
          supabase
            .from("notification_events")
            .select("user_id, event, created_at")
            .eq("notification_id", notification_id)
            .eq("event", "clicked")
            .in("user_id", userIds)
            .order("created_at", { ascending: false }),
        ]);
        const reads = readsRes.data || [];
        const evs = evsRes.data || [];
        for (const r of reads) readsMap.set(r.user_id, r);
        for (const e of evs || []) {
          if (!clickedMap.has(e.user_id)) clickedMap.set(e.user_id, e.created_at);
        }
      }

      const rows = (recipients || []).map((u: any) => {
        const r = readsMap.get(u.id) || {};
        const prefs = u.profile_prefs || {};
        return {
          user_id: u.id,
          username: u.username,
          name: u.name,
          profileAvatar: prefs.avatarId || null,
          seen_at: r.seen_at || null,
          read_at: r.read_at || null,
          deleted_at: r.deleted_at || null,
          clicked_at: clickedMap.get(u.id) || null,
        };
      });
      return new Response(JSON.stringify({ success: true, recipients: rows }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_delete_notification_for_user") {
      const session = await requireAdmin(req);
      const { notification_id, user_id } = params as { notification_id?: string; user_id?: string };
      if (!notification_id || !user_id) throw new Error("notification_id and user_id required");
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("notification_reads").upsert(
        { notification_id, user_id, deleted_at: nowIso, seen_at: nowIso },
        { onConflict: "notification_id,user_id" },
      );
      if (error) throw error;
      await supabase.from("notification_events").insert({
        notification_id, user_id, event: "dismissed", meta: { deleted: true, by_admin: session.userId },
      });
      await auditLog(supabase, "notification_deleted_for_user", session.userId, notification_id, { user_id }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_delete_notification") {
      const session = await requireAdmin(req);
      const { id } = params as { id?: string };
      if (!id) throw new Error("id required");
      const { error } = await supabase.from("notifications").delete().eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "notification_deleted", session.userId, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_update_notification") {
      const session = await requireAdmin(req);
      const p = params as any;
      if (!p?.id) throw new Error("id required");
      const patch: Record<string, any> = {};
      if (typeof p.title === "string") patch.title = p.title.slice(0, 200);
      if (typeof p.body === "string") patch.body = p.body.slice(0, 4000);
      if ("description" in p) patch.description = p.description ? String(p.description).slice(0, 8000) : null;
      if ("image_url" in p) patch.image_url = p.image_url ? String(p.image_url).slice(0, 2048) : null;
      if ("action_url" in p) patch.action_url = p.action_url ? String(p.action_url).slice(0, 2048) : null;
      if ("action_label" in p) patch.action_label = p.action_label ? String(p.action_label).slice(0, 80) : null;
      if ("platform_icon" in p) patch.platform_icon = p.platform_icon ? String(p.platform_icon).slice(0, 40) : null;
      if ("locked" in p) patch.locked = !!p.locked;
      if (p.category && ["announcement","update","security","maintenance","promo","billing"].includes(p.category)) patch.category = p.category;
      if (p.show_frequency) patch.show_frequency = p.show_frequency === "once" ? "once" : "session";
      if ("sort_order" in p) {
        patch.sort_order = p.sort_order === null || p.sort_order === undefined || p.sort_order === ""
          ? null
          : Math.max(0, Math.min(9999, Number(p.sort_order) || 0));
      }
      if (p.mode && ["popup","silent","banner"].includes(p.mode)) patch.mode = p.mode;
      if (p.audience && ["all","user"].includes(p.audience)) patch.audience = p.audience;
      if ("target_user_id" in p) patch.target_user_id = p.target_user_id || null;
      if ("expiresInDays" in p) {
        patch.expires_at = p.expiresInDays && Number(p.expiresInDays) > 0
          ? new Date(Date.now() + Number(p.expiresInDays) * 86400_000).toISOString()
          : null;
      }
      if (Object.keys(patch).length === 0) throw new Error("Nothing to update");
      const { error } = await supabase.from("notifications").update(patch).eq("id", p.id);
      if (error) throw error;
      await auditLog(supabase, "notification_updated", session.userId, p.id, { fields: Object.keys(patch) }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    if (action === "list_login_events") {
      await requireAdmin(req);
      const { limit, user_id, risk, since, search } = params || {};
      let q = supabase
        .from("login_events")
        .select("id, created_at, username, role, event, risk_score, ip, ip_source, isp, asn, city, region, country, country_code, device_brand, device_model, device_type, os_name, os_version, browser_name, browser_version, gps_lat, gps_lon, gps_accuracy, is_vpn, is_proxy, is_tor, is_hosting, is_new_device, impossible_travel, fingerprint_hash")
        .order("created_at", { ascending: false });
      if (user_id) q = q.eq("user_id", user_id);
      if (risk) q = q.eq("risk_score", risk);
      if (since) q = q.gte("created_at", since);
      if (search && typeof search === "string" && search.trim()) {
        const s = search.trim();
        q = q.or(`username.ilike.%${s}%,ip.ilike.%${s}%,city.ilike.%${s}%,country.ilike.%${s}%,isp.ilike.%${s}%`);
      }
      q = q.limit(Math.min(Number(limit) || 150, 300));
      const { data, error } = await q;
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, events: data || [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_list_emails") {
      const session = await requireAdmin(req);
      const { limit, offset, search, accountLabel } = (params || {}) as any;
      const buildFilters = (q: any) => {
        if (accountLabel) q = q.eq("account_label", accountLabel);
        if (search && typeof search === "string" && search.trim()) {
          const s = search.trim().replace(/[%,]/g, "");
          q = q.or(`subject.ilike.%${s}%,from_address.ilike.%${s}%,to_address.ilike.%${s}%,preview.ilike.%${s}%,otp.ilike.%${s}%`);
        }
        return q;
      };
      const lim = Math.min(Number(limit) || 100, 500);
      const off = Math.max(Number(offset) || 0, 0);
      // Rows page only. Fetch one extra row to answer "has next page" without
      // a count query; exact counts were one of the biggest cached_emails IO drains.
      let dataQ = supabase
        .from("cached_emails")
        .select("id, subject, from_address, to_address, date, otp, preview, account_label, cached_at")
        .eq("destroyed", false)
        .order("date", { ascending: false });
      dataQ = buildFilters(dataQ).range(off, off + lim);
      const { data, error } = await dataQ;
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const hasMore = rows.length > lim;
      const page = hasMore ? rows.slice(0, lim) : rows;
      const approximateTotal = off + page.length + (hasMore ? 1 : 0);
      return new Response(JSON.stringify({ success: true, emails: page, total: approximateTotal, hasMore }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_get_email") {
      await requireAdmin(req);
      const { id } = (params || {}) as any;
      if (!id) throw new Error("id required");
      const { data, error } = await supabase.from("cached_emails").select("*").eq("id", id).eq("destroyed", false).maybeSingle();
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, email: data || null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_delete_emails") {
      const session = await requireAdmin(req);
      const { ids } = (params || {}) as any;
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids required");
      const clean = ids.filter((x: any) => typeof x === "string").slice(0, 500);
      const { error } = await supabase
        .from("cached_emails")
        .update({ destroyed: true, html: null, preview: null, otp: null, cached_at: new Date().toISOString() })
        .in("id", clean)
        .eq("destroyed", false);
      if (error) throw error;
      await auditLog(supabase, "admin_delete_emails", session.userId, null, { ids: clean, requested: clean.length }, ip);
      return new Response(JSON.stringify({ success: true, deleted: clean.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Email visibility window (users) ----------
    if (action === "email_visibility_set") {
      const session = await requireAdmin(req);
      const { enabled, days } = (params || {}) as any;
      const clean = {
        enabled: enabled === true,
        days: Math.max(1, Math.min(365, Number(days) || 30)),
      };
      const { error } = await supabase.from("app_settings").upsert({ key: "email_visibility", value: clean }, { onConflict: "key" });
      invalidateAllSettings();
      if (error) throw error;
      await auditLog(supabase, "email_visibility_set", session.userId, null, clean, ip);
      return new Response(JSON.stringify({ success: true, value: clean }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- Email auto-delete cron ----------
    if (action === "email_cleanup_apply") {
      const session = await requireAdmin(req);
      const { enabled, days, hour } = (params || {}) as any;
      const clean = {
        enabled: enabled === true,
        days: Math.max(1, Math.min(365, Number(days) || 30)),
        hour: Math.max(0, Math.min(23, Number(hour) || 3)),
      };
      try {
        if (clean.enabled) {
          const { error } = await supabase.rpc("schedule_email_cleanup", { days: clean.days, hour: clean.hour });
          if (error) throw error;
        } else {
          const { error } = await supabase.rpc("unschedule_email_cleanup");
          if (error) throw error;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ success: false, error: msg }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await supabase.from("app_settings").upsert({ key: "email_auto_delete", value: clean }, { onConflict: "key" });
      invalidateAllSettings();
      await auditLog(supabase, "email_cleanup_apply", session.userId, null, clean, ip);
      return new Response(JSON.stringify({ success: true, value: clean }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "email_cleanup_status") {
      await requireAdmin(req);
      const { data, error } = await supabase.rpc("get_email_cleanup_status");
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, status: data }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // (Maintenance bypass endpoint intentionally removed — admins see the
    // same maintenance screen as everyone else. /admin* routes remain
    // reachable during maintenance so admins can still sign in.)



    // ---------- Admin dashboard: ONE composite call (replaces 12 client calls) ----------
    // Bulk: full mount payload. `refresh` variant skips rarely-changing settings.

    if (action === "admin_dashboard_bootstrap" || action === "admin_dashboard_refresh") {
      const session = await requireAdmin(req);
      const includeSettings = action === "admin_dashboard_bootstrap";

      // Kick everything off in PARALLEL server-side. Edge → Postgres latency is
      // ~1-5ms each, so 12 parallel queries return in ~50-150ms total.
      const usersP = supabase.from("app_users")
        .select("id, username, name, role, assigned_accounts, profile_prefs, session_limit, is_free, pinned, sort_order, expires_at, tv_override, feature_gmail, feature_tv, feature_link, plan_starts_at, plan_ends_at")
        .order("created_at", { ascending: true });

      // Fast estimated counts via pg_class.reltuples — head:true+exact was
      // triggering full index-only scans on every admin mount. `planned`
      // returns the planner estimate (updated by autovacuum) with 0 IO.
      const emailsCountP = supabase.from("cached_emails").select("id", { count: "planned", head: true }).eq("destroyed", false);

      const notesP = supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(200);
      const totalUsersP = supabase.from("app_users").select("id", { count: "planned", head: true }).neq("role", "admin");

      const settingsKeys = includeSettings
        ? ["recaptcha", "config", "primary_cloudflare_urls", "email_filters", "email_accounts", "session_config", "admin_session_config", "session_limits", "maintenance", "r2_storage", "vps_config", "email_visibility", "email_auto_delete", "cron_config", "netflix_promo", "location_policy", "free_session_minutes", "free_avatar_cooldown", "tv_feature"]
        : ["email_accounts", "location_policy"];

      const settingsP = supabase.from("app_settings").select("key,value").in("key", settingsKeys);
      const cookiesP = includeSettings
        ? supabase.from("imap_cookies").select("id, imap_user, label, filename, format, count, updated_at").order("updated_at", { ascending: false })
        : Promise.resolve({ data: [] as any[] });
      const loginEventsP = includeSettings
        ? supabase.from("login_events")
            .select("id, created_at, username, role, event, risk_score, ip, ip_source, isp, asn, city, region, country, country_code, device_brand, device_model, device_type, os_name, os_version, browser_name, browser_version, gps_lat, gps_lon, gps_accuracy, is_vpn, is_proxy, is_tor, is_hosting, is_new_device, impossible_travel, fingerprint_hash")
            .order("created_at", { ascending: false })
            .limit(150)
        : Promise.resolve({ data: [] as any[] });

      const [usersRes, emailsCountRes, notesRes, totalUsersRes, settingsRes, cookiesRes, loginEventsRes] = await Promise.all([usersP, emailsCountP, notesP, totalUsersP, settingsP, cookiesP, loginEventsP]);
      const settingsMapForUsers = new Map((settingsRes.data || []).map((row: any) => [row.key, row.value]));
      const globalLocationRequired = isGlobalLocationRequired(settingsMapForUsers.get("location_policy"));
      const emailAccountsForLabels = Array.isArray(settingsMapForUsers.get("email_accounts")) ? settingsMapForUsers.get("email_accounts") : [];
      const availableAccountLabelsForList = emailAccountsForLabels.map((acc: any) => String(acc?.label || acc?.user || "").trim()).filter(Boolean);

      // Users mapping
      const users = (usersRes.data || []).map((u: any) => ({
        ...u,
        assignedAccounts: normalizeAccountLabels(u.assigned_accounts || [], availableAccountLabelsForList).length > 0 ? normalizeAccountLabels(u.assigned_accounts || [], availableAccountLabelsForList) : null,
        profileAvatar: u.profile_prefs?.avatarId || null,
        profilePrefs: publicProfilePrefs(u.profile_prefs),
        locationRequired: isProfileLocationRequired(u, globalLocationRequired),
        isFree: !!u.is_free,
        pinned: !!u.pinned,
        sortOrder: u.sort_order ?? null,
        expiresAt: u.expires_at || null,
        tvOverride: u.tv_override === "on" || u.tv_override === "off" ? u.tv_override : null,
        features: pickFeatures(u),
        planStartsAt: u.plan_starts_at || null,
        planEndsAt: u.plan_ends_at || null,
      }));

      const totalUsers = totalUsersRes.count || 0;
      const notifications = (notesRes.data || []).map((n: any) => ({
        ...n,
        readCount: 0,
        seenCount: 0,
        clickCount: 0,
        deletedCount: 0,
        totalRecipients: n.audience === "all" ? totalUsers : 1,
      }));

      // Settings map + R2 normalization
      const settings: Record<string, any> = {};
      let r2: any = null;
      let vpsAccess: any = null;
      for (const row of (settingsRes as any).data || []) {
        if (row.key === "r2_storage") {
          const normalized = normalizeR2Config(row.value || {});
          const hasSecret = typeof normalized.config.secretAccessKey === "string" && normalized.config.secretAccessKey.length > 0;
          r2 = {
            accountId: normalized.config.accountId,
            accessKeyId: normalized.config.accessKeyId,
            secretAccessKey: "",
            bucket: normalized.config.bucket,
            publicBaseUrl: normalized.config.publicBaseUrl,
            pathPrefix: normalized.config.pathPrefix,
            enabled: normalized.config.enabled,
            secretAccessKeySet: hasSecret,
          };
        } else if (row.key === "vps_config") {
          vpsAccess = publicVpsConfig(row.value || {});
        } else {
          const safeValue = await ensureSettingsSecretsEncrypted(supabase, row.key, row.value, ENCRYPTION_SECRET);
          if (row.key === "config") settings[row.key] = await maskConfigForAdmin(safeValue, ENCRYPTION_SECRET);
          else if (row.key === "email_accounts") settings[row.key] = await maskEmailAccountsForAdmin(safeValue, ENCRYPTION_SECRET);
          else settings[row.key] = safeValue;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        users,
        emailsTotal: emailsCountRes.count || 0,
        notifications,
        cookies: includeSettings ? ((cookiesRes.data || []).map((row: any) => ({ ...row, count: Math.max(Number(row.count) || 0, 0) }))) : undefined,
        loginEvents: includeSettings ? (loginEventsRes.data || []) : undefined,
        settings: includeSettings ? settings : undefined,
        r2: includeSettings ? r2 : undefined,
        vpsAccess: includeSettings ? vpsAccess : undefined,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "private, max-age=15, stale-while-revalidate=60" } });
    }

    // ---------- R2 storage: admin-only ----------

    if (action === "admin_get_r2_config") {
      await requireAdmin(req);
      const { data } = await readSettingRow(supabase, "r2_storage");
      const v: any = data?.value || {};
      const normalized = normalizeR2Config(v);
      const hasSecret = typeof normalized.config.secretAccessKey === "string" && normalized.config.secretAccessKey.length > 0;
      return new Response(JSON.stringify({
        success: true,
        config: {
          accountId: normalized.config.accountId,
          accessKeyId: normalized.config.accessKeyId,
          secretAccessKey: "",
          bucket: normalized.config.bucket,
          publicBaseUrl: normalized.config.publicBaseUrl,
          pathPrefix: normalized.config.pathPrefix,
          enabled: normalized.config.enabled,
          secretAccessKeySet: hasSecret,
        },
        warnings: normalized.warnings,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_save_r2_config") {
      const session = await requireAdmin(req);
      const p = (params || {}) as any;
      const { data: existing } = await readSettingRow(supabase, "r2_storage");
      const prev: any = existing?.value || {};
      const normalized = normalizeR2Config(p, prev.secretAccessKey || "");
      if (normalized.errors.length) throw new Error(normalized.errors.join(" "));
      const value = normalized.config;
      const { error } = await supabase.from("app_settings").upsert({ key: "r2_storage", value }, { onConflict: "key" });
      invalidateAllSettings();
      if (error) throw error;
      await auditLog(supabase, "r2_config_updated", session.userId, null, { bucket: value.bucket, enabled: value.enabled }, ip);
      return new Response(JSON.stringify({
        success: true,
        warnings: normalized.warnings,
        config: {
          accountId: value.accountId,
          accessKeyId: value.accessKeyId,
          secretAccessKey: "",
          bucket: value.bucket,
          publicBaseUrl: value.publicBaseUrl,
          pathPrefix: value.pathPrefix,
          enabled: value.enabled,
          secretAccessKeySet: typeof value.secretAccessKey === "string" && value.secretAccessKey.length > 0,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_r2_test") {
      await requireAdmin(req);
      const { data } = await readSettingRow(supabase, "r2_storage");
      const saved: any = data?.value || {};
      const draft: any = params || {};
      const hasDraftConfig = draft.useSaved !== true && ["accountId", "accessKeyId", "secretAccessKey", "bucket", "publicBaseUrl", "pathPrefix", "enabled"].some((k) => k in draft);
      const source = hasDraftConfig ? { ...saved, ...draft } : saved;
      const normalized = normalizeR2Config(source, saved.secretAccessKey || "");
      const v = normalized.config;
      const missing: string[] = [];
      if (!v.accountId) missing.push("Account ID");
      if (!v.accessKeyId) missing.push("Access Key ID");
      if (!v.secretAccessKey) missing.push("Secret Access Key");
      if (!v.bucket) missing.push("Bucket");
      if (normalized.errors.length) missing.push(...normalized.errors);
      if (missing.length) {
        return new Response(JSON.stringify({ success: false, message: `Enter R2 config first — missing: ${missing.join(", ")}` }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { r2Put, r2Delete } = await import("../_shared/r2Sign.ts");
      const creds = { accountId: v.accountId, accessKeyId: v.accessKeyId, secretAccessKey: v.secretAccessKey, bucket: v.bucket };
      const key = `${v.pathPrefix || "notifications/"}_healthcheck-${Date.now()}.txt`;
      const t0 = Date.now();
      let putOk = false, putErr = "", publicUrlWorks = false, publicUrl = "";
      try {
        const res = await r2Put(creds, key, new TextEncoder().encode("ok"), "text/plain");
        putOk = res.ok;
        if (!res.ok) putErr = r2FailureMessage(res.status, await res.text(), normalized.warnings);
      } catch (e) {
        putErr = e instanceof Error ? e.message : String(e);
      }
      if (putOk && v.publicBaseUrl) {
        publicUrl = `${v.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
        try {
          const h = await fetch(publicUrl, { method: "GET" });
          publicUrlWorks = h.ok;
        } catch {}
      }
      // Clean up the test object.
      try { await r2Delete(creds, key); } catch {}
      return new Response(JSON.stringify({
        success: putOk,
        latencyMs: Date.now() - t0,
        publicUrlWorks,
        publicUrl,
        warnings: normalized.warnings,
        message: putOk ? "R2 upload OK" : putErr || "R2 test failed",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_upload_notification_image") {
      await requireAdmin(req);
      const p = (params || {}) as any;
      if (!p?.dataBase64 || !p?.filename) throw new Error("dataBase64 and filename required");
      const { data } = await readSettingRow(supabase, "r2_storage");
      const v: any = data?.value || {};
      if (!v.enabled) throw new Error("R2 is not enabled — configure it in Settings → Storage");
      const normalized = normalizeR2Config(v);
      if (normalized.errors.length) throw new Error(normalized.errors.join(" "));
      const cfg = normalized.config;
      if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket || !cfg.publicBaseUrl) {
        throw new Error("R2 credentials incomplete");
      }
      const contentType = String(p.contentType || "").slice(0, 100) || "application/octet-stream";
      if (!/^image\//.test(contentType)) throw new Error("Only image uploads are allowed");
      // Decode base64
      const b64 = String(p.dataBase64).replace(/^data:[^;]+;base64,/, "");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.length > 8 * 1024 * 1024) throw new Error("Image too large (max 8 MB)");
      const { r2Put, slugifyFilename } = await import("../_shared/r2Sign.ts");
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const rand = crypto.randomUUID().slice(0, 8);
      const key = `${cfg.pathPrefix || "notifications/"}${yyyy}/${mm}/${rand}-${slugifyFilename(p.filename)}`;
      const creds = { accountId: cfg.accountId, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, bucket: cfg.bucket };
      const res = await r2Put(creds, key, bytes, contentType);
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`R2 upload failed: ${r2FailureMessage(res.status, t, normalized.warnings)}`);
      }
      const url = `${cfg.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
      return new Response(JSON.stringify({ success: true, url, key }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_upload_vps_key") {
      const session = await requireAdmin(req);
      const p = (params || {}) as any;
      if (!p?.dataBase64 || !p?.filename) throw new Error("Private key file required");
      const { data: r2Row } = await readSettingRow(supabase, "r2_storage");
      const r2Value: any = r2Row?.value || {};
      if (!r2Value.enabled) throw new Error("R2 is not enabled — configure it in Settings → Storage first");
      const normalized = normalizeR2Config(r2Value);
      if (normalized.errors.length) throw new Error(normalized.errors.join(" "));
      const cfg = normalized.config;
      if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) throw new Error("R2 credentials incomplete");

      const b64 = String(p.dataBase64).replace(/^data:[^;]+;base64,/, "");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.length < 64) throw new Error("Private key file looks empty");
      if (bytes.length > 64 * 1024) throw new Error("Private key too large (max 64 KB)");
      const keyText = new TextDecoder().decode(bytes).trim();
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(keyText)) throw new Error("Upload a valid private SSH key file");

      const { r2Put, r2Delete, slugifyFilename } = await import("../_shared/r2Sign.ts");
      const creds = { accountId: cfg.accountId, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, bucket: cfg.bucket };
      const objectKey = `vps-vault/${crypto.randomUUID()}-${slugifyFilename(p.filename)}`;
      const res = await r2Put(creds, objectKey, bytes, "application/x-pem-file");
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`R2 upload failed: ${r2FailureMessage(res.status, t, normalized.warnings)}`);
      }

      const { data: existing } = await readSettingRow(supabase, "vps_config");
      const prev = publicVpsConfig(existing?.value);
      if (prev.keyObjectKey) {
        try { await r2Delete(creds, prev.keyObjectKey); } catch {}
      }
      const safeFilename = slugifyFilename(p.filename).replace(/\.bin$/i, ".pem");
      const value = {
        ...prev,
        keyFilename: safeFilename,
        keyObjectKey: objectKey,
        keyUploadedAt: new Date().toISOString(),
        keySize: bytes.length,
        hasKey: true,
      };
      const { error } = await supabase.from("app_settings").upsert({ key: "vps_config", value }, { onConflict: "key" });
      invalidateAllSettings();
      if (error) throw error;
      await auditLog(supabase, "vps_key_uploaded", session.userId, null, { filename: safeFilename, size: bytes.length }, ip);
      return new Response(JSON.stringify({ success: true, value }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_download_vps_key") {
      const session = await requireAdmin(req);
      const { data: vpsRow } = await readSettingRow(supabase, "vps_config");
      const vps = publicVpsConfig(vpsRow?.value);
      if (!vps.keyObjectKey) throw new Error("No private key has been uploaded yet");
      const { data: r2Row } = await readSettingRow(supabase, "r2_storage");
      const r2Value: any = r2Row?.value || {};
      if (!r2Value.enabled) throw new Error("R2 is not enabled — configure it in Settings → Storage first");
      const normalized = normalizeR2Config(r2Value);
      if (normalized.errors.length) throw new Error(normalized.errors.join(" "));
      const cfg = normalized.config;
      if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) throw new Error("R2 credentials incomplete");
      const { r2Get } = await import("../_shared/r2Sign.ts");
      const creds = { accountId: cfg.accountId, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, bucket: cfg.bucket };
      const res = await r2Get(creds, vps.keyObjectKey);
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`R2 download failed: ${r2FailureMessage(res.status, t, normalized.warnings)}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      await auditLog(supabase, "vps_key_downloaded", session.userId, null, { filename: vps.keyFilename }, ip);
      return new Response(JSON.stringify({ success: true, filename: vps.keyFilename, dataBase64: btoa(binary) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_delete_vps_key") {
      const session = await requireAdmin(req);
      const { data: vpsRow } = await readSettingRow(supabase, "vps_config");
      const vps = publicVpsConfig(vpsRow?.value);
      if (!vps.keyObjectKey) {
        return new Response(JSON.stringify({ success: true, value: vps, message: "No key was stored." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Best-effort delete from R2 (never fail the request if R2 is unreachable).
      try {
        const { data: r2Row } = await readSettingRow(supabase, "r2_storage");
        const r2Value: any = r2Row?.value || {};
        if (r2Value.enabled) {
          const normalized = normalizeR2Config(r2Value);
          const cfg = normalized.config;
          if (cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket) {
            const { r2Delete } = await import("../_shared/r2Sign.ts");
            await r2Delete({ accountId: cfg.accountId, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, bucket: cfg.bucket }, vps.keyObjectKey).catch(() => {});
          }
        }
      } catch { /* swallow — metadata wipe below is what actually matters */ }
      const value = { ...vps, keyFilename: "vps-private-key.pem", keyObjectKey: "", keyUploadedAt: "", keySize: 0, hasKey: false };
      const { error } = await supabase.from("app_settings").upsert({ key: "vps_config", value }, { onConflict: "key" });
      invalidateAllSettings();
      if (error) throw error;
      await auditLog(supabase, "vps_key_deleted", session.userId, null, { previous: vps.keyFilename }, ip);
      return new Response(JSON.stringify({ success: true, value: publicVpsConfig(value) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const parseStoredCookieCount = (raw: unknown): number => {
      const text = String(raw || "").trim();
      if (!text) return 0;

      const countJson = () => {
        const data = JSON.parse(text);
        const arr = Array.isArray(data)
          ? data
          : Array.isArray(data?.cookies)
          ? data.cookies
          : data && typeof data === "object" && data.name
          ? [data]
          : [];
        return arr.filter((c: any) => String(c?.name ?? c?.Name ?? "").trim()).length;
      };

      try {
        if (text.startsWith("{") || text.startsWith("[")) return countJson();
      } catch (_) {}

      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

      const netscape = lines.filter((rawLine) => {
        const line = rawLine.replace(/^#HttpOnly_/i, "");
        if (!line || line.startsWith("#")) return false;
        const parts = line.split("\t");
        return parts.length >= 7 && !!parts[5];
      }).length;
      if (netscape > 0) return netscape;

      if (text.includes("\t")) {
        const rows = lines.map((l) => l.split("\t"));
        const start = /^name$/i.test((rows[0]?.[0] || "").trim()) ? 1 : 0;
        let devtools = 0;
        for (let i = start; i < rows.length; i++) {
          const name = (rows[i]?.[0] || "").trim();
          if (name && !/\s/.test(name) && rows[i].length >= 3) devtools++;
        }
        if (devtools > 0) return devtools;
      }

      let header = 0;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/^\s*(set-cookie|cookie)\s*:\s*/i, "").trim();
        if (!line || line.startsWith("#")) continue;
        const pieces = line.split(";").map((p) => p.trim()).filter(Boolean);
        for (let i = 0; i < pieces.length; i++) {
          const eq = pieces[i].indexOf("=");
          if (eq <= 0) continue;
          const name = pieces[i].slice(0, eq).trim();
          if (!name || /\s/.test(name)) continue;
          if (/^(path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned)$/i.test(name)) continue;
          header++;
          const rest = pieces.slice(i + 1).join(";").toLowerCase();
          if (/(^|;|\s)(path|domain|expires|max-age|samesite|secure|httponly)\b/.test(rest)) break;
        }
      }
      if (header > 0) return header;

      try { return countJson(); } catch (_) {}
      return lines.length || (text ? 1 : 0);
    };

    const DIRECT_LINK_COOKIE_KEYS = ["NetflixId", "SecureNetflixId", "nfvdid", "OptanonConsent"];
    const decodeCookieValue = (value: unknown) => {
      const s = String(value || "");
      if (!s || !s.includes("%")) return s;
      try { return decodeURIComponent(s); } catch { return s; }
    };
    const extractNetflixIdFromStoredCookies = (raw: unknown): string => {
      const text = String(raw || "").trim();
      if (!text) return "";
      const cookieDict: Record<string, string> = {};

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim().replace(/^#HttpOnly_/i, "");
        if (!line || line.startsWith("#")) continue;
        const parts = line.split("\t");
        if (parts.length >= 7 && DIRECT_LINK_COOKIE_KEYS.includes(parts[5])) {
          cookieDict[parts[5]] = decodeCookieValue(parts[6]);
        }
      }

      try {
        const data = JSON.parse(text);
        const addCookie = (cookie: any) => {
          const name = String(cookie?.name ?? cookie?.Name ?? "");
          const value = cookie?.value ?? cookie?.Value;
          if (DIRECT_LINK_COOKIE_KEYS.includes(name) && typeof value === "string") cookieDict[name] = decodeCookieValue(value);
        };
        if (Array.isArray(data)) data.forEach(addCookie);
        else if (data && typeof data === "object") {
          for (const key of DIRECT_LINK_COOKIE_KEYS) {
            if (typeof data[key] === "string") cookieDict[key] = decodeCookieValue(data[key]);
          }
          if (Array.isArray(data.cookies)) data.cookies.forEach(addCookie);
        }
      } catch (_) {}

      for (const key of DIRECT_LINK_COOKIE_KEYS) {
        if (cookieDict[key]) continue;
        const match = new RegExp(`(?<!\\w)${key}=([^;,\\s]+)`, "i").exec(text);
        if (match?.[1]) cookieDict[key] = decodeCookieValue(match[1]);
      }

      return cookieDict.NetflixId || "";
    };

    const NETFLIX_DIRECT_LINK_QUERY: Record<string, string> = {
      appVersion: "15.48.1",
      config: '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
      device_type: "NFAPPL-02-",
      esn: "NFAPPL-02-IPHONE8%3D1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
      idiom: "phone",
      iosVersion: "15.8.5",
      isTablet: "false",
      languages: "en-US",
      locale: "en-US",
      maxDeviceWidth: "375",
      model: "saget",
      modelType: "IPHONE8-1",
      odpAware: "true",
      path: '["account","token","default"]',
      pathFormat: "graph",
      pixelDensity: "2.0",
      progressive: "false",
      responseFormat: "json",
    };

    const NETFLIX_DIRECT_LINK_HEADERS: Record<string, string> = {
      "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
      "x-netflix.request.attempt": "1",
      "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
      "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
      "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
      "x-netflix.context.app-version": "15.48.1",
      "x-netflix.argo.translated": "true",
      "x-netflix.context.form-factor": "phone",
      "x-netflix.context.sdk-version": "2012.4",
      "x-netflix.client.appversion": "15.48.1",
      "x-netflix.context.max-device-width": "375",
      "x-netflix.context.ab-tests": "",
      "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
      "x-netflix.client.type": "argo",
      "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
      "x-netflix.context.locales": "en-US",
      "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
      "x-netflix.client.iosversion": "15.8.5",
      "accept-language": "en-US;q=1",
      "x-netflix.argo.abtests": "",
      "x-netflix.context.os-version": "15.8.5",
      "x-netflix.request.client.context": '{"appState":"foreground"}',
      "x-netflix.context.ui-flavor": "argo",
      "x-netflix.argo.nfnsm": "9",
      "x-netflix.context.pixel-density": "2.0",
      "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
      "x-netflix.request.client.timezoneid": "Asia/Dhaka",
    };

    const maskTvEmail = (em: string) => {
      const email = String(em || "").trim().toLowerCase();
      const at = email.indexOf("@");
      if (at < 0) return email;
      const local = email.slice(0, at);
      const domain = email.slice(at);
      if (!local) return email;
      if (local.length <= 6) return `${local[0] || ""}•••${local.slice(-1)}${domain}`;
      return `${local.slice(0, 3)}•••${local.slice(-3)}${domain}`;
    };

    const resolveTvAccountCandidates = (allAccounts: any[], assignedAccounts: any[]) => {
      const assigned = (Array.isArray(assignedAccounts) ? assignedAccounts : [])
        .map((v: any) => String(v || "").trim().toLowerCase())
        .filter(Boolean);
      const showAll = assigned.length === 0 || assigned.includes("all");

      // Each recipient filter is treated as a distinct TV account.
      // If an account has no recipient filters, the IMAP user itself acts as
      // the single implicit filter (legacy behavior).
      const out: Array<{ account_key: string; label: string; imap_user: string; login_email: string; recipient_filters: string[] }> = [];
      const seen = new Set<string>();
      (Array.isArray(allAccounts) ? allAccounts : []).forEach((acc: any, idx: number) => {
        const label = String(acc?.label || acc?.user || "").trim();
        const imap_user = String(acc?.user || "").trim().toLowerCase();
        if (!imap_user) return;
        const recipientFilters = normalizeRecipientFilters(acc?.recipientFilters);
        const filters = recipientFilters.length > 0 ? recipientFilters : [imap_user];
        for (const filter of filters) {
          const loginEmail = String(filter || "").trim().toLowerCase();
          if (!loginEmail) continue;
          const matchKeys = new Set([
            label.toLowerCase(),
            imap_user,
            loginEmail,
            ...recipientFilters,
          ].filter(Boolean));
          if (!showAll && !assigned.some((item) => matchKeys.has(item))) continue;
          const key = `${idx}:${imap_user}:${loginEmail}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            account_key: key,
            label: filters.length > 1 ? `${label} · ${loginEmail}` : label,
            imap_user,
            login_email: loginEmail,
            recipient_filters: recipientFilters,
          });
        }
      });
      return out;
    };

    // ── Telegram reporting for TV auto-login flow ──
    // Emits a rich, HTML-formatted alert for every TV login attempt, result,
    // cookie-expiry issue, and user-initiated error report.
    const escapeTgHtml = (s: unknown) =>
      String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const redactTgValue = (value: unknown) =>
      String(value ?? "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => maskTvEmail(m));
    const humanTgKey = (key: string) => key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const splitTiming = (message: string) => {
      const idx = message.toLowerCase().indexOf("| timing");
      if (idx < 0) return { main: message, timing: "" };
      return { main: message.slice(0, idx).trim(), timing: message.slice(idx + 1).trim() };
    };
    const sendTvLoginTelegram = async (kind: string, fields: Record<string, unknown>) => {
      try {
        const tg = await getTelegramConfig(supabase);
        if (!tg) return;
        const titleMap: Record<string, string> = {
          attempt: "🚀 TV Login — Attempt started",
          success: "✅ TV Login — Signed in successfully",
          invalid_code: "❌ TV Login — Invalid code",
          cookies_expired: "🍪 TV Login — Cookies expired",
          no_cookies: "⚠️ TV Login — No cookies configured",
          not_configured: "⚙️ TV Login — Not configured",
          runner_timeout: "⏳ TV Login — Runner slow",
          netflix_timeout: "⏳ TV Login — Netflix slow",
          error: "🔥 TV Login — Error",
          user_error_report: "📣 TV Login — User report",
        };
        const get = (key: string) => {
          const v = fields[key];
          if (v === undefined || v === null || v === "") return "";
          return redactTgValue(v);
        };
        const row = (key: string, label = humanTgKey(key)) => {
          const v = get(key);
          return v ? `${escapeTgHtml(label)}: <code>${escapeTgHtml(v)}</code>` : "";
        };
        const section = (label: string, rows: string[]) => {
          const body = rows.filter(Boolean).join("\n");
          return body ? `<b>${escapeTgHtml(label)}</b>\n${body}` : "";
        };
        const rawMessage = get("message") || get("event_message") || get("ui_message");
        const { main: mainMessage, timing } = splitTiming(rawMessage);
        const msToSeconds = (ms: number) => {
          const sec = ms / 1000;
          return `${sec >= 10 ? sec.toFixed(1) : sec.toFixed(2)}s`;
        };
        const timingRows = timing
          ? timing.replace(/^timing\s*/i, "").split(/\s+/).filter(Boolean).map((part) => {
              const m = part.match(/^([\w.-]+)=(\d+(?:\.\d+)?)ms$/i);
              const pretty = m ? `${m[1]}=${msToSeconds(Number(m[2]))}` : part;
              return `<code>${escapeTgHtml(pretty)}</code>`;
            })
          : [];

        const parts = [
          `<b>${escapeTgHtml(titleMap[kind] || `TV Login — ${kind}`)}</b>`,
          section("📊 Result", [row("status"), row("result"), row("dispatch"), row("code_last4", "Code last 4")]),
          section("👤 User", [row("user"), row("display_name", "Display name"), row("user_id", "User ID"), row("ip", "IP")]),
          section("🎬 Account", [row("account_label", "Label"), row("imap_user", "Account"), row("login_email", "Login"), row("cookies_available", "Cookies")]),
          mainMessage ? section("💬 Message", [`<code>${escapeTgHtml(redactTgValue(mainMessage))}</code>`]) : "",
          timingRows.length ? section("⏱ Timing", timingRows) : "",
          section("🖥 Runtime", [row("run_url", "Runner"), row("started_at", "Started"), row("finished_at", "Finished"), row("submitted_at", "Submitted")]),
          get("user_note") ? section("📝 User note", [`<code>${escapeTgHtml(get("user_note"))}</code>`]) : "",
        ].filter(Boolean);
        const text = parts.join("\n\n");
        postTelegramBg(tg, { text: text.slice(0, 3900) });
      } catch (e) {
        console.warn("[tv_tg] send failed:", (e as Error).message);
      }
    };

    const USER_INVALID_TV_RESULTS = new Set(["runner_timeout", "netflix_timeout"]);
    const sanitizeTvEventForUser = (ev: any) => {
      if (!ev || !USER_INVALID_TV_RESULTS.has(String(ev.result || ""))) return ev;
      return {
        ...ev,
        status: "invalid_code",
        message: "Code rejected. Open Netflix on your TV, generate a fresh code, and try again.",
      };
    };

    const dispatchGithubTvRunner = async (eventId: string, reason: string, userLabel?: string) => {
      const cfg = await loadGithubConfig();
      const repo = cfg.repo;
      const pat = cfg.pat;
      if (!repo || !pat || !eventId) return { ok: false, diag: "github_not_configured", message: "GitHub Actions runner is not configured." };
      const cleanLabel = String(userLabel || "").replace(/[^\w.\-@ ]+/g, "").trim().slice(0, 60) || "user";
      const ghRes = await dispatchGithubWorkflow(pat, repo, { event_id: eventId, user_label: cleanLabel, fallback_reason: String(reason || "") });
      if (ghRes.status === 204) {
        return { ok: true, diag: "github_queued", message: "GitHub Actions runner queued." };
      }
      const body = await ghRes.text().catch(() => "");
      return { ok: false, diag: `github_${ghRes.status}`, message: githubPermissionMessage(ghRes.status, body, "run") };
    };


    if (action === "admin_cookies_list") {
      await requireAdmin(req);
      const { data, error } = await supabase
        .from("imap_cookies")
        .select("id, imap_user, label, filename, format, count, updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      const items = (data || []).map((row: any) => ({ ...row, count: Math.max(Number(row.count) || 0, 0) }));
      return new Response(JSON.stringify({ success: true, items }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_cookies_get") {
      await requireAdmin(req);
      const p = (params || {}) as any;
      const imapUser = String(p?.imap_user || "").trim().toLowerCase();
      if (!imapUser) throw new Error("imap_user required");
      const { data, error } = await supabase
        .from("imap_cookies")
        .select("imap_user, label, filename, format, count, content, updated_at")
        .eq("imap_user", imapUser)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data) data.count = Math.max(Number(data.count) || 0, parseStoredCookieCount(data.content));
      return new Response(JSON.stringify({ success: true, item: data || null }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_cookies_save") {
      const session = await requireAdmin(req);
      const p = (params || {}) as any;
      const imapUser = String(p?.imap_user || "").trim().toLowerCase();
      const content = String(p?.content || "");
      const filename = String(p?.filename || "cookies.txt").slice(0, 200);
      const format = String(p?.format || "text").slice(0, 20);
      const label = p?.label ? String(p.label).slice(0, 200) : null;
      const count = Math.max(0, Math.min(100000, Math.max(Number(p?.count) || 0, parseStoredCookieCount(content))));
      if (!imapUser) throw new Error("imap_user required");
      if (!content) throw new Error("content required");
      if (content.length > 2 * 1024 * 1024) throw new Error("content too large (max 2 MB)");
      const { data: saved, error } = await supabase
        .from("imap_cookies")
        .upsert({ imap_user: imapUser, label, filename, format, count, content, updated_at: new Date().toISOString() }, { onConflict: "imap_user" })
        .select("imap_user, label, filename, format, count, updated_at")
        .single();
      if (error) throw new Error(error.message);
      // Audit logging is non-critical and must never delay or falsely fail a
      // completed cookie write. Keep the isolate alive while it flushes.
      runInBackground(auditLog(supabase, "imap_cookies_saved", session.userId, null, { imap_user: imapUser, filename, format, count }, ip));
      return new Response(JSON.stringify({ success: true, item: saved }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_cookies_delete") {
      const session = await requireAdmin(req);
      const p = (params || {}) as any;
      const imapUser = String(p?.imap_user || "").trim().toLowerCase();
      if (!imapUser) throw new Error("imap_user required");
      const { error } = await supabase.from("imap_cookies").delete().eq("imap_user", imapUser);
      if (error) throw new Error(error.message);
      await auditLog(supabase, "imap_cookies_deleted", session.userId, null, { imap_user: imapUser }, ip);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "link_list_accounts" || action === "link_generate" || action === "link_list") {
      const session = await requireSession(req);
      const { data: user } = await supabase
        .from("app_users")
        .select("id, username, name, assigned_accounts, feature_link, role")
        .eq("id", session.userId)
        .maybeSingle();
      if (!user) throw new Error("User not found");
      if (user.role !== "admin" && user.feature_link !== true) {
        throw new Error("Direct Link isn't enabled for your account.");
      }

      // --- Shared: resolve candidate accounts w/ cookies ---
      const [, emailAccounts] = await Promise.all([
        getSetting<any>(supabase, "config"),
        getSetting<any[]>(supabase, "email_accounts"),
      ]);
      const allAccounts: any[] = Array.isArray(emailAccounts) ? emailAccounts : [];
      const candidates = resolveTvAccountCandidates(allAccounts, user.assigned_accounts);
      const lookupKeys = Array.from(new Set(candidates.map((c) => c.login_email))).filter(Boolean);
      const cookieMap = new Map<string, string>();
      if (lookupKeys.length > 0) {
        const { data: cookieRows } = await supabase.from("imap_cookies").select("imap_user, content, count").in("imap_user", lookupKeys);
        for (const row of cookieRows || []) {
          const has = Number((row as any).count) > 0 || (!!(row as any).content && String((row as any).content).length > 0);
          if (has) cookieMap.set(String((row as any).imap_user).toLowerCase(), String((row as any).content || ""));
        }
      }
      const eligible = candidates.filter((c) => cookieMap.has(c.login_email));

      if (action === "link_list_accounts") {
        return new Response(JSON.stringify({
          success: true,
          accounts: eligible.map((c) => ({
            account_key: c.account_key,
            login_email: c.login_email,
            login_email_masked: maskTvEmail(c.login_email),
            label: c.label,
          })),
          not_configured: eligible.length === 0,
          message: eligible.length === 0 ? "Admin hasn't set up Direct Link for your Netflix account yet." : undefined,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (action === "link_list") {
        const { data: rows } = await supabase
          .from("nftoken_links")
          .select("id, account_key, login_email, link_url, expires_at, created_at, revoked_at, status")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(20);
        return new Response(JSON.stringify({
          success: true,
          links: (rows || []).map((r: any) => ({
            ...r,
            login_email_masked: maskTvEmail(r.login_email || ""),
          })),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // link_generate
      const accountKey = String((params || {}).account_key || "").trim();
      const match = eligible.find((c) => c.account_key === accountKey) || eligible[0];
      if (!match) throw new Error("No configured Netflix account is available for a Direct Link.");

      // Enforce: user must wait until current active link expires before generating another.
      const { data: activeRows } = await supabase
        .from("nftoken_links")
        .select("id, expires_at")
        .eq("user_id", user.id)
        .eq("status", "active")
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("expires_at", { ascending: false })
        .limit(1);
      if (activeRows && activeRows.length > 0) {
        const exp = new Date(activeRows[0].expires_at).getTime();
        const secs = Math.max(0, Math.ceil((exp - Date.now()) / 1000));
        throw new Error(`Aapka current link abhi active hai. ${secs}s baad naya link generate kar sakte ho.`);
      }

      const cookieContent = cookieMap.get(match.login_email) || "";
      if (!cookieContent) throw new Error("Cookies missing for the selected account.");

      // Extract NetflixId from the same saved cookie formats accepted by the uploaded Python generator.
      const netflixId = extractNetflixIdFromStoredCookies(cookieContent);
      if (!netflixId) throw new Error("Stored cookies don't include a NetflixId session.");

      // Mint nftoken via the same Netflix iOS Argo API request as the uploaded Python script.
      let nftoken = "";
      let netflixExpires: number | null = null;
      try {
        const url = new URL("https://ios.prod.ftl.netflix.com/iosui/user/15.48");
        for (const [key, value] of Object.entries(NETFLIX_DIRECT_LINK_QUERY)) url.searchParams.set(key, value);
        const nfRes = await fetch(url, {
          method: "GET",
          headers: {
            ...NETFLIX_DIRECT_LINK_HEADERS,
            "Cookie": `NetflixId=${netflixId}`,
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (!nfRes.ok) throw new Error(`Netflix token endpoint returned ${nfRes.status}`);
        const body = await nfRes.json().catch(() => ({}));
        const tokenData = body?.value?.account?.token?.default || body?.account?.token?.default || {};
        nftoken = String(tokenData?.token || "");
        // Match Python exactly: if len(str(expires)) == 13 -> ms; else assume seconds.
        const rawExpiresVal = tokenData?.expires;
        const rawExpires = Number(rawExpiresVal);
        if (Number.isFinite(rawExpires) && rawExpires > 0) {
          const asStr = String(Math.trunc(rawExpires));
          netflixExpires = asStr.length === 13 ? Math.floor(rawExpires / 1000) : Math.floor(rawExpires);
        }
        console.log("[link_generate] netflix raw expires=", rawExpiresVal, "resolved seconds=", netflixExpires);
      } catch (e) {
        console.error("nftoken mint failed", e);
      }
      if (!nftoken) throw new Error("Netflix rejected the stored session. Cookies may be expired.");

      const expiresAt = netflixExpires ? new Date(netflixExpires * 1000).toISOString() : new Date(Date.now() + 60 * 60_000).toISOString();
      const linkUrl = `https://netflix.com/?nftoken=${nftoken}`;
      const { data: inserted, error: insErr } = await supabase.from("nftoken_links").insert({
        user_id: user.id,
        account_key: match.account_key,
        login_email: match.login_email,
        link: linkUrl,
        link_url: linkUrl,
        expires_at: expiresAt,
        status: "active",
        source_ip: ip,
        meta: { netflix_expires: netflixExpires, generator: "uploaded_python_exact" },
      }).select("id, created_at, expires_at").maybeSingle();
      if (insErr) throw insErr;

      // Admin Telegram notification (fire-and-forget)
      try {
        const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
        const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
        if (botToken && chatId) {
          const istFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
          const text = [
            "🔗 <b>Direct Link generated</b>",
            `User: <b>${user.name || user.username}</b> (${user.username})`,
            `Account: <code>${match.login_email}</code>`,
            `Expires (IST): <b>${istFmt.format(new Date(expiresAt))}</b>`,
          ].join("\n");
          fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
          }).catch(() => {});
        }
      } catch {}

      return new Response(JSON.stringify({
        success: true,
        link: {
          id: inserted?.id,
          link_url: linkUrl,
          expires_at: expiresAt,
          login_email_masked: maskTvEmail(match.login_email),
          account_key: match.account_key,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "tv_list_accounts") {
      const session = await requireSession(req);
      const { data: user } = await supabase
        .from("app_users")
        .select("id, assigned_accounts, feature_tv, role")
        .eq("id", session.userId)
        .maybeSingle();
      if (!user) throw new Error("User not found");
      if (user.role !== "admin" && user.feature_tv === false) {
        return new Response(JSON.stringify({ success: true, accounts: [], not_configured: true, message: "TV login isn't enabled for your account." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const [, emailAccounts] = await Promise.all([
        getSetting<any>(supabase, "config"),
        getSetting<any[]>(supabase, "email_accounts"),
      ]);
      const allAccounts: any[] = Array.isArray(emailAccounts) ? emailAccounts : [];
      const candidates = resolveTvAccountCandidates(allAccounts, user.assigned_accounts);

      // Cookies are keyed per recipient filter (login_email). An account is
      // only surfaced to the user if the admin has explicitly configured
      // cookies for THAT specific filter — never inherited from a sibling.
      const lookupKeys = Array.from(new Set(candidates.map((c) => c.login_email))).filter(Boolean);
      const cookieSet = new Set<string>();
      if (lookupKeys.length > 0) {
        const { data: cookieRows } = await supabase
          .from("imap_cookies")
          .select("imap_user, count, content")
          .in("imap_user", lookupKeys);
        for (const row of cookieRows || []) {
          const has = Number((row as any).count) > 0 || (!!(row as any).content && String((row as any).content).length > 0);
          if (has) cookieSet.add(String((row as any).imap_user).toLowerCase());
        }
      }

      const accounts = candidates
        .filter((c) => cookieSet.has(c.login_email))
        .map((c) => ({
          account_key: c.account_key,
          // Bind the frontend selection to the FILTER identity (login_email),
          // not the parent IMAP user. The runner will fetch cookies by this
          // key, so a filter without its own cookies can never fall back to
          // the primary account's cookies.
          imap_user: c.login_email,
          login_email: c.login_email,
          imap_user_masked: maskTvEmail(c.login_email),
          login_email_masked: maskTvEmail(c.login_email),
          actual_imap_user_masked: maskTvEmail(c.imap_user),
          label: c.label,
          cookies_available: true,
        }));
      const notConfigured = accounts.length === 0;
      return new Response(JSON.stringify({
        success: true,
        accounts,
        not_configured: notConfigured,
        message: notConfigured ? "Admin hasn't set up TV login for your Netflix account yet. Please check back soon." : undefined,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    if (action === "tv_submit_code") {
      const session = await requireSession(req);
      const p = (params || {}) as any;
      const code = String(p?.code || "").replace(/\D/g, "").slice(0, 8);
      if (code.length !== 8) throw new Error("Enter the 8-digit code shown on your TV");

      // GitHub Actions can cold-start slowly. Do not mark queued TV jobs stale
      // before the workflow has had time to boot and fetch the event, otherwise
      // the runner reaches `tv_login_fetch_job` and receives "Event is not runnable".
      const staleCutoffIso = new Date(Date.now() - 10 * 60_000).toISOString();
      await supabase
        .from("tv_login_events")
        .update({
          status: "error",
          result: "runner_timeout",
          message: "Fast TV runner did not report back. Please try again after the runner is online.",
          finished_at: new Date().toISOString(),
        })
        .in("status", ["queued", "running", "in_progress"])
        .lt("created_at", staleCutoffIso);

      const { data: user } = await supabase
        .from("app_users")
        .select("id, username, name, assigned_accounts, feature_tv, role")
        .eq("id", session.userId)
        .maybeSingle();
      if (user && user.role !== "admin" && user.feature_tv === false) {
        throw new Error("TV login isn't enabled for your account.");
      }
      if (!user) throw new Error("User not found");

      // Resolve the user's linked IMAP accounts strictly from admin-configured
      // email_accounts. No implicit "Primary" fallback — users see only what
      // the admin explicitly assigned to them.
      const [, emailAccounts] = await Promise.all([
        getSetting<any>(supabase, "config"),
        getSetting<any[]>(supabase, "email_accounts"),
      ]);
      const allAccounts: any[] = Array.isArray(emailAccounts) ? emailAccounts : [];
      const assignedLabels = (Array.isArray(user.assigned_accounts) ? user.assigned_accounts : [])
        .map((v: any) => String(v || "").trim().toLowerCase())
        .filter(Boolean);
      const candidates = resolveTvAccountCandidates(allAccounts, user.assigned_accounts);

      let matched: { account_key: string; label: string; imap_user: string; login_email: string } | null = null;
      let cookiesAvailable = false;
      const chosenImap = String(p?.imap_user || "").trim().toLowerCase();
      const chosenKey = String(p?.account_key || "").trim();
      if (candidates.length > 0) {
        const lookupKeys = Array.from(new Set(candidates.map((c) => c.login_email))).filter(Boolean);
        const { data: cookieRows } = await supabase
          .from("imap_cookies")
          .select("imap_user, count, content, updated_at")
          .in("imap_user", lookupKeys);
        const cookieMap = new Map<string, any>();
        for (const row of cookieRows || []) cookieMap.set(String(row.imap_user).toLowerCase(), row);

        if (chosenKey || chosenImap) {
          // Mandatory: chosen account must match the exact recipient-filter
          // identity (`login_email`). Do NOT match by the parent IMAP user here:
          // multiple filters can share the same inbox login, and matching the
          // parent would let aliases inherit primary cookies.
          const found = chosenKey
            ? candidates.find((c) => c.account_key === chosenKey && (!chosenImap || c.login_email === chosenImap))
            : candidates.find((c) => c.login_email === chosenImap);
          if (!found) throw new Error("Selected account is not available for your profile");
          matched = found;
          const row = cookieMap.get(found.login_email);
          cookiesAvailable = !!(row && (Number(row.count) > 0 || (row.content && String(row.content).length > 0)));
        } else {
          for (const c of candidates) {
            const row = cookieMap.get(c.login_email);
            if (row && (Number(row.count) > 0 || (row.content && String(row.content).length > 0))) {
              matched = c;
              cookiesAvailable = true;
              break;
            }
          }
          if (!matched) matched = candidates[0];
        }
      }

      const ua = req.headers.get("user-agent") || "";
      const metadata = {
        submittedAt: new Date().toISOString(),
        assignedLabels,
        candidateCount: candidates.length,
        matchedLabel: matched?.label || null,
        matchedLoginEmail: matched?.login_email || null,
        parentImapUser: matched?.imap_user || null,
        source: "viewer_tv_button",
      };
      const status = cookiesAvailable ? "in_progress" : "no_cookies";

      const { data: inserted, error: insErr } = await supabase
        .from("tv_login_events")
        .insert({
          user_id: user.id,
          username: user.username,
          // Bind the event to the FILTER's login_email (the cookie key), not
          // the parent IMAP user. This guarantees the runner will only ever
          // load cookies configured for THIS specific filter — never the
          // primary account's cookies.
          imap_user: matched?.login_email || null,
          account_label: matched?.label || null,
          code,
          status,
          cookies_available: cookiesAvailable,
          ip,
          user_agent: ua,
          metadata,
        })
        .select("id, created_at")
        .single();
      if (insErr) throw new Error(insErr.message);

      await auditLog(supabase, "tv_code_submitted", user.id, user.id, { code_last4: code.slice(-4), imap_user: matched?.login_email || null, parent_imap: matched?.imap_user || null, cookies_available: cookiesAvailable }, ip);


      // Exactly one runner is used: VPS mode OR GitHub Actions mode.
      let dispatched = false;
      let dispatchDiag = "skipped";
      let responseMessage: string | null = null;
      console.log(`[tv_submit] event=${inserted?.id} cookiesAvailable=${cookiesAvailable} matched_login=${matched?.login_email || "-"} parent_imap=${matched?.imap_user || "-"}`);
      if (cookiesAvailable && inserted?.id && matched?.login_email) {
        const { data: vpsRowForRunner } = await readSettingRow(supabase, "vps_config");
        const vpsCfgForRunner = publicVpsConfig(vpsRowForRunner?.value);
        const runnerMode: "vps" | "github" = (vpsCfgForRunner as any).mode === "github" ? "github" : "vps";
        const runnerBase = effectiveTvRunnerUrl(vpsRowForRunner?.value);
        const baseLabel = String(user?.name || user?.username || "user");
        const userLabel = matched?.label ? `${baseLabel} · ${matched.label}` : baseLabel;
        const tryGithubOnly = async (reason: string) => runnerMode === "github"
          ? await dispatchGithubTvRunner(inserted!.id, reason, userLabel).catch((err) => ({ ok: false, diag: "github_exception", message: err instanceof Error ? err.message : String(err) }))
          : { ok: false, diag: "vps_only_mode", message: "VPS mode is selected, so GitHub Actions will not run." };
        try {
          console.log(`[tv_submit] runner mode=${runnerMode} url_present=${!!runnerBase}`);

          // Mode: github → skip VPS entirely, dispatch GitHub Actions.
          if (runnerMode === "github") {
            const backup = await tryGithubOnly("mode_github");
            if (backup.ok) {
              dispatched = true;
              dispatchDiag = backup.diag;
              responseMessage = "GitHub runner started. Keep your TV on the code screen while it finishes.";
              await supabase.from("tv_login_events").update({
                status: "queued",
                result: null,
                message: responseMessage,
                metadata: { ...metadata, runnerMode: "github", githubQueuedAt: new Date().toISOString() },
              }).eq("id", inserted.id);
            } else {
              responseMessage = `GitHub Actions failed: ${backup.message}`;
              await supabase.from("tv_login_events").update({ status: "error", result: "fast_runner_unavailable", message: responseMessage, finished_at: new Date().toISOString() }).eq("id", inserted.id);
            }
          } else if (runnerBase) {
            const runnerToken = randomHex(32);
            const runnerTokenHash = await sha256Hex(runnerToken);
            await supabase
              .from("tv_login_events")
              .update({ metadata: { ...metadata, runnerMode: "direct", runnerTokenHash } })
              .eq("id", inserted.id);
            const runnerRes = await fetch(`${runnerBase}/run`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event_id: inserted.id, runner_token: runnerToken }),
              signal: AbortSignal.timeout(TV_RUNNER_DISPATCH_TIMEOUT_MS),
            });
            const txt = await runnerRes.text().catch(() => "");
            let runnerJson: any = null;
            try { runnerJson = txt ? JSON.parse(txt) : null; } catch {}
            console.log(`[tv_submit] direct runner response status=${runnerRes.status} body="${txt.slice(0, 220)}"`);
            dispatched = runnerRes.ok && runnerJson?.success !== false;
            if (!dispatched) {
              dispatchDiag = `fast_runner_${runnerRes.status}`;
              const runnerReason = runnerJson?.message || runnerJson?.error || txt.slice(0, 160);
              responseMessage = runnerRes.status === 409
                ? "Another TV sign-in is already running on this VPS. Try again in a few seconds."
                : runnerReason || `Fast runner rejected the job (${runnerRes.status})`;
              await supabase.from("tv_login_events").update({ status: "error", result: "fast_runner_unavailable", message: responseMessage, finished_at: new Date().toISOString() }).eq("id", inserted.id);
            } else {
              dispatchDiag = "fast_runner_running";
              responseMessage = "Fast TV runner started. Keep your TV on the code screen.";
              await supabase.from("tv_login_events").update({ status: "running", message: responseMessage }).eq("id", inserted.id);
            }
          } else {
            dispatchDiag = "no_config";
            const msg = "Fast TV runner URL is not configured.";
            console.log(`[tv_submit] ${msg}`);
            responseMessage = msg;
            await supabase.from("tv_login_events").update({ status: "error", result: "fast_runner_unavailable", message: responseMessage, finished_at: new Date().toISOString() }).eq("id", inserted.id);
          }
        } catch (e) {
          dispatchDiag = "exception";
          const em = e instanceof Error ? e.message : String(e);
          console.log(`[tv_submit] direct runner exception: ${em}`);
          responseMessage = /aborted|timeout/i.test(em)
            ? "Fast TV runner did not accept the job quickly enough. Try again in a few seconds."
            : `Fast runner error: ${em}`;
          await supabase.from("tv_login_events").update({ status: "error", result: "fast_runner_unavailable", message: responseMessage, finished_at: new Date().toISOString() }).eq("id", inserted.id);
        }
      }

      // Full-context Telegram alert for every TV login attempt.
      void sendTvLoginTelegram(cookiesAvailable ? "attempt" : (matched ? "no_cookies" : "not_configured"), {
        event_id: inserted?.id,
        user: user.username,
        user_id: user.id,
        display_name: user.name,
        account_label: matched?.label,
        imap_user: matched?.imap_user,
        login_email: matched?.login_email,
        code_last4: code.slice(-4),
        cookies_available: cookiesAvailable ? "yes" : "no",
        dispatch: dispatchDiag,
        ip,
        user_agent: ua.slice(0, 160),
        submitted_at: metadata.submittedAt,
      });

      return new Response(JSON.stringify({
        success: true,
        event_id: inserted?.id,
        created_at: inserted?.created_at,
        cookies_available: cookiesAvailable,
        account_label: matched?.label || null,
        imap_user_masked: matched?.login_email ? maskTvEmail(matched.login_email) : null,
        status: cookiesAvailable ? (dispatchDiag.startsWith("github") ? "queued" : dispatched ? "running" : "error") : "no_cookies",
        message: responseMessage,
        dispatch_diag: dispatchDiag,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── TV auto-login: client polling ──────────────────────────────
    if (action === "tv_login_status") {
      const session = await requireSession(req);
      const p = (params || {}) as any;
      const eventId = String(p?.event_id || "").trim();
      if (!eventId) throw new Error("event_id required");
      const { data: ev, error: evErr } = await supabase
        .from("tv_login_events")
        .select("id, status, result, message, account_label, imap_user, screenshot_url, github_run_url, created_at, finished_at, user_id, metadata")
        .eq("id", eventId)
        .maybeSingle();
      if (evErr) throw new Error(evErr.message);
      if (!ev) throw new Error("Event not found");
      if (String(ev.user_id) !== String(session.userId)) throw new Error("Forbidden");
      const evStatus = String(ev.status || "");
      const evCreated = Date.parse(String(ev.created_at || ""));
      const isStaleActive = ["queued", "running", "in_progress", "verifying", "checking"].includes(evStatus)
        && Number.isFinite(evCreated)
        && Date.now() - evCreated > 10 * 60_000;
      if (isStaleActive) {
        const expired = {
          ...ev,
          status: "error",
          result: "runner_timeout",
          message: evStatus === "queued"
            ? "TV sign-in took too long to start. Please try a fresh TV code."
            : "TV sign-in took too long to finish. Please try a fresh TV code.",
          finished_at: new Date().toISOString(),
          metadata: { ...((ev.metadata as any) || {}), autoExpiredAt: new Date().toISOString(), autoExpireReason: "status_poll_stale" },
        };
        await supabase
          .from("tv_login_events")
          .update({ status: expired.status, result: expired.result, message: expired.message, finished_at: expired.finished_at, metadata: expired.metadata })
          .eq("id", eventId);
        return new Response(JSON.stringify({ success: true, event: sanitizeTvEventForUser(expired) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const outEv = sanitizeTvEventForUser(ev);
      return new Response(JSON.stringify({ success: true, event: outEv }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Returns the caller's most recent non-terminal TV login event (if any).
    // Lets the UI resume in-flight sign-ins after workflow switches / reloads
    // instead of losing state that only lived in React memory.
    if (action === "tv_login_active") {
      const session = await requireSession(req);
      const cutoffIso = new Date(Date.now() - 30 * 60_000).toISOString();
      const { data: ev } = await supabase
        .from("tv_login_events")
        .select("id, status, result, message, account_label, imap_user, code, github_run_url, created_at, finished_at, cookies_available")
        .eq("user_id", session.userId)
        .in("status", ["queued", "running", "in_progress", "verifying", "checking"])
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return new Response(JSON.stringify({ success: true, event: ev || null }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Latest TV login attempts for the signed-in user. The UI uses this as the
    // durable per-profile process history, so workflow switches/reloads never
    // erase success/error details.
    if (action === "tv_login_recent") {
      const session = await requireSession(req);
      const { data, error } = await supabase
        .from("tv_login_events")
        .select("id, status, result, message, account_label, imap_user, github_run_url, created_at, finished_at, cookies_available")
        .eq("user_id", session.userId)
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ success: true, events: (data || []).map(sanitizeTvEventForUser) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }



    // ── TV auto-login: runner fetches job (HMAC-signed, plaintext) ──
    if (action === "tv_login_fetch_job" || action === "tv_login_report") {
      const p = (params || {}) as any;
      const eventId = String(p?.event_id || "").trim();
      const ts = Number(p?.ts || 0);
      const sig = String(p?.sig || "").toLowerCase();
      const runnerToken = String(p?.runner_token || "").trim();
      if (!eventId) throw new Error("event_id required");

      let authed = false;
      let runnerEvent: any = null;
      if (runnerToken) {
        const { data: tokenEvent } = await supabase
          .from("tv_login_events")
          .select("id, code, imap_user, status, user_id, metadata")
          .eq("id", eventId)
          .maybeSingle();
        runnerEvent = tokenEvent;
        const expectedHash = String((tokenEvent?.metadata as any)?.runnerTokenHash || "");
        authed = !!expectedHash && await sha256Hex(runnerToken) === expectedHash;
      }
      if (!authed) {
        // Loading GitHub configuration can involve database/secret work. Only
        // do it for the legacy HMAC runner; direct VPS jobs authenticate with
        // their one-time token and must stay on the fast path.
        const key = (await loadGithubConfig()).hmacKey;
        if (!key) throw new Error("Runner HMAC key not configured");
        if (!ts || Math.abs(Date.now() - ts) > 5 * 60 * 1000) throw new Error("Stale or missing timestamp");
        // HMAC over `${action}|${event_id}|${ts}` for fetch; for report include status+result
        const payloadStr = action === "tv_login_fetch_job"
          ? `${action}|${eventId}|${ts}`
          : `${action}|${eventId}|${ts}|${String(p?.status || "")}|${String(p?.result || "")}`;
        const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payloadStr));
        const expected = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
        if (expected !== sig) throw new Error("Bad signature");
      }

      if (action === "tv_login_fetch_job") {
        // Direct-token authentication already fetched the complete event.
        // Reuse it instead of making the same database round-trip twice.
        let ev = runnerEvent;
        if (!ev) {
          const { data, error: evErr } = await supabase
            .from("tv_login_events")
            .select("id, code, imap_user, status, user_id, metadata")
            .eq("id", eventId)
            .maybeSingle();
          if (evErr) throw new Error(evErr.message);
          ev = data;
        }
        if (!ev) throw new Error("Event not found");
        if (!ev.imap_user) throw new Error("No account bound to event");
        if (!new Set(["queued", "running", "in_progress"]).has(String(ev.status || ""))) throw new Error("Event is not runnable");
        console.log(`[tv_runner] fetch_job event=${eventId} status=${ev.status || "-"} imap=${ev.imap_user}`);
        // Cookie lookup and running-state update are independent. Running them
        // together removes another network round-trip from the direct VPS hot
        // path without changing any timeout or Netflix timing budget.
        const [{ data: cookieRow, error: cookieErr }, { error: runningErr }] = await Promise.all([
          supabase
            .from("imap_cookies")
            .select("content, format")
            .eq("imap_user", ev.imap_user)
            .maybeSingle(),
          supabase.from("tv_login_events").update({
            status: "running",
            github_run_url: String(p?.run_url || "") || null,
            metadata: { ...((ev.metadata as any) || {}), runnerStartedAt: new Date().toISOString() },
          }).eq("id", eventId),
        ]);
        if (cookieErr) throw new Error(cookieErr.message);
        if (runningErr) throw new Error(runningErr.message);
        if (!cookieRow?.content) throw new Error("No cookies stored for account");
        return new Response(JSON.stringify({
          success: true,
          event_id: ev.id,
          code: ev.code,
          cookies_content: cookieRow.content,
          cookies_format: cookieRow.format || "auto",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // tv_login_report
      const status = String(p?.status || "").slice(0, 40) || "unknown";
      const result = String(p?.result || "").slice(0, 40) || null;
      const message = String(p?.message || "").slice(0, 500) || null;
      const screenshotUrl = String(p?.screenshot_url || "").slice(0, 500) || null;
      const runUrl = String(p?.run_url || "").slice(0, 500) || null;
      console.log(`[tv_runner] report event=${eventId} status=${status} result=${result || "-"} run=${runUrl || "-"}`);
      const { data: preEv } = await supabase
        .from("tv_login_events")
        .select("id, username, user_id, account_label, imap_user, code, created_at")
        .eq("id", eventId)
        .maybeSingle();
      const { error: updErr } = await supabase
        .from("tv_login_events")
        .update({ status, result, message, screenshot_url: screenshotUrl, github_run_url: runUrl, finished_at: new Date().toISOString() })
        .eq("id", eventId);
      if (updErr) throw new Error(updErr.message);

      // Detailed Telegram alert for every runner result. Cookies expired /
      // errors are elevated so admin sees them immediately.
      const kind = result === "cookies_expired" ? "cookies_expired"
        : status === "success" ? "success"
        : status === "invalid_code" ? "invalid_code"
        : result === "runner_timeout" || result === "netflix_timeout" ? result
        : "error";
      void sendTvLoginTelegram(kind, {
        event_id: eventId,
        user: preEv?.username,
        user_id: preEv?.user_id,
        account_label: preEv?.account_label,
        imap_user: preEv?.imap_user,
        code_last4: typeof preEv?.code === "string" ? preEv.code.slice(-4) : undefined,
        status,
        result,
        message,
        run_url: runUrl,
        started_at: preEv?.created_at,
        finished_at: new Date().toISOString(),
      });

      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    throw new Error("Unknown action: " + action);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      console.error("[manage-app] action_failed", {
        action: typeof action === "string" ? action : "unknown",
        message,
      });
    } catch (_) {
      console.error("[manage-app] action_failed", message);
    }
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  };
  const __res = await __run();
  return await maybeEncryptResponse(__res, __ctx);
});
