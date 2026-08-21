import { supabase } from "../integrations/supabase/client";
import { setAvatarBaseUrl } from "./avatars";
import { sessionGet, sessionSet, clearBrowserIdentityNow, nukeBrowserIdentity } from "./session";


const WORKER_URLS_KEY = "cloudflare_worker_urls";
const BOOTSTRAP_CACHE_KEY = "bootstrap_cache_v1";
const BOOTSTRAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 20000;

export type EmailFilters = { showSignInCodes?: boolean; showPasswordResets?: boolean; showAccountUpdates?: boolean };
export type MaintenanceInfo = { enabled: boolean; title?: string; message?: string; eta?: string; startsAt?: string | null; endsAt?: string | null; versionFrom?: string; versionTo?: string; updated_at?: string | null };
export type FreeAvatarCooldown = { minutes: number; lastAt: string | null };
export type LocationPolicy = { required: boolean };
export type TvFeature = { enabled: boolean };
export type ContactInfo = { telegram: string; whatsapp: string; email: string; note: string };
export type BootstrapResult = { users: any[]; recaptcha: any; workerUrls: string[]; emailFilters?: EmailFilters; maintenance?: MaintenanceInfo; avatarBaseUrl?: string; freeAvatarCooldown?: FreeAvatarCooldown; locationPolicy?: LocationPolicy; tvFeature?: TvFeature; contactInfo?: ContactInfo; serverNow?: string };

// Module-level free-avatar cooldown cache — kept in sync with bootstrap.
let currentFreeAvatarCooldown: FreeAvatarCooldown = { minutes: 5, lastAt: null };
export function getFreeAvatarCooldown(): FreeAvatarCooldown { return currentFreeAvatarCooldown; }
export function setFreeAvatarCooldown(next: FreeAvatarCooldown | null | undefined) {
  const minutes = Number(next?.minutes);
  currentFreeAvatarCooldown = {
    minutes: Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 5,
    lastAt: typeof next?.lastAt === "string" ? next.lastAt : null,
  };
}


// Module-level filter cache — read synchronously by filterVisibleEmails.
const DEFAULT_EMAIL_FILTERS: Required<EmailFilters> = { showSignInCodes: true, showPasswordResets: true, showAccountUpdates: true };
function normalizeEmailFilters(value: EmailFilters | null | undefined): Required<EmailFilters> {
  const v = value && typeof value === "object" ? value : {};
  return {
    showSignInCodes: v.showSignInCodes === false ? false : true,
    showPasswordResets: v.showPasswordResets === false ? false : true,
    showAccountUpdates: v.showAccountUpdates === false ? false : true,
  };
}
let currentEmailFilters: EmailFilters = DEFAULT_EMAIL_FILTERS;
export function getEmailFilters(): EmailFilters { return currentEmailFilters; }
export function setEmailFilters(next: EmailFilters) {
  // Replace with a full normalized object instead of merging. Defaults show mail;
  // only an explicit admin OFF (`false`) hides that category.
  currentEmailFilters = normalizeEmailFilters(next);
  try { localStorage.removeItem("email_filters_cache_v1"); } catch {}
}

function sanitizeBootstrapUsers(users: any[]): any[] {
  if (!Array.isArray(users)) return [];
  return users.map((u) => {
    if (!u || typeof u !== "object") return u;
    const username = typeof u.username === "string" ? u.username : null;
    const legacyGeneratedFreeUsername = !!u.isFree && !!username && /^free_[a-z0-9]+_[a-z0-9]+$/i.test(username);
    const rawFeatures = u.features && typeof u.features === "object" ? u.features : {};
    const features = {
      gmail: rawFeatures.gmail !== undefined ? rawFeatures.gmail !== false : u.feature_gmail !== false,
      tv: rawFeatures.tv !== undefined ? rawFeatures.tv !== false : u.feature_tv !== false,
      link: rawFeatures.link !== undefined ? rawFeatures.link === true : u.feature_link === true,
    };
    return {
      ...u,
      ...(legacyGeneratedFreeUsername ? { username: null } : {}),
      feature_gmail: features.gmail,
      feature_tv: features.tv,
      feature_link: features.link,
      features,
    };
  });
}

