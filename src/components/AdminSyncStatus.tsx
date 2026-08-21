import { useEffect, useState } from "react";
import type { SyncState } from "../lib/adminSettingsCache";

// Small floating pill (bottom-right) that shows the current admin-settings
// sync state. Auto-hides after "saved" for 2s so it doesn't clutter the UI.
export function AdminSyncStatus() {
  const [state, setState] = useState<SyncState>({ kind: "idle" });

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SyncState>).detail;
      if (!detail) return;
      setState(detail);
      if (detail.kind === "saved") {
        window.setTimeout(() => setState({ kind: "idle" }), 2000);
      }
    };
    window.addEventListener("admin-sync-status", handler as EventListener);
    return () => window.removeEventListener("admin-sync-status", handler as EventListener);
  }, []);

  if (state.kind === "idle") return null;

  const styles: Record<SyncState["kind"], { bg: string; dot: string; label: string }> = {
    idle: { bg: "", dot: "", label: "" },
    "loading-local": { bg: "rgba(59,130,246,0.14)", dot: "#60a5fa", label: "Loading from cache…" },
    "syncing-server": { bg: "rgba(59,130,246,0.14)", dot: "#60a5fa", label: "Syncing with server…" },
    saved: { bg: "rgba(34,197,94,0.16)", dot: "#4ade80", label: "Saved" },
    "stale-refetching": { bg: "rgba(234,179,8,0.18)", dot: "#facc15", label: "Cache stale — refetching…" },
    error: { bg: "rgba(244,63,94,0.18)", dot: "#f43f5e", label: state.kind === "error" ? state.message : "" },
  };
  const s = styles[state.kind];
  const spinning = state.kind === "loading-local" || state.kind === "syncing-server" || state.kind === "stale-refetching";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 2147483000,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 14px",
        borderRadius: 999,
        background: s.bg,
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "rgba(255,255,255,0.92)",
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: 0.2,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        pointerEvents: "none",
        maxWidth: 320,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: s.dot,
          boxShadow: `0 0 10px ${s.dot}`,
          animation: spinning ? "adminSyncPulse 1.2s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.label}</span>
      <style>{`@keyframes adminSyncPulse { 0%,100%{opacity:.4} 50%{opacity:1} }`}</style>
    </div>
  );
}
