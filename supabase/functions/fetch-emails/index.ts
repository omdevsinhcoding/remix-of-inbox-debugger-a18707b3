import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.4.3";
import { simpleParser } from "npm:mailparser@3.9.6";
import { readRequest, maybeEncryptResponse, EncryptedRequestContext, PlaintextRejectedError, plaintextRejectedResponse, TransportError, transportErrorResponse } from "../_shared/crypto.ts";
import { redactEmailsHtml, redactEmailsText } from "../_shared/redact.ts";
import { getSetting, invalidateSetting, readSettingRow } from "../_shared/settingsCache.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token, x-cron-secret, x-crypto-session, x-accept-encoding",
};

const PASSWORD_RESET_SUBJECTS = [
  "reset your password", "forgot password", "password reset",
  "change your password", "password change", "password recovery",
  "account recovery", "reset password",
];

const ACCOUNT_UPDATE_RE = /(attention|action (needed|required)|account (information|info|details) (was |has been )?(changed|updated)|changes? to your account|email (address )?(was |has been )?(changed|updated)|new email address|email verification|verification email|verify (your )?(email address|phone number|mobile number|account)|confirm (your )?(email address|phone number|mobile number|account change|account)|membership (was |has been )?(cancell?ed|updated|paused)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold)|we[’']re sorry to see you go|payment (received|method|was|has been|declined|failed|updated|changed)|mobile (number )?(confirm|confirmed|verify|verified|update|updated)|phone (number )?(confirm|confirmed|verify|verified|update|updated)|verify (your )?(phone|mobile|email)|verify your email address|action needed: verify|request to make a change|update your account|make (a |any )?(change|changes) to your account)/i;

// Netflix household / new-device / "is this you?" emails have no OTP, but
// users must see them so they can press Netflix's verification button.
const HOUSEHOLD_SIGNIN_RE = /(netflix household|your household|update your household|household (has been|was|is) (confirmed|updated)|part of your (netflix )?household|watching on a tv|traveling|travelling|new device|new sign[\s-]?in|signed in on|is this you|confirm (this|your) device|approve (this|your) device|watch instead|yes,? this was me)/i;

const SIGN_IN_CODE_SUBJECTS = [
  "enter this code", "sign-in code", "sign in to", "sign-in activity",
  "verification code", "login code", "sign in code",
];

// Only extract an OTP when the email is *actually* a sign-in / verification code email.
// Netflix marketing emails often contain random 4-8 digit numbers (dates, IDs) that must NOT
// be shown as an OTP.
const OTP_SUBJECT_HINT = /(sign[\s-]?in code|verification code|one[\s-]?time|login code|enter this code|access code|otp|confirm.*account|verify.*account|temporary.*code)/i;
const OTP_BODY_CONTEXT = /(sign[\s-]?in code|verification code|one[\s-]?time (?:code|password|pin)|otp|login code|enter (?:the |this )?code|use (?:the |this )?code|your code is|code below|access code|temporary (?:code|password|pin))/i;

function extractOtpCode(subject: string, body: string): string | null {
  const subj = (subject || "").toString();
  const txt = (body || "").toString();
  const looksLikeCodeEmail = OTP_SUBJECT_HINT.test(subj) || OTP_BODY_CONTEXT.test(txt);
  if (!looksLikeCodeEmail) return null;

  // Strategy 1: number that appears near a context keyword (within ~80 chars).
  const contextRe = /(sign[\s-]?in code|verification code|one[\s-]?time (?:code|password|pin)|otp|login code|access code|your code is|use (?:the |this )?code|enter (?:the |this )?code|temporary (?:code|password|pin))[\s\S]{0,80}?\b(\d{4,8})\b/i;
  const m1 = txt.match(contextRe) || subj.match(contextRe);
  if (m1 && m1[2]) return m1[2];

  // Strategy 2: standalone 4-8 digit block on its own line (Netflix formats codes this way).
  const lineRe = /^\s*(\d{4,8})\s*$/m;
  const m2 = txt.match(lineRe);
  if (m2 && m2[1]) return m2[1];

  return null;
}

const FULL_SYNC_MAX_UIDS = 50;
const USER_REFRESH_MAX_UIDS = 12;
// A manual refresh publishes the newly delivered, still-missing Netflix mails
// (any category: sign-in, household, promo, device alerts). It walks a bounded
// window of newest UIDs so mail that landed between two refreshes is not lost.
const QUICK_REFRESH_CANDIDATE_UIDS = 50;
// How many already-cached UIDs a click refresh may walk past before it stops.
const QUICK_REFRESH_SKIP_WINDOW = 100;
// A click refresh publishes ALL newly delivered eligible messages per assigned
// logical account (bounded only by QUICK_REFRESH_CANDIDATE_UIDS and the
// per-account timeout). The old cap of 2 caused fresh household / device
// mails to be dropped and only appear on the next cron cycle 5-7 min later.
const QUICK_REFRESH_MAX_ELIGIBLE_PER_ACCOUNT = 25;


// Budgets are measured AFTER the IMAP connection is established (Gmail's TLS
// handshake + greeting alone can take 5-9s, which used to eat the whole budget
// and made every quick refresh scan 0 messages).
const PER_ACCOUNT_TIMEOUT_MS = 12000;
const FAST_REFRESH_TIMEOUT_MS = 8000;
// Connection time is intentionally separate from the mailbox scan budget.
// Gmail TLS/greeting can occasionally take 6-9s; charging that against the
// scan left no time to inspect INBOX and made fresh mail appear "missing".
const FAST_REFRESH_CONNECT_TIMEOUT_MS = 7000;
// Manual refresh must cover a busy Gmail inbox without parsing unrelated mail.
const FAST_REFRESH_SCAN_COUNT = 20;
const STALE_DAYS = 60;

// ------- Durable job coordination (survives Deno isolate recycles) --------
// Every knob below is a constant so ops can grep + tune in one place.
const STALE_CLEANUP_MIN_INTERVAL_MS = 6 * 60 * 60_000; // 6h floor per isolate
const DEDUP_ID_LIMIT = 2000;                // keyset window, not offset

const USER_SYNC_WINDOW_MS = 5_000;
const userSyncHits = new Map<string, number>();

type Session = { userId: string; username: string; role: "admin" | "user"; assignedAccounts?: string[] | null; exp?: number; impersonated?: boolean; adminId?: string | null };
type Account = { label: string; host: string; port: number; user: string; password: string; recipientFilters?: string[] };

function selectLogicalAccount(toRaw: string | null | undefined, accounts: Account[]): Account | null {
  // Explicit recipient assignments always win over a catch-all account that
  // points at the same physical IMAP inbox.
  const explicit = accounts.find((acc) => (acc.recipientFilters || []).length > 0 && recipientMatches(toRaw, acc.recipientFilters));
  if (explicit) return explicit;
  return accounts.find((acc) => (acc.recipientFilters || []).length === 0 && recipientMatches(toRaw, [])) || null;
}

function envelopeRecipients(envelope: any): string {
  const recipients = [
    ...(Array.isArray(envelope?.to) ? envelope.to : []),
    ...(Array.isArray(envelope?.cc) ? envelope.cc : []),
  ];
  return recipients
    .map((recipient: any) => String(recipient?.address || "").trim())
    .filter(Boolean)
    .join(", ");
}

function headerValueText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(headerValueText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.value)) {
      return record.value
        .map((entry: any) => entry?.address || entry?.text || "")
        .filter(Boolean)
        .join(", ");
    }
  }
  return String(value);
}