function storeWorkerUrls(urls: string[]) {
  try {
    localStorage.setItem(WORKER_URLS_KEY, JSON.stringify(urls));
  } catch {}
}

export function markSessionStart() {
  try { sessionSet("session_started_at" as any, String(Date.now())); } catch {}
}

export function revokeSessionInBackground() {
  try {
    const token = sessionGet("session_token" as any);
    if (!token) return;
    import("./secureTransport")
      .then(({ invokeEdge }) => invokeEdge("manage-app", { action: "logout" }, { headers: { "X-Session-Token": token } }))
      .catch(() => {});
  } catch {}
}

// Instant "click-and-done" logout. Netflix-style:
//   1. Fire server logout + browser deep-purge in background (no await).
//   2. Wipe local session state synchronously so app re-hydrates as signed-out.
//   3. Kick off a background fetch('/clearcookies') so the origin's
//      `Clear-Site-Data: "*"` response header purges httpOnly cookies + caches
//      without doing a top-level navigation (which was reload-looping and
//      caused the 10-30 s "stuck" screen).
//   4. Hard-replace to `/` immediately.
export function fastClearCookiesRedirect() {
  revokeSessionInBackground();
  try { clearBrowserIdentityNow(); } catch {}
  try { nukeBrowserIdentity().catch(() => {}); } catch {}
  try {
    // keepalive lets the fetch survive the navigation on the next line.
    fetch("/clearcookies", { method: "GET", cache: "no-store", credentials: "same-origin", keepalive: true }).catch(() => {});
  } catch {}
  const dest = "/?_cc=" + Date.now();
  try { window.location.replace(dest); } catch { try { window.location.href = dest; } catch {} }
}




export function readBootstrapCache(): BootstrapResult | null {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > BOOTSTRAP_CACHE_TTL_MS) return null;
    const contactInfo: ContactInfo = parsed.contactInfo && typeof parsed.contactInfo === "object"
      ? { telegram: String(parsed.contactInfo.telegram || ""), whatsapp: String(parsed.contactInfo.whatsapp || ""), email: String(parsed.contactInfo.email || ""), note: String(parsed.contactInfo.note || "") }
      : { telegram: "", whatsapp: "", email: "", note: "" };
    const result = { users: sanitizeBootstrapUsers(parsed.users || []), recaptcha: parsed.recaptcha, workerUrls: parsed.workerUrls || [], emailFilters: DEFAULT_EMAIL_FILTERS, maintenance: parsed.maintenance, avatarBaseUrl: parsed.avatarBaseUrl || "", freeAvatarCooldown: parsed.freeAvatarCooldown || { minutes: 5, lastAt: null }, locationPolicy: { required: parsed.locationPolicy?.required !== false }, tvFeature: { enabled: parsed.tvFeature?.enabled !== false }, contactInfo };
    setFreeAvatarCooldown(result.freeAvatarCooldown);
    setAvatarBaseUrl(result.avatarBaseUrl);
    return result;
  } catch { return null; }
}

function writeBootstrapCache(result: BootstrapResult) {
  try {
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify({ ...result, savedAt: Date.now() }));
  } catch {}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bootstrap timed out")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

let bootstrapInFlight: Promise<BootstrapResult> | null = null;

// Persisted ETag from the last worker/edge bootstrap response.
// Enables `If-None-Match` requests that come back as HTTP 304 (no body,
// no upstream DB read) whenever the settings/users snapshot is unchanged.
const BOOTSTRAP_ETAG_KEY = "bootstrap_etag_v1";
function readBootstrapEtag(): string | null {
  try { return localStorage.getItem(BOOTSTRAP_ETAG_KEY); } catch { return null; }
}
function writeBootstrapEtag(etag: string | null) {
  try {
    if (etag) localStorage.setItem(BOOTSTRAP_ETAG_KEY, etag);
    else localStorage.removeItem(BOOTSTRAP_ETAG_KEY);
  } catch {}
}

