// Session state store — in-memory primary, sessionStorage mirror for
// per-tab reload survival. NEVER touches localStorage; nothing here
// persists across tab close, and no other tab can read it.
//
// Session keys owned by this module:
//   session_token, refresh_token, session_expires_at, refresh_expires_at,
//   session_family_id, user, admin_auth, admin_backup, pending_admin_token,
//   pending_admin_token_at, session_started_at, cloudflare_worker_urls
//
// Everything else (worker URL cache, stats cache, email cache) still uses
// localStorage — those are non-secret UX caches.

const KEYS = [
  "session_token",
  "refresh_token",
  "session_expires_at",
  "refresh_expires_at",
  "session_family_id",
  "user",
  "admin_auth",
  "admin_backup",
  "pending_admin_token",
  "pending_admin_token_at",
  "session_started_at",
  "cloudflare_worker_urls",
] as const;

type SessionKey = typeof KEYS[number];

// In-memory primary store (never touches disk).
const mem = new Map<string, string>();

function ssGet(k: string): string | null {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function ssSet(k: string, v: string) {
  try { sessionStorage.setItem(k, v); } catch {}
}
function ssRemove(k: string) {
  try { sessionStorage.removeItem(k); } catch {}
}

// One-time migration: if legacy localStorage still holds session keys
// from a previous build, move them into sessionStorage and wipe.
(function migrateFromLocalStorage() {
  try {
    for (const k of KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) {
        ssSet(k, v);
        try { localStorage.removeItem(k); } catch {}
      }
    }
  } catch {}
})();

export function sessionGet(k: SessionKey): string | null {
  if (mem.has(k)) return mem.get(k) ?? null;
  const v = ssGet(k);
  if (v !== null) mem.set(k, v);
  return v;
}

export function sessionSet(k: SessionKey, v: string) {
  mem.set(k, v);
  ssSet(k, v);
}

export function sessionRemove(k: SessionKey) {
  mem.delete(k);
  ssRemove(k);
}

export function sessionClearAll() {
  for (const k of KEYS) sessionRemove(k);
}

// Fast JS-readable cookie purge. The real deep clear is the HTTP
// Clear-Site-Data header on /clearcookies; this is only a local-dev fallback.
export function clearSiteCookies() {
  try {
    if (typeof document === "undefined") return;
    const raw = document.cookie ? document.cookie.split(";") : [];
    const names = new Set<string>();
    for (const chunk of raw) {
      const eq = chunk.indexOf("=");
      const n = (eq >= 0 ? chunk.slice(0, eq) : chunk).trim();
      if (n) names.add(n);
    }
    const host = typeof location !== "undefined" ? location.hostname : "";
    const parts = host.split(".").filter(Boolean);
    const domains: string[] = [""];
    if (host) { domains.push(host); domains.push("." + host); }
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(i).join(".");
      if (d) { domains.push(d); domains.push("." + d); }
    }
    const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
    for (const name of names) {
      for (const d of domains) {
        const base = `${name}=; expires=${expired}; Max-Age=0; path=/${d ? `; domain=${d}` : ""}`;
        try { document.cookie = base; } catch {}
        try { document.cookie = `${base}; SameSite=Lax`; } catch {}
      }
    }
  } catch {}
}

// Netflix-style full identity wipe. Purges every client-visible storage
// surface for this origin: JS-readable cookies, localStorage, sessionStorage,
// IndexedDB, Cache Storage, service workers, and OPFS. HttpOnly cookies must
// be cleared server-side (manage-app logout) — this helper is the browser
// half of that flow.
//
// NOTE: The primary purge mechanism is the `Clear-Site-Data: "*"` HTTP header
// on the /clearcookies route (see netlify.toml / vercel.json). This JS wipe
// is a belt-and-suspenders fallback for local dev and hosts that strip the
// header. Order matters: unregister service workers FIRST so nothing can
// re-populate caches while we're clearing them.
export async function nukeBrowserIdentity(): Promise<void> {
  // 1. Kill service workers first — otherwise a live SW can re-cache assets
  //    (and hold onto IDB handles) while we're wiping.
  try {
    if (typeof navigator !== "undefined" && navigator.serviceWorker?.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch {}
  // 2. Cookies (JS-readable) — first pass, before storage wipes so cookies
  //    that only appear after state changes are still enumerable.
  try { clearSiteCookies(); } catch {}
  // 3. localStorage / sessionStorage / in-memory session mirror.
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  mem.clear();
  // 4. IndexedDB — enumerate via `databases()` (Chromium/Safari) and fall
  //    back to a known-name list for Firefox (which doesn't implement it).
  try {
    const idb: any = (typeof indexedDB !== "undefined" ? indexedDB : null);
    if (idb) {
      let names = new Set<string>();
      if (typeof idb.databases === "function") {
        const dbs: Array<{ name?: string }> = await idb.databases().catch(() => []);
        for (const db of dbs) if (db?.name) names.add(db.name);
      }
      // Firefox fallback + any app-specific DBs we've ever created.
      ["inbox-cache-v1", "inbox-cache", "keyval-store", "localforage", "workbox-precache-v2", "workbox-runtime"].forEach((n) => names.add(n));
      await Promise.all(Array.from(names).map((name) => new Promise<void>((resolve) => {
        try {
          const req = idb.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
          setTimeout(resolve, 250); // never hang the background wipe
        } catch { resolve(); }
      })));
    }
  } catch {}
  // 5. Cache Storage (SW-managed HTTP cache).
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys().catch(() => [] as string[]);
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch {}
  // 6. Origin Private File System — modern browsers store files here that
  //    don't show up in localStorage/IDB. Purge recursively.
  try {
    const storage: any = (typeof navigator !== "undefined" ? (navigator as any).storage : null);
    if (storage?.getDirectory) {
      const root: any = await storage.getDirectory().catch(() => null);
      if (root?.entries) {
        for await (const [name] of root.entries()) {
          try { await root.removeEntry(name, { recursive: true }); } catch {}
        }
      }
    }
  } catch {}
}

// Fast logout path: clear everything the app can clear synchronously, then let
// the /clearcookies response header finish the deep browser wipe in production.
export function clearBrowserIdentityNow(): void {
  try { clearSiteCookies(); } catch {}
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  mem.clear();
}

// Convenience getters.
export const getSessionToken = () => sessionGet("session_token");
export const getUserRaw = () => sessionGet("user");
