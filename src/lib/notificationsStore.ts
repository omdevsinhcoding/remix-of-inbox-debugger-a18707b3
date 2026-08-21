// Notifications singleton store — one poll for all subscribers.
//
// Fixes the 5-TB/month egress catastrophe caused by two independent
// setInterval(30_000) loops per logged-in user hitting list_notifications.
//
// - Single poll for the whole tab (bell + auto-popup + anywhere else)
// - 90s interval (was 30s × 2 hooks = effective 15s)
// - Only ticks while document is visible; polls on focus for freshness
// - Sends last known etag so server can return 304-equivalent (~200 B)
// - Dedupes concurrent refresh calls
//
// At 5000 users this drops notification egress from ~2.6 TB/month to
// well under free-tier limits (combined with server etag + CF worker cache).

import { listNotificationsWithEtag, type AppNotification } from "./bootstrap";

type Listener = (items: AppNotification[], loading: boolean) => void;

const POLL_INTERVAL_MS = 90_000;

let items: AppNotification[] = [];
let etag: string | null = null;
let loading = false;
let inflight = false;
let currentUserId: string | null = null;
let version = 0;
const listeners = new Set<Listener>();

let pollTimer: number | null = null;
let visibilityBound = false;

function emit() {
  for (const fn of listeners) {
    try { fn(items, loading); } catch { /* isolate subscriber errors */ }
  }
}

export async function refreshNotifications(force = false): Promise<void> {
  if (inflight) return;
  inflight = true;
  const runVersion = version;
  const runUserId = currentUserId;
  const wasEmpty = items.length === 0;
  if (wasEmpty) { loading = true; emit(); }
  try {
    const res = await listNotificationsWithEtag(force ? null : etag);
    if (runVersion !== version || runUserId !== currentUserId) return;
    if (!res.unchanged) {
      items = res.notifications;
      etag = res.etag;
      emit();
    } else if (res.etag && res.etag !== etag) {
      etag = res.etag;
    }
  } catch {
    // swallow — surface via empty state, never leave the spinner stuck.
  } finally {
    // ALWAYS clear inflight + loading, even if the profile switched mid-flight.
    // Previously the early-return here left `inflight=true` forever → new
    // profile's bell spun with no new fetch ever firing.
    inflight = false;
    if (loading) {
      loading = false;
      emit();
    }
  }
}


export function resetNotifications(userId: string | null = null): void {
  currentUserId = userId;
  version++;
  items = [];
  etag = null;
  loading = false;
  inflight = false;
  emit();
}

function startPollingIfNeeded() {
  if (pollTimer != null) return;
  if (typeof window === "undefined") return;
  pollTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void refreshNotifications();
  }, POLL_INTERVAL_MS);
  if (!visibilityBound) {
    visibilityBound = true;
    window.addEventListener("focus", () => void refreshNotifications());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void refreshNotifications();
    });
  }
}

function stopPollingIfIdle() {
  if (listeners.size === 0 && pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function subscribeNotifications(fn: Listener, userId: string | null = null): () => void {
  if (userId !== currentUserId) resetNotifications(userId);
  listeners.add(fn);
  // Immediate hydrate from current snapshot.
  try { fn(items, loading); } catch {}
  startPollingIfNeeded();
  // Any first subscriber for the current profile triggers fetch; `inflight`
  // dedupes bell + auto-popup mounting together.
  if (items.length === 0 && !inflight) {
    void refreshNotifications(true);
  }
  return () => {
    listeners.delete(fn);
    stopPollingIfIdle();
  };
}

export function getNotificationsSnapshot(): AppNotification[] {
  return items;
}

// Invalidate cache and refetch — called after mark_read / delete etc.
export function invalidateNotifications(): void {
  etag = null;
  void refreshNotifications(true);
}