// Try the Cloudflare worker's `/api/bootstrap` first. It fronts the edge
// function with a shared KV cache + ETag so most calls resolve as a 304
// (no DB read, no payload transfer). Falls back to `invokeEdge` on any
// failure so the picker never breaks if the worker is misconfigured.
async function fetchBootstrapViaWorker(): Promise<any | null> {
  const workerUrls = (() => {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(WORKER_URLS_KEY) : null;
      const arr = raw ? JSON.parse(raw) : null;
      return Array.isArray(arr) ? arr.filter((s: any) => typeof s === "string" && s.length > 0) : [];
    } catch { return []; }
  })();
  if (workerUrls.length === 0) return null;
  const etag = readBootstrapEtag();
  for (const base of workerUrls) {
    try {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch(`${base.replace(/\/+$/, "")}/api/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(etag ? { "If-None-Match": `"${etag}"` } : {}),
        },
        body: "{}",
        signal: ctrl.signal,
      }).finally(() => window.clearTimeout(timer));
      // 304 — nothing changed. Use the cached bootstrap payload.
      if (res.status === 304) {
        const cached = readBootstrapCache();
        if (cached) return { ...cached, success: true, __from304: true };
        // No local cache to pair with the 304 — force a full re-fetch.
        continue;
      }
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.success) continue;
      const nextEtag = (res.headers.get("etag") || "").replace(/^W\//, "").replace(/^"|"$/g, "") || (data.etag || "");
      if (nextEtag) writeBootstrapEtag(nextEtag);
      return data;
    } catch {
      // try next worker
    }
  }
  return null;
}

export async function bootstrapFromSupabase(opts?: { force?: boolean }): Promise<BootstrapResult> {
  if (!opts?.force) {
    const cached = readBootstrapCache();
    if (cached) return cached;
    if (bootstrapInFlight) return bootstrapInFlight;
  }

  const request = (async () => {
    let data: any = await fetchBootstrapViaWorker();
    if (!data) {
      const { invokeEdge } = await import("./secureTransport");
      data = await withTimeout(
        invokeEdge("manage-app", { action: "bootstrap_public" }),
        BOOTSTRAP_TIMEOUT_MS,
      );
      if (data?.etag) writeBootstrapEtag(data.etag);
    }
    if (!data?.success) throw new Error(data?.error || "Bootstrap failed");

    if (Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
      storeWorkerUrls(data.workerUrls);
    }

    const contactInfo: ContactInfo = data.contactInfo && typeof data.contactInfo === "object"
      ? { telegram: String(data.contactInfo.telegram || ""), whatsapp: String(data.contactInfo.whatsapp || ""), email: String(data.contactInfo.email || ""), note: String(data.contactInfo.note || "") }
      : { telegram: "", whatsapp: "", email: "", note: "" };
    const result: BootstrapResult = { users: sanitizeBootstrapUsers(data.users || []), recaptcha: data.recaptcha, workerUrls: data.workerUrls || [], emailFilters: normalizeEmailFilters(data.emailFilters), maintenance: data.maintenance || { enabled: false }, avatarBaseUrl: data.avatarBaseUrl || "", freeAvatarCooldown: data.freeAvatarCooldown || { minutes: 5, lastAt: null }, locationPolicy: { required: data.locationPolicy?.required !== false }, tvFeature: { enabled: data.tvFeature?.enabled !== false }, contactInfo, serverNow: typeof data.serverNow === "string" ? data.serverNow : undefined };
    setAvatarBaseUrl(result.avatarBaseUrl);
    setEmailFilters(result.emailFilters || DEFAULT_EMAIL_FILTERS);
    setFreeAvatarCooldown(result.freeAvatarCooldown);
    writeBootstrapCache(result);
    return result;
  })();

  if (!opts?.force) bootstrapInFlight = request;
  try {
    return await request;
  } finally {
    if (bootstrapInFlight === request) bootstrapInFlight = null;
  }
}



export const bootstrapPromise: Promise<BootstrapResult> = bootstrapFromSupabase().catch((err) => {
  console.warn("[bootstrap] prefetch failed:", err);
  const cached = readBootstrapCache();
  if (cached) return cached;
  return { users: [], recaptcha: null, workerUrls: [] };
});

// Force-refresh: always hits the network, updates cache, returns fresh result.
export async function refreshBootstrap(): Promise<BootstrapResult> {
  try {
    return await bootstrapFromSupabase({ force: true });
  } catch (err) {
    console.warn("[bootstrap] refresh failed:", err);
    const cached = readBootstrapCache();
    if (cached) return cached;
    return { users: [], recaptcha: null, workerUrls: [] };
  }
}

// Patch a single user's fields in the cached bootstrap so the next mount
// renders the new avatar/prefs instantly (no wait for network).
export function patchBootstrapCacheUser(userId: string, patch: Record<string, any>) {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.users)) return;
    parsed.users = parsed.users.map((u: any) => (u && u.id === userId ? { ...u, ...patch } : u));
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify(parsed));
  } catch {}
}

// ---------- Notifications helpers ----------
export type NotificationCategory = "announcement" | "update" | "security" | "maintenance" | "promo" | "billing";
export type NotificationPriority = "low" | "normal" | "high" | "critical";

export type AppNotification = {
  id: string;
  title: string;
  body: string;
  description?: string | null;
  
  image_url?: string | null;
  category?: NotificationCategory | string;
  priority?: NotificationPriority | string;
  icon?: string | null;
  platform_icon?: string | null;
  kind?: "flash" | string;
  sub_kind?: string | null;
  locked?: boolean;
  show_frequency?: "once" | "always" | "session" | "daily" | string | null;
  mode?: "popup" | "silent" | "banner" | string | null;
  action_url?: string | null;
  action_label?: string | null;
  action2_url?: string | null;
  action2_label?: string | null;
  
  audience: "all" | "user";
  created_at: string;
  expires_at: string | null;
  publish_at?: string | null;
  read: boolean;
  seen?: boolean;
  
  snoozed_until?: string | null;
};

async function callManage<T = any>(action: string, payload: Record<string, any> = {}): Promise<T> {
  const token = sessionGet("session_token" as any);
  const headers: Record<string, string> = {};
  if (token) headers["X-Session-Token"] = token;
  const { invokeEdge } = await import("./secureTransport");
  const data: any = await invokeEdge("manage-app", { action, ...payload }, { headers });
  if (!data?.success) throw new Error(data?.error || `${action} failed`);
  return data as T;
}

export type NotificationsResult = {
  notifications: AppNotification[];
  etag: string | null;
  unchanged: boolean;
};

// Etag-aware fetch: send last etag, receive {unchanged:true} + empty list, or fresh list + new etag.
// Prefers the Cloudflare worker (`/api/notifications/list`) when configured —
// it holds a 60 s per-user KV cache that cuts Supabase invocations ~95%.
export async function listNotificationsWithEtag(etag: string | null): Promise<NotificationsResult> {
  const token = sessionGet("session_token" as any);
  const workerUrls = getWorkerUrlsFromCache();
  // Try worker first (only if we have both a session token AND a worker URL).
  if (token && workerUrls.length > 0) {
    for (const base of workerUrls) {
      try {
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(`${base.replace(/\/+$/, "")}/api/notifications/list`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Token": String(token),
          },
          body: JSON.stringify(etag ? { if_etag: etag } : {}),
          signal: ctrl.signal,
        }).finally(() => window.clearTimeout(timer));
        if (!res.ok) continue;
        const data = await res.json();
        if (!data?.success) continue;
        return {
          notifications: data.notifications || [],
          etag: data.etag || null,
          unchanged: !!data.unchanged,
        };
      } catch {
        // fall through to next worker or Supabase
      }
    }
  }
  try {
    let timer: number | null = null;
    const data = await Promise.race([
      callManage<{ notifications?: AppNotification[]; etag?: string; unchanged?: boolean }>("list_notifications", etag ? { if_etag: etag } : {}),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("notifications timeout")), 6000); }),
    ]).finally(() => { if (timer != null) window.clearTimeout(timer); });
    return {
      notifications: data.notifications || [],
      etag: data.etag || null,
      unchanged: !!data.unchanged,
    };
  } catch (err) {
    console.warn("[notifications] list failed:", err);
    return { notifications: [], etag: null, unchanged: false };
  }
}

// Fire-and-forget worker cache invalidation (best-effort).
async function invalidateWorkerNotifsCache(): Promise<void> {
  const token = sessionGet("session_token" as any);
  const workerUrls = getWorkerUrlsFromCache();
  if (!token || workerUrls.length === 0) return;
  await Promise.allSettled(workerUrls.map((base) =>
    fetch(`${base.replace(/\/+$/, "")}/api/notifications/invalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Token": String(token) },
    }).catch(() => {})
  ));
}