function parsedRoutingRecipients(parsed: any, envelope: any): string {
  const visible = [parsed?.to, parsed?.cc]
    .flatMap((value: any) => Array.isArray(value) ? value : value ? [value] : [])
    .map((value: any) => headerValueText(value))
    .filter(Boolean);

  // Shared Gmail inboxes often receive Netflix messages through BCC or an
  // alias. In those messages `To` can contain the primary mailbox (or no useful
  // address), while Gmail preserves the real destination in delivery headers.
  // Include those headers before logical-account routing so a fresh message is
  // assigned to the intended profile rather than the catch-all account.
  const headers = parsed?.headers;
  const delivered = ["delivered-to", "x-original-to", "x-google-original-to", "envelope-to"]
    .map((name) => {
      try { return headerValueText(headers?.get?.(name)); } catch { return ""; }
    })
    .filter(Boolean);

  return Array.from(new Set([...delivered, ...visible, envelopeRecipients(envelope)]))
    .filter(Boolean)
    .join(", ");
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

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function verifySessionToken(token: string, secret: string): Promise<Session | null> {
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

async function verifySessionTokenAllowExpired(token: string, secret: string): Promise<Session | null> {
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

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireSession(req: Request, body: any, primary: string, legacy?: string, supabase?: any): Promise<Session | null> {
  const token = req.headers.get("x-session-token") || body.sessionToken;
  if (!token) return null;
  let p = await verifySessionToken(token, primary);
  if (!p && legacy && legacy !== primary) p = await verifySessionToken(token, legacy);
  let tokenExpired = false;
  if (!p) {
    p = await verifySessionTokenAllowExpired(token, primary);
    if (!p && legacy && legacy !== primary) p = await verifySessionTokenAllowExpired(token, legacy);
    tokenExpired = !!p;
  }
  if (!p) return null;
  // Live DB revocation check — an admin-revoked session must lose access
  // immediately, not wait for the 15-minute HMAC token to expire.
  if (supabase) {
    try {
      const tokenHash = await sha256Hex(token);
      const { data: sessRow } = await supabase
        .from("app_sessions")
        .select("id, revoked_at, revoked_reason, expires_at, refresh_expires_at, parent_session_id, family_id")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (!sessRow) {
        if (p.impersonated === true && typeof p.adminId === "string") return p;
        return null;
      }
      if (sessRow.revoked_at) {
        const rotatedGrace = /^rotated/i.test(String(sessRow.revoked_reason || ""))
          && Date.now() - new Date(sessRow.revoked_at).getTime() < 2 * 60 * 1000;
        if (!rotatedGrace && !(p.impersonated === true && typeof p.adminId === "string")) return null;
      }
      const rowExpired = sessRow.expires_at && new Date(sessRow.expires_at).getTime() < Date.now();
      if (tokenExpired || rowExpired) {
        let allowExpiredImpersonation = false;
        if (sessRow.parent_session_id && sessRow.refresh_expires_at && new Date(sessRow.refresh_expires_at).getTime() > Date.now()) {
          const { data: parent } = await supabase
            .from("app_sessions")
            .select("role, revoked_at")
            .eq("id", sessRow.parent_session_id)
            .maybeSingle();
          allowExpiredImpersonation = parent
            ? (parent.role === "admin" && !parent.revoked_at)
            : (p.impersonated === true && typeof p.adminId === "string");
        }
        if (!allowExpiredImpersonation) return null;
      }
    } catch {
      return null;
    }
  }
  return p;
}


async function deriveEncKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("imap-enc-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
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
  if (!encrypted?.startsWith?.("enc:")) return encrypted;
  const [, ivHex, ctHex] = encrypted.split(":");
  const key = await deriveEncKey(secret);
  const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

async function getAssignedAccountFilter(supabase: any, session: Session | null): Promise<string[] | null> {
  if (!session || session.role === "admin") return null;
  const [{ data: userData }, { data: accountsData }] = await Promise.all([
    supabase.from("app_users").select("assigned_accounts").eq("id", session.userId).single(),
    readSettingRow(supabase, "email_accounts"),
  ]);
  // For non-admin users: return the assigned list (possibly empty).
  // An empty array means "no accounts ticked" -> show nothing.
  const labels = (Array.isArray(accountsData?.value) ? accountsData.value : []).map((acc: any) => String(acc?.label || acc?.user || "").trim()).filter(Boolean);
  return Array.isArray(userData?.assigned_accounts) ? normalizeAccountLabels(userData.assigned_accounts, labels) : [];
}

// ============================================================================
// ⚠️  DO NOT TOUCH — HARD BLOCK: Netflix account-change mails ⚠️
// ----------------------------------------------------------------------------
// Netflix account-modification mails (email change, phone add/update, password
// change, profile add/remove/rename, payment/billing update, membership
// pause/cancel, "Confirm your account change with this code: XXXXXX", etc.)
// are HARD BLOCKED for end users — admin toggle irrelevant. Only admin sees
// them. Runs BEFORE the OTP/signin check so account-change mails carrying a
// 6-digit code (like Netflix's email-change confirmation) are still caught.
// Mirrors the identical rule in manage-app and the client classifier.
// ============================================================================
const ACCOUNT_CHANGE_STRONG_RE = /(confirm (your )?(account change|email address change|change to your account|new email|phone (number )?change)|your (account (information|info|details)|email address|phone number|password) (was |has been |is )?(changed|updated|added|removed|reset)|(email address|phone number|password|payment method|payment info|billing info|account information) (was |has been )?(changed|updated|added|removed|reset|verified)|changes? to your account (was|has been|were) (made|updated)|make (a |any )?(change|changes) to your account|request to make a change|password (was |has been )?(changed|reset|updated)|(a )?new profile (was |has been )?(added|created)|profile (was |has been )?(added|created|removed|deleted|renamed|updated|modified)|(a )?profile (has been|was) (added|removed|deleted|renamed)|added a (new )?(phone|mobile|email|profile)|(mobile|phone) number (was |has been )?(added|updated|changed|removed|verified|confirmed)|membership (was |has been )?(cancell?ed|updated|paused|on hold|restarted|resumed|reactivated)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold|reactivated)|we[’']re sorry to see you go|payment (method|info|information) (was |has been )?(updated|changed|added|removed)|update your account (information|info|details)|action needed: (verify|update|confirm))/i;

function classifyEmailForVisibility(e: any): "household" | "signin" | "password_reset" | "account_update" | "other" {
  const subject = String(e?.subject || "");
  const preview = String(e?.preview || "");
  const combined = `${subject} ${preview}`;
  // Household verification is an access/sign-in action, not an account-detail
  // mutation. It must win over broad phrases such as "update your account".
  if (HOUSEHOLD_SIGNIN_RE.test(combined)) return "household";
  // HARD BLOCK (see banner above) — wins over OTP, but not household access.
  if (ACCOUNT_CHANGE_STRONG_RE.test(combined)) return "account_update";
  // Password reset/recovery messages frequently contain an OTP. Classify the
  // purpose before the generic OTP rule so those codes never reach end users.
  if (PASSWORD_RESET_SUBJECTS.some(kw => combined.toLowerCase().includes(kw))) return "password_reset";
  if (e?.otp || SIGN_IN_CODE_SUBJECTS.some(kw => combined.toLowerCase().includes(kw)) || OTP_SUBJECT_HINT.test(subject) || OTP_BODY_CONTEXT.test(preview)) return "signin";
  if (ACCOUNT_UPDATE_RE.test(combined)) return "account_update";
  return "other";
}

function applyEmailFilters(emails: any[], filterSignInCodes: boolean, filterPasswordResets: boolean, filterAccountUpdates = true, blockPromo = false) {
  let output = emails;
  if (filterSignInCodes) {
    output = output.filter((e: any) => {
      const sub = (e.subject || "").toLowerCase();
      return !SIGN_IN_CODE_SUBJECTS.some(kw => sub.includes(kw));
    });
  }
  // Explicit blocklist by classification. Keeps signin, household, and "other"
  // (promo/marketing/continue-watching) visible. Only account_update is hard-
  // blocked; password_reset drops only when its filter is explicitly on.
  // DO NOT re-add the old "keep only signin" collapse — it silently killed
  // every promo mail (e.g. "Don't forget to finish Taskaree").
  output = output.filter((e: any) => {
    const cls = classifyEmailForVisibility(e);
    if (filterAccountUpdates && cls === "account_update") return false;
    if (filterPasswordResets && cls === "password_reset") return false;
    return true;
  });
  if (blockPromo) {
    output = output.filter((e: any) => !isNetflixPromo(e.subject));
  }
  return output;
}

async function getEmailVisibility(supabase: any): Promise<{ enabled: boolean; days: number } | null> {
  try {
    const v: any = await getSetting(supabase, "email_visibility");
    if (v && v.enabled === true && Number(v.days) > 0) return { enabled: true, days: Number(v.days) };
  } catch {}
  return null;
}

function clampLimit(value: any, fallback: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function escapeHtml(input: string) {
  return input.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
}

function isNetflixFrom(fromRaw: string | null | undefined): boolean {
  if (!fromRaw) return false;
  const s = String(fromRaw).toLowerCase();
  return /@([a-z0-9-]+\.)*netflix\.com\b/.test(s);
}

const NETFLIX_PROMO_SUBJECTS = [
  "unlimited series", "ready to watch", "finish signing up", "welcome to netflix",
  "new on netflix", "recommended for you", "top 10", "trending now",
  "coming soon", "start watching", "new releases", "we think you'll love",
  "don't miss", "back on netflix",
];
function isNetflixPromo(subject: string | null | undefined): boolean {
  const s = (subject || "").toLowerCase();
  return NETFLIX_PROMO_SUBJECTS.some((kw) => s.includes(kw));
}
async function shouldBlockPromo(supabase: any): Promise<boolean> {
  try {
    const v: any = await getSetting(supabase, "netflix_promo");
    return v?.block === true;
  } catch {
    return false;
  }
}


function decodeQuotedPrintable(input: string) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function formatAddress(addr: any) {
  if (!addr) return "";
  const name = addr.name ? `${addr.name} ` : "";
  const address = addr.address || "";
  return `${name}${address}`.trim();
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function extractEmailAddresses(value: string | null | undefined): string[] {
  const s = normalizeEmail(value);
  if (!s) return [];
  const matches = s.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return matches.map(normalizeEmail);
}

function normalizeRecipientFilters(raw: any): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  return Array.from(new Set(values.flatMap((v: any) => extractEmailAddresses(String(v || "")))));
}

function isPlusAliasAddress(email: string): boolean {
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
    // No explicit filters: treat plus-aliases (foo+tag@domain) as separate
    // mailboxes that must be explicitly assigned via recipientFilters.
    return recipients.some((email) => !isPlusAliasAddress(email));
  }
  const allowed = new Set(filters.map(normalizeEmail).filter(Boolean));
  return recipients.some((email) => allowed.has(email));
}

function parseFastEmail(rawSource: Uint8Array, envelope: any, accountLabel: string, uid: number) {
  const raw = new TextDecoder().decode(rawSource);
  const splitAt = raw.search(/\r?\n\r?\n/);
  const rawBody = splitAt >= 0 ? raw.slice(splitAt) : raw;
  const bodyText = decodeQuotedPrintable(rawBody)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20_000);
  const subject = (envelope?.subject || "").toString();
  const from = (envelope?.from || []).map(formatAddress).filter(Boolean).join(", ") || "Netflix";
  const to = (envelope?.to || []).map(formatAddress).filter(Boolean).join(", ") || undefined;
  // Strict: sender must be a real @netflix.com address. Promo filtering happens
  // at read-time (respecting the admin toggle), not at ingest — so all official
  // Netflix mail (marketing/new-release announcements included) enters the cache.
  if (!isNetflixFrom(from)) return null;
  const preview = bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText;
  return {
    id: `${accountLabel}:${uid}`,
    message_id: envelope?.messageId || null,
    subject,
    from,
    to,
    date: envelope?.date || new Date(),
    otp: extractOtpCode(subject, bodyText),
    preview: redactEmailsText(preview),
    html: redactEmailsHtml(`<pre>${escapeHtml(bodyText)}</pre>`),
    account_label: accountLabel,
  };
}

async function readCache(supabase: any, accountFilter: string[] | null, filterSignInCodes: boolean, filterPasswordResets: boolean, filterAccountUpdates: boolean, session: Session | null, limit = 500) {
  const safeLimit = clampLimit(limit, 500, session?.role === "admin" ? 500 : 200);
  // Non-admin with zero assigned accounts -> nothing visible.
  if (accountFilter && accountFilter.length === 0 && session && session.role !== "admin") return [];
  // Narrow SELECT: `html` (largest column — up to ~100KB per Netflix mail) is
  // excluded from list responses. Clients fetch html lazily via `email-html`
  // when opening a single mail. This alone cuts DB egress + shared-buffer IO
  // on the /cache path by ~95% at 200 rows per call.
  let query = supabase
    .from("cached_emails")
    .select("id, subject, from_address, to_address, date, preview, otp, account_label, cached_at")
    .eq("destroyed", false)
    .order("date", { ascending: false })
    .limit(safeLimit);
  if (accountFilter && accountFilter.length > 0) query = query.in("account_label", accountFilter);
  if (session && session.role !== "admin") {
    const vis = await getEmailVisibility(supabase);
    if (vis) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - vis.days);
      query = query.gte("date", cutoff.toISOString());
    }
  }
  const { data: cached, error } = await query;
  if (error) throw error;
  const emails = (cached || []).map((e: any) => ({
    id: e.id,
    subject: e.subject,
    from: e.from_address,
    to: e.to_address,
    date: e.date,
    otp: e.otp,
    preview: redactEmailsText(e.preview),
    // html intentionally omitted — lazy-loaded via email-html endpoint.
    account_label: e.account_label,
    cached_at: e.cached_at,
  }));
  let scopedEmails = emails;
  if (session && session.role !== "admin") {
    try {
      const accountsValue = await getSetting<any[]>(supabase, "email_accounts");
      const filtersByLabel = new Map<string, string[]>();
      if (Array.isArray(accountsValue)) {
        for (const acc of accountsValue) {
          const label = String(acc?.label || acc?.user || "").trim();
          if (!label) continue;
          filtersByLabel.set(label, normalizeRecipientFilters(acc.recipientFilters || acc.recipientFilter || acc.allowedRecipients));
        }
      }
      scopedEmails = emails.filter((e: any) => recipientMatches(e.to, filtersByLabel.get(String(e.account_label || "").trim())));
    } catch {}
  }
  const blockPromo = await shouldBlockPromo(supabase);
  const filtered = applyEmailFilters(scopedEmails, filterSignInCodes, filterPasswordResets, filterAccountUpdates, blockPromo);
  return filtered.map((e: any) => ({ ...e, to: redactEmailsText(e.to) }));
}

async function fetchFromAccount(
  imapHost: string,
  imapPort: number,
  imapUser: string,
  imapPassword: string,
  accountLabel: string,
  cachedIds: Set<string>,
  cachedMessageIds: Set<string>,
  maxMessages = FULL_SYNC_MAX_UIDS,
  quickRefresh = false,
  recipientFilters: string[] = [],
  logicalAccounts: Account[] = [],
): Promise<{ emails: any[]; fetched: number; skipped: number; recipientSkipped: number; timedOut: boolean }> {
  const emails: any[] = [];
  let skipped = 0;
  let recipientSkipped = 0;
  let timedOut = false;
  let startedAt = Date.now();
  const budgetMs = quickRefresh ? FAST_REFRESH_TIMEOUT_MS : PER_ACCOUNT_TIMEOUT_MS;
  const connectBudgetMs = quickRefresh ? FAST_REFRESH_CONNECT_TIMEOUT_MS : 8000;
  let timer: number | undefined;
  let connectTimer: number | undefined;
  let closeInitiated = false;
  const hasBudget = () => !timedOut && Date.now() - startedAt < budgetMs;

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: true,
    auth: { user: imapUser, pass: imapPassword },
    logger: false,
    connectionTimeout: connectBudgetMs,
    // The explicit connect/scan budgets below are the user-facing deadline.
    // Keep ImapFlow's inactivity watchdog above that deadline so it cannot
    // abort a slow Gmail TLS greeting before our bounded timer does.
    socketTimeout: quickRefresh ? 20000 : 30000,
    greetingTimeout: quickRefresh ? 7000 : 8000,
  });

  const closeClient = () => {
    if (closeInitiated || !(client as any).usable) return;
    closeInitiated = true;
    try {
      const closing: any = client.close();
      if (closing && typeof closing.catch === "function") void closing.catch(() => {});
    } catch {}
  };

  const accountVariants = logicalAccounts.length > 0
    ? logicalAccounts
    : [{ label: accountLabel, host: imapHost, port: imapPort, user: imapUser, password: imapPassword, recipientFilters }];

  const scanMailbox = async (mailboxPath: string, idNamespace = "", allowIndexingGrace = false) => {
    if (!hasBudget()) return;
    const lock = await client.getMailboxLock(mailboxPath);
    try {
      // SELECT can return before Gmail publishes a just-delivered message's
      // EXISTS update. Force one cheap round trip before reading the count so
      // the first bounded tail scan includes the newest OTP/household message.
      if (quickRefresh && allowIndexingGrace && hasBudget()) {
        try { await client.noop(); } catch {}
      }
      const totalMessages = Number((client.mailbox as any)?.exists || 0);
      if (totalMessages <= 0 || !hasBudget()) return;

      const makeId = (label: string, uid: number) => `${label}:${idNamespace}${uid}`;
      const isCached = (uid: number) => cachedIds.has(String(uid)) || accountVariants.some((acc) => cachedIds.has(makeId(acc.label, uid)));
      let netflixUids: number[] = [];

      // A Gmail SEARCH across All Mail can consume the complete 8-second manual
      // refresh budget on large inboxes. For a click refresh, fetch one bounded
      // tail of lightweight envelopes instead; this reaches newly delivered
      // sign-in and household messages in one round trip and leaves the budget
      // for downloading only genuinely new Netflix bodies.
      if (quickRefresh && hasBudget()) {
        // Keep this deliberately small. Fetching 100 envelopes from Gmail was
        // consuming the complete 8-second budget before a brand-new sign-in
        // or household message body could be downloaded. The latest mail is at
        // the tail, so 20 envelopes is enough for an immediate click refresh;
        // the deeper non-interactive sync still covers the wider history.
        const tailCount = FAST_REFRESH_SCAN_COUNT;
        const tailStart = Math.max(1, totalMessages - (tailCount - 1));
        try {
          for await (const message of client.fetch(`${tailStart}:*`, { envelope: true, uid: true })) {
            if (!hasBudget()) break;
            const fromAddresses = (message.envelope?.from || [])
              .map((sender: any) => String(sender?.address || "").toLowerCase())
              .filter(Boolean);
            if (!fromAddresses.some((address: string) => /@([a-z0-9-]+\.)*netflix\.com$/.test(address))) continue;
            const envelopeMessageId = String(message.envelope?.messageId || "").trim().toLowerCase();
            // All Mail and INBOX use different UIDs for the same message. The
            // Message-ID check prevents old cached mail from consuming body
            // fetch time after switching mailbox paths.
            if (isCached(message.uid) || (envelopeMessageId && cachedMessageIds.has(envelopeMessageId))) {
              skipped++;
              continue;
            }
            netflixUids.push(message.uid);
          }
        } catch (tailErr) {
          console.log(`[${accountLabel}] ${mailboxPath} newest-envelope scan failed:`, tailErr);
        }
      } else if (hasBudget()) {
        const since = new Date();
        since.setDate(since.getDate() - 7);
        try {
          const found = await client.search({ from: "netflix.com", since }, { uid: true });
          if (Array.isArray(found) && found.length > 0) netflixUids.push(...found);
        } catch (searchErr) {
          console.log(`[${accountLabel}] ${mailboxPath} Netflix search failed:`, searchErr);
        }
      }
      const candidates = Array.from(new Set(netflixUids)).sort((a, b) => b - a);
      const scanLimit = quickRefresh ? Math.min(candidates.length, 250) : Math.min(Math.max(candidates.length, maxMessages * 3), 250);
      const fetchLimit = quickRefresh ? QUICK_REFRESH_CANDIDATE_UIDS : clampLimit(maxMessages, USER_REFRESH_MAX_UIDS, FULL_SYNC_MAX_UIDS);
      let uncachedUids: number[] = [];
      for (const uid of candidates.slice(0, scanLimit)) {
        if (isCached(uid)) {
          skipped++;
        } else {
          uncachedUids.push(uid);
        }
        if (uncachedUids.length >= fetchLimit) break;
      }

      const eligibleByAccount = new Map(accountVariants.map((acc) => [acc.label, 0]));
      const allAccountQuotasFilled = () => accountVariants.every(
        (acc) => (eligibleByAccount.get(acc.label) || 0) >= QUICK_REFRESH_MAX_ELIGIBLE_PER_ACCOUNT,
      );

      for (const uid of uncachedUids) {
        if (!hasBudget() || (quickRefresh && allAccountQuotasFilled())) break;
        try {
          const fullMsg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!fullMsg || !fullMsg.source) continue;
          const parsed = await simpleParser(fullMsg.source, { skipImageLinks: true, skipTextLinks: true });
          const bodyText = (parsed.text || "").trim();
          const subjectText = (parsed.subject || fullMsg.envelope?.subject || "").toString();
          const fromText = parsed.from?.text || "";
          if (!isNetflixFrom(fromText)) continue;
          // Some Netflix household templates expose the recipient only in the
          // IMAP envelope or Gmail delivery headers (BCC/aliases), while
          // sign-in-code templates populate the parsed To header. Use all of
          // them so recipient routing cannot discard or misassign fresh mail.
          const toText = parsedRoutingRecipients(parsed, fullMsg.envelope) || undefined;
          const matchedAccount = selectLogicalAccount(toText, accountVariants);
          if (!matchedAccount) {
            recipientSkipped++;
            continue;
          }
          const messageId = String(parsed.messageId || "").trim().toLowerCase();
          if (messageId && cachedMessageIds.has(messageId)) {
            skipped++;
            continue;
          }
          const email = {
            id: makeId(matchedAccount.label, uid),
            message_id: parsed.messageId || null,
            subject: parsed.subject || fullMsg.envelope?.subject || "",
            from: parsed.from?.text || "Netflix",
            to: toText,
            date: parsed.date || new Date(),
            otp: extractOtpCode(subjectText, bodyText),
            preview: redactEmailsText(bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText),
            html: redactEmailsHtml(parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`),
            account_label: matchedAccount.label,
          };
          const visibility = classifyEmailForVisibility(email);
          const eligibleForUser = visibility !== "password_reset" && visibility !== "account_update";
          if (!quickRefresh || !eligibleForUser || (eligibleByAccount.get(matchedAccount.label) || 0) < QUICK_REFRESH_MAX_ELIGIBLE_PER_ACCOUNT) {
            emails.push(email);
            if (messageId) cachedMessageIds.add(messageId);
          }
          if (eligibleForUser) eligibleByAccount.set(matchedAccount.label, (eligibleByAccount.get(matchedAccount.label) || 0) + 1);
        } catch (parseErr) {
          const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          console.error(`[${accountLabel}] ${mailboxPath} fetch error UID ${uid}: ${errMsg}`);
          if (/eof|closed|reset|tls|socket/i.test(errMsg)) break;
        }
      }
    } finally {
      try { lock.release(); } catch {}
    }
  };

  try {
    // ImapFlow's connectionTimeout performs the abort. Closing a socket from a
    // competing timer before it is usable emits an uncaught event-loop error.
    await client.connect();
    console.log(`[${accountLabel}] IMAP connected to ${imapHost}`);
    startedAt = Date.now();
    // Closing the socket is intentional: a boolean timeout cannot interrupt a
    // hung IMAP SEARCH/FETCH, which was leaving the browser loading for minutes.
    timer = setTimeout(() => {
      timedOut = true;
      closeClient();
    }, budgetMs) as unknown as number;

    // INBOX is the latency-critical path for sign-in and household messages.
    // Only fall back to Gmail All Mail when INBOX produced no new rows; doing
    // both on every click consumed the fixed budget and made even OTPs late.
    await scanMailbox("INBOX", "", true);
    if (quickRefresh && emails.length === 0 && /(^|\.)gmail\.com$/i.test(imapHost) && hasBudget()) {
      try {
        await scanMailbox("[Gmail]/All Mail", "all:", false);
      } catch (fallbackErr) {
        if (!timedOut) console.log(`[${accountLabel}] Canonical All Mail fallback unavailable:`, fallbackErr);
      }
    }
  } catch (err) {
    if (!timedOut) throw err;
    console.warn(`[${accountLabel}] IMAP refresh stopped at ${budgetMs}ms budget`);
  } finally {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    if (timer !== undefined) clearTimeout(timer);
    closeClient();
  }

  return { emails, fetched: emails.length, skipped, recipientSkipped, timedOut };
}

async function loadAccounts(supabase: any, secret: string, accountLabels: string[] | null): Promise<Account[]> {
  let accounts: Account[] = [];
  let requested = accountLabels && accountLabels.length > 0
    ? new Set(accountLabels.map((label) => String(label).trim()).filter(Boolean))
    : null;

  try {
    const { data: accountsData } = await supabase.from("app_settings").select("value").eq("key", "email_accounts").single();
    if (Array.isArray(accountsData?.value)) {
      const healedAccounts = await Promise.all(accountsData.value.map(async (acc: any) => {
        const password = acc?.password;
        if (typeof password === "string" && password.length > 0 && !password.startsWith("enc:")) {
          return { ...acc, password: await encryptValue(password, secret) };
        }
        return acc;
      }));
      if (JSON.stringify(healedAccounts) !== JSON.stringify(accountsData.value)) {
        await supabase.from("app_settings").upsert({ key: "email_accounts", value: healedAccounts }, { onConflict: "key" });
      }
      const availableLabels = accountsData.value.map((acc: any) => String(acc.label || acc.user || "").trim()).filter(Boolean);
      if (accountLabels && accountLabels.length > 0) {
        requested = new Set(normalizeAccountLabels(accountLabels, availableLabels));
      }
      const requestedLabels = requested;
      const accountRows = requestedLabels
        ? healedAccounts.filter((acc: any) => requestedLabels.has(String(acc.label || acc.user || "").trim()))
        : healedAccounts;
      const decrypted = await Promise.all(accountRows.map(async (acc: any) => {
        if (!acc.user || !acc.password) return null;
        return {
          label: acc.label || acc.user,
          host: acc.host || "imap.gmail.com",
          port: parseInt(acc.port) || 993,
          user: acc.user,
          password: await decryptValue(acc.password, secret),
          recipientFilters: normalizeRecipientFilters(acc.recipientFilters || acc.recipientFilter || acc.allowedRecipients),
        } as Account;
      }));
      accounts.push(...decrypted.filter(Boolean) as Account[]);
    }
  } catch (err) {
    console.error("[sync] Failed to load email_accounts:", err);
  }

  if (accountLabels && accountLabels.length > 0) {
    const normalized = normalizeAccountLabels(accountLabels, accounts.map((a) => a.label));
    accounts = accounts.filter(a => normalized.includes(a.label));
  }

  return accounts;
}

async function runSync(supabase: any, secret: string, source: string, accountLabels: string[] | null, maxMessages = FULL_SYNC_MAX_UIDS) {
  console.log(`[sync] Starting parallel IMAP sync (source: ${source})`);
  // User-clicked refresh gets the newest-envelope fast path. Full/admin syncs
  // retain the deeper seven-day search. Both paths still use simpleParser, so
  // the stored Netflix HTML remains identical.
  const quickRefresh = source === "user_refresh" || source === "user_refresh_direct";

  try {
    const accounts = await loadAccounts(supabase, secret, accountLabels);
    if (accounts.length === 0) {
      return { success: false, error: "Inbox not configured. Add IMAP email in Admin Panel.", stats: {}, totalFetched: 0, inserted: 0 };
    }

    // Legacy backfill removed: `account_label` is now sourced from real
    // per-account labels; historical NULL rows are left as-is.


    // ---- Dedup cache: keyset-bounded scan of recent IDs.
    // Uses the (date DESC, id DESC) partial index so this is an index-only scan
    // over at most DEDUP_ID_LIMIT rows. No OFFSET, no full-table read.
    const dedupCutoff = new Date();
    dedupCutoff.setDate(dedupCutoff.getDate() - STALE_DAYS);
    const { data: cachedRows } = await supabase
      .from("cached_emails")
      .select("id, message_id")
      .eq("destroyed", false)
      .gte("date", dedupCutoff.toISOString())
      .order("date", { ascending: false })
      .order("id", { ascending: false })
      .limit(DEDUP_ID_LIMIT);
    const cachedIds = new Set<string>((cachedRows || []).map((r: any) => String(r.id)));
    const cachedMessageIds = new Set<string>(
      (cachedRows || []).map((r: any) => String(r.message_id || "").trim().toLowerCase()).filter(Boolean),
    );

    // Several logical accounts may share one Gmail inbox. Opening one parallel
    // IMAP connection per logical label caused socket timeouts and let whichever
    // label finished first own the UID. Fetch each physical inbox once, then
    // route every message to the matching logical account by recipient.
    const physicalGroups = Array.from(accounts.reduce((groups, acc) => {
      const key = `${acc.host}\u0000${acc.port}\u0000${acc.user}\u0000${acc.password}`;
      const group = groups.get(key) || [];
      group.push(acc);
      groups.set(key, group);
      return groups;
    }, new Map<string, Account[]>()).values());

    const settled = await Promise.allSettled(physicalGroups.map(async (group) => {
      const primary = group[0];
      console.log(`[sync] Fetching ${group.map((acc) => acc.label).join(", ")} (${primary.user})`);
      const result = await fetchFromAccount(primary.host, primary.port, primary.user, primary.password, primary.label, cachedIds, cachedMessageIds, maxMessages, quickRefresh, [], group);
      return { group, result };
    }));

    const allEmails: any[] = [];
    const accountErrors: Array<{ label: string; error: string }> = [];
    const syncStats: Record<string, { fetched: number; skipped: number; recipientSkipped?: number; error?: string }> = {};

    settled.forEach((item, index) => {
      const group = physicalGroups[index] || [];
      const label = group.map((acc) => acc.label).join(", ") || `Account ${index + 1}`;
      if (item.status === "fulfilled") {
        for (const acc of group) {
          const fetched = item.value.result.emails.filter((email: any) => email.account_label === acc.label).length;
          syncStats[acc.label] = {
            fetched,
            skipped: item.value.result.skipped,
            recipientSkipped: item.value.result.recipientSkipped,
            ...(item.value.result.timedOut ? { error: "Mail check reached its time limit; partial results were saved" } : {}),
          };
        }
        allEmails.push(...item.value.result.emails);
      } else {
        const errMsg = item.reason instanceof Error ? item.reason.message : String(item.reason);
        const isAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errMsg);
        const errorText = isAuthError ? `IMAP login failed for "${label}". Check email and app password.` : `Failed to connect to "${label}": ${errMsg}`;
        for (const acc of group) syncStats[acc.label] = { fetched: 0, skipped: 0, error: errorText };
        accountErrors.push({ label, error: errorText });
      }
    });

    if (accountErrors.length > 0 && accountErrors.length === physicalGroups.length) {
      const combinedMsg = accountErrors.map(e => e.error).join(" | ");
      console.error("[sync] All accounts failed:", combinedMsg);
      return { success: false, error: combinedMsg, stats: syncStats, totalFetched: 0, inserted: 0 };
    }

    allEmails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    // fetchFromAccount already enforces two eligible rows per logical account.
    // Do not apply a second global cap: it would let the busiest inbox crowd out
    // the other accounts assigned to the same profile.


    let inserted = 0;
    if (allEmails.length > 0) {
      const rows = allEmails.map((e: any) => ({
        id: String(e.id),
        subject: e.subject,
        from_address: e.from,
        to_address: e.to || null,
        date: e.date,
        otp: e.otp || null,
        preview: e.preview || null,
        html: e.html || null,
        account_label: e.account_label || null,
        cached_at: new Date().toISOString(),
        message_id: e.message_id || null,
        destroyed: false,
      }));

      const { error: upsertErr } = await supabase
        .from("cached_emails")
        .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (upsertErr) {
        console.error("[sync] Cache upsert error:", upsertErr);
        return { success: false, error: upsertErr.message, stats: syncStats, totalFetched: allEmails.length, inserted: 0 };
      }
      inserted = rows.length;
    }

    // Never run retention cleanup in the user-click refresh path. Deleting old
    // rows is maintenance work and must not delay delivery of the newest mail.
    if (!quickRefresh) {
      const nowMs = Date.now();
      const last = (globalThis as any).__lastStaleCleanupAt || 0;
      if (nowMs - last >= STALE_CLEANUP_MIN_INTERVAL_MS) {
        (globalThis as any).__lastStaleCleanupAt = nowMs;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - STALE_DAYS);
        const { error: delErr } = await supabase
          .from("cached_emails").delete()
          .lt("date", cutoff.toISOString()).eq("destroyed", false);
        if (delErr) console.error("[sync] Stale cleanup error:", delErr);
      }
    }

    const response: any = {
      success: true,
      emails: allEmails,
      stats: syncStats,
      totalFetched: allEmails.length,
      inserted,
      duplicatesSkipped: Object.values(syncStats).reduce((s: number, v: any) => s + (v.skipped || 0), 0),
    };
    if (accountErrors.length > 0) response.warnings = accountErrors.map(e => e.error);
    const recipientWarnings = Object.entries(syncStats)
      .filter(([, v]: any) => Number(v.recipientSkipped || 0) > 0)
      .map(([label, v]: any) => `${label}: ${v.recipientSkipped} Netflix email skipped by recipient filter`);
    if (recipientWarnings.length > 0) response.warnings = [...(response.warnings || []), ...recipientWarnings];
    const timeoutWarnings = Object.entries(syncStats)
      .filter(([, v]: any) => /time limit/i.test(String(v.error || "")))
      .map(([label]) => `${label}: mail check reached its time limit; partial results were saved`);
    if (timeoutWarnings.length > 0) response.warnings = [...(response.warnings || []), ...timeoutWarnings];
    if (Array.isArray(response.warnings) && response.warnings.length > 0) response.warning = response.warnings.join(" • ");
    console.log(`[sync] Complete: ${allEmails.length} fetched/upserted across ${accounts.length} account(s)`);
    return response;
  } catch (e) {
    console.error("[sync] fatal", e);
    return { success: false, error: e instanceof Error ? e.message : String(e), stats: {}, totalFetched: 0, inserted: 0 };
  }
}

Deno.serve(async (originalReq) => {
  if (originalReq.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ---- transport encryption boundary ----
  // Server-to-server callers may POST plaintext JSON. Browser callers include
  // Sec-Fetch-Site and must still use encrypted transport.
  const CRON_SHARED_SECRET_FOR_TRANSPORT = Deno.env.get("CRON_SHARED_SECRET") || "";
  const SERVICE_ROLE_FOR_TRANSPORT = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const cronHeaderForTransport = originalReq.headers.get("x-cron-secret") || "";
  const authHeaderForTransport = originalReq.headers.get("authorization") || "";
  const sessionTokenForTransport = originalReq.headers.get("x-session-token") || "";
  const secFetchSiteForTransport = originalReq.headers.get("sec-fetch-site") || "";
  const hasValidCronSecret = !!CRON_SHARED_SECRET_FOR_TRANSPORT && cronHeaderForTransport === CRON_SHARED_SECRET_FOR_TRANSPORT;
  const hasServiceRoleBearer = !!SERVICE_ROLE_FOR_TRANSPORT && authHeaderForTransport === `Bearer ${SERVICE_ROLE_FOR_TRANSPORT}`;
  // Trusted server proxies may send plaintext transport; scheduled sources are
  // still rejected explicitly below because email ingestion is manual-only.
  const hasServerSideBearer = /^Bearer\s+\S+/i.test(authHeaderForTransport) && !secFetchSiteForTransport && originalReq.method === "POST";
  const serverLikeSessionProxy = !!sessionTokenForTransport && !secFetchSiteForTransport;
  const allowServerPlaintext = hasValidCronSecret || hasServiceRoleBearer || hasServerSideBearer || serverLikeSessionProxy;
  let ctx: EncryptedRequestContext | null = null;
  let parsedBody: any = null;
  try {
    const r = await readRequest(originalReq, { allowPlaintext: allowServerPlaintext });
    parsedBody = r.body ?? {};
    ctx = r.encrypted ? r.ctx : null;
  } catch (e) {
    if (e instanceof PlaintextRejectedError) return plaintextRejectedResponse();
    if (e instanceof TransportError) return transportErrorResponse(e);
    return new Response(JSON.stringify({ success: false, error: "bad request" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const req = new Request(originalReq.url, {
    method: originalReq.method,
    headers: originalReq.headers,
    body: JSON.stringify(parsedBody ?? {}),
  });
  const __run = async () => {
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // F5: dedicated signing key with legacy fallback (see manage-app).
    // ENCRYPTION_SECRET (=SERVICE_ROLE_KEY) stays for decrypting IMAP passwords in runSync.
    const ENCRYPTION_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SIGNING_SECRET = Deno.env.get("SESSION_SIGNING_SECRET") || ENCRYPTION_SECRET;
    const LEGACY_SIGNING = ENCRYPTION_SECRET;
    const CRON_SHARED_SECRET = Deno.env.get("CRON_SHARED_SECRET") || "";

    let body: any = {};
    try { body = await req.json(); } catch {}
    const mode = body.mode || "sync";
    const source = body.source || "manual";
    const session = await requireSession(req, body, SIGNING_SECRET, LEGACY_SIGNING, supabase);
    const isCronSecret = !!CRON_SHARED_SECRET && req.headers.get("x-cron-secret") === CRON_SHARED_SECRET;


    let filterSignInCodes = false;
    let filterPasswordResets = false;
    let filterAccountUpdates = false;
    try {
      const filterValue: any = await getSetting(supabase, "email_filters");
      if (filterValue) {
        if (filterValue.showSignInCodes === false) filterSignInCodes = true;
        if (filterValue.showPasswordResets === false) filterPasswordResets = true;
        if (filterValue.showAccountUpdates === false) filterAccountUpdates = true;
      }
    } catch {}

    // ⚠️ HARD BLOCK — for any non-admin session, account-change and
    //    password-reset mails are ALWAYS filtered out. Admin toggle
    //    irrelevant. See banner near ACCOUNT_CHANGE_STRONG_RE. DO NOT TOUCH.
    if (session && session.role !== "admin") {
      filterAccountUpdates = true;
      filterPasswordResets = true;
    }


    // Service-role callers are trusted server-to-server maintenance clients.
    // Scheduled sources are still rejected below, so this does not re-enable
    // automatic syncing; it only permits explicit manual/probe sync requests.
    const isCron = isCronSecret || hasServiceRoleBearer;

    // Email ingestion is intentionally user-driven. Reject every scheduled
    // source even if an old Cloudflare/Supabase schedule still calls us.
    if (["cron", "worker-cron", "cron-warm"].includes(source)) {
      return json({ success: false, error: "Automatic email sync is disabled; use manual refresh" }, 403);
    }

    if (mode === "cron_status") {
      if (!session || session.role !== "admin") return json({ success: false, error: "Admin session required" }, 401);
      return json({ active: false, schedule: "", interval: 0, lastSync: null });
    }

    if (mode === "cron_toggle") {
      if (!session || session.role !== "admin") return json({ success: false, error: "Admin session required" }, 401);
      try {
        try { await supabase.rpc("unschedule_email_sync"); } catch {}
        await supabase.from("app_settings").upsert({ key: "cron_config", value: { active: false, interval: 0 } }, { onConflict: "key" });
        invalidateSetting("cron_config");
        return json({ success: true, active: false, interval: 0, message: "Automatic email sync is disabled" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[cron] Toggle error:", msg);
        return json({ success: false, error: msg }, 500);
      }
    }

    if (mode === "cache") {
      if (!session) return json({ success: false, error: "Authentication required" }, 401);
      const accountFilter = await getAssignedAccountFilter(supabase, session);
      const emails = await readCache(supabase, accountFilter, filterSignInCodes, filterPasswordResets, filterAccountUpdates, session, body.limit);
      return json(emails);
    }

    if (mode === "unfiltered_count") {
      if (!session) return json({ success: false, error: "Authentication required" }, 401);
      const accountFilter = await getAssignedAccountFilter(supabase, session);
      if (session.role !== "admin" && accountFilter && accountFilter.length === 0) {
        return json({ total: 0, error: null });
      }
      // count:'planned' uses pg_class.reltuples — O(1), no table scan, no
      // shared-buffer thrash. Slightly stale (updated by autovacuum) but
      // exact accuracy is not required for the header badge.
      let query = supabase.from("cached_emails").select("id", { count: "planned", head: true }).eq("destroyed", false);
      if (accountFilter && accountFilter.length > 0) query = query.in("account_label", accountFilter);
      if (session.role !== "admin") {
        const vis = await getEmailVisibility(supabase);
        if (vis) {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - vis.days);
          query = query.gte("date", cutoff.toISOString());
        }
      }
      const { count, error } = await query;
      return json({ total: count || 0, error: error?.message || null });
    }

    const adminOrCron = (session?.role === "admin") || isCron;
    const userRequestedSync = mode === "user_sync" || mode === "sync_async";
    if (mode === "sync" && !adminOrCron) return json({ success: false, error: "Admin session or cron secret required" }, 401);
    if (userRequestedSync && !session && !isCron) return json({ success: false, error: "Authentication required" }, 401);
    if (!["sync", "sync_async", "user_sync"].includes(mode)) return json({ success: false, error: `Unknown mode: ${mode}` }, 400);

    let accountLabels: string[] | null = null;
    if (Array.isArray(body.accountLabels) && body.accountLabels.length > 0) accountLabels = body.accountLabels;

    if (session && session.role !== "admin") {
      const assigned = await getAssignedAccountFilter(supabase, session);
      // Non-admin user: restrict sync scope to their assigned accounts.
      // Empty assignment -> nothing to sync/display.
      if (assigned && assigned.length === 0) {
        return json({ success: true, accepted: true, emails: [], message: "No accounts assigned" }, mode === "sync_async" ? 202 : 200);
      }
      if (assigned && assigned.length > 0) accountLabels = accountLabels ? accountLabels.filter(l => assigned.includes(l)) : assigned;
      if (mode === "sync_async" && source !== "user_refresh") {
        const last = userSyncHits.get(session.userId) || 0;
        if (Date.now() - last < USER_SYNC_WINDOW_MS) {
          const cache = await readCache(supabase, assigned, filterSignInCodes, filterPasswordResets, filterAccountUpdates, session, body.limit);
          return json({ success: true, rateLimited: true, message: "Please wait before refreshing again", emails: cache }, 202);
        }
        userSyncHits.set(session.userId, Date.now());
      }
    }

    if (mode === "sync_async" && source !== "user_refresh") {
      const accountFilterForCache = session ? await getAssignedAccountFilter(supabase, session) : null;
      const cache = session ? await readCache(supabase, accountFilterForCache, filterSignInCodes, filterPasswordResets, filterAccountUpdates, session, body.limit).catch(() => []) : [];
      const maxMessages = clampLimit(body.limit, USER_REFRESH_MAX_UIDS, FULL_SYNC_MAX_UIDS);
      const work = runSync(supabase, ENCRYPTION_SECRET, source || "async", accountLabels, maxMessages).catch(err => console.error("[sync_async] background failed:", err));
      ((globalThis as any).EdgeRuntime?.waitUntil?.(work) ?? work);
      return json({ success: true, accepted: true, emails: cache }, 202);
    }

    const result = await runSync(supabase, ENCRYPTION_SECRET, source, accountLabels, clampLimit(body.limit, FULL_SYNC_MAX_UIDS, FULL_SYNC_MAX_UIDS));
    if (userRequestedSync && session && result?.success === false) {
      const accountFilterForCache = await getAssignedAccountFilter(supabase, session);
      const cache = await readCache(supabase, accountFilterForCache, filterSignInCodes, filterPasswordResets, filterAccountUpdates, session, body.limit).catch(() => []);
      return json({
        success: true,
        fallback: true,
        warning: result.error || "Mail server is temporarily unavailable",
        emails: cache,
        stats: result.stats || {},
        totalFetched: Array.isArray(cache) ? cache.length : 0,
        inserted: 0,
      });
    }
    if (!session && isCron && result?.success !== false) {
      return json({
        success: true,
        source,
        stats: result.stats || {},
        totalFetched: result.totalFetched || 0,
        inserted: result.inserted || 0,
        duplicatesSkipped: result.duplicatesSkipped || 0,
      });
    }
    if (session && session.role !== "admin" && result?.success !== false) {
      const accountFilterForCache = await getAssignedAccountFilter(supabase, session);
      result.emails = await readCache(supabase, accountFilterForCache, filterSignInCodes, filterPasswordResets, filterAccountUpdates, session, body.limit).catch(() => []);
      result.totalFetched = Array.isArray(result.emails) ? result.emails.length : 0;
    }
    return json(result, result.success === false ? 502 : 200);
  } catch (err) {
    console.error("[sync] Fatal error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isImapAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errorMessage);
    return json({
      success: false,
      error: isImapAuthError
        ? "IMAP login failed. Check the inbox email address and app password in Admin Panel."
        : `Failed to fetch emails: ${errorMessage}`,
    }, isImapAuthError ? 401 : 500);
  }
  };
  const res = await __run();
  return await maybeEncryptResponse(res, ctx);
});

