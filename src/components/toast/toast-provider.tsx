import { AlertTriangle, Check, Info, LoaderCircle, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { type GlobalToast, notify, toastStore } from "./notify";

type CardTone = "light" | "dark";

const ICONS = {
  success: Check,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  loading: LoaderCircle,
};

/* ---------- surface-aware card tone ----------
   light page  -> dark toast card
   dark page   -> light toast card
   The name here is the CARD tone, not the page tone. */

function parseRgb(value: string): [number, number, number, number] | null {
  if (!value || value === "transparent") return null;
  const m = value.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?\)/i);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

function luminance([r, g, b]: [number, number, number, number]) {
  const toLin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function sampleAt(x: number, y: number): number | null {
  const stack = document.elementsFromPoint(x, y);
  for (const el of stack) {
    if ((el as HTMLElement).closest?.("[data-global-toast-root]")) continue;
    let node: Element | null = el;
    while (node) {
      const rgba = parseRgb(window.getComputedStyle(node).backgroundColor);
      if (rgba && rgba[3] >= 0.2) return luminance(rgba);
      node = node.parentElement;
    }
  }
  return null;
}

function getCardTone(): CardTone {
  if (typeof window === "undefined" || typeof document === "undefined") return "light";
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Sample around the toast anchor first, then the main visible page.
  const samples: number[] = [];
  const points: Array<[number, number]> = [
    [Math.max(16, w - 56), Math.max(16, h - 56)],
    [Math.max(16, w - 220), Math.max(16, h - 96)],
    [Math.max(16, w - 120), Math.floor(h / 2)],
    [Math.floor(w / 2), Math.floor(h / 2)],
    [Math.floor(w / 2), Math.max(24, h - 120)],
  ];
  for (const [x, y] of points) {
    const l = sampleAt(x, y);
    if (l !== null) samples.push(l);
  }
  if (samples.length === 0) {
    const bodyRgba = parseRgb(window.getComputedStyle(document.body).backgroundColor);
    if (bodyRgba) samples.push(luminance(bodyRgba));
  }
  if (samples.length === 0) return "light";
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return avg > 0.46 ? "dark" : "light";
}

/* ---------- individual compact card ---------- */

function ToastCard({ toast, tone }: { toast: GlobalToast; tone: CardTone }) {
  const Icon = ICONS[toast.variant];
  return (
    <div className="gt-toast" data-card={tone} data-variant={toast.variant} data-has-action={toast.action ? "true" : "false"} role={toast.variant === "error" ? "alert" : "status"} aria-live={toast.variant === "error" ? "assertive" : "polite"}>
      <div className="gt-toast-icon" aria-hidden="true">
        <Icon />
      </div>
      <div className="gt-toast-copy">
        {toast.title ? <div className="gt-toast-title">{toast.title}</div> : null}
        {toast.description ? <div className="gt-toast-desc">{toast.description}</div> : null}
      </div>
      {toast.action ? (
        <button
          className="gt-toast-action"
          type="button"
          onClick={() => {
            try { toast.action?.onClick(); } finally { notify.dismiss(toast.id); }
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        className="gt-toast-close"
        type="button"
        aria-label="Dismiss notification"
        onClick={() => notify.dismiss(toast.id)}
      >
        <X />
      </button>
    </div>
  );
}

/* ---------- provider ---------- */

export function ToastProvider() {
  const [toasts, setToasts] = useState<GlobalToast[]>(() => toastStore.getSnapshot());
  const [tone, setTone] = useState<CardTone>(() => (typeof window === "undefined" ? "light" : getCardTone()));

  useEffect(() => toastStore.subscribe(setToasts), []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    let raf = 0;
    const update = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => setTone(getCardTone()));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer.disconnect();
    };
  }, []);

  // Re-sample whenever a new toast arrives (route changes usually trigger a toast).
  useEffect(() => {
    if (typeof window !== "undefined") setTone(getCardTone());
  }, [toasts.length]);

  // Hide toasts entirely while the notification panel is open — notifications
  // are the primary surface, toasts must not overlay them.
  const [notifOpen, setNotifOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpen = () => setNotifOpen(true);
    const onClose = () => setNotifOpen(false);
    window.addEventListener("notif:open", onOpen);
    window.addEventListener("notif:close", onClose);
    return () => {
      window.removeEventListener("notif:open", onOpen);
      window.removeEventListener("notif:close", onClose);
    };
  }, []);

  const root = useMemo(() => (typeof document === "undefined" ? null : document.body), []);
  if (!root || toasts.length === 0 || notifOpen) return null;

  return createPortal(
    <div className="gt-toast-viewport" data-global-toast-root="true">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} tone={tone} />
      ))}
    </div>,
    root,
  );
}

export default ToastProvider;