function getWorkerUrlsFromCache(): string[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(WORKER_URLS_KEY) : null;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.trim().length > 0) : [];
  } catch { return []; }
}



// Fire-and-forget cache buster shared by every mutation below.
// Ensures the singleton store re-fetches with a fresh etag after any write,
// and the Cloudflare worker's per-user KV entry is dropped so the next poll
// isn't served stale.
function bustNotifStore() {
  import("./notificationsStore").then(({ invalidateNotifications }) => invalidateNotifications()).catch(() => {});
  invalidateWorkerNotifsCache().catch(() => {});
}


export async function markNotificationRead(id: string): Promise<void> {
  try { await callManage("mark_notification_read", { notification_id: id }); } finally { bustNotifStore(); }
}
export async function markAllNotificationsRead(): Promise<void> {
  try { await callManage("mark_all_notifications_read"); } finally { bustNotifStore(); }
}
export async function markNotificationSeen(ids: string[]): Promise<void> {
  if (!ids?.length) return;
  try { await callManage("mark_notifications_seen", { ids }); } finally { bustNotifStore(); }
}
export async function deleteNotificationForMe(id: string): Promise<void> {
  try { await callManage("user_delete_notification", { notification_id: id }); } finally { bustNotifStore(); }
}

// snoozeNotification removed — Snooze is no longer a supported user action.

export async function logNotificationEvent(id: string, event: string, meta?: any): Promise<void> {
  try { await callManage("log_notification_event", { notification_id: id, event, meta }); } catch {}
}

// User-side inbox clearing is fully disabled. Only admins can suppress
// emails (server-side via `destroyed=true`). This helper is kept as a no-op
// to preserve any legacy import site; it never touches the server.
export async function clearMyInbox(_visibleIds: string[]): Promise<any> {
  return { success: false, disabled: true };
}

// ---------- Admin: per-notification recipients ----------
export type NotificationRecipient = {
  user_id: string;
  username: string;
  name: string;
  profileAvatar?: string | null;
  seen_at: string | null;
  read_at: string | null;
  clicked_at: string | null;
  deleted_at: string | null;
};

export async function adminListRecipients(notificationId: string): Promise<NotificationRecipient[]> {
  const data = await callManage<{ recipients: NotificationRecipient[] }>("admin_notification_recipients", { notification_id: notificationId });
  return data.recipients || [];
}

export async function adminDeleteNotificationForUser(notificationId: string, userId: string): Promise<void> {
  await callManage("admin_delete_notification_for_user", { notification_id: notificationId, user_id: userId });
}

// Auto-popup dedupe: scoped per logged-in profile. A global key made newly-created
// profiles skip the first notification if the same browser had already popped it.
const POPUP_SEEN_KEY = "notif_popup_seen_v1";

function popupSeenKey(): string {
  try {
    const rawUser = sessionGet("user" as any);
    const userId = rawUser ? JSON.parse(rawUser)?.id : null;
    if (userId) return `${POPUP_SEEN_KEY}:${userId}`;
    const token = sessionGet("session_token" as any);
    if (token) return `${POPUP_SEEN_KEY}:token:${String(token).slice(0, 16)}`;
  } catch {}
  return POPUP_SEEN_KEY;
}

export function getPoppedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(popupSeenKey());
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
export function markPopped(id: string) {
  try {
    const s = getPoppedIds();
    s.add(id);
    const arr = Array.from(s).slice(-200);
    localStorage.setItem(popupSeenKey(), JSON.stringify(arr));
  } catch {}
}



