import React, { useState, useEffect, createContext, useContext, useCallback, useRef, useMemo, Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { Mail, RefreshCw, ShieldCheck, Shield, Clock, AlertCircle, Copy, Check, ArrowLeft, Lock, Key, LogOut, Settings, Plus, Users, Trash2, CheckCircle2, X, Eye, EyeOff, KeyRound, Filter, Server, Globe, Edit, Info, UserCircle, Search, ChevronRight, Bell, Send, MessageSquare, Image as ImageIcon, ExternalLink, AlertTriangle, Sparkles, Megaphone, Wrench, CreditCard, Tag, ChevronDown, ChevronUp, HardDrive, Upload, Zap, BookOpen, GraduationCap, Film, PlayCircle, Pin, MapPin, MapPinOff, Tv, Loader2, Download, ClipboardPaste, Link as LinkIcon, Activity, HelpCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from "react-router";
import NetflixHouseholdVerificationGuide from "./pages/NetflixHouseholdVerificationGuide";
import NetflixTvActivationGuide from "./pages/NetflixTvActivationGuide";
import { useRouteHead } from "./lib/useRouteHead";
import { notify } from "./components/toast/notify";
import { ToastProvider } from "./components/toast/toast-provider";
import { WorkflowChooser, ViewSwitcher, DirectLinkView, useWorkflowView, resolveFeatures, countEnabled, WorkflowSwitcher, prefetchWorkflowAccounts, readAccountsCache, writeAccountsCache, requestWorkflowView } from "./components/WorkflowViews";

import { supabase } from "./integrations/supabase/client";
import { AVATAR_CATEGORIES, resolveAvatar, buildAvatarId, prettyName, getAvatarCategoryUrls } from "./lib/avatars";
import { bootstrapFromSupabase, fastClearCookiesRedirect, revokeSessionInBackground, markSessionStart, readBootstrapCache, refreshBootstrap, patchBootstrapCacheUser, getEmailFilters, setEmailFilters as setEmailFiltersCache, getFreeAvatarCooldown, setFreeAvatarCooldown, markNotificationRead, markAllNotificationsRead, markNotificationSeen, deleteNotificationForMe, logNotificationEvent, getPoppedIds, markPopped, adminListRecipients, adminDeleteNotificationForUser, type EmailFilters, type AppNotification, type MaintenanceInfo, type NotificationRecipient } from "./lib/bootstrap";
import MaintenanceScreen from "./components/MaintenanceScreen";
import DateTimePicker from "./components/DateTimePicker";
import { clearBrowserIdentityNow, sessionGet, sessionSet, sessionRemove, nukeBrowserIdentity } from "./lib/session";
import { openInboxDB, readLatestEmails, writeDelta, getSyncCursor, cacheEmailHtml, getEmailHtml, purgeEmailsOutsideScope, type CachedEmail } from "./lib/inboxCache";
import { readAdminCache, writeAdminCache, isCacheFresh, reconcileVersion, emitSyncStatus } from "./lib/adminSettingsCache";
import { AdminSyncStatus } from "./components/AdminSyncStatus";
import { useAdminSlice } from "./hooks/useAdminSlice";
import { AdminSliceKeys, setSlice as setAdminSlice, clearAllSlices as clearAllAdminSlices } from "./lib/adminData";


// Lazy-loaded heavy auth-only libs — kept out of the public first-load chunk.
const ReCAPTCHA = lazy(() => import("react-google-recaptcha"));
const QRCodeSVG = lazy(() => import("qrcode.react").then((m) => ({ default: m.QRCodeSVG })));

// Preload Google reCAPTCHA API script as soon as siteKey is known so the
// widget mounts instantly when the modal opens (avoids 5–10s cold load).
let __recaptchaPreloaded = false;
function preloadRecaptchaScript() {
  if (__recaptchaPreloaded || typeof document === "undefined") return;
  __recaptchaPreloaded = true;
  try {
    // Warm up react-google-recaptcha JS chunk (no-op if already bundled).
    import("react-google-recaptcha").catch(() => {});
    if (document.querySelector('script[data-recaptcha-preload]')) return;
    const s = document.createElement("script");
    s.src = "https://www.google.com/recaptcha/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.setAttribute("data-recaptcha-preload", "1");
    document.head.appendChild(s);
  } catch {}
}

// --- Admin composer: platform logo options ---
type PlatformOption = { id: string; label: string; logoFile: string; aliases?: string[] };
const PLATFORM_LOGO_BASE = "/platform-logos/";
const DEFAULT_PLATFORM_LOGO = `${PLATFORM_LOGO_BASE}default-logo.svg`;

const normalizePlatformKey = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const PLATFORM_OPTIONS: PlatformOption[] = [
  { id: "telegram",      label: "Telegram",         logoFile: "telegram.svg" },
  { id: "whatsapp",      label: "WhatsApp",         logoFile: "whatsapp.svg" },
  { id: "youtube",       label: "YouTube",          logoFile: "youtube.svg" },
  { id: "instagram",     label: "Instagram",        logoFile: "instagram.svg" },
  { id: "discord",       label: "Discord",          logoFile: "discord.svg" },
  { id: "twitter",       label: "Twitter / X",      logoFile: "twitter.svg", aliases: ["x", "twitterx"] },
  { id: "facebook",      label: "Facebook",         logoFile: "facebook.svg" },
  { id: "linkedin",      label: "LinkedIn",         logoFile: "linkedin.svg" },
  { id: "netflix",       label: "Netflix",          logoFile: "netflix.svg" },
  { id: "prime",         label: "Prime Video",      logoFile: "primevideo.svg", aliases: ["amazonprimevideo", "primevideo", "amazonprime"] },
  { id: "hotstar",       label: "Disney+ Hotstar",  logoFile: "disney-hotstar.svg", aliases: ["disneyhotstar", "disneyplushotstar", "hotstar"] },
  { id: "jiohotstar",    label: "JioHotstar",       logoFile: "jiohotstar.svg", aliases: ["jiohotstar", "jiohotstarapp"] },
  { id: "sonyliv",       label: "Sony LIV",         logoFile: "sonyliv.png", aliases: ["sonyliv", "sony live", "sony liv"] },
  { id: "zee5",          label: "ZEE5",             logoFile: "zee5.svg", aliases: ["zee 5", "z5"] },
  { id: "jiocinema",     label: "JioCinema",        logoFile: "jiocinema.svg", aliases: ["jio cinema", "jio-cinema", "jio.cinema"] },
  { id: "mxplayer",      label: "MX Player",        logoFile: "mxplayer.png", aliases: ["mx", "mx player"] },
  { id: "minitv",        label: "Amazon miniTV",    logoFile: "minitv.png", aliases: ["amazonminitv", "mini tv", "minitv"] },
  { id: "appletv",       label: "Apple TV+",        logoFile: "appletv.svg", aliases: ["apple tv", "apple tv plus", "appletvplus"] },
  { id: "lionsgate",     label: "Lionsgate Play",   logoFile: "lionsgateplay.png", aliases: ["lionsgate", "lionsgateplay", "lions play", "lionsplay"] },
  { id: "discoveryplus", label: "Discovery+",       logoFile: "discoveryplus.svg", aliases: ["discovery", "discoveryplus", "discovery plus"] },
  { id: "sunnxt",        label: "Sun NXT",          logoFile: "sunnxt.png", aliases: ["sun nxt", "sunnext"] },
  { id: "aha",           label: "Aha",              logoFile: "aha.png", aliases: ["aha video", "ahavideo"] },
  { id: "chaupal",       label: "Chaupal",          logoFile: "chaupal.svg" },
  { id: "hoichoi",       label: "Hoichoi",          logoFile: "hoichoi.png" },
  { id: "manoramamax",   label: "ManoramaMAX",      logoFile: "manoramamax.png", aliases: ["manorama max"] },
  { id: "erosnow",       label: "Eros Now",         logoFile: "erosnow.svg", aliases: ["eros"] },
  { id: "mubi",          label: "MUBI",             logoFile: "mubi.png" },
  { id: "shemaroome",    label: "ShemarooMe",       logoFile: "shemaroome.png", aliases: ["shemaroo", "shemaroo me"] },
  { id: "docubay",       label: "DocuBay",          logoFile: "docubay.png" },
  { id: "epicon",        label: "EPIC ON",          logoFile: "epicon.png", aliases: ["epic on", "epic"] },
  { id: "planetmarathi", label: "Planet Marathi",   logoFile: "planetmarathi.png", aliases: ["planet marathi ott", "planet marathi"] },
  { id: "stage",         label: "Stage",            logoFile: "stage.png", aliases: ["stage ott"] },
  { id: "nammaflix",     label: "NammaFlix",        logoFile: "nammaflix.png", aliases: ["namma flix"] },
  { id: "klikk",         label: "Klikk",            logoFile: "klikk.png", aliases: ["klikk ott"] },
  { id: "simplysouth",   label: "Simply South",     logoFile: "simplysouth.png", aliases: ["simply south"] },
  { id: "tentkotta",     label: "Tentkotta",        logoFile: "tentkotta.jpg", aliases: ["tent kotta"] },
  { id: "ytpremium",     label: "YouTube Premium",  logoFile: "ytpremium.svg", aliases: ["youtube premium", "yt premium"] },
  { id: "",              label: "Custom / Bell",    logoFile: "default-logo.svg", aliases: ["custom", "bell", "notification"] },
];

const PLATFORM_ALIAS_TO_ID = PLATFORM_OPTIONS.reduce<Record<string, string>>((acc, platform) => {
  [platform.id, platform.label, platform.logoFile.replace(/\.[^.]+$/, ""), ...(platform.aliases || [])].forEach((value) => {
    const key = normalizePlatformKey(value);
    if (key) acc[key] = platform.id;
  });
  return acc;
}, {});

const getPlatformLogoUrl = (platform: PlatformOption) => `${PLATFORM_LOGO_BASE}${platform.logoFile}`;

const resolvePlatformOption = (value: string | null | undefined) => {
  const raw = String(value || "");
  const exact = PLATFORM_OPTIONS.find((platform) => platform.id === raw);
  if (exact) return exact;
  const id = PLATFORM_ALIAS_TO_ID[normalizePlatformKey(raw)];
  return PLATFORM_OPTIONS.find((platform) => platform.id === id) || PLATFORM_OPTIONS.find((platform) => platform.id === "")!;
};

function DurationQuickAdd({ baseDateStr, onApply }: { baseDateStr: string; onApply: (localStr: string) => void }) {
  const [amount, setAmount] = useState<string>("");
  const [unit, setUnit] = useState<"days" | "months" | "years">("months");
  const apply = () => {
    const n = parseInt(amount, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    const base = baseDateStr ? new Date(baseDateStr) : new Date();
    if (Number.isNaN(base.getTime())) return;
    const d = new Date(base);
    if (unit === "days") d.setDate(d.getDate() + n);
    else if (unit === "months") d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    const pad = (v: number) => String(v).padStart(2, "0");
    onApply(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    setAmount("");
  };
  return (
    <div className="mt-2 flex items-stretch gap-1.5">
      <input
        type="number"
        min={1}
        inputMode="numeric"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }}
        placeholder="e.g. 2"
        aria-label="Duration amount"
        className="w-20 px-2.5 py-1.5 rounded-lg border border-sky-200 bg-white text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-400"
      />
      <select
        value={unit}
        onChange={(e) => setUnit(e.target.value as "days" | "months" | "years")}
        aria-label="Duration unit"
        className="px-2 py-1.5 rounded-lg border border-sky-200 bg-white text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-400"
      >
        <option value="days">days</option>
        <option value="months">months</option>
        <option value="years">years</option>
      </select>
      <button type="button" onClick={apply}
        className="px-3 py-1.5 rounded-lg text-xs font-black bg-sky-600 text-white hover:bg-sky-700 active:scale-95 transition-all">
        Add
      </button>
    </div>
  );
}


const platformMatchesSearch = (platform: PlatformOption, search: string) => {
  const query = normalizePlatformKey(search);
  if (!query) return true;
  return [platform.id, platform.label, platform.logoFile, ...(platform.aliases || [])]
    .some((value) => normalizePlatformKey(value).includes(query));
};

const logPlatformLogoFailure = ({ platform, url, status, reason }: { platform: string; url: string; status?: number | string; reason: string }) => {
  console.error("[platform-logo] failed", {
    platform,
    expectedUrl: url,
    httpStatus: status ?? "unknown",
    reason,
  });
};

// --- Notification templates (guided types) ---
type TemplateOption = { id: string; label: string; color: string; hint: string };
const TEMPLATE_OPTIONS: TemplateOption[] = [
  { id: "tutorial",     label: "Tutorial",       color: "#3B82F6", hint: "Step-by-step teaching" },
  { id: "howto",        label: "How to use",     color: "#8B5CF6", hint: "Quick usage guide" },
  { id: "new_movie",    label: "New Movie",      color: "#E50914", hint: "New title on Netflix/Prime" },
  { id: "new_episode",  label: "New Episode",    color: "#EC4899", hint: "Fresh episode drop" },
  { id: "update",       label: "Update",         color: "#10B981", hint: "App/feature update" },
  { id: "announcement", label: "Announcement",   color: "#F59E0B", hint: "General announcement" },
  { id: "promo",        label: "Promo / Offer",  color: "#F97316", hint: "Discount or deal" },
  { id: "alert",        label: "Alert",          color: "#EF4444", hint: "Important warning" },
  { id: "event",        label: "Live Event",     color: "#06B6D4", hint: "Match/premiere/live" },
];

const PlatformChipVisual: React.FC<{ id?: string | null; size?: number }> = ({ id, size = 32 }) => {
  const p = resolvePlatformOption(id);
  const logoUrl = getPlatformLogoUrl(p);
  const [src, setSrc] = React.useState(logoUrl);

  React.useEffect(() => {
    setSrc(logoUrl);
  }, [logoUrl]);

  const fallbackToDefaultLogo = () => {
    logPlatformLogoFailure({
      platform: p.label,
      url: logoUrl,
      reason: "<img> onError fired while rendering logo",
    });
    if (src !== DEFAULT_PLATFORM_LOGO) setSrc(DEFAULT_PLATFORM_LOGO);
  };

  return (
    <div
      className="rounded-full flex items-center justify-center bg-white shadow-md leading-none shrink-0 overflow-hidden ring-1 ring-black/5"
      style={{ width: size, height: size }}
    >
      <img
        src={src}
        alt={`${p.label} logo`}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={fallbackToDefaultLogo}
        style={{ width: Math.round(size * 0.92), height: Math.round(size * 0.92), objectFit: "contain" }}
      />
    </div>
  );
};

// Premium framed tile for user-facing notification icons (popup / center / list).
// Uses admin-selected platform_icon when set, otherwise falls back to the category glyph.
const NotifIconTile: React.FC<{
  platformId?: string | null;
  fallback?: React.ReactNode;
  size?: number;
  tone?: "dark" | "light";
}> = ({ platformId, fallback, size = 44, tone = "dark" }) => {
  const resolved = platformId ? resolvePlatformOption(platformId) : null;
  const hasPlatform = !!(resolved && resolved.id);
  const radius = Math.round(size * 0.28);
  const inner = Math.round(size * 0.78);
  const bg = tone === "dark"
    ? "linear-gradient(160deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02))"
    : "linear-gradient(160deg, #ffffff, #f4f4f6)";
  const ring = tone === "dark" ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(0,0,0,0.06)";
  const shadow = tone === "dark"
    ? "0 10px 28px -12px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.08)"
    : "0 8px 22px -10px rgba(15,15,20,0.35), inset 0 1px 0 rgba(255,255,255,0.9)";
  return (
    <div
      className="flex-shrink-0 flex items-center justify-center relative"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: bg,
        border: ring,
        boxShadow: shadow,
      }}
    >
      {hasPlatform ? (
        <PlatformChipVisual id={resolved!.id} size={inner} />
      ) : (
        <div
          className="flex items-center justify-center rounded-full"
          style={{
            width: inner,
            height: inner,
            background: tone === "dark" ? "rgba(255,255,255,0.04)" : "rgba(15,15,20,0.04)",
          }}
        >
          {fallback}
        </div>
      )}
    </div>
  );
};


// Template icon (lucide)
const TemplateIcon: React.FC<{ id: string; className?: string }> = ({ id, className = "w-4 h-4" }) => {
  switch (id) {
    case "tutorial":     return <BookOpen className={className} />;
    case "howto":        return <GraduationCap className={className} />;
    case "new_movie":    return <Film className={className} />;
    case "new_episode":  return <PlayCircle className={className} />;
    case "update":       return <Sparkles className={className} />;
    case "announcement": return <Megaphone className={className} />;
    case "promo":        return <Tag className={className} />;
    case "alert":        return <AlertTriangle className={className} />;
    case "event":        return <Zap className={className} />;
    default:             return <Bell className={className} />;
  }
};



const SESSION_CONFIG_KEY_FOR = (role: "admin" | "user") =>
  role === "admin" ? "admin_session_config" : "session_config";

const SESSION_TIMEOUT_CACHE_KEY = (role: "admin" | "user") =>
  role === "admin" ? "admin_session_timeout_min" : "user_session_timeout_min";

const DEFAULT_SESSION_TIMEOUT_MINUTES: Record<"admin" | "user", number> = {
  admin: 60,
  user: 5,
};

function readSessionNumber(key: "session_started_at" | "session_expires_at"): number {
  const value = Number(sessionGet(key as any) || "0");
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function ensureSessionStarted(): number {
  const existing = readSessionNumber("session_started_at");
  if (existing) return existing;
  markSessionStart();
  return readSessionNumber("session_started_at") || Date.now();
}

function readCachedTimeoutMinutes(role: "admin" | "user"): number {
  try {
    const raw = Number(sessionGet(SESSION_TIMEOUT_CACHE_KEY(role) as any) || "0");
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  } catch { return 0; }
}

function writeCachedTimeoutMinutes(role: "admin" | "user", minutes: number): void {
  try {
    if (Number.isFinite(minutes) && minutes > 0) {
      sessionSet(SESSION_TIMEOUT_CACHE_KEY(role) as any, String(Math.floor(minutes)));
    }
  } catch {}
}

function getSessionDeadline(role: "admin" | "user", minutes?: number): number {
  const started = readSessionNumber("session_started_at");
  const accessExpiresAt = readSessionNumber("session_expires_at");
  const explicit = Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Number(minutes) : 0;
  // Prefer explicit (fresh from server) → cached configured → default. Using the
  // default synchronously on remount would nuke long admin windows (e.g. 60min
  // default vs 180min configured) as soon as elapsed exceeds 60min, before the
  // async settings fetch had a chance to re-arm.
  const configuredMinutes = explicit || readCachedTimeoutMinutes(role) || DEFAULT_SESSION_TIMEOUT_MINUTES[role];
  const configuredDeadline = started && configuredMinutes > 0 ? started + configuredMinutes * 60_000 : 0;
  return configuredDeadline || accessExpiresAt || 0;
}

function getSessionTotalMinutes(role: "admin" | "user", minutes?: number): number {
  const started = readSessionNumber("session_started_at");
  const deadline = getSessionDeadline(role, minutes);
  if (started && deadline > started) return Math.max(1, Math.ceil((deadline - started) / 60_000));
  const explicit = Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Number(minutes) : 0;
  return explicit || readCachedTimeoutMinutes(role) || DEFAULT_SESSION_TIMEOUT_MINUTES[role];
}


// --- Worker URL Types & Helpers ---
type WorkerUrlMap = {
  primary: string[];
  byAccount: Record<string, string[]>;
};

type EmailSyncResult = { emails: Email[]; inserted: number; warning: string | null; fallback: boolean };

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getStoredWorkerUrls(): string[] {
  try {
    const raw = sessionGet("cloudflare_worker_urls" as any);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String).map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean) : [];
  } catch { return []; }
}

function storeWorkerUrls(urls: string[]) {
  try {
    const normalized = Array.from(new Set((urls || []).map(String).map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean)));
    if (normalized.length) sessionSet("cloudflare_worker_urls" as any, JSON.stringify(normalized));
  } catch {}
}

function getSessionToken(): string | null {
  try {
    return sessionGet("session_token" as any);
  } catch { return null; }
}

function readStoredSessionUser(): any | null {
  try {
    const raw = sessionGet("user" as any);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function clearRouteSessionState(): void {
  const keys = [
    "session_token",
    "refresh_token",
    "session_expires_at",
    "refresh_expires_at",
    "session_family_id",
    "session_started_at",
    "user",
    "admin_auth",
    "cloudflare_worker_urls",
    "admin_session_timeout_min",
    "user_session_timeout_min",
  ];

  keys.forEach((key) => {
    try { sessionRemove(key as any); } catch {}
  });
  import("./lib/sessionRefresh").then(({ clearRefreshState }) => clearRefreshState()).catch(() => {});
}

type DeviceFingerprint = {
  userAgent?: string;
  platform?: string;
  vendor?: string;
  deviceName?: string;
  deviceModel?: string;
  deviceVendor?: string;
  deviceType?: "Mobile" | "Tablet" | "Desktop";
  deviceInfoSource?: "ua-ch" | "ua" | "fallback";
  deviceInfoConfidence?: "high" | "medium" | "low";
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
  colorScheme?: "dark" | "light" | "no-preference";
  reducedMotion?: boolean;
  hdr?: boolean;
  webglVendor?: string;
  webglRenderer?: string;
  canvasHash?: string;
  webdriver?: boolean;
  fingerprintHash?: string;
};

type LoginLocationPayload = {
  status: "granted" | "denied" | "timeout" | "unavailable" | "unsupported" | "error";
  permissionState?: PermissionState | "unknown";
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp?: number;
  error?: string;
  publicIp?: string;
  publicIpSource?: "ipwho.is";
  device?: DeviceFingerprint;
};


async function sha256Hex(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return ""; }
}

function collectWebGL(): { vendor?: string; renderer?: string } {
  try {
    const canvas = document.createElement("canvas");
    const gl: any = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return {};
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  } catch { return {}; }
}

function collectCanvasHash(): string {
  try {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 50;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 200, 50);
    ctx.fillStyle = "#069";
    ctx.fillText("🔐 lovable-fp", 2, 15);
    return c.toDataURL().slice(-64);
  } catch { return ""; }
}

function cleanVersion(value?: string) {
  const v = String(value || "").trim();
  if (!v) return "";
  const parts = v.split(".").filter(Boolean);
  if (parts.length >= 2 && parts.slice(1).every((p) => p === "0")) return parts[0];
  return parts.slice(0, 3).join(".");
}

function parseClientUa(ua: string, uaPlatform?: string, uaPlatformVersion?: string) {
  const s = ua || "";
  const pick = (re: RegExp) => s.match(re)?.[1] || "";
  let browserName = "Unknown";
  let browserVersion = "";
  if (/Edg\//.test(s)) { browserName = "Edge"; browserVersion = pick(/Edg\/([\d.]+)/); }
  else if (/SamsungBrowser\//.test(s)) { browserName = "Samsung Internet"; browserVersion = pick(/SamsungBrowser\/([\d.]+)/); }
  else if (/MiuiBrowser\//.test(s)) { browserName = "Mi Browser"; browserVersion = pick(/MiuiBrowser\/([\d.]+)/); }
  else if (/Chrome\//.test(s)) { browserName = "Chrome"; browserVersion = pick(/Chrome\/([\d.]+)/); }
  else if (/Firefox\//.test(s)) { browserName = "Firefox"; browserVersion = pick(/Firefox\/([\d.]+)/); }
  else if (/Safari\//.test(s)) { browserName = "Safari"; browserVersion = pick(/Version\/([\d.]+)/); }

  let osName = "Unknown";
  let osVersion = "";
  if (/Android/.test(s) || uaPlatform === "Android") {
    osName = "Android";
    osVersion = cleanVersion(uaPlatformVersion) || pick(/Android ([\d.]+)/);
    // Chrome UA reduction commonly reports "Android 10; K" for every Android.
    // Without UA-CH, showing that as exact is misleading.
    if (!uaPlatformVersion && /Android 10;\s*K[;)\s]/.test(s)) osVersion = "hidden";
  } else if (/iPhone|iPad|iPod/.test(s)) {
    osName = /iPad/.test(s) ? "iPadOS" : "iOS";
    osVersion = (pick(/OS ([\d_]+)/) || "").replace(/_/g, ".");
  } else if (/Windows NT/.test(s) || uaPlatform === "Windows") {
    osName = "Windows";
    const v = pick(/Windows NT ([\d.]+)/);
    osVersion = ({ "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" } as Record<string, string>)[v] || v;
  } else if (/Mac OS X/.test(s) || uaPlatform === "macOS") {
    osName = "macOS";
    osVersion = (pick(/Mac OS X ([\d_.]+)/) || "").replace(/_/g, ".");
  } else if (/CrOS/.test(s) || uaPlatform === "Chrome OS") {
    osName = "ChromeOS";
  } else if (/Linux/.test(s)) {
    osName = "Linux";
  }
  return { browserName, browserVersion: cleanVersion(browserVersion), osName, osVersion: cleanVersion(osVersion) || osVersion };
}

function isReliableDeviceModel(model?: string) {
  const m = String(model || "").trim();
  if (!m) return false;
  if (/^(k|android|mobile|linux|build|wv|unknown|generic)$/i.test(m)) return false;
  if (m.length < 2) return false;
  return true;
}

function inferClientDeviceIdentity(fp: DeviceFingerprint) {
  const ua = fp.userAgent || "";
  const uaModel = String(fp.uaModel || "").trim();
  const mobile = fp.mobile ?? /Mobi|Android|iPhone|iPod/.test(ua);
  const tablet = /iPad|Tablet|Nexus 7|Nexus 10|SM-T\d/i.test(ua);
  const deviceType: "Mobile" | "Tablet" | "Desktop" = tablet ? "Tablet" : mobile ? "Mobile" : "Desktop";
  let deviceModel = "";
  let source: DeviceFingerprint["deviceInfoSource"] = "fallback";
  let confidence: DeviceFingerprint["deviceInfoConfidence"] = "low";

  if (isReliableDeviceModel(uaModel)) {
    deviceModel = uaModel;
    source = "ua-ch";
    confidence = "high";
  } else if (/iPhone/.test(ua)) {
    deviceModel = "iPhone"; source = "ua"; confidence = "medium";
  } else if (/iPad/.test(ua)) {
    deviceModel = "iPad"; source = "ua"; confidence = "medium";
  } else if (/Android/.test(ua)) {
    const match = ua.match(/Android[^;]*;\s*[^;]*;\s*([^;)]+?)\s+Build/i) || ua.match(/;\s*([^;)]+?)\)\s+AppleWebKit/i);
    if (isReliableDeviceModel(match?.[1])) {
      deviceModel = match![1].trim();
      source = "ua";
      confidence = "medium";
    } else {
      deviceModel = tablet ? "Android tablet" : "Android phone";
    }
  } else if (/Windows/.test(ua)) deviceModel = "Windows PC";
  else if (/Macintosh/.test(ua)) deviceModel = "Mac";
  else deviceModel = deviceType;

  const blob = `${ua} ${deviceModel}`;
  let deviceVendor = "";
  if (/Samsung|SM-|GT-/i.test(blob)) deviceVendor = "Samsung";
  else if (/Xiaomi|Redmi|MI |POCO/i.test(blob)) deviceVendor = "Xiaomi";
  else if (/OnePlus/i.test(blob)) deviceVendor = "OnePlus";
  else if (/Pixel/i.test(blob)) deviceVendor = "Google";
  else if (/HUAWEI|Honor/i.test(blob)) deviceVendor = "Huawei";
  else if (/Realme/i.test(blob)) deviceVendor = "Realme";
  else if (/OPPO/i.test(blob)) deviceVendor = "Oppo";
  else if (/Vivo/i.test(blob)) deviceVendor = "Vivo";
  else if (/Motorola|Moto /i.test(blob)) deviceVendor = "Motorola";
  else if (/Apple|iPhone|iPad|Macintosh/i.test(blob)) deviceVendor = "Apple";
  else if (/Windows/i.test(blob)) deviceVendor = "PC";

  const deviceName = `${deviceVendor ? deviceVendor + " " : ""}${deviceModel}`.trim();
  return { deviceName, deviceModel, deviceVendor, deviceType, deviceInfoSource: source, deviceInfoConfidence: confidence };
}

async function collectDeviceFingerprint(): Promise<DeviceFingerprint> {
  const fp: DeviceFingerprint = {};
  try {
    if (typeof navigator !== "undefined") {
      fp.userAgent = navigator.userAgent;
      fp.platform = (navigator as any).platform;
      fp.vendor = (navigator as any).vendor;
      fp.language = navigator.language;
      fp.languages = Array.isArray(navigator.languages) ? navigator.languages.slice(0, 6) : undefined;
      fp.touchPoints = (navigator as any).maxTouchPoints;
      fp.deviceMemory = (navigator as any).deviceMemory;
      fp.hardwareConcurrency = navigator.hardwareConcurrency;
      fp.cookieEnabled = navigator.cookieEnabled;
      fp.onLine = navigator.onLine;
      fp.pdfViewerEnabled = (navigator as any).pdfViewerEnabled;
      fp.webdriver = !!(navigator as any).webdriver;
    }
    if (typeof window !== "undefined" && window.screen) {
      fp.screen = {
        width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio || 1,
        availWidth: window.screen.availWidth, availHeight: window.screen.availHeight,
        colorDepth: window.screen.colorDepth, pixelDepth: window.screen.pixelDepth,
      };
      fp.viewport = { width: window.innerWidth, height: window.innerHeight };
      try { fp.orientation = (window.screen.orientation?.type) || (window.innerHeight > window.innerWidth ? "portrait" : "landscape"); } catch {}
    }
    try {
      fp.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      fp.utcOffsetMinutes = -new Date().getTimezoneOffset();
    } catch {}
    try {
      if (window.matchMedia) {
        fp.colorScheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark"
          : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "no-preference";
        fp.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        fp.hdr = window.matchMedia("(dynamic-range: high)").matches;
      }
    } catch {}
    try {
      const conn: any = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
      if (conn) fp.network = { type: conn.type, effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt, saveData: !!conn.saveData };
    } catch {}
    const gl = collectWebGL();
    if (gl.vendor) fp.webglVendor = gl.vendor;
    if (gl.renderer) fp.webglRenderer = gl.renderer;
    fp.canvasHash = collectCanvasHash();
    const uaData: any = (navigator as any).userAgentData;
    if (uaData) {
      fp.mobile = !!uaData.mobile;
      fp.uaPlatform = uaData.platform;
      fp.uaBrands = Array.isArray(uaData.brands) ? uaData.brands.map((b: any) => ({ brand: b.brand, version: b.version })) : undefined;
      if (typeof uaData.getHighEntropyValues === "function") {
        try {
          const hi = await uaData.getHighEntropyValues([
            "platform", "platformVersion", "model", "architecture", "bitness", "uaFullVersion", "fullVersionList",
          ]);
          fp.uaPlatform = hi.platform || fp.uaPlatform;
          fp.uaPlatformVersion = hi.platformVersion;
          fp.uaModel = hi.model;
          fp.uaArchitecture = hi.architecture;
          fp.uaBitness = hi.bitness;
          fp.uaFullVersion = hi.uaFullVersion || hi.fullVersionList?.find?.((b: any) => /Chrome|Chromium|Edge/i.test(b.brand))?.version;
        } catch (e) { console.warn("[Device] high-entropy UA-CH failed:", e); }
      }
    }
    const parsed = parseClientUa(fp.userAgent || "", fp.uaPlatform, fp.uaPlatformVersion);
    fp.osName = parsed.osName;
    fp.osVersion = parsed.osVersion;
    fp.browserName = parsed.browserName;
    fp.browserVersion = fp.uaFullVersion || parsed.browserVersion;
    Object.assign(fp, inferClientDeviceIdentity(fp));
    try {
      const bat: any = await (navigator as any).getBattery?.();
      if (bat) fp.battery = { level: bat.level, charging: bat.charging, chargingTime: bat.chargingTime, dischargingTime: bat.dischargingTime };
    } catch {}
    // Stable fingerprint hash
    const parts = [
      fp.userAgent, fp.platform, fp.language, (fp.languages || []).join(","), fp.timezone,
      fp.screen ? `${fp.screen.width}x${fp.screen.height}x${fp.screen.colorDepth || ""}@${fp.screen.dpr}` : "",
      fp.hardwareConcurrency, fp.deviceMemory, fp.touchPoints,
      fp.webglVendor, fp.webglRenderer, fp.canvasHash,
      fp.uaModel, fp.uaPlatformVersion,
    ].filter(v => v !== undefined && v !== null).join("|");
    fp.fingerprintHash = await sha256Hex(parts);
  } catch (e) {
    console.warn("[Device] fingerprint failed:", e);
  }
  return fp;
}

function beginDeviceFingerprintCapture(): Promise<DeviceFingerprint> {
  return collectDeviceFingerprint();
}


const LOGIN_GEO_TIMEOUT_MS = 45_000;
const LOGIN_HANDSHAKE_TIMEOUT_MS = 15_000;
const LOGIN_EDGE_TIMEOUT_MS = 45_000;
const GPS_PERMISSION_TOAST_ID = "gps-permission-blocked";
const GPS_PERMISSION_REQUIRED_MESSAGE = "Allow location to sign in.";
const GPS_PERMISSION_BLOCKED_MESSAGE = "Location blocked. Enable it in browser site settings.";

type GpsPermissionMode = "needed" | "blocked";

function isGpsPermissionDeniedMessage(message: string) {
  const m = message.toLowerCase();
  return m.includes("gps permission") || m.includes("gps coordinates missing") || m.includes("gps timed out") || m.includes("device gps unavailable") || m.includes("location permission") || m.includes("allow location") || m.includes("location blocked") || m.includes("browser location popup") || m.includes("does not support gps");
}

function getGpsPermissionMode(message: string): GpsPermissionMode {
  const m = message.toLowerCase();
  return m.includes("blocked") || m.includes("browser settings") || m.includes("site settings") ? "blocked" : "needed";
}

function showGpsPermissionToast(message: string) {
  const mode = getGpsPermissionMode(message);
  if (mode === "blocked") {
    notify.error("Location blocked", {
      id: GPS_PERMISSION_TOAST_ID,
      description: "Reset Location in the browser site settings, then tap Enable Location again.",
      duration: 9000,
    });
  } else {
    notify.error("Tap Allow for location", {
      id: GPS_PERMISSION_TOAST_ID,
      description: "Use Enable Location below.",
      duration: 9000,
    });
  }
}


async function fetchBrowserPublicIp(): Promise<Pick<LoginLocationPayload, "publicIp" | "publicIpSource">> {
  // Encrypted-only mode: disable third-party browser IP lookups.
  return {};
}

function buildLocationSignInMessage(location: LoginLocationPayload): string {
  if (location.permissionState === "denied") {
    return GPS_PERMISSION_BLOCKED_MESSAGE;
  }
  if (location.status === "denied") {
    return GPS_PERMISSION_REQUIRED_MESSAGE;
  }
  if (location.status === "unsupported") {
    return "This browser/device does not support GPS location. Use Chrome/Firefox with location services enabled.";
  }
  if (location.status === "timeout") {
    return "GPS request timed out. Enable device Location/Precise Location and try again.";
  }
  if (location.status === "unavailable") {
    return `Device GPS is unavailable right now (${location.error || "position unavailable"}). Turn on device Location and try again.`;
  }
  if (location.status === "error") {
    return `GPS error: ${location.error || "unknown error"}.`;
  }
  return `Could not read device GPS coordinates (${location.error || "unknown"}).`;
}

// CRITICAL for Chrome Android / Incognito:
// getCurrentPosition MUST be called synchronously in the same tick as the user
// gesture (click/submit), BEFORE any setState / await / notify calls. Any async
// gap invalidates user activation and Chrome silently drops the native prompt.
// This helper is intentionally NOT async — it fires getCurrentPosition
// immediately and returns a plain Promise consumers can await later.
function beginGeolocationCapture(): Promise<LoginLocationPayload> {
  if (typeof window === "undefined" || typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve({ status: "unsupported", permissionState: "unknown", error: "Geolocation is not supported on this device." });
  }
  if (!window.isSecureContext) {
    return Promise.resolve({ status: "error", permissionState: "unknown", error: "HTTPS is required for GPS." });
  }
  try {
    const policy = (document as any).permissionsPolicy || (document as any).featurePolicy;
    if (policy?.allowsFeature && !policy.allowsFeature("geolocation")) {
      return Promise.resolve({ status: "denied", permissionState: "denied", error: "Location is blocked by browser frame policy." });
    }
  } catch {}

  const startedAt = Date.now();
  return new Promise<LoginLocationPayload>((resolve) => {
    let settled = false;
    let timer: number | undefined;
    const finish = (payload: LoginLocationPayload) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      
      resolve(payload);
    };
    const onSuccess = (pos: GeolocationPosition) => {
      finish({
        status: "granted",
        permissionState: "granted",
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        altitude: pos.coords.altitude,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
        timestamp: pos.timestamp,
      });
    };
    const onError = async (err: GeolocationPositionError) => {
      console.error("[GPS] error code:", err.code, "message:", err.message);
      let status: LoginLocationPayload["status"] = "error";
      if (err.code === err.PERMISSION_DENIED) status = "denied";
      else if (err.code === err.POSITION_UNAVAILABLE) status = "unavailable";
      else if (err.code === err.TIMEOUT) status = "timeout";
      let nextPermissionState: LoginLocationPayload["permissionState"] = "unknown";
      try {
        if (navigator.permissions?.query) {
          const permission = await navigator.permissions.query({ name: "geolocation" as PermissionName });
          nextPermissionState = permission.state;
        }
      } catch {}
      finish({ status, permissionState: nextPermissionState, error: err.message || `code ${err.code}` });
    };
    const options: PositionOptions = {
      enableHighAccuracy: true,
      timeout: LOGIN_GEO_TIMEOUT_MS,
      maximumAge: 0,
    };
    // FIRE FIRST — before setTimeout / any other work — to preserve user activation.
    // Use one GPS request only; starting getCurrentPosition + watchPosition caused
    // some browsers/extensions to show repeated permission prompts.
    try {
      navigator.geolocation.getCurrentPosition(onSuccess, onError, options);
    } catch (err: any) {
      finish({ status: "error", permissionState: "unknown", error: err?.message || "Could not start location request." });
      return;
    }
    timer = window.setTimeout(() => {
      finish({ status: "timeout", permissionState: "unknown", error: "GPS fix timed out." });
    }, LOGIN_GEO_TIMEOUT_MS);
  });
}

// Async variant kept for non-gesture code paths (auto-recovery etc.).
async function collectLoginLocation(): Promise<LoginLocationPayload> {
  return beginGeolocationCapture();
}

async function requireLoginLocation(preStarted?: Promise<LoginLocationPayload> | null, preStartedDevice?: Promise<DeviceFingerprint> | null): Promise<LoginLocationPayload> {
  const location = await (preStarted ?? beginGeolocationCapture());
  if (location.status !== "granted" || typeof location.latitude !== "number" || typeof location.longitude !== "number") {
    throw new Error(buildLocationSignInMessage(location));
  }
  const [publicIp, device] = await Promise.all([fetchBrowserPublicIp(), preStartedDevice ?? collectDeviceFingerprint()]);
  return { ...location, ...publicIp, device };
}

function hasGrantedLocation(location: LoginLocationPayload | null | undefined): location is LoginLocationPayload {
  return location?.status === "granted" && typeof location.latitude === "number" && typeof location.longitude === "number";
}

function GpsPermissionSheet({ mode, loading, onEnable, onPrimeEnable }: { mode: GpsPermissionMode | null; loading: boolean; onEnable: () => void; onPrimeEnable?: () => void }) {
  if (!mode) return null;
  const blocked = mode === "blocked";
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="rounded-xl border border-[#e50914]/45 bg-[#38070b]/95 p-4 shadow-[0_16px_40px_-22px_rgba(229,9,20,0.75)]"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#e50914]/20 text-[#ffb3b8]">
          <AlertCircle className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-bold leading-tight text-white">Location permission required</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-white/78">
            {blocked
              ? "You blocked location earlier. Reset it below, then tap Enable Location to see the browser popup again."
              : "Tap Enable Location, then press Allow in the browser popup."}
          </p>
          {blocked && (
            <ol className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-white/70 list-decimal pl-4">
              <li>Tap the <span className="font-semibold text-white/90">lock / tune icon</span> left of the URL bar.</li>
              <li>Open <span className="font-semibold text-white/90">Permissions</span> and set <span className="font-semibold text-white/90">Location → Allow</span> (or tap Reset).</li>
              <li>Come back and tap <span className="font-semibold text-white/90">Enable Location</span> — the native popup will appear.</li>
            </ol>
          )}
          <button
            type="button"
            onPointerDownCapture={onPrimeEnable}
            onClick={onEnable}
            disabled={loading}
            className="mt-3 inline-flex min-h-10 items-center justify-center rounded-lg bg-[#e50914] px-4 text-[13px] font-bold text-white transition active:scale-[0.98] disabled:opacity-55"
          >
            {loading ? "Requesting..." : "Enable Location"}
          </button>
        </div>
      </div>
    </motion.div>
  );
}


// --- API Helper (encrypted-only Supabase edge transport) ---

// In-flight coalescer: overlapping calls for read-only idempotent actions
// (e.g. `me` fired by hydration + plan-expiry + route boundary within the
// same tick) share a single Promise instead of triggering N edge invocations.
// Keyed by function+action+token so different sessions never share a result.
const inflightReads = new Map<string, Promise<any>>();
const COALESCE_ACTIONS = new Set(["me", "bootstrap_public"]);

async function apiCall(functionName: string, body: any) {

  const token = getSessionToken();
  const pendingToken = (() => { try { return sessionGet("pending_admin_token" as any); } catch { return null; } })();
  const pendingActions = new Set(["request_admin_otp", "verify_otp", "verify_totp", "update_totp", "finalize_admin_session"]);
  const extraHeaders: Record<string, string> = {};
  if (token) extraHeaders["X-Session-Token"] = token;
  if (pendingToken && functionName === "manage-app" && pendingActions.has(body?.action)) extraHeaders["X-Pending-Token"] = pendingToken;

  const coalesceKey = (functionName === "manage-app" && COALESCE_ACTIONS.has(body?.action))
    ? `${functionName}:${body.action}:${token || "anon"}`
    : null;
  if (coalesceKey) {
    const existing = inflightReads.get(coalesceKey);
    if (existing) return existing;
  }

  const { invokeEdge } = await import("./lib/secureTransport");
  const { storeSessionPair, refreshNow, ensureFreshAccess, hasRefreshToken } = await import("./lib/sessionRefresh");

  const skipRefreshActions = new Set(["refresh_session"]);

  // C.2: proactively refresh if access token is within 30s of expiry before
  // ANY authenticated edge call, including fetch-emails. Previously this only
  // ran for manage-app, so manual inbox refresh could hit fetch-emails with an
  // expired access token and show "Refresh could not complete".
  if (!(functionName === "manage-app" && skipRefreshActions.has(body?.action))) {
    await ensureFreshAccess(30_000).catch(() => {});
    // Re-read possibly-rotated token
    const t2 = getSessionToken();
    if (t2) extraHeaders["X-Session-Token"] = t2;
  }

  const isTransientEdgeError = (value: unknown) => /Secure connection|handshake|Failed to fetch|NetworkError|busy|timeout|temporar|unknown session|bad frame|non-binary|stale request|replay|origin mismatch/i.test(
    value instanceof Error ? value.message : String(value || ""),
  );

  const run = (async () => {
    let data: any;
    try {
      data = await invokeEdge(functionName, body, { headers: extraHeaders });
    } catch (err: any) {
      const msg = String(err?.message || err || "");
      const looksExpired = /access token expired|session expired|session revoked|authentication required|session invalid/i.test(msg);
      // C.2: single retry after refresh on stale-session errors, except for the
      // refresh endpoint itself and unauthenticated calls.
      if (looksExpired && !(functionName === "manage-app" && skipRefreshActions.has(body?.action)) && (getSessionToken() || hasRefreshToken())) {
        const ok = await refreshNow();
        if (!ok) throw err;
        const t3 = getSessionToken();
        if (t3) extraHeaders["X-Session-Token"] = t3;
        data = await invokeEdge(functionName, body, { headers: extraHeaders });
      } else if (isTransientEdgeError(err)) {
        await new Promise((r) => setTimeout(r, 750));
        const t4 = getSessionToken();
        if (t4) extraHeaders["X-Session-Token"] = t4;
        data = await invokeEdge(functionName, body, { headers: extraHeaders });
      } else {
        throw err;
      }
    }

    if (data?.sessionToken) {
      sessionSet("session_token" as any, data.sessionToken);
    }
    if (data?.refreshToken || data?.expiresAt) {
      storeSessionPair(data);
    }
    // Plan-expiry surface: any endpoint (login, me, ...) that returns
    // { success: false, error: "plan_finished", ... } is broadcast globally
    // so a friendly "Plan Finished" screen can render — regardless of caller.
    if (data && data.success === false && data.error === "plan_finished") {
      try {
        window.dispatchEvent(new CustomEvent("app:plan-finished", { detail: { contactInfo: data.contactInfo || null, planEndsAt: data.planEndsAt || null } }));
      } catch {}
    }
    return data;
  })();

  if (coalesceKey) {
    inflightReads.set(coalesceKey, run);
    run.finally(() => {
      if (inflightReads.get(coalesceKey) === run) inflightReads.delete(coalesceKey);
    });
  }
  return run;
}


class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error("[render-crash]", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-white flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-3xl border border-red-500/30 bg-slate-900 p-6 shadow-2xl">
          <div className="flex items-center gap-3 text-red-300 font-black text-lg mb-3"><AlertCircle className="w-5 h-5" /> App recovered from an error</div>
          <p className="text-sm text-slate-300 mb-4">No more white screen — reload once to restore the latest app state.</p>
          <pre className="max-h-32 overflow-auto rounded-xl bg-black/30 p-3 text-[11px] text-red-100 mb-4">{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()} className="w-full rounded-xl bg-red-600 py-3 font-bold hover:bg-red-700">Reload app</button>
        </div>
      </div>
    );
  }
}

// Toast surface is fully owned by <ToastProvider /> from ./components/toast.

// --- Perf timing (login flow instrumentation) ---
// Emits console lines the user asked for so we can see exactly where the
// captcha→login latency goes. Also feeds performance.mark so it's visible
// in DevTools Performance panel. Zero-overhead when console is closed.
type PerfTimer = { mark: (label: string) => void; end: (label?: string) => number };
function startPerfTimer(name: string): PerfTimer {
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  let last = t0;
  try { performance.mark?.(`${name}:start`); } catch {}
  // eslint-disable-next-line no-console
  console.info(`[perf] ${name} start`);
  return {
    mark(label: string) {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const dSincePrev = Math.round(now - last);
      const dTotal = Math.round(now - t0);
      last = now;
      try { performance.mark?.(`${name}:${label}`); } catch {}
      // eslint-disable-next-line no-console
      console.info(`[perf] ${name} · ${label}  Δ${dSincePrev}ms (total ${dTotal}ms)`);
    },
    end(label = "end") {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const dTotal = Math.round(now - t0);
      try {
        performance.mark?.(`${name}:${label}`);
        performance.measure?.(name, `${name}:start`, `${name}:${label}`);
      } catch {}
      // eslint-disable-next-line no-console
      console.info(`[perf] ${name} ${label} (total ${dTotal}ms)`);
      return dTotal;
    },
  };
}



// --- Rate Limiter ---
const loginAttempts: { [key: string]: number[] } = {};
function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const maxAttempts = 5;
  if (!loginAttempts[key]) loginAttempts[key] = [];
  loginAttempts[key] = loginAttempts[key].filter(t => now - t < window);
  if (loginAttempts[key].length >= maxAttempts) return false;
  loginAttempts[key].push(now);
  return true;
}

// --- Auth Context ---
const AuthContext = createContext<{ user: any; loading: boolean; checkAuth: () => void } | null>(null);

const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Read cached user immediately for fast paint, then re-hydrate from the DB.
  const readCached = () => {
    return readStoredSessionUser();
  };

  const hydrateFromServer = async () => {
    let token = getSessionToken();
    const cachedBeforeHydrate = readCached();
    const pendingAdminToken = (() => { try { return sessionGet("pending_admin_token" as any); } catch { return null; } })();
    const cachedPendingAdmin = cachedBeforeHydrate?.role === "admin" && cachedBeforeHydrate?.pending === true;
    if (!token) {
      // Admin password step creates a short-lived pending 2FA identity before a
      // real session_token exists. Do not let the initial /me hydration sweep
      // race clear that identity, or the 2FA page bounces back to /admin even
      // after a correct password.
      if (pendingAdminToken && cachedPendingAdmin) {
        setUser(cachedBeforeHydrate);
        setLoading(false);
        return;
      }
      try {
        const { hasRefreshToken, refreshNow } = await import("./lib/sessionRefresh");
        if (hasRefreshToken()) {
          await refreshNow();
          token = getSessionToken();
        }
      } catch {}
    }
    if (!token) {
      const liveCached = readCached();
      const livePendingAdminToken = (() => { try { return sessionGet("pending_admin_token" as any); } catch { return null; } })();
      if (livePendingAdminToken && liveCached?.role === "admin" && liveCached?.pending === true) {
        setUser(liveCached);
        setLoading(false);
        return;
      }
      try { sessionRemove("user" as any); } catch {}
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const res = await apiCall("manage-app", { action: "me" });
      if (res?.success && res.user) {
        const merged = { ...(readCached() || {}), ...res.user };
        try { sessionSet("user" as any, JSON.stringify(merged)); } catch {}
        setUser(merged);
      } else {
        throw new Error(res?.error || "Session invalid");
      }
    } catch (err) {
      // Session revoked, expired, or account missing → force logout.
      // Exception: an admin viewing a user account must never be dumped into
      // maintenance on refresh because of a transient /me or refresh failure.
      // Keep the cached server-signed impersonation shell so Back to Admin can
      // still use the existing token row (back_to_admin accepts expired access).
      if (cachedBeforeHydrate?.impersonated === true && cachedBeforeHydrate?.id) {
        setUser(cachedBeforeHydrate);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err || "");
      const path = typeof window !== "undefined" ? window.location.pathname : "";
      const latestCached = readCached();
      const adminFinalizeHandoff =
        (path === "/admin" || path === "/admin-auth") &&
        latestCached?.role === "admin" &&
        latestCached?.pending !== true &&
        !!getSessionToken() &&
        sessionGet("admin_auth" as any) === "true";
      if (adminFinalizeHandoff) {
        setUser(latestCached);
        return;
      }
      if (cachedBeforeHydrate?.id && /Secure connection|handshake|Failed to fetch|NetworkError|busy|timeout|temporar|Unknown session/i.test(msg)) {
        setUser(cachedBeforeHydrate);
        return;
      }
      if (pendingAdminToken && cachedPendingAdmin) {
        setUser(cachedBeforeHydrate);
        return;
      }
      try {
        sessionRemove("session_token" as any);
        sessionRemove("user" as any);
        sessionRemove("admin_auth" as any);
        sessionRemove("pending_admin_token" as any);
      } catch {}
      try { const { clearRefreshState } = await import("./lib/sessionRefresh"); clearRefreshState(); } catch {}
      setUser(null);

    } finally {
      setLoading(false);
    }
  };

  const checkAuth = () => {
    // Fast path: reflect tab session synchronously (used after login/logout).
    setUser(readCached());
    setLoading(false);
  };

  useEffect(() => {
    
    // Initial paint from cache so UI is not blocked, then verify against DB.
    setUser(readCached());
    // C.2: arm auto-refresh from any stored refresh token in this tab.
    import("./lib/sessionRefresh").then(({ armAutoRefresh }) => armAutoRefresh()).catch(() => {});
    void hydrateFromServer();
  }, []);

  // Instant remote-logout via Supabase Realtime Broadcast.
  // Server pushes a `revoked` event to `session-family-<uuid>` when another
  // device logs in and the concurrent-session cap kicks this device out.
  // One persistent WebSocket, ~50 bytes on revoke, no polling.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let channel: any = null;
    (async () => {
      try {
        const { getSessionFamilyId } = await import("./lib/sessionRefresh");
        const fid = getSessionFamilyId();
        if (!fid || cancelled) return;
        const { supabase } = await import("./integrations/supabase/client");
        channel = supabase
          .channel(`session-family-${fid}`)
          .on("broadcast", { event: "revoked" }, async () => {
            if ((user as any)?.impersonated === true) return;
            try {
              const { notify } = await import("./components/toast/notify");
              notify.error("Signed out", {
                description: "You signed in on another device.",
                duration: 3000,
              });
            } catch {}
            // Silent full reset: purge cookies + session, then reload the page.
            fastClearCookiesRedirect();
          })
          .subscribe();
      } catch {}
    })();
    return () => {
      cancelled = true;
      if (channel) {
        try {
          import("./integrations/supabase/client").then(({ supabase }) => supabase.removeChannel(channel)).catch(() => {});
        } catch {}
      }
    };
  }, [user?.id]);



  return <AuthContext.Provider value={{ user, loading, checkAuth }}>{children}</AuthContext.Provider>;
};

const useAuth = () => useContext(AuthContext)!;

// --- Session Timeout Guard ---
// Reads admin-configured absolute session timeout (minutes) from app_settings.
// When elapsed, forces full logout: user must click their profile and re-enter password.
function useSessionTimeoutGuard(role: "admin" | "user", enabled = true) {
  const navigate = useNavigate();
  const { user: authUser, checkAuth } = useAuth();

  useEffect(() => {
    if (!enabled) return;
    let timer: any;
    let cancelled = false;
    const doLogout = () => {
      notify.info("🔒 Session timed out", {
        id: "session-timed-out",
        description: "Tap your profile and enter password again.",
        duration: 3000,
      });
      // Silent full reset: route through /clearcookies so browser storage
      // (cookies, localStorage, IDB, caches, SW) is wiped to 0 B via the
      // `Clear-Site-Data: "*"` header + JS fallback.
      fastClearCookiesRedirect();
    };
    const armForDeadline = (deadline: number) => {
      if (timer) clearTimeout(timer);
      if (!deadline) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { doLogout(); return; }
      timer = setTimeout(doLogout, remaining);
    };

    ensureSessionStarted();
    armForDeadline(getSessionDeadline(role));

    (async () => {
      let minutes = 0;
      try {
        const res = await apiCall("manage-app", { action: "get_settings", key: SESSION_CONFIG_KEY_FOR(role) });
        minutes = Number(res?.value?.timeoutMinutes) || 0;
      } catch {}
      if (cancelled) return;
      if (minutes > 0) writeCachedTimeoutMinutes(role, minutes);
      if (!minutes || minutes <= 0) return;
      armForDeadline(getSessionDeadline(role, minutes));
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, enabled]);
}

// ==================== NETFLIX N LOGO (inline SVG, no external asset) ====================
function NetflixNLogo({ className = "w-7 h-7 sm:w-8 sm:h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 111 30" xmlns="http://www.w3.org/2000/svg" className={className} aria-label="Netflix" role="img">
      <path fill="#E50914" d="M105.06 14.28L110.6 30c-1.63-.23-3.26-.53-4.92-.75l-3.13-8.14-3.24 7.47c-1.57-.27-3.11-.36-4.68-.56L100.24 15 95.16 1.65h4.62l2.87 7.35 3.06-7.35H110l-4.94 12.63zM90.72 1.65h-4.19V27.9c1.37.08 2.8.15 4.19.31V1.65zm-7.75 25.72c-3.82-.26-7.66-.5-11.56-.6V1.65h4.24V22.7c2.45.05 4.9.24 7.32.36v4.31zM64.63 11.61v4.29h-5.79v9.61h-4.19V1.65h11.87v4.29h-7.68v5.67h5.79zm-15.36-5.67v20.11c-1.42 0-2.87 0-4.24.03V5.94H40.66V1.65c4.79 0 9.59 0 14.38 0v4.29h-5.77zm-14.5 15.83c1.88.04 3.79.19 5.66.28v4.24c-3.03-.19-6.06-.38-9.15-.45V1.65h4.24v19.35c.11.12-.75.12-.75.77zM26.83 27.4c-1.31-.03-2.65-.03-3.99-.03V1.65h3.99V27.4zM6.29 14.35v14.5c-1.5.16-2.83.36-4.23.58V1.65h3.95l5.4 15.1V1.65h4.24v27.62c-1.5.27-3.03.42-4.61.7L6.29 14.35z"/>
    </svg>
  );
}

// ==================== NOTIFICATION BELL ====================
// Complete rewrite: mobile = bottom sheet portal; desktop = editorial glass panel.
// Polling pauses while open; SessionCountdown hides via window events.

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function useIsMobile() {
  const [is, setIs] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 639px)").matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setIs(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return is;
}

// ==============================================================
// Notification System — Premium unified popup + auto-popup
// ==============================================================

const CATEGORY_META: Record<string, { label: string; icon: any; color: string }> = {
  announcement: { label: "Announcement", icon: Megaphone,     color: "text-sky-300" },
  update:       { label: "Update",       icon: Sparkles,      color: "text-violet-300" },
  security:     { label: "Security",     icon: Shield,        color: "text-emerald-300" },
  maintenance:  { label: "Maintenance",  icon: Wrench,        color: "text-amber-300" },
  promo:        { label: "Offer",        icon: Tag,           color: "text-pink-300" },
  billing:      { label: "Billing",      icon: CreditCard,    color: "text-cyan-300" },
};
const PRIORITY_ACCENT: Record<string, string> = {
  low: "bg-zinc-500",
  normal: "bg-sky-500",
  high: "bg-amber-500",
  critical: "bg-rose-500",
};

function categoryMeta(cat?: string | null) {
  return CATEGORY_META[cat || "announcement"] || CATEGORY_META.announcement;
}

// ---- Shared refresh signal so bell + popup + list stay in sync ----
const NOTIF_REFRESH_EVENT = "notif:refresh";
function requestNotifRefresh() {
  // Backed by the singleton store — trigger an immediate refresh + broadcast
  // so components subscribed via the store OR the legacy event both react.
  try {
    // Lazy import to avoid pulling the store into critical-path bundles that don't need it.
    import("./lib/notificationsStore").then(({ invalidateNotifications }) => invalidateNotifications());
  } catch {}
  window.dispatchEvent(new CustomEvent(NOTIF_REFRESH_EVENT));
}

// Notifications hook — reads from the module-level singleton store.
// One poll for the whole tab (was two independent 30s intervals per user).
function useNotifications() {
  const { user } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;
    (async () => {
      const { subscribeNotifications, invalidateNotifications } = await import("./lib/notificationsStore");
      if (!alive) return;
      unsub = subscribeNotifications((next, isLoading) => {
        setItems(next);
        setLoading(isLoading);
      }, user?.id || null);
      const onEvt = () => invalidateNotifications();
      window.addEventListener(NOTIF_REFRESH_EVENT, onEvt);
      const cleanupEvt = () => window.removeEventListener(NOTIF_REFRESH_EVENT, onEvt);
      const prevUnsub = unsub;
      unsub = () => { prevUnsub?.(); cleanupEvt(); };
    })();
    return () => { alive = false; unsub?.(); };
  }, [user?.id]);

  const refresh = useCallback(async () => {
    const { invalidateNotifications } = await import("./lib/notificationsStore");
    invalidateNotifications();
  }, []);

  return { items, setItems, loading, refresh };
}

// ---------- Auto-popup: premium modal shown on first sight of a notification ----------
function AutoPopupNotification() {
  const { user } = useAuth();
  const [queue, setQueue] = useState<AppNotification[]>([]);
  const [dismissing, setDismissing] = useState(false);
  const seenRef = useRef<Set<string>>(getPoppedIds());

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;
    const process = (list: AppNotification[]) => {
      const fresh = list.filter((n) =>
        !seenRef.current.has(n.id) &&
        !n.read &&
        (!n.snoozed_until || new Date(n.snoozed_until) < new Date())
      );
      if (fresh.length) {
        // Priority order (kid-friendly rule):
        // 1) Security / password-reset notifications first (force to top).
        // 2) Then admin announcements in FIFO order (oldest unseen first) —
        //    so a brand-new user's first login shows the first admin message first.
        // 3) Everything else after, newest first.
        const rank = (n: AppNotification): number => {
          const cat = (n.category || "").toLowerCase();
          const sub = (n.sub_kind || "").toLowerCase();
          if (cat === "security" || sub.includes("password") || sub.includes("reset")) return 0;
          if (cat === "announcement" || cat === "update" || cat === "maintenance") return 1;
          return 2;
        };
        fresh.sort((a, b) => {
          const ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          const cra = a.priority === "critical" ? 1 : 0, crb = b.priority === "critical" ? 1 : 0;
          if (cra !== crb) return crb - cra;
          const ta = new Date(a.created_at).getTime(), tb = new Date(b.created_at).getTime();
          return ra === 1 ? ta - tb : tb - ta;
        });
        setQueue((prev) => (prev.length ? prev : fresh.slice(0, 3)));
      }
    };
    (async () => {
      const { subscribeNotifications } = await import("./lib/notificationsStore");
      if (!alive) return;
      unsub = subscribeNotifications((list) => process(list), user?.id || null);
    })();
    return () => { alive = false; unsub?.(); };
  }, [user?.id]);



  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    // hide session countdown while modal is open
    window.dispatchEvent(new CustomEvent("notif:open"));
    logNotificationEvent(current.id, "delivered").catch(() => {});
    markNotificationSeen([current.id]).catch(() => {});
    return () => { window.dispatchEvent(new CustomEvent("notif:close")); };
  }, [current?.id]);

  const dismiss = async (opened = false) => {
    if (!current) return;
    setDismissing(true);
    markPopped(current.id);
    seenRef.current.add(current.id);
    if (!opened) await logNotificationEvent(current.id, "dismissed").catch(() => {});
    setTimeout(() => {
      setDismissing(false);
      setQueue((q) => q.slice(1));
    }, 180);
  };

  const openInBell = () => {
    dismiss(true);
    setTimeout(() => window.dispatchEvent(new CustomEvent("notif:openCenter", { detail: { id: current?.id } })), 220);
  };

  if (!current || typeof document === "undefined") return null;
  const cat = categoryMeta(current.category);
  const CatIcon = cat.icon;
  const accent = PRIORITY_ACCENT[current.priority || "normal"] || PRIORITY_ACCENT.normal;

  return createPortal(
    <AnimatePresence>
      {!dismissing && (
        <motion.div
          key={`popup-${current.id}`}
          className="fixed inset-0 z-[110] flex items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-md" onClick={() => dismiss(false)} />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ scale: 0.94, y: 16, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, y: 8, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="relative w-full max-w-[560px] rounded-3xl overflow-hidden bg-white border border-slate-200"
            style={{
              boxShadow: "0 40px 100px -20px rgba(15,23,42,0.35), 0 2px 8px -2px rgba(15,23,42,0.08)",
            }}
          >
            {/* priority accent bar */}
            <div className={`absolute inset-x-0 top-0 h-[3px] ${accent}`} />

            {/* close */}
            <button
              onClick={() => dismiss(false)}
              className="absolute top-3 right-3 z-10 p-1.5 rounded-full text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>

            {/* hero image — prominent on user side */}
            {current.image_url ? (
              <div className="relative aspect-[16/9] w-full overflow-hidden bg-slate-100">
                <img
                  src={current.image_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
              </div>
            ) : (
              <div className="pt-10" />
            )}

            <div className="px-6 sm:px-7 pb-6 sm:pb-7 pt-5 sm:pt-6">
              {/* icon medallion */}
              <div className="flex items-center gap-3 mb-4">
                <NotifIconTile
                  platformId={current.platform_icon}
                  size={52}
                  tone="light"
                  fallback={<CatIcon className={`w-6 h-6 ${cat.color}`} />}
                />
                <div className="flex flex-col">
                  <span className="text-[10.5px] uppercase tracking-[0.16em] text-slate-500 font-semibold">
                    {cat.label}
                  </span>
                  <span className="text-[11px] text-slate-400 font-normal mt-0.5">
                    {formatRelative(current.created_at)}
                  </span>
                </div>
              </div>

              <h2
                className="text-slate-900 text-[25px] sm:text-[28px] leading-tight mb-2 font-bold"
                style={{ letterSpacing: "-0.015em" }}
              >
                {current.title}
              </h2>
              <p className="text-slate-700 text-[15px] sm:text-[15.5px] leading-relaxed whitespace-pre-wrap">
                {current.body}
              </p>
              {current.description && (
                <p className="mt-3 text-slate-500 text-[14px] leading-relaxed whitespace-pre-wrap line-clamp-6">
                  {current.description}
                </p>
              )}

              <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
                <button
                  onClick={() => dismiss(false)}
                  className="flex-1 py-3 rounded-xl text-[14px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
                >
                  Later
                </button>
                {current.action_url && current.action_label && !/snooze|archive|24h/i.test(current.action_label) ? (
                  <a
                    href={current.action_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => { logNotificationEvent(current.id, "clicked", { url: current.action_url }).catch(() => {}); markNotificationRead(current.id).catch(() => {}); dismiss(true); }}
                    className="flex-1 py-3 rounded-xl text-[14px] font-bold text-white bg-slate-900 hover:bg-slate-800 flex items-center justify-center gap-1.5 transition-colors"
                  >
                    {current.action_label} <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : (
                  <button
                    onClick={openInBell}
                    className="flex-1 py-3 rounded-xl text-[14px] font-bold text-white bg-slate-900 hover:bg-slate-800 transition-colors"
                  >
                    Read more
                  </button>
                )}
              </div>

              <p className="mt-3 text-center text-[10.5px] text-slate-400 tracking-wide">
                Dismiss — you can reopen this from the <Bell className="inline w-3 h-3 -mt-0.5" /> bell any time.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---------- Full Notification Center (unified popup: mobile sheet + desktop modal) ----------
type Tab = "all" | "unread";

function NotificationCenter({ open, onClose, initialId, items, loading, onChange }: {
  open: boolean;
  onClose: () => void;
  initialId?: string | null;
  items: AppNotification[];
  loading: boolean;
  onChange: () => void;
}) {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setSelected(null); return; }
    if (initialId) setSelected(initialId);
    window.dispatchEvent(new CustomEvent("notif:open"));
    // mark visible as seen
    const visibleIds = items.filter((n) => !n.seen).map((n) => n.id);
    if (visibleIds.length) markNotificationSeen(visibleIds).catch(() => {});
    if (isMobile) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
        window.dispatchEvent(new CustomEvent("notif:close"));
      };
    }
    return () => { window.dispatchEvent(new CustomEvent("notif:close")); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selected) setSelected(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, selected, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((n) => {
      if (tab === "unread" && n.read) return false;
      if (q && !(`${n.title} ${n.body} ${n.description || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, tab, query]);

  const detail = selected ? items.find((n) => n.id === selected) : null;

  const handleOpenDetail = async (n: AppNotification) => {
    setSelected(n.id);
    if (!n.read) {
      await markNotificationRead(n.id).catch(() => {});
      onChange();
    }
  };

  const handleDelete = async (id: string) => {
    await deleteNotificationForMe(id);
    onChange();
    if (selected === id) setSelected(null);
  };

  // Snooze removed — no user-facing action.


  const handleMarkAllRead = async () => {
    await markAllNotificationsRead();
    onChange();
    notify.success("All caught up");
  };

  // ---- grouped rendering ----
  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  const Header = (
    <div className="px-5 pt-5 pb-3 border-b border-slate-200 bg-white">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h3 className="text-slate-900 text-[22px] leading-none font-bold" style={{ letterSpacing: "-0.015em" }}>
            {detail ? "Notification" : "Notifications"}
          </h3>
          {!detail && items.filter((n) => !n.read).length > 0 && (
            <span className="text-[10.5px] font-semibold text-rose-600 tracking-wider uppercase">
              {items.filter((n) => !n.read).length} new
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {detail ? (
            <button onClick={() => setSelected(null)} className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </button>
          ) : (
            items.some((n) => !n.read) && (
              <button onClick={handleMarkAllRead} title="Mark all read" className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors">
                <CheckCircle2 className="w-4 h-4" />
              </button>
            )
          )}
          <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!detail && (
        <>
          <div className="mt-4 flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
            {(["all", "unread"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-full text-[11.5px] font-semibold tracking-wide capitalize transition-colors whitespace-nowrap ${
                  tab === t ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="mt-3 relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notifications"
              aria-label="Search notifications"
              className="w-full pl-9 pr-3 py-2 rounded-xl text-[12.5px] bg-slate-50 border border-slate-200 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 focus:bg-white transition-colors"
            />
          </div>
        </>
      )}
    </div>
  );

  const List = (
    <div className="overflow-y-auto overscroll-contain flex-1 bg-slate-50">
      {loading && items.length === 0 && (
        <div className="py-16 text-center text-slate-500 text-sm font-medium tracking-wide">
          <div className="w-5 h-5 mx-auto mb-3 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin" />
          Loading
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="py-20 px-6 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm">
            <Bell className="w-6 h-6 text-slate-400 stroke-[1.5]" />
          </div>
          <p className="text-slate-900 text-[14px] font-semibold tracking-wide">You're all caught up</p>
          <p className="text-slate-500 text-[12px] mt-1">Nothing new here right now.</p>
        </div>
      )}
      {groups.map(({ label, rows }) => (
        <div key={label}>
          <div className="px-5 pt-4 pb-2 text-[10px] uppercase tracking-[0.14em] text-slate-500 font-bold">{label}</div>
          <ul className="px-3 space-y-2">
            {rows.map((n) => {
              const cat = categoryMeta(n.category);
              const CatIcon = cat.icon;
              const accent = PRIORITY_ACCENT[n.priority || "normal"] || PRIORITY_ACCENT.normal;
              return (
                <li key={n.id} className="group relative">
                  <button
                    onClick={() => handleOpenDetail(n)}
                    className={`w-full text-left rounded-2xl overflow-hidden transition-all border ${!n.read ? "bg-white border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300" : "bg-white/60 border-slate-200/70 hover:bg-white hover:border-slate-200"}`}
                  >
                    {/* Hero image if present — prominent on user side */}
                    {n.image_url && (
                      <div className="relative aspect-[16/7] w-full overflow-hidden bg-slate-100">
                        <img src={n.image_url} referrerPolicy="no-referrer" loading="lazy" alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                        <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${accent}`} />
                      </div>
                    )}
                    <div className="flex gap-3 px-4 py-3.5">
                      {!n.image_url && <span className={`w-1 rounded-full ${accent} opacity-70 self-stretch min-h-[36px] flex-shrink-0`} />}
                      <NotifIconTile
                        platformId={n.platform_icon}
                        size={44}
                        tone="light"
                        fallback={<CatIcon className={`w-4 h-4 ${cat.color}`} />}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className={`text-[13.5px] leading-snug truncate ${!n.read ? "text-slate-900 font-bold" : "text-slate-600 font-medium"}`}>
                            {n.title}
                          </p>
                          <span className="text-[10.5px] text-slate-400 font-medium tabular-nums flex-shrink-0 transition-opacity group-hover:opacity-0" title={new Date(n.created_at).toLocaleString()}>
                            {formatRelative(n.created_at)}
                          </span>
                        </div>
                        <p className="text-slate-500 text-[12px] mt-1 leading-relaxed line-clamp-2">{n.body}</p>
                      </div>
                      {!n.read && (
                        <span className="w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)] mt-1.5 flex-shrink-0 transition-opacity group-hover:opacity-0" />
                      )}
                    </div>
                  </button>
                  {!n.locked && (
                    <div className="absolute right-3 top-3 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 pointer-events-none group-hover:pointer-events-auto">
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(n.id); }} className="p-1.5 rounded-md bg-white border border-slate-200 text-slate-500 hover:text-rose-600 hover:border-rose-200 shadow-sm" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="h-4" />
    </div>
  );

  const Detail = detail && (() => {
    const cat = categoryMeta(detail.category);
    const CatIcon = cat.icon;
    const accent = PRIORITY_ACCENT[detail.priority || "normal"] || PRIORITY_ACCENT.normal;
    return (
      <div className="overflow-y-auto overscroll-contain flex-1 bg-white">
        {detail.image_url && (
          <div className="relative aspect-[16/9] w-full overflow-hidden bg-slate-100">
            <img src={detail.image_url} alt="" referrerPolicy="no-referrer" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
          </div>
        )}
        <div className="px-6 py-5">
          <div className="flex items-start gap-3.5 mb-4">
            <NotifIconTile
              platformId={detail.platform_icon}
              size={54}
              tone="light"
              fallback={<CatIcon className={`w-6 h-6 ${cat.color}`} />}
            />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-1.5 h-1.5 rounded-full ${accent}`} />
                <span className="text-[10.5px] uppercase tracking-[0.16em] text-slate-500 font-semibold">
                  {cat.label}
                </span>
                <span className="text-[10.5px] text-slate-400 ml-auto">{new Date(detail.created_at).toLocaleString()}</span>
              </div>
              <h2 className="text-slate-900 text-[24px] leading-tight font-bold" style={{ letterSpacing: "-0.015em" }}>
                {detail.title}
              </h2>
            </div>
          </div>
          <p className="text-slate-700 text-[14px] leading-relaxed whitespace-pre-wrap">{detail.body}</p>
          {detail.description && (
            <p className="mt-4 text-slate-500 text-[13px] leading-relaxed whitespace-pre-wrap">{detail.description}</p>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            {detail.action_url && detail.action_label && !/snooze|archive|24h/i.test(detail.action_label) && (
              <a href={detail.action_url} target="_blank" rel="noopener noreferrer"
                onClick={() => logNotificationEvent(detail.id, "clicked", { url: detail.action_url }).catch(() => {})}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-bold bg-slate-900 text-white hover:bg-slate-800 transition-colors">
                {detail.action_label} <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            {detail.action2_url && detail.action2_label && !/snooze|archive|24h/i.test(detail.action2_label) && (
              <a href={detail.action2_url} target="_blank" rel="noopener noreferrer"
                onClick={() => logNotificationEvent(detail.id, "clicked", { url: detail.action2_url, secondary: true }).catch(() => {})}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-semibold bg-slate-100 text-slate-900 hover:bg-slate-200 transition-colors">
                {detail.action2_label}
              </a>
            )}
          </div>
          <div className="mt-6 pt-4 border-t border-slate-200 flex gap-2">
            {detail.locked ? (
              <div className="flex-1 py-2 rounded-lg text-[12px] text-slate-500 bg-slate-50 border border-slate-200 inline-flex items-center justify-center gap-1.5">
                <Lock className="w-3.5 h-3.5" /> Locked by admin
              </div>
            ) : (
              <button onClick={() => handleDelete(detail.id)} className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 transition-colors inline-flex items-center justify-center gap-1.5">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            )}
          </div>
        </div>
      </div>
    );
  })();

  if (!open || typeof document === "undefined") return null;

  const surfaceStyle: React.CSSProperties = {
    background: "#ffffff",
    border: "1px solid rgb(226 232 240)",
    boxShadow: "0 30px 80px -20px rgba(15,23,42,0.35), 0 2px 8px -2px rgba(15,23,42,0.06)",
  };


  const Panel = isMobile ? (
    <motion.div
      role="dialog"
      aria-modal="true"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
      className="absolute left-0 right-0 bottom-0 flex flex-col rounded-t-3xl overflow-hidden"
      style={{ ...surfaceStyle, height: "min(78dvh, 720px)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="mx-auto mt-2.5 mb-1 w-10 h-1 rounded-full bg-white/25 hover:bg-white/40 transition-colors flex-shrink-0"
      />
      {Header}
      {detail ? Detail : List}
    </motion.div>
  ) : (
    <motion.div
      role="dialog"
      aria-modal="true"
      initial={{ scale: 0.96, y: 8, opacity: 0 }}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      exit={{ scale: 0.98, opacity: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="relative w-full max-w-[780px] flex flex-col rounded-3xl overflow-hidden"
      style={{ ...surfaceStyle, maxHeight: "min(88vh, 920px)" }}
    >
      {Header}
      {detail ? Detail : List}
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="notif-center"
        className={`fixed inset-0 z-[100] ${isMobile ? "" : "flex items-center justify-center p-4"}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      >
        <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm" onClick={onClose} />
        {Panel}
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

function groupByDate(list: AppNotification[]) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYest = startToday - 86400_000;
  const startWeek = startToday - 6 * 86400_000;
  const buckets: { label: string; rows: AppNotification[] }[] = [
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "This week", rows: [] },
    { label: "Earlier", rows: [] },
  ];
  for (const n of list) {
    const t = new Date(n.created_at).getTime();
    if (t >= startToday) buckets[0].rows.push(n);
    else if (t >= startYest) buckets[1].rows.push(n);
    else if (t >= startWeek) buckets[2].rows.push(n);
    else buckets[3].rows.push(n);
  }
  return buckets.filter((b) => b.rows.length);
}

function NotificationBell() {
  const { items, loading, refresh } = useNotifications();
  const [open, setOpen] = useState(false);
  const [initialId, setInitialId] = useState<string | null>(null);

  useEffect(() => {
    const onOpenCenter = (e: any) => {
      setInitialId(e?.detail?.id || null);
      setOpen(true);
    };
    window.addEventListener("notif:openCenter", onOpenCenter);
    return () => window.removeEventListener("notif:openCenter", onOpenCenter);
  }, []);

  const active = items;
  const unread = active.filter((n) => !n.read).length;
  const highestPriority = active.filter((n) => !n.read).reduce<string>((acc, n) => {
    const rank = (p?: string) => ({ low: 1, normal: 2, high: 3, critical: 4 } as any)[p || "normal"] || 2;
    return rank(n.priority) > rank(acc) ? (n.priority || "normal") : acc;
  }, "normal");
  const dotColor = highestPriority === "critical" ? "bg-rose-500"
    : highestPriority === "high" ? "bg-amber-500"
    : "bg-rose-500";

  return (
    <>
      <button
        onClick={() => { setInitialId(null); setOpen(true); }}
        className="relative flex items-center justify-center p-2.5 bg-slate-900 text-white rounded-full hover:bg-slate-800 transition-all active:scale-95"
        title="Notifications"
        aria-label={`Notifications (${unread} unread)`}
      >
        <Bell className={`w-4 h-4 sm:w-5 sm:h-5 ${unread > 0 ? "animate-pulse" : ""}`} />
        {unread > 0 && (
          <>
            <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full animate-ping ${dotColor}`} />
            <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white ${dotColor}`} />
          </>
        )}
      </button>
      <NotificationCenter
        open={open}
        onClose={() => { setOpen(false); refresh(); }}
        initialId={initialId}
        items={items}
        loading={loading}
        onChange={refresh}
      />
      <AutoPopupNotification />
    </>
  );
}

// --- TV Auto-Login header button + Coming Soon popup ---

function userFriendlyTvError(message?: string | null) {
  const raw = String(message || "").trim();
  if (!raw) return "Please try again.";
  const lower = raw.toLowerCase();
  if (/locator|selector|timeout|waiting for|tvsignup|playwright|button:has-text|call log/.test(lower)) {
    return "Code rejected. Open Netflix on your TV, generate a fresh code, and try again.";
  }
  if (/invalid|wasn.?t right|incorrect|not recognized|try again/.test(lower)) {
    return "Netflix rejected the code. Generate a fresh code on your TV and try again.";
  }
  if (/cookies?|login|password|email|expired/.test(lower)) {
    return "This account isn't ready right now. Please contact the admin.";
  }
  return raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
}

type TvLoginStatus = "idle" | "verifying" | "checking" | "queued" | "running" | "in_progress" | "success" | "invalid_code" | "cookies_expired" | "no_cookies" | "error";
type TvRunInfo = {
  accountLabel?: string | null;
  imapMasked?: string | null;
  eventId?: string | null;
  message?: string | null;
  runUrl?: string | null;
  createdAt?: string | null;
  finishedAt?: string | null;
  result?: string | null;
};

const TV_ACTIVE_STATUSES = new Set<TvLoginStatus>(["verifying", "checking", "queued", "running", "in_progress"]);
const TV_TERMINAL_STATUSES = new Set<TvLoginStatus>(["success", "invalid_code", "cookies_expired", "no_cookies", "error"]);

function isTvActiveStatus(status: TvLoginStatus): boolean {
  return TV_ACTIVE_STATUSES.has(status);
}

function isTvRetryableStatus(status: TvLoginStatus): boolean {
  return status === "success" || status === "invalid_code" || status === "error";
}

function normalizeTvStatus(value: unknown): TvLoginStatus {
  const s = String(value || "");
  return (["idle", "verifying", "checking", "queued", "running", "in_progress", "success", "invalid_code", "cookies_expired", "no_cookies", "error"] as TvLoginStatus[]).includes(s as TvLoginStatus)
    ? (s as TvLoginStatus)
    : "idle";
}

function splitTvCode(value: unknown): string[] {
  const clean = String(value || "").replace(/\D/g, "").slice(0, 8);
  return Array.from({ length: 8 }, (_, i) => clean[i] || "");
}

function maskTvEmail(value: string): string {
  const raw = String(value || "").trim();
  const at = raw.indexOf("@");
  if (at <= 1) return raw;
  const name = raw.slice(0, at);
  const domain = raw.slice(at);
  return `${name.slice(0, 3)}•••${name.slice(-2)}${domain}`;
}

function tvRunInfoFromEvent(ev: any): TvRunInfo {
  return {
    accountLabel: ev?.account_label || null,
    imapMasked: ev?.imap_user ? maskTvEmail(String(ev.imap_user)) : null,
    eventId: ev?.id || null,
    message: ev?.message || null,
    runUrl: ev?.github_run_url || null,
    createdAt: ev?.created_at || null,
    finishedAt: ev?.finished_at || null,
    result: ev?.result || null,
  };
}

function formatTvRunTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch { return String(iso); }
}

function formatTvDuration(start?: string | null, end?: string | null): string {
  const a = start ? new Date(start).getTime() : 0;
  const b = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b) || !a || b < a) return "—";
  const sec = Math.max(1, Math.round((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${String(rem).padStart(2, "0")}s`;
}

function TvRunDetails({ info, status, code, theme = "light" }: { info: TvRunInfo; status: TvLoginStatus; code?: string; theme?: "dark" | "light" }) {
  if (!info?.eventId && !info?.createdAt) return null;
  const dark = theme === "dark";
  const terminal = TV_TERMINAL_STATUSES.has(status);
  const active = TV_ACTIVE_STATUSES.has(status);
  const tone = status === "success" ? "emerald" : active ? "rose" : status === "idle" ? "slate" : "amber";
  const shell = dark
    ? "border-white/10 bg-white/[0.04] text-white"
    : "border-slate-200 bg-slate-50/80 text-slate-900";
  const muted = dark ? "text-white/55" : "text-slate-500";
  const value = dark ? "text-white" : "text-slate-900";
  const badge = tone === "emerald"
    ? dark ? "bg-emerald-500/15 text-emerald-200 border-emerald-400/25" : "bg-emerald-50 text-emerald-700 border-emerald-200"
    : tone === "rose"
      ? dark ? "bg-rose-500/15 text-rose-200 border-rose-400/25" : "bg-rose-50 text-rose-700 border-rose-200"
      : dark ? "bg-amber-500/15 text-amber-200 border-amber-400/25" : "bg-amber-50 text-amber-700 border-amber-200";
  const label = status === "success" ? "Process completed" : active ? "Process running" : "Process ended";
  return (
    <div className={`mt-5 rounded-2xl border p-4 ${shell}`}>
      <div className="flex items-center justify-between gap-3">
        <div className={`text-[10px] uppercase tracking-[0.18em] font-black ${muted}`}>TV sign-in details</div>
        <div className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${badge}`}>{label}</div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:text-xs">
        <div className={`rounded-xl px-3 py-2 ${dark ? "bg-black/20" : "bg-white border border-slate-100"}`}>
          <div className={muted}>Started</div>
          <div className={`mt-0.5 font-bold ${value}`}>{formatTvRunTime(info.createdAt)}</div>
        </div>
        <div className={`rounded-xl px-3 py-2 ${dark ? "bg-black/20" : "bg-white border border-slate-100"}`}>
          <div className={muted}>{terminal ? "Finished" : "Running for"}</div>
          <div className={`mt-0.5 font-bold ${value}`}>{terminal ? formatTvRunTime(info.finishedAt) : formatTvDuration(info.createdAt, null)}</div>
        </div>
        <div className={`rounded-xl px-3 py-2 ${dark ? "bg-black/20" : "bg-white border border-slate-100"}`}>
          <div className={muted}>Taken time</div>
          <div className={`mt-0.5 font-bold ${value}`}>{formatTvDuration(info.createdAt, info.finishedAt)}</div>
        </div>
        <div className={`rounded-xl px-3 py-2 ${dark ? "bg-black/20" : "bg-white border border-slate-100"}`}>
          <div className={muted}>Code</div>
          <div className={`mt-0.5 font-bold tabular-nums ${value}`}>{code || "—"}</div>
        </div>
      </div>
      {(info.accountLabel || info.imapMasked) && (
        <div className={`mt-2 rounded-xl px-3 py-2 text-[11px] sm:text-xs ${dark ? "bg-black/20" : "bg-white border border-slate-100"}`}>
          <div className={muted}>Account</div>
          <div className={`mt-0.5 font-bold truncate ${value}`}>{info.imapMasked || info.accountLabel}{info.accountLabel && info.imapMasked ? ` · ${info.accountLabel}` : ""}</div>
        </div>
      )}
    </div>
  );
}

function TvRecentRuns({ events, onRefresh }: { events: any[]; onRefresh: () => void }) {
  if (!events.length) return null;
  const statusLabel = (ev: any) => String(ev?.status || "").replace(/_/g, " ") || "unknown";
  const dot = (status: string) => status === "success" ? "bg-emerald-500" : ["queued", "running", "in_progress"].includes(status) ? "bg-rose-500 animate-pulse" : "bg-amber-500";
  return (
    <div className="mt-6 rounded-3xl bg-white border border-slate-200 shadow-sm p-5 xl:p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-slate-900 flex items-center gap-2 text-sm"><Clock className="w-4 h-4 text-slate-500" /> Recent TV sign-ins</h3>
        <button type="button" onClick={onRefresh} className="p-1.5 rounded-full hover:bg-slate-100" title="Refresh"><RefreshCw className="w-3.5 h-3.5 text-slate-500" /></button>
      </div>
      <ul className="divide-y divide-slate-100 max-h-[360px] sm:max-h-[420px] overflow-y-auto overscroll-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {events.map((ev) => {
          const status = String(ev?.status || "");
          return (
            <li key={ev.id} className="py-3 flex items-start gap-3">
              <div className={`mt-1.5 w-2 h-2 rounded-full ${dot(status)}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-700 truncate font-bold capitalize">{statusLabel(ev)}</div>
                  <div className="text-[11px] text-slate-400 shrink-0">{formatTvDuration(ev.created_at, ev.finished_at)}</div>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 truncate">{ev.imap_user ? maskTvEmail(String(ev.imap_user)) : ev.account_label || "TV sign-in"}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">Started <b>{formatTvRunTime(ev.created_at)}</b>{ev.finished_at ? <> · Finished <b>{formatTvRunTime(ev.finished_at)}</b></> : null}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const tvActiveCopy = [
  "Signing you in",
  "Almost there",
  "Just a moment",
  "Finishing up",
];

function getTvProgress(status: TvLoginStatus, elapsedMs: number) {
  if (status === "verifying") return { title: "Signing you in", detail: "Please keep your TV on.", progress: 14 };
  if (status === "checking") return { title: "Signing you in", detail: "Please keep your TV on.", progress: 28 };
  const activeIndex = Math.floor(elapsedMs / 2200) % tvActiveCopy.length;
  if (status === "queued") {
    return {
      title: tvActiveCopy[activeIndex],
      detail: "Please keep your TV on.",
      progress: Math.min(72, 34 + Math.floor(elapsedMs / 700)),
    };
  }
  if (status === "running" || status === "in_progress") {
    return {
      title: tvActiveCopy[(activeIndex + 1) % tvActiveCopy.length],
      detail: "Please keep your TV on.",
      progress: Math.min(94, 58 + Math.floor(elapsedMs / 650)),
    };
  }
  return { title: "Sign in on TV", detail: "", progress: 0 };
}

function getTvTerminalCopy(status: TvLoginStatus, message?: string | null) {
  if (status === "success") return { title: "TV signed in", detail: "All set — enjoy!", tone: "success" as const };
  if (status === "invalid_code") return { title: "Code rejected — try again", detail: "Open Netflix on your TV and generate a fresh code.", tone: "danger" as const };
  if (status === "cookies_expired") return { title: "Account not ready", detail: "Please contact the admin.", tone: "warning" as const };
  if (status === "no_cookies") return { title: "Account not ready", detail: "Please contact the admin.", tone: "warning" as const };
  if (status === "error") return { title: "Could not sign in — try again", detail: userFriendlyTvError(message), tone: "danger" as const };
  return null;
}

function TvProcessButton({
  status,
  elapsedMs,
  isComplete,
  message,
  onSubmit,
  onRetry,
  idleText,
  theme = "dark",
}: {
  status: TvLoginStatus;
  elapsedMs: number;
  isComplete: boolean;
  message?: string | null;
  onSubmit: () => void;
  onRetry: () => void;
  idleText: string;
  theme?: "dark" | "light";
}) {
  const active = ["verifying", "checking", "queued", "running", "in_progress"].includes(status);
  const terminal = ["success", "invalid_code", "cookies_expired", "no_cookies", "error"].includes(status);
  const process = getTvProgress(status, elapsedMs);
  const terminalCopy = getTvTerminalCopy(status, message);
  const canSubmit = status === "idle" && isComplete;
  const dark = theme === "dark";
  const disabled = active || (status === "idle" && !isComplete) || status === "no_cookies" || status === "cookies_expired";
  const click = terminal && status !== "no_cookies" && status !== "cookies_expired" ? onRetry : onSubmit;
  const base = dark
    ? "mt-6 w-full min-h-12 rounded-xl font-bold text-sm tracking-wide transition-all active:scale-[0.98] overflow-hidden relative"
    : "mt-8 w-full min-h-14 2xl:min-h-16 rounded-xl xl:rounded-2xl font-black text-sm xl:text-base tracking-wide transition-all active:scale-[0.98] overflow-hidden relative";
  const idleClass = canSubmit
    ? dark
      ? "bg-gradient-to-r from-[#e50914] to-[#b0060f] text-white shadow-lg shadow-[#e50914]/30 hover:shadow-[#e50914]/50 hover:brightness-110"
      : "bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-lg shadow-rose-600/25 hover:shadow-rose-600/40 hover:brightness-110"
    : dark
      ? "bg-white/[0.06] text-white/40 cursor-not-allowed"
      : "bg-slate-100 text-slate-400 cursor-not-allowed";
  const activeClass = dark
    ? "bg-white/[0.08] border border-white/10 text-white shadow-[0_16px_40px_-22px_rgba(229,9,20,0.65)] cursor-wait"
    : "bg-slate-900 text-white shadow-[0_20px_42px_-24px_rgba(15,23,42,0.75)] cursor-wait";
  const terminalClass = terminalCopy?.tone === "success"
    ? dark ? "bg-emerald-500/15 border border-emerald-400/30 text-emerald-200" : "bg-emerald-50 border border-emerald-200 text-emerald-800"
    : terminalCopy?.tone === "warning"
      ? dark ? "bg-amber-500/15 border border-amber-400/30 text-amber-200" : "bg-amber-50 border border-amber-200 text-amber-800"
      : dark ? "bg-red-500/15 border border-red-400/30 text-red-200 hover:bg-red-500/20" : "bg-red-50 border border-red-200 text-red-700 hover:bg-red-100";
  const title = terminalCopy?.title || (active ? process.title : idleText);
  const detail = terminalCopy?.detail || (active ? process.detail : "");

  return (
    <button type="button" onClick={click} disabled={disabled} className={`${base} ${active ? activeClass : terminal ? terminalClass : idleClass}`}>
      <span className="relative z-10 flex min-h-[inherit] flex-col items-center justify-center gap-0.5 px-4 py-2.5 text-center leading-tight">
        <span className="inline-flex items-center justify-center gap-2">
          {active && <Loader2 className="w-4 h-4 animate-spin" />}
          {terminalCopy?.tone === "success" && <CheckCircle2 className="w-4 h-4" />}
          <span>{title}</span>
        </span>
        {detail && <span className={`text-[10.5px] sm:text-[11px] font-semibold ${dark ? "opacity-70" : "opacity-75"}`}>{detail}</span>}
      </span>
      {active && (
        <span className={`absolute inset-x-0 bottom-0 h-1 ${dark ? "bg-white/10" : "bg-white/15"}`}>
          <span className="block h-full bg-current opacity-70 transition-all duration-500 ease-out" style={{ width: `${process.progress}%` }} />
        </span>
      )}
    </button>
  );
}

// TvQueueNoticeModal removed — the inline button state ("Signing you in… please keep your TV on")
// is enough. No global popup so users who did not submit a code never see it.

function TvAutoLoginButton({ visible = true }: { visible?: boolean } = {}) {

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  type TvAccount = { account_key?: string; imap_user: string; imap_user_masked: string; actual_imap_user_masked?: string; label: string; cookies_available: boolean };
  const [step, setStep] = useState<"select" | "code">("select");
  const [accounts, setAccounts] = useState<TvAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<TvAccount | null>(null);

  const [code, setCode] = useState<string[]>(["", "", "", "", "", "", "", ""]);
  const [status, setStatus] = useState<TvLoginStatus>("idle");
  const [resultInfo, setResultInfo] = useState<TvRunInfo>({});
  const [pollElapsed, setPollElapsed] = useState(0);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  const resumeActiveTvLogin = useCallback(async (): Promise<boolean> => {
    try {
      const res: any = await apiCall("manage-app", { action: "tv_login_active" });
      const ev = res?.event;
      if (!ev) return false;
      const s = normalizeTvStatus(ev.status);
      if (s === "idle") return false;
      setResultInfo(tvRunInfoFromEvent(ev));
      if (ev.code) setCode(splitTvCode(ev.code));
      setStep("code");
      setStatus(s);
      return true;
    } catch {
      return false;
    }
  }, []);

  const placePanel = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < 640;
    const width = isMobile ? vw - margin * 2 : Math.min(420, vw - margin * 2);
    const estHeight = 560;
    let left: number;
    let top: number;
    if (isMobile) {
      left = margin;
      top = Math.max(margin, (vh - estHeight) / 2);
    } else {
      left = Math.min(Math.max(margin, rect.right - width), vw - width - margin);
      top = Math.min(rect.bottom + 10, Math.max(margin, vh - margin - estHeight));
    }
    setPanelStyle({ left, top, width, maxHeight: `calc(100svh - ${margin * 2}px)` });
  }, []);

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const res: any = await apiCall("manage-app", { action: "tv_list_accounts" });
      if (!res?.success) throw new Error(res?.error || "Failed to load accounts");
      const list: TvAccount[] = Array.isArray(res.accounts) ? res.accounts : [];
      // Only surface accounts that are actually usable. Never reveal readiness state to the user.
      const usable = list.filter((a) => a?.cookies_available);
      setAccounts(usable);
      // If exactly one usable account, skip the picker entirely — go straight to the code step.
      if (usable.length === 1) {
        setChosen(usable[0]);
        setStep((prev) => (prev === "select" ? "code" : prev));
      } else if (usable.length === 0) {
        setChosen(null);
      }
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.dispatchEvent(new CustomEvent("notif:open"));
    placePanel();
    loadAccounts();
    resumeActiveTvLogin().then((resumed) => {
      if (cancelled || resumed) return;
      setStep("select");
      setChosen(null);
      setCode(["", "", "", "", "", "", "", ""]);
      setStatus("idle");
      setResultInfo({});
    });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onReposition = () => placePanel();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      cancelled = true;
      window.dispatchEvent(new CustomEvent("notif:close"));
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, placePanel, loadAccounts, resumeActiveTvLogin]);

  useEffect(() => {
    if (open && step === "code") {
      const t = setTimeout(() => inputsRef.current[0]?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open, step]);

  // Resume in-flight sign-in from DB after a workflow switch / reload — state
  // must not live only in React memory or switching to Gmail loses it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await resumeActiveTvLogin();
    })();
    return () => { cancelled = true; };
  }, [resumeActiveTvLogin]);

  const setDigit = (i: number, v: string) => {
    const d = v.replace(/\D/g, "").slice(-1);
    const clearPreviousCode = isTvRetryableStatus(status);
    if (clearPreviousCode) {
      setStatus("idle");
      setResultInfo({});
      setPollElapsed(0);
    }
    setCode((prev) => {
      const next = clearPreviousCode ? ["", "", "", "", "", "", "", ""] : [...prev];
      next[i] = d;
      return next;
    });
    if (d && i < 7) inputsRef.current[i + 1]?.focus();
  };

  const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !code[i] && i > 0) {
      inputsRef.current[i - 1]?.focus();
    } else if (e.key === "ArrowLeft" && i > 0) {
      inputsRef.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < 7) {
      inputsRef.current[i + 1]?.focus();
    } else if (e.key === "Enter") {
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 8);
    if (!text) return;
    e.preventDefault();
    if (isTvRetryableStatus(status)) {
      setStatus("idle");
      setResultInfo({});
      setPollElapsed(0);
    }
    const arr = ["", "", "", "", "", "", "", ""];
    for (let i = 0; i < text.length; i++) arr[i] = text[i];
    setCode(arr);
    const focusIdx = Math.min(text.length, 7);
    inputsRef.current[focusIdx]?.focus();
  };

  const full = code.join("");
  const isComplete = full.length === 8;

  const submit = async () => {
    if (!isComplete || status !== "idle" || !chosen) return;
    setStatus("verifying");
    setResultInfo({});
    setTimeout(() => setStatus((s) => (s === "verifying" ? "checking" : s)), 500);
    try {
      const res: any = await apiCall("manage-app", { action: "tv_submit_code", code: full, imap_user: chosen.imap_user, account_key: chosen.account_key });
      if (!res?.success) throw new Error(res?.error || "Failed to submit code");
      setResultInfo({
        accountLabel: res.account_label,
        imapMasked: res.imap_user_masked,
        eventId: res.event_id,
        message: res.message || null,
        createdAt: res.created_at || new Date().toISOString(),
      });
      if (!res.cookies_available) { setStatus("no_cookies"); return; }
      setStatus(res.status === "queued" ? "queued" : res.status === "error" ? "error" : "in_progress");
    } catch (err) {
      setResultInfo({ message: err instanceof Error ? err.message : "Something went wrong" });
      setStatus("error");
    }
  };

  // Reset code entry so the user can retry without reopening the modal.
  const resetForRetry = useCallback(() => {
    setCode(["", "", "", "", "", "", "", ""]);
    setStatus("idle");
    setResultInfo({});
    setPollElapsed(0);
    setTimeout(() => inputsRef.current[0]?.focus(), 40);
  }, []);

  // Poll until a real terminal result arrives. Slow queue/runner states stay active
  // so the UI does not show fake timeout failures while the job is still running.
  useEffect(() => {
    const eventId = resultInfo.eventId;
    if (!eventId) return;
    if (!["queued", "running", "in_progress"].includes(status)) return;
    let cancelled = false;
    let timer: number | null = null;
    const startedAt = resultInfo.createdAt ? new Date(resultInfo.createdAt).getTime() : Date.now();
    setPollElapsed(0);
    let consecutiveErrors = 0;

    const tick = async () => {
      const elapsed = Date.now() - startedAt;
      setPollElapsed(elapsed);
      try {
        const res: any = await apiCall("manage-app", { action: "tv_login_status", event_id: eventId });
        if (cancelled) return;
        consecutiveErrors = 0;
        const ev = res?.event;
        if (ev) {
          setResultInfo((prev) => ({ ...prev, ...tvRunInfoFromEvent(ev), message: ev.message || prev.message, runUrl: ev.github_run_url || prev.runUrl }));
          const s = normalizeTvStatus(ev.status);
          const r = String(ev.result || "");
          if (s === "success") {
            setStatus("success");
            return;
          }
          if (r === "runner_timeout" || r === "netflix_timeout") {
            setStatus("invalid_code");
            setResultInfo((prev) => ({ ...prev, message: "Code rejected. Open Netflix on your TV, generate a fresh code, and try again." }));
            return;
          }
          if (s === "invalid_code" || s === "cookies_expired" || s === "no_cookies" || s === "error") {
            setStatus(s);
            return;
          }
          if (s === "running" || s === "queued" || s === "in_progress") setStatus(s);
        }
      } catch {
        consecutiveErrors += 1;
        // After ~5 consecutive network failures (~10s), surface error instead of spinning forever.
        if (consecutiveErrors >= 5 && !cancelled) {
          setStatus("error");
          setResultInfo((prev) => ({ ...prev, message: "Lost connection to the status service. Check your network and try again." }));
          return;
        }
      }
      if (elapsed > 11 * 60_000) {
        setStatus("invalid_code");
        setResultInfo((prev) => ({ ...prev, message: "Code rejected. Open Netflix on your TV, generate a fresh code, and try again." }));
        return;
      }
      if (!cancelled) timer = window.setTimeout(tick, 700);
    };
    timer = window.setTimeout(tick, 500);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [resultInfo.eventId, resultInfo.createdAt, status]);




  const popup = open ? createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Enter Netflix TV code"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={panelStyle}
        className="fixed overflow-y-auto rounded-3xl shadow-[0_25px_80px_-15px_rgba(229,9,20,0.4)] animate-in zoom-in-95 slide-in-from-top-2 duration-200 origin-top-right"
      >
        {/* Netflix-inspired cinematic card */}
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-[#141414] via-[#1a0608] to-[#0a0a0a] border border-white/10">
          {/* Glow accents */}
          <div className="pointer-events-none absolute -top-24 -right-16 w-64 h-64 rounded-full bg-[#e50914]/25 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-32 -left-16 w-72 h-72 rounded-full bg-[#e50914]/10 blur-3xl" />

          {/* Close */}
          <button
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="relative p-6 sm:p-7">
            {/* Header */}
            <div className="flex flex-col items-center text-center">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-gradient-to-br from-[#e50914] to-[#8b0610] shadow-lg shadow-[#e50914]/30 mb-3">
                <Tv className="w-7 h-7 text-white" />
              </div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-[#e50914] font-bold">Netflix • TV</div>
              <h2 className="mt-1 text-xl sm:text-2xl font-black text-white tracking-tight">
                {step === "select" ? "Choose your account" : "Enter your code"}
              </h2>
              <p className="mt-1.5 text-[11.5px] sm:text-xs text-white/60 leading-relaxed max-w-[300px]">
                {step === "select"
                  ? "Select the account you want to sign in on your TV."
                  : "Enter the code displayed on your TV."}
              </p>

              {/* Steps indicator */}
              {accounts.length > 1 && <div className="mt-3 inline-flex items-center gap-2 text-[10px] text-white/40">
                <span className={`inline-flex items-center gap-1.5 ${step === "select" ? "text-white" : ""}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${step === "select" ? "bg-[#e50914]" : "bg-emerald-400"}`} />
                  Account
                </span>
                <span className="w-4 h-px bg-white/15" />
                <span className={`inline-flex items-center gap-1.5 ${step === "code" ? "text-white" : ""}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${step === "code" ? "bg-[#e50914]" : "bg-white/20"}`} />
                  Code
                </span>
              </div>}
            </div>

            {step === "select" ? (
              <div className="mt-5">
                {accountsLoading ? (
                  <div className="py-8 flex flex-col items-center justify-center gap-2 text-white/60">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <div className="text-[11px]">Loading your accounts…</div>
                  </div>
                ) : accountsError ? (
                  <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-3 text-center">
                    <div className="text-[11px] font-bold text-red-300">Couldn't load accounts</div>
                    <div className="text-[10.5px] text-red-200/80 mt-0.5">{accountsError}</div>
                    <button
                      onClick={loadAccounts}
                      className="mt-2 h-8 px-3 rounded-lg text-[11px] font-bold bg-white/10 text-white hover:bg-white/15"
                    >
                      Retry
                    </button>
                  </div>
                ) : accounts.length === 0 ? (
                  <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 px-3 py-3 text-center">
                    <div className="text-[11px] font-bold text-amber-300">TV login not enabled yet</div>
                    <div className="text-[10.5px] text-amber-200/80 mt-0.5 leading-relaxed">Admin hasn't set up TV login for your Netflix account yet. Please check back soon.</div>
                  </div>



                ) : (
                  <div className="flex flex-col gap-2 max-h-[280px] overflow-y-auto pr-1">
                    {accounts.map((acc) => {
                      const selected = (chosen?.account_key || chosen?.imap_user) === (acc.account_key || acc.imap_user);
                      return (
                        <button
                          key={acc.account_key || acc.imap_user}
                          onClick={() => setChosen(acc)}
                          className={`group w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all active:scale-[0.99] ${
                            selected
                              ? "bg-[#e50914]/10 border-[#e50914] shadow-[0_0_20px_-4px_rgba(229,9,20,0.6)]"
                              : "bg-white/[0.04] border-white/10 hover:bg-white/[0.07] hover:border-white/20"
                          }`}
                        >
                          <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${selected ? "bg-[#e50914]/20" : "bg-white/5"}`}>
                            <Mail className={`w-4 h-4 ${selected ? "text-[#e50914]" : "text-white/60"}`} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] font-bold text-white truncate tracking-tight">
                              {acc.imap_user_masked}
                            </div>
                            {acc.label && (
                              <div className="mt-0.5 text-[10px]">
                                <span className="px-1.5 py-0.5 rounded-md bg-white/10 text-white/70 font-semibold">{acc.label}</span>
                              </div>
                            )}
                          </div>
                          <div className={`shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${selected ? "border-[#e50914] bg-[#e50914]" : "border-white/25"}`}>
                            {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                <button
                  onClick={() => { if (chosen) setStep("code"); }}
                  disabled={!chosen}
                  className={`mt-5 w-full h-11 rounded-xl font-bold text-sm tracking-wide transition-all active:scale-[0.98] ${
                    chosen
                      ? "bg-gradient-to-r from-[#e50914] to-[#b0060f] text-white shadow-lg shadow-[#e50914]/30 hover:shadow-[#e50914]/50 hover:brightness-110"
                      : "bg-white/[0.06] text-white/40 cursor-not-allowed"
                  }`}
                >
                  Continue
                </button>

                <div className="mt-3 flex items-center justify-center gap-1.5 text-[10.5px] text-white/40">
                  <ShieldCheck className="w-3 h-3" />
                  <span>Account selection is required to continue</span>
                </div>
              </div>
            ) : (
              <>
                {/* Selected account chip */}
                {chosen && accounts.length > 1 && (
                  <div className="mt-4 flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] border border-white/10 px-3 py-2">
                    <div className="min-w-0 flex items-center gap-2">
                      <Mail className="w-3.5 h-3.5 text-white/60 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[11.5px] font-bold text-white truncate">{chosen.imap_user_masked}</div>
                        {chosen.label && <div className="text-[9.5px] text-white/50 truncate">{chosen.label}</div>}
                      </div>
                    </div>
                    <button
                      onClick={() => { setStep("select"); setStatus("idle"); setResultInfo({}); setCode(["", "", "", "", "", "", "", ""]); }}
                      disabled={isTvActiveStatus(status)}
                      className="text-[10.5px] font-semibold text-[#e50914] hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Change
                    </button>
                  </div>
                )}

                {/* Code inputs */}
                <div className="mt-5 flex items-center justify-center gap-1.5 sm:gap-2">
                  {code.map((d, i) => (
                    <React.Fragment key={i}>
                      {i === 4 && (
                        <span aria-hidden className="shrink-0 w-2 sm:w-3 h-0.5 rounded-full bg-white/25 mx-0.5" />
                      )}
                      <input
                        ref={(el) => { inputsRef.current[i] = el; }}
                        value={d}
                        onChange={(e) => setDigit(i, e.target.value)}
                        onKeyDown={(e) => onKeyDown(i, e)}
                        onPaste={onPaste}
                        onFocus={(e) => e.currentTarget.select()}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={1}
                        disabled={isTvActiveStatus(status) || status === "no_cookies" || status === "cookies_expired"}
                        aria-label={`Digit ${i + 1}`}
                        className={`aspect-square w-full min-w-0 flex-1 text-center text-lg sm:text-2xl font-black rounded-xl bg-white/[0.04] border-2 text-white caret-[#e50914] outline-none transition-all
                          ${d ? "border-[#e50914] bg-[#e50914]/10 shadow-[0_0_20px_-4px_rgba(229,9,20,0.6)]" : "border-white/15"}
                          focus:border-[#e50914] focus:bg-[#e50914]/10 focus:shadow-[0_0_24px_-4px_rgba(229,9,20,0.7)] focus:scale-[1.04]
                          disabled:opacity-60`}
                      />
                    </React.Fragment>
                  ))}
                </div>

                {/* Submit / live process / final result */}
                <TvProcessButton
                  status={status}
                  elapsedMs={pollElapsed}
                  isComplete={isComplete}
                  message={resultInfo.message}
                  onSubmit={submit}
                  onRetry={resetForRetry}
                  idleText="Start TV sign-in"
                  theme="dark"
                />

                <TvRunDetails info={resultInfo} status={status} code={full || undefined} theme="dark" />


                {status === "idle" && (
                  <div className="mt-4 flex items-center justify-center gap-1.5 text-[10.5px] text-white/40">
                    <ShieldCheck className="w-3 h-3" />
                    <span>Encrypted • One-time code • Never shared</span>
                  </div>
                )}


              </>
            )}
          </div>

        </div>
      </div>
    </div>,
    document.body,
  ) : null;


  if (!visible) return null;
  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => { placePanel(); setOpen(true); }}
        className="relative flex items-center justify-center p-2.5 bg-slate-900 text-white rounded-full hover:bg-slate-800 transition-all active:scale-95"
        title="TV Auto-Login"
        aria-label="TV Auto-Login"
      >
        <Tv className="w-4 h-4 sm:w-5 sm:h-5" />
      </button>
      {popup}
    </>
  );
}


// ============================================================================
// TvSignInPage — dedicated full-page TV sign-in surface (no Gmail, inline flow)
// Mirrors the TvAutoLoginButton popup, styled as a spacious page card.
// ============================================================================
function TvSignInPage() {
  type TvAccount = { account_key?: string; imap_user: string; imap_user_masked: string; label: string; cookies_available: boolean };
  // Persist across workflow switches so the user doesn't lose their entered
  // code / picked account when they navigate away and come back mid-flight.
  const DRAFT_KEY = "tv_signin_draft_v1";
  const readDraft = () => {
    try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}"); } catch { return {}; }
  };
  const initialDraft = readDraft();
  const [step, setStep] = useState<"select" | "code">(initialDraft.step === "code" ? "code" : "select");
  const [accounts, setAccounts] = useState<TvAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<TvAccount | null>(initialDraft.chosen || null);
  const [code, setCode] = useState<string[]>(() => {
    const saved = Array.isArray(initialDraft.code) ? initialDraft.code : null;
    if (saved && saved.length === 8) return saved.map((d: any) => (typeof d === "string" ? d.slice(0, 1) : ""));
    return ["", "", "", "", "", "", "", ""];
  });
  const [status, setStatus] = useState<TvLoginStatus>(() => normalizeTvStatus(initialDraft.status));
  const [resultInfo, setResultInfo] = useState<TvRunInfo>(initialDraft.resultInfo || {});
  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  const [pollElapsed, setPollElapsed] = useState(0);
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);


  const applyAccounts = useCallback((list: TvAccount[]) => {
    const filtered = list.filter((a) => a?.cookies_available);
    setAccounts(filtered);
    // Auto-select + skip account picker when exactly one usable cookie-bound account exists.
    if (filtered.length === 1) {
      setChosen(filtered[0]);
      setStep((prev) => (prev === "select" ? "code" : prev));
    } else if (filtered.length === 0) {
      setChosen(null);
    }
  }, []);

  const loadAccounts = useCallback(async (opts?: { background?: boolean }) => {
    const background = !!opts?.background;
    if (!background) setAccountsLoading(true);
    setAccountsError(null);
    try {
      const res: any = await apiCall("manage-app", { action: "tv_list_accounts" });
      if (!res?.success) throw new Error(res?.error || "Failed to load accounts");
      const list: TvAccount[] = Array.isArray(res.accounts) ? res.accounts : [];
      applyAccounts(list);
      try { writeAccountsCache("tv", res); } catch {}
    } catch (err) {
      if (!background) setAccountsError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      if (!background) setAccountsLoading(false);
    }
  }, [applyAccounts]);

  const loadRecentRuns = useCallback(async () => {
    try {
      const res: any = await apiCall("manage-app", { action: "tv_login_recent" });
      if (Array.isArray(res?.events)) setRecentRuns(res.events);
    } catch {}
  }, []);

  useEffect(() => {
    // Instant paint from session cache (populated by prefetchWorkflowAccounts), then
    // silently refresh in background so switching to TV feels immediate.
    const cached: any = readAccountsCache("tv");
    if (cached?.accounts) {
      const list: TvAccount[] = Array.isArray(cached.accounts) ? cached.accounts : [];
      applyAccounts(list);
      setAccountsLoading(false);
      loadAccounts({ background: true });
    } else {
      loadAccounts();
    }
    return undefined;
  }, [loadAccounts, applyAccounts]);

  useEffect(() => { loadRecentRuns(); }, [loadRecentRuns]);

  useEffect(() => {
    if (step === "code") {
      const t = setTimeout(() => inputsRef.current[0]?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [step]);

  // Resume in-flight sign-in from DB (survives workflow switch / reload).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res: any = await apiCall("manage-app", { action: "tv_login_active" });
        if (cancelled) return;
        const ev = res?.event;
        if (!ev) return;
        const s = normalizeTvStatus(ev.status);
        if (s === "idle") return;
        setResultInfo(tvRunInfoFromEvent(ev));
        if (ev.code) setCode(splitTvCode(ev.code));
        setStep("code");
        setStatus(s);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const setDigit = (i: number, v: string) => {
    const d = v.replace(/\D/g, "").slice(-1);
    const clearPreviousCode = isTvRetryableStatus(status);
    if (clearPreviousCode) {
      setStatus("idle");
      setResultInfo({});
      setPollElapsed(0);
    }
    setCode((prev) => { const n = clearPreviousCode ? ["", "", "", "", "", "", "", ""] : [...prev]; n[i] = d; return n; });
    if (d && i < 7) inputsRef.current[i + 1]?.focus();
  };
  const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !code[i] && i > 0) inputsRef.current[i - 1]?.focus();
    else if (e.key === "ArrowLeft" && i > 0) inputsRef.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < 7) inputsRef.current[i + 1]?.focus();
    else if (e.key === "Enter") submit();
  };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 8);
    if (!text) return;
    e.preventDefault();
    if (isTvRetryableStatus(status)) {
      setStatus("idle");
      setResultInfo({});
      setPollElapsed(0);
    }
    const arr = ["", "", "", "", "", "", "", ""];
    for (let i = 0; i < text.length; i++) arr[i] = text[i];
    setCode(arr);
    inputsRef.current[Math.min(text.length, 7)]?.focus();
  };

  const full = code.join("");
  const isComplete = full.length === 8;

  const submit = async () => {
    if (!isComplete || status !== "idle" || !chosen) return;
    setStatus("verifying");
    setResultInfo({});
    setTimeout(() => setStatus((s) => (s === "verifying" ? "checking" : s)), 500);
    try {
      const res: any = await apiCall("manage-app", { action: "tv_submit_code", code: full, imap_user: chosen.imap_user, account_key: chosen.account_key });
      if (!res?.success) throw new Error(res?.error || "Failed to submit code");
      setResultInfo({ accountLabel: res.account_label, imapMasked: res.imap_user_masked, eventId: res.event_id, message: res.message || null, createdAt: res.created_at || new Date().toISOString() });
      if (!res.cookies_available) { setStatus("no_cookies"); return; }
      setStatus(res.status === "queued" ? "queued" : res.status === "error" ? "error" : "in_progress");
      void loadRecentRuns();
    } catch (err) {
      setResultInfo({ message: err instanceof Error ? err.message : "Something went wrong" });
      setStatus("error");
    }
  };

  const resetForRetry = useCallback(() => {
    setCode(["", "", "", "", "", "", "", ""]);
    setStatus("idle");
    setResultInfo({});
    setPollElapsed(0);
    try { sessionStorage.removeItem(DRAFT_KEY); } catch {}
    setTimeout(() => inputsRef.current[0]?.focus(), 40);
  }, []);

  // Persist draft (step + chosen + code) so a workflow switch doesn't wipe it.
  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step, chosen, code, status, resultInfo }));
    } catch {}
  }, [step, chosen, code, status, resultInfo]);



  useEffect(() => {
    const eventId = resultInfo.eventId;
    if (!eventId) return;
    if (!["queued", "running", "in_progress"].includes(status)) return;
    let cancelled = false;
    let timer: number | null = null;
    const startedAt = resultInfo.createdAt ? new Date(resultInfo.createdAt).getTime() : Date.now();
    setPollElapsed(0);
    let consecutiveErrors = 0;
    const tick = async () => {
      const elapsed = Date.now() - startedAt;
      setPollElapsed(elapsed);
      try {
        const res: any = await apiCall("manage-app", { action: "tv_login_status", event_id: eventId });
        if (cancelled) return;
        consecutiveErrors = 0;
        const ev = res?.event;
        if (ev) {
          setResultInfo((p) => ({ ...p, ...tvRunInfoFromEvent(ev), message: ev.message || p.message, runUrl: ev.github_run_url || p.runUrl }));
          const s = normalizeTvStatus(ev.status);
          const r = String(ev.result || "");
          if (s === "success") {
            setStatus("success");
            void loadRecentRuns();
            return;
          }
          if (r === "runner_timeout" || r === "netflix_timeout") { setStatus("invalid_code"); setResultInfo((p) => ({ ...p, message: "Code rejected. Open Netflix on your TV, generate a fresh code, and try again." })); void loadRecentRuns(); return; }
          if (s === "invalid_code" || s === "cookies_expired" || s === "no_cookies" || s === "error") { setStatus(s); void loadRecentRuns(); return; }
          if (s === "running" || s === "queued" || s === "in_progress") setStatus(s);
        }
      } catch {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5 && !cancelled) {
          setStatus("error");
          setResultInfo((p) => ({ ...p, message: "Lost connection to the status service. Check your network and try again." }));
          return;
        }
      }
      if (elapsed > 11 * 60_000) {
        setStatus("invalid_code");
        setResultInfo((p) => ({ ...p, message: "Code rejected. Open Netflix on your TV, generate a fresh code, and try again." }));
        return;
      }
      if (!cancelled) timer = window.setTimeout(tick, 700);
    };
    timer = window.setTimeout(tick, 500);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [resultInfo.eventId, resultInfo.createdAt, status, loadRecentRuns]);

  return (
    <div className="min-h-[calc(100vh-4rem)] px-3 sm:px-6 pt-8 sm:pt-12 xl:pt-16 pb-32 sm:pb-36 bg-gradient-to-b from-white via-rose-50/40 to-white">
      <div className="max-w-2xl xl:max-w-4xl 2xl:max-w-5xl mx-auto">
        {/* Hero */}
        <div className="text-center mb-8 xl:mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-50 border border-rose-100 text-[10px] xl:text-xs font-bold uppercase tracking-[0.22em] text-rose-600">
            <Tv className="w-3 h-3" /> Netflix · TV Sign-in
          </div>
          <h1 className="mt-3 text-3xl sm:text-4xl xl:text-5xl 2xl:text-6xl font-black text-slate-900 tracking-tight">
            {step === "select" ? "Choose your account" : "Enter the 8-digit code"}
          </h1>
          <p className="mt-2 text-sm xl:text-base 2xl:text-lg text-slate-500 max-w-xl mx-auto">
            {step === "select"
              ? "Pick the Netflix account you want to sign in on your TV. We'll handle the rest in under 10 seconds."
              : "Type the code shown on your Netflix TV screen. We'll auto-sign in and confirm here."}
          </p>
          {/* Stepper — hidden for single-account users */}
          {accounts.length > 1 && (
          <div className="mt-5 inline-flex items-center gap-3 text-[11px] xl:text-xs font-bold uppercase tracking-widest">
            <span className={`inline-flex items-center gap-1.5 ${step === "select" ? "text-rose-600" : "text-emerald-600"}`}>
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] ${step === "select" ? "bg-rose-600 text-white" : "bg-emerald-500 text-white"}`}>1</span>
              Account
            </span>
            <span className="w-10 h-px bg-slate-200" />
            <span className={`inline-flex items-center gap-1.5 ${step === "code" ? "text-rose-600" : "text-slate-400"}`}>
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] ${step === "code" ? "bg-rose-600 text-white" : "bg-slate-200 text-slate-500"}`}>2</span>
              Code
            </span>
          </div>
          )}
        </div>

        {/* Card */}
        <div className="relative rounded-3xl bg-white border border-slate-200 shadow-[0_25px_60px_-25px_rgba(2,6,23,0.15)] overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 w-64 h-64 xl:w-96 xl:h-96 rounded-full bg-rose-500/[0.06] blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 w-72 h-72 xl:w-[26rem] xl:h-[26rem] rounded-full bg-rose-500/[0.04] blur-3xl" />

          <div className="relative p-3 sm:p-10 xl:p-14">
            {step === "select" ? (
              <div>
                {accountsLoading ? (
                  <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin text-rose-500" />
                    <div className="text-xs">Loading your accounts…</div>
                  </div>
                ) : accountsError ? (
                  <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-4 text-center">
                    <div className="text-xs font-bold text-red-700">Couldn't load accounts</div>
                    <div className="text-[11px] text-red-600/80 mt-1">{accountsError}</div>
                    <button onClick={() => loadAccounts()} className="mt-2 h-8 px-3 rounded-lg text-[11px] font-bold bg-red-600 text-white hover:bg-red-700">Retry</button>
                  </div>
                ) : accounts.length === 0 ? (
                  <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-6 text-center">
                    <div className="text-sm font-bold text-amber-800">TV login not enabled yet</div>
                    <div className="text-[12px] text-amber-700/90 mt-1 leading-relaxed">Admin hasn't set up TV login for your Netflix account yet. Please check back soon.</div>
                  </div>
                ) : (
                  <div className="grid gap-2.5 max-h-[360px] xl:max-h-[520px] overflow-y-auto pr-1">
                    {accounts.map((acc) => {
                      const selected = (chosen?.account_key || chosen?.imap_user) === (acc.account_key || acc.imap_user);
                      return (
                        <button key={acc.account_key || acc.imap_user}
                          onClick={() => setChosen(acc)}
                          className={`group w-full flex items-center gap-3 rounded-2xl border-2 px-4 py-3.5 xl:py-4 text-left transition-all active:scale-[0.99] ${
                            selected
                              ? "bg-rose-50 border-rose-500 shadow-[0_10px_30px_-12px_rgba(229,9,20,0.35)]"
                              : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                          }`}>
                          <div className={`shrink-0 w-11 h-11 xl:w-12 xl:h-12 rounded-xl flex items-center justify-center ${selected ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-500"}`}>
                            <Mail className="w-5 h-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm xl:text-base font-bold text-slate-900 truncate tracking-tight">{acc.imap_user_masked}</div>
                            {acc.label && (
                              <div className="mt-1 text-[11px] inline-block px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-semibold">{acc.label}</div>
                            )}
                          </div>
                          <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? "border-rose-500 bg-rose-500" : "border-slate-300"}`}>
                            {selected && <span className="w-2 h-2 rounded-full bg-white" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                <button onClick={() => { if (chosen) setStep("code"); }}
                  disabled={!chosen}
                  className={`mt-6 w-full h-12 xl:h-14 rounded-xl xl:rounded-2xl font-black text-sm xl:text-base tracking-wide transition-all active:scale-[0.98] ${
                    chosen
                      ? "bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-lg shadow-rose-600/25 hover:shadow-rose-600/40 hover:brightness-110"
                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                  }`}>
                  Continue →
                </button>
                <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
                  <ShieldCheck className="w-3 h-3" />
                  <span>Account selection is required to continue</span>
                </div>
              </div>
            ) : (
              <div>
                {chosen && accounts.length > 1 && (
                  <div className="flex items-center justify-between gap-2 rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3">
                    <div className="min-w-0 flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-lg bg-white border border-slate-200 flex items-center justify-center">
                        <Mail className="w-4 h-4 text-slate-500" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-900 truncate">{chosen.imap_user_masked}</div>
                        {chosen.label && <div className="text-[11px] text-slate-500 truncate">{chosen.label}</div>}
                      </div>
                    </div>
                    <button onClick={() => { setStep("select"); setStatus("idle"); setResultInfo({}); setCode(["", "", "", "", "", "", "", ""]); }}
                      disabled={isTvActiveStatus(status)}
                      className="shrink-0 text-[11px] font-bold text-rose-600 hover:text-rose-700 transition disabled:opacity-40 disabled:cursor-not-allowed">
                      Change
                    </button>
                  </div>
                )}

                <div className="mt-10 sm:mt-8 flex items-stretch justify-center gap-1.5 sm:gap-2">
                  {code.map((d, i) => (
                    <React.Fragment key={i}>
                      {i === 4 && <span aria-hidden className="self-center shrink-0 w-1.5 sm:w-3 h-0.5 rounded-full bg-slate-300 mx-0 sm:mx-0.5" />}
                      <input
                        ref={(el) => { inputsRef.current[i] = el; }}
                        value={d}
                        onChange={(e) => setDigit(i, e.target.value)}
                        onKeyDown={(e) => onKeyDown(i, e)}
                        onPaste={onPaste}
                        onFocus={(e) => e.currentTarget.select()}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={1}
                        disabled={isTvActiveStatus(status) || status === "no_cookies" || status === "cookies_expired"}
                        aria-label={`Digit ${i + 1}`}
                        className={`aspect-square w-full min-w-0 flex-1 text-center text-2xl sm:text-3xl xl:text-5xl 2xl:text-6xl font-black rounded-xl sm:rounded-2xl bg-white border-2 text-slate-900 caret-rose-500 outline-none transition-all
                          ${d ? "border-rose-500 bg-rose-50 shadow-[0_8px_24px_-8px_rgba(229,9,20,0.4)]" : "border-slate-200"}
                          focus:border-rose-500 focus:bg-rose-50 focus:shadow-[0_8px_24px_-8px_rgba(229,9,20,0.5)] focus:scale-[1.04]
                          disabled:opacity-60 disabled:bg-slate-50`}
                      />
                    </React.Fragment>
                  ))}
                </div>


                <TvProcessButton
                  status={status}
                  elapsedMs={pollElapsed}
                  isComplete={isComplete}
                  message={resultInfo.message}
                  onSubmit={submit}
                  onRetry={resetForRetry}
                  idleText="Sign in on TV"
                  theme="light"
                />

                <TvRunDetails info={resultInfo} status={status} code={full || undefined} theme="light" />

                {status === "idle" && (
                  <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
                    <ShieldCheck className="w-3 h-3" />
                    <span>Encrypted · One-time code · Never shared</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <TvRecentRuns events={recentRuns} onRefresh={loadRecentRuns} />
      </div>
    </div>
  );
}




function SessionCountdown({ role }: { role: "admin" | "user" }) {
  const [minutes, setMinutes] = useState<number>(() => DEFAULT_SESSION_TIMEOUT_MINUTES[role]);
  const [remainingMs, setRemainingMs] = useState<number>(() => {
    ensureSessionStarted();
    return Math.max(0, getSessionDeadline(role) - Date.now());
  });
  const warnedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiCall("manage-app", { action: "get_settings", key: SESSION_CONFIG_KEY_FOR(role) });
        const m = Number(res?.value?.timeoutMinutes) || 0;
        if (!cancelled && m > 0) setMinutes(m);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [role]);

  useEffect(() => {
    warnedRef.current = false;
    const tick = () => {
      ensureSessionStarted();
      const deadline = getSessionDeadline(role, minutes);
      const rem = deadline ? deadline - Date.now() : 0;
      setRemainingMs(Math.max(0, rem));
      if (rem > 0 && rem <= 60_000 && !warnedRef.current) {
        warnedRef.current = true;
        notify.warning("Session ending in 1 minute", {
          id: "session-1min-warning",
          description: "Finish what you're doing — sign in again soon.",
          duration: 9000,
        });

      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [role, minutes]);

  const [showInfo, setShowInfo] = useState(false);
  if (remainingMs <= 0) return null;

  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const urgent = remainingMs <= 60_000;
  const warn = !urgent && remainingMs <= 120_000;
  const cls = urgent
    ? "bg-red-500 text-white animate-pulse ring-2 ring-red-300"
    : warn
    ? "bg-amber-500 text-white"
    : "bg-slate-900/90 text-white";

  const deadline = getSessionDeadline(role, minutes);
  const endsAt = deadline ? new Date(deadline).toLocaleString() : "—";
  const totalMinutes = getSessionTotalMinutes(role, minutes);

  // Keep the session pill bottom-right on both mobile and desktop.
  return (
    <>
      <button
        type="button"
        onClick={() => setShowInfo((v) => !v)}
        title="Tap for details"
        className={`fixed z-[10001] right-3 sm:right-4 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:bottom-4 h-7 sm:h-8 px-3 sm:px-3.5 rounded-full text-[11px] sm:text-xs font-semibold shadow-lg backdrop-blur ${cls} flex items-center gap-1.5 select-none active:scale-95 transition`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
        {role === "admin" ? "Admin" : "Session"}: {pad(mm)}:{pad(ss)}
      </button>

      {showInfo && createPortal(
        <div
          className="fixed inset-0 z-[10002] bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-150"
          onClick={() => setShowInfo(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full sm:w-auto sm:min-w-[22rem] sm:max-w-md max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white shadow-2xl border border-slate-200 p-5 sm:p-6 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] sm:pb-6 animate-in slide-in-from-bottom-4 sm:zoom-in-95 sm:slide-in-from-bottom-0 duration-200"
          >
            <div aria-hidden className="sm:hidden flex justify-center -mt-1 mb-3">
              <div className="w-10 h-1 rounded-full bg-slate-300" />
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 ${urgent ? "bg-red-100 text-red-600" : warn ? "bg-amber-100 text-amber-600" : "bg-slate-100 text-slate-700"}`}>
                <Clock className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold text-slate-900 leading-tight">{role === "admin" ? "Admin session" : "Session timer"}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">Auto sign-out countdown</div>
              </div>
              <button
                onClick={() => setShowInfo(false)}
                aria-label="Close"
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-600 transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-slate-700 leading-relaxed">
              You&apos;ll be <span className="font-bold">signed out automatically</span> when the timer hits zero. Sign in again to continue.
            </p>
            <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500 font-bold">Signs out at</div>
              <div className="text-sm font-semibold text-slate-900 mt-1 break-words">{endsAt}</div>
              <div className="text-[11px] text-slate-500 mt-2">Remaining: <span className="font-bold text-slate-800 tabular-nums">{pad(mm)}:{pad(ss)}</span> · Total: {totalMinutes}m</div>
            </div>
            <button
              onClick={() => setShowInfo(false)}
              className="mt-5 w-full h-11 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 active:scale-[0.98] transition"
            >
              Got it
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}


// --- Free profile expiry pill (auto-deletion notice) ---
// Matches SessionCountdown style; sits directly above the session pill (bottom-right).
function FreeExpiryPill({ userOverride }: { userOverride?: any } = {}) {
  const { user: authUser } = useAuth();
  const user = userOverride || authUser;
  const [now, setNow] = useState<number>(() => Date.now());
  const [showInfo, setShowInfo] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const isFree = !!(user as any)?.isFree;
  const expIso = (user as any)?.expiresAt as string | null | undefined;
  const autoDelete = (user as any)?.autoDelete !== false;


  if (!isFree || !expIso || !autoDelete) return null;
  const expMs = Date.parse(expIso);
  if (!Number.isFinite(expMs)) return null;
  const rem = expMs - now;
  if (rem <= 0) return null;

  const totalSec = Math.floor(rem / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  let label = "";
  if (days >= 1) label = `${days}d ${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  else label = `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;

  const urgent = rem <= 60 * 60_000;
  const warn = !urgent && rem <= 24 * 60 * 60_000;
  const cls = urgent
    ? "bg-red-500 text-white animate-pulse ring-2 ring-red-300"
    : warn
    ? "bg-amber-500 text-white"
    : "bg-emerald-600/90 text-white";

  const full = new Date(expMs).toLocaleString();
  return (
    <>
      <button
        type="button"
        onClick={() => setShowInfo((v) => !v)}
        title="Tap for details"
        className={`fixed z-[10001] right-3 sm:right-4 bottom-[calc(env(safe-area-inset-bottom)+0.75rem+2.25rem)] sm:bottom-[calc(1rem+2.5rem)] h-7 sm:h-8 px-3 sm:px-3.5 rounded-full text-[11px] sm:text-xs font-semibold shadow-lg backdrop-blur ${cls} flex items-center gap-1.5 select-none active:scale-95 transition`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
        Deletes in: {label}
      </button>

      {showInfo && createPortal(
        <div
          className="fixed inset-0 z-[10002] bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in duration-150"
          onClick={() => setShowInfo(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full sm:w-auto sm:min-w-[22rem] sm:max-w-md max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white shadow-2xl border border-slate-200 p-5 sm:p-6 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] sm:pb-6 animate-in slide-in-from-bottom-4 sm:zoom-in-95 sm:slide-in-from-bottom-0 duration-200"
          >
            <div aria-hidden className="sm:hidden flex justify-center -mt-1 mb-3">
              <div className="w-10 h-1 rounded-full bg-slate-300" />
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 ${urgent ? "bg-red-100 text-red-600" : warn ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600"}`}>
                <Clock className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold text-slate-900 leading-tight">Free profile auto-delete</div>
                <div className="text-[11px] text-slate-500 mt-0.5">Countdown to deletion</div>
              </div>
              <button
                onClick={() => setShowInfo(false)}
                aria-label="Close"
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-600 transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-slate-700 leading-relaxed">
              This is a free profile. It will be <span className="font-bold">automatically deleted</span> when the timer hits zero.
            </p>
            <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500 font-bold">Deletes on</div>
              <div className="text-sm font-semibold text-slate-900 mt-1 break-words">{full}</div>
              <div className="text-[11px] text-slate-500 mt-2">Remaining: <span className="font-bold text-slate-800">{label}</span></div>
            </div>
            <button
              onClick={() => setShowInfo(false)}
              className="mt-5 w-full h-11 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 active:scale-[0.98] transition"
            >
              Got it
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}


// --- Paid user plan-end countdown pill (mirror of FreeExpiryPill styling) ---
function PlanEndsPill({ userOverride }: { userOverride?: any } = {}) {
  const { user: authUser } = useAuth();
  const user = userOverride || authUser;
  const [now, setNow] = useState<number>(() => Date.now());
  const [showInfo, setShowInfo] = useState(false);
  const expiredNoticeRef = useRef(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const isFree = !!(user as any)?.isFree;
  const role = (user as any)?.role;
  const endIso = ((user as any)?.planEndsAt || (user as any)?.plan_ends_at) as string | null | undefined;
  // Show only for paid non-admin users with a set plan end date.
  if (isFree || role === "admin" || !endIso) return null;
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(endMs)) return null;
  const rem = endMs - now;
  if (rem <= 0) {
    if (!expiredNoticeRef.current) {
      expiredNoticeRef.current = true;
      // Ask the server to confirm expiry. When it returns
      // { error: "plan_finished", contactInfo, planEndsAt } the global
      // apiCall interceptor dispatches app:plan-finished with the full
      // payload. We do NOT dispatch a bare event here — that used to
      // race the server response and flicker the modal between
      // "with contacts" and "no contacts" states.
      apiCall("manage-app", { action: "me" }).catch(() => {
        // Offline / server unreachable → surface the popup anyway so
        // the user isn't stuck on a dead timer. Contacts merge in
        // later if the server call succeeds on retry.
        try {
          window.dispatchEvent(new CustomEvent("app:plan-finished", { detail: { planEndsAt: endIso } }));
        } catch {}
      });
    }
    return null;
  }

  const totalSec = Math.floor(rem / 1000);
  const days = Math.floor(totalSec / 86400);
  const hrs = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const label = days >= 1 ? `${days}d ${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;

  // Compact label so the pill matches Session pill footprint on mobile.
  const shortLabel = days >= 1
    ? `${days}d ${pad(hrs)}h`
    : (hrs >= 1 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`);
  const urgent = rem <= 10 * 60_000;
  const warn = !urgent && rem <= 60 * 60_000;
  const cls = urgent
    ? "bg-red-500 text-white animate-pulse ring-2 ring-red-300"
    : warn
    ? "bg-amber-500 text-white"
    : "bg-indigo-600/90 text-white";
  const full = new Date(endMs).toLocaleString();

  return (
    <>
      <button
        type="button"
        onClick={() => setShowInfo((v) => !v)}
        title={`Plan ends ${full}`}
        aria-label={`Plan ends in ${label}`}
        className={`fixed z-[10001] right-3 sm:right-4 bottom-[calc(env(safe-area-inset-bottom)+0.75rem+2.75rem)] sm:bottom-[calc(1rem+3rem)] h-7 sm:h-8 px-3 sm:px-3.5 rounded-full text-[11px] sm:text-xs font-semibold shadow-lg backdrop-blur ${cls} flex items-center gap-1.5 select-none active:scale-95 transition tabular-nums`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
        Plan: {label}
      </button>

      {showInfo && createPortal(
        <div
          className="fixed inset-0 z-[10002] bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowInfo(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full sm:w-auto sm:min-w-[22rem] sm:max-w-md max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white shadow-2xl border border-slate-200 p-5 sm:p-6 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] sm:pb-6"
          >
            <div aria-hidden className="sm:hidden flex justify-center -mt-1 mb-3">
              <div className="w-10 h-1 rounded-full bg-slate-300" />
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 ${urgent ? "bg-red-100 text-red-600" : warn ? "bg-amber-100 text-amber-600" : "bg-indigo-100 text-indigo-600"}`}>
                <Clock className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold text-slate-900 leading-tight">Your plan</div>
                <div className="text-[11px] text-slate-500 mt-0.5">Time remaining</div>
              </div>
              <button
                onClick={() => setShowInfo(false)}
                aria-label="Close"
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-600 flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-slate-700 leading-relaxed">
              After your plan ends, sign-in features will be paused. Contact the admin to renew.
            </p>
            <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500 font-bold">Ends on</div>
              <div className="text-sm font-semibold text-slate-900 mt-1 break-words">{full}</div>
              <div className="text-[11px] text-slate-500 mt-2">Remaining: <span className="font-bold text-slate-800">{label}</span></div>
            </div>
            <button
              onClick={() => setShowInfo(false)}
              className="mt-5 w-full h-11 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 active:scale-[0.98] transition"
            >
              Got it
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}



interface Email {
  id: string; subject: string; from: string; to?: string; date: string; otp: string | null; preview: string; html: string; account_label?: string | null; cached_at?: string | null; destroyed?: boolean;
}

type EmailAccountConfig = { label: string; host: string; port: string; user: string; password: string; cloudflareUrls: string[]; recipientFilters?: string[] };

function normalizeAccountLabels(raw: unknown, available: string[] = []): string[] {
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

function escapeEmailHtml(value = "") {
  return String(value).replace(/[&<>"]/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return ch;
  });
}

function stripRawMimeNoise(value = "") {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|table|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/^--[-=_A-Za-z0-9.'+\/]+--?\s*$/gm, "")
    .replace(/^Content-(Type|Transfer-Encoding|Disposition|ID|Description):.*$/gim, "")
    .replace(/^MIME-Version:.*$/gim, "")
    .replace(/^charset=.*$/gim, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeRawMime(value = "") {
  return /Content-Transfer-Encoding|quoted-printable|MIME-Version:|Content-Type:|=_Part_|--[A-Za-z0-9'_()+,./:=?-]{8,}/i.test(String(value || ""));
}

function decodeQuotedPrintableText(input = "") {
  try {
    return String(input || "")
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  } catch {
    return String(input || "");
  }
}

function extractDisplayableMimePart(raw = "") {
  const source = String(raw || "").replace(/\r/g, "");
  const parts = source.split(/\n--[^\n]+/g).map((part) => part.trim()).filter(Boolean);
  const htmlPart = parts.find((part) => /Content-Type:\s*text\/html/i.test(part)) || "";
  const textPart = parts.find((part) => /Content-Type:\s*text\/plain/i.test(part)) || "";
  const chosen = htmlPart || textPart || source;
  const bodyStart = chosen.search(/\n\n/);
  const body = bodyStart >= 0 ? chosen.slice(bodyStart + 2) : chosen;
  return decodeQuotedPrintableText(body)
    .replace(/^Content-[^\n]+$/gim, "")
    .replace(/^MIME-Version:[^\n]+$/gim, "")
    .trim();
}

function decodeHtmlEntities(input = "") {
  return String(input || "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function unwrapPreWrapper(input = "") {
  const m = String(input || "").match(/^\s*<pre[^>]*>([\s\S]*?)<\/pre>\s*$/i);
  if (!m) return input;
  return decodeHtmlEntities(m[1]);
}

function isLikelyCssJunkText(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < 80) return false;
  const cssSignals = [
    /@media\b/i,
    /@font-face\b/i,
    /!important\b/i,
    /\.(mobile|desktop|ios|content|container|footer|hide-link)[-_a-z0-9]*\s*[,{]/i,
    /\b(display|padding(?:-left|-right)?|margin|font-family|table-layout|border-collapse)\s*:/i,
    /webkit-min-device-pixel-ratio/i,
  ];
  return cssSignals.filter((re) => re.test(text)).length >= 2;
}

function stripVisibleCssTextNodes(doc: Document) {
  const body = doc.body;
  if (!body) return;
  const walker = doc.createTreeWalker(body, 4);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  const messageStart = /(this link expires|did you request|your netflix household|household has been confirmed|a new device is using|please review|enter this code|temporary access code|hi\s+[^,]{0,40},)/i;
  nodes.forEach((textNode) => {
    const value = textNode.nodeValue || "";
    if (!isLikelyCssJunkText(value)) return;
    const start = value.search(messageStart);
    if (start > 0) textNode.nodeValue = value.slice(start).trimStart();
    else textNode.parentNode?.removeChild(textNode);
  });
}

function sanitizeEmailHtmlFragment(input = "", preview = "") {
  const raw = String(input || "");
  if (!raw.trim()) {
    return `<pre style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif">${escapeEmailHtml(String(preview || ""))}</pre>`;
  }

  if (typeof DOMParser === "undefined") return raw;

  try {
    const doc = new DOMParser().parseFromString(raw, "text/html");
    // Keep the email's own <style> and inline styles so the original message
    // renders like the sender designed it. Only strip executable/embedding tags.
    doc.querySelectorAll("script, noscript, meta, title, base, object, embed, iframe").forEach((el) => el.remove());
    stripVisibleCssTextNodes(doc);
    doc.querySelectorAll("*").forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = attr.value || "";
        if (name.startsWith("on")) el.removeAttribute(attr.name);
        if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) el.removeAttribute(attr.name);
      });
      if (el.tagName.toLowerCase() === "a") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    });
    const headStyles = Array.from(doc.head?.querySelectorAll("style") || [])
      .map((el) => el.outerHTML)
      .join("\n");
    const bodyHtml = (doc.body?.innerHTML || "").trim();
    if (bodyHtml) return `${headStyles}${bodyHtml}`;
  } catch {}

  const cleaned = stripRawMimeNoise(decodeQuotedPrintableText(raw));
  return `<pre style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.45">${escapeEmailHtml(cleaned || String(preview || ""))}</pre>`;
}

function normalizeEmailHtmlForDisplay(rawHtml = "", preview = "") {
  let raw = String(rawHtml || "");
  if (!raw) {
    return `<pre style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif">${escapeEmailHtml(String(preview || ""))}</pre>`;
  }
  // Legacy cached emails were stored as `<pre>{escaped raw MIME}</pre>`.
  // Unwrap and decode so the MIME extractor below can actually see it.
  const unwrapped = unwrapPreWrapper(raw);
  if (unwrapped !== raw) raw = unwrapped;

  if (!looksLikeRawMime(raw)) return sanitizeEmailHtmlFragment(raw, preview);

  const extracted = extractDisplayableMimePart(raw);
  if (/<\s*(html|body|table|div|p|span|a|img)\b/i.test(extracted) && !looksLikeRawMime(extracted.replace(/<[^>]+>/g, " "))) {
    return sanitizeEmailHtmlFragment(extracted, preview);
  }
  const cleaned = stripRawMimeNoise(decodeQuotedPrintableText(extracted || raw));
  return `<pre style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.45">${escapeEmailHtml(cleaned || String(preview || ""))}</pre>`;
}

function emailHtmlForDisplay(email: Email | null) {
  if (!email) return "";
  return normalizeEmailHtmlForDisplay(String(email.html || ""), String((email as any).preview || (email as any).snippet || ""));
}

// Global listener: resize email iframes from their own measured content height.
// Uses a per-iframe id fallback so sandboxed windows do not miss the match.
if (typeof window !== "undefined" && !(window as any).__emailIframeResizeInstalled) {
  (window as any).__emailIframeResizeInstalled = true;
  window.addEventListener("message", (ev: MessageEvent) => {
    const data: any = ev?.data;
    if (!data || typeof data !== "object") return;
    const h = Number(data.__emailIframeHeight);
    if (!h || h < 40) return;
    const frameId = typeof data.__emailIframeId === "string" ? data.__emailIframeId : "";
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[data-email-iframe="true"]');
    iframes.forEach((f) => {
      const sourceMatches = f.contentWindow === ev.source;
      const idMatches = frameId && f.dataset.emailIframeId === frameId;
      if (!sourceMatches && !idMatches) return;
      const next = Math.ceil(Math.min(Math.max(h + 12, 220), 12000));
      const current = parseFloat(f.style.height || "0");
      if (!current || Math.abs(current - next) > 6) f.style.height = next + "px";
    });
  });
}

function responsiveEmailSrcDoc(email: Email | null) {
  const html = emailHtmlForDisplay(email);
  const iframeId = String((email as any)?.id || "email-preview").replace(/[^a-zA-Z0-9_-]/g, "_");

  return `<!DOCTYPE html><html><head><base target="_blank"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>
    html,body{margin:0!important;padding:0!important;width:100%!important;min-width:0!important;height:auto!important;min-height:0!important;overflow:hidden!important;-webkit-text-size-adjust:100%;text-size-adjust:100%;background:#fff;}
    body{font-family:Arial,Helvetica,sans-serif;color:#221f1f;}
    #email-root{display:block!important;width:100%!important;min-width:0!important;height:auto!important;overflow:visible!important;transform-origin:top left;}
    img{max-width:100%;height:auto;}
    pre{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}
    a{word-break:break-word;overflow-wrap:anywhere;}
  </style></head><body><div id="email-root">${html}</div><script>(function(){
    var iframeId=${JSON.stringify(iframeId)};
    var scale=1;
    function fit(){try{
      var root=document.getElementById('email-root')||document.body;
      root.style.transform='none';root.style.width='auto';
      var vw=Math.max(1,document.documentElement.clientWidth||window.innerWidth||320);
      var natural=Math.max(root.scrollWidth||0,document.body.scrollWidth||0,document.documentElement.scrollWidth||0,vw);
      scale=Math.min(1,vw/natural);
      root.style.transform='scale('+scale+')';
      root.style.width=(100/scale)+'%';
      document.documentElement.style.overflow='hidden';document.body.style.overflow='hidden';
    }catch(e){scale=1;}}
    function measureContentHeight(){try{
      var root=document.getElementById('email-root')||document.body;
      var rootRect=root.getBoundingClientRect();
      var max=Math.ceil(rootRect.height||root.scrollHeight||0);
      root.querySelectorAll('*').forEach(function(el){
        var r=el.getBoundingClientRect();
        var bottom=Math.ceil(r.bottom-rootRect.top);
        if(bottom>max&&bottom<20000)max=bottom;
      });
      return Math.max(40,max+2);
    }catch(e){return Math.max(40,document.body.scrollHeight||document.documentElement.scrollHeight||0);}}
    var lastH=0,pendingH=0;
    function postH(){try{
      var h=measureContentHeight();
      if(h&&Math.abs(h-lastH)>8){lastH=h;parent.postMessage({__emailIframeHeight:h,__emailIframeId:iframeId},'*');}
    }catch(e){}}
    function schedulePostH(){if(pendingH)return;pendingH=1;requestAnimationFrame(function(){pendingH=0;postH();});}
    function tick(){fit();schedulePostH();}
    function force(a){try{a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer');}catch(e){}}
    function scanLinks(){document.querySelectorAll('a,button').forEach(force);}
    document.addEventListener('click',function(e){var a=e.target.closest('a,button');if(!a)return;var href=a.getAttribute('href')||a.dataset.href;if(href){e.preventDefault();window.open(href,'_blank','noopener,noreferrer');}},true);
    document.addEventListener('contextmenu',function(e){e.preventDefault();});
    window.addEventListener('load',tick);
    window.addEventListener('resize',tick);
    document.querySelectorAll('img').forEach(function(img){img.addEventListener('load',tick);img.addEventListener('error',tick);});
    scanLinks();tick();[50,200,500,1000,2000].forEach(function(t){setTimeout(tick,t);});
    try{new MutationObserver(function(){scanLinks();schedulePostH();}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['href','target']});}catch(e){}
  })();<\/script></body></html>`;
}

interface UserData {
  id: string; username: string | null; name: string; role: "admin" | "user"; totpSecret?: string; mustChangePassword?: boolean; assignedAccounts?: string[] | null; profileAvatar?: string | null; profilePrefs?: UserProfilePrefs;
  isFree?: boolean; pinned?: boolean; sortOrder?: number | null; session_limit?: number | null; expiresAt?: string | null; locationRequired?: boolean;
  planStartsAt?: string | null;
  planEndsAt?: string | null;
  tvOverride?: "on" | "off" | null;
  tvFeatureEnabled?: boolean;
}

function adminUserFeatures(u: any): { gmail: boolean; tv: boolean; link: boolean } {
  const f = u?.features && typeof u.features === "object" ? u.features : {};
  return {
    gmail: f.gmail !== undefined ? f.gmail !== false : u?.feature_gmail !== false,
    tv: f.tv !== undefined ? f.tv !== false : u?.feature_tv !== false,
    link: f.link !== undefined ? f.link === true : u?.feature_link === true,
  };
}

type TvOverrideValue = "inherit" | "on" | "off";
type TvFeatureEvent =
  | { type: "tv-global"; enabled: boolean; at: number }
  | { type: "tv-profile"; userId: string; tvOverride: "on" | "off" | null; at: number };

const TV_FEATURE_CHANNEL = "tv_feature_control_v1";

function normalizeTvOverride(value: unknown): "on" | "off" | null {
  return value === "on" || value === "off" ? value : null;
}

function tvOverridePayload(value: TvOverrideValue | "on" | "off" | null): "on" | "off" | "inherit" {
  return value === "on" || value === "off" ? value : "inherit";
}

function broadcastTvFeatureEvent(event: TvFeatureEvent) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TvFeatureEvent>(TV_FEATURE_CHANNEL, { detail: event }));
  try {
    const channel = new BroadcastChannel(TV_FEATURE_CHANNEL);
    channel.postMessage(event);
    channel.close();
  } catch {}
}

function applyTvOverrideToStoredUser(userId: string, tvOverride: "on" | "off" | null) {
  try {
    const raw = sessionGet("user" as any);
    if (!raw) return;
    const stored = JSON.parse(raw);
    if (stored?.id !== userId) return;
    sessionSet("user" as any, JSON.stringify({ ...stored, tvOverride }));
  } catch {}
}

function isLocationRequiredForProfile(profile?: Partial<UserData> | null) {
  if (!profile) return false;
  // Admins default to GPS OFF, but the admin card toggle can turn it ON
  // explicitly. Honor the top-level flag / prefs override when present.
  if (profile.role === "admin") {
    if (typeof profile.locationRequired === "boolean") return profile.locationRequired;
    if (profile.profilePrefs?.locationRequiredOverride === true) {
      return profile.profilePrefs?.locationRequired === true;
    }
    return false;
  }
  // Trust the top-level flag the server sends (already role-aware). Fall back
  // to nested prefs only if the top-level flag is missing.
  if (typeof profile.locationRequired === "boolean") return profile.locationRequired;
  const explicitOverride = profile.profilePrefs?.locationRequiredOverride === true;
  const nested = profile.profilePrefs?.locationRequired;
  return !(explicitOverride && nested === false);
}

// TV Auto-Login visibility: admins always see it (for QA). For regular users:
// per-profile override wins (`on`/`off`); otherwise fall back to the global
// `tvFeature.enabled` flag from bootstrap. Default = enabled.
function isTvVisibleFor(
  user: Partial<UserData> | null | undefined,
  tvFeatureEnabled: boolean,
): boolean {
  if (!user) return false;
  if (user.role === "admin" || (user as any)?.impersonated === true) return true;
  if (user.tvOverride === "on") return true;
  if (user.tvOverride === "off") return false;
  return tvFeatureEnabled !== false;
}

function getUserRefreshAccountLabels(user: Partial<UserData>): string[] | null | undefined {
  if ((user as any)?.impersonated === true && user.role === "admin") return [];
  if (Array.isArray(user.assignedAccounts)) {
    return normalizeAccountLabels(user.assignedAccounts);
  }
  // During a hard refresh the auth shell can render before `/me` has hydrated
  // assignedAccounts. That state is UNKNOWN, not "no accounts". Returning []
  // here made the inbox clear itself and purge IndexedDB, causing the visible
  // show → vanish → show behavior users saw.
  if (!user.id || user.role !== "admin") return undefined;
  return user.role === "admin" ? null : [];
}

function buildWorkerRequestGroups(labels: string[] | null | undefined, map: WorkerUrlMap, primaryUrls: string[]) {
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  const primary = Array.from(new Set([...(map.primary || []), ...primaryUrls].map(norm).filter(Boolean)));

  // Admin / unrestricted: hit exactly one worker (any primary).
  if (labels === null) {
    const pool = primary.length > 0 ? primary : Array.from(new Set(Object.values(map.byAccount || {}).flat().map(norm).filter(Boolean)));
    const url = pool.length > 0 ? pool[0] : "";
    return url ? [{ url, labels: null as string[] | null }] : [];
  }

  if (labels === undefined) return [];

  if (labels.length === 0) return [];

  // Build per-label URL pool (dedicated overrides primary).
  const pools: { label: string; pool: string[] }[] = labels.map((label) => {
    const dedicated = Array.from(new Set((map.byAccount?.[label] || []).map(norm).filter(Boolean)));
    return { label, pool: dedicated.length > 0 ? dedicated : primary };
  }).filter((x) => x.pool.length > 0);

  if (pools.length === 0) return [];

  // Fast path: if a single URL exists in EVERY label's pool, use one grouped request.
  const shared = pools.reduce<string[]>((acc, { pool }, i) => {
    if (i === 0) return [...pool];
    return acc.filter((u) => pool.includes(u));
  }, []);
  if (shared.length > 0) {
    return [{ url: shared[0], labels: pools.map((p) => p.label) }];
  }

  // Otherwise: deterministic grouping — each label goes to the first URL in its pool.
  // Labels that resolve to the same URL are merged into one request; distinct URLs run in parallel.
  const grouped = new Map<string, string[]>();
  for (const { label, pool } of pools) {
    const url = pool[0];
    grouped.set(url, [...(grouped.get(url) || []), label]);
  }
  return Array.from(grouped.entries()).map(([url, groupLabels]) => ({ url, labels: groupLabels }));
}

function appendAccountLabelParams(params: URLSearchParams, labels: string[] | null) {
  if (!labels) return;
  for (const label of labels) params.append("accountLabel", label);
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message = "Request timed out"): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  }) as Promise<T>;
}

async function isUsableEmailWorker(url: string) {
  try {
    const res = await fetchWithTimeout(`${url.replace(/\/+$/, "")}/api/health`, { cache: "no-store" }, 5000);
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    // Universal Cloudflare mode: a new account may have no Worker runtime
    // secrets yet. Email APIs still work because the Worker validates the
    // session through Supabase and then fetches via Cloudflare. Requiring
    // `signing=true` here made fresh GitHub-connected Workers look unusable,
    // so the browser never hit them.
    return data?.ok === true && data?.kv === true;
  } catch {
    return false;
  }
}

function mergeEmailsById(lists: Email[][]): Email[] {
  const byId = new Map<string, Email>();
  for (const list of lists) {
    for (const email of list) {
      if (!email?.id) continue;
      if (email.destroyed) byId.delete(email.id);
      else byId.set(email.id, email);
    }
  }
  return Array.from(byId.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

type UserProfilePrefs = {
  avatarId?: string | null;
  locationRequired?: boolean;
  locationRequiredOverride?: boolean;
  hiddenBefore?: string | null;
  hiddenEmailIds?: string[];
};

// --- Password Toggle Helper ---
function PasswordInput({ value, onChange, placeholder, className, autoFocus, required }: {
  value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string; className?: string; autoFocus?: boolean; required?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? "text" : "password"} value={value} onChange={onChange}
        placeholder={placeholder}
        aria-label={placeholder || "Password"}
        aria-required={required || undefined}
        className={(className || "") + " text-slate-900 placeholder:text-slate-400"}
        autoFocus={autoFocus} />
      <button type="button" onClick={() => setShow(!show)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors p-1">
        {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

// --- Profile Colors ---
const PROFILE_COLORS = [
  "bg-red-500", "bg-blue-500", "bg-green-500", "bg-purple-500",
  "bg-orange-500", "bg-pink-500", "bg-teal-500", "bg-indigo-500",
];

function getAvatarUri(avatarId?: string | null): string | null {
  return resolveAvatar(avatarId);
}

const DEFAULT_PROFILE_AVATAR_IDS = AVATAR_CATEGORIES.flatMap((category) =>
  category.files.map((file) => buildAvatarId(category.key, file))
);

function getStableProfileAvatar(profile?: Pick<UserData, "id" | "username" | "name" | "profileAvatar"> | null): string | null {
  if (!profile) return null;
  if (profile.profileAvatar && getAvatarUri(profile.profileAvatar)) return profile.profileAvatar;
  if (DEFAULT_PROFILE_AVATAR_IDS.length === 0) return null;
  const seed = `${profile.id || profile.username || "profile"}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return DEFAULT_PROFILE_AVATAR_IDS[hash % DEFAULT_PROFILE_AVATAR_IDS.length];
}

function ProfileAvatar({ avatarId, name, className = "w-16 h-16", fallbackColor = "bg-red-500", eager = false }: { avatarId?: string | null; name?: string; className?: string; fallbackColor?: string; eager?: boolean }) {
  const uri = getAvatarUri(avatarId);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);
  if (!uri || failed) {
    return (
      <div className={`${className} rounded-xl sm:rounded-2xl ${fallbackColor} shadow-lg shadow-black/30 ring-1 ring-white/10 overflow-hidden`} aria-label={name || undefined} />
    );
  }
  return (
    <div className={`${className} relative rounded-xl sm:rounded-2xl bg-slate-900 overflow-hidden shadow-lg shadow-black/30 ring-1 ring-white/10`}>
      <img
        src={uri}
        loading={eager ? "eager" : "lazy"}
        decoding={eager ? "sync" : "async"}
        fetchPriority={eager ? "high" : "auto"}
        alt=""
        onError={() => setFailed(true)}
        className="w-full h-full object-cover"
      />
    </div>
  );
}

const warmedAvatarUrls = new Set<string>();
const loadedAvatarUrls = new Set<string>();
const avatarLoadPromises = new Map<string, Promise<void>>();

function warmAvatarUrls(urls: string[], priority: "high" | "low" = "low") {
  if (typeof window === "undefined") return;
  urls.forEach((url) => {
    if (warmedAvatarUrls.has(`${priority}:${url}`)) return;
    warmedAvatarUrls.add(`${priority}:${url}`);
    const link = document.createElement("link");
    link.rel = priority === "high" ? "preload" : "prefetch";
    link.as = "image";
    link.href = url;
    if (priority === "high") link.setAttribute("fetchpriority", "high");
    document.head.appendChild(link);

    const img = new Image();
    img.decoding = "async";
    img.src = url;
  });
}

function loadAvatarUrl(url: string): Promise<void> {
  if (loadedAvatarUrls.has(url)) return Promise.resolve();
  const existing = avatarLoadPromises.get(url);
  if (existing) return existing;

  const promise = new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    const done = () => {
      loadedAvatarUrls.add(url);
      resolve();
    };
    img.onload = done;
    img.onerror = done;
    img.src = url;
    if (img.complete) done();
  });
  avatarLoadPromises.set(url, promise);
  return promise;
}

function preloadAvatarUrls(urls: string[], maxWaitMs = 6000, priority: "high" | "low" = "high"): Promise<void> {
  if (urls.length === 0) return Promise.resolve();
  warmAvatarUrls(urls, priority);
  return Promise.race([
    Promise.allSettled(urls.map(loadAvatarUrl)).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, maxWaitMs)),
  ]);
}

function getCategoryKeyFromAvatarId(avatarId?: string | null): string | null {
  if (!avatarId?.startsWith("netflix:")) return null;
  const [, key] = avatarId.split(":");
  return AVATAR_CATEGORIES.some((category) => category.key === key) ? key : null;
}

function warmAvatarCategory(categoryKey: string, priority: "high" | "low" = "low") {
  warmAvatarUrls(getAvatarCategoryUrls(categoryKey), priority);
}

function preloadAvatarCategory(categoryKey: string, maxWaitMs?: number, priority: "high" | "low" = "high") {
  return preloadAvatarUrls(getAvatarCategoryUrls(categoryKey), maxWaitMs, priority);
}



function emailIdentity(email: Pick<Email, "id" | "account_label">) {
  return `${email.account_label || "unassigned"}:${email.id}`;
}

type EmailCategory = "signin" | "password_reset" | "account_update" | "other";
const RE_SIGNIN = /(sign[\s-]?in code|new sign[\s-]?in|new device|temporary access code|is using your account|access your account|otp)/i;
const RE_HOUSEHOLD = /(netflix household|your household|update your household|household has been confirmed|part of your (netflix )?household|watching on a tv|traveling|travelling|new device|new sign[\s-]?in|signed in on|is this you|confirm (this|your) device|approve (this|your) device|watch instead|yes,? this was me)/i;
const RE_PASSWORD_RESET = /(password (was |has been )?(changed|reset|updated)|reset your password|new password)/i;
const RE_ACCOUNT_UPDATE = /(attention|action (needed|required)|account (information|info|details) (was |has been )?(changed|updated)|changes? to your account|email (address )?(was |has been )?(changed|updated)|new email address|email verification|verification email|verify (your )?(email address|phone number|mobile number|account)|confirm (your )?(email address|phone number|mobile number|account change|account)|membership (was |has been )?(cancell?ed|updated|paused)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold)|we[’']re sorry to see you go|payment (received|method|was|has been|declined|failed|updated|changed)|mobile (number )?(confirm|confirmed|verify|verified|update|updated)|phone (number )?(confirm|confirmed|verify|verified|update|updated)|verify (your )?(phone|mobile|email)|verify your email address|action needed: verify|request to make a change|update your account|make (a |any )?(change|changes) to your account)/i;
// ============================================================================
// ⚠️  DO NOT TOUCH — HARD BLOCK: Netflix account-change mails ⚠️
// ----------------------------------------------------------------------------
// Any Netflix mail generated by an ACCOUNT MODIFICATION — email change, phone
// number add/update, password change, profile add/remove/rename, payment
// method update, membership pause/cancel, "Confirm your account change with
// this code: XXXXXX", "Confirm your email address change" etc. — is HARD
// BLOCKED for end users. No admin toggle overrides this. Only the admin panel
// sees these mails. Runs BEFORE OTP detection so account-change mails that
// carry a code are still caught. Mirrors the server rule in manage-app.
// ============================================================================
const RE_ACCOUNT_CHANGE_STRONG = /(confirm (your )?(account change|email address change|change to your account|new email|phone (number )?change)|your (account (information|info|details)|email address|phone number|password) (was |has been |is )?(changed|updated|added|removed|reset)|(email address|phone number|password|payment method|payment info|billing info|account information) (was |has been )?(changed|updated|added|removed|reset|verified)|changes? to your account (was|has been|were) (made|updated)|make (a |any )?(change|changes) to your account|request to make a change|password (was |has been )?(changed|reset|updated)|(a )?new profile (was |has been )?(added|created)|profile (was |has been )?(added|created|removed|deleted|renamed|updated|modified)|(a )?profile (has been|was) (added|removed|deleted|renamed)|added a (new )?(phone|mobile|email|profile)|(mobile|phone) number (was |has been )?(added|updated|changed|removed|verified|confirmed)|membership (was |has been )?(cancell?ed|updated|paused|on hold|restarted|resumed|reactivated)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold|reactivated)|we[’']re sorry to see you go|payment (method|info|information) (was |has been )?(updated|changed|added|removed)|update your account (information|info|details)|action needed: (verify|update|confirm))/i;

function classifyEmail(e: Email): EmailCategory {
  const subject = (e.subject || "").toLowerCase();
  const preview = (e.preview || "").toLowerCase();
  const combined = `${subject} ${preview}`;
  // HARD BLOCK (see banner above) — always wins, even over OTP.
  if (RE_ACCOUNT_CHANGE_STRONG.test(combined)) return "account_update";
  if (e.otp || RE_HOUSEHOLD.test(combined) || RE_SIGNIN.test(combined) || /verification code/i.test(subject)) return "signin";
  if (RE_ACCOUNT_UPDATE.test(combined)) return "account_update";
  if (RE_PASSWORD_RESET.test(combined)) return "password_reset";
  return "other";
}

function filterVisibleEmails(list: Email[], _prefs?: UserProfilePrefs | null, viewer?: Partial<UserData> | null) {
  const filters = getEmailFilters();
  const hideSignin = filters.showSignInCodes === false;
  const hideReset = filters.showPasswordResets === false;
  const nonAdmin = viewer?.role !== "admin";
  return list.filter((email) => {
    const cat = classifyEmail(email);
    // ⚠️ HARD BLOCK — never show account-modification mails to end users.
    //    Admin toggle irrelevant. See banner above. Admin panel keeps them.
    if (nonAdmin && cat === "account_update") return false;
    if (nonAdmin && cat === "password_reset") return false;
    if (nonAdmin && viewer?.isFree && cat !== "signin") return false;
    if (hideSignin && cat === "signin") return false;
    if (hideReset && cat === "other") return false;
    return true;
  });
}

// ==================== CAPTCHA MODAL (shared) ====================
export type CaptchaStage = "verifying" | "connecting" | "authenticating";

function CaptchaModal({ siteKey, onVerify, onCancel, stage }: {
  siteKey: string;
  onVerify: (token: string) => void;
  onCancel: () => void;
  /** When set, hides captcha widget and shows a stepper — the login is in-flight. */
  stage?: CaptchaStage | null;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Warm the ECDH handshake in parallel while the user solves the captcha,
  // so we don't pay 400–1500ms of TLS+ECDH+HKDF after they click Continue.
  useEffect(() => {
    let cancelled = false;
    import("./lib/secureTransport")
      .then((m) => { if (!cancelled) void m.warmupSession(); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);


  const submit = useCallback(() => {
    if (token && !submitting) {
      setSubmitting(true);
      onVerify(token);
    }
  }, [token, submitting, onVerify]);

  const handleToken = useCallback((nextToken: string | null) => {
    setLoadError(false);
    setToken(nextToken);
    if (nextToken) {
      setSubmitting(true);
      onVerify(nextToken);
    }
  }, [onVerify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && token) { e.preventDefault(); onVerify(token); }
      else if (e.key === "Escape" && !stage) { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token, onVerify, onCancel, stage]);

  const busy = !!stage;
  const steps: Array<{ id: CaptchaStage; label: string }> = [
    { id: "verifying", label: "Verifying you're human" },
    { id: "connecting", label: "Securing connection" },
    { id: "authenticating", label: "Signing you in" },
  ];
  const activeIdx = stage ? steps.findIndex((s) => s.id === stage) : -1;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        className="bg-white w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="bg-blue-600 p-2 rounded-xl">
              <ShieldCheck className="text-white w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black text-slate-900 text-lg">{busy ? "Signing you in" : "Security Check"}</h3>
              <p className="text-slate-500 text-xs">{busy ? "This takes a moment — hang tight." : "Verify you're human to continue"}</p>
            </div>
          </div>
        </div>

        {busy ? (
          <div className="px-6 pb-5" aria-live="polite">
            <ol className="space-y-2.5">
              {steps.map((s, i) => {
                const done = i < activeIdx;
                const active = i === activeIdx;
                return (
                  <li key={s.id} className="flex items-center gap-3 text-sm">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      done ? "bg-emerald-500 text-white" : active ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-500"
                    }`}>
                      {done ? <Check className="w-3 h-3" /> : active ? (
                        <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                      ) : (i + 1)}
                    </span>
                    <span className={done ? "text-slate-400 line-through" : active ? "text-slate-900 font-bold" : "text-slate-500"}>
                      {s.label}
                    </span>
                  </li>
                );
              })}
            </ol>
            <div className="mt-4 h-1 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600 rounded-full transition-all duration-500"
                style={{ width: `${Math.max(15, Math.min(100, ((activeIdx + 1) / steps.length) * 100))}%` }} />
            </div>
          </div>
        ) : (
          <>
            <div className="flex justify-center px-6 pb-4 min-h-[78px]">
              <Suspense fallback={<div className="h-[78px] w-[304px] rounded-lg bg-slate-100 animate-pulse" />}>
                <ReCAPTCHA
                  sitekey={siteKey}
                  onChange={handleToken}
                  onExpired={() => setToken(null)}
                  onErrored={() => { setToken(null); setLoadError(true); }}
                />
              </Suspense>
            </div>
            {loadError && (
              <p className="px-6 pb-4 text-xs font-bold text-red-600 text-center">
                CAPTCHA domain/key is not allowed for this site. Add this domain in Google reCAPTCHA settings, then refresh.
              </p>
            )}

            <div className="flex border-t border-slate-100">
              <button onClick={onCancel}
                className="flex-1 py-4 text-sm font-bold text-slate-500 hover:bg-slate-50 transition-colors">
                Cancel
              </button>
              <div className="w-px bg-slate-100" />
              <button
                onClick={submit}
                disabled={!token || submitting}
                className="flex-1 py-4 text-sm font-bold text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                {submitting ? "Continuing..." : token ? "Continue" : "Waiting..."}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}


// ==================== NETFLIX-STYLE PROFILE LOGIN ====================
function ProfileSelectPage() {
  const cachedBootstrap = useMemo(() => readBootstrapCache(), []);
  const cachedUsers = useMemo<UserData[]>(
    () => (cachedBootstrap?.users || []).filter((u: UserData) => u.role === "user"),
    [cachedBootstrap]
  );
  const [profiles, setProfiles] = useState<UserData[]>(cachedUsers);
  const [selectedProfile, setSelectedProfile] = useState<UserData | null>(null);
  const [password, setPassword] = useState("");
  // Only show a skeleton on cold visits (no cache at all).
  const [loading, setLoading] = useState(cachedUsers.length === 0);
  const [fromCache, setFromCache] = useState(cachedUsers.length > 0);
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState("");
  const cachedSiteKey = cachedBootstrap?.recaptcha?.enabled === true && cachedBootstrap?.recaptcha?.siteKey ? String(cachedBootstrap.recaptcha.siteKey) : null;
  const [siteKey, setSiteKey] = useState<string | null>(cachedSiteKey);
  const [captchaReady, setCaptchaReady] = useState(!!cachedBootstrap);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [pendingLogin, setPendingLogin] = useState(false);
  const [freeLoginId, setFreeLoginId] = useState<string | null>(null);
  const [freeCaptchaProfile, setFreeCaptchaProfile] = useState<UserData | null>(null);
  // Progress stage shown by CaptchaModal after the user solves the captcha.
  const [loginStage, setLoginStage] = useState<CaptchaStage | null>(null);
  const [gpsRequesting, setGpsRequesting] = useState(false);
  const [gpsPermissionMode, setGpsPermissionMode] = useState<GpsPermissionMode | null>(null);
  const pendingClientGeoRef = useRef<LoginLocationPayload | null>(null);
  const armedGeoRef = useRef<Promise<LoginLocationPayload> | null>(null);
  const armedDeviceRef = useRef<Promise<DeviceFingerprint> | null>(null);
  const selectedLocationRequired = isLocationRequiredForProfile(selectedProfile);
  const gpsBlocked = gpsPermissionMode !== null;
  const navigate = useNavigate();
  const { user: authUser, checkAuth } = useAuth();

  useEffect(() => {
    if (!authUser) return;
    const path = window.location.pathname;
    if (path.startsWith("/admin") || path === "/viewer") return;
    if ((authUser as any)?.impersonated === true) navigate("/admin/viewer", { replace: true });
    else if (authUser.role === "user") navigate("/viewer", { replace: true });
    else if (authUser.role === "admin") navigate("/admin/dashboard", { replace: true });
  }, [authUser?.id, authUser?.role, (authUser as any)?.impersonated, navigate]);

  useEffect(() => {
    let cancelled = false;
    // Always fetch fresh on mount so after logout / avatar change the profile
    // grid reflects the latest data instead of the stale module singleton.
    bootstrapFromSupabase({ force: true })
      .then((bootstrap) => {
        if (cancelled) return;
        setProfiles((bootstrap.users || []).filter((u: UserData) => u.role === "user"));
        if (bootstrap.recaptcha?.enabled === true && bootstrap.recaptcha?.siteKey) {
          setSiteKey(bootstrap.recaptcha.siteKey);
          preloadRecaptchaScript();
        } else {
          setSiteKey(null);
        }
        setError("");
        setFromCache(false);
        setCaptchaReady(true);
      })
      .catch((err) => {
        console.warn("Bootstrap refresh failed (using cache/fallback):", err);
        if (!cancelled) {
          // Do NOT block sign-in on a captcha/config fetch hiccup. If we already
          // have profiles from the cached bootstrap, stay usable; only show a
          // hard error when we have nothing at all to render.
          setSiteKey(null);
          setCaptchaReady(true);
          if (profiles.length === 0) {
            setError("Connection is busy. Please refresh or try again in a few seconds.");
          } else {
            setError("");
          }
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [profileSearch, setProfileSearch] = useState("");
  const displayProfiles = useMemo(() => {
    const list = profiles.map((profile) => ({ ...profile, profileAvatar: getStableProfileAvatar(profile) }));
    const q = profileSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => (p.name || "").toLowerCase().includes(q) || (p.username || "").toLowerCase().includes(q));
  }, [profiles, profileSearch]);


  // Preload profile avatars into browser cache the instant profiles arrive.
  useEffect(() => {
    displayProfiles.forEach((p) => {
      const uri = getAvatarUri(p.profileAvatar);
      if (uri) { const img = new Image(); img.decoding = "async"; img.src = uri; }
    });
  }, [displayProfiles]);

  useEffect(() => {
    if (!selectedLocationRequired) { setGpsPermissionMode(null); return; }
    if (!selectedProfile || typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    const primeGpsSheet = async () => {
      try {
        if (navigator.permissions?.query) {
          const permission = await navigator.permissions.query({ name: "geolocation" as PermissionName });
          if (cancelled) return;
          setGpsPermissionMode(permission.state === "granted" ? null : permission.state === "denied" ? "blocked" : "needed");
        } else if (!cancelled) {
          setGpsPermissionMode("needed");
        }
      } catch {
        if (!cancelled) setGpsPermissionMode("needed");
      }
    };
    void primeGpsSheet();
    return () => { cancelled = true; };
  }, [selectedProfile?.id, selectedLocationRequired]);



  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProfile) return;
    if (!password.trim()) {
      setError("Password required");
      notify.error("Password required");
      return;
    }
    // When admin turned OFF the location policy, skip all GPS handling and
    // go straight to captcha / login. No permission prompt, no device geo call.
    if (!selectedLocationRequired) {
      setGpsPermissionMode(null);
      notify.dismiss(GPS_PERMISSION_TOAST_ID);
      setError("");
      void startLocationThenLogin();
      return;
    }
    // FIRE GEOLOCATION FIRST — synchronously, before any setState / notify.
    // Chrome Android + Incognito silently drop the native prompt if there is
    // any async gap between the user gesture and getCurrentPosition().
    const hasPreparedGeo = hasGrantedLocation(pendingClientGeoRef.current);
    const geoPromise = hasPreparedGeo ? undefined : (armedGeoRef.current ?? beginGeolocationCapture());
    const devicePromise = hasPreparedGeo ? undefined : (armedDeviceRef.current ?? beginDeviceFingerprintCapture());
    armedGeoRef.current = null;
    armedDeviceRef.current = null;
    setGpsPermissionMode(null);
    notify.dismiss(GPS_PERMISSION_TOAST_ID);
    setError("");
    void startLocationThenLogin(geoPromise, devicePromise);
  };

  const armLoginTelemetry = () => {
    if (!selectedLocationRequired) return;
    if (hasGrantedLocation(pendingClientGeoRef.current)) return;
    if (!armedGeoRef.current) armedGeoRef.current = beginGeolocationCapture();
    if (!armedDeviceRef.current) armedDeviceRef.current = beginDeviceFingerprintCapture();
  };

  const primeGpsFromPointer = () => {
    if (!selectedProfile || loginLoading || pendingLogin || !password.trim()) return;
    armLoginTelemetry();
  };

  const primeGpsEnableFromPointer = () => {
    if (gpsRequesting || loginLoading) return;
    if (hasGrantedLocation(pendingClientGeoRef.current)) return;
    // Start a fresh native GPS prompt on the earliest user gesture. Mobile
    // Chrome is more reliable on pointerdown than click for permission prompts.
    if (!selectedLocationRequired && selectedProfile) return;
    armedGeoRef.current = beginGeolocationCapture();
    armedDeviceRef.current = beginDeviceFingerprintCapture();
  };

  // Auto-run the queued login the moment bootstrap finishes.
  useEffect(() => {
    if (!pendingLogin || !captchaReady) return;
    setPendingLogin(false);
    void startLocationThenLogin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLogin, captchaReady, siteKey]);

  useEffect(() => {
    if (!gpsBlocked || typeof navigator === "undefined") return;
    let active = true;
    let status: PermissionStatus | null = null;
    const clearBlocked = () => {
      setGpsPermissionMode(null);
      notify.dismiss(GPS_PERMISSION_TOAST_ID);
      notify.info("Location ready", { id: "gps-permission-ready", description: "Tap Sign In to continue.", duration: 8500 });
    };
    const recheck = async () => {
      if (!active || !navigator.permissions?.query) return;
      try {
        const p = await navigator.permissions.query({ name: "geolocation" as PermissionName });
        if (active && p.state !== "denied") clearBlocked();
      } catch {}
    };
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: "geolocation" as PermissionName }).then((permission) => {
        if (!active) return;
        status = permission;
        permission.onchange = () => { if (active && permission.state !== "denied") clearBlocked(); };
      }).catch(() => {});
    }
    const onVisible = () => { if (document.visibilityState === "visible") recheck(); };
    window.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", recheck);
    return () => {
      active = false;
      if (status) status.onchange = null;
      window.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", recheck);
    };
  }, [gpsBlocked]);

  const startLocationThenLogin = async (preStartedGeo?: Promise<LoginLocationPayload>, preStartedDevice?: Promise<DeviceFingerprint>) => {
    if (!selectedProfile) return;
    setLoginLoading(true);
    setError("");

    try {
      // Admin turned off location: never call requireLoginLocation.
      // Send login with clientGeo=null; server accepts because policy is off.
      const clientGeo: LoginLocationPayload | null = selectedLocationRequired
        ? (hasGrantedLocation(pendingClientGeoRef.current) ? pendingClientGeoRef.current : await requireLoginLocation(preStartedGeo, preStartedDevice))
        : null;
      pendingClientGeoRef.current = clientGeo;
      if (!captchaReady) {
        setPendingLogin(true);
        setLoginLoading(false);
        if (selectedLocationRequired) {
          notify.info("Location ready", { id: "gps-permission-ready", description: "Finishing security check…", duration: 8500 });
        }
        return;
      }
      if (siteKey) {
        setShowCaptcha(true);
        setLoginLoading(false);
      } else {
        await executeLogin(undefined, clientGeo || undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      if (isGpsPermissionDeniedMessage(msg)) {
        setError("");
        setGpsPermissionMode(getGpsPermissionMode(msg));
        showGpsPermissionToast(msg);
      } else {
        setError(msg);
        notify.error(msg);
      }
      setLoginLoading(false);
    }
  };

  const requestGpsPermissionOnly = async () => {
    if (hasGrantedLocation(pendingClientGeoRef.current)) {
      setGpsPermissionMode(null);
      notify.success("Location enabled", { id: "gps-permission-ready", description: selectedProfile ? "Now tap Sign In." : "Now tap the profile again.", duration: 8500 });
      return;
    }
    // Prefer the fresh request started on pointerdown; if this came from
    // keyboard/click only, start it synchronously here.
    const geoPromise = armedGeoRef.current ?? beginGeolocationCapture();
    const devicePromise = armedDeviceRef.current ?? beginDeviceFingerprintCapture();
    armedGeoRef.current = null;
    armedDeviceRef.current = null;
    setGpsRequesting(true);
    setError("");
    notify.dismiss(GPS_PERMISSION_TOAST_ID);
    if (gpsPermissionMode === "blocked") {
      notify.error("Location blocked in browser", {
        id: GPS_PERMISSION_TOAST_ID,
        description: "Normal Chrome will not show the native popup again until you reset Location from the lock/tune icon.",
        duration: 9000,
      });
    }
    try {
      const [location, device] = await Promise.all([geoPromise, devicePromise]);
      if (location.status === "granted" && typeof location.latitude === "number" && typeof location.longitude === "number") {
        pendingClientGeoRef.current = { ...location, device };
        setGpsPermissionMode(null);
        notify.success("Location enabled", { id: "gps-permission-ready", description: selectedProfile ? "Now tap Sign In." : "Now tap the profile again.", duration: 8500 });
        return;
      }
      const msg = buildLocationSignInMessage(location);
      setGpsPermissionMode(getGpsPermissionMode(msg));
      showGpsPermissionToast(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Allow location to sign in.";
      if (isGpsPermissionDeniedMessage(msg)) {
        setGpsPermissionMode(getGpsPermissionMode(msg));
        showGpsPermissionToast(msg);
      } else {
        setError(msg);
        notify.error(msg);
      }
    } finally {
      setGpsRequesting(false);
    }
  };

  const executeLogin = async (captchaToken?: string, preparedGeo?: LoginLocationPayload) => {
    if (!selectedProfile) return;
    setLoginLoading(true);
    setError("");
    const perf = startPerfTimer("login.user");
    if (captchaToken) perf.mark("captcha_token_received");

    try {
      if (!checkRateLimit(`user_${selectedProfile.username}`)) {
        throw new Error("Too many attempts. Wait 1 minute.");
      }

      const clientGeo = selectedLocationRequired
        ? (preparedGeo || pendingClientGeoRef.current || await requireLoginLocation())
        : (preparedGeo || pendingClientGeoRef.current || null);
      pendingClientGeoRef.current = null;
      perf.mark("geo_ready");

      // Warm handshake in parallel with any pre-login work (no-op if already
      // warmed by the captcha modal). Then flip stage to "connecting" so the
      // user sees an active step while the encrypted request is in flight.
      const { warmupSession } = await import("./lib/secureTransport");
      setLoginStage("connecting");
      await withTimeout(warmupSession(), LOGIN_HANDSHAKE_TIMEOUT_MS, "Connection is busy. Please try again.");
      perf.mark("handshake_ready");

      setLoginStage("authenticating");
      const data: any = await withTimeout(apiCall("manage-app", {
        action: "login",
        username: selectedProfile.username,
        password,
        clientGeo,
        captchaToken,
      }), LOGIN_EDGE_TIMEOUT_MS, "Login took too long. Please try again.");
      if (!data?.success || !data?.user) {
        throw new Error(data?.error === "plan_finished" ? "Plan finished" : (data?.error || "Login failed"));
      }
      perf.mark("manage_app_login_ok");

      if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
        storeWorkerUrls(data.workerUrls);
      }

      let loginUser = data.user;
      if (data.sessionToken) sessionSet("session_token" as any, data.sessionToken);
      try {
        const { storeSessionPair } = await import("./lib/sessionRefresh");
        storeSessionPair(data);
      } catch {}
      try {
        const fresh: any = await apiCall("manage-app", { action: "me" });
        if (fresh?.success && fresh.user) loginUser = { ...loginUser, ...fresh.user };
      } catch {}
      sessionSet("user" as any, JSON.stringify(loginUser));
      // Global session: start the countdown instantly on login so the pill
      // appears immediately regardless of workflow (Gmail / TV / Direct Link).
      try { markSessionStart(); } catch {}
      checkAuth();

      perf.end("navigate_viewer");
      navigate("/viewer");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      perf.end(`failed: ${msg.slice(0, 60)}`);
      if (isGpsPermissionDeniedMessage(msg)) {
        setError("");
        setGpsPermissionMode(getGpsPermissionMode(msg));
        showGpsPermissionToast(msg);
      } else {
        setError(msg);
        notify.error(msg);
      }
    } finally {
      setLoginLoading(false);
      setLoginStage(null);
      setShowCaptcha(false);
    }
  };

  const executeFreeLogin = async (profile: UserData, captchaToken?: string) => {
    if (freeLoginId) return;
    if (siteKey && !captchaToken) {
      setError("");
      setFreeCaptchaProfile(profile);
      return;
    }
    const perf = startPerfTimer("login.free");
    if (captchaToken) perf.mark("captcha_token_received");
    const locationRequired = isLocationRequiredForProfile(profile);
    const geoPromise = locationRequired ? beginGeolocationCapture() : null;
    const devicePromise = locationRequired ? beginDeviceFingerprintCapture() : null;
    setFreeLoginId(profile.id);
    setError("");
    try { notify.info(`Entering ${profile.name || "Free Profile"}…`, { description: "Preparing your inbox" }); } catch {}
    try {
      const clientGeo = locationRequired ? await requireLoginLocation(geoPromise, devicePromise) : null;
      perf.mark("geo_ready");
      const { warmupSession } = await import("./lib/secureTransport");
      setLoginStage("connecting");
      await withTimeout(warmupSession(), LOGIN_HANDSHAKE_TIMEOUT_MS, "Connection is busy. Please try again.");
      perf.mark("handshake_ready");
      setLoginStage("authenticating");
      const data: any = await withTimeout(apiCall("manage-app", { action: "login_free", user_id: profile.id, clientGeo, captchaToken }), LOGIN_EDGE_TIMEOUT_MS, "Login took too long. Please try again.");
      perf.mark("manage_app_login_free_ok");
      if (!data?.success) throw new Error(data?.error || "Failed to enter profile");
      if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
        storeWorkerUrls(data.workerUrls);
      }
      let freeLoginUser = data.user;
      if (data.sessionToken) sessionSet("session_token" as any, data.sessionToken);
      try {
        const { storeSessionPair } = await import("./lib/sessionRefresh");
        storeSessionPair(data);
      } catch {}
      try {
        const fresh: any = await apiCall("manage-app", { action: "me" });
        if (fresh?.success && fresh.user) freeLoginUser = { ...freeLoginUser, ...fresh.user };
      } catch {}
      sessionSet("user" as any, JSON.stringify(freeLoginUser));
      try { markSessionStart(); } catch {}
      checkAuth();
      perf.end("navigate_viewer");
      navigate("/viewer");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to enter profile";
      perf.end(`failed: ${msg.slice(0, 60)}`);
      if (isGpsPermissionDeniedMessage(msg)) {
        setError("");
        setGpsPermissionMode(getGpsPermissionMode(msg));
        showGpsPermissionToast(msg);
      } else {
        setError(msg);
        notify.error(msg);
      }
    } finally {
      setFreeLoginId(null);
      setLoginStage(null);
    }
  };


  const loginFreeProfile = async (profile: UserData) => {
    if (freeLoginId) return;
    // If admin has enabled reCAPTCHA globally, free profile entry also
    // requires the user to solve a captcha in a popup first.
    if (siteKey) {
      setError("");
      setFreeCaptchaProfile(profile);
      return;
    }
    if (!captchaReady) {
      setFreeLoginId(profile.id);
      setError("");
      try {
        const fresh = await bootstrapFromSupabase({ force: true });
        const freshSiteKey = fresh.recaptcha?.enabled === true && fresh.recaptcha?.siteKey ? String(fresh.recaptcha.siteKey) : null;
        setProfiles((fresh.users || []).filter((u: UserData) => u.role === "user"));
        setSiteKey(freshSiteKey);
        setCaptchaReady(true);
        if (freshSiteKey) {
          preloadRecaptchaScript();
          setFreeCaptchaProfile(profile);
        } else {
          await executeFreeLogin(profile);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Connection is busy. Please try again.";
        setError(msg);
        notify.error(msg);
      } finally {
        setFreeLoginId(null);
      }
      return;
    }
    await executeFreeLogin(profile);
  };



  return (
    <div className="min-h-screen bg-[#141414] flex flex-col items-center px-4 pt-10 sm:pt-14 pb-12 relative overflow-hidden">
      {/* Official Netflix wordmark + premium OTP badge (baseline-aligned) */}
      <div className="w-full max-w-6xl mx-auto flex items-center justify-start px-2 sm:px-6 absolute top-4 sm:top-6 left-1/2 -translate-x-1/2 z-20">
        <div className="relative inline-flex items-end gap-2 sm:gap-2.5 select-none">
          <svg
            viewBox="0 0 111 30"
            aria-label="Netflix"
            className="h-7 sm:h-9 w-auto block"
            style={{ filter: "drop-shadow(0 2px 10px rgba(229,9,20,0.45))" }}
          >
            <path
              fill="#E50914"
              d="M105.06233,14.2806261 L110.999156,30 C109.249227,29.7497422 107.500234,29.4366857 105.718437,29.1554972 L102.374168,20.4686475 L98.9371075,28.4375293 C97.2499766,28.1563408 95.5928391,28.061674 93.9057081,27.8432843 L99.9372012,14.0931671 L94.4680851,0 L99.5313525,0 L102.593495,7.87513723 L105.874965,0 L110.999156,0 L105.06233,14.2806261 Z M90.4686475,0 L85.8749649,0 L85.8749649,27.2499766 C87.3746368,27.3437061 88.9371075,27.4055675 90.4686475,27.5930265 L90.4686475,0 Z M81.9055207,26.93692 C77.7186241,26.6557316 73.5307901,26.4064111 69.250164,26.3117443 L69.250164,0 L73.9366389,0 L73.9366389,21.8745899 C76.6248008,21.9373887 79.3120255,22.1557784 81.9055207,22.2804387 L81.9055207,26.93692 Z M64.2496954,10.6561065 L64.2496954,15.3435186 L57.8442216,15.3435186 L57.8442216,25.9996251 L53.2186709,25.9996251 L53.2186709,0 L66.3436123,0 L66.3436123,4.68741213 L57.8442216,4.68741213 L57.8442216,10.6561065 L64.2496954,10.6561065 Z M45.3435186,4.68741213 L45.3435186,26.2498828 C43.7810479,26.2498828 42.1876465,26.2498828 40.6561065,26.3117443 L40.6561065,4.68741213 L35.8123454,4.68741213 L35.8123454,0 L50.2183897,0 L50.2183897,4.68741213 L45.3435186,4.68741213 Z M30.749836,15.5928391 C28.687787,15.5928391 26.2498828,15.5928391 24.4999531,15.6875059 L24.4999531,22.6562939 C27.2499766,22.4678976 30,22.2495079 32.7809542,22.1557784 L32.7809542,26.6557316 L19.812541,27.6876933 L19.812541,0 L32.7809542,0 L32.7809542,4.68741213 L24.4999531,4.68741213 L24.4999531,10.9991564 C26.3126816,10.9991564 29.0936358,10.9054269 30.749836,10.9054269 L30.749836,15.5928391 Z M4.78114163,12.9684132 L4.78114163,29.3429562 C3.09401084,29.5313525 1.59340144,29.7497422 0,30 L0,0 L4.4690224,0 L10.5623124,17.0315868 L10.5623124,0 L15.2497246,0 L15.2497246,28.061674 C13.5935889,28.3437998 11.906458,28.4375293 10.1246602,28.6868498 L4.78114163,12.9684132 Z"
            />
          </svg>
          {/* Premium OTP pill — baseline-aligned with the logo */}
          <span
            aria-label="OTP"
            className="relative inline-flex items-center gap-1.5 rounded-full pl-2 pr-2.5 sm:pl-2.5 sm:pr-3 py-[3px] sm:py-[4px] text-[10px] sm:text-[11px] font-bold tracking-[0.32em] uppercase whitespace-nowrap mb-[3px] sm:mb-[4px]"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 60%), #0b0b0b",
              border: "1px solid rgba(229,9,20,0.55)",
              color: "#ffe6e8",
              boxShadow:
                "0 0 0 1px rgba(0,0,0,0.6), 0 6px 18px -8px rgba(229,9,20,0.75), inset 0 0 12px rgba(229,9,20,0.18)",
              textShadow: "0 0 8px rgba(229,9,20,0.5)",
            }}
          >
            <span
              className="w-[5px] h-[5px] rounded-full bg-[#e50914] animate-pulse"
              style={{ boxShadow: "0 0 6px #e50914, 0 0 12px rgba(229,9,20,0.85)" }}
            />
            OTP
          </span>
        </div>
      </div>


      <AnimatePresence mode="wait">
        {!selectedProfile ? (
          <motion.div
            key="profiles"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="relative z-10 w-full max-w-6xl flex flex-col items-center mt-14 sm:mt-20"
          >
            <motion.h1
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="text-white text-center font-normal tracking-tight text-[32px] sm:text-[56px] leading-[1.1] mb-8 sm:mb-12"
              style={{ fontFamily: '"Netflix Sans","Helvetica Neue",Arial,sans-serif', fontWeight: 400 }}
            >
              Who's watching?<span className="sr-only"> — Netflix Mail profile selection</span>
            </motion.h1>

            {profiles.length > 6 && (
              <div className="relative mb-6 sm:mb-8 w-full max-w-md px-2">
                <Search className="absolute left-6 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500 pointer-events-none" />
                <input
                  type="text"
                  value={profileSearch}
                  onChange={(e) => setProfileSearch(e.target.value)}
                  placeholder="Search profiles"
                  aria-label="Search profiles"
                  className="w-full bg-[#1f1f1f] border border-neutral-800 text-white text-sm rounded-md pl-10 pr-10 py-2.5 outline-none focus:border-neutral-500 placeholder:text-neutral-500"
                />
                {profileSearch && (
                  <button
                    onClick={() => setProfileSearch("")}
                    aria-label="Clear profile search"
                    className="absolute right-5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white p-1"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            <div className="w-full max-w-md mb-5 space-y-3">
              {error && (
                <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }}
                  className="bg-[#e50914]/10 border border-[#e50914]/30 text-[#f5c9cc] text-xs p-3 rounded-md flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
                </motion.div>
              )}
              <AnimatePresence>
                <GpsPermissionSheet mode={gpsPermissionMode} loading={gpsRequesting || loginLoading || pendingLogin || !!freeLoginId} onPrimeEnable={primeGpsEnableFromPointer} onEnable={() => void requestGpsPermissionOnly()} />
              </AnimatePresence>
            </div>

            {displayProfiles.length === 0 ? (
              loading ? (
                <div className="w-full max-w-5xl mx-auto rounded-2xl border border-white/[0.06] bg-white/[0.015] p-3 sm:p-5">
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-x-4 gap-y-7 sm:gap-x-6 sm:gap-y-9 mx-auto pb-4">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <div key={i} className="flex flex-col items-center gap-2 sm:gap-3 min-w-0" style={{ animationDelay: `${i * 60}ms` }}>
                        <div className="relative rounded-md overflow-hidden aspect-square w-full max-w-[140px] bg-white/[0.04] profile-skeleton" />
                        <div className="h-3 w-16 rounded bg-white/[0.05] profile-skeleton" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-16">
                  <p className="text-neutral-500 text-sm">
                    {profileSearch ? `No profiles match "${profileSearch}"` : "No profiles yet. Ask admin to create users."}
                  </p>
                </div>
              )
            ) : (
              <div className="w-full max-w-5xl mx-auto rounded-2xl border border-white/[0.06] bg-white/[0.015] p-3 sm:p-5 profile-grid-enter">
                <div
                  className="w-full overflow-y-scroll overscroll-contain pr-2 sm:pr-3 py-2 sm:py-3 max-h-[58vh] sm:max-h-[62vh] scroll-smooth [scrollbar-width:thin] [scrollbar-color:#e50914_rgba(255,255,255,0.04)] [&::-webkit-scrollbar]:w-[10px] [&::-webkit-scrollbar-track]:bg-white/[0.03] [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gradient-to-b [&::-webkit-scrollbar-thumb]:from-[#e50914] [&::-webkit-scrollbar-thumb]:to-[#7a0006] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:from-[#ff1a25] [&::-webkit-scrollbar-thumb:hover]:to-[#a30009]"
                >
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-x-4 gap-y-7 sm:gap-x-6 sm:gap-y-9 mx-auto pb-4">
                    {displayProfiles.map((profile, i) => {
                      const d = `${Math.min(i, 30) * 75}ms`;
                      const isFreeProfile = !!profile.isFree;
                      return (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() => {
                          if (isFreeProfile) {
                            void loginFreeProfile(profile);
                          } else {
                            setSelectedProfile(profile);
                          }
                        }}
                        disabled={isFreeProfile && freeLoginId === profile.id}
                        className="flex flex-col items-center gap-2 sm:gap-3 group focus:outline-none min-w-0 profile-item-in disabled:opacity-70"
                        style={{ animationDelay: d, ["--tile-delay" as any]: d }}
                      >
                        <div className="relative rounded-md overflow-hidden ring-0 group-hover:ring-2 group-hover:ring-white aspect-square w-full max-w-[140px] transform-gpu transition-transform duration-150 ease-out group-hover:scale-105 group-active:scale-95 will-change-transform">
                          <ProfileAvatar
                            avatarId={profile.profileAvatar}
                            name={profile.name}
                            className="w-full h-full"
                            fallbackColor={PROFILE_COLORS[i % PROFILE_COLORS.length]}
                            eager
                          />
                          {isFreeProfile && (
                            <span
                              className="absolute top-1.5 right-1.5 inline-flex items-center gap-0.5 px-1.5 py-[2px] rounded-md text-[9px] sm:text-[10px] font-black tracking-[0.14em] uppercase text-white"
                              style={{
                                background: "linear-gradient(135deg,#00c853,#009624)",
                                boxShadow: "0 2px 8px rgba(0,150,50,0.55), inset 0 0 0 1px rgba(255,255,255,0.25)",
                                textShadow: "0 1px 2px rgba(0,0,0,0.4)",
                              }}
                            >
                              FREE
                            </span>
                          )}
                          {profile.pinned && (
                            <span
                              aria-label="Pinned"
                              title="Pinned"
                              className="absolute top-1.5 left-1.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-400 text-black ring-2 ring-black/70"
                              style={{ boxShadow: "0 4px 10px rgba(0,0,0,0.55)" }}
                            >
                              <Pin className="w-3.5 h-3.5" strokeWidth={2.5} fill="currentColor" />
                            </span>
                          )}
                        </div>
                        <span className="text-neutral-400 group-hover:text-white text-[12px] sm:text-[14px] font-normal transition-colors duration-150 truncate max-w-full text-center">
                          {profile.name}
                        </span>
                      </button>
                      );
                    })}
                  </div>
                </div>
              </div>

            )}

          </motion.div>
        ) : (
          <motion.div key="password" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="relative z-10 w-full max-w-sm px-2 mt-16 sm:mt-24">
            <button onClick={() => { setSelectedProfile(null); setPassword(""); setError(""); setGpsPermissionMode(null); notify.dismiss(GPS_PERMISSION_TOAST_ID); }}
              className="text-neutral-400 hover:text-white text-sm font-normal mb-8 flex items-center gap-1.5 transition-colors group">
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> Back
            </button>

            <div className="flex flex-col items-center mb-8">
              <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 220 }}
                className="mb-5 rounded-md overflow-hidden ring-1 ring-white/10">
                <ProfileAvatar avatarId={getStableProfileAvatar(selectedProfile)} name={selectedProfile.name} className="w-24 h-24 sm:w-28 sm:h-28" fallbackColor={PROFILE_COLORS[Math.max(0, profiles.findIndex((p) => p.id === selectedProfile.id)) % PROFILE_COLORS.length]} eager />
              </motion.div>
              <h2 className="text-2xl sm:text-3xl font-normal text-white tracking-tight" style={{ fontFamily: '"Netflix Sans","Helvetica Neue",Arial,sans-serif' }}>{selectedProfile.name}</h2>
              {selectedProfile.username ? (<p className="text-neutral-500 text-xs sm:text-sm mt-1">@{selectedProfile.username}</p>) : null}
            </div>

            <form onSubmit={initiateLogin} noValidate className="space-y-4">
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500 w-4 h-4 z-10" />
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-[#1f1f1f] border border-neutral-800 text-white rounded-md py-3.5 pl-11 pr-12 focus:border-neutral-500 transition-all outline-none placeholder:text-neutral-500 text-sm"
                  placeholder="Password" autoFocus required />
              </div>

              {error && (
                <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }}
                  className="bg-[#e50914]/10 border border-[#e50914]/30 text-[#f5c9cc] text-xs p-3 rounded-md flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
                </motion.div>
              )}

              <AnimatePresence>
                <GpsPermissionSheet mode={gpsPermissionMode} loading={gpsRequesting || loginLoading || pendingLogin} onPrimeEnable={primeGpsEnableFromPointer} onEnable={() => void requestGpsPermissionOnly()} />
              </AnimatePresence>

              <button type="submit" onPointerDownCapture={primeGpsFromPointer} disabled={loginLoading || pendingLogin}
                className="w-full bg-[#e50914] hover:bg-[#f6121d] text-white font-semibold py-3 rounded-md transition-all active:scale-[0.98] disabled:opacity-50 text-[15px]">
                {(loginLoading || pendingLogin) ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {pendingLogin ? "Preparing..." : "Verifying..."}
                  </span>
                ) : "Sign In"}
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(showCaptcha || (loginStage && !freeCaptchaProfile)) && siteKey && (
          <CaptchaModal
            siteKey={siteKey}
            stage={loginStage}
            onVerify={(token) => { void executeLogin(token); }}
            onCancel={() => { pendingClientGeoRef.current = null; setShowCaptcha(false); }}
          />
        )}
        {(freeCaptchaProfile || (loginStage && !showCaptcha && !!freeLoginId)) && siteKey && (
          <CaptchaModal
            siteKey={siteKey}
            stage={loginStage}
            onVerify={(token) => {
              const p = freeCaptchaProfile;
              setFreeCaptchaProfile(null);
              if (p) void executeFreeLogin(p, token);
            }}
            onCancel={() => setFreeCaptchaProfile(null)}
          />
        )}
      </AnimatePresence>

    </div>
  );
}

// ==================== ADMIN LOGIN ====================

function AdminLoginPage() {
  useRouteHead({
    title: "Admin Sign-In — Netflix Mail",
    description: "Restricted admin sign-in for Netflix Mail operators.",
    ogTitle: "Admin Sign-In — Netflix Mail",
    ogDescription: "Restricted admin sign-in for Netflix Mail operators.",
    robots: "noindex, nofollow",
  });
  // Remembered-username store. Key is versioned + isolated from any legacy
  // draft key that used to hold a password. What we persist:
  //   { u: <base64(username)>, t: <ms timestamp> }
  // - Username only. Password is NEVER written to any browser storage.
  // - Value is base64-wrapped so a casual glance at devtools doesn't
  //   reveal the operator email. It's obfuscation, not encryption —
  //   real defense is (a) never storing the password and (b) the
  //   /clearcookies logout flow that nukes all site storage on sign-out.
  // - 30-day TTL so a stale email doesn't linger forever on shared devices.
  // - Legacy `admin_login_draft_v1` (which could contain a plaintext
  //   password field) is purged on mount.
  const ADMIN_REMEMBER_KEY = "admin_login_remember_v2";
  const LEGACY_DRAFT_KEY = "admin_login_draft_v1";
  const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const encodeU = (v: string) => {
    try { return typeof btoa === "function" ? btoa(unescape(encodeURIComponent(v))) : v; } catch { return ""; }
  };
  const decodeU = (v: string) => {
    try { return typeof atob === "function" ? decodeURIComponent(escape(atob(v))) : v; } catch { return ""; }
  };
  const readRememberedUsername = (): string => {
    try {
      if (typeof window === "undefined") return "";
      // Purge legacy draft (may have password) — one-shot cleanup.
      try { window.localStorage.removeItem(LEGACY_DRAFT_KEY); } catch { /* ignore */ }
      const raw = window.localStorage.getItem(ADMIN_REMEMBER_KEY);
      if (!raw) return "";
      const obj = JSON.parse(raw);
      const t = Number(obj?.t) || 0;
      if (!t || Date.now() - t > REMEMBER_TTL_MS) {
        try { window.localStorage.removeItem(ADMIN_REMEMBER_KEY); } catch { /* ignore */ }
        return "";
      }
      const u = typeof obj?.u === "string" ? decodeU(obj.u) : "";
      return u;
    } catch { return ""; }
  };
  const [username, setUsername] = useState(readRememberedUsername);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Persist ONLY the username, base64-wrapped, with a timestamp for TTL.
  // Password is intentionally never written to any browser storage.
  // NOTE: no unmount cleanup — that's what was wiping the remembered email
  // between navigations. Full teardown happens on /clearcookies logout.
  useEffect(() => {
    try {
      const u = username.trim();
      if (!u) {
        window.localStorage.removeItem(ADMIN_REMEMBER_KEY);
        return;
      }
      window.localStorage.setItem(
        ADMIN_REMEMBER_KEY,
        JSON.stringify({ u: encodeU(u), t: Date.now() })
      );
    } catch { /* ignore quota */ }
  }, [username]);


  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [captchaReady, setCaptchaReady] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [loginStage, setLoginStage] = useState<CaptchaStage | null>(null);
  const [gpsRequesting, setGpsRequesting] = useState(false);
  const [gpsPermissionMode, setGpsPermissionMode] = useState<GpsPermissionMode | null>(null);
  // Per-admin GPS policy: public bootstrap intentionally excludes admins, so
  // resolve the typed admin username through a tiny public policy endpoint.
  // Default remains OFF until the server says this admin explicitly forced it.
  const [adminLocationPolicy, setAdminLocationPolicy] = useState<{ username: string; required: boolean; loading: boolean }>({ username: "", required: false, loading: false });
  const normalizedAdminUsername = username.trim().toLowerCase();
  const locationRequired = adminLocationPolicy.username === normalizedAdminUsername ? adminLocationPolicy.required : false;
  const locationPolicyChecking = !!normalizedAdminUsername && (adminLocationPolicy.loading || adminLocationPolicy.username !== normalizedAdminUsername);
  const pendingClientGeoRef = useRef<LoginLocationPayload | null>(null);
  const armedGeoRef = useRef<Promise<LoginLocationPayload> | null>(null);
  const armedDeviceRef = useRef<Promise<DeviceFingerprint> | null>(null);
  const gpsBlocked = locationRequired && gpsPermissionMode !== null;
  const navigate = useNavigate();
  const { user: authUser, checkAuth } = useAuth();

  useEffect(() => {
    if (authUser?.role === "admin" && authUser?.pending !== true && getSessionToken()) {
      navigate("/admin/dashboard", { replace: true });
    }
  }, [authUser?.role, authUser?.pending, navigate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bootstrap = await bootstrapFromSupabase({ force: true });
        if (cancelled) return;
        if (bootstrap.recaptcha?.enabled === true && bootstrap.recaptcha?.siteKey) {
          setSiteKey(bootstrap.recaptcha.siteKey);
          preloadRecaptchaScript();
        } else {
          setSiteKey(null);
        }
        setCaptchaReady(true);
      } catch (err) {
        console.warn("Admin bootstrap failed, allowing sign-in without captcha config:", err);
        if (!cancelled) {
          // Never block a legitimate admin from signing in because the captcha
          // config fetch hiccupped. Fall back to captcha-off; the server still
          // enforces its real captcha requirement if one is configured.
          setSiteKey(null);
          setCaptchaReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const u = username.trim();
    const normalized = u.toLowerCase();
    if (!normalized) {
      setAdminLocationPolicy({ username: "", required: false, loading: false });
      return;
    }
    let cancelled = false;
    setAdminLocationPolicy((prev) => prev.username === normalized && prev.required
      ? { ...prev, loading: true }
      : { username: normalized, required: false, loading: true });
    const t = window.setTimeout(() => {
      apiCall("manage-app", { action: "admin_location_policy", username: u })
        .then((res: any) => {
          if (cancelled) return;
          setAdminLocationPolicy({ username: normalized, required: res?.required === true, loading: false });
        })
        .catch(() => {
          if (cancelled) return;
          setAdminLocationPolicy({ username: normalized, required: false, loading: false });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [username]);

  useEffect(() => {
    if (!locationRequired) { setGpsPermissionMode(null); return; }
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    const primeGpsSheet = async () => {
      try {
        if (navigator.permissions?.query) {
          const permission = await navigator.permissions.query({ name: "geolocation" as PermissionName });
          if (cancelled) return;
          setGpsPermissionMode(permission.state === "granted" ? null : permission.state === "denied" ? "blocked" : "needed");
        } else if (!cancelled) {
          setGpsPermissionMode("needed");
        }
      } catch {
        if (!cancelled) setGpsPermissionMode("needed");
      }
    };
    void primeGpsSheet();
    return () => { cancelled = true; };
  }, [locationRequired]);

  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      const msg = "Username and password required";
      setError(msg);
      notify.error(msg);
      return;
    }
    if (locationPolicyChecking) {
      const msg = "Checking admin security policy. Try again in a moment.";
      setError(msg);
      notify.info("Checking security", { id: "admin-policy-checking", description: "Try again in a moment.", duration: 2500 });
      return;
    }
    if (!locationRequired) {
      setError("");
      void startLocationThenLogin();
      return;
    }
    // FIRE GEO FIRST synchronously — preserve user activation (Chrome Incognito).
    const hasPreparedGeo = hasGrantedLocation(pendingClientGeoRef.current);
    const geoPromise = hasPreparedGeo ? undefined : (armedGeoRef.current ?? beginGeolocationCapture());
    const devicePromise = hasPreparedGeo ? undefined : (armedDeviceRef.current ?? beginDeviceFingerprintCapture());
    armedGeoRef.current = null;
    armedDeviceRef.current = null;
    setGpsPermissionMode(null);
    notify.dismiss(GPS_PERMISSION_TOAST_ID);
    setError("");
    void startLocationThenLogin(geoPromise, devicePromise);
  };

  const armLoginTelemetry = () => {
    if (!locationRequired) return;
    if (hasGrantedLocation(pendingClientGeoRef.current)) return;
    if (!armedGeoRef.current) armedGeoRef.current = beginGeolocationCapture();
    if (!armedDeviceRef.current) armedDeviceRef.current = beginDeviceFingerprintCapture();
  };

  const primeGpsFromPointer = () => {
    if (loading || !username.trim() || !password.trim()) return;
    armLoginTelemetry();
  };

  const primeGpsEnableFromPointer = () => {
    if (!locationRequired) return;
    if (gpsRequesting || loading) return;
    if (hasGrantedLocation(pendingClientGeoRef.current)) return;
    armedGeoRef.current = beginGeolocationCapture();
    armedDeviceRef.current = beginDeviceFingerprintCapture();
  };

  useEffect(() => {
    if (!gpsBlocked || typeof navigator === "undefined") return;
    let active = true;
    let status: PermissionStatus | null = null;
    const clearBlocked = () => {
      setGpsPermissionMode(null);
      notify.dismiss(GPS_PERMISSION_TOAST_ID);
      notify.info("Location ready", { id: "gps-permission-ready", description: "Tap Admin Sign In to continue.", duration: 8500 });
    };
    const recheck = async () => {
      if (!active || !navigator.permissions?.query) return;
      try {
        const p = await navigator.permissions.query({ name: "geolocation" as PermissionName });
        if (active && p.state !== "denied") clearBlocked();
      } catch {}
    };
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: "geolocation" as PermissionName }).then((permission) => {
        if (!active) return;
        status = permission;
        permission.onchange = () => { if (active && permission.state !== "denied") clearBlocked(); };
      }).catch(() => {});
    }
    const onVisible = () => { if (document.visibilityState === "visible") recheck(); };
    window.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", recheck);
    return () => {
      active = false;
      if (status) status.onchange = null;
      window.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", recheck);
    };
  }, [gpsBlocked]);

  const startLocationThenLogin = async (preStartedGeo?: Promise<LoginLocationPayload>, preStartedDevice?: Promise<DeviceFingerprint>) => {
    setLoading(true);
    setError("");
    try {
      let clientGeo: LoginLocationPayload | null = null;
      if (locationRequired) {
        clientGeo = hasGrantedLocation(pendingClientGeoRef.current) ? pendingClientGeoRef.current : await requireLoginLocation(preStartedGeo, preStartedDevice);
        pendingClientGeoRef.current = clientGeo;
      }
      if (!captchaReady) {
        setLoading(false);
        if (locationRequired) {
          notify.info("Location ready", { id: "gps-permission-ready", description: "Wait for security check, then tap Admin Sign In.", duration: 8500 });
        }
        return;
      }
      if (siteKey) {
        setShowCaptcha(true);
        setLoading(false);
      } else {
        await executeLogin(undefined, clientGeo ?? undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      if (isGpsPermissionDeniedMessage(msg)) {
        setError("");
        setGpsPermissionMode(getGpsPermissionMode(msg));
        showGpsPermissionToast(msg);
      } else {
        setError(msg);
        notify.error(msg);
      }
      setLoading(false);
    }
  };

  const requestGpsPermissionOnly = async () => {
    if (hasGrantedLocation(pendingClientGeoRef.current)) {
      setGpsPermissionMode(null);
      notify.success("Location enabled", { id: "gps-permission-ready", description: "Now tap Admin Sign In.", duration: 8500 });
      return;
    }
    // Prefer the fresh request started on pointerdown; fallback for keyboard.
    const geoPromise = armedGeoRef.current ?? beginGeolocationCapture();
    const devicePromise = armedDeviceRef.current ?? beginDeviceFingerprintCapture();
    armedGeoRef.current = null;
    armedDeviceRef.current = null;
    setGpsRequesting(true);
    setError("");
    notify.dismiss(GPS_PERMISSION_TOAST_ID);
    if (gpsPermissionMode === "blocked") {
      notify.error("Location blocked in browser", {
        id: GPS_PERMISSION_TOAST_ID,
        description: "Normal Chrome will not show the native popup again until you reset Location from the lock/tune icon.",
        duration: 9000,
      });
    }
    try {
      const [location, device] = await Promise.all([geoPromise, devicePromise]);
      if (location.status === "granted" && typeof location.latitude === "number" && typeof location.longitude === "number") {
        pendingClientGeoRef.current = { ...location, device };
        setGpsPermissionMode(null);
        notify.success("Location enabled", { id: "gps-permission-ready", description: "Now tap Admin Sign In.", duration: 8500 });
        return;
      }
      const msg = buildLocationSignInMessage(location);
      setGpsPermissionMode(getGpsPermissionMode(msg));
      showGpsPermissionToast(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Allow location to sign in.";
      if (isGpsPermissionDeniedMessage(msg)) {
        setGpsPermissionMode(getGpsPermissionMode(msg));
        showGpsPermissionToast(msg);
      } else {
        setError(msg);
        notify.error(msg);
      }
    } finally {
      setGpsRequesting(false);
    }
  };

  const executeLogin = async (captchaToken?: string, preparedGeo?: LoginLocationPayload) => {
    setLoading(true);
    setError("");
    const perf = startPerfTimer("login.admin");
    if (captchaToken) perf.mark("captcha_token_received");
    try {
      if (!checkRateLimit(`admin_${username}`)) throw new Error("Too many attempts. Wait 1 minute.");

      const clientGeo = locationRequired
        ? (preparedGeo || pendingClientGeoRef.current || await requireLoginLocation())
        : (preparedGeo || pendingClientGeoRef.current || null);
      pendingClientGeoRef.current = null;
      perf.mark("geo_ready");

      const { warmupSession } = await import("./lib/secureTransport");
      setLoginStage("connecting");
      await withTimeout(warmupSession(), LOGIN_HANDSHAKE_TIMEOUT_MS, "Connection is busy. Please try again.");
      perf.mark("handshake_ready");

      setLoginStage("authenticating");
      const data: any = await withTimeout(apiCall("manage-app", { action: "login", username, password, clientGeo, captchaToken }), LOGIN_EDGE_TIMEOUT_MS, "Login took too long. Please try again.");
      perf.mark("manage_app_login_ok");

      if (!data?.success || !data?.user) {
        throw new Error(data?.error === "plan_finished" ? "Plan finished" : (data?.error || "Login failed"));
      }
      if (data.user.role !== "admin") throw new Error("Access denied");
      if (typeof data.user.locationRequired === "boolean") {
        setAdminLocationPolicy({ username: username.trim().toLowerCase(), required: data.user.locationRequired, loading: false });
      }
      if (data.pendingToken) {
        sessionSet("pending_admin_token" as any, data.pendingToken);
        sessionSet("pending_admin_token_at" as any, String(Date.now()));
      }

      if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
        storeWorkerUrls(data.workerUrls);
      }

      sessionSet("user" as any, JSON.stringify({ ...data.user, pending: true }));
      checkAuth();

      perf.end("navigate_admin_auth");
      notify.success("Password verified. Complete 2FA to enter admin.", { id: "admin-password-verified", duration: 3000 });
      navigate("/admin-auth");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      perf.end(`failed: ${msg.slice(0, 60)}`);
      if (isGpsPermissionDeniedMessage(msg)) {
        setError("");
        if (normalizedAdminUsername) setAdminLocationPolicy({ username: normalizedAdminUsername, required: true, loading: false });
        setGpsPermissionMode(getGpsPermissionMode(msg));
        showGpsPermissionToast(msg);
      } else {
        setError(msg);
        notify.error(msg);
      }
    } finally {
      setLoading(false);
      setLoginStage(null);
      setShowCaptcha(false);
    }
  };



  return (
    <div className="min-h-[100dvh] overflow-y-auto bg-slate-900 flex items-center justify-center px-4 py-10 pt-[calc(env(safe-area-inset-top)+4.75rem)] sm:py-8 sm:pt-[calc(env(safe-area-inset-top)+2rem)]">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="bg-white w-full max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-8 shadow-2xl border-t-4 sm:border-t-8 border-red-600 mx-2 sm:mx-0 my-auto">
        <div className="flex justify-center mb-8">
          <div className="bg-slate-900 p-3 sm:p-4 rounded-2xl shadow-lg">
            <ShieldCheck className="text-white w-6 h-6 sm:w-8 sm:h-8" />
          </div>
        </div>
        <h2 className="text-xl sm:text-2xl font-black text-center text-slate-900 mb-1 sm:mb-2">Admin Access</h2>
        <p className="text-slate-500 text-center text-xs sm:text-sm mb-4 sm:mb-8">Secure administrator login</p>

        <form onSubmit={initiateLogin} noValidate className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Admin Username</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="admin" aria-required="true" autoComplete="username" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Admin Password</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-12 text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="••••••••" required />
            </div>
          </div>
          {error && (
            <div className="bg-red-50 text-red-600 text-xs p-3 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />{error}
            </div>
          )}

          <AnimatePresence>
            <GpsPermissionSheet mode={gpsPermissionMode} loading={gpsRequesting || loading} onPrimeEnable={primeGpsEnableFromPointer} onEnable={() => void requestGpsPermissionOnly()} />
          </AnimatePresence>

          <button type="submit" onPointerDownCapture={primeGpsFromPointer} disabled={loading || locationPolicyChecking}
            className="w-full bg-red-600 text-white font-bold py-4 rounded-2xl hover:bg-red-700 transition-all active:scale-95 disabled:opacity-50">
            {loading ? "Authenticating..." : locationPolicyChecking ? "Checking..." : "Admin Sign In"}
          </button>
        </form>

        <div className="flex flex-col gap-2 mt-6">
          <button onClick={() => navigate("/")}
            className="text-slate-400 text-[10px] font-bold uppercase tracking-widest hover:text-slate-900 transition-colors mt-2">
            Back to User Login
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {(showCaptcha || loginStage) && siteKey && (
          <CaptchaModal
            siteKey={siteKey}
            stage={loginStage}
            onVerify={(token) => { void executeLogin(token); }}
            onCancel={() => { pendingClientGeoRef.current = null; setShowCaptcha(false); }}
          />
        )}
      </AnimatePresence>

    </div>
  );
}

// ==================== ADMIN 2FA ====================
function AdminAuthPage() {
  useRouteHead({
    title: "Admin 2FA — Netflix Mail",
    description: "Two-factor verification for Netflix Mail admin operators.",
    ogTitle: "Admin 2FA — Netflix Mail",
    ogDescription: "Two-factor verification for Netflix Mail admin operators.",
    robots: "noindex, nofollow",
  });
  const [step, setStep] = useState(1);
  const [otp, setOtp] = useState("");
  const [totp, setTotp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const otpRequested = React.useRef(false);
  const { user, checkAuth } = useAuth();
  const effectiveUser = user?.role === "admin" ? user : readStoredSessionUser();
  const PROOF_TTL_MS = 15 * 60 * 1000;
  const [remainingMs, setRemainingMs] = useState<number>(() => {
    const at = Number(sessionGet("pending_admin_token_at" as any) || 0);
    if (!at) return PROOF_TTL_MS;
    return Math.max(0, PROOF_TTL_MS - (Date.now() - at));
  });
  useEffect(() => {
    const t = setInterval(() => {
      const at = Number(sessionGet("pending_admin_token_at" as any) || 0);
      const left = at ? Math.max(0, PROOF_TTL_MS - (Date.now() - at)) : 0;
      setRemainingMs(left);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const expired = remainingMs <= 0;
  const mm = String(Math.floor(remainingMs / 60000)).padStart(2, "0");
  const ss = String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0");
  const restartLogin = () => {
    try {
      sessionRemove("pending_admin_token" as any);
      sessionRemove("pending_admin_token_at" as any);
      sessionRemove("user" as any);
    } catch {}
    navigate("/admin", { replace: true });
  };

  useEffect(() => {
    const pending = (() => { try { return sessionGet("pending_admin_token" as any); } catch { return null; } })();
    if (!pending) {
      if (effectiveUser?.role === "admin" && effectiveUser?.pending !== true && getSessionToken()) {
        navigate("/admin/dashboard", { replace: true });
      } else {
        navigate("/admin", { replace: true });
      }
      return;
    }
    if (!effectiveUser || effectiveUser.role !== "admin") { navigate("/admin", { replace: true }); return; }


    if (step === 1 && !otpRequested.current) {
      otpRequested.current = true;
      setLoading(true);
      (async () => {
        try {
          await apiCall("manage-app", { action: "request_admin_otp", user_id: effectiveUser.id });
          notify.success("Secure OTP sent to your Telegram.");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to send OTP";
          setError(msg);
          notify.error(msg);
          otpRequested.current = false;
        } finally {
          setLoading(false);
        }
      })();
    }

    if (step === 2 && !effectiveUser.totpSecret) {
      (async () => {
        try {
          if (effectiveUser.totpConfigured) return;
          const res = await apiCall("manage-app", { action: "update_totp", user_id: effectiveUser.id });
          if (res.secret) setSecretKey(res.secret);
          if (res.otpauthUrl) setQrCode(res.otpauthUrl);
        } catch (err) {
          console.error("TOTP setup error:", err);
          notify.error(err instanceof Error ? err.message : "Could not start authenticator setup");
        }
      })();
    }
  }, [step, effectiveUser?.id, effectiveUser?.role, effectiveUser?.pending, effectiveUser?.totpConfigured, effectiveUser?.totpSecret, navigate]);

  const verifyTelegramOtp = async (submittedOtp = otp) => {
    const code = submittedOtp.trim();
    if (loading) return;
    if (!effectiveUser?.id) {
      navigate("/admin", { replace: true });
      return;
    }
    if (code.length < 6) {
      setError("Enter the 6-digit Telegram OTP.");
      return;
    }
    setLoading(true);
    try {
      await apiCall("manage-app", { action: "verify_otp", user_id: effectiveUser.id, otp: code });
      setStep(2);
      setError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid OTP";
      setError(msg);
      notify.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const verifyTotp = async (submittedTotp = totp) => {
    const code = submittedTotp.trim();
    if (loading) return;
    if (!effectiveUser?.id) {
      navigate("/admin", { replace: true });
      return;
    }
    if (code.length < 6) {
      setError("Enter the 6-digit authenticator code.");
      return;
    }
    setLoading(true);
    try {
      await apiCall("manage-app", { action: "verify_totp", user_id: effectiveUser.id, code });
      const finalData = await apiCall("manage-app", { action: "finalize_admin_session", user_id: effectiveUser.id });
      if (!finalData?.success || !finalData?.sessionToken || finalData?.user?.role !== "admin") {
        throw new Error(finalData?.error || "Admin session could not be finalized");
      }
      if (finalData.workerUrls && Array.isArray(finalData.workerUrls) && finalData.workerUrls.length > 0) {
        storeWorkerUrls(finalData.workerUrls);
      }
      sessionSet("admin_auth" as any, "true");
      if (finalData.sessionToken) sessionSet("session_token" as any, finalData.sessionToken);
      sessionRemove("pending_admin_token" as any);
      sessionRemove("pending_admin_token_at" as any);
      const adminUser = { ...(finalData.user || {}), pending: false };
      sessionSet("user" as any, JSON.stringify(adminUser));
      markSessionStart();
      checkAuth();
      notify.success("Admin session secured.");
      navigate("/admin/dashboard", { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid Google Auth Code";
      setError(msg);
      notify.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleTelegramOtpSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const formOtp = new FormData(e.currentTarget).get("telegramOtp")?.toString() ?? otp;
    const normalizedOtp = formOtp.replace(/\D/g, "").slice(0, 6);
    if (normalizedOtp !== otp) setOtp(normalizedOtp);
    void verifyTelegramOtp(normalizedOtp);
  };

  const handleTotpSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const formTotp = new FormData(e.currentTarget).get("totpCode")?.toString() ?? totp;
    const normalizedTotp = formTotp.replace(/\D/g, "").slice(0, 6);
    if (normalizedTotp !== totp) setTotp(normalizedTotp);
    void verifyTotp(normalizedTotp);
  };

  const handleOtpInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    const normalizedOtp = e.currentTarget.value.replace(/\D/g, "").slice(0, 6);
    if (normalizedOtp !== otp) setOtp(normalizedOtp);
    void verifyTelegramOtp(normalizedOtp);
  };

  const handleTotpInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    const normalizedTotp = e.currentTarget.value.replace(/\D/g, "").slice(0, 6);
    if (normalizedTotp !== totp) setTotp(normalizedTotp);
    void verifyTotp(normalizedTotp);
  };

  return (
    <div className="min-h-[100dvh] bg-slate-950 flex items-center justify-center px-4 py-6 pt-[calc(env(safe-area-inset-top)+1rem)] relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-red-600/20 blur-[120px] rounded-full pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-slate-900/80 backdrop-blur-xl border border-slate-700/50 max-w-md w-full rounded-3xl p-6 sm:p-8 shadow-[0_0_40px_rgba(220,38,38,0.1)] relative z-10"
      >
        <div className="flex justify-center mb-6">
          <div className="bg-red-500/10 p-4 rounded-2xl border border-red-500/20">
            <ShieldCheck className="w-10 h-10 text-red-500" />
          </div>
        </div>

        <h2 className="text-2xl font-black text-center text-white tracking-tight mb-2">3-Factor Auth</h2>
        <p className="text-slate-400 text-center text-sm mb-3">
          {step === 1 ? "OTP sent to Telegram" : "Enter Google Authenticator code"}
        </p>
        <div className="flex justify-center mb-6">
          {expired ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> Session expired
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1 rounded-full border uppercase tracking-wider ${remainingMs < 60_000 ? "bg-amber-500/10 border-amber-500/30 text-amber-400" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${remainingMs < 60_000 ? "bg-amber-400" : "bg-emerald-400"} animate-pulse`} /> Expires in {mm}:{ss}
            </span>
          )}
        </div>
        {expired && (
          <button type="button" onClick={restartLogin}
            className="w-full mb-6 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-semibold py-3 rounded-2xl transition-colors">
            Restart login
          </button>
        )}


        {step === 1 ? (
          <form onSubmit={handleTelegramOtpSubmit} className="space-y-6" noValidate>
            <input name="telegramOtp" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={handleOtpInputKeyDown}
              className="w-full bg-slate-950 border border-slate-800 text-white text-center tracking-[0.75em] font-mono text-2xl rounded-2xl py-5 focus:ring-2 focus:ring-red-500 outline-none placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600"
              placeholder="••••••" maxLength={6} />
            <button type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-bold py-4 rounded-2xl hover:from-red-500 hover:to-red-600 shadow-lg shadow-red-900/20 transition-all active:scale-[0.98] disabled:opacity-50">
              {loading ? "Verifying..." : "Verify Telegram OTP"}
            </button>
            {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-4 rounded-xl text-center">{error}</div>}
          </form>
        ) : (
          <form onSubmit={handleTotpSubmit} className="space-y-6" noValidate>
            {qrCode && (
              <div className="flex flex-col items-center bg-slate-950 p-6 rounded-2xl border border-slate-800">
                <p className="text-xs font-bold text-slate-400 uppercase mb-4">Scan with Google Authenticator</p>
                <div className="bg-white p-2 rounded-xl">
                  <Suspense fallback={<div className="w-[160px] h-[160px] bg-slate-100 animate-pulse rounded-md" />}>
                    <QRCodeSVG value={qrCode} size={160} />
                  </Suspense>
                </div>

                <div className="mt-4 w-full">
                  <p className="text-xs text-slate-500 text-center mb-2">Or enter this key manually:</p>
                  <div className="flex items-center justify-between bg-slate-900 border border-slate-700 rounded-xl p-3">
                    <code className="text-sm font-mono text-slate-300 tracking-wider truncate">{secretKey}</code>
                    <button type="button" onClick={() => { navigator.clipboard.writeText(secretKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="text-slate-400 hover:text-white transition-colors flex-shrink-0 ml-2">
                      {copied ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <input name="totpCode" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={handleTotpInputKeyDown}
              className="w-full bg-slate-950 border border-slate-800 text-white text-center tracking-[0.75em] font-mono text-2xl rounded-2xl py-5 focus:ring-2 focus:ring-red-500 outline-none placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600"
              placeholder="••••••" maxLength={6} />
            <button type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-bold py-4 rounded-2xl hover:from-red-500 hover:to-red-600 shadow-lg shadow-red-900/20 transition-all active:scale-[0.98] disabled:opacity-50">
              {loading ? "Verifying..." : "Verify & Enter Admin"}
            </button>
            {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-4 rounded-xl text-center">{error}</div>}
          </form>
        )}
      </motion.div>
    </div>
  );
}

// ==================== ADMIN PANEL ====================
function LoginEventsPanel() {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  // SWR: paints instantly from cache, refreshes silently in background.
  // Search re-fetches with a new key so previous searches stay cached.
  const sliceKey = React.useMemo(() => `loginEvents:${search || "__all__"}`, [search]);
  const fetcher = React.useCallback(async () => {
    const res: any = await apiCall("manage-app", { action: "list_login_events", limit: 300, search: search || undefined });
    return (res?.events || []) as any[];
  }, [search]);
  const { data, refreshing, hasData, refresh } = useAdminSlice<any[]>(sliceKey, fetcher);
  const events = data || [];
  const loading = !hasData && refreshing; // only block-render on true cold start
  const load = () => refresh(true);


  const exportCsv = () => {
    if (!events.length) return;
    const cols = ["created_at","username","role","event","risk_score","ip","isp","country","city","device_brand","device_model","device_type","os_name","os_version","browser_name","browser_version","gps_lat","gps_lon","gps_accuracy","is_vpn","is_proxy","is_tor","is_hosting","is_new_device","impossible_travel","fingerprint_hash"];
    const rows = [cols.join(",")].concat(events.map(e => cols.map(c => JSON.stringify(e?.[c] ?? "")).join(",")));
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `login_events_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `login_events_${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <section className="bg-white p-3 sm:p-6 rounded-2xl border shadow-sm">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="font-black text-base sm:text-lg flex items-center gap-2 mr-auto">
          <div className="bg-red-50 p-1.5 rounded-lg"><ShieldCheck className="w-4 h-4 text-red-600" /></div>
          Login Events <span className="text-xs font-normal text-slate-500">({events.length})</span>
        </h2>
        <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && load()}
          placeholder="Search user/IP/city/ISP…" aria-label="Search login events" className="border rounded-lg px-3 py-1.5 text-sm w-full sm:w-48" />
        <button onClick={load} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-semibold">Refresh</button>
        <button onClick={exportCsv} className="px-3 py-1.5 bg-slate-900 text-white hover:bg-slate-800 rounded-lg text-sm font-semibold">CSV</button>
        <button onClick={exportJson} className="px-3 py-1.5 bg-slate-700 text-white hover:bg-slate-800 rounded-lg text-sm font-semibold">JSON</button>
      </div>
      {loading ? (
        <div className="py-12 text-center text-slate-500 text-sm">Loading…</div>
      ) : events.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-sm">No login events yet.</div>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden md:block overflow-auto border rounded-lg max-h-[65vh]">
            <table className="w-full text-xs sm:text-sm min-w-[820px]">
              <thead className="bg-slate-50 text-left text-slate-600 uppercase text-[10px] tracking-wider sticky top-0 z-10">
                <tr>
                  <th className="p-2">Time</th><th className="p-2">User</th>
                  <th className="p-2">Device</th><th className="p-2">Browser · OS</th>
                  <th className="p-2">IP</th><th className="p-2">ISP</th><th className="p-2">Location</th>
                  <th className="p-2">Flags</th><th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.map(e => (
                  <React.Fragment key={e.id}>
                    <tr className="hover:bg-slate-50">
                      <td className="p-2 whitespace-nowrap text-slate-600">{new Date(e.created_at).toLocaleString()}</td>
                      <td className="p-2 font-semibold">{e.username}<div className="text-[10px] text-slate-400">{e.role}</div>{e.is_new_device && <div className="text-[10px] text-orange-600 mt-1">🆕 new device</div>}</td>
                      <td className="p-2">{[e.device_brand, e.device_model].filter(Boolean).join(" ") || "—"}<div className="text-[10px] text-slate-400">{e.device_type}</div></td>
                      <td className="p-2">{e.browser_name} {e.browser_version?.split(".")[0]}<div className="text-[10px] text-slate-400">{e.os_name} {e.os_version}</div></td>
                      <td className="p-2 font-mono text-[11px]">{e.ip || "—"}<div className="text-[10px] text-slate-400">{e.ip_source}</div></td>
                      <td className="p-2">{e.isp || "—"}<div className="text-[10px] text-slate-400">{e.asn}</div></td>
                      <td className="p-2">{[e.city, e.region, e.country_code].filter(Boolean).join(", ") || "—"}{typeof e.gps_lat === "number" && <div className="text-[10px] text-emerald-600">GPS ±{Math.round(e.gps_accuracy || 0)}m</div>}</td>
                      <td className="p-2 space-x-1">
                        {e.is_vpn && <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px]">VPN</span>}
                        {e.is_proxy && <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-[10px]">PROXY</span>}
                        {e.is_tor && <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px]">TOR</span>}
                        {e.is_hosting && <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px]">HOST</span>}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {(typeof e.gps_lat === "number" || typeof e.ip_lat === "number") && (
                          <a target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${e.gps_lat ?? e.ip_lat},${e.gps_lon ?? e.ip_lon}`} className="text-blue-600 hover:underline text-[11px] mr-2">Map</a>
                        )}
                        {e.ip && <button onClick={() => { navigator.clipboard.writeText(e.ip); notify.success("IP copied"); }} className="text-slate-600 hover:underline text-[11px] mr-2">Copy IP</button>}
                        <button onClick={() => setExpanded(expanded === e.id ? null : e.id)} className="text-slate-600 hover:underline text-[11px]">{expanded === e.id ? "Hide" : "Raw"}</button>
                      </td>
                    </tr>
                    {expanded === e.id && (
                      <tr><td colSpan={9} className="p-2 bg-slate-50"><pre className="text-[10px] overflow-x-auto max-h-96">{JSON.stringify(e, null, 2)}</pre></td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list — no horizontal scroll */}
          <div className="md:hidden space-y-3 max-h-[65vh] overflow-y-auto pr-1">
            {events.map(e => {
              const isOpen = expanded === e.id;
              const flags: { label: string; cls: string }[] = [];
              if (e.is_vpn) flags.push({ label: "VPN", cls: "bg-red-100 text-red-700" });
              if (e.is_proxy) flags.push({ label: "PROXY", cls: "bg-orange-100 text-orange-700" });
              if (e.is_tor) flags.push({ label: "TOR", cls: "bg-purple-100 text-purple-700" });
              if (e.is_hosting) flags.push({ label: "HOST", cls: "bg-slate-200 text-slate-700" });
              return (
                <div key={e.id} className="border rounded-xl p-3 bg-white shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-sm text-slate-900 truncate">{e.username}</p>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">{e.role}</p>
                    </div>
                    <p className="text-[10px] text-slate-500 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</p>
                  </div>

                  {e.is_new_device && <p className="text-[10px] text-orange-600 mt-1">🆕 new device</p>}

                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                    <div>
                      <p className="text-slate-400 text-[9px] uppercase tracking-wider">Device</p>
                      <p className="text-slate-700 truncate">{[e.device_brand, e.device_model].filter(Boolean).join(" ") || "—"}</p>
                      <p className="text-slate-400 text-[10px]">{e.device_type}</p>
                    </div>
                    <div>
                      <p className="text-slate-400 text-[9px] uppercase tracking-wider">Browser · OS</p>
                      <p className="text-slate-700 truncate">{e.browser_name} {e.browser_version?.split(".")[0]}</p>
                      <p className="text-slate-400 text-[10px] truncate">{e.os_name} {e.os_version}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-slate-400 text-[9px] uppercase tracking-wider">IP · ISP</p>
                      <p className="font-mono text-[11px] text-slate-700 break-all">{e.ip || "—"}</p>
                      <p className="text-slate-500 text-[10px] truncate">{e.isp || "—"} {e.asn ? `· ${e.asn}` : ""}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-slate-400 text-[9px] uppercase tracking-wider">Location</p>
                      <p className="text-slate-700 text-[11px]">{[e.city, e.region, e.country_code].filter(Boolean).join(", ") || "—"}</p>
                      {typeof e.gps_lat === "number" && (
                        <p className="text-emerald-600 text-[10px]">GPS ±{Math.round(e.gps_accuracy || 0)}m</p>
                      )}
                    </div>
                  </div>

                  {flags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {flags.map(f => (
                        <span key={f.label} className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${f.cls}`}>{f.label}</span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2 pt-2 border-t">
                    {(typeof e.gps_lat === "number" || typeof e.ip_lat === "number") && (
                      <a target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${e.gps_lat ?? e.ip_lat},${e.gps_lon ?? e.ip_lon}`}
                        className="text-blue-600 hover:underline text-[11px] font-semibold">Map</a>
                    )}
                    {e.ip && <button onClick={() => { navigator.clipboard.writeText(e.ip); notify.success("IP copied"); }} className="text-slate-600 hover:underline text-[11px] font-semibold">Copy IP</button>}
                    <button onClick={() => setExpanded(isOpen ? null : e.id)} className="text-slate-600 hover:underline text-[11px] font-semibold ml-auto">{isOpen ? "Hide raw" : "Raw"}</button>
                  </div>

                  {isOpen && (
                    <pre className="mt-2 text-[9px] leading-tight bg-slate-50 rounded-lg p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">{JSON.stringify(e, null, 2)}</pre>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}


// ==================== ADMIN: ALL EMAILS (across every user/account) ====================
function AllEmailsPanel() {
  const [emails, setEmails] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [labels, setLabels] = useState<{ label: string; user: string }[]>([]);
  
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<any | null>(null);
  const [offset, setOffset] = useState(0);
  // "picker" = show account cards, "list" = show emails for chosen account (or all).
  const [view, setView] = useState<"picker" | "list">("picker");
  const limit = 100;
  const pageCacheRef = useRef(new Map<string, { at: number; emails: any[]; total: number; hasMore: boolean }>());
  const PAGE_CACHE_TTL_MS = 20_000;


  const load = useCallback(async (nextOffset = 0, labelOverride?: string) => {
    const effectiveLabel = labelOverride !== undefined ? labelOverride : accountLabel;
    const cacheKey = JSON.stringify([effectiveLabel || "", nextOffset, search || ""]);
    const cached = pageCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.at < PAGE_CACHE_TTL_MS) {
      setEmails(cached.emails);
      setTotal(cached.total);
      setHasMore(cached.hasMore);
      setOffset(nextOffset);
      setSelected(new Set());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res: any = await apiCall("manage-app", {
        action: "admin_list_emails",
        limit, offset: nextOffset,
        search: search || undefined,
        accountLabel: effectiveLabel || undefined,
      });
      const nextEmails = res?.emails || [];
      const nextTotal = res?.total || 0;
      const nextHasMore = res?.hasMore === true;
      pageCacheRef.current.set(cacheKey, { at: Date.now(), emails: nextEmails, total: nextTotal, hasMore: nextHasMore });
      if (pageCacheRef.current.size > 30) {
        const oldestKey = pageCacheRef.current.keys().next().value;
        if (typeof oldestKey === "string") pageCacheRef.current.delete(oldestKey);
      }
      setEmails(nextEmails);
      setTotal(nextTotal);
      setHasMore(nextHasMore);
      setOffset(nextOffset);
      setSelected(new Set());
    } catch (e: any) {
      notify.error(e?.message || "Failed to load emails");
    } finally { setLoading(false); }
  }, [search, accountLabel]);

  // SWR: cache the account picker so All Emails opens instantly on every
  // subsequent visit. Fetcher is tiny (2 KV-cached settings reads).
  const accountsFetcher = React.useCallback(async () => {
    const accData: any = await apiCall("manage-app", { action: "get_settings", key: "email_accounts" });
    const labels = Array.isArray(accData?.value)
      ? accData.value
          .map((a: any) => ({ label: String(a.label || a.user || "").trim(), user: String(a.user || "").trim() }))
          .filter((a: any) => a.label)
      : [];
    return { labels };
  }, []);
  const { data: accountsData } = useAdminSlice<{ labels: { label: string; user: string }[] }>(
    AdminSliceKeys.emailAccounts,
    accountsFetcher,
  );
  React.useEffect(() => {
    if (!accountsData) return;
    setLabels(accountsData.labels);
    // Do NOT auto-load emails — admin picks an account first.
  }, [accountsData]);



  const openAccount = (label: string) => {
    setAccountLabel(label);
    setView("list");
    setSearch("");
    load(0, label);
  };
  const backToPicker = () => {
    setView("picker");
    setEmails([]);
    setTotal(0);
    setHasMore(false);
    setSelected(new Set());
    setViewing(null);
  };



  const openEmail = async (id: string) => {
    try {
      const res: any = await apiCall("manage-app", { action: "admin_get_email", id });
      setViewing(res?.email || null);
    } catch (e: any) { notify.error(e?.message || "Failed to open"); }
  };

  const deleteIds = async (ids: string[]) => {
    if (!ids.length) return;
    if (!confirm(`Suppress ${ids.length} email${ids.length === 1 ? "" : "s"} for every user? Future syncs will not bring them back.`)) return;
    try {
      const res: any = await apiCall("manage-app", { action: "admin_delete_emails", ids });
      notify.success(`Suppressed ${res?.deleted ?? ids.length} email${(res?.deleted ?? ids.length) === 1 ? "" : "s"}`);
      if (viewing && ids.includes(viewing.id)) setViewing(null);
      pageCacheRef.current.clear();
      await load(offset);
    } catch (e: any) { notify.error(e?.message || "Delete failed"); }
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const toggleAll = () => {
    if (selected.size === emails.length) setSelected(new Set());
    else setSelected(new Set(emails.map(e => e.id)));
  };

  if (view === "picker") {
    const hasAny = labels.length > 0;
    const totalAccounts = labels.length;
    return (
      <section className="relative overflow-hidden rounded-3xl bg-white p-5 sm:p-7 border border-slate-200/70 shadow-[0_20px_60px_-30px_rgba(220,38,38,0.25)]">
        {/* Soft brand blush */}
        <div className="absolute -top-32 -right-32 w-72 h-72 bg-gradient-to-br from-red-100 to-transparent rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-32 w-72 h-72 bg-gradient-to-tr from-amber-50 to-transparent rounded-full blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="relative flex items-end justify-between gap-3 mb-5 sm:mb-6 pb-4 border-b border-slate-100">
          <div className="min-w-0 flex items-center gap-3">
            <div className="relative flex-shrink-0">
              <div className="absolute inset-0 bg-red-500 rounded-2xl blur-md opacity-30" />
              <div className="relative w-11 h-11 rounded-2xl bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center shadow-lg shadow-red-500/30">
                <Mail className="w-5 h-5 text-white" strokeWidth={2.5} />
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black tracking-[0.2em] text-red-600 mb-0.5">MAIL ARCHIVE</p>
              <h2 className="font-black text-xl sm:text-2xl text-slate-900 tracking-tight leading-none flex items-center gap-2">
                All Emails
                <span className="text-[10px] font-mono font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md border border-slate-200">{totalAccounts.toString().padStart(2, "0")}</span>
              </h2>
            </div>
          </div>
          <p className="text-[10px] sm:text-[11px] text-slate-400 font-mono uppercase tracking-wider text-right hidden sm:block">Tap to load</p>
        </div>

        {!hasAny ? (
          <div className="relative py-16 text-center text-slate-400 text-sm font-mono">// no accounts configured</div>
        ) : (
          <div className="relative grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
            {/* All accounts — ghost card */}
            <button
              onClick={() => openAccount("")}
              className="group relative overflow-hidden text-left rounded-2xl border-2 border-dashed border-slate-200 hover:border-red-400 bg-slate-50/50 hover:bg-red-50/60 active:scale-[0.99] transition-all p-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-white border border-slate-200 group-hover:border-red-300 flex items-center justify-center flex-shrink-0 shadow-sm transition-colors">
                  <Mail className="w-5 h-5 text-slate-500 group-hover:text-red-600 transition-colors" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-black text-slate-900 text-sm truncate">All Accounts</p>
                  <p className="text-[10px] text-slate-500 font-mono truncate uppercase tracking-wide">combined · heavier</p>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-red-500 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
              </div>
            </button>


            {labels.map((a, idx) => (
              <button key={a.label} onClick={() => openAccount(a.label)}
                className="group relative overflow-hidden text-left rounded-2xl border border-slate-200 bg-white hover:border-red-300 hover:shadow-lg hover:shadow-red-500/10 active:scale-[0.99] transition-all p-4">
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-red-500 to-red-700 opacity-80 group-hover:opacity-100 transition-opacity" />
                <div className="flex items-center gap-3 pl-1">
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center flex-shrink-0 shadow-md shadow-red-500/40">
                    <Mail className="w-5 h-5 text-white" strokeWidth={2.5} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="font-black text-slate-900 text-sm truncate" title={a.label}>{a.label}</p>
                      <span className="text-[8px] font-mono font-bold text-slate-400 tracking-wider">#{String(idx + 1).padStart(2, "0")}</span>
                    </div>
                    <p className="text-[10px] text-red-700/80 font-mono truncate mt-0.5" title={a.user}>{a.user || "tap to load"}</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-red-500 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    );

  }



  return (
    <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={backToPicker} className="px-2 py-1 rounded-lg hover:bg-slate-100 text-slate-600 text-sm font-semibold" title="Back to accounts">← Accounts</button>
        <h2 className="font-black text-base sm:text-lg flex items-center gap-2 mr-auto">
          <div className="bg-red-50 p-1.5 rounded-lg"><Mail className="w-4 h-4 text-red-600" /></div>
          {accountLabel || "All accounts"} <span className="text-xs font-normal text-slate-500">({total})</span>
        </h2>
        <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && load(0)}
          placeholder="Search subject / from / to / OTP…" aria-label="Search all emails" className="border rounded-lg px-3 py-1.5 text-sm w-56 text-slate-900" />
        <button onClick={() => load(0)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-semibold">Search</button>
        {selected.size > 0 && (
          <button onClick={() => deleteIds(Array.from(selected))} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold flex items-center gap-1">
            <Trash2 className="w-3.5 h-3.5" /> Delete {selected.size}
          </button>
        )}
      </div>


      {loading && emails.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-sm">Loading…</div>
      ) : emails.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-sm">No emails found.</div>
      ) : (
        <>
          {loading && <div className="mb-2 text-[11px] font-bold text-amber-600">Refreshing cached results…</div>}
          <div className="overflow-auto border rounded-lg max-h-[65vh]">
            <table className="w-full text-xs sm:text-sm min-w-[800px]">
              <thead className="bg-slate-50 text-left text-slate-600 uppercase text-[10px] tracking-wider sticky top-0 z-10">
                <tr>
                  <th className="p-2 w-8"><input type="checkbox" checked={selected.size === emails.length && emails.length > 0} onChange={toggleAll} /></th>
                  <th className="p-2">Date</th><th className="p-2">Account</th><th className="p-2">From</th>
                  <th className="p-2">Subject</th><th className="p-2">OTP</th><th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {emails.map(e => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="p-2"><input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} /></td>
                    <td className="p-2 whitespace-nowrap text-slate-600">{e.date ? new Date(e.date).toLocaleString() : "—"}</td>
                    <td className="p-2 text-slate-700">{e.account_label || "—"}</td>
                    <td className="p-2 text-slate-700 truncate max-w-[220px]" title={e.from_address}>{e.from_address || "—"}</td>
                    <td className="p-2 text-slate-900 font-medium truncate max-w-[300px]" title={e.subject}>{e.subject || "(no subject)"}</td>
                    <td className="p-2 font-mono text-[11px]">{e.otp || "—"}</td>
                    <td className="p-2 whitespace-nowrap">
                      <button onClick={() => openEmail(e.id)} className="text-blue-600 hover:underline text-[11px] mr-3">View</button>
                      <button onClick={() => deleteIds([e.id])} className="text-red-600 hover:underline text-[11px]">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
            <span>Showing {offset + 1}–{offset + emails.length}{hasMore ? "+" : ` of ${total}`}</span>
            <div className="flex gap-2">
              <button disabled={offset === 0} onClick={() => load(Math.max(0, offset - limit))} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg font-semibold disabled:opacity-40">Prev</button>
              <button disabled={!hasMore} onClick={() => load(offset + limit)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg font-semibold disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}

      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3 sm:p-6" onClick={() => setViewing(null)}>
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">{viewing.account_label || "—"} · {viewing.date ? new Date(viewing.date).toLocaleString() : "—"}</p>
                <h3 className="font-black text-lg text-slate-900 truncate">{viewing.subject || "(no subject)"}</h3>
                <p className="text-xs text-slate-600 truncate">From: {viewing.from_address}</p>
                <p className="text-xs text-slate-600 truncate">To: {viewing.to_address}</p>
                {viewing.otp && <p className="text-xs mt-1"><span className="font-mono bg-amber-100 text-amber-800 px-2 py-0.5 rounded">OTP: {viewing.otp}</span></p>}
              </div>
              <button onClick={() => deleteIds([viewing.id])} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
              <button onClick={() => setViewing(null)} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
            </div>
            <div className="p-4 overflow-auto flex-1">
              {viewing.html ? (
                <iframe title="email" srcDoc={responsiveEmailSrcDoc(viewing as Email)} className="w-full border rounded block" scrolling="no" style={{ height: 220, minHeight: 220, overflow: "hidden" }} data-email-iframe="true" data-email-iframe-id={String((viewing as Email).id || "email-preview").replace(/[^a-zA-Z0-9_-]/g, "_")} sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts" />
              ) : (
                <pre className="text-xs whitespace-pre-wrap text-slate-700">{viewing.preview || "(no content)"}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function usePageHead(title: string, description: string, path: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    const url = `https://nfotp.netlify.app${path}`;
    const upsert = (sel: string, create: () => HTMLElement, attr: string, value: string) => {
      let el = document.head.querySelector<HTMLElement>(sel);
      if (!el) { el = create(); document.head.appendChild(el); }
      el.setAttribute(attr, value);
      return el;
    };
    const md = upsert('meta[name="description"]', () => { const m = document.createElement('meta'); m.setAttribute('name', 'description'); return m; }, 'content', description);
    const ot = upsert('meta[property="og:title"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:title'); return m; }, 'content', title);
    const od = upsert('meta[property="og:description"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:description'); return m; }, 'content', description);
    const ou = upsert('meta[property="og:url"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:url'); return m; }, 'content', url);
    const cn = upsert('link[rel="canonical"]', () => { const l = document.createElement('link'); l.setAttribute('rel', 'canonical'); return l; }, 'href', url);
    return () => { document.title = prev; void md; void ot; void od; void ou; void cn; };
  }, [title, description, path]);
}

function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  if (d < 0) return "—";
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function RecipientsDrawer({ notification, onClose, onChanged }: { notification: any; onClose: () => void; onChanged?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<NotificationRecipient[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "seen" | "read" | "clicked" | "deleted" | "pending">("all");
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const list = await adminListRecipients(notification.id);
      setRows(list);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to load recipients");
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [notification.id]);

  const removeForUser = async (userId: string) => {
    if (!confirm("Is user ke inbox se yeh notification hata dein?")) return;
    setRemoving(userId);
    try {
      await adminDeleteNotificationForUser(notification.id, userId);
      notify.success("Removed for this user");
      await load();
      onChanged?.();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed");
    } finally { setRemoving(null); }
  };

  const q = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (q && !((r.name || "").toLowerCase().includes(q) || (r.username || "").toLowerCase().includes(q))) return false;
    switch (filter) {
      case "seen": return !!r.seen_at;
      case "read": return !!r.read_at;
      case "clicked": return !!r.clicked_at;
      case "deleted": return !!r.deleted_at;
      case "pending": return !r.seen_at && !r.deleted_at;
      default: return true;
    }
  });

  const seenN = rows.filter((r) => !!r.seen_at).length;
  const readN = rows.filter((r) => !!r.read_at).length;
  const clickedN = rows.filter((r) => !!r.clicked_at).length;
  const deletedN = rows.filter((r) => !!r.deleted_at).length;

  return (
    <div className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-3xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 sm:p-5 border-b flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">👥 Recipients</div>
            <h3 className="font-black text-base sm:text-lg text-slate-900 truncate mt-0.5">{notification.title}</h3>
            <div className="mt-2 flex items-center gap-3 text-[11px] font-bold flex-wrap">
              <span className="text-slate-600">Total {rows.length}</span>
              <span className="text-slate-600">👀 {seenN} seen</span>
              <span className="text-emerald-700">✅ {readN} read</span>
              <span className="text-sky-700">🖱 {clickedN} clicked</span>
              <span className="text-rose-600">🗑 {deletedN} deleted</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 shrink-0 p-1"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-3 sm:p-4 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or username…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 bg-white focus:outline-none focus:border-slate-400"
            />
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {([
              { k: "all", label: "All" },
              { k: "pending", label: "Pending" },
              { k: "seen", label: "Seen" },
              { k: "read", label: "Read" },
              { k: "clicked", label: "Clicked" },
              { k: "deleted", label: "Deleted" },
            ] as const).map((f) => (
              <button key={f.k} onClick={() => setFilter(f.k)}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors ${filter === f.k ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"}`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">Loading recipients…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">Koi recipient nahi mila.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                <tr>
                  <th className="text-left px-4 py-2.5">User</th>
                  <th className="text-left px-3 py-2.5">Seen</th>
                  <th className="text-left px-3 py-2.5">Read</th>
                  <th className="text-left px-3 py-2.5">Clicked</th>
                  <th className="text-left px-3 py-2.5">Deleted</th>
                  <th className="text-right px-4 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const isDeleted = !!r.deleted_at;
                  return (
                    <tr key={r.user_id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-slate-900 text-[13px]">{r.name || r.username}</div>
                        <div className="text-[11px] text-slate-500">@{r.username}</div>
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-slate-700">{timeAgo(r.seen_at)}</td>
                      <td className={`px-3 py-2.5 text-[12px] ${r.read_at ? "text-emerald-700 font-semibold" : "text-slate-400"}`}>{timeAgo(r.read_at)}</td>
                      <td className={`px-3 py-2.5 text-[12px] ${r.clicked_at ? "text-sky-700 font-semibold" : "text-slate-400"}`}>{timeAgo(r.clicked_at)}</td>
                      <td className={`px-3 py-2.5 text-[12px] ${isDeleted ? "text-rose-600 font-semibold" : "text-slate-400"}`}>{timeAgo(r.deleted_at)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {isDeleted ? (
                          <span className="text-[11px] text-slate-400 italic">already deleted</span>
                        ) : (
                          <button
                            onClick={() => removeForUser(r.user_id)}
                            disabled={removing === r.user_id}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-rose-600 hover:bg-rose-50 border border-rose-200 disabled:opacity-50">
                            <Trash2 className="w-3 h-3" />
                            {removing === r.user_id ? "…" : "Remove for user"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="p-3 border-t bg-slate-50 flex items-center justify-between rounded-b-2xl">
          <button onClick={load} className="text-[12px] font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-[12px] font-bold hover:bg-slate-800">Done</button>
        </div>
      </div>
    </div>
  );
}

// ============ Cookies Tab ============
// Two-step admin flow: 1) pick an IMAP account, 2) upload cookies file
// (JSON array/object or Netscape cookies.txt). Parsed client-side; persisted
// server-side per account so no browser localStorage is needed.
type CookieRecord = { name: string; value: string; domain?: string; path?: string; expires?: number | null; secure?: boolean; httpOnly?: boolean; sameSite?: string };

function parseNetscapeCookies(text: string): CookieRecord[] {
  const out: CookieRecord[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^#HttpOnly_/i, "").trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, , path, secure, expires, name, value] = parts;
    if (!name) continue;
    out.push({
      name,
      value: value ?? "",
      domain,
      path,
      secure: /^true$/i.test(secure),
      expires: Number(expires) || null,
    });
  }
  return out;
}

// Chrome/Edge DevTools → Application → Cookies "Copy" gives a tab-separated
// table: Name\tValue\tDomain\tPath\tExpires\tSize\tHttpOnly\tSecure\tSameSite\t...
// (optional header row). Detect and parse that shape.
function parseDevtoolsTable(text: string): CookieRecord[] {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const rows = lines.map((l) => l.split("\t"));
  if (!rows.every((r) => r.length >= 3)) return [];
  const start = /^name$/i.test((rows[0][0] || "").trim()) ? 1 : 0;
  const out: CookieRecord[] = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[0] || "").trim();
    if (!name || /\s/.test(name)) continue;
    out.push({
      name,
      value: (r[1] ?? "").trim(),
      domain: (r[2] ?? "").trim() || undefined,
      path: (r[3] ?? "").trim() || undefined,
      httpOnly: /^(true|✓|✔|yes)$/i.test((r[6] ?? "").trim()),
      secure: /^(true|✓|✔|yes)$/i.test((r[7] ?? "").trim()),
      sameSite: (r[8] ?? "").trim() || undefined,
    });
  }
  return out;
}

function parseJsonCookies(text: string): CookieRecord[] {
  const data = JSON.parse(text);
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.cookies)
    ? (data as any).cookies
    : (data && typeof data === "object" && (data as any).name)
    ? [data]
    : null;
  if (!arr) throw new Error("JSON must be an array of cookies or { cookies: [...] }");
  return arr.map((c: any) => ({
    name: String(c.name ?? c.Name ?? ""),
    value: String(c.value ?? c.Value ?? ""),
    domain: c.domain ?? c.Domain,
    path: c.path ?? c.Path,
    expires: typeof c.expirationDate === "number" ? c.expirationDate : (typeof c.expires === "number" ? c.expires : null),
    secure: !!(c.secure ?? c.Secure),
    httpOnly: !!(c.httpOnly ?? c.HttpOnly),
    sameSite: c.sameSite ?? c.SameSite,
  })).filter((c: CookieRecord) => c.name);
}

function parseCookieHeader(text: string): CookieRecord[] {
  // Handles:
  //  - "a=1; b=2; c=3" single Cookie header
  //  - one "name=value" per line
  //  - "Set-Cookie: name=value; Path=/; …" (one per line, attributes stripped)
  //  - "Cookie: a=1; b=2" prefix
  const out: CookieRecord[] = [];
  const cleaned = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(set-cookie|cookie)\s*:\s*/i, ""))
    .join("\n");
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pieces = line.split(";").map((p) => p.trim()).filter(Boolean);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const eq = piece.indexOf("=");
      if (eq <= 0) continue;
      const name = piece.slice(0, eq).trim();
      const value = piece.slice(eq + 1).trim();
      if (!name || /\s/.test(name)) continue;
      if (/^(path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned)$/i.test(name)) continue;
      out.push({ name, value });
      const rest = pieces.slice(i + 1).join(";").toLowerCase();
      if (/(^|;|\s)(path|domain|expires|max-age|samesite|secure|httponly)\b/.test(rest)) break;
    }
  }
  return out;
}

function parseManualCookieText(text: string): CookieRecord[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const chunks = lines.length ? lines : (text.trim() ? [text.trim()] : []);
  return chunks.map((value, index) => ({ name: `manual_cookie_text_${index + 1}`, value }));
}

function parseCookiesAuto(text: string, filename: string): { cookies: CookieRecord[]; format: "json" | "netscape" | "devtools" | "header" | "text" } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return { cookies: parseJsonCookies(trimmed), format: "json" };
  if (/^# Netscape/i.test(trimmed)) {
    const c = parseNetscapeCookies(trimmed);
    if (c.length) return { cookies: c, format: "netscape" };
  }
  if (/\t/.test(trimmed)) {
    const firstRow = trimmed.split(/\r?\n/)[0].split("\t");
    if (firstRow.length >= 7 && !/^name$/i.test((firstRow[0] || "").trim())) {
      const c = parseNetscapeCookies(trimmed);
      if (c.length) return { cookies: c, format: "netscape" };
    }
    const dt = parseDevtoolsTable(trimmed);
    if (dt.length) return { cookies: dt, format: "devtools" };
  }
  try { return { cookies: parseJsonCookies(trimmed), format: "json" }; } catch {}
  const netscape = parseNetscapeCookies(trimmed);
  if (netscape.length) return { cookies: netscape, format: "netscape" };
  const header = parseCookieHeader(trimmed);
  if (header.length) return { cookies: header, format: "header" };
  return { cookies: parseManualCookieText(trimmed), format: "text" };
}

function getSavedCookieCount(row: SavedCookieRow): number {
  return Math.max(0, Number(row.count) || 0);
}

type SavedCookieRow = { imap_user: string; label?: string | null; filename?: string | null; format?: string | null; count: number; updated_at: string };
type CookieDraftInfo = { length: number; kind: "JSON" | "Netscape" | "Text" | "" };

function getCookieDraftInfo(text: string): CookieDraftInfo {
  const raw = String(text || "");
  let start = 0;
  while (start < raw.length && /\s/.test(raw[start])) start += 1;
  const first = raw[start] || "";
  const sample = raw.slice(start, start + 512);
  return {
    length: raw.trimStart().length,
    kind: !first ? "" : first === "[" || first === "{" ? "JSON" : /^# Netscape/i.test(sample) || /\t/.test(sample) ? "Netscape" : "Text",
  };
}

function afterNextPaint(fn: () => void) {
  if (typeof window === "undefined") { fn(); return; }
  window.requestAnimationFrame(() => window.setTimeout(fn, 0));
}

function CookiesTab({ emailAccounts }: { emailAccounts: any[] }) {
  const accounts = React.useMemo(() => {
    type Acc = { key: string; label: string; user: string; host: string; isFilter?: boolean; parentLabel?: string };
    const out: Acc[] = [];
    const pushWithFilters = (base: Acc, filters: string[] | undefined) => {
      const clean = (filters || []).map((f) => String(f || "").trim()).filter(Boolean);
      if (clean.length === 0) { out.push(base); return; }
      // Treat each recipient filter as its own "account" (higher priority)
      for (const f of clean) {
        out.push({
          key: `${base.key}::${f.toLowerCase()}`,
          label: f,
          user: f,
          host: base.host,
          isFilter: true,
          parentLabel: base.label,
        });
      }
    };



    for (const a of (emailAccounts || [])) {
      pushWithFilters(
        { key: a.label || a.user, label: a.label || a.user, user: a.user, host: a.host },
        a.recipientFilters,
      );
    }
    // Recipient-filter entries take first priority
    return out.sort((x, y) => Number(!!y.isFilter) - Number(!!x.isFilter));
  }, [emailAccounts]);

  // `selected` is the imap_user (email address) of the account being edited.
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pasteInfo, setPasteInfo] = React.useState<CookieDraftInfo>({ length: 0, kind: "" });
  const [editLoadingFor, setEditLoadingFor] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"paste" | "file">("paste");
  const [dragActive, setDragActive] = React.useState(false);
  const pasteRef = React.useRef<HTMLTextAreaElement | null>(null);
  const pendingPasteValue = React.useRef<string | null>("");
  const draftDirtyRef = React.useRef(false);
  const editLoadSeq = React.useRef(0);
  const contentCache = React.useRef<Record<string, { content: string; filename: string; format: string }>>({});
  const dragCounter = React.useRef(0);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const applyDraftText = React.useCallback((value: string, markDirty = false) => {
    const next = String(value || "");
    pendingPasteValue.current = next;
    if (pasteRef.current) {
      pasteRef.current.value = next;
      pendingPasteValue.current = null;
    }
    draftDirtyRef.current = markDirty;
    setPasteInfo(getCookieDraftInfo(next));
  }, []);

  const bindPasteRef = React.useCallback((node: HTMLTextAreaElement | null) => {
    pasteRef.current = node;
    if (node && pendingPasteValue.current !== null) {
      node.value = pendingPasteValue.current;
      pendingPasteValue.current = null;
    }
  }, []);

  const getDraftText = React.useCallback(() => {
    if (pasteRef.current) return pasteRef.current.value;
    return pendingPasteValue.current || "";
  }, []);

  // SWR: cookies-list paints instantly from cache, silent background refresh.
  const cookiesFetcher = React.useCallback(async () => {
    const res: any = await apiCall("manage-app", { action: "admin_cookies_list" });
    return (Array.isArray(res?.items) ? res.items : []) as SavedCookieRow[];
  }, []);
  const { data: savedRowsData, hasData: cookiesHasData, refreshing: cookiesRefreshing, refresh: refreshCookies } =
    useAdminSlice<SavedCookieRow[]>(AdminSliceKeys.cookies, cookiesFetcher);
  const savedRows = savedRowsData || [];
  const loading = !cookiesHasData && cookiesRefreshing;

  const savedByUser = React.useMemo(() => {
    const map: Record<string, SavedCookieRow> = {};
    for (const r of savedRows) map[String(r.imap_user || "").toLowerCase()] = r;
    return map;
  }, [savedRows]);

  const refresh = React.useCallback(async () => {
    try { await refreshCookies(true); }
    catch (e: any) { notify.error("Could not load saved cookies", { description: e?.message || String(e) }); }
  }, [refreshCookies]);


  const selectedAcc = React.useMemo(() => {
    if (!selected) return null;
    const key = selected.toLowerCase();
    return accounts.find((a) => (a.user || "").toLowerCase() === key) || { key, label: selected, user: selected, host: "" };
  }, [selected, accounts]);

  const saveCookies = async (rawText: string, filename: string) => {
    if (!selected) return;
    const text = rawText.trim();
    if (!text) { notify.error("Nothing to save — paste or upload some cookies first"); return; }
    if (text.length > 2 * 1024 * 1024) { notify.error("Content too large (max 2 MB)"); return; }
    setBusy(true);
    try {
      const { cookies, format } = parseCookiesAuto(text, filename);
      if (!cookies.length) throw new Error("No cookies detected — expected JSON, Netscape cookies.txt, or 'name=value; …' header format");
      await apiCall("manage-app", {
        action: "admin_cookies_save",
        imap_user: selected,
        label: selectedAcc?.label || selected,
        filename,
        format,
        count: cookies.length,
        content: text,
      });
      notify.success(`Saved ${cookies.length} cookie${cookies.length === 1 ? "" : "s"}`, {
        description: `${selected} • ${format.toUpperCase()}${savedByUser[selected.toLowerCase()] ? " (replaced previous)" : ""}`,
      });
      delete contentCache.current[selected.toLowerCase()];
      applyDraftText("");
      if (fileRef.current) fileRef.current.value = "";
      await refresh();
      setSelected(null);
    } catch (e: any) {
      notify.error("Could not save cookies", { description: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) { notify.error("File too large (max 2 MB)"); return; }
    const text = await file.text();
    await saveCookies(text, file.name);
  };

  const [pendingDelete, setPendingDelete] = React.useState<SavedCookieRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await apiCall("manage-app", { action: "admin_cookies_delete", imap_user: pendingDelete.imap_user });
      notify.success("Saved cookies deleted");
      setPendingDelete(null);
      await refresh();
    } catch (e: any) {
      notify.error("Delete failed", { description: e?.message || String(e) });
    } finally {
      setDeleting(false);
    }
  };

  const fetchContent = React.useCallback(async (imapUser: string): Promise<{ content: string; filename: string; format: string } | null> => {
    try {
      const key = imapUser.toLowerCase();
      if (contentCache.current[key]) return contentCache.current[key];
      const res: any = await apiCall("manage-app", { action: "admin_cookies_get", imap_user: imapUser });
      if (!res?.item?.content) throw new Error("No content stored");
      const item = { content: res.item.content, filename: res.item.filename || "cookies.txt", format: res.item.format || "text" };
      contentCache.current[key] = item;
      return item;
    } catch (e: any) {
      notify.error("Fetch failed", { description: e?.message || String(e) });
      return null;
    }
  }, []);

  const openEditorForRow = React.useCallback(async (row: SavedCookieRow) => {
    const imapUser = row.imap_user;
    const key = imapUser.toLowerCase();
    const seq = ++editLoadSeq.current;

    const cached = contentCache.current[key];
    if (cached) {
      setMode("paste");
      applyDraftText(cached.content);
      setEditLoadingFor(null);
      setSelected(imapUser);
      return;
    }

    // Fetch FIRST — keep the user on the list with a spinner on the row —
    // then transition to the editor only when the content is ready.
    setEditLoadingFor(imapUser);
    try {
      const data = await fetchContent(imapUser);
      if (seq !== editLoadSeq.current) return;
      if (!data) return;
      setMode("paste");
      applyDraftText(data.content);
      setSelected(imapUser);
    } finally {
      if (seq === editLoadSeq.current) setEditLoadingFor(null);
    }
  }, [applyDraftText, fetchContent]);


  const copyForRow = async (imapUser: string) => {
    const data = await fetchContent(imapUser);
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.content);
      notify.success("Cookies copied to clipboard");
    } catch (e: any) {
      notify.error("Copy failed", { description: e?.message || "Clipboard unavailable" });
    }
  };

  const openLinkForRow = async (imapUser: string) => {
    const data = await fetchContent(imapUser);
    if (!data) return;
    const blob = new Blob([data.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const downloadForRow = async (imapUser: string) => {
    const data = await fetchContent(imapUser);
    if (!data) return;
    const safeName = imapUser.replace(/[^\w.\-@]/g, "_");
    const ext = data.format === "json" ? ".json" : ".txt";
    const name = `cookies-${safeName}${ext}`;
    const blob = new Blob([data.content], { type: data.format === "json" ? "application/json" : "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
    notify.success(`Downloaded ${name}`);
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-amber-50 p-2 rounded-xl"><Key className="w-5 h-5 text-amber-600" /></div>
          <div className="min-w-0">
            <h2 className="font-black text-base sm:text-lg text-slate-900">Cookies Vault</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {selected ? `Editing cookies for ${selected}` : "Manage saved cookies per IMAP account. Stored in Supabase."}
            </p>
          </div>
          {selected && (
            <button onClick={() => { editLoadSeq.current += 1; setSelected(null); setEditLoadingFor(null); applyDraftText(""); }} className="ml-auto text-xs font-bold text-slate-600 hover:text-slate-900 flex items-center gap-1">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          )}
        </div>
      </section>

      {/* STEP 1 — pick account + saved cookies list */}
      {!selected && (
        <>
          <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
            <h3 className="font-bold text-sm text-slate-900 mb-3 flex items-center gap-2">
              <Server className="w-4 h-4 text-slate-400" /> Select an IMAP account
              <span className="bg-slate-100 text-slate-600 text-xs px-2 py-0.5 rounded-full ml-auto">{accounts.filter((a) => !savedByUser[(a.user || "").toLowerCase()]).length}</span>
            </h3>
            {accounts.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">No IMAP accounts configured yet. Add one under the "Email Accounts" tab.</p>
            ) : accounts.filter((a) => !savedByUser[(a.user || "").toLowerCase()]).length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">All IMAP accounts already have saved cookies. Delete a saved entry below to re-add one.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {accounts.filter((a) => !savedByUser[(a.user || "").toLowerCase()]).map((a) => {
                  return (
                    <li key={a.key}>
                      <button
                         onClick={() => { if (!a.user) return; editLoadSeq.current += 1; setMode("paste"); applyDraftText(""); setSelected(a.user); }}
                        disabled={!a.user}
                        className="w-full flex items-center gap-3 py-3 px-2 rounded-xl hover:bg-slate-50 transition-colors text-left disabled:opacity-50"
                      >
                        <div className={`p-2 rounded-xl ${a.isFilter ? "bg-red-50" : "bg-slate-100"}`}>
                          <Mail className={`w-4 h-4 ${a.isFilter ? "text-red-600" : "text-slate-500"}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="font-bold text-sm text-slate-900 truncate">{a.label}</p>
                            {a.isFilter && (
                              <span className="text-[9px] font-black uppercase tracking-wider bg-red-50 text-red-700 border border-red-200 px-1.5 py-0.5 rounded">
                                Recipient
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 truncate">
                            {a.isFilter ? `via ${a.parentLabel}${a.host ? ` • ${a.host}` : ""}` : `${a.user || "—"}${a.host ? ` • ${a.host}` : ""}`}
                          </p>
                        </div>
                        <ChevronRight className="w-4 h-4 text-slate-300" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>


          {/* Saved cookies list */}
          <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
            <h3 className="font-bold text-sm text-slate-900 mb-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Saved Cookies
              <span className="bg-slate-100 text-slate-600 text-xs px-2 py-0.5 rounded-full ml-auto">{savedRows.length}</span>
            </h3>
            {loading ? (
              <div className="py-8 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : savedRows.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">No cookies saved yet. Pick an account above to add some.</p>
            ) : (
              <ul className="space-y-2">
                {savedRows.map((r) => (
                  <li key={r.imap_user} className="rounded-2xl border border-slate-200 bg-slate-50/40 p-3 sm:p-4">
                    <div className="flex items-start gap-3">
                      <div className="bg-emerald-100 p-2 rounded-xl flex-shrink-0"><Mail className="w-4 h-4 text-emerald-700" /></div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-sm text-slate-900 truncate">{r.imap_user}</p>
                          {r.format && (
                            <span className="text-[10px] font-bold uppercase tracking-wider bg-white text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded">{r.format}</span>
                          )}
                        </div>
                        <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                          Saved {new Date(r.updated_at).toLocaleString()}
                          {r.filename ? ` · ${r.filename}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => copyForRow(r.imap_user)}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-colors"
                        title="Copy cookie text to clipboard"
                      >
                        <Copy className="w-3.5 h-3.5" /> Copy
                      </button>
                      <button
                        onClick={() => openLinkForRow(r.imap_user)}
                        className="inline-flex items-center gap-1.5 text-xs font-black text-white bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded-lg transition-colors shadow-sm"
                        title="Open cookie content in a new tab"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> Open link
                      </button>
                      <button
                        onClick={() => downloadForRow(r.imap_user)}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-colors"
                        title="Download as .txt / .json"
                      >
                        <Download className="w-3.5 h-3.5" /> Download
                      </button>
                      <button
                        onClick={() => openEditorForRow(r)}
                        disabled={editLoadingFor === r.imap_user}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-colors ml-auto disabled:opacity-60 disabled:cursor-wait"
                        title="Load current cookies into editor to edit or replace"
                      >
                        {editLoadingFor === r.imap_user
                          ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</>)
                          : (<><Edit className="w-3.5 h-3.5" /> Change</>)}
                      </button>


                      <button
                        onClick={() => setPendingDelete(r)}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-red-600 hover:bg-red-50 px-2 py-1.5 rounded-lg transition-colors"
                        title="Delete saved cookies"
                        aria-label={`Delete cookies for ${r.imap_user}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {/* STEP 2 — paste first, then upload */}
      {selected && selectedAcc && (
        <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
          <div className="flex items-center gap-3 mb-4 sm:mb-5 pb-4 border-b border-slate-100">
            <div className="bg-slate-100 p-2 rounded-xl flex-shrink-0">
              <Mail className="w-4 h-4 text-slate-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-sm text-slate-900 truncate">{selectedAcc.label}</p>
              <p className="text-[11px] sm:text-xs text-slate-500 truncate">{selectedAcc.user || "—"}</p>
            </div>
            {savedByUser[selected.toLowerCase()] && (
              <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-50 text-amber-700 border border-amber-200 px-2 py-1 rounded-md">Will replace existing</span>
            )}
          </div>




          {/* Paste FIRST, then Upload */}
          <div role="tablist" aria-label="Save mode" className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl mb-4">
            <button
              role="tab"
              aria-selected={mode === "paste"}
              onClick={() => setMode("paste")}
              className={`flex items-center justify-center gap-1.5 sm:gap-2 h-9 rounded-lg text-xs sm:text-sm font-bold transition-all ${mode === "paste" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <ClipboardPaste className="w-3.5 h-3.5" /> Paste text
            </button>
            <button
              role="tab"
              aria-selected={mode === "file"}
              onClick={() => setMode("file")}
              className={`flex items-center justify-center gap-1.5 sm:gap-2 h-9 rounded-lg text-xs sm:text-sm font-bold transition-all ${mode === "file" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              <Upload className="w-3.5 h-3.5" /> Upload file
            </button>
          </div>

          {mode === "paste" && (
            <div>
              <div className="relative">
                <textarea
                  ref={bindPasteRef}
                  onChange={(e) => { draftDirtyRef.current = true; setPasteInfo(getCookieDraftInfo(e.target.value)); }}
                  placeholder={'[\n  { "name": "SessionId", "value": "…", "domain": ".netflix.com" }\n]\n\n— or —\n\n.netflix.com\tTRUE\t/\tTRUE\t1900000000\tSessionId\t…'}
                  rows={10}
                  disabled={busy}
                  className="w-full text-[11px] sm:text-xs font-mono rounded-xl border border-slate-300 bg-slate-50 p-3 sm:p-4 focus:outline-none focus:ring-2 focus:ring-red-400/60 focus:border-red-400 focus:bg-white resize-y transition-colors placeholder:text-slate-400"
                  spellCheck={false}
                />
                {pasteInfo.length > 0 && (
                  <span className="absolute top-2 right-2 text-[10px] font-bold uppercase tracking-wider bg-white/90 text-slate-500 px-1.5 py-0.5 rounded border border-slate-200 backdrop-blur">
                    {pasteInfo.kind}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between mt-3 gap-3 flex-wrap">
                <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${pasteInfo.length ? "bg-emerald-500" : "bg-slate-300"}`} />
                  {pasteInfo.length ? `${pasteInfo.length.toLocaleString()} chars` : "Auto-detects JSON or Netscape"}
                </p>
                <div className="flex items-center gap-2">
                  {pasteInfo.length > 0 && (
                    <button onClick={() => applyDraftText("", true)} disabled={busy} className="text-xs font-bold text-slate-600 hover:text-slate-900 px-3 py-2 rounded-lg hover:bg-slate-100 transition-colors">Clear</button>
                  )}
                  <button
                    onClick={() => {
                      const text = getDraftText();
                      const looksJson = text.trim().startsWith("[") || text.trim().startsWith("{");
                      saveCookies(text, looksJson ? "pasted-cookies.json" : "pasted-cookies.txt");
                    }}
                    disabled={busy || !pasteInfo.length}
                    className="text-xs font-black text-white bg-red-600 hover:bg-red-700 disabled:bg-slate-300 disabled:cursor-not-allowed px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-1.5 shadow-sm"
                  >
                    {busy ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>) : "Save cookies"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {mode === "file" && (
            <label
              htmlFor="cookies-file-input"
              className={`relative block border-2 border-dashed rounded-2xl p-6 sm:p-10 text-center cursor-pointer transition-all select-none ${
                busy
                  ? "border-slate-200 bg-slate-50 opacity-70 cursor-wait"
                  : dragActive
                  ? "border-red-500 bg-red-50 scale-[1.01] shadow-inner"
                  : "border-slate-300 hover:border-red-400 hover:bg-red-50/30"
              }`}
              onDragEnter={(e) => { e.preventDefault(); dragCounter.current += 1; setDragActive(true); }}
              onDragLeave={(e) => { e.preventDefault(); dragCounter.current -= 1; if (dragCounter.current <= 0) { dragCounter.current = 0; setDragActive(false); } }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDrop={(e) => { e.preventDefault(); dragCounter.current = 0; setDragActive(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
            >
              <input
                id="cookies-file-input"
                ref={fileRef}
                type="file"
                accept=".json,.txt,application/json,text/plain"
                className="sr-only"
                disabled={busy}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              <div className={`mx-auto w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex items-center justify-center mb-3 transition-colors ${dragActive ? "bg-red-100" : "bg-slate-100"}`}>
                {busy ? <Loader2 className="w-6 h-6 text-slate-500 animate-spin" /> : <Upload className={`w-6 h-6 ${dragActive ? "text-red-600" : "text-slate-500"}`} />}
              </div>
              <p className="text-sm sm:text-base font-bold text-slate-900">
                {busy ? "Saving…" : dragActive ? "Release to upload" : (
                  <>
                    <span className="hidden sm:inline">Drag &amp; drop or </span>
                    <span className="text-red-600 underline underline-offset-2">choose a file</span>
                  </>
                )}
              </p>
              <p className="text-[11px] sm:text-xs text-slate-500 mt-1.5">JSON (EditThisCookie / Puppeteer) or Netscape cookies.txt · max 2 MB</p>
            </label>
          )}
        </section>
      )}

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => !deleting && setPendingDelete(null)}
        >
          <div
            className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <div className="bg-red-50 p-2.5 rounded-xl flex-shrink-0">
                  <Trash2 className="w-5 h-5 text-red-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-black text-base text-slate-900">Delete saved cookies?</h3>
                  <p className="text-xs text-slate-500 mt-1">This action can't be undone.</p>
                </div>
              </div>
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-bold text-slate-500 w-16 flex-shrink-0">Account</span>
                  <span className="font-mono text-slate-900 truncate">{pendingDelete.imap_user}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-bold text-slate-500 w-16 flex-shrink-0">Format</span>
                  <span className="text-slate-900">{pendingDelete.format ? pendingDelete.format.toUpperCase() : "—"}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-bold text-slate-500 w-16 flex-shrink-0">Saved</span>
                  <span className="text-slate-900">{new Date(pendingDelete.updated_at).toLocaleString()}</span>
                </div>
                {pendingDelete.filename && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-bold text-slate-500 w-16 flex-shrink-0">File</span>
                    <span className="text-slate-900 truncate">{pendingDelete.filename}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 sm:px-6 py-4 bg-slate-50 border-t border-slate-100">
              <button
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="text-xs font-bold text-slate-700 hover:bg-slate-200 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="text-xs font-black text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-1.5 shadow-sm"
              >
                {deleting ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Deleting…</>) : (<><Trash2 className="w-3.5 h-3.5" /> Delete cookies</>)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



function AdminPanel() {
  usePageHead("Admin Dashboard — Netflix Mail", "Admin control panel for managing users, sessions, notifications, and email accounts.", "/admin/dashboard");
  const ADMIN_ACTIVE_TAB_KEY = "admin_active_tab_v1";
  const [activeTab, setActiveTab] = useState<"users" | "security" | "emails" | "settings" | "notifications" | "inbox" | "logins" | "allmails" | "deploy" | "tv" | "cookies" | "directlink">(() => {
    try {
      const raw = sessionStorage.getItem(ADMIN_ACTIVE_TAB_KEY);
      if (!raw) return "users";
      const allowed = new Set(["users", "security", "emails", "settings", "notifications", "inbox", "logins", "allmails", "deploy", "tv", "cookies", "directlink"]);
      return allowed.has(raw) ? (raw as any) : "users";

    } catch {
      return "users";
    }
  });
  const [users, setUsers] = useState<UserData[]>(() => {
    // Instant hydrate from bootstrap cache so the users list renders on first paint.
    try {
      const cached = readBootstrapCache();
      if (cached?.users?.length) return cached.users as any;
    } catch {}
    return [];
  });
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newUserAccounts, setNewUserAccounts] = useState<string[]>([]);
  const [siteKey, setSiteKey] = useState("");
  const [secretKeyVal, setSecretKeyVal] = useState("");
  const [sessionTimeoutMin, setSessionTimeoutMin] = useState<string>("0");
  const [savingSessionTimeout, setSavingSessionTimeout] = useState(false);
  const [adminSessionTimeoutMin, setAdminSessionTimeoutMin] = useState<string>("0");
  const [concurrentSessionLimit, setConcurrentSessionLimit] = useState<string>("0");
  const [savingConcurrentSessionLimit, setSavingConcurrentSessionLimit] = useState(false);
  const [freeAvatarCooldownMin, setFreeAvatarCooldownMinState] = useState<string>("5");
  const [savingFreeAvatarCooldown, setSavingFreeAvatarCooldown] = useState(false);
  const [contactInfoTelegrams, setContactInfoTelegrams] = useState<string[]>([""]);
  const [contactInfoWhatsapps, setContactInfoWhatsapps] = useState<string[]>([""]);
  const [contactInfoEmails, setContactInfoEmails] = useState<string[]>([""]);
  const [contactInfoNote, setContactInfoNote] = useState<string>("");
  const [savingContactInfo, setSavingContactInfo] = useState(false);
  const loadContactInfoRef = useRef(false);
  useEffect(() => {
    if (loadContactInfoRef.current) return;
    loadContactInfoRef.current = true;
    (async () => {
      try {
        const res: any = await apiCall("manage-app", { action: "get_settings", key: "contact_info" });
        const v = res?.value || res?.settings?.contact_info || null;
        if (v && typeof v === "object") {
          const pickArr = (plural: any, singular: any): string[] => {
            if (Array.isArray(plural) && plural.length) return plural.map((x: any) => String(x || "")).filter(Boolean);
            if (typeof singular === "string" && singular.trim()) return [singular.trim()];
            return [""];
          };
          setContactInfoTelegrams(pickArr(v.telegrams, v.telegram));
          setContactInfoWhatsapps(pickArr(v.whatsapps, v.whatsapp));
          setContactInfoEmails(pickArr(v.emails, v.email));
          setContactInfoNote(v.note || "");
        }
      } catch {}
    })();
  }, []);
  const saveContactInfo = async () => {
    setSavingContactInfo(true);
    try {
      const clean = (arr: string[]) => Array.from(new Set(arr.map(s => s.trim()).filter(Boolean)));
      await apiCall("manage-app", { action: "save_contact_info", value: {
        telegrams: clean(contactInfoTelegrams),
        whatsapps: clean(contactInfoWhatsapps),
        emails: clean(contactInfoEmails),
        note: contactInfoNote.trim(),
      }});
      notify.success("Contact info saved");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save contact info");
    } finally {
      setSavingContactInfo(false);
    }
  };



  const [savingAdminSessionTimeout, setSavingAdminSessionTimeout] = useState(false);
  const [captchaEnabled, setCaptchaEnabled] = useState<boolean>(false);
  const [emailVisibilityEnabled, setEmailVisibilityEnabled] = useState(false);
  const [emailVisibilityDays, setEmailVisibilityDays] = useState<string>("20");
  const [savingEmailVisibility, setSavingEmailVisibility] = useState(false);
  const [emailAutoDeleteEnabled, setEmailAutoDeleteEnabled] = useState(false);
  const [emailAutoDeleteDays, setEmailAutoDeleteDays] = useState<string>("30");
  const [emailAutoDeleteHour, setEmailAutoDeleteHour] = useState<string>("3");
  const [savingEmailAutoDelete, setSavingEmailAutoDelete] = useState(false);
  const [blockNetflixPromo, setBlockNetflixPromo] = useState(false);
  const [savingBlockPromo, setSavingBlockPromo] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [changingUserPass, setChangingUserPass] = useState<string | null>(null);
  const [userNewPass, setUserNewPass] = useState("");
  const [showSignInCodes, setShowSignInCodes] = useState(true);
  const [showPasswordResets, setShowPasswordResets] = useState(true);
  const [showAccountUpdates, setShowAccountUpdates] = useState(true);
  const [editingUserAccounts, setEditingUserAccounts] = useState<string | null>(null);
  const [editHint, setEditHint] = useState<string | null>(null);
  const [editAccountsList, setEditAccountsList] = useState<string[]>([]);
  const [editUsername, setEditUsername] = useState<string>("");
  const [editSessionLimit, setEditSessionLimit] = useState<string>("");
  const [editExpiresAt, setEditExpiresAt] = useState<string>(""); // "YYYY-MM-DDTHH:mm" for free users only
  const [editAutoDelete, setEditAutoDelete] = useState<boolean>(true);
  const [editPlanStartsAt, setEditPlanStartsAt] = useState<string>("");
  const [editPlanEndsAt, setEditPlanEndsAt] = useState<string>("");
  const [editTvOverride, setEditTvOverride] = useState<"inherit" | "on" | "off">("inherit");
  const [editDirectLinkEnabled, setEditDirectLinkEnabled] = useState<boolean>(false);
  const [newIsFree, setNewIsFree] = useState(false);
  const [newFreeExpiresAt, setNewFreeExpiresAt] = useState<string>(""); // "YYYY-MM-DDTHH:mm"
  const [newPlanStartsAt, setNewPlanStartsAt] = useState<string>("");
  const [newPlanEndsAt, setNewPlanEndsAt] = useState<string>("");
  const [newTvOverride, setNewTvOverride] = useState<"inherit" | "on" | "off">("inherit");
  const [dragUserId, setDragUserId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [serverConfig, setServerConfig] = useState({
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "",
  });
  const [savingConfig, setSavingConfig] = useState(false);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccountConfig[]>([]);
  const [newAccount, setNewAccount] = useState({ label: "", host: "imap.gmail.com", port: "993", user: "", password: "" });
  const [newAccountCfUrls, setNewAccountCfUrls] = useState<string[]>([]);
  const [newAccountCfInput, setNewAccountCfInput] = useState("");
  const [newAccountRecipients, setNewAccountRecipients] = useState("");
  const [savingAccounts, setSavingAccounts] = useState(false);
  const [expandedAccount, setExpandedAccount] = useState<number | null>(null);
  const [revealedPasswords, setRevealedPasswords] = useState<Set<string>>(new Set());
  const togglePasswordReveal = (key: string) => {
    setRevealedPasswords(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const copyToClipboard = async (text: string, label = "Copied") => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      }
      notify.success(label);
    } catch { notify.error("Copy failed"); }
  };
  const [primaryCfUrls, setPrimaryCfUrls] = useState<string[]>([]);
  // Location alert toggle
  const [ipwhoAlertEnabled, setIpwhoAlertEnabled] = useState(false);
  const [savingIpwho, setSavingIpwho] = useState(false);
  const [locationPolicyRequired, setLocationPolicyRequired] = useState(true);
  const [tvFeatureEnabled, setTvFeatureEnabled] = useState(true);
  const [tvSearch, setTvSearch] = useState("");
  const [savingTvFeature, setSavingTvFeature] = useState(false);
  const [savingLocationPolicy, setSavingLocationPolicy] = useState(false);

  // VPS Vault (admin-only metadata in app_settings; private key file lives in R2)
  const [vpsCfg, setVpsCfg] = useState<{ ip: string; runnerUrl: string; mode: "vps" | "github"; keyFilename: string; keyUploadedAt: string; keySize: number; hasKey: boolean }>({
    ip: "140.238.226.213", runnerUrl: "", mode: "vps", keyFilename: "vps-private-key.pem", keyUploadedAt: "", keySize: 0, hasKey: false,
  });
  const [vpsDeletingKey, setVpsDeletingKey] = useState(false);
  const [vpsTesting, setVpsTesting] = useState(false);
  const [vpsHealth, setVpsHealth] = useState<{ ok: boolean; status: number; latencyMs: number; message?: string; at: number } | null>(null);
  const [githubTesting, setGithubTesting] = useState(false);
  const [githubHealth, setGithubHealth] = useState<{ ok: boolean; status: string; latencyMs: number; message?: string; runUrl?: string; at: number } | null>(null);
  const [ghSetupStatus, setGhSetupStatus] = useState<{ configured: boolean; repo: string; hasPat: boolean; hasHmac: boolean; updatedAt: string | null } | null>(null);
  const [ghSetupSyncing, setGhSetupSyncing] = useState(false);
  const [ghSetupPat, setGhSetupPat] = useState("");
  const [ghSetupPatVisible, setGhSetupPatVisible] = useState(false);
  const [ghSetupRepo, setGhSetupRepo] = useState("");
  const [ghSetupOpen, setGhSetupOpen] = useState(false);
  const loadGhStatus = React.useCallback(async () => {
    try {
      const res: any = await apiCall("manage-app", { action: "admin_github_status" });
      setGhSetupStatus({
        configured: !!res?.configured,
        repo: String(res?.repo || ""),
        hasPat: !!res?.hasPat,
        hasHmac: !!res?.hasHmac,
        updatedAt: res?.updatedAt || null,
      });
      setGhSetupRepo((prev) => prev || String(res?.repo || ""));
    } catch {}
  }, []);
  const revealSavedPat = React.useCallback(async () => {
    try {
      const res: any = await apiCall("manage-app", { action: "admin_github_status", reveal: true });
      if (res?.pat) setGhSetupPat(String(res.pat));
      else notify.error("No saved token found");
    } catch (e: any) {
      notify.error("Could not load saved token", { description: e?.message || String(e) });
    }
  }, []);
  React.useEffect(() => { if (activeTab === "tv") { void loadGhStatus(); } }, [activeTab, loadGhStatus]);
  const runGhSetup = async () => {
    if (ghSetupSyncing) return;
    if (!ghSetupPat.trim() && !ghSetupStatus?.hasPat) {
      notify.error("Paste a GitHub token first");
      return;
    }
    setGhSetupSyncing(true);
    try {
      const res: any = await apiCall("manage-app", { action: "admin_github_setup", pat: ghSetupPat.trim(), repo: ghSetupRepo.trim() });
      notify.success("GitHub setup synced", { description: res?.message || `Linked to ${res?.repo || "repo"}` });
      setGhSetupPat("");
      setGhSetupOpen(false);
      await loadGhStatus();
    } catch (e: any) {
      notify.error("GitHub setup failed", { description: e?.message || String(e) });
    } finally {
      setGhSetupSyncing(false);
    }
  };
  const [vpsLoading, setVpsLoading] = useState(false);
  const [vpsSaving, setVpsSaving] = useState(false);
  const [vpsUploading, setVpsUploading] = useState(false);
  const vpsFileInputRef = useRef<HTMLInputElement | null>(null);
  const vpsLoadedRef = useRef(false);

  // VPS config: SWR-cached so opening TV tab paints instantly on repeat visits.
  const vpsFetcher = React.useCallback(async () => {
    const res: any = await apiCall("manage-app", { action: "admin_get_vps_config" });
    return (res?.value || {}) as any;
  }, []);
  const { data: vpsData, refreshing: vpsRefreshing } = useAdminSlice<any>(
    AdminSliceKeys.vps,
    vpsFetcher,
    { enabled: activeTab === "tv" },
  );
  React.useEffect(() => { setVpsLoading(vpsRefreshing); }, [vpsRefreshing]);
  React.useEffect(() => {
    if (!vpsData) return;
    setVpsCfg((prev) => ({
      ip: typeof vpsData.ip === "string" && vpsData.ip ? vpsData.ip : prev.ip,
      runnerUrl: typeof vpsData.runnerUrl === "string" ? vpsData.runnerUrl : prev.runnerUrl,
      mode: vpsData.mode === "github" ? "github" : "vps",
      keyFilename: typeof vpsData.keyFilename === "string" && vpsData.keyFilename ? vpsData.keyFilename : prev.keyFilename,
      keyUploadedAt: typeof vpsData.keyUploadedAt === "string" ? vpsData.keyUploadedAt : "",
      keySize: Number(vpsData.keySize) || 0,
      hasKey: vpsData.hasKey === true,
    }));
  }, [vpsData]);


  const saveVpsConfig = async () => {
    if (vpsSaving) return;
    setVpsSaving(true);
    try {
      const res: any = await apiCall("manage-app", { action: "admin_save_vps_access", ip: vpsCfg.ip.trim(), runnerUrl: vpsCfg.runnerUrl.trim(), mode: vpsCfg.mode });
      if (res?.value) setVpsCfg((p) => ({ ...p, ...res.value }));
      notify.success("VPS settings saved");
    } catch (e: any) {
      notify.error("Failed to save VPS", { description: e?.message || String(e) });
    } finally {
      setVpsSaving(false);
    }
  };

  const testVpsRunner = async () => {
    if (vpsTesting) return;
    setVpsTesting(true);
    try {
      const res: any = await apiCall("manage-app", { action: "admin_test_vps_runner" });
      const h = { ok: !!res?.ok, status: Number(res?.status) || 0, latencyMs: Number(res?.latencyMs) || 0, message: res?.message || "", at: Date.now() };
      setVpsHealth(h);
      if (h.ok) notify.success(`Runner online · ${h.latencyMs}ms`);
      else notify.error(`Runner offline${h.status ? ` (${h.status})` : ""}`, { description: h.message || "No response from /health" });
    } catch (e: any) {
      setVpsHealth({ ok: false, status: 0, latencyMs: 0, message: e?.message || String(e), at: Date.now() });
      notify.error("Test failed", { description: e?.message || String(e) });
    } finally {
      setVpsTesting(false);
    }
  };

  const testGithubRunner = async () => {
    if (githubTesting) return;
    setGithubTesting(true);
    try {
      const res: any = await apiCall("manage-app", { action: "admin_test_github_runner" });
      const h = {
        ok: !!res?.ok,
        status: String(res?.githubStatus || res?.status || "unknown"),
        latencyMs: Number(res?.latencyMs) || 0,
        message: res?.message || "",
        runUrl: res?.runUrl || "",
        at: Date.now(),
      };
      setGithubHealth(h);
      if (h.ok) notify.success("GitHub runner test sent", { description: h.message || "Check GitHub Actions." });
      else notify.error("GitHub runner problem", { description: h.message || "Check repo token and Actions runners." });
    } catch (e: any) {
      const msg = e?.message || String(e);
      setGithubHealth({ ok: false, status: "error", latencyMs: 0, message: msg, at: Date.now() });
      notify.error("GitHub test failed", { description: msg });
    } finally {
      setGithubTesting(false);
    }
  };

  const uploadVpsKeyFile = async (file: File) => {
    if (!file || vpsUploading) return;
    setVpsUploading(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read file"));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      const res: any = await apiCall("manage-app", {
        action: "admin_upload_vps_key",
        filename: file.name || "vps-private-key.pem",
        contentType: file.type || "application/x-pem-file",
        dataBase64,
      });
      if (res?.value) setVpsCfg((p) => ({ ...p, ...res.value }));
      notify.success("Private key saved to Cloudflare");
    } catch (e: any) {
      notify.error("Key upload failed", { description: e?.message || String(e) });
    } finally {
      setVpsUploading(false);
      if (vpsFileInputRef.current) vpsFileInputRef.current.value = "";
    }
  };

  const downloadSshKey = async () => {
    if (!vpsCfg.hasKey) { notify.error("No private key uploaded"); return; }
    try {
      const res: any = await apiCall("manage-app", { action: "admin_download_vps_key" });
      const b64 = String(res?.dataBase64 || "");
      if (!b64) throw new Error("Empty key response");
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const filename = String(res?.filename || vpsCfg.keyFilename || "vps-private-key.pem").replace(/[^\w.\-]/g, "_");
      const blob = new Blob([bytes], { type: "application/x-pem-file" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
      notify.success("Private key downloaded");
    } catch (e: any) {
      notify.error("Download failed", { description: e?.message || String(e) });
    }
  };
  const deleteVpsKey = async () => {
    if (vpsDeletingKey) return;
    if (!confirm("Delete the stored SSH private key? You'll need to upload a new one before the current VPS can be re-used.")) return;
    setVpsDeletingKey(true);
    try {
      const res: any = await apiCall("manage-app", { action: "admin_delete_vps_key" });
      if (res?.value) setVpsCfg((p) => ({ ...p, ...res.value }));
      notify.success("Private key deleted");
    } catch (e: any) {
      notify.error("Delete failed", { description: e?.message || String(e) });
    } finally {
      setVpsDeletingKey(false);
    }
  };



  useEffect(() => {
    const applyEvent = (event: TvFeatureEvent) => {
      if (!event || typeof event !== "object") return;
      if (event.type === "tv-global") {
        setTvFeatureEnabled(event.enabled !== false);
        return;
      }
      if (event.type === "tv-profile") {
        const next = normalizeTvOverride(event.tvOverride);
        setUsers(prev => prev.map(u => u.id === event.userId ? { ...u, tvOverride: next } : u));
      }
    };
    const onWindowEvent = (event: Event) => applyEvent((event as CustomEvent<TvFeatureEvent>).detail);
    window.addEventListener(TV_FEATURE_CHANNEL, onWindowEvent);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(TV_FEATURE_CHANNEL);
      channel.onmessage = (event) => applyEvent(event.data as TvFeatureEvent);
    } catch {}
    return () => {
      window.removeEventListener(TV_FEATURE_CHANNEL, onWindowEvent);
      try { channel?.close(); } catch {}
    };
  }, []);
  // Maintenance mode
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceTitle, setMaintenanceTitle] = useState("");
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [maintenanceStartsAt, setMaintenanceStartsAt] = useState(""); // datetime-local "YYYY-MM-DDTHH:mm"
  const [maintenanceEndsAt, setMaintenanceEndsAt] = useState(""); // datetime-local value "YYYY-MM-DDTHH:mm"
  const [maintenanceVersionFrom, setMaintenanceVersionFrom] = useState("");
  const [maintenanceVersionTo, setMaintenanceVersionTo] = useState("");
  const [savingMaintenance, setSavingMaintenance] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<UserData | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);
  const prevSavedVersionToRef = useRef<string>("");


  // Notifications tab
  const [adminNotifs, setAdminNotifs] = useState<any[]>([]);
  const [notifTitle, setNotifTitle] = useState("");
  const [notifBody, setNotifBody] = useState("");
  const [notifDescription, setNotifDescription] = useState("");
  const [notifImageUrl, setNotifImageUrl] = useState("");
  const [notifImageUploading, setNotifImageUploading] = useState(false);
  const [notifCategory, setNotifCategory] = useState<"announcement" | "update" | "security" | "maintenance" | "promo" | "billing">("announcement");
  const [notifPriority, setNotifPriority] = useState<"low" | "normal" | "high" | "critical">("normal");
  const [notifActionUrl, setNotifActionUrl] = useState("");
  const [notifActionLabel, setNotifActionLabel] = useState("");
  
  const [notifAudience, setNotifAudience] = useState<"all" | "user">("all");
  const [notifTargetUser, setNotifTargetUser] = useState<string>("");
  const [notifExpiresDays, setNotifExpiresDays] = useState<string>("");
  const [notifPlatformIcon, setNotifPlatformIcon] = useState<string>("");
  const [notifTemplate, setNotifTemplate] = useState<string>("");
  const [platformSearch, setPlatformSearch] = useState("");
  const filteredPlatformOptions = useMemo(
    () => PLATFORM_OPTIONS.filter((p) => platformMatchesSearch(p, platformSearch)),
    [platformSearch],
  );
  const [notifLocked, setNotifLocked] = useState(false);
  const [notifShowFrequency, setNotifShowFrequency] = useState<"once" | "always" | "session" | "daily">("once");
  const [notifMode, setNotifMode] = useState<"popup" | "silent" | "banner">("popup");
  const [sendingNotif, setSendingNotif] = useState(false);
  const [editingNotif, setEditingNotif] = useState<any | null>(null);
  const [savingEditNotif, setSavingEditNotif] = useState(false);
  const [recipientsFor, setRecipientsFor] = useState<any | null>(null);


  // R2 storage config
  type R2Cfg = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicBaseUrl: string; pathPrefix: string; enabled: boolean; secretAccessKeySet: boolean };
  const [r2Cfg, setR2Cfg] = useState<R2Cfg>({ accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "", publicBaseUrl: "", pathPrefix: "notifications/", enabled: false, secretAccessKeySet: false });
  const [r2Saving, setR2Saving] = useState(false);
  const [r2Testing, setR2Testing] = useState(false);
  const [r2TestResult, setR2TestResult] = useState<{ ok: boolean; message: string; latencyMs?: number; publicUrlWorks?: boolean; warnings?: string[] } | null>(null);
  const [r2ShowSecret, setR2ShowSecret] = useState(false);
  const [r2Dirty, setR2Dirty] = useState(false);
  const safeR2ForCache = (r2: any | null | undefined) => r2 ? { ...r2, secretAccessKey: "" } : null;
  const lastAdminRefreshRef = useRef(0);
  const updateR2Cfg = useCallback((patch: Partial<R2Cfg>) => {
    setR2Dirty(true);
    setR2Cfg((c) => ({ ...c, ...patch }));
  }, []);

  // Inbox tab
  const [inboxMode, setInboxMode] = useState<"all" | "label" | "days">("days");
  const [inboxLabel, setInboxLabel] = useState("");
  const [inboxDays, setInboxDays] = useState("30");
  const [inboxConfirm, setInboxConfirm] = useState("");
  const [clearingInbox, setClearingInbox] = useState(false);

  const [primaryCfInput, setPrimaryCfInput] = useState("");
  const [signingSecretReveal, setSigningSecretReveal] = useState<{ fingerprint: string; length: number; source: string } | null>(null);
  const [revealingSigningSecret, setRevealingSigningSecret] = useState(false);
  const [editingAccountUrls, setEditingAccountUrls] = useState<number | null>(null);
  const [editCfUrls, setEditCfUrls] = useState<string[]>([]);
  const [editCfInput, setEditCfInput] = useState("");
  const [editingAccountRecipients, setEditingAccountRecipients] = useState<number | null>(null);
  const [editRecipientsInput, setEditRecipientsInput] = useState("");
  const navigate = useNavigate();
  const { user: currentUser, checkAuth } = useAuth();

  const STATS_CACHE_KEY = "admin_stats_cache_v1";
  // Admin settings cache — versioned, refresh-safe. Delete flows do NOT touch
  // this cache (silent refresh branch below skips the write), so removing a
  // user cannot wipe CAPTCHA keys or other admin settings.
  const [stats, setStats] = useState<{ totalUsers: number; totalEmails: number }>(() => {
    // Hydrate instantly from cache so the dashboard never flashes 0.
    try {
      const cached = sessionStorage.getItem(STATS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed.totalUsers === "number" && typeof parsed.totalEmails === "number") return parsed;
      }
    } catch {}
    // Fallback: use bootstrap user count so we at least show a real number.
    try {
      const cached = readBootstrapCache();
      if (cached?.users?.length) return { totalUsers: cached.users.length, totalEmails: 0 };
    } catch {}
    return { totalUsers: 0, totalEmails: 0 };
  });
  useEffect(() => {
    try { sessionStorage.setItem(STATS_CACHE_KEY, JSON.stringify(stats)); } catch {}
  }, [stats]);

  useEffect(() => {
    try { sessionStorage.setItem(ADMIN_ACTIVE_TAB_KEY, activeTab); } catch {}
  }, [activeTab]);

  const availableAccounts = useMemo<string[]>(() => {
    const labels: string[] = [];
    emailAccounts.forEach(acc => {
      if (acc.label && !labels.includes(acc.label)) labels.push(acc.label);
    });
    return labels;
  }, [emailAccounts]);
  const normalizeSelectedAccounts = useCallback((raw: unknown) => normalizeAccountLabels(raw, availableAccounts), [availableAccounts]);

  const parseRecipientFilters = (value: string): string[] => Array.from(new Set(
    value
      .split(/[\s,;]+/)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
  ));

  const loadAdminData = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    const isTransientAdminLoadError = (value: unknown) => /Secure connection|handshake|Failed to fetch|NetworkError|busy|timeout|temporar|unknown session|bad frame|non-binary|stale request|replay|origin mismatch/i.test(
      value instanceof Error ? value.message : String(value || ""),
    );
    // ONE composite server call replaces the 12 individual apiCalls.
    // - Bootstrap: users + emails count + notifications (+counts) + all settings + r2  → 1 HTTP request
    // - Refresh (silent): only the 3 live datasets, no settings → still 1 request
    // This keeps Supabase egress + edge-function invocations minimal so
    // free-tier limits don't get eaten by the admin panel.
    try {
      let res: any;
      try {
        res = await apiCall("manage-app", {
          action: silent ? "admin_dashboard_refresh" : "admin_dashboard_bootstrap",
        });
      } catch (err) {
        if (!silent && isTransientAdminLoadError(err)) {
          await new Promise((r) => setTimeout(r, 700));
          res = await apiCall("manage-app", {
            action: "admin_dashboard_bootstrap",
          });
        } else {
          throw err;
        }
      }
      if (Array.isArray(res?.users)) {
        setUsers(res.users);
        setStats(prev => ({ ...prev, totalUsers: res.users.length }));
      }
      if (typeof res?.emailsTotal === "number") {
        setStats(prev => ({ ...prev, totalEmails: res.emailsTotal }));
      }
      if (Array.isArray(res?.notifications)) setAdminNotifs(res.notifications);
      if (!silent) {
        if (Array.isArray(res?.notifications)) setAdminSlice(AdminSliceKeys.notifications, res.notifications);
        if (Array.isArray(res?.cookies)) setAdminSlice(AdminSliceKeys.cookies, res.cookies);
        if (Array.isArray(res?.loginEvents)) setAdminSlice(`${AdminSliceKeys.loginEvents}:__all__`, res.loginEvents);
        if (res?.vpsAccess) setAdminSlice(AdminSliceKeys.vps, res.vpsAccess);
      }

      if (!silent && res?.settings) {
        const s = res.settings;
        if (s.recaptcha) {
          setSiteKey(s.recaptcha.siteKey || "");
          setSecretKeyVal(s.recaptcha.secretKey || "");
          setCaptchaEnabled(s.recaptcha.enabled === true);
        }
        if (s.email_visibility) {
          setEmailVisibilityEnabled(s.email_visibility.enabled === true);
          if (Number(s.email_visibility.days) > 0) setEmailVisibilityDays(String(s.email_visibility.days));
        }
        if (s.email_auto_delete) {
          setEmailAutoDeleteEnabled(s.email_auto_delete.enabled === true);
          if (Number(s.email_auto_delete.days) > 0) setEmailAutoDeleteDays(String(s.email_auto_delete.days));
          if (Number.isFinite(Number(s.email_auto_delete.hour))) setEmailAutoDeleteHour(String(s.email_auto_delete.hour));
        }
        if (s.netflix_promo) {
          setBlockNetflixPromo(s.netflix_promo.block === true);
        }
        if (s.config) {
          const c = s.config as any;
          setServerConfig({
            TELEGRAM_BOT_TOKEN: c.TELEGRAM_BOT_TOKEN || "",
            TELEGRAM_CHAT_ID: c.TELEGRAM_CHAT_ID || "",
          });
        }
        if (Array.isArray(s.primary_cloudflare_urls)) setPrimaryCfUrls(s.primary_cloudflare_urls);
        if (s.email_filters) {
          setShowSignInCodes(s.email_filters.showSignInCodes !== false);
          setShowPasswordResets(s.email_filters.showPasswordResets === true);
          setShowAccountUpdates(s.email_filters.showAccountUpdates === true);
          setEmailFiltersCache(s.email_filters);
        }
        if (Array.isArray(s.email_accounts)) {
          const migrated = s.email_accounts.map((acc: any) => {
            if (acc.cloudflareUrls && Array.isArray(acc.cloudflareUrls)) return { ...acc, recipientFilters: Array.isArray(acc.recipientFilters) ? acc.recipientFilters : [] };
            const urls: string[] = [];
            if (acc.cloudflareUrl && acc.cloudflareUrl.trim()) urls.push(acc.cloudflareUrl.trim());
            const { cloudflareUrl, ...rest } = acc;
            return { ...rest, cloudflareUrls: urls, recipientFilters: Array.isArray(acc.recipientFilters) ? acc.recipientFilters : [] };
          });
          setEmailAccounts(migrated);
          const labels = migrated
            .map((a: any) => ({ label: String(a.label || a.user || "").trim(), user: String(a.user || "").trim() }))
            .filter((a: any) => a.label);
          setAdminSlice(AdminSliceKeys.emailAccounts, { labels });
        }
        const m1 = Number(s.session_config?.timeoutMinutes);
        if (Number.isFinite(m1) && m1 >= 0) { setSessionTimeoutMin(String(m1)); if (m1 > 0) writeCachedTimeoutMinutes("user", m1); }
        const m2 = Number(s.admin_session_config?.timeoutMinutes);
        if (Number.isFinite(m2) && m2 >= 0) { setAdminSessionTimeoutMin(String(m2)); if (m2 > 0) writeCachedTimeoutMinutes("admin", m2); }

        const cs = Number(s.session_limits?.maxPerUser);
        if (Number.isFinite(cs) && cs >= 0) setConcurrentSessionLimit(String(cs));
        setIpwhoAlertEnabled(s.ipwho_alert?.enabled === true);
        setLocationPolicyRequired(s.location_policy?.required !== false);
        setTvFeatureEnabled(s.tv_feature?.enabled !== false);
        const fac = Number(s.free_avatar_cooldown?.minutes);
        if (Number.isFinite(fac) && fac > 0) setFreeAvatarCooldownMinState(String(Math.floor(fac)));

        if (s.maintenance) {
          const mnt = s.maintenance;
          setMaintenanceEnabled(mnt.enabled === true);
          setMaintenanceTitle(mnt.title || "");
          setMaintenanceMessage(mnt.message || "");
          setMaintenanceVersionFrom(mnt.versionFrom || "");
          setMaintenanceVersionTo(mnt.versionTo || "");
          prevSavedVersionToRef.current = mnt.versionTo || "";
          const toLocalInput = (iso: string) => {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return "";
            const pad = (n: number) => String(n).padStart(2, "0");
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          };
          if (mnt.startsAt) setMaintenanceStartsAt(toLocalInput(mnt.startsAt));
          if (mnt.endsAt) setMaintenanceEndsAt(toLocalInput(mnt.endsAt));
        }
        if (res.r2) {
          setR2Cfg((current) => r2Dirty ? current : ({
            accountId: res.r2.accountId || "",
            accessKeyId: res.r2.accessKeyId || "",
            secretAccessKey: "",
            bucket: res.r2.bucket || "",
            publicBaseUrl: res.r2.publicBaseUrl || "",
            pathPrefix: res.r2.pathPrefix || "notifications/",
            enabled: res.r2.enabled === true,
            secretAccessKeySet: res.r2.secretAccessKeySet === true,
          }));
        }
        // Cache settings + r2 so a page refresh shows the saved values
        // instantly instead of flashing empty inputs while the server load runs.
        try {
          const serverVersion = Number(res.settings?.settings_version) || Date.now();
          const prev = readAdminCache();
          reconcileVersion(prev?.version ?? 0, serverVersion);
          writeAdminCache({ version: serverVersion, settings: res.settings, r2: safeR2ForCache(res.r2) });
          emitSyncStatus({ kind: "saved" });
        } catch (e) {
          emitSyncStatus({ kind: "error", message: "Cache write failed" });
        }
      }
    } catch (err) {
      if (!silent) {
        console.warn("[admin] dashboard load failed:", err);
        emitSyncStatus({ kind: "error", message: err instanceof Error ? err.message : "Server sync failed" });
      }
    }
  }, [r2Dirty]);

  // Hydrate settings state instantly from cache on mount so a refresh doesn't
  // flash empty CAPTCHA/site-key/etc. fields before the server round-trip.
  useEffect(() => {
    try {
      emitSyncStatus({ kind: "loading-local" });
      const parsed = readAdminCache();
      if (!parsed) { emitSyncStatus({ kind: "syncing-server" }); return; }
      const s = parsed.settings;
      if (!s) { emitSyncStatus({ kind: "syncing-server" }); return; }
      if (!isCacheFresh(parsed)) emitSyncStatus({ kind: "stale-refetching" });
      else emitSyncStatus({ kind: "syncing-server" });
      if (s.recaptcha) {
        setSiteKey(s.recaptcha.siteKey || "");
        setSecretKeyVal(s.recaptcha.secretKey || "");
        setCaptchaEnabled(s.recaptcha.enabled === true);
      }
      if (s.email_visibility) {
        setEmailVisibilityEnabled(s.email_visibility.enabled === true);
        if (Number(s.email_visibility.days) > 0) setEmailVisibilityDays(String(s.email_visibility.days));
      }
      if (s.email_auto_delete) {
        setEmailAutoDeleteEnabled(s.email_auto_delete.enabled === true);
        if (Number(s.email_auto_delete.days) > 0) setEmailAutoDeleteDays(String(s.email_auto_delete.days));
        if (Number.isFinite(Number(s.email_auto_delete.hour))) setEmailAutoDeleteHour(String(s.email_auto_delete.hour));
      }
      if (s.netflix_promo) setBlockNetflixPromo(s.netflix_promo.block === true);
      if (s.config) {
        const c = s.config as any;
        setServerConfig({
          TELEGRAM_BOT_TOKEN: c.TELEGRAM_BOT_TOKEN || "",
          TELEGRAM_CHAT_ID: c.TELEGRAM_CHAT_ID || "",
        });
      }
      if (Array.isArray(s.primary_cloudflare_urls)) setPrimaryCfUrls(s.primary_cloudflare_urls);
      if (s.email_filters) {
        setShowSignInCodes(s.email_filters.showSignInCodes !== false);
        setShowPasswordResets(s.email_filters.showPasswordResets === true);
        setShowAccountUpdates(s.email_filters.showAccountUpdates === true);
      }
      if (Array.isArray(s.email_accounts)) {
        const migrated = s.email_accounts.map((acc: any) => {
          if (acc.cloudflareUrls && Array.isArray(acc.cloudflareUrls)) return { ...acc, recipientFilters: Array.isArray(acc.recipientFilters) ? acc.recipientFilters : [] };
          const urls: string[] = [];
          if (acc.cloudflareUrl && acc.cloudflareUrl.trim()) urls.push(acc.cloudflareUrl.trim());
          const { cloudflareUrl, ...rest } = acc;
          return { ...rest, cloudflareUrls: urls, recipientFilters: Array.isArray(acc.recipientFilters) ? acc.recipientFilters : [] };
        });
        setEmailAccounts(migrated);
      }
      const m1 = Number(s.session_config?.timeoutMinutes);
      if (Number.isFinite(m1) && m1 >= 0) setSessionTimeoutMin(String(m1));
      const m2 = Number(s.admin_session_config?.timeoutMinutes);
      if (Number.isFinite(m2) && m2 >= 0) setAdminSessionTimeoutMin(String(m2));
      const cs = Number(s.session_limits?.maxPerUser);
      if (Number.isFinite(cs) && cs >= 0) setConcurrentSessionLimit(String(cs));
      setIpwhoAlertEnabled(s.ipwho_alert?.enabled === true);
      setLocationPolicyRequired(s.location_policy?.required !== false);
      setTvFeatureEnabled(s.tv_feature?.enabled !== false);
      const fac = Number(s.free_avatar_cooldown?.minutes);
      if (Number.isFinite(fac) && fac > 0) setFreeAvatarCooldownMinState(String(Math.floor(fac)));
      if (s.maintenance) {
        const mnt = s.maintenance;
        setMaintenanceEnabled(mnt.enabled === true);
        setMaintenanceTitle(mnt.title || "");
        setMaintenanceMessage(mnt.message || "");
        setMaintenanceVersionFrom(mnt.versionFrom || "");
        setMaintenanceVersionTo(mnt.versionTo || "");
        prevSavedVersionToRef.current = mnt.versionTo || "";
      }
      const r2 = parsed?.r2;
      if (r2) {
        setR2Cfg({
          accountId: r2.accountId || "",
          accessKeyId: r2.accessKeyId || "",
          secretAccessKey: "",
          bucket: r2.bucket || "",
          publicBaseUrl: r2.publicBaseUrl || "",
          pathPrefix: r2.pathPrefix || "notifications/",
          enabled: r2.enabled === true,
          secretAccessKeySet: r2.secretAccessKeySet === true,
        });
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Initial full load
    void loadAdminData();

    // Refresh live data on tab focus only. NO polling — polling would burn
    // through Supabase egress + edge-function invocations on the free tier.
    // Admin still gets fresh data whenever they come back to the tab, and
    // can pull the manual "Refresh" button for on-demand updates.
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAdminRefreshRef.current < 5 * 60_000) return;
      lastAdminRefreshRef.current = now;
      void loadAdminData({ silent: true });
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [loadAdminData]);



  const saveSessionTimeout = async () => {
    const m = Math.max(0, Math.floor(Number(sessionTimeoutMin) || 0));
    setSavingSessionTimeout(true);
    try {
      await apiCall("manage-app", {
        action: "set_settings",
        key: "session_config",
        value: { timeoutMinutes: m },
      });
      setSessionTimeoutMin(String(m));
      notify.success(m === 0 ? "Session timeout disabled" : `Session timeout set to ${m} min`);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save session timeout");
    } finally {
      setSavingSessionTimeout(false);
    }
  };
  const saveAdminSessionTimeout = async () => {
    const m = Math.max(0, Math.floor(Number(adminSessionTimeoutMin) || 0));
    setSavingAdminSessionTimeout(true);
    try {
      await apiCall("manage-app", {
        action: "set_settings",
        key: "admin_session_config",
        value: { timeoutMinutes: m },
      });
      setAdminSessionTimeoutMin(String(m));
      notify.success(m === 0 ? "Admin session timeout disabled" : `Admin auto-logout set to ${m} min`);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save admin session timeout");
    } finally {
      setSavingAdminSessionTimeout(false);
    }
  };

  const saveConcurrentSessionLimit = async () => {
    const n = Math.max(0, Math.floor(Number(concurrentSessionLimit) || 0));
    setSavingConcurrentSessionLimit(true);
    try {
      await apiCall("manage-app", {
        action: "set_settings",
        key: "session_limits",
        value: { maxPerUser: n },
      });
      setConcurrentSessionLimit(String(n));
      notify.success(n === 0 ? "Concurrent session limit disabled" : `Max ${n} active session${n === 1 ? "" : "s"} per user`);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save session limit");
    } finally {
      setSavingConcurrentSessionLimit(false);
    }
  };

  const saveFreeAvatarCooldown = async () => {
    const m = Math.max(1, Math.floor(Number(freeAvatarCooldownMin) || 1));
    setSavingFreeAvatarCooldown(true);
    try {
      await apiCall("manage-app", {
        action: "set_settings",
        key: "free_avatar_cooldown",
        value: { minutes: m },
      });
      setFreeAvatarCooldownMinState(String(m));
      setFreeAvatarCooldown({ ...getFreeAvatarCooldown(), minutes: m });
      notify.success(`Free avatar cooldown set to ${m} min`);
      refreshBootstrap().catch(() => {});
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save cooldown");
    } finally {
      setSavingFreeAvatarCooldown(false);
    }
  };





  const saveMaintenance = async (nextEnabled?: boolean) => {
    const enabled = typeof nextEnabled === "boolean" ? nextEnabled : maintenanceEnabled;

    // Version auto-bump: baseline 2.4.4. Each save bumps patch +1 from the previously saved
    // versionTo unless the admin manually typed a different (higher) version.
    const bumpPatch = (v: string) => {
      const parts = String(v || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
      while (parts.length < 3) parts.push(0);
      parts[2] = (Number.isFinite(parts[2]) ? parts[2] : 0) + 1;
      return parts.map((n) => (Number.isFinite(n) ? n : 0)).join(".");
    };
    const prevTo = prevSavedVersionToRef.current || "2.4.3";
    let nextVersionTo = maintenanceVersionTo.trim();
    let autoBumped = false;
    if (!nextVersionTo || nextVersionTo === prevTo) {
      nextVersionTo = bumpPatch(prevTo);
      autoBumped = true;
    }
    const nextVersionFrom = prevTo;

    setSavingMaintenance(true);
    try {
      await apiCall("manage-app", {
        action: "set_settings",
        key: "maintenance",
        value: {
          enabled,
          title: maintenanceTitle.trim(),
          message: maintenanceMessage.trim(),
          startsAt: null,
          endsAt: maintenanceEndsAt ? new Date(maintenanceEndsAt).toISOString() : null,
          versionFrom: nextVersionFrom,
          versionTo: nextVersionTo,
          updated_at: new Date().toISOString(),
        },
      });
      setMaintenanceEnabled(enabled);
      setMaintenanceVersionFrom(nextVersionFrom);
      setMaintenanceVersionTo(nextVersionTo);
      setMaintenanceStartsAt("");
      prevSavedVersionToRef.current = nextVersionTo;
      try { await refreshBootstrap(); } catch {}
      window.dispatchEvent(new Event("maintenance:changed"));
      if (autoBumped) notify.success(`Saved · version auto-bumped to v${nextVersionTo}`);
      else notify.success(enabled ? `Maintenance ON · v${nextVersionTo}` : `Maintenance OFF · v${nextVersionTo}`);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save maintenance settings");
    } finally {
      setSavingMaintenance(false);
    }
  };


  const saveR2Config = async () => {
    setR2Saving(true);
    setR2TestResult(null);
    try {
      const res: any = await apiCall("manage-app", {
        action: "admin_save_r2_config",
        accountId: r2Cfg.accountId.trim(),
        accessKeyId: r2Cfg.accessKeyId.trim(),
        secretAccessKey: r2Cfg.secretAccessKey, // blank string = keep existing
        bucket: r2Cfg.bucket.trim(),
        publicBaseUrl: r2Cfg.publicBaseUrl.trim(),
        pathPrefix: (r2Cfg.pathPrefix.trim() || "notifications/"),
        enabled: r2Cfg.enabled,
      });
      if (res?.config) {
        setR2Cfg((c) => ({
          ...c,
          accountId: res.config.accountId ?? c.accountId,
          accessKeyId: res.config.accessKeyId ?? c.accessKeyId,
          secretAccessKey: "",
          bucket: res.config.bucket ?? c.bucket,
          publicBaseUrl: res.config.publicBaseUrl ?? c.publicBaseUrl,
          pathPrefix: res.config.pathPrefix ?? c.pathPrefix,
          enabled: res.config.enabled ?? c.enabled,
          secretAccessKeySet: res.config.secretAccessKeySet ?? c.secretAccessKeySet,
        }));
      }
      const persisted = r2Cfg.secretAccessKey.length > 0 || r2Cfg.secretAccessKeySet;
      setR2Cfg((c) => ({ ...c, secretAccessKeySet: persisted }));
      setR2Dirty(false);
      const note = Array.isArray(res?.warnings) && res.warnings.length ? ` (${res.warnings[0]})` : "";
      notify.success(`${r2Cfg.enabled ? "R2 storage saved & enabled" : "R2 storage saved"}${note}`);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save R2 config");
    } finally {
      setR2Saving(false);
    }
  };

  const testR2Connection = async () => {
    setR2Testing(true);
    setR2TestResult(null);
    try {
      const res: any = await apiCall("manage-app", {
        action: "admin_r2_test",
        accountId: r2Cfg.accountId.trim(),
        accessKeyId: r2Cfg.accessKeyId.trim(),
        secretAccessKey: r2Cfg.secretAccessKey,
        bucket: r2Cfg.bucket.trim(),
        publicBaseUrl: r2Cfg.publicBaseUrl.trim(),
        pathPrefix: (r2Cfg.pathPrefix.trim() || "notifications/"),
        enabled: r2Cfg.enabled,
      });
      setR2TestResult({
        ok: res?.success === true,
        message: res?.message || (res?.success ? "OK" : "Failed"),
        latencyMs: res?.latencyMs,
        publicUrlWorks: res?.publicUrlWorks,
        warnings: Array.isArray(res?.warnings) ? res.warnings : undefined,
      });
      if (res?.success) notify.success(`Typed R2 values valid · ${res.latencyMs}ms`);
      else notify.error(res?.message || "R2 test failed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "R2 test failed";
      setR2TestResult({ ok: false, message: msg });
      notify.error(msg);
    } finally {
      setR2Testing(false);
    }
  };


  const toggleCaptcha = async () => {
    const prevEnabled = captchaEnabled;
    const newEnabled = !prevEnabled;
    if (newEnabled && (!siteKey || !secretKeyVal)) { notify.error("Enter both Site Key and Secret Key first"); return; }
    // Optimistic flip — no second round-trip. Rollback on failure.
    setCaptchaEnabled(newEnabled);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "recaptcha", value: { siteKey, secretKey: secretKeyVal, enabled: newEnabled } });
      notify.success(newEnabled ? "CAPTCHA enabled!" : "CAPTCHA disabled!");
    } catch (err) {
      setCaptchaEnabled(prevEnabled);
      notify.error(err instanceof Error ? err.message : "Failed to toggle CAPTCHA");
    }
  };

  const saveRecaptchaSettings = async () => {
    const prevEnabled = captchaEnabled;
    const newEnabled = !!(siteKey && secretKeyVal);
    setCaptchaEnabled(newEnabled);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "recaptcha", value: { siteKey, secretKey: secretKeyVal, enabled: newEnabled } });
      notify.success("ReCAPTCHA settings saved!");
    } catch (err) {
      setCaptchaEnabled(prevEnabled);
      notify.error(err instanceof Error ? err.message : "Failed to save settings");
    }
  };

  const saveEmailVisibility = async (nextEnabled?: boolean) => {
    setSavingEmailVisibility(true);
    try {
      const enabled = typeof nextEnabled === "boolean" ? nextEnabled : emailVisibilityEnabled;
      const days = Math.max(1, Math.min(365, parseInt(emailVisibilityDays) || 30));
      await apiCall("manage-app", { action: "email_visibility_set", enabled, days });
      setEmailVisibilityEnabled(enabled);
      setEmailVisibilityDays(String(days));
      notify.success(enabled ? `Users will see last ${days} days of emails` : "Users can see all emails");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingEmailVisibility(false);
    }
  };

  const saveEmailAutoDelete = async (nextEnabled?: boolean) => {
    setSavingEmailAutoDelete(true);
    try {
      const enabled = typeof nextEnabled === "boolean" ? nextEnabled : emailAutoDeleteEnabled;
      const days = Math.max(1, Math.min(365, parseInt(emailAutoDeleteDays) || 30));
      const hour = Math.max(0, Math.min(23, parseInt(emailAutoDeleteHour) || 3));
      await apiCall("manage-app", { action: "email_cleanup_apply", enabled, days, hour });
      setEmailAutoDeleteEnabled(enabled);
      setEmailAutoDeleteDays(String(days));
      setEmailAutoDeleteHour(String(hour));
      notify.success(enabled ? `Auto-delete: emails older than ${days} days will be removed daily at ${hour}:00` : "Auto-delete turned off");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingEmailAutoDelete(false);
    }
  };

  const saveBlockNetflixPromo = async (nextBlock: boolean) => {
    setSavingBlockPromo(true);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "netflix_promo", value: { block: nextBlock } });
      setBlockNetflixPromo(nextBlock);
      notify.success(nextBlock ? "Netflix marketing/promo emails are now hidden from users" : "Netflix marketing/promo emails are visible to users");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingBlockPromo(false);
    }
  };

  const persistEmailFilters = async (next: { showSignInCodes: boolean; showPasswordResets: boolean; showAccountUpdates: boolean }) => {
    await apiCall("manage-app", { action: "set_settings", key: "email_filters", value: next });
    setEmailFiltersCache(next);
  };

  const toggleSignInCodeFilter = async () => {
    const newVal = !showSignInCodes;
    setShowSignInCodes(newVal);
    try {
      await persistEmailFilters({ showSignInCodes: newVal, showPasswordResets, showAccountUpdates });
      notify.success(newVal ? "Sign-in code emails will be shown" : "Sign-in code emails will be hidden");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save filter setting");
      setShowSignInCodes(!newVal);
    }
  };

  const togglePasswordResetFilter = async () => {
    const newVal = !showPasswordResets;
    setShowPasswordResets(newVal);
    try {
      await persistEmailFilters({ showSignInCodes, showPasswordResets: newVal, showAccountUpdates });
      notify.success(newVal ? "Password reset emails will be shown" : "Password reset emails will be hidden");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save filter setting");
      setShowPasswordResets(!newVal);
    }
  };

  const toggleAccountUpdateFilter = async () => {
    const newVal = !showAccountUpdates;
    setShowAccountUpdates(newVal);
    try {
      await persistEmailFilters({ showSignInCodes, showPasswordResets, showAccountUpdates: newVal });
      notify.success(newVal ? "Account update emails will be shown" : "Account update emails will be hidden");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save filter setting");
      setShowAccountUpdates(!newVal);
    }
  };

  const saveServerConfig = async () => {
    setSavingConfig(true);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "config", value: serverConfig });
      await apiCall("manage-app", { action: "set_settings", key: "primary_cloudflare_urls", value: primaryCfUrls });
      // No browser-persistent worker URL cache; viewer reloads server settings.
      storeWorkerUrls(primaryCfUrls);
      notify.success("Server configuration saved!");
    } catch (err) {
      notify.error("Failed to save: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSavingConfig(false);
    }
  };

  const revealSigningSecret = async () => {
    setRevealingSigningSecret(true);
    try {
      // Direct Supabase call on purpose: this secret is needed to configure Cloudflare,
      // so revealing it must not depend on an already-working Worker.
      const token = getSessionToken();
      const { invokeEdge } = await import("./lib/secureTransport");
      const res: any = await invokeEdge(
        "manage-app",
        { action: "admin_reveal_session_signing_secret" },
        { headers: token ? { "X-Session-Token": token } : {} },
      );
      if (!res?.success) throw new Error(res?.error || "Could not inspect SESSION_SIGNING_SECRET");
      setSigningSecretReveal({
        fingerprint: String(res.fingerprint || ""),
        length: Number(res.length) || 0,
        source: String(res.source || ""),
      });
      notify.success("Signing secret verified. Copy the raw value from Supabase Dashboard → Edge Function Secrets.");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Could not inspect SESSION_SIGNING_SECRET");
    } finally {
      setRevealingSigningSecret(false);
    }
  };

  const copySigningSecret = async () => {
    if (!signingSecretReveal?.fingerprint) return;
    try {
      await navigator.clipboard.writeText(signingSecretReveal.fingerprint);
      notify.success("Fingerprint copied (not the raw secret)");
    } catch {
      notify.error("Copy failed — long press/select manually.");
    }
  };

  const toggleIpwhoAlert = async () => {
    const next = !ipwhoAlertEnabled;
    setIpwhoAlertEnabled(next);
    setSavingIpwho(true);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "ipwho_alert", value: { enabled: next } });
      notify.success(next ? "Legacy ipwho.is alert enabled" : "Legacy ipwho.is alert disabled");
    } catch (err) {
      setIpwhoAlertEnabled(!next);
      notify.error(err instanceof Error ? err.message : "Failed");
    } finally { setSavingIpwho(false); }
  };

  const toggleLocationPolicy = async () => {
    const next = !locationPolicyRequired;
    setLocationPolicyRequired(next);
    setSavingLocationPolicy(true);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "location_policy", value: { required: next } });
      notify.success(next ? "GPS required for paid profiles" : "GPS disabled for user profiles");
      await refreshBootstrap().catch(() => null);
    } catch (err) {
      setLocationPolicyRequired(!next);
      notify.error(err instanceof Error ? err.message : "Failed");
    } finally { setSavingLocationPolicy(false); }
  };

  const toggleTvFeature = async () => {
    const next = !tvFeatureEnabled;
    const prevOverrides = users.map(u => ({ id: u.id, tvOverride: u.tvOverride ?? null }));
    setTvFeatureEnabled(next);
    // Optimistically clear all per-user overrides — global switch is TOP priority.
    setUsers(prev => prev.map(x => ({ ...x, tvOverride: null })));
    setSavingTvFeature(true);
    try {
      await apiCall("manage-app", { action: "set_tv_feature", enabled: next });
      broadcastTvFeatureEvent({ type: "tv-global", enabled: next, at: Date.now() });
      // Broadcast a per-profile inherit so any open user tabs drop their local override too.
      prevOverrides.forEach(({ id, tvOverride }) => {
        if (tvOverride !== null) {
          applyTvOverrideToStoredUser(id, null);
          patchBootstrapCacheUser(id, { tvOverride: null });
          broadcastTvFeatureEvent({ type: "tv-profile", userId: id, tvOverride: null, at: Date.now() });
        }
      });
      notify.success(next ? "TV shown for everyone (overrides reset)" : "TV hidden for everyone (overrides reset)");
      // Ground-truth: re-fetch admin users so any stale override rows are corrected.
      void loadAdminData({ silent: true });
      await refreshBootstrap().catch(() => null);
    } catch (err) {
      setTvFeatureEnabled(!next);
      setUsers(prev => prev.map(x => {
        const p = prevOverrides.find(o => o.id === x.id);
        return p ? { ...x, tvOverride: p.tvOverride } : x;
      }));
      notify.error(err instanceof Error ? err.message : "Failed");
    } finally { setSavingTvFeature(false); }
  };


  const setProfileTvOverride = async (u: UserData, value: TvOverrideValue) => {
    const next: "on" | "off" | null = normalizeTvOverride(value);
    const previous = normalizeTvOverride(u.tvOverride);
    try {
      await apiCall("manage-app", { action: "update_user", id: u.id, tv_override: tvOverridePayload(next) });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, tvOverride: next } : x));
      applyTvOverrideToStoredUser(u.id, next);
      patchBootstrapCacheUser(u.id, { tvOverride: next });
      broadcastTvFeatureEvent({ type: "tv-profile", userId: u.id, tvOverride: next, at: Date.now() });
      notify.success(next === null ? `${u.name}: TV follows global setting` : next === "on" ? `${u.name}: TV forced ON` : `${u.name}: TV forced OFF`);
      refreshBootstrap().catch(() => null);
    } catch (err) {
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, tvOverride: previous } : x));
      notify.error(err instanceof Error ? err.message : "Failed to update TV override");
    }
  };

  const toggleProfileTvOverride = async (u: UserData) => {
    // 3-state cycle: inherit (null) -> on -> off -> inherit
    const current: "on" | "off" | null = normalizeTvOverride(u.tvOverride);
    const next: TvOverrideValue = current === null ? "on" : current === "on" ? "off" : "inherit";
    await setProfileTvOverride(u, next);
  };

  const toggleUserFeature = async (u: UserData, key: "gmail" | "tv" | "link") => {
    const cur = adminUserFeatures(u);
    const nextVal = key === "link" ? !(cur[key] === true) : !(cur[key] !== false);
    const nextFeatures = { ...cur, [key]: nextVal };
    const flatKey = key === "gmail" ? "feature_gmail" : key === "tv" ? "feature_tv" : "feature_link";
    setUsers((prev) => prev.map((x) => x.id === u.id ? ({ ...x, features: nextFeatures, [flatKey]: nextVal } as any) : x));
    try {
      const res: any = await apiCall("manage-app", { action: "update_user", id: u.id, features: { [key]: nextVal } });
      const persistedFeatures = res?.user?.features || nextFeatures;
      const persistedPatch = {
        features: persistedFeatures,
        feature_gmail: persistedFeatures.gmail !== false,
        feature_tv: persistedFeatures.tv !== false,
        feature_link: persistedFeatures.link === true,
      };
      setUsers((prev) => prev.map((x) => x.id === u.id ? ({ ...x, ...persistedPatch } as any) : x));
      patchBootstrapCacheUser(u.id, persistedPatch);
      try { await refreshBootstrap(); } catch {}
      notify.success(`${key === "gmail" ? "Gmail" : key === "tv" ? "TV" : "Direct Link"} ${nextVal ? "enabled" : "disabled"}`);
    } catch (err) {
      setUsers((prev) => prev.map((x) => x.id === u.id ? ({ ...x, features: cur, [flatKey]: (u as any)[flatKey] } as any) : x));
      patchBootstrapCacheUser(u.id, { features: cur, [flatKey]: (u as any)[flatKey] });
      notify.error(err instanceof Error ? err.message : "Failed to update feature");
    }
  };


  // Hydrate notifications from SWR cache on mount (instant paint after prefetch).
  const notifFetcher = React.useCallback(async () => {
    const nl: any = await apiCall("manage-app", { action: "admin_list_notifications" });
    return Array.isArray(nl?.notifications) ? nl.notifications : [];
  }, []);
  const { data: cachedNotifs, refresh: refreshAdminNotifs } = useAdminSlice<any[]>(AdminSliceKeys.notifications, notifFetcher, { enabled: activeTab === "notifications" && adminNotifs.length === 0 });
  const reloadAdminNotifs = React.useCallback(async () => {
    try {
      const list = await refreshAdminNotifs(true);
      setAdminNotifs(Array.isArray(list) ? list : []);
    } catch (err) { console.warn(err); }
  }, [refreshAdminNotifs]);
  React.useEffect(() => {
    if (Array.isArray(cachedNotifs) && cachedNotifs.length) setAdminNotifs(cachedNotifs);
  }, [cachedNotifs]);


  const sendNotification = async () => {
    if (!notifTitle.trim() || !notifBody.trim()) { notify.error("Title and body required"); return; }
    if (notifAudience === "user" && !notifTargetUser) { notify.error("Choose a target user"); return; }
    if (notifImageUrl.trim() && !/^https:\/\//i.test(notifImageUrl.trim())) { notify.error("Image URL must start with https://"); return; }
    if (notifActionUrl.trim() && !/^https?:\/\//i.test(notifActionUrl.trim())) { notify.error("Action URL must be a valid link"); return; }
    setSendingNotif(true);
    try {
      await apiCall("manage-app", {
        action: "admin_create_notification",
        title: notifTitle.trim(),
        body: notifBody.trim(),
        description: notifDescription.trim() || null,
        image_url: notifImageUrl.trim() || null,
        category: notifCategory,
        priority: notifPriority,
        kind: "flash",
        mode: notifMode,
        show_frequency: notifShowFrequency,
        platform_icon: resolvePlatformOption(notifPlatformIcon).id || null,
        sub_kind: notifTemplate || null,
        locked: notifLocked,
        action_url: notifActionUrl.trim() || null,
        action_label: notifActionLabel.trim() || null,
        audience: notifAudience,
        target_user_id: notifAudience === "user" ? notifTargetUser : null,
        expiresInDays: notifExpiresDays ? Number(notifExpiresDays) : null,
      });
      notify.info("Notification sent", { description: "Delivered to targeted users", duration: 2400 });
      setNotifTitle(""); setNotifBody(""); setNotifDescription(""); setNotifImageUrl("");
      setNotifActionUrl(""); setNotifActionLabel("");
      setNotifExpiresDays(""); setNotifPlatformIcon(""); setNotifTemplate("");
      setNotifLocked(false);
      await reloadAdminNotifs();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to send");
    } finally { setSendingNotif(false); }
  };


  const deleteNotification = async (id: string) => {
    if (!confirm("Delete this notification for everyone?")) return;
    try {
      await apiCall("manage-app", { action: "admin_delete_notification", id });
      setAdminNotifs((prev) => prev.filter((n) => n.id !== id));
      notify.success("Deleted");
    } catch (err) { notify.error(err instanceof Error ? err.message : "Failed"); }
  };

  const saveEditNotif = async () => {
    if (!editingNotif) return;
    const e = editingNotif;
    if (!e.title?.trim() || !e.body?.trim()) { notify.error("Title and message required"); return; }
    setSavingEditNotif(true);
    try {
      await apiCall("manage-app", {
        action: "admin_update_notification",
        id: e.id,
        title: e.title.trim(),
        body: e.body.trim(),
        action_url: e.action_url?.trim() || null,
        platform_icon: resolvePlatformOption(e.platform_icon).id || null,
        locked: !!e.locked,
        priority: e.priority || "normal",
        audience: e.audience || "all",
        target_user_id: e.audience === "user" ? (e.target_user_id || null) : null,
      });
      notify.success("Updated");
      setEditingNotif(null);
      await reloadAdminNotifs();
    } catch (err) { notify.error(err instanceof Error ? err.message : "Failed"); }
    finally { setSavingEditNotif(false); }
  };

  const duplicateToComposer = (n: any) => {
    setNotifTitle(n.title || "");
    setNotifBody(n.body || "");
    setNotifDescription(n.description || "");
    setNotifImageUrl(n.image_url || "");
    setNotifActionUrl(n.action_url || "");
    setNotifActionLabel(n.action_label || "");
    setNotifPlatformIcon(resolvePlatformOption(n.platform_icon).id || "");
    setNotifLocked(!!n.locked);
    setNotifCategory(n.category || "announcement");
    setNotifPriority(n.priority || "normal");
    setNotifAudience(n.audience || "all");
    setNotifTargetUser(n.target_user_id || "");
    setNotifShowFrequency(n.show_frequency || "once");
    setNotifMode(n.mode || "popup");
    notify.success("Copied to composer — edit and publish as new");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };




  const adminClearInbox = async () => {
    if (inboxMode === "all" && inboxConfirm !== "DELETE ALL") {
      notify.error('Type DELETE ALL to confirm');
      return;
    }
    if (inboxMode === "label" && !inboxLabel) { notify.error("Choose an account label"); return; }
    if (inboxMode === "days" && !inboxDays) { notify.error("Enter days"); return; }
    if (!confirm("This suppresses matching emails for every user forever. Future syncs will not bring them back. Continue?")) return;
    setClearingInbox(true);
    try {
      await apiCall("manage-app", {
        action: "admin_clear_inbox",
        mode: inboxMode,
        accountLabel: inboxMode === "label" ? inboxLabel : undefined,
        days: inboxMode === "days" ? Number(inboxDays) : undefined,
        confirm: inboxMode === "all" ? inboxConfirm : undefined,
      });
      notify.success("Matching emails suppressed");
      setInboxConfirm("");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed");
    } finally { setClearingInbox(false); }
  };

  const changeAdminPassword = async () => {
    if (!currentPassword || !newAdminPassword) { notify.error("Fill both fields"); return; }
    setChangingPassword(true);
    try {
      await apiCall("manage-app", {
        action: "change_password", id: currentUser?.id, current_password: currentPassword, new_password: newAdminPassword,
      });
      setCurrentPassword(""); setNewAdminPassword("");
      notify.success("Password changed successfully!");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setChangingPassword(false);
    }
  };

  const changeUserPassword = async (userId: string) => {
    if (!userNewPass || userNewPass.length < 6) { notify.error("Password must be at least 6 characters"); return; }
    try {
      await apiCall("manage-app", { action: "change_password", id: userId, new_password: userNewPass });
      setUserNewPass(""); setChangingUserPass(null);
      notify.success("User password changed!");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to change password");
    }
  };

  const loginAsUser = async (targetUser: UserData, startWorkflow?: "gmail" | "tv" | "link") => {
    try {
      notify.loading(`Opening ${targetUser.name}${startWorkflow === "link" ? "'s Direct Link page" : "'s inbox"}…`, { id: "impersonate" });
      const data = await apiCall("manage-app", { action: "impersonate", target_user_id: targetUser.id });
      notify.dismiss("impersonate");

      // Write the impersonated user session BEFORE /viewer mounts so EmailViewer
      // opens the correct per-user IndexedDB and delta-syncs that user's account.
      // The return-to-admin path is server-side through the parent admin session
      // row, not a client-side admin token backup.
      const impersonatedUser = { ...(data.user || {}), impersonated: true, adminId: data.user?.adminId || null };
      sessionSet("user" as any, JSON.stringify(impersonatedUser));
      if (data.sessionToken) sessionSet("session_token" as any, data.sessionToken);
      if (startWorkflow) requestWorkflowView(startWorkflow);
      sessionRemove("admin_auth" as any);
      checkAuth();
      navigate("/admin/viewer", { replace: true });
      window.setTimeout(() => {
        if (window.location.pathname !== "/admin/viewer") window.location.replace("/admin/viewer");
      }, 80);
      notify.success(`Viewing as ${targetUser.name}`);
    } catch (err) {
      notify.dismiss("impersonate");
      notify.error(err instanceof Error ? err.message : "Failed to impersonate user");
    }
  };



  const createUser = async () => {
    const displayName = newName.trim();
    const username = newUsername.trim();
    const password = newPassword.trim();
    if (!displayName) { notify.error("Display name required"); return; }
    if (!newIsFree && (!username || !password)) { notify.error("Please fill all fields"); return; }
    if (creatingUser) return;
    setCreatingUser(true);
    const timeout = window.setTimeout(() => {
      notify.error("Create request is taking too long. Please retry.");
      setCreatingUser(false);
    }, 25_000);
    try {
      let expiresIso: string | null = null;
      if (newIsFree && newFreeExpiresAt) {
        const t = Date.parse(newFreeExpiresAt);
        if (!Number.isFinite(t)) { notify.error("Invalid expiry date"); setCreatingUser(false); return; }
        if (t <= Date.now()) { notify.error("Expiry must be in the future"); setCreatingUser(false); return; }
        expiresIso = new Date(t).toISOString();
      }
      // Free profile: passwordless one-tap entry. Username is optional/manual only
      // (never generated); password is never sent for free profiles.
      if (!newIsFree && newPlanStartsAt && !newPlanEndsAt) {
        notify.error("Plan end date required", { description: "Add an end date or use the duration box so the Plan pill can count down." });
        return;
      }
      const tvOv: "on" | "off" | null = newTvOverride === "on" || newTvOverride === "off" ? newTvOverride : null;
      const body: any = newIsFree
        ? {
            action: "create",
            username: username || undefined,
            name: displayName,
            role: "user",
            is_free: true,
            assigned_accounts: normalizeSelectedAccounts(newUserAccounts).length > 0 ? normalizeSelectedAccounts(newUserAccounts) : null,
            expires_at: expiresIso,
            tv_override: tvOv,
          }
        : {
            action: "create",
            username,
            password,
            name: displayName,
            role: "user",
            assigned_accounts: normalizeSelectedAccounts(newUserAccounts).length > 0 ? normalizeSelectedAccounts(newUserAccounts) : null,
            is_free: false,
            tv_override: tvOv,
            plan_starts_at: newPlanStartsAt ? new Date(newPlanStartsAt).toISOString() : null,
            plan_ends_at: newPlanEndsAt ? new Date(newPlanEndsAt).toISOString() : null,
          };
      // Clear the form immediately so the admin sees the input reset even
      // while the create RPC is still in flight. On failure we don't restore
      // the raw fields — the error toast is enough context to retry.
      setNewUsername(""); setNewPassword(""); setNewName(""); setNewUserAccounts([]); setNewIsFree(false); setNewFreeExpiresAt(""); setNewPlanStartsAt(""); setNewPlanEndsAt(""); setNewTvOverride("inherit");
      const res: any = await apiCall("manage-app", body);
      if (!res?.user) throw new Error("Server did not return the created user");
      setUsers(prev => [...prev, res.user]);
      setStats(prev => ({ ...prev, totalUsers: prev.totalUsers + 1 }));
      notify.success(newIsFree ? "Free profile created!" : "User created!");
    } catch (err) {
      notify.error("Failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      window.clearTimeout(timeout);
      setCreatingUser(false);
    }
  };

  const togglePinnedUser = async (u: UserData) => {
    const next = !u.pinned;
    setUsers(prev => prev.map(x => x.id === u.id ? { ...x, pinned: next } : x));
    try {
      await apiCall("manage-app", { action: "update_user", id: u.id, pinned: next });
      notify.success(next ? "Pinned to top" : "Unpinned");
    } catch (err) {
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, pinned: !next } : x));
      notify.error(err instanceof Error ? err.message : "Failed to pin");
    }
  };

  const toggleProfileLocationRequired = async (u: UserData) => {
    const next = !isLocationRequiredForProfile(u);
    const nextPrefs = { ...(u.profilePrefs || {}), locationRequired: next, locationRequiredOverride: true };
    setUsers(prev => prev.map(x => x.id === u.id ? { ...x, locationRequired: next, profilePrefs: nextPrefs } : x));
    try {
      await apiCall("manage-app", { action: "update_user", id: u.id, location_required: next });
      notify.success(next ? "Location required for this profile" : "Location not required for this profile");
      try { await refreshBootstrap(); } catch {}
    } catch (err) {
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, locationRequired: !next, profilePrefs: { ...(x.profilePrefs || {}), locationRequired: !next, locationRequiredOverride: true } } : x));
      notify.error(err instanceof Error ? err.message : "Failed to update location setting");
    }
  };

  const persistUserOrder = async (orderedIds: string[]) => {
    if (reordering) return;
    setReordering(true);
    try {
      await apiCall("manage-app", { action: "reorder_users", orderedIds });
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save order");
    } finally {
      setReordering(false);
    }
  };

  const onDropUser = (targetId: string) => {
    if (!dragUserId || dragUserId === targetId) { setDragUserId(null); return; }
    setUsers(prev => {
      const nonAdmin = prev.filter(u => u.role !== "admin");
      const admins = prev.filter(u => u.role === "admin");
      const from = nonAdmin.findIndex(u => u.id === dragUserId);
      const to = nonAdmin.findIndex(u => u.id === targetId);
      if (from < 0 || to < 0) return prev;
      const moved = [...nonAdmin];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      const merged = [...admins, ...moved];
      persistUserOrder(moved.map(u => u.id));
      return merged;
    });
    setDragUserId(null);
  };

  const moveUser = (id: string, dir: -1 | 1) => {
    setUsers(prev => {
      const nonAdmin = prev.filter(u => u.role !== "admin");
      const admins = prev.filter(u => u.role === "admin");
      const from = nonAdmin.findIndex(u => u.id === id);
      if (from < 0) return prev;
      const to = from + dir;
      if (to < 0 || to >= nonAdmin.length) return prev;
      const moved = [...nonAdmin];
      [moved[from], moved[to]] = [moved[to], moved[from]];
      persistUserOrder(moved.map(u => u.id));
      return [...admins, ...moved];
    });
  };




  const deleteUser = async (id: string) => {
    // Optimistic removal — the UI feels instant; rollback if the server rejects.
    const snapshot = users;
    setUsers(prev => prev.filter(u => u.id !== id));
    setStats(prev => ({ ...prev, totalUsers: Math.max(0, prev.totalUsers - 1) }));
    setDeleteConfirmUser(null);
    setDeletingUser(true);
    try {
      await apiCall("manage-app", { action: "delete", id });
      notify.success("User deleted!");
    } catch (err) {
      setUsers(snapshot);
      setStats(prev => ({ ...prev, totalUsers: snapshot.length }));
      notify.error("Failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDeletingUser(false);
    }
  };

  const addEmailAccount = async () => {
    if (!newAccount.label || !newAccount.user || !newAccount.password) {
      notify.error("Fill label, email, and password"); return;
    }
    const recipientFilters = parseRecipientFilters(newAccountRecipients);
    const updated = [...emailAccounts, { ...newAccount, cloudflareUrls: [...newAccountCfUrls], recipientFilters }];
    setEmailAccounts(updated);
    setNewAccount({ label: "", host: "imap.gmail.com", port: "993", user: "", password: "" });
    setNewAccountCfUrls([]);
    setNewAccountCfInput("");
    setNewAccountRecipients("");
    try {
      await apiCall("manage-app", { action: "set_settings", key: "email_accounts", value: updated });
      notify.success("Email account added!");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save account");
    }
  };

  const removeEmailAccount = async (index: number) => {
    const updated = emailAccounts.filter((_, i) => i !== index);
    setEmailAccounts(updated);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "email_accounts", value: updated });
      notify.success("Account removed!");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to remove account");
    }
  };

  const updateEmailAccountDraft = (index: number, patch: Partial<EmailAccountConfig>) => {
    setEmailAccounts((prev) => prev.map((acc, i) => (i === index ? { ...acc, ...patch } : acc)));
  };

  const saveEmailAccount = async (index: number) => {
    const account = emailAccounts[index];
    if (!account) return;
    if (!account.label.trim() || !account.user.trim() || !account.password.trim()) {
      notify.error("Fill label, email, and password");
      return;
    }
    const updated = emailAccounts.map((acc, i) => (
      i === index
        ? { ...acc, recipientFilters: editingAccountRecipients === index ? parseRecipientFilters(editRecipientsInput) : (acc.recipientFilters || []) }
        : acc
    ));
    setSavingAccounts(true);
    try {
      setEmailAccounts(updated);
      setEditingAccountRecipients(null);
      await apiCall("manage-app", { action: "set_settings", key: "email_accounts", value: updated });
      notify.success("Account updated!");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to save account");
    } finally {
      setSavingAccounts(false);
    }
  };

  const updateUserAccounts = async (userId: string) => {
    try {
      const raw = editSessionLimit.trim();
      const session_limit = raw === "" ? null : Math.max(0, Math.min(50, Math.floor(Number(raw) || 0)));
      const target = users.find(x => x.id === userId);
      const isFreeTarget = !!target?.isFree;
      let expires_at: string | null | undefined = undefined;
      if (isFreeTarget) {
        if (!editExpiresAt) {
          expires_at = null;
        } else {
          const t = Date.parse(editExpiresAt);
          if (!Number.isFinite(t)) { notify.error("Invalid expiry date"); return; }
          if (t <= Date.now()) { notify.error("Expiry must be in the future"); return; }
          expires_at = new Date(t).toISOString();
        }
      }
      const tvOvOut: "on" | "off" | null = editTvOverride === "on" ? "on" : editTvOverride === "off" ? "off" : null;
      const isPaidNonAdmin = !isFreeTarget && target?.role !== "admin";
      if (isPaidNonAdmin && editPlanStartsAt && !editPlanEndsAt) {
        notify.error("Plan end date required", { description: "Add an end date or use the duration box so the Plan pill can count down." });
        return;
      }
      const plan_starts_at = isPaidNonAdmin ? (editPlanStartsAt ? new Date(editPlanStartsAt).toISOString() : null) : undefined;
      const plan_ends_at = isPaidNonAdmin ? (editPlanEndsAt ? new Date(editPlanEndsAt).toISOString() : null) : undefined;
      await apiCall("manage-app", {
        action: "update_user",
        id: userId,
        username: editUsername.trim() || null,
        assigned_accounts: normalizeSelectedAccounts(editAccountsList).length > 0 ? normalizeSelectedAccounts(editAccountsList) : null,
        session_limit,
        tv_override: tvOverridePayload(editTvOverride),
        features: { link: editDirectLinkEnabled },
        ...(expires_at !== undefined ? { expires_at } : {}),
        ...(isFreeTarget ? { auto_delete: editAutoDelete } : {}),
        ...(plan_starts_at !== undefined ? { plan_starts_at } : {}),
        ...(plan_ends_at !== undefined ? { plan_ends_at } : {}),
      });
      const nextAccounts = normalizeSelectedAccounts(editAccountsList).length > 0 ? normalizeSelectedAccounts(editAccountsList) : null;
      const nextUsername = editUsername.trim() || null;
      setEditingUserAccounts(null); setEditHint(null);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, username: nextUsername as any, assignedAccounts: nextAccounts, session_limit, tvOverride: tvOvOut, features: { ...adminUserFeatures(u), link: editDirectLinkEnabled }, feature_link: editDirectLinkEnabled, ...(expires_at !== undefined ? { expiresAt: expires_at } as any : {}), ...(isFreeTarget ? { autoDelete: editAutoDelete } as any : {}), ...(plan_starts_at !== undefined ? { planStartsAt: plan_starts_at } as any : {}), ...(plan_ends_at !== undefined ? { planEndsAt: plan_ends_at } as any : {}) } as any : u));
      applyTvOverrideToStoredUser(userId, tvOvOut);
      patchBootstrapCacheUser(userId, { tvOverride: tvOvOut, features: { ...adminUserFeatures(target), link: editDirectLinkEnabled }, feature_link: editDirectLinkEnabled });
      try { await refreshBootstrap(); } catch {}
      broadcastTvFeatureEvent({ type: "tv-profile", userId, tvOverride: tvOvOut, at: Date.now() });
      notify.success("User settings updated!");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const tabs = [
    { id: "users" as const, label: "Users", icon: Users },
    { id: "logins" as const, label: "Login Events", icon: ShieldCheck },
    { id: "allmails" as const, label: "All Emails", icon: Mail },
    { id: "notifications" as const, label: "Notifications", icon: Bell },
    { id: "inbox" as const, label: "Inbox", icon: Mail },
    { id: "tv" as const, label: "TV Auto-Login", icon: Tv },
    { id: "cookies" as const, label: "Cookies", icon: Key },
    { id: "directlink" as const, label: "Direct Link", icon: LinkIcon },
    { id: "security" as const, label: "Security", icon: ShieldCheck },

    { id: "emails" as const, label: "Email Accounts", icon: Server },
    { id: "settings" as const, label: "Settings", icon: Settings },
    { id: "deploy" as const, label: "Deploy", icon: Server },
  ];

  const nonAdminOrder = useMemo(() => users.filter((u) => u.role !== "admin").map((u) => u.id), [users]);
  const nonAdminIndexById = useMemo(() => {
    const map = new Map<string, number>();
    nonAdminOrder.forEach((id, idx) => map.set(id, idx));
    return map;
  }, [nonAdminOrder]);
  const tvUsers = useMemo(() => users.filter((u) => u.role !== "admin"), [users]);
  const filteredTvUsers = useMemo(() => {
    const q = tvSearch.trim().toLowerCase();
    if (!q) return tvUsers;
    return tvUsers.filter((u) => `${u.name} ${u.username || ""}`.toLowerCase().includes(q));
  }, [tvSearch, tvUsers]);
  const [directSearch, setDirectSearch] = useState("");
  const filteredDirectUsers = useMemo(() => {
    const q = directSearch.trim().toLowerCase();
    if (!q) return tvUsers;
    return tvUsers.filter((u) => `${u.name} ${u.username || ""}`.toLowerCase().includes(q));
  }, [directSearch, tvUsers]);


  return (
    <div className="admin-panel min-h-[100dvh] bg-slate-50 overflow-x-hidden text-slate-900">
      <h1 className="sr-only">Admin Dashboard — Netflix Mail</h1>
      <header className="bg-white border-b px-3 sm:px-6 py-3 sm:py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto flex justify-between items-center gap-2">
          <h2 className="text-sm sm:text-xl font-black flex items-center gap-2 min-w-0 truncate">
            <div className="bg-red-600 p-1.5 sm:p-2 rounded-xl">
              <Settings className="w-4 h-4 sm:w-5 sm:h-5 text-white" aria-hidden="true" />
            </div>
            <span className="hidden sm:inline">Admin Control Panel</span>
            <span className="sm:hidden">Admin</span>
          </h2>
          <button onClick={fastClearCookiesRedirect} className="p-2 hover:bg-slate-100 rounded-full transition-colors" title="Logout" aria-label="Logout">
            <LogOut className="w-5 h-5 text-slate-400" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-3 sm:px-6 pt-4 sm:pt-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-2xl border p-4 flex items-center gap-3">
            <div className="bg-blue-50 p-2.5 rounded-xl"><Users className="w-5 h-5 text-blue-600" /></div>
            <div><p className="text-2xl font-black text-slate-900">{stats.totalUsers}</p><p className="text-xs text-slate-500">Total Users</p></div>
          </div>
          <div className="bg-white rounded-2xl border p-4 flex items-center gap-3">
            <div className="bg-green-50 p-2.5 rounded-xl"><Mail className="w-5 h-5 text-green-600" /></div>
            <div><p className="text-2xl font-black text-slate-900">{stats.totalEmails}</p><p className="text-xs text-slate-500">Total Emails</p></div>
          </div>
          <div className="bg-white rounded-2xl border p-4 flex items-center gap-3">
            <div className="bg-purple-50 p-2.5 rounded-xl"><Globe className="w-5 h-5 text-purple-600" /></div>
            <div><p className="text-2xl font-black text-slate-900">{emailAccounts.length}</p><p className="text-xs text-slate-500">Email Accounts</p></div>
          </div>
          <div className="bg-white rounded-2xl border p-4 flex items-center gap-3">
            <div className="bg-amber-50 p-2.5 rounded-xl"><ShieldCheck className="w-5 h-5 text-amber-600" /></div>
            <div><p className="text-2xl font-black text-slate-900">{captchaEnabled ? "ON" : "OFF"}</p><p className="text-xs text-slate-500">CAPTCHA</p></div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-3 sm:px-6 pt-4 sm:pt-6">
        <div className="flex gap-1 bg-white rounded-2xl border p-1.5 overflow-x-auto">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 sm:px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all whitespace-nowrap ${
                activeTab === tab.id ? "bg-red-600 text-white shadow-md" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              }`}>
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <main className="max-w-6xl mx-auto p-3 sm:p-6 pt-4 sm:pt-6">
        {activeTab === "users" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-green-50 p-1.5 rounded-lg"><Plus className="w-4 h-4 text-green-600" /></div>
                Create User
              </h2>
              <div className="space-y-3 min-w-0">
                <label className="flex items-start gap-3 p-3 rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/60 cursor-pointer hover:bg-emerald-50 transition-colors">
                  <input type="checkbox" checked={newIsFree} onChange={(e) => setNewIsFree(e.target.checked)}
                    className="w-4 h-4 mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-emerald-900">Free profile (no password)</p>
                    <p className="text-[11px] text-emerald-700/80 leading-snug">Anyone can enter this profile with one tap. Username is optional and admin-controlled.</p>
                  </div>
                </label>

                <input type="text" placeholder="Display Name" value={newName} onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                {newIsFree ? (
                  <input type="text" placeholder="Username (optional)" value={newUsername} onChange={(e) => setNewUsername(e.target.value)}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-emerald-500 text-sm" />
                ) : (
                  <>
                    <input type="text" placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                    <PasswordInput value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Password"
                      className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                  </>
                )}

                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Assign IMAP Accounts</label>
                  <div className="space-y-1.5">
                    {availableAccounts.map(label => (
                      <label key={label} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors">
                        <input type="checkbox" checked={newUserAccounts.includes(label)}
                          onChange={(e) => {
                            if (e.target.checked) setNewUserAccounts([...newUserAccounts, label]);
                            else setNewUserAccounts(newUserAccounts.filter(a => a !== label));
                          }}
                          className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500" />
                        <span className="text-sm text-slate-700">{label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">Leave empty = user sees no accounts</p>
                </div>

                {newIsFree && (
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Expires at (optional)</label>
                    <DateTimePicker value={newFreeExpiresAt} onChange={setNewFreeExpiresAt} />
                    <p className="text-[10px] text-slate-400 mt-1">Free profile is auto-deleted after this time. Leave empty = never expires.</p>
                    {newFreeExpiresAt && (
                      <button type="button" onClick={() => setNewFreeExpiresAt("")}
                        className="mt-1 text-[11px] text-emerald-700 hover:underline">Clear expiry</button>
                    )}
                  </div>
                )}

                {!newIsFree && (
                  <div className="rounded-2xl border border-sky-200 bg-sky-50/50 p-3 space-y-3">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-sky-800">Plan window (optional)</div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1">Plan starts at</label>
                      <DateTimePicker value={newPlanStartsAt} onChange={setNewPlanStartsAt} />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1">Plan ends at</label>
                      <DateTimePicker value={newPlanEndsAt} onChange={setNewPlanEndsAt} />
                      <DurationQuickAdd baseDateStr={newPlanStartsAt} onApply={setNewPlanEndsAt} />
                      <p className="text-[10px] text-slate-500 mt-1">Type a number and pick days/months/years — auto-calculated from Plan Start (or now).</p>
                    </div>
                    <p className="text-[10px] text-slate-500">Leave empty = no plan gating. When set, user sees a live countdown pill and is locked out after the end date. Reminders go to admin Telegram in the last 7 days.</p>
                    {(newPlanStartsAt || newPlanEndsAt) && (
                      <button type="button" onClick={() => { setNewPlanStartsAt(""); setNewPlanEndsAt(""); }}
                        className="text-[11px] text-sky-700 hover:underline">Clear plan dates</button>
                    )}
                  </div>
                )}


                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-2">TV Auto-Login</label>
                  <div className="flex gap-2">
                    {(["on", "off", "inherit"] as const).map(v => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setNewTvOverride(v)}
                        className={`flex-1 text-xs font-bold py-2 rounded-lg border transition-all ${newTvOverride === v ? (v === "on" ? "bg-emerald-600 text-white border-emerald-600" : v === "off" ? "bg-rose-600 text-white border-rose-600" : "bg-slate-900 text-white border-slate-900") : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}
                      >
                        {v === "on" ? "ON" : v === "off" ? "OFF" : "Default"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1"><b>ON</b> = always show TV icon. <b>OFF</b> = always hide. <b>Default</b> = same as global switch.</p>
                </div>


                <button onClick={createUser}
                  disabled={creatingUser}
                  className={`w-full text-white font-bold py-3 rounded-xl transition-all text-sm ${newIsFree ? "bg-emerald-600 hover:bg-emerald-700" : "bg-slate-900 hover:bg-slate-800"}`}>
                  {creatingUser ? "Creating…" : (newIsFree ? "Create Free Profile" : "Create User")}
                </button>
              </div>
            </section>

            <section className="lg:col-span-2 relative overflow-hidden rounded-3xl bg-white p-5 sm:p-7 border border-slate-200/70 shadow-[0_20px_60px_-30px_rgba(59,130,246,0.25)]">
              {/* Soft blush accents */}
              <div className="absolute -top-32 -left-32 w-72 h-72 bg-gradient-to-br from-blue-100 to-transparent rounded-full blur-3xl pointer-events-none" />
              <div className="absolute -bottom-32 -right-32 w-72 h-72 bg-gradient-to-tl from-red-50 to-transparent rounded-full blur-3xl pointer-events-none" />

              <div className="relative flex items-end justify-between gap-3 mb-5 pb-4 border-b border-slate-100">
                <div className="min-w-0 flex items-center gap-3">
                  <div className="relative flex-shrink-0">
                    <div className="absolute inset-0 bg-blue-500 rounded-2xl blur-md opacity-30" />
                    <div className="relative w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-lg shadow-blue-500/30">
                      <Users className="w-5 h-5 text-white" strokeWidth={2.5} />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-black tracking-[0.2em] text-blue-600 mb-0.5">ROSTER</p>
                    <h2 className="font-black text-xl sm:text-2xl text-slate-900 tracking-tight leading-none flex items-center gap-2">
                      Active Users
                      <span className="text-[10px] font-mono font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md border border-slate-200">{users.length.toString().padStart(2, "0")}</span>
                    </h2>
                    <p className="text-[10px] sm:text-[11px] text-slate-400 mt-1.5 font-mono hidden sm:block">// drag to reorder · pinned stays on top</p>
                  </div>
                </div>
              </div>

              <div className="relative space-y-2.5">
                {(() => { return null; })()}
                {users.map(u => {
                  const canDrag = u.role !== "admin";
                  const idx = nonAdminIndexById.get(u.id) ?? -1;
                  const isFirst = idx === 0;
                  const isLast = idx === nonAdminOrder.length - 1;
                  const isAdmin = u.role === "admin";
                  const roleLabel = isAdmin ? "Administrator" : (u.isFree ? "Free profile" : "Member profile");
                  return (
                  <div
                    key={u.id}
                    draggable={canDrag}
                    onDragStart={() => canDrag && setDragUserId(u.id)}
                    onDragOver={(e) => { if (canDrag && dragUserId && dragUserId !== u.id) e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); if (canDrag) onDropUser(u.id); }}
                    onDragEnd={() => setDragUserId(null)}
                    className={`group relative overflow-hidden rounded-xl border bg-white transition-all min-w-0 ${dragUserId === u.id ? "opacity-60 border-primary shadow-lg" : "border-slate-200 hover:border-slate-300 hover:shadow-md"} ${canDrag ? "sm:cursor-move" : ""}`}
                  >
                    <div className="p-4 sm:p-5">
                      <div className="flex min-w-0 flex-col gap-4">
                        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3.5">
                          <ProfileAvatar
                            avatarId={getStableProfileAvatar(u)}
                            name={u.name}
                            className="w-12 h-12 sm:w-14 sm:h-14 !rounded-xl border border-slate-200 shadow-sm"
                            fallbackColor="bg-red-600"
                          />
                          <div className="min-w-0">
                            <div className="min-w-0 space-y-1">
                              <p className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-black text-slate-950 text-[17px] sm:text-xl tracking-tight leading-tight">{u.name || "Unnamed"}</p>
                              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-red-600">{roleLabel}</span>
                                {u.pinned && (
                                  <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700">Pinned</span>
                                )}
                              </div>
                            </div>
                            <p className="mt-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-slate-500">
                              {u.username ? `@${u.username}` : "username not set"}
                            </p>
                            {!isAdmin && (() => {
                              const gpsOn = isLocationRequiredForProfile(u);
                              const ov = u.tvOverride === "on" || u.tvOverride === "off" ? u.tvOverride : null;
                              const tvOn = ov === "on" ? true : ov === "off" ? false : tvFeatureEnabled;
                              const f = adminUserFeatures(u);
                              const gmailOn = f.gmail !== false;
                              const linkOn = f.link === true;
                              const accts = u.assignedAccounts || [];
                              const sessionLimit = (u as any).session_limit;
                               const expiresAt = (u as any).expiresAt as string | null | undefined;
                               const planEndsAt = ((u as any).planEndsAt || (u as any).plan_ends_at) as string | null | undefined;
                               const planStartsAt = ((u as any).planStartsAt || (u as any).plan_starts_at) as string | null | undefined;
                               const accessSummary = [
                                 gpsOn ? "Location required" : "Location optional",
                                 tvOn ? "TV enabled" : "TV disabled",
                                 gmailOn ? "Gmail enabled" : "Gmail disabled",
                                 linkOn ? "Direct Link enabled" : "Direct Link disabled",
                               ].join(" · ");
                               const sessionSummary = u.isFree && expiresAt
                                 ? `Free access ends ${new Date(expiresAt).toLocaleDateString()}`
                                 : !u.isFree && sessionLimit != null
                                   ? (sessionLimit === 0 ? "Unlimited sessions" : `${sessionLimit} session${sessionLimit === 1 ? "" : "s"} allowed`)
                                   : "Session limit not set";
                               const mailboxSummary = accts.length === 0 ? "Not assigned" : `${accts.length} connected`;
                               // Plan status (paid non-admin only)
                               let planPill: { label: string; sub: string; tone: "active" | "soon" | "expired" | "pending" | "none" } | null = null;
                               if (!u.isFree) {
                                 const now = Date.now();
                                 const startsMs = planStartsAt ? Date.parse(planStartsAt) : NaN;
                                 const endsMs = planEndsAt ? Date.parse(planEndsAt) : NaN;
                                 if (Number.isFinite(endsMs)) {
                                   if (endsMs <= now) {
                                     planPill = { label: "No · Expired", sub: `Ended ${new Date(endsMs).toLocaleDateString()}`, tone: "expired" };
                                   } else if (Number.isFinite(startsMs) && startsMs > now) {
                                     const days = Math.ceil((startsMs - now) / 86400000);
                                     planPill = { label: "Pending start", sub: `Starts in ${days}d`, tone: "pending" };
                                   } else {
                                     const msLeft = endsMs - now;
                                     const days = Math.floor(msLeft / 86400000);
                                     const hours = Math.floor((msLeft % 86400000) / 3600000);
                                     const left = days > 0 ? `${days}d ${hours}h left` : `${hours}h left`;
                                     planPill = { label: "Yes · Active", sub: left, tone: days <= 7 ? "soon" : "active" };
                                   }
                                 } else {
                                   planPill = { label: "No · Not set", sub: "No plan dates", tone: "none" };
                                 }
                               }
                               const planToneCls = planPill ? ({
                                 active:  "border-emerald-200 bg-emerald-50 text-emerald-800",
                                 soon:    "border-amber-200 bg-amber-50 text-amber-800",
                                 expired: "border-rose-200 bg-rose-50 text-rose-800",
                                 pending: "border-sky-200 bg-sky-50 text-sky-800",
                                 none:    "border-slate-200 bg-slate-50 text-slate-700",
                               } as const)[planPill.tone] : "";
                               return (
                                 <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-slate-600">
                                   <span className="inline-flex items-center gap-1.5"><span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Mailbox</span><span className="font-semibold text-slate-800">{mailboxSummary}</span></span>
                                   <span className="h-3 w-px bg-slate-200" aria-hidden />
                                   <span className="inline-flex items-center gap-1.5"><span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Session</span><span className="font-semibold text-slate-800">{sessionSummary}</span></span>
                                   {planPill && (
                                     <>
                                       <span className="h-3 w-px bg-slate-200" aria-hidden />
                                       <span className="inline-flex items-center gap-1.5">
                                         <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Plan</span>
                                         <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-bold ${planToneCls}`}>
                                           <span>{planPill.label}</span>
                                           <span className="opacity-60">·</span>
                                           <span className="font-semibold">{planPill.sub}</span>
                                         </span>
                                       </span>
                                     </>
                                   )}
                                   <span className="h-3 w-px bg-slate-200" aria-hidden />
                                   <span className="inline-flex items-center gap-1.5"><span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Access</span><span className="font-semibold text-slate-800">{accessSummary}</span></span>
                                 </div>
                               );
                            })()}
                          </div>
                        </div>

                       {!isAdmin && (
                         <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
                           <button onClick={() => moveUser(u.id, -1)} disabled={isFirst || reordering} title="Move up"
                             className="h-8 rounded-md border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 transition disabled:opacity-40 disabled:cursor-not-allowed">
                             Move up
                           </button>
                           <button onClick={() => moveUser(u.id, 1)} disabled={isLast || reordering} title="Move down"
                             className="h-8 rounded-md border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 transition disabled:opacity-40 disabled:cursor-not-allowed">
                             Move down
                           </button>
                           <button onClick={() => togglePinnedUser(u)} title={u.pinned ? "Unpin" : "Pin"}
                             className={`h-8 rounded-md border px-2.5 text-[11px] font-semibold transition ${u.pinned ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                             {u.pinned ? "Unpin" : "Pin"}
                           </button>
                           <button onClick={() => toggleProfileLocationRequired(u)} title={isLocationRequiredForProfile(u) ? "GPS on" : "GPS off"}
                             className={`h-8 rounded-md border px-2.5 text-[11px] font-semibold transition ${isLocationRequiredForProfile(u) ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                             {isLocationRequiredForProfile(u) ? "Location on" : "Location off"}
                           </button>
                           <button onClick={() => loginAsUser(u)} title="View as user"
                             className="h-8 rounded-md border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 transition">
                             View
                           </button>
                           <button onClick={() => {
                              const opening = editingUserAccounts !== u.id;
                              setEditingUserAccounts(opening ? u.id : null);
                              setEditUsername(u.username || "");
                              setEditAccountsList(normalizeSelectedAccounts((u as any).assignedAccounts || []));
                              const cur = (u as any).session_limit;
                              setEditSessionLimit(cur === null || cur === undefined ? "" : String(cur));
                              const exp = (u as any).expiresAt as string | null | undefined;
                              if (exp) {
                                const d = new Date(exp);
                                const pad = (n: number) => String(n).padStart(2, "0");
                                setEditExpiresAt(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
                              } else {
                                setEditExpiresAt("");
                              }
                              setEditAutoDelete((u as any).autoDelete !== false);
                              const toLocalInput = (iso: string | null | undefined): string => {
                                if (!iso) return "";
                                const d = new Date(iso);
                                const pad = (n: number) => String(n).padStart(2, "0");
                                return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                              };
                              setEditPlanStartsAt(toLocalInput((u as any).planStartsAt));
                              setEditPlanEndsAt(toLocalInput((u as any).planEndsAt));
                              const ovInit = (u as any).tvOverride;
                              setEditTvOverride(ovInit === "on" ? "on" : ovInit === "off" ? "off" : "inherit");
                              setEditDirectLinkEnabled(adminUserFeatures(u).link === true);
                           }} title="Edit"
                             className={`h-8 rounded-md border px-2.5 text-[11px] font-semibold transition ${editingUserAccounts === u.id ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                             Edit
                           </button>
                           {!u.isFree && (
                             <button onClick={() => { setChangingUserPass(changingUserPass === u.id ? null : u.id); setUserNewPass(""); }} title="Change password"
                               className={`h-8 rounded-md border px-2.5 text-[11px] font-semibold transition ${changingUserPass === u.id ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                               Password
                             </button>
                           )}
                           <button onClick={() => setDeleteConfirmUser(u)} title="Delete"
                             className="ml-auto h-8 rounded-md border border-red-200 bg-red-50 px-2.5 text-[11px] font-semibold text-red-700 hover:bg-red-100 transition">
                             Delete
                           </button>
                         </div>
                       )}

                       {isAdmin && (
                         <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
                           <button onClick={() => toggleProfileLocationRequired(u)}
                             title={isLocationRequiredForProfile(u) ? "GPS required" : "GPS off"}
                             className={`h-8 rounded-md border px-2.5 text-[11px] font-semibold transition ${isLocationRequiredForProfile(u) ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                             {isLocationRequiredForProfile(u) ? "Location on" : "Location off"}
                           </button>
                           {currentUser?.id !== u.id && (
                             <button onClick={() => loginAsUser(u)} title="Sign in as admin"
                               className="h-8 rounded-md border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 transition">
                               View
                             </button>
                           )}
                           <button onClick={() => {
                               const opening = editingUserAccounts !== u.id;
                               setEditingUserAccounts(opening ? u.id : null);
                               setEditUsername(u.username || "");
                             }} title="Edit admin"
                             className={`h-8 rounded-md border px-2.5 text-[11px] font-semibold transition ${editingUserAccounts === u.id ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                             Edit
                           </button>
                           <button onClick={() => { setChangingUserPass(changingUserPass === u.id ? null : u.id); setUserNewPass(""); }}
                             title="Change password"
                             className={`h-8 rounded-md border px-2.5 text-[11px] font-semibold transition ${changingUserPass === u.id ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                             Password
                           </button>
                         </div>
                       )}

                      {editingUserAccounts === u.id && u.role === "admin" && (
                        <div className="mt-2 p-3.5 rounded-xl border border-slate-200 bg-white shadow-sm space-y-2.5">
                          <label className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-500 flex items-center gap-1.5">
                            <UserCircle className="w-3.5 h-3.5 text-red-600" /> Admin username
                          </label>
                          <input type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value)}
                            placeholder="e.g. admin"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-red-500 focus:bg-white focus:ring-2 focus:ring-red-100 transition-all" />
                          <div className="flex gap-2 pt-1">
                            <button onClick={() => setEditingUserAccounts(null)}
                              className="flex-1 h-9 rounded-lg border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 active:scale-95 transition-all">Cancel</button>
                            <button onClick={async () => {
                                try {
                                  const next = editUsername.trim() || null;
                                  await apiCall("manage-app", { action: "update_user", id: u.id, username: next });
                                  setUsers(prev => prev.map(x => x.id === u.id ? { ...x, username: next as any } : x));
                                  setEditingUserAccounts(null);
                                  try { await refreshBootstrap(); } catch {}
                                  notify.success("Admin updated");
                                } catch (err) { notify.error(err instanceof Error ? err.message : "Failed to update"); }
                              }}
                              className="flex-1 h-9 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold active:scale-95 transition-all shadow-sm shadow-red-200">Save</button>
                          </div>
                        </div>
                      )}

                    {deleteConfirmUser?.id === u.id && createPortal(
                      <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 animate-in fade-in duration-200"
                        onClick={() => !deletingUser && setDeleteConfirmUser(null)}
                        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
                        {/* Cinematic backdrop */}
                        <div className="absolute inset-0 bg-black/80 backdrop-blur-xl" />
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(244,63,94,0.18),transparent_60%)] pointer-events-none" />

                        <div onClick={(e) => e.stopPropagation()}
                          className="relative w-full max-w-[380px] rounded-3xl overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
                          style={{
                            background: "linear-gradient(180deg, rgba(24,24,32,0.98) 0%, rgba(12,12,18,0.98) 100%)",
                            border: "1px solid rgba(255,255,255,0.08)",
                            boxShadow: "0 40px 80px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04) inset, 0 30px 60px -30px rgba(244,63,94,0.35)",
                          }}>
                          {/* Top accent hairline */}
                          <div className="h-px w-full bg-gradient-to-r from-transparent via-rose-500/60 to-transparent" />

                          {/* Header */}
                          <div className="px-6 pt-7 pb-5 text-center">
                            <div className="relative mx-auto w-16 h-16 mb-4">
                              <div className="absolute inset-0 rounded-full bg-rose-500/10 blur-xl" />
                              <div className="relative w-16 h-16 rounded-full flex items-center justify-center"
                                style={{
                                  background: "linear-gradient(135deg, rgba(244,63,94,0.15), rgba(244,63,94,0.05))",
                                  border: "1px solid rgba(244,63,94,0.3)",
                                  boxShadow: "0 0 0 6px rgba(244,63,94,0.06), inset 0 1px 0 rgba(255,255,255,0.08)",
                                }}>
                                <Trash2 className="w-7 h-7 text-rose-400" strokeWidth={2} />
                              </div>
                            </div>
                            <div className="text-white text-[19px] font-bold tracking-tight leading-tight">
                              Permanently delete profile?
                            </div>
                            <div className="text-white/50 text-[13px] mt-1.5 leading-relaxed px-2">
                              This will erase everything tied to this account. There is no undo.
                            </div>
                          </div>

                          {/* User card */}
                          <div className="mx-5 mb-4">
                            <div className="flex items-center gap-3 rounded-2xl px-3.5 py-3"
                              style={{
                                background: "rgba(255,255,255,0.03)",
                                border: "1px solid rgba(255,255,255,0.06)",
                              }}>
                              <div className="w-11 h-11 rounded-full flex items-center justify-center text-[14px] font-bold text-white/90 overflow-hidden shrink-0"
                                style={{
                                  background: "linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))",
                                  border: "1px solid rgba(255,255,255,0.08)",
                                }}>
                                {u.profileAvatar ? <img src={u.profileAvatar} alt="" className="w-full h-full object-cover" /> : (u.name || u.username || "?").slice(0, 1).toUpperCase()}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-[14px] font-semibold text-white truncate">{u.name || u.username || "Unnamed"}</div>
                                {u.username && <div className="text-[11.5px] text-white/45 truncate mt-0.5">@{u.username}</div>}
                              </div>
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="px-5 pb-5 flex gap-2.5">
                            <button
                              onClick={() => setDeleteConfirmUser(null)}
                              disabled={deletingUser}
                              className="flex-1 h-11 rounded-xl text-white/80 text-[13.5px] font-semibold transition-all active:scale-[0.98] disabled:opacity-50 hover:text-white"
                              style={{
                                background: "rgba(255,255,255,0.04)",
                                border: "1px solid rgba(255,255,255,0.08)",
                              }}>
                              Keep it
                            </button>
                            <button
                              onClick={() => deleteUser(u.id)}
                              disabled={deletingUser}
                              className="flex-1 h-11 rounded-xl text-white text-[13.5px] font-bold transition-all active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-1.5"
                              style={{
                                background: "linear-gradient(180deg, #f43f5e 0%, #e11d48 100%)",
                                boxShadow: "0 8px 20px -6px rgba(244,63,94,0.5), inset 0 1px 0 rgba(255,255,255,0.15)",
                              }}>
                              {deletingUser ? (
                                <><div className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Deleting…</>
                              ) : (
                                <><Trash2 className="w-4 h-4" /> Delete forever</>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>,
                      document.body,
                    )}









                    {editingUserAccounts === u.id && u.role !== "admin" && createPortal(
                      <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center animate-in fade-in duration-200 font-['Manrope',system-ui,sans-serif] px-0 sm:px-4"
                          onClick={() => { setEditingUserAccounts(null); setEditHint(null); }}
                        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
                        <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-lg" />
                        <div onClick={(e) => e.stopPropagation()}
                          className="relative w-full sm:max-w-xl lg:max-w-2xl max-h-[96vh] sm:max-h-[90vh] overflow-hidden bg-white sm:rounded-3xl rounded-t-3xl shadow-[0_50px_120px_-20px_rgba(0,0,0,0.5)] animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-300 flex flex-col">

                          {/* Ticket-style top: red barcode strip */}
                          <div className="relative flex-shrink-0">
                            <div className="h-2 bg-gradient-to-r from-red-600 via-rose-500 to-red-600" />
                            <div className="flex items-center justify-between px-5 sm:px-7 py-2.5 bg-white border-b border-dashed border-slate-200">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />
                                <span className="text-[10px] font-black tracking-[0.35em] text-slate-900 uppercase">Edit · Profile</span>
                              </div>
                              <button onClick={() => { setEditingUserAccounts(null); setEditHint(null); }}
                                className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-100 hover:bg-red-600 text-slate-600 hover:text-white flex items-center justify-center transition-all active:scale-90">
                                <X className="w-4 h-4" strokeWidth={2.5} />
                              </button>
                            </div>
                          </div>

                          {/* Profile hero: minimal, no gradient */}
                          <div className="flex-shrink-0 px-5 sm:px-7 pt-5 sm:pt-6 pb-4 sm:pb-5 bg-white flex items-center gap-4 border-b border-slate-100">
                            <div className="relative flex-shrink-0">
                              <ProfileAvatar avatarId={getStableProfileAvatar(u)} name={u.name}
                                className="w-16 h-16 sm:w-20 sm:h-20 !rounded-2xl ring-1 ring-slate-200 shadow-md" />
                              <span className="absolute -top-1.5 -right-1.5 px-1.5 py-0.5 rounded-md bg-red-600 text-white text-[8px] font-black tracking-widest uppercase shadow-md">{u.isFree ? "Free" : ((u as any).role === "admin" ? "Admin" : "Pro")}</span>
                            </div>
                            <div className="min-w-0 flex-1">
                              <h2 className="text-slate-900 font-black text-2xl sm:text-3xl leading-none tracking-tight truncate font-['Sora',system-ui,sans-serif]">{u.name}</h2>
                              <p className="text-slate-500 text-xs sm:text-sm font-mono truncate mt-1.5">{u.username ? `@${u.username}` : "no username set"}</p>
                            </div>
                          </div>

                          {/* Body */}
                          <div className="relative flex-1 overflow-y-auto bg-slate-50/60 px-4 sm:px-7 py-5 space-y-4">

                              {/* Identity */}
                              <section className="bg-white rounded-2xl p-4 sm:p-5 ring-1 ring-slate-200/70 hover:ring-red-200 transition-all">
                                <div className="flex items-center justify-between mb-2.5">
                                  <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.15em] text-slate-900">
                                    <UserCircle className="w-4 h-4 text-red-600" />
                                    Username {u.isFree && <span className="text-slate-400 normal-case tracking-normal font-medium">· optional</span>}
                                  </label>
                                  <button type="button" onClick={() => setEditHint(editHint === "user" ? null : "user")}
                                    className={`w-6 h-6 rounded-full flex items-center justify-center transition ${editHint === "user" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-red-50 hover:text-red-600"}`}>
                                    <Info className="w-3 h-3" />
                                  </button>
                                </div>
                                <input type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value)}
                                  placeholder={u.isFree ? "No username needed" : "e.g. john123"}
                                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:border-red-500 focus:bg-white focus:ring-4 focus:ring-red-100 text-sm font-semibold text-slate-900 placeholder:text-slate-400 transition-all" />
                                {editHint === "user" && (
                                  <p className="mt-2 text-[11px] text-slate-700 bg-red-50 border-l-2 border-red-500 rounded-r-md px-3 py-2 leading-snug">The name this user types to log in.</p>
                                )}
                              </section>

                              {/* Mailbox */}
                              <section className="bg-white rounded-2xl p-4 sm:p-5 ring-1 ring-slate-200/70 hover:ring-red-200 transition-all">
                                <div className="flex items-center justify-between mb-2.5">
                                  <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.15em] text-slate-900">
                                    <Mail className="w-4 h-4 text-red-600" />
                                    Mailbox Access
                                  </label>
                                  <span className="text-[10px] font-mono text-slate-400">{editAccountsList.length}/{availableAccounts.length}</span>
                                </div>
                                <p className="text-[11px] text-slate-500 mb-3">Tap to allow · tap again to hide</p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                                  {availableAccounts.map(label => {
                                    const checked = editAccountsList.includes(label);
                                    return (
                                      <button key={label} type="button"
                                        onClick={() => {
                                          if (checked) setEditAccountsList(editAccountsList.filter(a => a !== label));
                                          else setEditAccountsList([...editAccountsList, label]);
                                        }}
                                        className={`group flex items-center gap-2.5 p-3 rounded-xl text-left transition-all border ${checked ? "bg-red-600 border-red-600 shadow-md shadow-red-200" : "bg-white border-slate-200 hover:border-red-300"}`}>
                                        <span className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center transition-all ${checked ? "bg-white" : "bg-slate-100 group-hover:bg-red-50"}`}>
                                          {checked && <Check className="w-3.5 h-3.5 text-red-600" strokeWidth={4} />}
                                        </span>
                                        <span className={`text-[13px] truncate flex-1 font-bold ${checked ? "text-white" : "text-slate-800"}`}>{label}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </section>

                              {/* Devices */}
                              {!u.isFree && (
                                <section className="bg-white rounded-2xl p-4 sm:p-5 ring-1 ring-slate-200/70 hover:ring-red-200 transition-all">
                                  <div className="flex items-center justify-between mb-3">
                                    <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.15em] text-slate-900">
                                      <Users className="w-4 h-4 text-red-600" />
                                      Concurrent Devices
                                    </label>
                                    <button type="button" onClick={() => setEditHint(editHint === "sess" ? null : "sess")}
                                      className={`w-6 h-6 rounded-full flex items-center justify-center transition ${editHint === "sess" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-red-50 hover:text-red-600"}`}>
                                      <Info className="w-3 h-3" />
                                    </button>
                                  </div>
                                  {editHint === "sess" && (
                                    <p className="mb-3 text-[11px] text-slate-700 bg-red-50 border-l-2 border-red-500 rounded-r-md px-3 py-2 leading-snug">Set 2 = user can log in on max 2 devices. A 3rd login kicks out the oldest.</p>
                                  )}
                                  <div className="flex flex-col sm:flex-row gap-2">
                                    <input type="number" min={0} max={50} step={1} value={editSessionLimit}
                                      onChange={(e) => setEditSessionLimit(e.target.value)}
                                      placeholder="Default"
                                      className="sm:w-24 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:border-red-500 focus:bg-white focus:ring-4 focus:ring-red-100 text-center text-lg font-black text-slate-900 placeholder:text-slate-400 transition-all" />
                                    <div className="grid grid-cols-3 gap-1.5 flex-1">
                                      {[
                                        { v: "", label: "Default" },
                                        { v: "0", label: "∞ Unlimited" },
                                        { v: "1", label: "Only 1" },
                                      ].map(o => (
                                        <button key={o.v} type="button" onClick={() => setEditSessionLimit(o.v)}
                                          className={`text-[10px] font-black py-2.5 rounded-lg transition-all uppercase tracking-wider border ${editSessionLimit === o.v ? "bg-red-600 border-red-600 text-white shadow-md shadow-red-200" : "bg-white border-slate-200 text-slate-600 hover:border-red-400 hover:text-red-600"}`}>
                                          {o.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                </section>
                              )}

                              {/* Feature toggles — grid */}
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <section className="bg-white rounded-2xl p-4 sm:p-5 ring-1 ring-slate-200/70 hover:ring-red-200 transition-all">
                                  <div className="flex items-center justify-between mb-3">
                                    <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.15em] text-slate-900">
                                      <Tv className="w-4 h-4 text-red-600" />
                                      TV Presence
                                    </label>
                                    {editTvOverride !== "inherit" && (
                                      <button type="button" onClick={() => setEditTvOverride("inherit")}
                                        className="text-[9px] font-black text-slate-500 hover:text-red-600 uppercase tracking-wider transition-colors">Reset</button>
                                    )}
                                  </div>
                                  <div className="flex bg-slate-100 p-1 rounded-xl">
                                    {([
                                      { value: "on" as const,  label: "Show", Icon: Eye },
                                      { value: "off" as const, label: "Hide", Icon: EyeOff },
                                    ]).map((opt) => {
                                      const active = editTvOverride === opt.value;
                                      const Icon = opt.Icon;
                                      return (
                                        <button key={opt.value} type="button" onClick={() => setEditTvOverride(opt.value)}
                                          className={`flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-black transition-all active:scale-[0.97] uppercase tracking-wider ${active ? "bg-white text-red-600 shadow-sm ring-1 ring-red-200" : "text-slate-500 hover:text-slate-800"}`}
                                          aria-pressed={active}>
                                          <Icon className="w-3.5 h-3.5" />
                                          {opt.label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <p className="text-[11px] text-slate-500 mt-2 leading-snug">
                                    {editTvOverride === "inherit"
                                      ? <>Follows global ({tvFeatureEnabled ? "visible" : "hidden"})</>
                                      : editTvOverride === "on" ? "Always visible." : "Always hidden."}
                                  </p>
                                </section>

                                <section className="bg-white rounded-2xl p-4 sm:p-5 ring-1 ring-slate-200/70 hover:ring-red-200 transition-all">
                                  <div className="flex items-center justify-between mb-3 gap-2">
                                    <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.15em] text-slate-900 min-w-0">
                                      <LinkIcon className="w-4 h-4 text-red-600 shrink-0" />
                                      <span className="truncate">Direct Link</span>
                                    </label>
                                    <span className={`shrink-0 px-2 py-0.5 rounded-md text-[9px] font-black tracking-widest uppercase ${editDirectLinkEnabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}>
                                      {editDirectLinkEnabled ? "On" : "Off"}
                                    </span>
                                  </div>
                                  <button type="button" onClick={() => setEditDirectLinkEnabled((v) => !v)}
                                    aria-pressed={editDirectLinkEnabled}
                                    className={`relative w-full h-11 rounded-xl transition-all overflow-hidden ${editDirectLinkEnabled ? "bg-gradient-to-r from-emerald-500 to-emerald-600 shadow-md shadow-emerald-200" : "bg-slate-200"}`}>
                                    <span className={`absolute top-1 w-9 h-9 rounded-lg bg-white shadow-md flex items-center justify-center transition-all ${editDirectLinkEnabled ? "left-[calc(100%-2.5rem)]" : "left-1"}`}>
                                      {editDirectLinkEnabled ? <Check className="w-4 h-4 text-emerald-600" strokeWidth={3.5} /> : <X className="w-4 h-4 text-slate-500" strokeWidth={3.5} />}
                                    </span>
                                    <span className={`absolute inset-0 flex items-center text-[11px] font-black uppercase tracking-widest ${editDirectLinkEnabled ? "justify-start pl-4 text-white" : "justify-end pr-4 text-slate-500"}`}>
                                      {editDirectLinkEnabled ? "Enabled" : "Disabled"}
                                    </span>
                                  </button>
                                  <p className="text-[11px] text-slate-500 mt-2 leading-snug">
                                    {editDirectLinkEnabled ? "User can generate Netflix links." : "Direct Link workflow is hidden."}
                                  </p>
                                </section>
                              </div>

                              {/* Free profile expiry */}
                              {u.isFree && (
                                <section className="bg-white rounded-2xl p-4 sm:p-5 ring-1 ring-slate-200/70 hover:ring-red-200 transition-all">
                                  <div className="flex items-center justify-between mb-3">
                                    <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.15em] text-slate-900">
                                      <Clock className="w-4 h-4 text-red-600" />
                                      Auto-Delete Date
                                    </label>
                                    {editExpiresAt && (
                                      <button type="button" onClick={() => setEditExpiresAt("")}
                                        className="text-[9px] font-black text-slate-500 hover:text-red-600 uppercase tracking-wider transition-colors">Clear</button>
                                    )}
                                  </div>
                                  <DateTimePicker value={editExpiresAt} onChange={setEditExpiresAt} />
                                  <p className="text-[11px] text-slate-500 mt-2">Empty = keep forever</p>
                                </section>
                              )}

                              {u.isFree && (
                                <section className="bg-white rounded-2xl p-4 sm:p-5 ring-1 ring-slate-200/70 flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-[13px] font-black text-slate-900">Show expiry pill</div>
                                    <div className="text-[11px] text-slate-500 leading-snug mt-0.5">
                                      {editAutoDelete ? "Live countdown visible to user." : "Countdown hidden."}
                                    </div>
                                  </div>
                                  <button type="button" onClick={() => setEditAutoDelete((v) => !v)}
                                    aria-pressed={editAutoDelete}
                                    className={`relative shrink-0 w-14 h-8 rounded-full transition-colors ${editAutoDelete ? "bg-emerald-500" : "bg-slate-300"}`}>
                                    <span className={`absolute top-1 w-6 h-6 rounded-full bg-white shadow-md transition-transform ${editAutoDelete ? "translate-x-7" : "translate-x-1"}`} />
                                  </button>
                                </section>
                              )}

                              {/* Plan window */}
                              {!u.isFree && (u as any).role !== "admin" && (
                                <section className="bg-white rounded-2xl p-4 sm:p-5 ring-2 ring-red-500 shadow-md shadow-red-100">
                                  <div className="flex items-center justify-between mb-4">
                                    <label className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.15em] text-red-700">
                                      <Clock className="w-4 h-4" />
                                      Plan Window
                                    </label>
                                    {(editPlanStartsAt || editPlanEndsAt) && (
                                      <button type="button" onClick={() => { setEditPlanStartsAt(""); setEditPlanEndsAt(""); }}
                                        className="text-[9px] font-black text-slate-500 hover:text-red-600 uppercase tracking-wider transition-colors">Clear</button>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                      <label className="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Starts</label>
                                      <DateTimePicker value={editPlanStartsAt} onChange={setEditPlanStartsAt} />
                                    </div>
                                    <div>
                                      <label className="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Ends</label>
                                      <DateTimePicker value={editPlanEndsAt} onChange={setEditPlanEndsAt} />
                                    </div>
                                  </div>
                                  <div className="mt-3">
                                    <DurationQuickAdd baseDateStr={editPlanStartsAt} onApply={setEditPlanEndsAt} />
                                  </div>
                                  <p className="text-[11px] text-slate-500 mt-2 leading-snug">Locks access after end date. Telegram reminders last 7 days.</p>
                                </section>
                              )}
                          </div>

                          {/* Footer */}
                          <div className="flex-shrink-0 border-t border-slate-200 p-4 sm:p-5 flex flex-col-reverse sm:flex-row gap-2.5 sm:gap-3 bg-white">
                            <button onClick={() => { setEditingUserAccounts(null); setEditHint(null); }}
                              className="sm:flex-1 py-3.5 rounded-xl border-2 border-slate-200 bg-white text-slate-700 text-sm font-black uppercase tracking-widest hover:bg-slate-50 hover:border-slate-300 active:scale-[0.98] transition-all">
                              Cancel
                            </button>
                            <button onClick={() => updateUserAccounts(u.id)}
                              className="sm:flex-[2] py-3.5 rounded-xl text-white text-sm font-black uppercase tracking-widest bg-gradient-to-r from-red-600 via-rose-600 to-red-700 hover:from-red-700 hover:via-rose-700 hover:to-red-800 active:scale-[0.98] shadow-lg shadow-red-300/60 hover:shadow-red-400/70 transition-all font-['Sora',system-ui,sans-serif]">
                              Save Changes
                            </button>
                          </div>
                        </div>
                      </div>,
                      document.body
                    )}


                    {changingUserPass === u.id && createPortal(
                      <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center animate-in fade-in duration-200"
                        onClick={() => setChangingUserPass(null)}
                        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
                        <div className="absolute inset-0 bg-gradient-to-br from-slate-950/70 via-rose-950/60 to-slate-950/70 backdrop-blur-xl" />
                        <div onClick={(e) => e.stopPropagation()}
                          className="relative w-full sm:max-w-sm overflow-hidden bg-white sm:rounded-3xl rounded-t-3xl shadow-[0_-20px_80px_-10px_rgba(0,0,0,0.4)] sm:shadow-[0_30px_120px_-30px_rgba(244,63,94,0.5)] ring-1 ring-white/40 animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-300">
                          <div className="sm:hidden flex justify-center pt-2.5 pb-1"><div className="w-10 h-1 rounded-full bg-slate-300" /></div>
                          <div className="relative overflow-hidden px-5 pt-5 pb-16 bg-gradient-to-br from-rose-500 via-red-600 to-orange-600">
                            <div className="absolute inset-0 opacity-30" style={{ backgroundImage: "radial-gradient(circle at 20% 20%, rgba(255,255,255,0.4) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255,255,255,0.2) 0%, transparent 50%)" }} />
                            <div className="absolute -top-10 -right-10 w-48 h-48 rounded-full bg-white/15 blur-3xl" />
                            <div className="absolute -bottom-12 -left-8 w-40 h-40 rounded-full bg-white/10 blur-3xl" />
                            <div className="relative flex items-start justify-between">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="relative flex-shrink-0">
                                  <div className="absolute inset-0 bg-white/40 rounded-2xl blur-md" />
                                  <div className="relative w-12 h-12 rounded-2xl bg-white/20 ring-2 ring-white/60 shadow-xl flex items-center justify-center backdrop-blur-sm">
                                    <KeyRound className="w-5 h-5 text-white" strokeWidth={2.5} />
                                  </div>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-[9px] font-black tracking-[0.3em] text-white/80 uppercase mb-0.5">🔒 Reset Password</p>
                                  <p className="text-white font-black text-lg leading-tight truncate">{u.name}</p>
                                  <p className="text-white/70 text-[11px] font-mono truncate">{u.username ? `@${u.username}` : "no username"}</p>
                                </div>
                              </div>
                              <button onClick={() => setChangingUserPass(null)}
                                className="flex-shrink-0 w-9 h-9 rounded-2xl bg-white/20 hover:bg-white/35 text-white flex items-center justify-center transition-all active:scale-90 backdrop-blur-sm ring-1 ring-white/30">
                                <X className="w-4 h-4" strokeWidth={2.5} />
                              </button>
                            </div>
                          </div>
                          <div className="relative -mt-10 px-4 sm:px-5 pb-4">
                            <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl shadow-rose-200/40 p-4 space-y-3">
                              <div>
                                <label className="block text-[10px] font-black tracking-[0.2em] text-slate-500 uppercase mb-2">New Password</label>
                                <PasswordInput value={userNewPass} onChange={(e) => setUserNewPass(e.target.value)}
                                  placeholder="Min 6 characters"
                                  className="w-full bg-slate-50 border-2 border-slate-200 rounded-xl px-3 py-2.5 pr-10 outline-none focus:ring-2 focus:ring-rose-500/30 focus:border-rose-500 text-sm font-medium" />
                              </div>
                              <div className="flex items-start gap-2 p-3 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200">
                                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                                <p className="text-[11px] text-amber-900 leading-relaxed font-medium">Active sessions stay valid. Share the new password securely.</p>
                              </div>
                            </div>
                          </div>
                          <div className="border-t border-slate-100 p-3 flex gap-2 bg-gradient-to-b from-white to-slate-50">
                            <button onClick={() => setChangingUserPass(null)}
                              className="flex-1 py-3 rounded-2xl border-2 border-slate-200 bg-white text-slate-700 text-sm font-bold hover:bg-slate-50 hover:border-slate-300 active:scale-95 transition-all">
                              Cancel
                            </button>
                            <button onClick={() => changeUserPassword(u.id)}
                              className="flex-[2] py-3 rounded-2xl text-white text-sm font-black shadow-xl shadow-rose-500/40 bg-gradient-to-r from-rose-600 via-red-600 to-orange-600 hover:brightness-110 active:scale-95 transition-all">
                              Update Password
                            </button>
                          </div>
                        </div>
                      </div>,
                      document.body
                    )}
                      </div>
                    </div>
                  </div>

                  );
                })}
                {users.length === 0 && <p className="text-slate-400 text-sm text-center py-8">No users yet. Create one above.</p>}
              </div>
            </section>
          </div>
        )}

        {activeTab === "security" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-black text-base sm:text-lg flex items-center gap-2">
                  <div className="bg-blue-50 p-1.5 rounded-lg"><ShieldCheck className="w-4 h-4 text-blue-600" /></div>
                  CAPTCHA Protection
                </h2>
                <button onClick={toggleCaptcha}
                  className={`relative w-12 h-6 rounded-full transition-colors ${captchaEnabled ? "bg-green-500" : "bg-slate-300"}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${captchaEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
                </button>
              </div>
              <p className="text-xs text-slate-500 mb-4">{captchaEnabled ? "✅ CAPTCHA is active on all logins" : "⚠️ CAPTCHA is disabled — logins are unprotected"}</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Site Key</label>
                  <input type="text" placeholder="Enter Site Key" value={siteKey} onChange={(e) => setSiteKey(e.target.value)}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Secret Key</label>
                  <PasswordInput value={secretKeyVal} onChange={(e) => setSecretKeyVal(e.target.value)}
                    placeholder="Enter Secret Key"
                    className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <button onClick={saveRecaptchaSettings}
                  className="w-full bg-red-600 text-white font-bold py-3 rounded-xl hover:bg-red-700 transition-all text-sm">
                  Save Keys
                </button>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-purple-50 p-1.5 rounded-lg"><Filter className="w-4 h-4 text-purple-600" /></div>
                Email Filters
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div>
                    <p className="font-bold text-sm text-slate-900">Show Sign-In Code Emails</p>
                    <p className="text-xs text-slate-500 mt-1">When OFF, sign-in code & activity emails are hidden</p>
                  </div>
                  <button onClick={toggleSignInCodeFilter}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${showSignInCodes ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${showSignInCodes ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div>
                    <p className="font-bold text-sm text-slate-900">Show Password Reset Emails</p>
                    <p className="text-xs text-slate-500 mt-1">When OFF, password reset emails are hidden from inbox</p>
                  </div>
                  <button onClick={togglePasswordResetFilter}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${showPasswordResets ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${showPasswordResets ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div className="pr-3">
                    <p className="font-bold text-sm text-slate-900">Show Account Update Emails</p>
                    <p className="text-xs text-slate-500 mt-1">When OFF, Netflix "account info changed / email changed / membership cancelled / account deleted / on hold" emails are hidden from inbox. Telegram alerts are not affected.</p>
                  </div>
                  <button onClick={toggleAccountUpdateFilter}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${showAccountUpdates ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${showAccountUpdates ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-emerald-50 p-1.5 rounded-lg"><Mail className="w-4 h-4 text-emerald-600" /></div>
                User Email Visibility
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div className="pr-3">
                    <p className="font-bold text-sm text-slate-900">Limit how far back users can see emails</p>
                    <p className="text-xs text-slate-500 mt-1">When OFF, every user sees all cached Netflix emails. When ON, only emails from the last N days are visible to users (admins always see everything).</p>
                  </div>
                  <button onClick={() => saveEmailVisibility(!emailVisibilityEnabled)} disabled={savingEmailVisibility}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${emailVisibilityEnabled ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${emailVisibilityEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                  <div className="flex-1">
                    <label className="text-xs font-bold text-slate-700 mb-1 block">Days visible to users</label>
                    <input type="number" min={1} max={365} value={emailVisibilityDays}
                      onChange={(e) => setEmailVisibilityDays(e.target.value)}
                      disabled={!emailVisibilityEnabled}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-emerald-500 text-sm disabled:opacity-50" />
                  </div>
                  <button onClick={() => saveEmailVisibility()} disabled={savingEmailVisibility || !emailVisibilityEnabled}
                    className="bg-emerald-600 text-white font-bold py-3 px-5 rounded-xl hover:bg-emerald-700 transition-all text-sm disabled:opacity-50">
                    {savingEmailVisibility ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-amber-50 p-1.5 rounded-lg"><Mail className="w-4 h-4 text-amber-600" /></div>
                Netflix Marketing / Promo Emails
              </h2>
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                <div className="pr-3">
                  <p className="font-bold text-sm text-slate-900">Hide Netflix promotional emails from users</p>
                  <p className="text-xs text-slate-500 mt-1">Only affects emails from official Netflix domains (welcome, new releases, top 10, "start watching today", etc.). Transactional mail like sign-in codes, household verification, password resets and billing is always shown. <b>Default: OFF</b> — users see all official Netflix mail.</p>
                </div>
                <button onClick={() => saveBlockNetflixPromo(!blockNetflixPromo)} disabled={savingBlockPromo}
                  className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${blockNetflixPromo ? "bg-rose-500" : "bg-slate-300"}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${blockNetflixPromo ? "translate-x-6" : "translate-x-0.5"}`} />
                </button>
              </div>
            </section>


            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-rose-50 p-1.5 rounded-lg"><Trash2 className="w-4 h-4 text-rose-600" /></div>
                Auto-Delete Old Emails
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div className="pr-3">
                    <p className="font-bold text-sm text-slate-900">Automatic daily cleanup</p>
                    <p className="text-xs text-slate-500 mt-1">Runs once per day at the chosen hour and permanently deletes cached emails older than N days from the database.</p>
                  </div>
                  <button onClick={() => saveEmailAutoDelete(!emailAutoDeleteEnabled)} disabled={savingEmailAutoDelete}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${emailAutoDeleteEnabled ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${emailAutoDeleteEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-bold text-slate-700 mb-1 block">Delete older than (days)</label>
                    <input type="number" min={1} max={365} value={emailAutoDeleteDays}
                      onChange={(e) => setEmailAutoDeleteDays(e.target.value)}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-rose-500 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 mb-1 block">Run at hour (UTC, 0-23)</label>
                    <input type="number" min={0} max={23} value={emailAutoDeleteHour}
                      onChange={(e) => setEmailAutoDeleteHour(e.target.value)}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-rose-500 text-sm" />
                  </div>
                  <div className="flex items-end">
                    <button onClick={() => saveEmailAutoDelete()} disabled={savingEmailAutoDelete}
                      className="w-full bg-rose-600 text-white font-bold py-3 rounded-xl hover:bg-rose-700 transition-all text-sm disabled:opacity-50">
                      {savingEmailAutoDelete ? "Saving..." : (emailAutoDeleteEnabled ? "Update Schedule" : "Save")}
                    </button>
                  </div>
                </div>
              </div>
            </section>



            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-amber-50 p-1.5 rounded-lg"><Key className="w-4 h-4 text-amber-600" /></div>
                Change Admin Password
              </h2>
              <div className="space-y-3">
                <PasswordInput value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Current Password"
                  className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <PasswordInput value={newAdminPassword} onChange={(e) => setNewAdminPassword(e.target.value)}
                  placeholder="New Password"
                  className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <button onClick={changeAdminPassword} disabled={changingPassword}
                  className="w-full bg-red-600 text-white font-bold py-3 rounded-xl hover:bg-red-700 transition-all disabled:opacity-50 text-sm">
                  {changingPassword ? "Changing..." : "Change Password"}
                </button>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-2 flex items-center gap-2 text-slate-900">
                <div className="bg-indigo-50 p-1.5 rounded-lg"><Clock className="w-4 h-4 text-indigo-600" /></div>
                User Session Timeout
              </h2>
              <p className="text-xs text-slate-500 mb-4">
                Auto-logout for <span className="font-bold">end users</span> after this many minutes since login.
                Set <span className="font-bold">0</span> to disable.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1">User timeout (minutes)</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={sessionTimeoutMin}
                    onChange={(e) => setSessionTimeoutMin(e.target.value)}
                    placeholder="e.g. 5"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <button
                  onClick={saveSessionTimeout}
                  disabled={savingSessionTimeout}
                  className="sm:mt-5 bg-indigo-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-indigo-700 transition-all disabled:opacity-50 text-sm whitespace-nowrap">
                  {savingSessionTimeout ? "Saving..." : "Save"}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-3">
                Current: {Number(sessionTimeoutMin) > 0 ? `${sessionTimeoutMin} min auto-logout` : "Disabled — user sessions never expire"}
              </p>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-2 flex items-center gap-2 text-slate-900">
                <div className="bg-red-50 p-1.5 rounded-lg"><Shield className="w-4 h-4 text-red-600" /></div>
                Admin Session Timeout
              </h2>
              <p className="text-xs text-slate-500 mb-4">
                Auto-logout for the <span className="font-bold">admin panel</span> after this many minutes.
                Independent from the user timeout. Set <span className="font-bold">0</span> to disable.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1">Admin timeout (minutes)</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={adminSessionTimeoutMin}
                    onChange={(e) => setAdminSessionTimeoutMin(e.target.value)}
                    placeholder="e.g. 15"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <button
                  onClick={saveAdminSessionTimeout}
                  disabled={savingAdminSessionTimeout}
                  className="sm:mt-5 bg-red-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-red-700 transition-all disabled:opacity-50 text-sm whitespace-nowrap">
                  {savingAdminSessionTimeout ? "Saving..." : "Save"}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-3">
                Current: {Number(adminSessionTimeoutMin) > 0 ? `${adminSessionTimeoutMin} min auto-logout` : "Disabled — admin sessions never expire"}
              </p>
            </section>

            {/* Location policy — per profile */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-2 flex items-center gap-2 text-slate-900">
                <div className="bg-sky-50 p-1.5 rounded-lg"><MapPin className="w-4 h-4 text-sky-600" /></div>
                Location Policy
              </h2>
              <p className="text-xs text-slate-500 mb-2">
                GPS is ON by default for every user profile. Use the map-pin toggle in <b>Active Users</b> only when you want to turn GPS OFF for a specific profile.
              </p>
              <p className="text-[11px] text-slate-400">Default is <b>GPS REQUIRED</b>; OFF sends only minimal device/browser/IP alert.</p>
            </section>

            {/* Free-profile behavior note (uses User Session Timeout above) */}
            <section className="bg-emerald-50/40 p-5 sm:p-6 rounded-2xl border border-emerald-200 shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-2 flex items-center gap-2 text-emerald-900">
                <div className="bg-emerald-100 p-1.5 rounded-lg"><Clock className="w-4 h-4 text-emerald-700" /></div>
                Free Profiles — how sessions work
              </h2>
              <p className="text-xs text-emerald-900/80">
                Free profiles use the <b>User Session Timeout</b> value above. Every free login gets its
                own countdown from its own login time — unlimited concurrent free logins, no eviction.
                Each session auto-logs out after {Number(sessionTimeoutMin) > 0 ? `${sessionTimeoutMin} min` : "never (currently disabled)"}.
              </p>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-2 flex items-center gap-2 text-slate-900">
                <div className="bg-emerald-50 p-1.5 rounded-lg"><Shield className="w-4 h-4 text-emerald-600" /></div>
                Concurrent Session Limit
              </h2>
              <p className="text-xs text-slate-500 mb-4">
                Max active sessions/devices per user at the same time. When a user logs in and would exceed
                this cap, the <span className="font-bold">oldest session is revoked</span> and that device is
                logged out. Set <span className="font-bold">1</span> for single-device login, or
                <span className="font-bold"> 0</span> to allow unlimited.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1">Max sessions per user</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={concurrentSessionLimit}
                    onChange={(e) => setConcurrentSessionLimit(e.target.value)}
                    placeholder="e.g. 1"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <button
                  onClick={saveConcurrentSessionLimit}
                  disabled={savingConcurrentSessionLimit}
                  className="sm:mt-5 bg-emerald-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-emerald-700 transition-all disabled:opacity-50 text-sm whitespace-nowrap">
                  {savingConcurrentSessionLimit ? "Saving..." : "Save"}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-3">
                Current: {Number(concurrentSessionLimit) > 0
                  ? `${concurrentSessionLimit} active session${Number(concurrentSessionLimit) === 1 ? "" : "s"} per user — extra logins kick the oldest device out`
                  : "Unlimited — users can be signed in on any number of devices at once"}
              </p>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-2 flex items-center gap-2 text-slate-900">
                <div className="bg-emerald-50 p-1.5 rounded-lg"><Shield className="w-4 h-4 text-emerald-600" /></div>
                Free Profile Avatar Cooldown
              </h2>
              <p className="text-xs text-slate-500 mb-4">
                Global rate limit for free profiles changing their avatar. When any free user updates
                their icon, <span className="font-bold">all other free users</span> must wait this many
                minutes before they can change theirs. Paid and admin accounts are unaffected.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1">Cooldown (minutes)</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={freeAvatarCooldownMin}
                    onChange={(e) => setFreeAvatarCooldownMinState(e.target.value)}
                    placeholder="e.g. 5"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <button
                  onClick={saveFreeAvatarCooldown}
                  disabled={savingFreeAvatarCooldown}
                  className="sm:mt-5 bg-emerald-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-emerald-700 transition-all disabled:opacity-50 text-sm whitespace-nowrap">
                  {savingFreeAvatarCooldown ? "Saving..." : "Save"}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-3">
                Current: every free avatar change locks the icon change globally for {freeAvatarCooldownMin || 5} min.
              </p>
            </section>





            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-red-50 p-1.5 rounded-lg"><Send className="w-4 h-4 text-red-600" /></div>
                ipwho.is provider
              </h2>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Enable ipwho.is for login location</p>
                  <p className="text-xs text-slate-500 mt-1">When OFF, ipwho.is is not called at all — no IP goes to ipwho.is and the extra ipwho.is Telegram dump is not sent. Other providers (ipapi.co, ip-api.com, ipinfo.io, freeipapi.com) and device GPS still work.</p>
                </div>
                <button onClick={toggleIpwhoAlert} disabled={savingIpwho}
                  className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${ipwhoAlertEnabled ? "bg-green-500" : "bg-slate-300"}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${ipwhoAlertEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
                </button>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-emerald-50 p-1.5 rounded-lg"><ShieldCheck className="w-4 h-4 text-emerald-600" /></div>
                Login GPS
              </h2>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Require GPS for user logins</p>
                  <p className="text-xs text-slate-500 mt-1">When ON, both paid and free profiles must solve CAPTCHA and grant location before entering. When OFF, profiles sign in without the browser location popup.</p>
                </div>
                <button onClick={toggleLocationPolicy} disabled={savingLocationPolicy}
                  className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${locationPolicyRequired ? "bg-green-500" : "bg-slate-300"}`}
                  aria-label="Toggle GPS requirement">
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${locationPolicyRequired ? "translate-x-6" : "translate-x-0.5"}`} />
                </button>
              </div>
            </section>

            {/* TV Auto-Login card removed — full controls live in the dedicated "TV Auto-Login" admin tab */}



            {/* --- Cloudflare R2 Storage (for notification images) --- */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-start justify-between gap-4 mb-4">
                <h2 className="font-black text-base sm:text-lg flex items-center gap-2 text-slate-900">
                  <div className="bg-orange-50 p-1.5 rounded-lg"><HardDrive className="w-4 h-4 text-orange-600" /></div>
                  Cloudflare R2 Storage
                </h2>
                <label className="inline-flex items-center gap-2 cursor-pointer flex-shrink-0">
                  <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">{r2Cfg.enabled ? "Enabled" : "Disabled"}</span>
                  <button
                    type="button"
                    onClick={() => updateR2Cfg({ enabled: !r2Cfg.enabled })}
                    className={`relative w-12 h-6 rounded-full transition-colors ${r2Cfg.enabled ? "bg-green-500" : "bg-slate-300"}`}
                    aria-label="Toggle R2 enabled"
                  >
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${r2Cfg.enabled ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </label>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                Where notification hero images live. Admins can view and edit every R2 value here; the app uses exactly what is saved, with no hardcoded fallback.
                When disabled, admins can still paste an https image URL manually.
              </p>

              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Account ID</label>
                    <input value={r2Cfg.accountId} onChange={(e) => updateR2Cfg({ accountId: e.target.value })}
                      placeholder="abcdef1234567890"
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Bucket</label>
                    <input value={r2Cfg.bucket} onChange={(e) => updateR2Cfg({ bucket: e.target.value })}
                      placeholder="notification-media"
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Access Key ID</label>
                  <input value={r2Cfg.accessKeyId} onChange={(e) => updateR2Cfg({ accessKeyId: e.target.value })}
                    placeholder="R2 API token — Access Key ID"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                </div>
                <div>
                  <label className="flex items-center justify-between text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                    <span>Secret Access Key {r2Cfg.secretAccessKeySet && (
                      <span className="ml-2 text-emerald-600 normal-case tracking-normal">✓ configured</span>
                    )}</span>
                  </label>
                  <input type="text" value={r2Cfg.secretAccessKey}
                    onChange={(e) => updateR2Cfg({ secretAccessKey: e.target.value })}
                    placeholder="Paste secret access key"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Public Base URL</label>
                    <input value={r2Cfg.publicBaseUrl} onChange={(e) => updateR2Cfg({ publicBaseUrl: e.target.value })}
                      placeholder="https://cdn.example.com  (or  https://pub-xxx.r2.dev)"
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                    <p className="text-[10.5px] text-slate-400 mt-1">Custom domain, or the r2.dev URL enabled on the bucket.</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Path Prefix</label>
                    <input value={r2Cfg.pathPrefix} onChange={(e) => updateR2Cfg({ pathPrefix: e.target.value })}
                      placeholder="notifications/"
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <button onClick={saveR2Config} disabled={r2Saving}
                    className="bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-bold py-2.5 px-5 rounded-lg text-sm inline-flex items-center gap-2">
                    <HardDrive className="w-4 h-4" /> {r2Saving ? "Saving…" : "Save R2 Settings"}
                  </button>
                  <button onClick={testR2Connection} disabled={r2Testing || (!r2Cfg.accountId || !r2Cfg.accessKeyId || !r2Cfg.bucket || (!r2Cfg.secretAccessKey && !r2Cfg.secretAccessKeySet))}
                    className="bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white font-bold py-2.5 px-5 rounded-lg text-sm inline-flex items-center gap-2">
                    <Zap className="w-4 h-4" /> {r2Testing ? "Testing…" : "Test Typed Values"}
                  </button>
                </div>

                {r2TestResult && (
                  <div className={`mt-2 p-3 rounded-lg text-xs border ${r2TestResult.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-800"}`}>
                    <div className="font-bold flex items-center gap-2">
                      {r2TestResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                      {r2TestResult.ok ? "Typed R2 values valid" : "R2 test failed"}
                      {typeof r2TestResult.latencyMs === "number" && <span className="font-normal opacity-70">· {r2TestResult.latencyMs}ms</span>}
                    </div>
                    <div className="mt-1 opacity-90 break-words">{r2TestResult.message}</div>
                    {Array.isArray(r2TestResult.warnings) && r2TestResult.warnings.length > 0 && (
                      <ul className="mt-2 list-disc pl-4 space-y-1 text-amber-700">
                        {r2TestResult.warnings.map((warning, idx) => <li key={idx}>{warning}</li>)}
                      </ul>
                    )}
                    {r2TestResult.ok && r2TestResult.publicUrlWorks === false && (
                      <div className="mt-1 text-amber-700">⚠️ Upload signed OK but the public URL was not reachable — check your public domain / r2.dev setup and CORS.</div>
                    )}
                  </div>
                )}

                <details className="mt-2 text-xs text-slate-600">
                  <summary className="cursor-pointer font-semibold text-slate-700">Setup help — R2 API token permissions & CORS</summary>
                  <div className="mt-2 space-y-2 pl-2">
                    <p><span className="font-semibold">API token:</span> Cloudflare dashboard → R2 → Manage R2 API Tokens → Create with <span className="font-mono bg-slate-100 px-1 rounded">Object Read &amp; Write</span> scoped to this bucket.</p>
                    <p><span className="font-semibold">Public access:</span> Either connect a custom domain to the bucket, or turn on the r2.dev subdomain (Settings → Public access). Paste that URL as "Public Base URL".</p>
                    <p><span className="font-semibold">CORS (for image display in the browser):</span></p>
                    <pre className="bg-slate-900 text-slate-100 p-3 rounded-lg overflow-x-auto text-[11px]">{`[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]`}</pre>
                    <p className="text-slate-500">Uploads are signed server-side (via edge function) so browser CORS is only needed for GET/HEAD when displaying the images.</p>
                  </div>
                </details>
              </div>
            </section>
          </div>
        )}


        {activeTab === "logins" && (
          <LoginEventsPanel />
        )}

        {activeTab === "allmails" && (
          <AllEmailsPanel />
        )}

        {activeTab === "tv" && (
          <div className="max-w-4xl mx-auto space-y-5">
            {/* Header — plain, no stats, no gradients */}
            <div className="px-1">
              <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-950 flex items-center gap-2.5">
                <span className="inline-flex w-9 h-9 rounded-xl bg-slate-900 text-white items-center justify-center shadow-sm"><Tv className="w-5 h-5" /></span>
                TV Remote Access
              </h2>
              <p className="text-sm text-slate-500 mt-1.5 ml-[46px]">Decide who sees the <b className="text-slate-800">Login on TV</b> button in their header.</p>
            </div>

            {/* Global — one iOS-style switch, one sentence */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-base sm:text-lg font-bold text-slate-950 leading-snug">Everyone gets the TV button</p>
                  <p className="text-[13px] text-slate-500 mt-1 leading-relaxed">
                    {tvFeatureEnabled
                      ? "It's on. Every profile below sees the TV button — unless you turn a person off."
                      : "It's off. Nobody sees the TV button — unless you turn a person on."}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={tvFeatureEnabled}
                  onClick={() => { void toggleTvFeature(); }}
                  disabled={savingTvFeature}
                  className={`relative shrink-0 w-[62px] h-[34px] rounded-full transition-colors duration-200 disabled:opacity-60 focus:outline-none focus:ring-4 ring-offset-2 ${tvFeatureEnabled ? "bg-emerald-500 ring-emerald-200" : "bg-slate-300 ring-slate-200"}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-[30px] h-[30px] bg-white rounded-full shadow-md transition-transform duration-200 ease-out flex items-center justify-center ${tvFeatureEnabled ? "translate-x-[28px]" : "translate-x-0"}`}>
                    {tvFeatureEnabled ? <Eye className="w-3.5 h-3.5 text-emerald-600" /> : <EyeOff className="w-3.5 h-3.5 text-slate-400" />}
                  </span>
                </button>
              </div>
            </section>

            {/* GitHub Actions Runner Setup — one-click sync */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex w-8 h-8 rounded-lg bg-slate-950 text-white items-center justify-center"><Zap className="w-4 h-4" /></span>
                    <p className="text-base sm:text-lg font-bold text-slate-950 leading-snug">GitHub Actions runner</p>
                    {ghSetupStatus?.configured ? (
                      <span className="text-[10px] font-black uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">Ready</span>
                    ) : (
                      <span className="text-[10px] font-black uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Not set up</span>
                    )}
                  </div>
                  <p className="text-[13px] text-slate-500 mt-1 leading-relaxed">
                    {ghSetupStatus?.configured
                      ? <>Linked to <b className="text-slate-800">{ghSetupStatus.repo || "your repo"}</b>. HMAC key is auto-managed — no manual GitHub secrets to sync.</>
                      : <>Paste a GitHub token once. We auto-detect the repo, generate an HMAC key, and push it to GitHub Actions secrets.</>}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setGhSetupOpen((v) => !v)}
                    className="h-10 px-4 rounded-lg border border-slate-300 bg-white text-slate-900 text-xs font-bold hover:bg-slate-50 inline-flex items-center gap-1.5"
                  >
                    <Settings className="w-3.5 h-3.5" /> {ghSetupStatus?.configured ? "Rotate" : "Set up"}
                  </button>
                  <button
                    type="button"
                    onClick={testGithubRunner}
                    disabled={githubTesting || !ghSetupStatus?.configured}
                    className="h-10 px-4 rounded-lg bg-slate-950 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {githubTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Test
                  </button>
                </div>
              </div>
              {ghSetupOpen && (
                <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">GitHub Personal Access Token</label>
                    <div className="relative mt-1">
                      <input
                        type={ghSetupPatVisible ? "text" : "password"}
                        value={ghSetupPat}
                        onChange={(e) => setGhSetupPat(e.target.value)}
                        placeholder={ghSetupStatus?.hasPat ? "•••••••••••••• (saved — paste to replace)" : "github_pat_11A..."}
                        className="w-full h-11 pl-3 pr-11 rounded-lg border border-slate-300 bg-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-950/10"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const next = !ghSetupPatVisible;
                          setGhSetupPatVisible(next);
                          if (next && !ghSetupPat && ghSetupStatus?.hasPat) void revealSavedPat();
                        }}
                        aria-label={ghSetupPatVisible ? "Hide token" : "Show token"}
                        className="absolute inset-y-0 right-0 w-11 flex items-center justify-center text-slate-500 hover:text-slate-900"
                      >
                        {ghSetupPatVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <details className="mt-2 rounded-lg border border-slate-200 bg-slate-50 open:bg-white overflow-hidden group">
                      <summary className="cursor-pointer select-none list-none px-3 py-2.5 flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-700 hover:bg-slate-100">
                        <span className="inline-flex items-center gap-1.5"><HelpCircle className="w-3.5 h-3.5" /> PAT kaise banaye? (step-by-step)</span>
                        <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="px-4 py-3 border-t border-slate-200 space-y-3 text-[12px] leading-relaxed text-slate-700">
                        <div>
                          <p className="font-bold text-slate-900">1. GitHub me login karo</p>
                          <p className="text-slate-600">Us account me jismein tumhara repo hai (jahan Actions chalane hain).</p>
                        </div>
                        <div>
                          <p className="font-bold text-slate-900">2. Fine-grained token page kholo</p>
                          <a
                            href="https://github.com/settings/personal-access-tokens/new"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 mt-1 h-8 px-3 rounded-md bg-slate-950 text-white text-[11px] font-bold hover:bg-slate-800"
                          >
                            <ExternalLink className="w-3 h-3" /> Open GitHub token page
                          </a>
                          <p className="text-[11px] text-slate-500 mt-1.5">Manual: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new</p>
                        </div>
                        <div>
                          <p className="font-bold text-slate-900">3. Form bharo</p>
                          <ul className="mt-1 space-y-1 text-slate-600 list-disc pl-4">
                            <li><b>Token name:</b> koi bhi naam chalega (e.g. <code className="px-1 py-0.5 rounded bg-slate-100 text-slate-800">lovable-tv-runner</code>) — sirf tumhare reference ke liye hai</li>
                            <li><b>Expiration:</b> 1 year (ya custom)</li>
                            <li><b>Resource owner:</b> apna username / org</li>
                            <li><b>Repository access:</b> <i>Only select repositories</i> → apna repo choose karo</li>
                          </ul>
                        </div>
                        <div>
                          <p className="font-bold text-slate-900">4. Permissions (Repository permissions)</p>
                          <div className="mt-1 rounded-md border border-slate-200 overflow-hidden text-[11px]">
                            <div className="grid grid-cols-2 bg-slate-100 font-bold text-slate-700 px-2 py-1.5"><span>Permission</span><span>Access</span></div>
                            <div className="grid grid-cols-2 px-2 py-1.5 border-t border-slate-100"><span>Actions</span><span className="font-mono">Read and write</span></div>
                            <div className="grid grid-cols-2 px-2 py-1.5 border-t border-slate-100"><span>Secrets</span><span className="font-mono">Read and write</span></div>
                            <div className="grid grid-cols-2 px-2 py-1.5 border-t border-slate-100"><span>Metadata</span><span className="font-mono">Read-only (auto)</span></div>
                          </div>
                          <p className="text-[11px] text-slate-500 mt-1.5">Contents permission zaroori nahi hai. Baaki sab <b>No access</b> chhod do.</p>
                        </div>
                        <div>
                          <p className="font-bold text-slate-900">5. Generate token → copy karo</p>
                          <p className="text-slate-600">Token <code className="px-1 py-0.5 rounded bg-slate-100 text-slate-800">github_pat_11...</code> se start hoga. Sirf ek baar dikhega — turant copy karke upar wale field me paste karo.</p>
                        </div>
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                          <b>Org repo hai?</b> Agar "Resource owner" me org nahi dikh raha, org owner ko Settings → Third-party Access → Personal access tokens me fine-grained tokens allow karne padenge. Ya <a className="underline font-bold" href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=lovable-tv-runner" target="_blank" rel="noopener noreferrer">classic PAT (repo + workflow scope)</a> use karo — wo bhi kaam karega.
                        </div>
                      </div>
                    </details>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Repo (optional)</label>
                    <input
                      value={ghSetupRepo}
                      onChange={(e) => setGhSetupRepo(e.target.value)}
                      placeholder="auto-detected (owner/name)"
                      className="mt-1 w-full h-11 px-3 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-slate-950/10"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={runGhSetup}
                    disabled={ghSetupSyncing}
                    className="w-full h-11 rounded-lg bg-slate-950 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-60 inline-flex items-center justify-center gap-2"
                  >
                    {ghSetupSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {ghSetupStatus?.configured ? "Rotate HMAC key & sync" : "Sync GitHub setup"}
                  </button>
                  {ghSetupStatus?.updatedAt && (
                    <p className="text-[11px] text-slate-400 text-center">Last synced {new Date(ghSetupStatus.updatedAt).toLocaleString()}</p>
                  )}
                </div>
              )}
            </section>

            {/* People */}

            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 sm:px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="font-bold text-slate-950">People</h3>
                  <span className="text-[11px] font-bold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">{filteredTvUsers.length}</span>
                </div>
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    value={tvSearch}
                    onChange={(e) => setTvSearch(e.target.value)}
                    placeholder="Search name or @username"
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 bg-slate-50 text-sm outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300 focus:bg-white transition"
                  />
                </div>
              </div>

              <ul className="divide-y divide-slate-100">
                {filteredTvUsers.map((u) => {
                  const ov = normalizeTvOverride(u.tvOverride);
                  const effective = ov === "on" ? true : ov === "off" ? false : tvFeatureEnabled;
                  const overridden = ov !== null;
                  return (
                    <li key={u.id} className="flex items-center gap-3 sm:gap-4 px-5 sm:px-6 py-3.5 hover:bg-slate-50/60 transition-colors">
                      <ProfileAvatar avatarId={getStableProfileAvatar(u)} name={u.name} className="w-10 h-10 !rounded-full ring-1 ring-slate-200 shadow-sm shrink-0" fallbackColor={u.isFree ? "bg-emerald-500" : "bg-blue-500"} />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                          <p className="text-[14px] font-bold text-slate-900 truncate">{u.name}</p>
                          <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${effective ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${effective ? "bg-emerald-500" : "bg-slate-400"}`} />
                            {effective ? "Visible" : "Hidden"}
                          </span>
                          {overridden && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 shrink-0">
                              Custom
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-0.5 min-w-0">
                          <span className="font-mono truncate">{u.username ? `@${u.username}` : "free profile"}</span>
                          {overridden && (
                            <button
                              type="button"
                              onClick={() => { void setProfileTvOverride(u, "inherit"); }}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 shrink-0"
                              title="Remove custom setting — follow the global switch"
                            >
                              ↺ Reset
                            </button>
                          )}
                        </div>
                      </div>


                      {/* Two-state segmented switch: Show / Hide.
                          Highlights the *effective* state (so global OFF auto-ticks Hide
                          for everyone without an override). Overridden = solid color,
                          inherited-from-global = soft tint. */}
                      <div className="shrink-0 inline-flex p-0.5 rounded-full bg-slate-100 border border-slate-200">
                        {([
                          { value: "on" as const,  label: "Show", Icon: Eye,    solid: "bg-emerald-500 text-white shadow-sm", soft: "bg-emerald-100 text-emerald-700" },
                          { value: "off" as const, label: "Hide", Icon: EyeOff, solid: "bg-slate-900 text-white shadow-sm",   soft: "bg-slate-200 text-slate-700" },
                        ]).map((opt) => {
                          const isEffective = (opt.value === "on") === effective;
                          const isOverride = ov === opt.value;
                          const Icon = opt.Icon;
                          const cls = isOverride ? opt.solid : isEffective ? opt.soft : "text-slate-500 hover:text-slate-800";
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => { void setProfileTvOverride(u, opt.value); }}
                              className={`inline-flex items-center gap-1.5 px-3 sm:px-3.5 h-8 rounded-full text-[12px] font-bold transition-all active:scale-[0.97] ${cls}`}
                              aria-pressed={isEffective}
                            >
                              <Icon className="w-3.5 h-3.5" />
                              <span>{opt.label}</span>
                            </button>
                          );
                        })}
                      </div>

                    </li>
                  );
                })}

                {filteredTvUsers.length === 0 && (
                  <li className="px-6 py-16 text-center">
                    <div className="inline-flex p-3 rounded-full bg-slate-100 mb-3"><Search className="w-5 h-5 text-slate-400" /></div>
                    <p className="text-sm font-bold text-slate-700">No people match your search</p>
                    <p className="text-xs text-slate-500 mt-1">Try a different name or username.</p>
                  </li>
                )}
              </ul>
            </section>

            {/* TV Runner — clean white redesign, no testing clutter */}
            <section className="bg-white rounded-3xl border border-slate-200 overflow-hidden">
              {/* Hero */}
              <div className="px-6 sm:px-8 pt-7 pb-6">
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">TV Runner</p>
                <h3 className="mt-1 text-2xl sm:text-[26px] font-black tracking-tight text-slate-950">Where should Netflix open?</h3>
                <p className="mt-1.5 text-[13px] text-slate-500">One choice. Change anytime. VPS is instant, GitHub is free.</p>

                {/* Segmented mode switch */}
                <div className="mt-5 grid grid-cols-2 gap-1.5 p-1.5 rounded-2xl bg-slate-100">
                  {([
                    { id: "vps", label: "My VPS", hint: "Fast" },
                    { id: "github", label: "GitHub Actions", hint: "Free" },
                  ] as const).map((opt) => {
                    const active = vpsCfg.mode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setVpsCfg((p) => ({ ...p, mode: opt.id }))}
                        className={`h-12 rounded-xl text-[13px] font-black transition flex items-center justify-center gap-2 ${active ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                      >
                        {opt.label}
                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-md ${active ? "bg-slate-950 text-white" : "bg-slate-200 text-slate-500"}`}>{opt.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Body */}
              {vpsCfg.mode === "vps" ? (
                <div className="px-6 sm:px-8 pb-7 pt-1 space-y-5">
                  <div>
                    <label className="text-[11px] font-black uppercase tracking-wider text-slate-500">Server IP</label>
                    <input
                      value={vpsCfg.ip}
                      onChange={(e) => setVpsCfg((p) => ({ ...p, ip: e.target.value }))}
                      placeholder="140.238.226.213"
                      className="mt-2 w-full h-12 rounded-xl border border-slate-200 bg-white px-4 font-mono text-[14px] font-bold text-slate-950 outline-none focus:border-slate-950 focus:ring-2 focus:ring-slate-950/10"
                    />
                  </div>


                  <div>
                    <label className="text-[11px] font-black uppercase tracking-wider text-slate-500">SSH Private Key</label>
                    <div className="mt-2 rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${vpsCfg.hasKey ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
                          <KeyRound className="w-5 h-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-black text-slate-950 truncate">
                            {vpsCfg.hasKey ? vpsCfg.keyFilename : "No key uploaded"}
                          </p>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            {vpsCfg.hasKey
                              ? `${vpsCfg.keySize ? (vpsCfg.keySize / 1024).toFixed(1) + " KB · " : ""}Stored in Cloudflare R2`
                              : "Upload a .pem or .key file"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => vpsFileInputRef.current?.click()}
                          disabled={vpsUploading || vpsLoading}
                          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-slate-950 px-3 text-[12px] font-black text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          {vpsUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                          {vpsCfg.hasKey ? "Replace" : "Upload"}
                        </button>
                        <button
                          type="button"
                          onClick={downloadSshKey}
                          disabled={vpsLoading || !vpsCfg.hasKey}
                          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[12px] font-black text-slate-800 hover:bg-slate-50 disabled:opacity-40"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </button>
                        <input
                          ref={vpsFileInputRef}
                          type="file"
                          accept=".pem,.key,.txt,*/*"
                          className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadVpsKeyFile(f); }}
                        />
                      </div>

                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={saveVpsConfig}
                    disabled={vpsSaving || vpsLoading}
                    className="w-full h-12 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 text-[13px] font-black text-white hover:bg-slate-800 disabled:opacity-60"
                  >
                    {vpsSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Save changes
                  </button>
                </div>
              ) : (
                <div className="px-6 sm:px-8 pb-7 pt-1 space-y-4">
                  <div className="rounded-xl border border-slate-200 bg-white p-5">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-950 text-white flex items-center justify-center shrink-0">
                        <Zap className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[14px] font-black text-slate-950">Nothing to configure</p>
                        <p className="mt-1 text-[12px] text-slate-500 leading-relaxed">
                          GitHub Actions runs on their free servers. Slower (~45s per code) but no VPS to manage.
                        </p>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={saveVpsConfig}
                    disabled={vpsSaving || vpsLoading}
                    className="w-full h-12 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 text-[13px] font-black text-white hover:bg-slate-800 disabled:opacity-60"
                  >
                    {vpsSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Use GitHub Actions
                  </button>
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === "cookies" && <CookiesTab emailAccounts={emailAccounts} />}

        {activeTab === "directlink" && (
          <div className="max-w-4xl mx-auto space-y-5">
            {/* Header — mirrors TV Auto-Login */}
            <div className="px-1">
              <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-950 flex items-center gap-2.5">
                <span className="inline-flex w-9 h-9 rounded-xl bg-slate-900 text-white items-center justify-center shadow-sm"><LinkIcon className="w-5 h-5" /></span>
                Direct Link Access
              </h2>
              <p className="text-sm text-slate-500 mt-1.5 ml-[46px]">Decide who can generate <b className="text-slate-800">Netflix Direct Links</b> from their workflow.</p>
            </div>

            {/* Summary — one card, one sentence */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6">
              {(() => {
                const nonAdmins = users.filter((u) => u.role !== "admin");
                const on = nonAdmins.filter((u) => adminUserFeatures(u).link).length;
                const total = nonAdmins.length;
                return (
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-base sm:text-lg font-bold text-slate-950 leading-snug">{on} of {total} profiles enabled</p>
                      <p className="text-[13px] text-slate-500 mt-1 leading-relaxed">
                        {on === 0
                          ? "No one has Direct Link access yet — toggle any profile below to enable."
                          : on === total
                          ? "Every profile below can generate Netflix Direct Links from their workflow page."
                          : "Green means enabled — toggle any profile below to change access."}
                      </p>
                    </div>
                    <span className="shrink-0 inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">
                      <LinkIcon className="w-3 h-3" />
                      Direct Link
                    </span>
                  </div>
                );
              })()}
            </section>

            {/* People */}
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 sm:px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="font-bold text-slate-950">People</h3>
                  <span className="text-[11px] font-bold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">{filteredDirectUsers.length}</span>
                </div>
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    value={directSearch}
                    onChange={(e) => setDirectSearch(e.target.value)}
                    placeholder="Search name or @username"
                    className="w-full h-10 pl-9 pr-3 rounded-xl border border-slate-200 bg-slate-50 text-sm outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300 focus:bg-white transition"
                  />
                </div>
              </div>

              <ul className="divide-y divide-slate-100">
                {filteredDirectUsers.map((u) => {
                  const enabled = adminUserFeatures(u).link === true;
                  return (
                    <li key={u.id} className="flex items-center gap-3 sm:gap-4 px-5 sm:px-6 py-3.5 hover:bg-slate-50/60 transition-colors">
                      <ProfileAvatar avatarId={getStableProfileAvatar(u)} name={u.name} className="w-10 h-10 !rounded-full ring-1 ring-slate-200 shadow-sm shrink-0" fallbackColor={u.isFree ? "bg-emerald-500" : "bg-blue-500"} />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                          <p className="text-[14px] font-bold text-slate-900 truncate">{u.name}</p>
                          <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-emerald-500" : "bg-slate-400"}`} />
                            {enabled ? "Enabled" : "Disabled"}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-0.5 min-w-0">
                          <span className="font-mono truncate">{u.username ? `@${u.username}` : "free profile"}</span>
                          {enabled && (
                            <button
                              type="button"
                              onClick={() => loginAsUser(u, "link")}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 shrink-0"
                              title="Open this user's Direct Link page"
                            >
                              ↗ Open
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Two-state segmented switch: Enable / Disable */}
                      <div className="shrink-0 inline-flex p-0.5 rounded-full bg-slate-100 border border-slate-200">
                        {([
                          { value: true,  label: "Enable",  Icon: Eye,    solid: "bg-emerald-500 text-white shadow-sm", soft: "bg-emerald-100 text-emerald-700" },
                          { value: false, label: "Disable", Icon: EyeOff, solid: "bg-slate-900 text-white shadow-sm",   soft: "bg-slate-200 text-slate-700" },
                        ]).map((opt) => {
                          const isActive = enabled === opt.value;
                          const Icon = opt.Icon;
                          const cls = isActive ? opt.solid : "text-slate-500 hover:text-slate-800";
                          return (
                            <button
                              key={String(opt.value)}
                              type="button"
                              onClick={() => { if (enabled !== opt.value) toggleUserFeature(u, "link"); }}
                              className={`inline-flex items-center gap-1.5 px-3 sm:px-3.5 h-8 rounded-full text-[12px] font-bold transition-all active:scale-[0.97] ${cls}`}
                              aria-pressed={isActive}
                            >
                              <Icon className="w-3.5 h-3.5" />
                              <span>{opt.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </li>
                  );
                })}

                {filteredDirectUsers.length === 0 && (
                  <li className="px-6 py-16 text-center">
                    <div className="inline-flex p-3 rounded-full bg-slate-100 mb-3"><Search className="w-5 h-5 text-slate-400" /></div>
                    <p className="text-sm font-bold text-slate-700">No people match your search</p>
                    <p className="text-xs text-slate-500 mt-1">Try a different name or username.</p>
                  </li>
                )}
              </ul>
            </section>
          </div>
        )}




        {activeTab === "notifications" && (
          <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_1fr] gap-4 sm:gap-6">
            {/* --- Composer (light theme) --- */}
            <section className="bg-white p-5 sm:p-7 rounded-2xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
                <div className="bg-slate-900 p-2 rounded-xl">
                  <Bell className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h2 className="font-bold text-slate-900 text-base sm:text-lg leading-tight">New Notification</h2>
                  <p className="text-[11px] text-slate-500">Compose once. Publish to the right people.</p>
                </div>
              </div>

              <div className="space-y-4">
                {/* Title + Link URL side by side */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Title <span className="text-rose-500">*</span></label>
                    <input value={notifTitle} onChange={(e) => setNotifTitle(e.target.value)} placeholder="e.g. Join our Telegram Group"
                      className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/5 transition-all" />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Link URL</label>
                    <input value={notifActionUrl} onChange={(e) => setNotifActionUrl(e.target.value)} placeholder="https://t.me/yourchannel"
                      className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/5 transition-all" />
                  </div>
                </div>

                {/* Message */}
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Message <span className="text-rose-500">*</span></label>
                  <textarea value={notifBody} onChange={(e) => setNotifBody(e.target.value)} placeholder="e.g. Join our Telegram group for daily updates, free PDFs and notifications." rows={3}
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/5 transition-all resize-none" />
                </div>

                {/* Notification Template */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Notification Type</label>
                    {notifTemplate && (
                      <button type="button" onClick={() => setNotifTemplate("")} className="text-[10px] font-semibold text-slate-500 hover:text-slate-900">Clear</button>
                    )}
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-2">
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-[132px] overflow-y-auto pr-1">
                      {TEMPLATE_OPTIONS.map((t) => {
                        const active = notifTemplate === t.id;
                        return (
                          <button key={t.id} type="button" onClick={() => setNotifTemplate(t.id)} title={t.hint}
                            className={`flex items-center gap-2 px-2 py-2 rounded-lg border transition-all min-w-0 ${active ? "bg-white border-slate-900 shadow-sm" : "bg-white border-slate-200 hover:border-slate-300"}`}>
                            <div className="w-6 h-6 rounded-md flex items-center justify-center text-white shrink-0" style={{ background: t.color }}>
                              <TemplateIcon id={t.id} className="w-3 h-3" />
                            </div>
                            <span className={`text-[10.5px] font-semibold truncate ${active ? "text-slate-900" : "text-slate-600"}`}>{t.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Platform / Icon */}
                <div>
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Platform / Icon</label>
                    <input value={platformSearch} onChange={(e) => setPlatformSearch(e.target.value)} placeholder="Search platform…"
                      className="w-40 px-2 py-1 bg-white border border-slate-200 rounded-md text-[11px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900" />
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-2 max-h-[240px] overflow-y-auto">
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                      {filteredPlatformOptions.map((p) => {
                        const active = resolvePlatformOption(notifPlatformIcon).id === p.id;
                        return (
                          <button key={p.id || "none"} type="button" onClick={() => setNotifPlatformIcon(p.id)}
                            className={`group relative flex flex-col items-center justify-center gap-1.5 py-2.5 px-1.5 rounded-lg border transition-all min-h-[74px] ${active ? "bg-white border-slate-900 shadow-sm" : "bg-white border-slate-200 hover:border-slate-300"}`}>
                            <PlatformChipVisual id={p.id} size={40} />
                            <span className={`text-[9.5px] font-medium text-center leading-tight px-0.5 line-clamp-2 ${active ? "text-slate-900" : "text-slate-500 group-hover:text-slate-700"}`}>{p.label}</span>
                          </button>
                        );
                      })}
                    </div>
                    {filteredPlatformOptions.length === 0 && (
                      <p className="text-center text-[11px] text-slate-500 py-4">No platform matches "{platformSearch}"</p>
                    )}
                  </div>
                </div>

                {/* Toggles */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                    <label className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500 block mb-2">User Can Delete?</label>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => setNotifLocked(!notifLocked)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${!notifLocked ? "bg-emerald-500" : "bg-slate-300"}`}
                        aria-label="Allow user to delete this notification">
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${!notifLocked ? "translate-x-6" : "translate-x-1"}`} />
                      </button>
                      <span className="text-[11px] text-slate-600">
                        {notifLocked ? "Locked" : "Allowed"}
                      </span>
                    </div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                    <label className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500 block mb-2">Audience</label>
                    <div className="inline-flex bg-white border border-slate-200 rounded-lg p-0.5 text-[11px]">
                      <button type="button" onClick={() => setNotifAudience("all")}
                        className={`px-2.5 py-1 rounded-md font-semibold transition-all ${notifAudience === "all" ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900"}`}>All users</button>
                      <button type="button" onClick={() => setNotifAudience("user")}
                        className={`px-2.5 py-1 rounded-md font-semibold transition-all ${notifAudience === "user" ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900"}`}>Specific</button>
                    </div>
                  </div>
                </div>

                {notifAudience === "user" && (
                  <select value={notifTargetUser} onChange={(e) => setNotifTargetUser(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 font-medium focus:outline-none focus:border-slate-900">
                    <option value="">— select user —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
                  </select>
                )}

                {/* Advanced */}
                <details className="group bg-slate-50 border border-slate-200 rounded-xl">
                  <summary className="cursor-pointer text-[11px] font-semibold text-slate-600 hover:text-slate-900 transition-colors flex items-center gap-1.5 list-none px-3 py-2.5">
                    <ChevronDown className="w-3.5 h-3.5 group-open:rotate-180 transition-transform" />
                    Advanced (image, CTA label, expiry)
                  </summary>
                  <div className="px-3 pb-3 space-y-3">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Hero image URL</label>
                      <div className="flex gap-2">
                        <input value={notifImageUrl} onChange={(e) => setNotifImageUrl(e.target.value)} placeholder="https://…/image.jpg"
                          className="flex-1 px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900" />
                        <label className={`px-3 py-2 rounded-xl text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors ${notifImageUploading ? "bg-slate-200 text-slate-500 cursor-wait" : "bg-slate-900 text-white hover:bg-slate-800"}`}>
                          {notifImageUploading ? "Uploading…" : "Upload"}
                          <input type="file" accept="image/*" className="hidden" disabled={notifImageUploading}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              e.currentTarget.value = "";
                              if (!file) return;
                              if (file.size > 8 * 1024 * 1024) { notify.error("Image too large (max 8 MB)"); return; }
                              setNotifImageUploading(true);
                              try {
                                const dataBase64: string = await new Promise((resolve, reject) => {
                                  const r = new FileReader();
                                  r.onload = () => resolve(String(r.result || ""));
                                  r.onerror = () => reject(new Error("read failed"));
                                  r.readAsDataURL(file);
                                });
                                const res = await apiCall("manage-app", {
                                  action: "admin_upload_notification_image",
                                  filename: file.name,
                                  contentType: file.type || "image/jpeg",
                                  dataBase64,
                                });
                                if (res?.success && res.url) { setNotifImageUrl(res.url); notify.success("Uploaded"); }
                                else throw new Error(res?.error || "upload failed");
                              } catch (err: any) { notify.error(err?.message || "Upload failed"); }
                              finally { setNotifImageUploading(false); }
                            }} />
                        </label>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input value={notifActionLabel} onChange={(e) => setNotifActionLabel(e.target.value)} placeholder="CTA label (auto if empty)"
                        className="px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900" />
                      <input value={notifExpiresDays} onChange={(e) => setNotifExpiresDays(e.target.value)} placeholder="Expires (days)" type="number" min="1"
                        className="px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <select value={notifPriority} onChange={(e) => setNotifPriority(e.target.value as any)}
                        className="px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 font-medium capitalize focus:outline-none focus:border-slate-900">
                        {(["low","normal","high","critical"] as const).map(p => <option key={p} value={p} className="capitalize">{p} priority</option>)}
                      </select>
                      <select value={notifShowFrequency} onChange={(e) => setNotifShowFrequency(e.target.value as any)}
                        className="px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 font-medium focus:outline-none focus:border-slate-900">
                        <option value="once">Show once</option>
                        <option value="session">Every session</option>
                        <option value="daily">Once per day</option>
                        <option value="always">Always until read</option>
                      </select>
                    </div>
                  </div>
                </details>

                <button onClick={sendNotification} disabled={sendingNotif || !notifTitle.trim() || !notifBody.trim()}
                  className="w-full mt-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center gap-2 shadow-sm transition-all">
                  <Send className="w-4 h-4" /> {sendingNotif ? "Publishing…" : "Publish Notification"}
                </button>
              </div>
            </section>

            {/* --- Live preview + Past notifications --- */}
            <div className="space-y-4 sm:space-y-6">
              {/* Live preview — matches the white user-facing card */}
              <section className="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10.5px] uppercase tracking-[0.16em] text-slate-500 font-bold">Live Preview</span>
                  <span className="text-[10px] text-slate-400">how users will see it</span>
                </div>
                <div className="rounded-2xl overflow-hidden mx-auto max-w-[400px] bg-white border border-slate-200 shadow-sm">
                  <div className={`h-[3px] ${notifPriority === "critical" ? "bg-rose-500" : notifPriority === "high" ? "bg-amber-500" : notifPriority === "normal" ? "bg-sky-500" : "bg-slate-400"}`} />
                  {notifImageUrl && (
                    <div className="aspect-[16/9] w-full bg-slate-100 overflow-hidden">
                      <img src={notifImageUrl} referrerPolicy="no-referrer" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                    </div>
                  )}
                  <div className="p-5">
                    <div className="flex items-center gap-2 mb-2">
                      {notifPlatformIcon ? <PlatformChipVisual id={notifPlatformIcon} size={22} /> : null}
                      <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500 font-semibold capitalize">{notifCategory}</span>
                    </div>
                    <h3 className="text-slate-900 text-[19px] leading-tight mb-2 font-bold" style={{ letterSpacing: "-0.015em" }}>
                      {notifTitle || "Your title here"}
                    </h3>
                    <p className="text-slate-700 text-[13px] leading-relaxed">{notifBody || "Short body text preview…"}</p>
                    {notifDescription && <p className="mt-2 text-slate-500 text-[12px] leading-relaxed line-clamp-3">{notifDescription}</p>}
                    {(notifActionLabel || notifActionUrl) && (
                      <div className="mt-4 py-2.5 px-4 rounded-xl bg-slate-900 text-white text-center text-[13px] font-bold">
                        {notifActionLabel || "CTA"}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section className="bg-white p-5 sm:p-6 rounded-2xl border border-slate-200 shadow-sm">
                <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100">
                  <h2 className="font-bold text-base sm:text-lg flex items-center gap-2 text-slate-900">
                    <div className="bg-slate-900 p-1.5 rounded-lg"><MessageSquare className="w-4 h-4 text-white" /></div>
                    Past Notifications
                    <span className="text-[11px] font-semibold text-slate-400">({adminNotifs.length})</span>
                  </h2>
                  <button onClick={reloadAdminNotifs} className="text-[11px] font-semibold text-slate-500 hover:text-slate-900 flex items-center gap-1">
                    <RefreshCw className="w-3 h-3" /> Refresh
                  </button>
                </div>
                <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
                  {adminNotifs.length === 0 && (
                    <div className="text-center py-10">
                      <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 flex items-center justify-center mb-2">
                        <Bell className="w-5 h-5 text-slate-400" />
                      </div>
                      <p className="text-sm text-slate-500">No notifications yet.</p>
                    </div>
                  )}
                  {adminNotifs.map((n) => (
                    <div key={n.id} className="border border-slate-200 rounded-xl overflow-hidden hover:border-slate-300 hover:shadow-sm transition-all bg-white">
                      {/* Hero image preview if uploaded — same as what users see */}
                      {n.image_url && (
                        <div className="relative aspect-[16/7] w-full overflow-hidden bg-slate-100 border-b border-slate-200">
                          <img src={n.image_url} referrerPolicy="no-referrer" alt="" loading="lazy"
                            className="absolute inset-0 w-full h-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                        </div>
                      )}
                      <div className="p-3.5 sm:p-4">
                        <div className="flex items-start gap-3">
                          <div className="shrink-0">
                            {n.platform_icon
                              ? <PlatformChipVisual id={n.platform_icon} size={44} />
                              : <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center"><Bell className="w-4 h-4 text-slate-400" /></div>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold capitalize ${n.priority === "critical" ? "text-rose-600" : n.priority === "high" ? "text-amber-600" : n.priority === "normal" ? "text-sky-600" : "text-slate-500"}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${n.priority === "critical" ? "bg-rose-500" : n.priority === "high" ? "bg-amber-500" : n.priority === "normal" ? "bg-sky-500" : "bg-slate-400"}`} />
                                {n.priority || "low"}
                              </span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 capitalize font-medium">{n.category || "announcement"}</span>
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${n.locked ? "bg-amber-50 text-amber-700 border border-amber-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"}`}>
                                {n.locked ? "Locked" : "User delete OK"}
                              </span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">
                                {n.audience === "all" ? `All · ${n.totalRecipients || 0}` : "Specific"}
                              </span>
                              {n.image_url && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 font-medium inline-flex items-center gap-1">
                                  <ImageIcon className="w-2.5 h-2.5" /> Image
                                </span>
                              )}
                            </div>
                            <p className="font-bold text-[14.5px] text-slate-900 truncate">{n.title}</p>
                            <p className="text-[12.5px] text-slate-600 line-clamp-2 mt-0.5">{n.body}</p>
                            <div className="flex items-center gap-3 mt-2 flex-wrap text-[11px]">
                              <span className="inline-flex items-center gap-1 text-slate-600"><span className="font-bold">{n.seenCount || 0}</span> <span className="text-slate-400">seen</span></span>
                              <span className="inline-flex items-center gap-1 text-emerald-700"><span className="font-bold">{n.readCount || 0}</span> <span className="text-slate-400">read</span></span>
                              <span className="inline-flex items-center gap-1 text-sky-700"><span className="font-bold">{n.clickCount || 0}</span> <span className="text-slate-400">clicked</span></span>
                              <span className="inline-flex items-center gap-1 text-rose-600"><span className="font-bold">{n.deletedCount || 0}</span> <span className="text-slate-400">deleted</span></span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-slate-100">
                          <button onClick={() => setRecipientsFor(n)} className="flex-1 min-h-[36px] px-3 py-1.5 rounded-lg text-[12px] font-bold text-white bg-slate-900 hover:bg-slate-800 flex items-center justify-center gap-1.5">
                            <Users className="w-3.5 h-3.5" /> Recipients
                          </button>
                          <button onClick={() => setEditingNotif({ ...n })} className="flex-1 min-h-[36px] px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 hover:bg-slate-100 border border-slate-200 flex items-center justify-center gap-1.5">
                            <Edit className="w-3.5 h-3.5" /> Edit
                          </button>
                          <button onClick={() => duplicateToComposer(n)} className="min-h-[36px] px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 hover:bg-slate-100 border border-slate-200 flex items-center justify-center gap-1.5" title="Duplicate">
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => deleteNotification(n.id)} className="min-h-[36px] px-3 py-1.5 rounded-lg text-[12px] font-semibold text-rose-600 hover:bg-rose-50 border border-rose-200 flex items-center justify-center gap-1.5" title="Delete for everyone">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

            </div>
          </div>
        )}

        {editingNotif && createPortal(
          <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => !savingEditNotif && setEditingNotif(null)}>
            <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="p-5 border-b flex items-center justify-between">
                <h3 className="font-black text-base flex items-center gap-2 text-slate-900"><Edit className="w-4 h-4" /> Edit Notification</h3>
                <button onClick={() => setEditingNotif(null)} className="text-slate-400 hover:text-slate-900" disabled={savingEditNotif}><X className="w-5 h-5" /></button>
              </div>
              <div className="p-5 space-y-3">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Title</label>
                  <input value={editingNotif.title || ""} onChange={(e) => setEditingNotif({ ...editingNotif, title: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Message</label>
                  <textarea value={editingNotif.body || ""} onChange={(e) => setEditingNotif({ ...editingNotif, body: e.target.value })} rows={3}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Link URL</label>
                  <input value={editingNotif.action_url || ""} onChange={(e) => setEditingNotif({ ...editingNotif, action_url: e.target.value })} placeholder="https://…"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5 block">Platform / Icon</label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {PLATFORM_OPTIONS.map((p) => {
                      const active = resolvePlatformOption(editingNotif.platform_icon).id === p.id;
                      return (
                        <button key={p.id || "none"} type="button" onClick={() => setEditingNotif({ ...editingNotif, platform_icon: p.id })}
                          className={`flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-lg border transition-all ${active ? "border-orange-500 bg-orange-50" : "border-slate-200 hover:border-slate-300"}`}>
                          <PlatformChipVisual id={p.id} size={40} />
                          <span className="text-[9px] font-medium text-slate-600 text-center leading-tight">{p.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Priority</label>
                    <select value={editingNotif.priority || "normal"} onChange={(e) => setEditingNotif({ ...editingNotif, priority: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 capitalize">
                      {["low","normal","high","critical"].map(p => <option key={p} value={p} className="capitalize">{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Audience</label>
                    <select value={editingNotif.audience || "all"} onChange={(e) => setEditingNotif({ ...editingNotif, audience: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900">
                      <option value="all">All users</option>
                      <option value="user">Specific user</option>
                    </select>
                  </div>
                </div>
                {editingNotif.audience === "user" && (
                  <select value={editingNotif.target_user_id || ""} onChange={(e) => setEditingNotif({ ...editingNotif, target_user_id: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900">
                    <option value="">— select user —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
                  </select>
                )}
                <div className={`rounded-xl p-3 border-2 ${!editingNotif.locked ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={!editingNotif.locked} onChange={(e) => setEditingNotif({ ...editingNotif, locked: !e.target.checked })} className="mt-1 w-4 h-4" />
                    <div className="flex-1">
                      <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                        {!editingNotif.locked ? "🔓 User is notification ko delete kar sakta hai" : "🔒 Locked — user delete nahi kar sakta"}
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        {!editingNotif.locked
                          ? "User ke notification panel me delete/close button dikhega."
                          : "User na dismiss kar sakta, na delete. Sirf admin hata sakta."}
                      </div>
                    </div>
                  </label>
                </div>
              </div>
              <div className="p-5 border-t flex items-center gap-2 bg-slate-50 rounded-b-2xl">
                <button onClick={() => setEditingNotif(null)} disabled={savingEditNotif} className="flex-1 px-4 py-2.5 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-white">Cancel</button>
                <button onClick={saveEditNotif} disabled={savingEditNotif} className="flex-1 px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-60">
                  {savingEditNotif ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {recipientsFor && createPortal(
          <RecipientsDrawer notification={recipientsFor} onClose={() => setRecipientsFor(null)} onChanged={reloadAdminNotifs} />,
          document.body,
        )}





        {activeTab === "inbox" && (
          <div className="max-w-2xl">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-red-50 p-1.5 rounded-lg"><Trash2 className="w-4 h-4 text-red-600" /></div>
                Clear Cached Inbox
              </h2>
              <p className="text-xs text-slate-500 mb-4">Suppresses emails in <code>cached_emails</code> forever. This affects every user and future syncs will not bring them back.</p>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3 text-sm">
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="radio" checked={inboxMode === "days"} onChange={() => setInboxMode("days")} /> Older than N days
                  </label>
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="radio" checked={inboxMode === "label"} onChange={() => setInboxMode("label")} /> By account label
                  </label>
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="radio" checked={inboxMode === "all"} onChange={() => setInboxMode("all")} /> ALL emails
                  </label>
                </div>
                {inboxMode === "days" && (
                  <input value={inboxDays} onChange={(e) => setInboxDays(e.target.value)} type="number" min="1" placeholder="Days"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                )}
                {inboxMode === "label" && (
                  <select value={inboxLabel} onChange={(e) => setInboxLabel(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900">
                    <option value="">— select account —</option>
                    {emailAccounts.map((a) => <option key={a.label} value={a.label}>{a.label}</option>)}
                  </select>
                )}
                {inboxMode === "all" && (
                  <input value={inboxConfirm} onChange={(e) => setInboxConfirm(e.target.value)} placeholder='Type DELETE ALL to confirm'
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                )}
                <button onClick={adminClearInbox} disabled={clearingInbox}
                  className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-bold py-2.5 rounded-lg text-sm flex items-center justify-center gap-2">
                  <Trash2 className="w-4 h-4" /> {clearingInbox ? "Deleting…" : "Delete now"}
                </button>
              </div>
            </section>
          </div>
        )}



        {activeTab === "emails" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-green-50 p-1.5 rounded-lg"><Plus className="w-4 h-4 text-green-600" /></div>
                Add Email Account
              </h2>
              <div className="space-y-3">
                <input type="text" placeholder="Account Label (e.g. Gmail Main)" value={newAccount.label} onChange={(e) => setNewAccount({ ...newAccount, label: e.target.value })}
                  className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <div className="grid grid-cols-2 gap-2">
                  <input type="text" placeholder="IMAP Host" value={newAccount.host} onChange={(e) => setNewAccount({ ...newAccount, host: e.target.value })}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                  <input type="text" placeholder="Port" value={newAccount.port} onChange={(e) => setNewAccount({ ...newAccount, port: e.target.value })}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <input type="text" placeholder="Email Address" value={newAccount.user} onChange={(e) => setNewAccount({ ...newAccount, user: e.target.value })}
                  className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <PasswordInput value={newAccount.password} onChange={(e) => setNewAccount({ ...newAccount, password: e.target.value })}
                  placeholder="App Password"
                  className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />

                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Recipient filter</label>
                  <input type="text" placeholder="omdevsinhgohil538+freenf@gmail.com" value={newAccountRecipients} onChange={(e) => setNewAccountRecipients(e.target.value)}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                  <p className="text-[10px] text-slate-400 mt-1 ml-1">Optional. Only cache emails sent to these addresses. Use comma/space for multiple.</p>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Cloudflare Worker URLs</label>
                  <p className="text-[10px] text-slate-400 mb-2 ml-1">Assign dedicated Cloudflare Worker URLs to this account. Emails for this account will be fetched through these workers. If none are added, primary workers will be used. Multiple URLs are load-balanced randomly.</p>
                  <div className="space-y-1.5 mb-2">
                    {newAccountCfUrls.map((url, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg border">
                        <Globe className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                        <span className="text-xs text-slate-700 flex-1 break-all">{url}</span>
                        <button onClick={() => setNewAccountCfUrls(newAccountCfUrls.filter((_, idx) => idx !== i))}
                          className="p-1 hover:bg-red-50 text-red-400 hover:text-red-600 rounded transition-colors">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input type="text" placeholder="https://worker.workers.dev" value={newAccountCfInput}
                      onChange={(e) => setNewAccountCfInput(e.target.value)}
                      className="flex-1 bg-slate-50 border rounded-lg p-2 outline-none focus:ring-2 focus:ring-red-500 text-xs" />
                    <button onClick={() => {
                      if (!newAccountCfInput.trim()) return;
                      setNewAccountCfUrls([...newAccountCfUrls, newAccountCfInput.trim().replace(/\/+$/, "")]);
                      setNewAccountCfInput("");
                    }} className="px-3 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-lg hover:bg-slate-700">
                      Add
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">Add multiple worker URLs for redundancy</p>
                </div>

                <button onClick={addEmailAccount}
                  className="w-full bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800 transition-all text-sm">
                  Add Account
                </button>
              </div>
            </section>

            <section className="lg:col-span-2 bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-blue-50 p-1.5 rounded-lg"><Mail className="w-4 h-4 text-blue-600" /></div>
                Connected Accounts
                <span className="bg-slate-100 text-slate-600 text-xs px-2 py-0.5 rounded-full ml-auto">{emailAccounts.length}</span>
              </h2>


              {emailAccounts.length === 0 ? (
                <p className="text-slate-400 text-sm text-center py-6">No additional accounts. Add one from the left panel.</p>
              ) : (
                <div className="space-y-3">
                  {emailAccounts.map((acc, i) => (
                    <div key={i}
                      className={`p-4 rounded-2xl border cursor-pointer transition-all ${expandedAccount === i ? "bg-blue-50 border-blue-200 shadow-md" : "bg-slate-50 border-slate-100 hover:border-slate-200"}`}
                      onClick={() => setExpandedAccount(expandedAccount === i ? null : i)}
                    >
                      <div className="flex items-center gap-3">
                        <div className="bg-blue-100 p-2 rounded-xl">
                          <Mail className="w-4 h-4 text-blue-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm text-slate-900">{acc.label}</p>
                          <p className="text-xs text-slate-500 truncate">{acc.user} • {acc.host}:{acc.port}</p>
                          {acc.cloudflareUrls && acc.cloudflareUrls.length > 0 && (
                            <p className="text-[10px] text-orange-600 font-bold mt-0.5">{acc.cloudflareUrls.length} Worker URL{acc.cloudflareUrls.length > 1 ? "s" : ""}</p>
                          )}
                          {acc.recipientFilters && acc.recipientFilters.length > 0 && (
                            <p className="text-[10px] text-emerald-600 font-bold mt-0.5">Recipient filter: {acc.recipientFilters.join(", ")}</p>
                          )}
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); removeEmailAccount(i); }}
                          className="p-2 hover:bg-red-50 text-red-400 hover:text-red-600 rounded-lg transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      {expandedAccount === i && (
                        <div className="mt-4 pt-3 border-t border-blue-200 space-y-2.5">
                          <div onClick={(e) => e.stopPropagation()} className="space-y-3">
                            <div>
                              <label className="block text-[10px] font-bold text-blue-500 uppercase mb-1">Label / Name</label>
                              <input type="text" value={acc.label} onChange={(e) => updateEmailAccountDraft(i, { label: e.target.value })}
                                placeholder="Account label" className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-900" />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-[10px] font-bold text-blue-500 uppercase mb-1">Host</label>
                                <input type="text" value={acc.host} onChange={(e) => updateEmailAccountDraft(i, { host: e.target.value })}
                                  placeholder="imap.gmail.com" className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-900" />
                              </div>
                              <div>
                                <label className="block text-[10px] font-bold text-blue-500 uppercase mb-1">Port</label>
                                <input type="text" value={acc.port} onChange={(e) => updateEmailAccountDraft(i, { port: e.target.value })}
                                  placeholder="993" className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-900" />
                              </div>
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-blue-500 uppercase mb-1">Email / Username</label>
                              <input type="text" value={acc.user} onChange={(e) => updateEmailAccountDraft(i, { user: e.target.value })}
                                placeholder="Email address" className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-900" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-blue-500 uppercase mb-1">Password</label>
                              <PasswordInput value={acc.password} onChange={(e) => updateEmailAccountDraft(i, { password: e.target.value })}
                                placeholder="App password" className="w-full bg-white border border-slate-200 rounded-lg p-2 pr-12 outline-none focus:ring-2 focus:ring-blue-500 text-sm" />
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-blue-500 uppercase mb-1">Cloudflare Worker URLs</p>
                              <div className="space-y-1.5 mb-2">
                                {(acc.cloudflareUrls || []).map((url, ui) => (
                                  <div key={ui} className="flex items-center gap-2 bg-white rounded-md px-2 py-1 border border-slate-100">
                                    <input type="text" value={url} onChange={(e) => updateEmailAccountDraft(i, { cloudflareUrls: (acc.cloudflareUrls || []).map((item, idx) => idx === ui ? e.target.value : item) })}
                                      className="text-sm text-slate-800 font-medium flex-1 min-w-0 bg-transparent outline-none" />
                                    <button type="button" onClick={() => copyToClipboard(url, "Worker URL copied")}
                                      className="p-1 rounded hover:bg-slate-200 text-slate-600 flex-shrink-0" aria-label="Copy worker URL">
                                      <Copy className="w-3 h-3" />
                                    </button>
                                    <button type="button" onClick={() => updateEmailAccountDraft(i, { cloudflareUrls: (acc.cloudflareUrls || []).filter((_, idx) => idx !== ui) })}
                                      className="p-1 rounded hover:bg-red-50 text-red-500 flex-shrink-0" aria-label="Remove worker URL">
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                              <div className="flex gap-1.5">
                                <input type="text" placeholder="https://worker.workers.dev" value={editingAccountUrls === i ? editCfInput : ""}
                                  onFocus={() => { setEditingAccountUrls(i); setEditCfInput(""); }}
                                  onChange={(e) => { setEditingAccountUrls(i); setEditCfInput(e.target.value); }}
                                  className="flex-1 bg-white border border-slate-200 rounded-lg p-1.5 outline-none focus:ring-2 focus:ring-blue-500 text-xs text-slate-900" />
                                <button type="button" onClick={() => {
                                  if (!editCfInput.trim()) return;
                                  updateEmailAccountDraft(i, { cloudflareUrls: [...(acc.cloudflareUrls || []), editCfInput.trim().replace(/\/+$/, "")] });
                                  setEditCfInput("");
                                  setEditingAccountUrls(null);
                                }} className="px-2 py-1 bg-slate-800 text-white text-[10px] font-bold rounded-lg hover:bg-slate-700">
                                  Add
                                </button>
                              </div>
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-emerald-600 uppercase mb-1">Recipient filter</label>
                              <input type="text" placeholder="email1@example.com, email2@example.com" value={editingAccountRecipients === i ? editRecipientsInput : (acc.recipientFilters || []).join(", ")}
                                onFocus={() => { setEditingAccountRecipients(i); setEditRecipientsInput((acc.recipientFilters || []).join(", ")); }}
                                onChange={(e) => { setEditingAccountRecipients(i); setEditRecipientsInput(e.target.value); }}
                                className="w-full bg-white border border-slate-200 rounded-lg p-2 outline-none focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900" />
                            </div>
                            <button type="button" onClick={() => saveEmailAccount(i)} disabled={savingAccounts}
                              className="w-full bg-blue-600 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-blue-700 disabled:opacity-60 transition-all">
                              {savingAccounts ? "Saving..." : "Save Account"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === "settings" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm lg:col-span-2">
              <h2 className="font-black text-base sm:text-lg mb-1 flex items-center gap-2">
                <div className="bg-amber-50 p-1.5 rounded-lg"><AlertCircle className="w-4 h-4 text-amber-600" /></div>
                Plan Contact Info
              </h2>
              <p className="text-[11px] text-slate-500 mb-4">Shown to paid users when their plan has ended. Add multiple entries per channel — perfect for a support team.</p>
              {([
                { label: "Telegram", list: contactInfoTelegrams, set: setContactInfoTelegrams, placeholder: "@yourhandle or https://t.me/...", icon: Send, tint: "sky" },
                { label: "WhatsApp", list: contactInfoWhatsapps, set: setContactInfoWhatsapps, placeholder: "+91 98765 43210", icon: MessageSquare, tint: "emerald" },
                { label: "Email", list: contactInfoEmails, set: setContactInfoEmails, placeholder: "admin@example.com", icon: Mail, tint: "slate" },
              ] as const).map(({ label, list, set, placeholder, icon: Icon, tint }) => (
                <div key={label} className="mb-4">
                  <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">
                    <Icon className={`w-3.5 h-3.5 text-${tint}-600`} /> {label}
                  </label>
                  <div className="space-y-2">
                    {list.map((val, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input type={label === "Email" ? "email" : "text"} placeholder={placeholder} value={val}
                          onChange={(e) => set(list.map((v, i) => i === idx ? e.target.value : v))}
                          className="flex-1 bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                        <button type="button" onClick={() => set(list.length > 1 ? list.filter((_, i) => i !== idx) : [""])}
                          className="h-11 w-11 rounded-xl border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 flex items-center justify-center transition"
                          title="Remove">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => set([...list, ""])}
                      className="text-xs font-bold text-slate-600 hover:text-red-600 flex items-center gap-1 transition">
                      <Plus className="w-3.5 h-3.5" /> Add {label.toLowerCase()}
                    </button>
                  </div>
                </div>
              ))}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Note (optional)</label>
                <input type="text" placeholder="Renewal instructions..." value={contactInfoNote}
                  onChange={(e) => setContactInfoNote(e.target.value)}
                  className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
              </div>
              <button onClick={saveContactInfo} disabled={savingContactInfo}
                className="mt-4 h-10 px-5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 active:scale-[0.98] transition disabled:opacity-50">
                {savingContactInfo ? "Saving…" : "Save Contact Info"}
              </button>
            </section>


            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-blue-50 p-1.5 rounded-lg"><Server className="w-4 h-4 text-blue-600" /></div>
                Telegram Notifications
              </h2>
              <p className="text-[10px] text-slate-400 mb-3">💡 Save once to persist these values</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Bot Token</label>
                  <PasswordInput value={serverConfig.TELEGRAM_BOT_TOKEN}
                    onChange={(e) => setServerConfig({ ...serverConfig, TELEGRAM_BOT_TOKEN: e.target.value })}
                    placeholder="e.g. 8575582532:AAE..."
                    className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Chat ID</label>
                  <input type="text" placeholder="e.g. 769748540" value={serverConfig.TELEGRAM_CHAT_ID}
                    onChange={(e) => setServerConfig({ ...serverConfig, TELEGRAM_CHAT_ID: e.target.value })}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-slate-100 p-1.5 rounded-lg"><Globe className="w-4 h-4 text-slate-600" /></div>
                Cloudflare Workers
              </h2>
              <p className="text-[10px] text-slate-400 mb-3">💡 Shared fallback workers used for accounts without dedicated URLs</p>
              <div className="space-y-3">


                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Cloudflare Worker URLs</label>
                  <p className="text-[10px] text-slate-400 mb-2 ml-1">These are the default/primary workers used for all accounts without dedicated workers. Add multiple URLs for random load balancing. Update code from Cloudflare Dashboard → Workers & Pages → Edit code → Deploy, or let Cloudflare GitHub builds deploy it.</p>
                  <div className="space-y-1.5 mb-2">
                    {primaryCfUrls.map((url, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg border">
                        <Globe className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                        <span className="text-xs text-slate-700 flex-1 break-all">{url}</span>
                        <button onClick={() => setPrimaryCfUrls(primaryCfUrls.filter((_, idx) => idx !== i))}
                          className="p-1 hover:bg-red-50 text-red-400 hover:text-red-600 rounded transition-colors">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input type="text" placeholder="https://worker.workers.dev" value={primaryCfInput}
                      onChange={(e) => setPrimaryCfInput(e.target.value)}
                      className="flex-1 bg-slate-50 border rounded-lg p-2 outline-none focus:ring-2 focus:ring-red-500 text-xs" />
                    <button onClick={() => {
                      if (!primaryCfInput.trim()) return;
                      setPrimaryCfUrls([...primaryCfUrls, primaryCfInput.trim().replace(/\/+$/, "")]);
                      setPrimaryCfInput("");
                    }} className="px-3 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-lg hover:bg-slate-700">
                      Add
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">Multiple URLs are shuffled randomly for load balancing — not sequential failover</p>
                </div>

                {/* Cloudflare Setup Guide - Mobile Friendly (No PC needed) */}
                <details className="mt-4 bg-blue-50 border border-blue-200 rounded-xl overflow-hidden">
                  <summary className="text-xs font-bold text-blue-700 cursor-pointer select-none flex items-center gap-2 p-3 active:bg-blue-100 transition-colors">
                    <Info className="w-4 h-4 flex-shrink-0" />
                    <span>📘 Cloudflare Worker Setup (No PC Needed)</span>
                  </summary>
                  <div className="px-2.5 pb-3 space-y-2">
                    <p className="text-[11px] text-blue-800 bg-blue-100 rounded-lg p-2">✅ Sab kuch phone browser se hoga — koi terminal ya PC ki zaroorat nahi!</p>

                    {/* ⚡ 1-YEAR-LATER QUICK REFERENCE — read this first, everything else is detail */}
                    <div className="rounded-xl border-2 border-emerald-400 bg-emerald-50 p-3">
                      <p className="text-xs font-black text-emerald-900 mb-2">⚡ 1-SAAL BAAD YAAD KARNE KE LIYE — Sirf ye 8 steps</p>
                      <p className="text-[10px] text-emerald-800 mb-2">Har Cloudflare account me exact same. Bookmark kar lo.</p>
                      <p className="text-[10.5px] text-red-800 bg-red-50 border border-red-200 rounded-lg p-2 mb-2"><b>IMPORTANT:</b> Naye Cloudflare account me manual env/secrets required nahi. Worker health me KV true hote hi app us Worker ko hit karega; signing secret missing ho to Worker session verify Supabase ke through karega.</p>
                      <pre className="whitespace-pre-wrap break-words text-[10.5px] leading-relaxed font-mono bg-white rounded-lg p-2 border border-emerald-200 text-slate-800">{`1. dash.cloudflare.com → us account me login karo
2. Workers & Pages → Create → "Import a repository"
   (NOT "Hello World")
3. Repo: inbox-debugger    Branch: main
4. EXACT ye fields:
     Project name    = netflix (unique: netflix2, netflix3...)
     Root directory  = /cloudflare-worker
     Build command   = (blank chhodo)
     Deploy command  = npm run deploy
     Non-prod branch = ☐ uncheck
5. API token → "Create new" → default template.
   Permissions: Workers Scripts Edit +
                Workers KV Storage Edit +
                Account Settings Read
6. Build variables/secrets blank chhodo.
   deploy.mjs KV auto-create/bind karega.
   Agar Cloudflare token env expose kare to signing secret auto-sync hoga;
   nahi hua tab bhi email sync Worker se chalega.
7. "Save and Deploy" → Logs me dekho:
     "Creating/updating Worker with KV binding EMAIL_CACHE"
     "Creating/Found KV namespace EMAIL_CACHE"
     "Finalizing Worker deploy with synced secrets"
8. Worker URL copy karo (https://netflix.xxx.workers.dev)
   → Admin Panel → Cloudflare Workers →
     "Primary Cloudflare Worker URLs" me paste → Save`}</pre>
                      <div className="mt-2 space-y-1 text-[10.5px] text-emerald-900">
                        <p><b>Update code?</b> GitHub main pe commit push → auto rebuild + secret re-sync.</p>
                        <p><b>Build start nahi hua?</b> Deployments tab → Retry. Settings save karne se build nahi chalta.</p>
                        <p><b>Deploy command galat?</b> Edit → <code className="bg-white px-1 rounded">npm run deploy</code>. Default <code className="bg-white px-1 rounded">npx wrangler deploy</code> se KV bootstrap + secret sync skip ho jata hai.</p>
                      </div>
                    </div>


                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-black text-amber-900">🔐 SESSION_SIGNING_SECRET yahi se copy karo</p>
                          <p className="text-[11px] text-amber-800 mt-0.5">Admin login ke bina value nahi dikhegi. Cloudflare me Type hamesha <b>Secret</b> select karna, Plaintext nahi.</p>
                        </div>
                        <button
                          type="button"
                          onClick={revealSigningSecret}
                          disabled={revealingSigningSecret}
                          className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-[11px] font-black text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          {revealingSigningSecret ? "Opening..." : signingSecretReveal ? "Reveal again" : "Reveal"}
                        </button>
                      </div>
                      {signingSecretReveal && (
                        <div className="rounded-lg border border-amber-300 bg-white p-2">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[10px] font-black uppercase text-amber-700">Verified · {signingSecretReveal.length} chars · {signingSecretReveal.source}</span>
                            <button type="button" onClick={copySigningSecret} className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-[10px] font-black text-amber-900 hover:bg-amber-200">
                              <Copy className="w-3 h-3" /> Copy fingerprint
                            </button>
                          </div>
                          <code className="block break-all rounded-md bg-slate-950 p-2 text-[11px] leading-relaxed text-amber-100">fp: {signingSecretReveal.fingerprint}</code>
                          <p className="mt-2 text-[10px] leading-snug text-amber-800">
                            🔒 For security, the raw signing secret is never returned by the API. Copy it from
                            <strong> Supabase Dashboard → Edge Functions → Secrets → SESSION_SIGNING_SECRET</strong>.
                            The fingerprint above lets you confirm both sides match after rotation.
                          </p>
                        </div>
                      )}
                    </div>

                    {[
                      {
                        step: "1",
                        title: "Cloudflare Account Banao (2 min)",
                        points: [
                          "Browser me naya tab kholo → address bar me type karo: dash.cloudflare.com",
                          "Right side upar 'Sign Up' button dabao",
                          "Apna email + strong password daalo → 'Create Account'",
                          "Cloudflare tere email pe verification link bhejega — Gmail kholo, us link pe click karo",
                          "Verify hone ke baad wapas dash.cloudflare.com pe login karo",
                          "Home page khulega jisme left side ek sidebar dikhega",
                        ],
                      },
                      {
                        step: "2",
                        title: "Worker Create Karo (3 min)",
                        points: [
                          "Left sidebar me neeche scroll karo → 'Compute (Workers)' dhundo",
                          "Uske andar 'Workers & Pages' pe click karo",
                          "Right side blue button 'Create' pe dabao",
                          "Options aayenge — 'Start with Hello World' select karo → 'Get started' dabao",
                          "Worker ka naam do: netflix (ya har account ke liye unique lowercase naam, no spaces)",
                          "Neeche 'Deploy' button dabao",
                          "10 second wait karo — 'Success!' message aayega",
                          "'Continue to project' ya 'Edit code' button dikhega",
                        ],
                      },
                      {
                        step: "2-GIT",
                        title: "⚡ ALTERNATIVE: GitHub se Auto-Deploy (Manual code paste skip)",
                        points: [
                          "Agar tu 'Start with Hello World' ke bajaye GitHub connect karke auto-deploy karna chahta hai to ye follow kar. Warna step 3 pe jump kar.",
                          "",
                          "Workers & Pages → 'Create' → 'Import a repository' / 'Connect to Git' select karo",
                          "⚠️ Agar overview pe 'Automatic deployment on upload' + 'Edit code' dikh raha hai, to ye Git build project nahi hai. Isme npm/bun build kabhi start nahi hoga — new Worker 'Import a repository' se banao.",
                          "GitHub authorize karo → repo select: inbox-debugger (ya jo bhi repo hai)",
                          "Branch: main",
                          "",
                          "📝 'Set up your application' screen pe EXACT ye values daalni hain:",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "Project name:    netflix (ya har Cloudflare account ke liye unique naam)",
                          "Framework preset: None / Worker (Pages/Vite mat select karo)",
                          "Root directory:  /cloudflare-worker  ← ZAROORI (blank chhoda to React frontend detect ho sakta hai)",
                          "Build command:   (BLANK chhod do — agar Cloudflare npm/bun run build auto chalaye to bhi node deploy.mjs chalega)",
                          "Deploy command:  npm run deploy  ← REQUIRED / safest (screenshot me npx wrangler deploy hai, isliye deploy.mjs wala KV bootstrap/logs nahi chal raha)",
                          "                 Best: Root=/cloudflare-worker, Build blank, Deploy=npm run deploy",
                          "Builds for non-production branches: ☐ unchecked rakho",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "",
                          "🪄 Trick kaise kaam karta hai:",
                          "cloudflare-worker/package.json ka build/deploy/start sab node deploy.mjs chalate hain.",
                          "deploy.mjs har Cloudflare account me EMAIL_CACHE KV dhundta hai; na mile to create karta hai; fir binding id inject karke deploy karta hai.",
                          "Isliye npm run build ho ya bun run build — worker deploy + KV binding trigger ho jata hai ✅",
                          "",
                          "'Advanced settings' expand karo → scroll karo:",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "Non-production branch deploy command: (BLANK)",
                          "Build variables/secrets: (BLANK — kuch add mat karo)",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "",
                          "Neeche:",
                          "API token:       Create new token / default token with KV access",
                          "Permission required: Account Settings Read + Workers Scripts Edit + Workers KV Storage Edit + User Details Read + Memberships Read",
                          "",
                          "⚠️ COMMON GALTI:",
                          "❌ Root directory blank MAT chhodo — /cloudflare-worker set karo, warna frontend build detect ho sakta hai",
                          "❌ Build command me 'bash setup.sh' MAT likho",
                          "❌ Deploy command me 'npm install' MAT likho",
                          "❌ Deploy command default 'npx wrangler deploy' reh gaya to hamara deploy.mjs script nahi chalega. Edit pencil dabao → npm run deploy set karo.",
                          "❌ Purana/restricted API token mat use karo — KV bind/create ke liye Workers KV Storage Edit chahiye",
                          "✅ Best setup: Root=/cloudflare-worker, Build=blank, Deploy=npm run deploy",
                          "",
                          "Blue 'Save and Deploy' button dabao. Agar Settings me later change kiya hai to wo turant start nahi hota — Deployments tab me Retry/Create deployment dabao ya new commit push karo.",
                          "Logs me 'Creating/Found KV namespace EMAIL_CACHE' aana chahiye → Settings → Bindings me EMAIL_CACHE dikhega",
                          "Existing manual/upload worker ko GitHub se connect nahi kiya to koi build start nahi hoga. Git connected ho to connect ke baad ek NEW commit push karo ya Deployments → Retry karo",
                          "Har alag Cloudflare account me same repo authorize + naya token/select token repeat karna padega — accounts isolated hote hain.",

                        ],
                        warning: "⚠️ Ye flow tab hi kaam karega jab repo public ho ya GitHub connect authorize kiya ho. Confuse ho to Step 2 wala manual Hello World flow use kar — safer hai.",
                      },
                      {
                        step: "3",
                        title: "Worker Code Paste Karo (5 min)",
                        points: [
                          "'Edit code' pe click karo — code editor khulega browser me hi",
                          "Left side ek file dikhegi 'worker.js' — usme default 'Hello World' code hai",
                          "Poore code pe click karo → Ctrl+A (ya mobile pe long-press → Select All) → Delete",
                          "",
                          "📥 Ab tereko project ka worker code chahiye:",
                          "→ Lovable me left side 'Code' icon pe click karo (ya GitHub repo kholo)",
                          "→ Folder: cloudflare-worker/worker.js file kholo",
                          "→ Poora code Ctrl+A → Copy karo",
                          "",
                          "Cloudflare editor me wapas jao → khali jagah pe Paste karo",
                          "Upar right side 'Deploy' button dabao",
                          "'Deploy' confirmation aayega — dabao",
                          "✅ Green 'Deployed successfully' message aayega",
                        ],
                      },
                      {
                        step: "4",
                        title: "KV Storage Banao (Email Cache ke liye) — 3 min",
                        points: [
                          "Upar left me '← Workers & Pages' pe click karke wapas jao",
                          "Top pe tabs dikhenge: Overview | KV | R2 | D1 | Queues...",
                          "'KV' tab pe click karo",
                          "Blue button 'Create instance' (ya '+ Create') dabao",
                          "Namespace name: EMAIL_CACHE (exact same, capital letters)",
                          "'Add' dabao — namespace ban jayega",
                          "",
                          "🔗 Ab is KV ko Worker se connect karna hai:",
                          "→ 'Workers & Pages' pe wapas jao",
                          "→ Apna worker (netflixfetch) pe click karo",
                          "→ Top tabs me 'Settings' pe click karo",
                          "→ Left sub-menu me 'Bindings' pe click karo",
                          "→ '+ Add' button → 'KV Namespace' select karo",
                          "→ Variable name: EMAIL_CACHE",
                          "→ KV namespace dropdown me: EMAIL_CACHE select karo",
                          "→ 'Deploy' dabao",
                        ],
                      },
                      {
                        step: "5-A",
                        title: "🔓 Pehle: SESSION_SIGNING_SECRET ki value nikaalo",
                        points: [
                          "Ye value tera password jaisa hai — Cloudflare ko dena hai taki dono milke session verify kar sakein.",
                          "",
                          "📱 SIMPLE TAREEKA (admin panel se, 10 second):",
                          "1. Isi blue guide ke upar yellow box me 'Reveal' button dabao",
                          "2. Neeche black box me long value dikhegi",
                          "3. 'Copy' dabao — wahi SESSION_SIGNING_SECRET value hai",
                          "4. Cloudflare me SECRET #3 ke Value field me paste karo",
                          "",
                          "Agar copy fail ho jaye: black box pe long press/drag karke manually select karke copy karo.",
                        ],
                        warning: "🔒 Ye admin-only reveal hai. Value kisi ko bhi mat dena — Telegram/WhatsApp pe bhi nahi bhejna.",
                      },
                      {
                        step: "5-B",
                        title: "4 Secrets Cloudflare Worker me Add Karo",
                        points: [
                          "Worker page → 'Settings' tab → left sub-menu me 'Variables and Secrets'",
                          "Right side '+ Add' button dabao",
                          "",
                          "⚙️ HAR SECRET ke liye ye 3 cheezein bharni hain:",
                          "   • Type: dropdown se 'Secret' select karo (Plaintext NAHI)",
                          "   • Variable name: (neeche list se copy karo, EXACT same spelling)",
                          "   • Value: (neeche list se copy karo)",
                          "   • Fir 'Deploy' dabao — har secret ke baad ek baar",
                          "",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "🔑 SECRET #1",
                          "Name: SUPABASE_URL",
                          "Value: https://jsqchutnfdeljajkxmly.supabase.co",
                          "(Ye tera Supabase project URL hai — already known)",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "🔑 SECRET #2",
                          "Name: SUPABASE_KEY",
                          "Value kaha se milega:",
                          "  → supabase.com/dashboard kholo",
                          "  → Apna project (jsqchutnfdeljajkxmly) select karo",
                          "  → Left sidebar niche gear icon 'Project Settings'",
                          "  → 'API Keys' section pe click",
                          "  → 'anon' 'public' row me lambi key dikhegi (eyJhbGc... se shuru)",
                          "  → 'Copy' button dabao → Cloudflare me paste",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "🔑 SECRET #3 ⭐ (MOST IMPORTANT)",
                          "Name: SESSION_SIGNING_SECRET",
                          "Value: Step 5-A me jo string copy ki thi wahi paste karo",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "🔑 SECRET #4 (backward compatibility)",
                          "Name: SESSION_SECRET",
                          "Value kaha se milega:",
                          "  → Supabase Dashboard → Project Settings → API Keys",
                          "  → NEECHE scroll karo → 'service_role' 'secret' row",
                          "  → 'Reveal' dabake copy karo (ye SUPER secret hai, kisi ko mat dena)",
                          "  → Cloudflare me paste",
                          "  Note: 24 ghante baad ye safely delete kar sakte ho",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "",
                          "Chaaron add ho gaye? → Last 'Deploy' dabao → ✅ Done",
                        ],
                        warning: "⚠️ Spelling galat hui (jaise SUPBASE_URL) to worker fail hoga. Copy-paste karo, type mat karo.",
                      },
                      {
                        step: "6",
                        title: "Worker URL Copy Karo aur App me Daalo",
                        points: [
                          "Worker page pe wapas jao (top pe worker naam pe click)",
                          "'Overview' tab pe URL dikhega, kuch aisa:",
                          "   https://netflix.YOURNAME.workers.dev",
                          "'Copy' icon dabake URL copy karo",
                          "",
                          "📲 App me daalne ke steps:",
                          "  → App me admin login karo",
                          "  → Admin Panel → 'Cloudflare Workers' section",
                          "  → 'Primary Cloudflare Worker URLs' input me paste karo",
                          "  → '+ Add' dabao",
                          "  → 'Save' dabao",
                          "",
                          "✅ Ho gaya! Ab test karo — koi email account refresh karo, emails worker se aayenge.",
                        ],
                      },
                    ].map((s) => (
                      <details key={s.step} className="bg-white rounded-lg border border-blue-100 overflow-hidden">
                        <summary className="flex items-center gap-2 p-2.5 cursor-pointer active:bg-blue-50 transition-colors">
                          <span className="bg-blue-600 text-white text-[10px] font-bold min-w-[20px] h-5 px-1 rounded-full flex items-center justify-center flex-shrink-0">{s.step}</span>
                          <span className="text-xs font-bold text-slate-800">{s.title}</span>
                        </summary>
                        <div className="px-2.5 pb-2.5">
                          <ul className="space-y-1">
                            {s.points.map((p, i) => (
                              <li key={i} className={`text-[11px] text-slate-700 ${p === "" ? "h-1" : "flex gap-1.5"}`}>
                                {p !== "" && <><span className="text-blue-400 mt-0.5 flex-shrink-0">•</span><span className="whitespace-pre-wrap break-words">{p}</span></>}
                              </li>
                            ))}
                          </ul>
                          {"warning" in s && s.warning && (
                            <p className="text-[10px] text-red-600 font-bold mt-1.5 bg-red-50 p-1.5 rounded">{s.warning}</p>
                          )}
                        </div>
                      </details>
                    ))}

                    <details className="bg-yellow-50 rounded-lg border border-yellow-200 overflow-hidden">
                      <summary className="flex items-center gap-2 p-2.5 cursor-pointer active:bg-yellow-100 transition-colors">
                        <span className="text-xs font-bold text-yellow-800">🔄 Naya Email Account / Second Cloudflare Account?</span>
                      </summary>
                      <div className="px-2.5 pb-2.5">
                        <ol className="text-[11px] text-yellow-900 space-y-1.5 ml-4 list-decimal">
                          <li>Naye Cloudflare account me login karo (ya same account me new worker banao)</li>
                          <li>Step 2 se 6 repeat karo — worker ka naam alag rakhna (jaise netflix2)</li>
                      <li>GitHub auto-deploy flow use karoge to <b>Deploy command: npx wrangler deploy</b> rakho — KV auto bind hoga, secrets/env ki zaroorat nahi.</li>
                          <li>Naya worker URL copy karo</li>
                          <li>App → Admin Panel → Email Accounts tab</li>
                          <li>Us specific account ke 'Edit' me jao → 'Cloudflare Worker URLs' me naya URL add karo</li>
                          <li>Ya sab accounts ke liye global chahiye to 'Primary Cloudflare Worker URLs' me add karo — load balance hoga automatic</li>
                        </ol>
                      </div>
                    </details>


                    <div className="bg-green-50 rounded-lg border border-green-200 p-2.5">
                      <p className="text-xs font-bold text-green-800 mb-1">💡 Tips</p>
                      <ul className="text-[11px] text-green-900 space-y-0.5 ml-3 list-disc">
                        <li>Multiple URLs = random load balancing</li>
                        <li>Per-account URL = dedicated routing</li>
                        <li>Worker down? App direct Supabase use karega</li>
                      </ul>
                    </div>
                  </div>
                </details>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm lg:col-span-2">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <h2 className="font-black text-base sm:text-lg mb-1 flex items-center gap-2">
                    <div className={`p-1.5 rounded-lg ${maintenanceEnabled ? "bg-amber-100" : "bg-slate-100"}`}>
                      <AlertTriangle className={`w-4 h-4 ${maintenanceEnabled ? "text-amber-600" : "text-slate-500"}`} />
                    </div>
                    Maintenance Mode
                  </h2>
                  <p className="text-xs text-slate-500 max-w-md">When enabled, all non-admin users see an animated maintenance screen. Admins can still browse the site normally.</p>
                </div>
                <button
                  type="button"
                  onClick={() => saveMaintenance(!maintenanceEnabled)}
                  disabled={savingMaintenance}
                  aria-pressed={maintenanceEnabled}
                  className={`relative inline-flex h-8 w-14 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${maintenanceEnabled ? "bg-amber-500" : "bg-slate-300"}`}
                >
                  <span className={`inline-block w-6 h-6 bg-white rounded-full shadow transform transition-transform ${maintenanceEnabled ? "translate-x-7" : "translate-x-1"}`} />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-5">
                <div className="md:col-span-2">
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Headline (optional)</label>
                  <input type="text" value={maintenanceTitle} onChange={(e) => setMaintenanceTitle(e.target.value)}
                    placeholder="We're upgrading the system"
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm" />
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Current version (auto)</label>
                  <input type="text" value={maintenanceVersionFrom} readOnly disabled
                    placeholder="—"
                    className="w-full bg-slate-100 border rounded-xl p-3 outline-none text-sm font-mono text-slate-700 cursor-not-allowed select-all"
                    title="Auto-filled from the last saved upgrade target. Change it only from the database." />
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">Locked — mirrors the last saved “Upgrading to”. Edit in DB only.</p>
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Upgrading to (upgrade-only)</label>
                  <input type="text" value={maintenanceVersionTo} onChange={(e) => setMaintenanceVersionTo(e.target.value)}
                    placeholder="e.g. 2.5.0"
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm font-mono text-slate-900" />
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">Stored in DB. Downgrades are blocked. Leave blank to auto-bump patch.</p>
                </div>

                <div className="md:col-span-2">
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Back online at (optional)</label>
                  {(() => {
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const parts = (() => {
                      if (!maintenanceEndsAt) return { date: "", h12: "", min: "", ampm: "AM" as "AM" | "PM" };
                      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(maintenanceEndsAt);
                      if (!m) return { date: "", h12: "", min: "", ampm: "AM" as "AM" | "PM" };
                      const h = parseInt(m[2], 10);
                      const ampm: "AM" | "PM" = h >= 12 ? "PM" : "AM";
                      const h12 = h % 12 === 0 ? 12 : h % 12;
                      return { date: m[1], h12: String(h12), min: m[3], ampm };
                    })();
                    const compose = (date: string, h12: string, min: string, ampm: "AM" | "PM") => {
                      if (!date || !h12 || min === "") { setMaintenanceEndsAt(""); return; }
                      let h = parseInt(h12, 10) % 12;
                      if (ampm === "PM") h += 12;
                      setMaintenanceEndsAt(`${date}T${pad(h)}:${pad(parseInt(min, 10) || 0)}`);
                    };
                    return (
                      <div className="flex items-center gap-2 flex-wrap">
                        <input type="date" value={parts.date}
                          onChange={(e) => compose(e.target.value, parts.h12 || "12", parts.min || "00", parts.ampm)}
                          className="bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm text-slate-900" />
                        <div className="flex items-center gap-1 bg-slate-50 border rounded-xl px-2 py-1">
                          <select value={parts.h12} onChange={(e) => compose(parts.date, e.target.value, parts.min || "00", parts.ampm)}
                            className="bg-transparent text-sm text-slate-900 outline-none px-1 py-1.5">
                            <option value="" disabled>HH</option>
                            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                              <option key={h} value={String(h)}>{pad(h)}</option>
                            ))}
                          </select>
                          <span className="text-slate-400 text-sm">:</span>
                          <select value={parts.min} onChange={(e) => compose(parts.date, parts.h12 || "12", e.target.value, parts.ampm)}
                            className="bg-transparent text-sm text-slate-900 outline-none px-1 py-1.5">
                            <option value="" disabled>MM</option>
                            {Array.from({ length: 60 }, (_, i) => i).map((m) => (
                              <option key={m} value={pad(m)}>{pad(m)}</option>
                            ))}
                          </select>
                        </div>
                        <div className="inline-flex rounded-xl border overflow-hidden text-xs font-semibold">
                          {(["AM", "PM"] as const).map((v) => (
                            <button key={v} type="button"
                              onClick={() => compose(parts.date || new Date().toISOString().slice(0, 10), parts.h12 || "12", parts.min || "00", v)}
                              className={`px-3 py-2 ${parts.ampm === v ? "bg-amber-500 text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`}>
                              {v}
                            </button>
                          ))}
                        </div>
                        {maintenanceEndsAt && (
                          <button type="button" onClick={() => setMaintenanceEndsAt("")}
                            className="px-3 py-2 rounded-xl border text-xs font-semibold text-slate-600 hover:bg-slate-50">Clear</button>
                        )}
                        {[15, 30, 60, 120].map((mins) => (
                          <button key={mins} type="button"
                            onClick={() => {
                              const d = new Date(Date.now() + mins * 60000);
                              setMaintenanceEndsAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
                            }}
                            className="px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                            +{mins < 60 ? `${mins}m` : `${mins / 60}h`}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">12-hour format with AM/PM. Shown as “Back at …” with a live countdown on the maintenance screen. Leave blank to hide.</p>
                </div>


                <div className="md:col-span-2">
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Message shown to users</label>
                  <textarea value={maintenanceMessage} onChange={(e) => setMaintenanceMessage(e.target.value)} rows={3}
                    placeholder="The site is offline for a short while so we can make it faster and safer for you. No action needed — please check back soon."
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm resize-none text-slate-900" />
                </div>
              </div>

              {/* Live preview */}
              <div className="mt-5 rounded-2xl overflow-hidden border border-slate-800 bg-black text-white p-5 sm:p-6 relative">
                <div className="flex items-center gap-2 text-[10px] tracking-[0.28em] uppercase text-white/60 font-semibold mb-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#e50914] animate-pulse" />
                  Live preview — this is what users see
                </div>
                <div className="text-[22px] sm:text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] mb-2 min-h-[1.2em]">
                  {maintenanceTitle.trim() || <span className="text-white/40 italic">(rotating headlines when empty)</span>}
                </div>
                <p className="text-white/70 text-sm leading-relaxed">
                  {maintenanceMessage.trim() || <span className="text-white/40 italic">The site is offline for a short while so we can make it faster and safer for you. You don't need to do anything — just come back in a few minutes.</span>}
                </p>
              </div>

              <div className="flex items-center gap-2 mt-4 flex-wrap">
                <button onClick={() => saveMaintenance()} disabled={savingMaintenance}
                  className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-60">
                  {savingMaintenance ? "Saving…" : "Save changes"}
                </button>

                {maintenanceEnabled && (
                  <span className="text-[11px] px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 inline-flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" /> Site is in maintenance mode
                  </span>
                )}
              </div>
            </section>



            <div className="lg:col-span-2">
              <button onClick={saveServerConfig} disabled={savingConfig}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all disabled:opacity-50 shadow-sm">
                {savingConfig ? "Saving..." : "Save All Configuration"}
              </button>
            </div>
          </div>
        )}

        {activeTab === "deploy" && (
          <div className="grid grid-cols-1 gap-4 sm:gap-6">
            {/* HERO */}
            <section className="relative overflow-hidden rounded-2xl border border-orange-200 bg-gradient-to-br from-orange-50 via-white to-amber-50 p-5 sm:p-6 shadow-sm">
              <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-orange-200/40 blur-3xl" />
              <div className="relative">
                <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-orange-100 border border-orange-200 text-[10px] font-black uppercase tracking-wider text-orange-700 mb-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                  Cloudflare Workers Builds
                </div>
                <h2 className="font-black text-xl sm:text-2xl text-slate-900 leading-tight">Deploy Guide — Step by Step</h2>
                <p className="text-xs sm:text-sm text-slate-600 mt-1.5 max-w-2xl">
                  GitHub connect karo → yeh exact values paste karo → har account me KV auto-create + bind. Multi-account safe.
                </p>
              </div>
            </section>

            {/* STEP 1 */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-slate-900 text-white font-black text-sm flex items-center justify-center">1</div>
                <div>
                  <h3 className="font-black text-base text-slate-900">GitHub se connect karo</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Cloudflare Dashboard → Workers &amp; Pages → <b>Workers</b> import/connect. Har Cloudflare account me GitHub repo authorize karna padega.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {[
                  ["Repository", "inbox-debugger (your repo)"],
                  ["Production branch", "main"],
                  ["Root directory", "/cloudflare-worker  (REQUIRED)"],
                  ["API Token", "Create new/default with KV edit"],
                ].map(([k, v]) => (
                  <div key={k} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{k}</p>
                    <p className="font-mono text-sm text-slate-900 mt-0.5 break-all">{v}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-3">
                💡 <b>API Token</b>: Create new/default token select karo, but permissions me Workers Scripts Edit + Workers KV Storage Edit zaroor hona chahiye.
              </p>
              <p className="text-[11px] text-rose-600 mt-1 font-semibold">
                ⚠️ Root directory <b>MUST</b> be <code className="font-mono bg-rose-50 px-1 rounded">/cloudflare-worker</code>. Blank chhoda to Cloudflare frontend detect kar sakta hai; agar root use karo to build variable <code className="font-mono bg-rose-50 px-1 rounded">CLOUDFLARE_WORKER_BUILD=1</code> lagao.
              </p>

            </section>

            {/* STEP 2 */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-slate-900 text-white font-black text-sm flex items-center justify-center">2</div>
                <div>
                  <h3 className="font-black text-base text-slate-900">Build &amp; Deploy commands</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Ye exact values fill karo. Kuch aur MAT chedo.</p>
                </div>
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-200">
                    {[
                      ["Build command", "(leave EMPTY — npm/bun build bhi node deploy.mjs trigger karega)", "empty"],
                      ["Deploy command", "npm run deploy", "code"],
                      ["Build variables", "(none)", "empty"],
                      ["Build secrets", "(none)", "empty"],
                    ].map(([k, v, kind]) => (
                      <tr key={k} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-bold text-slate-700 whitespace-nowrap bg-slate-50/60 w-[45%] sm:w-[35%]">{k}</td>
                        <td className={`px-4 py-3 break-all ${kind === "code" ? "font-mono text-emerald-700 font-semibold" : "font-mono text-slate-400 italic"}`}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200">
                <p className="text-xs font-bold text-emerald-900 mb-1">🪄 Auto-deploy trick</p>
                <p className="text-[11px] text-emerald-800 leading-relaxed">
                  <code className="font-mono bg-white px-1 rounded">cloudflare-worker/package.json</code> ka <code className="font-mono bg-white px-1 rounded">build/deploy/start</code> sab <code className="font-mono bg-white px-1 rounded">node deploy.mjs</code> chalate hain. Script har Cloudflare account me <code className="font-mono bg-white px-1 rounded">EMAIL_CACHE</code> KV dhundta/create karta hai, binding id inject karta hai, fir deploy karta hai. Isliye <code className="font-mono bg-white px-1 rounded">npm run build</code> ho ya <code className="font-mono bg-white px-1 rounded">bun run build</code> — trigger same hai.
                </p>
              </div>
              <div className="mt-3 p-3.5 rounded-xl bg-sky-50 border border-sky-200">
                <p className="text-xs font-bold text-sky-900 mb-1">🔐 Har Cloudflare account me allow kaise karna hai</p>
                <ul className="text-[11px] text-sky-800 space-y-0.5 list-disc list-inside">
                  <li>Us exact Cloudflare account me login karo → Workers &amp; Pages → Import repository</li>
                  <li>GitHub authorization me repo allow karo; org repo ho to org owner ko access approve karna padega</li>
                  <li>API token naya banao/select karo with Account Settings Read, Workers Scripts Edit, Workers KV Storage Edit, User Details Read, Memberships Read</li>
                  <li>Deploy logs me <code className="font-mono bg-white px-1 rounded">Creating KV namespace EMAIL_CACHE</code> ya <code className="font-mono bg-white px-1 rounded">Found existing KV namespace EMAIL_CACHE</code> aana chahiye</li>
                  <li>Worker → Settings → Bindings me <code className="font-mono bg-white px-1 rounded">EMAIL_CACHE</code> dikhe tab binding sahi hai</li>
                  <li>Cloudflare GitHub Builds env/secrets auto-insert nahi karta — runtime secrets chahiye to us account me Variables &amp; Secrets me manually add karo</li>
                </ul>
              </div>
              <div className="mt-3 p-3.5 rounded-xl bg-red-50 border border-red-200">
                <p className="text-xs font-bold text-red-900 mb-1">❌ Common mistakes</p>
                <ul className="text-[11px] text-red-800 space-y-0.5 list-disc list-inside">
                  <li>Root directory blank MAT chhodo — <code className="font-mono bg-red-100 px-1 rounded">/cloudflare-worker</code> ZAROORI hai</li>
                  <li>Build command me <code className="font-mono bg-red-100 px-1 rounded">bash setup.sh</code> ya kuch aur MAT likho — blank rakho</li>
                  <li>Deploy command blank/default mat chhodo agar binding nahi ban rahi — <code className="font-mono bg-red-100 px-1 rounded">npm run deploy</code> set karo</li>
                  <li>Purana restricted API token mat use karo — KV ke liye <code className="font-mono bg-red-100 px-1 rounded">Workers KV Storage Edit</code> chahiye</li>
                  <li>Agar root directory blank rakhna hi hai: Build variable <code className="font-mono bg-red-100 px-1 rounded">CLOUDFLARE_WORKER_BUILD=1</code> add karo</li>
                </ul>
              </div>

            </section>

            {/* STEP 3 */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-slate-900 text-white font-black text-sm flex items-center justify-center">3</div>
                <div>
                  <h3 className="font-black text-base text-slate-900">Non-production branches</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Har PR/feature branch pe deploy nahi chahiye — credits waste hote hain.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-4 rounded-xl bg-slate-50 border-2 border-dashed border-slate-300">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">☐</span>
                    <p className="font-black text-sm text-slate-900">Build for non-production branches</p>
                  </div>
                  <p className="text-[11px] text-slate-600">Checkbox <b>UNTICKED</b> rakho</p>
                </div>
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <p className="text-[10px] font-bold uppercase text-slate-500 mb-1">Non-prod branch command</p>
                  <p className="font-mono text-sm text-slate-400 italic">(leave empty — disabled)</p>
                </div>
              </div>
            </section>

            {/* STEP 4 */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br from-purple-600 to-pink-600 text-white font-black text-sm flex items-center justify-center">4</div>
                <div>
                  <h3 className="font-black text-base text-slate-900">Multiple Cloudflare accounts?</h3>
                  <p className="text-xs text-slate-500 mt-0.5">20 accounts ho tab bhi safe — har account independent hai.</p>
                </div>
              </div>
              <div className="p-4 rounded-xl bg-gradient-to-br from-purple-50 to-pink-50 border border-purple-200">
                <p className="text-xs text-slate-700 leading-relaxed">
                  Ek account me deploy karne se dusre account ka worker <b>touch nahi hota</b>. Har account ka apna worker, apna KV, apna URL.
                </p>
                <div className="mt-3 space-y-2">
                  <div className="flex gap-2 text-[11px]">
                    <span className="font-black text-purple-700 flex-shrink-0">Option A:</span>
                    <span className="text-slate-700">Har account ke liye alag branch (<code className="font-mono bg-white px-1 rounded">main-acc1</code>, <code className="font-mono bg-white px-1 rounded">main-acc2</code>)</span>
                  </div>
                  <div className="flex gap-2 text-[11px]">
                    <span className="font-black text-purple-700 flex-shrink-0">Option B:</span>
                    <span className="text-slate-700">Deploy command override: <code className="font-mono bg-white px-1 rounded">npx wrangler deploy --name netflix-acc2</code></span>
                  </div>
                  <div className="flex gap-2 text-[11px]">
                    <span className="font-black text-purple-700 flex-shrink-0">Option C:</span>
                    <span className="text-slate-700">Manual: sirf ek account Git-connected, baaki manually <code className="font-mono bg-white px-1 rounded">wrangler deploy</code></span>
                  </div>
                </div>
              </div>
            </section>

            {/* STEP 5 */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-emerald-600 text-white font-black text-sm flex items-center justify-center">✓</div>
                <div>
                  <h3 className="font-black text-base text-slate-900">Deploy ke baad</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Worker URL milega jaise <code className="font-mono">https://netflix.YOURNAME.workers.dev</code></p>
                </div>
              </div>
              <ol className="space-y-2 text-xs text-slate-700">
                <li className="flex gap-2"><span className="font-black text-emerald-600">1.</span> Worker URL copy karo</li>
                <li className="flex gap-2"><span className="font-black text-emerald-600">2.</span> Admin Panel → <b>Infrastructure</b> tab → <b>Primary Cloudflare Worker URLs</b> me paste karo</li>
                <li className="flex gap-2"><span className="font-black text-emerald-600">3.</span> Save karo — app automatically is worker se emails fetch karega</li>
              </ol>
              <div className="mt-4 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200">
                <p className="text-xs font-bold text-emerald-900 mb-1">🔄 Redeploy kaise karein</p>
                <p className="text-[11px] text-emerald-800">
                  Existing Worker connect karne ke baad sirf wait karne se old commit deploy nahi hota. <b>Save and Deploy</b> dabao, ya GitHub main branch pe NEW commit push karo, ya Deployments → Build history se build start/retry karo.
                </p>
              </div>
            </section>

            <section className="bg-amber-50 p-5 sm:p-6 rounded-2xl border border-amber-200 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-amber-500 text-white font-black text-sm flex items-center justify-center">!</div>
                <div>
                  <h3 className="font-black text-base text-amber-950">Why 10 minutes wait ke baad bhi build start nahi hua?</h3>
                  <ul className="mt-2 space-y-1.5 text-xs text-amber-900 list-disc list-inside">
                    <li><b>No builds exist yet</b> ka matlab GitHub Builds abhi run hi nahi hua.</li>
                    <li>Existing worker ko connect karne ke baad Cloudflare old commit ko baar-baar poll nahi karta.</li>
                    <li>Trigger ke liye <b>Save and Deploy</b>, ek <b>new GitHub commit</b>, ya Deployments → Build history → Retry/Start chahiye.</li>
                    <li>Blank build command me bhi <b>npm run build</b> chal raha hai to wrong preset/root detect hua — command clear karo aur Worker deploy use karo.</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* COPY SUMMARY */}
            <section className="bg-slate-900 text-white p-5 sm:p-6 rounded-2xl shadow-lg">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-sm text-emerald-400 uppercase tracking-wider">Copy-Paste Summary</h3>
                <button
                  type="button"
                  onClick={() => copyToClipboard(
                    "Root directory: /cloudflare-worker  (REQUIRED)\nProduction branch: main\nBuild command: (empty — auto npm run build = wrangler deploy)\nDeploy command: (empty — already deployed in build step)\nNon-prod branches: unchecked\nAPI Token: Use default",
                    "Settings copied"
                  )}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/20 border border-white/20"
                >Copy all</button>
              </div>
              <pre className="text-[11px] sm:text-xs font-mono leading-relaxed text-slate-300 overflow-x-auto">
{`Root directory:       /cloudflare-worker   ← REQUIRED
Production branch:    main
Build command:        (empty)              ← auto npm run build = wrangler deploy
Deploy command:       (empty)              ← already deployed in build step
Non-prod branches:    ☐ unchecked
Non-prod command:     (empty)
API Token:            Use default`}
              </pre>
            </section>
          </div>
        )}
      </main>

    </div>
  );
}

// ==================== CHANGE PASSWORD MODAL ====================
function ChangePasswordModal({ user, onDone, forced = false }: { user: UserData; onDone: () => void; forced?: boolean }) {
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!forced && !currentPass) { setError("Enter your current password"); return; }
    if (newPass.length < 6) { setError("Password must be at least 6 characters"); return; }
    if (newPass !== confirmPass) { setError("Passwords do not match"); return; }
    setLoading(true);
    try {
      await apiCall("manage-app", {
        action: "change_password", id: user.id,
        ...(forced ? {} : { current_password: currentPass }),
        new_password: newPass,
      });
      const stored = JSON.parse(sessionGet("user" as any) || "{}");
      stored.mustChangePassword = false;
      sessionSet("user" as any, JSON.stringify(stored));
      notify.success("Password changed successfully!");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-white w-full max-w-sm rounded-2xl p-6 shadow-2xl">
        <div className="flex justify-center mb-4">
          <div className="bg-gradient-to-br from-violet-500 to-purple-600 p-3 rounded-2xl shadow-lg shadow-purple-200">
            <Key className="text-white w-6 h-6" />
          </div>
        </div>
        <h2 className="text-xl font-black text-center text-slate-900 mb-1">
          {forced ? "Set Your Password" : "Change Password"}
        </h2>
        <p className="text-slate-500 text-center text-xs mb-6">
          {forced ? "For security, set a private password only you know." : "Update your password to keep your account secure."}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {!forced && (
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
              <PasswordInput value={currentPass} onChange={(e) => setCurrentPass(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-12 pr-12 focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                placeholder="Current password" required autoFocus />
            </div>
          )}
          <div className="relative">
            <Key className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
            <PasswordInput value={newPass} onChange={(e) => setNewPass(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-12 pr-12 focus:ring-2 focus:ring-purple-500 outline-none text-sm"
              placeholder="New password (min 6 chars)" required {...(forced ? { autoFocus: true } : {})} />
          </div>
          <div className="relative">
            <ShieldCheck className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
            <PasswordInput value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-12 pr-12 focus:ring-2 focus:ring-purple-500 outline-none text-sm"
              placeholder="Confirm new password" required />
          </div>
          {error && (
            <div className="bg-red-50 text-red-600 text-xs p-3 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </div>
          )}
          <div className="flex gap-3 pt-1">
            {!forced && (
              <button type="button" onClick={onDone}
                className="flex-1 bg-slate-100 text-slate-700 font-bold py-3 rounded-xl hover:bg-slate-200 transition-all active:scale-95">
                Cancel
              </button>
            )}
            <button type="submit" disabled={loading}
              className={`${forced ? "w-full" : "flex-1"} bg-gradient-to-r from-violet-500 to-purple-600 text-white font-bold py-3 rounded-xl hover:from-violet-600 hover:to-purple-700 transition-all active:scale-95 disabled:opacity-50 shadow-md shadow-purple-200`}>
              {loading ? "Saving..." : forced ? "Set Password" : "Update Password"}
            </button>
          </div>
        </form>
        <p className="text-[10px] text-slate-400 text-center mt-4">🔒 Your password is encrypted and secure.</p>
      </motion.div>
    </motion.div>
  );
}

function AvatarRow({
  category,
  userName,
  selectedAvatar,
  onPick,
  saving,
}: {
  category: typeof AVATAR_CATEGORIES[number];
  userName?: string;
  selectedAvatar: string | null;
  onPick: (id: string) => void;
  saving: boolean;
}) {
  return (
    <section id={`avatar-row-${category.key}`} className="scroll-mt-16">
      {/* Section title — desktop only. Mobile relies on the sticky tab strip. */}
      <div className="hidden sm:flex items-center justify-between px-5 mb-2">
        <h4 className="text-base font-black text-slate-900 tracking-tight">{category.label}</h4>
        <span className="text-[10px] font-bold text-slate-400">{category.files.length}</span>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2.5 sm:gap-3 px-3 sm:px-5 pb-3">
        {category.files.map((file) => {
          const id = buildAvatarId(category.key, file);
          const selected = selectedAvatar === id;
          return (
            <button
              key={id}
              onClick={() => onPick(id)}
              disabled={saving}
              title={prettyName(file)}
              className={`group relative aspect-square rounded-2xl overflow-hidden transition-all duration-200 active:scale-[0.94] ${
                selected
                  ? "ring-[2.5px] ring-red-600 shadow-md shadow-red-500/20"
                  : "ring-1 ring-slate-200/70 hover:ring-slate-300"
              }`}
            >
              <ProfileAvatar avatarId={id} name={userName} className="w-full h-full !rounded-2xl" eager />
              {/* Name overlay — desktop only. Cleaner mobile grid. */}
              <span className="hidden sm:block absolute inset-x-0 bottom-0 px-1.5 py-1 text-[10px] font-bold text-white text-center bg-gradient-to-t from-black/85 via-black/50 to-transparent truncate">
                {prettyName(file)}
              </span>
              {selected && (
                <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-600 flex items-center justify-center shadow-md ring-2 ring-white">
                  <Check className="w-3 h-3 text-white" strokeWidth={3.5} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}



function AvatarPicker({
  userName,
  selectedAvatar,
  onPick,
  saving,
}: {
  userName?: string;
  selectedAvatar: string | null;
  onPick: (id: string) => void;
  saving: boolean;
}) {
  const [activeCategoryKey, setActiveCategoryKey] = useState(() => getCategoryKeyFromAvatarId(selectedAvatar) || AVATAR_CATEGORIES[0]?.key || "");
  const [pendingCategoryKey, setPendingCategoryKey] = useState<string | null>(null);
  const activeCategory = AVATAR_CATEGORIES.find((c) => c.key === activeCategoryKey) || AVATAR_CATEGORIES[0];
  const activeIndex = Math.max(0, AVATAR_CATEGORIES.findIndex((c) => c.key === activeCategory.key));

  useEffect(() => {
    if (!activeCategory) return;
    void preloadAvatarCategory(activeCategory.key, 2500);
    const next = AVATAR_CATEGORIES[activeIndex + 1];
    const prev = AVATAR_CATEGORIES[activeIndex - 1];
    if (next) warmAvatarCategory(next.key, "low");
    if (prev) warmAvatarCategory(prev.key, "low");
  }, [activeCategory?.key, activeIndex]);

  useEffect(() => {
    let cancelled = false;
    const warmRest = async () => {
      const ordered = AVATAR_CATEGORIES.filter((category) => category.key !== activeCategory?.key);
      for (const category of ordered) {
        if (cancelled) return;
        warmAvatarCategory(category.key, "low");
        await preloadAvatarCategory(category.key, 1200, "low");
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    };
    const run = () => void warmRest();
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const idle = win.requestIdleCallback
      ? win.requestIdleCallback(run, { timeout: 1200 })
      : window.setTimeout(run, 700);
    return () => {
      cancelled = true;
      if (typeof idle === "number") window.clearTimeout(idle);
      if (win.cancelIdleCallback) win.cancelIdleCallback(idle);
    };
  }, [activeCategory?.key]);

  const selectCategory = (key: string) => {
    if (key === activeCategoryKey || pendingCategoryKey) return;
    setPendingCategoryKey(key);
    setActiveCategoryKey(key);
    preloadAvatarCategory(key, 1200).finally(() => setPendingCategoryKey(null));
  };

  const chipScrollRef = useRef<HTMLDivElement | null>(null);
  const [chipEdges, setChipEdges] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  const updateChipEdges = () => {
    const el = chipScrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setChipEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };

  useEffect(() => {
    updateChipEdges();
    const el = chipScrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateChipEdges, { passive: true });
    window.addEventListener("resize", updateChipEdges);
    return () => {
      el.removeEventListener("scroll", updateChipEdges);
      window.removeEventListener("resize", updateChipEdges);
    };
  }, []);

  // Auto-scroll nudge: scroll right ~120px then back so users notice the row scrolls
  useEffect(() => {
    const el = chipScrollRef.current;
    if (!el) return;
    if (el.scrollWidth <= el.clientWidth + 8) return;
    const start = el.scrollLeft;
    let raf1: number, raf2: number;
    const t1 = window.setTimeout(() => {
      el.scrollTo({ left: start + 140, behavior: "smooth" });
      const t2 = window.setTimeout(() => {
        el.scrollTo({ left: start, behavior: "smooth" });
      }, 700);
      raf2 = t2 as unknown as number;
    }, 450);
    raf1 = t1 as unknown as number;
    return () => {
      window.clearTimeout(raf1);
      window.clearTimeout(raf2);
    };
  }, []);

  // Center active chip when it changes
  useEffect(() => {
    const el = chipScrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLButtonElement>(`button[data-cat-key="${activeCategoryKey}"]`);
    if (active) {
      const target = active.offsetLeft - el.clientWidth / 2 + active.clientWidth / 2;
      el.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    }
  }, [activeCategoryKey]);

  const scrollChips = (dir: 1 | -1) => {
    const el = chipScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.7), behavior: "smooth" });
  };

  if (!activeCategory) return null;

  return (
    <div className="pb-4">
      {/* ============ HEADER (same on mobile + desktop) ============ */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 pt-3 pb-2">
        <div className="flex items-baseline justify-between mb-2.5">
          <h3 className="text-[15px] font-bold text-slate-900 tracking-tight">
            Choose an icon
          </h3>
          <span className="text-[11px] font-semibold text-slate-400">
            {saving ? "Saving…" : pendingCategoryKey ? "Loading…" : `${activeCategory.files.length} icons`}
          </span>
        </div>
        {/* Underline tab strip — Instagram / iOS style */}
        <div className="relative -mx-4">
          {chipEdges.left && (
            <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-white to-transparent z-10" />
          )}
          {chipEdges.right && (
            <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-white to-transparent z-10" />
          )}
          <div
            ref={chipScrollRef}
            className="flex gap-5 overflow-x-auto scrollbar-none px-4"
            style={{ scrollbarWidth: "none" }}
          >
            {AVATAR_CATEGORIES.map((c) => {
              const active = activeCategoryKey === c.key;
              const pending = pendingCategoryKey === c.key;
              return (
                <button
                  key={c.key}
                  data-cat-key={c.key}
                  onClick={() => selectCategory(c.key)}
                  onMouseEnter={() => warmAvatarCategory(c.key, "low")}
                  className={`flex-shrink-0 relative pb-2 pt-1 text-[13px] font-semibold whitespace-nowrap transition-colors ${
                    active ? "text-red-600" : pending ? "text-slate-900" : "text-slate-500"
                  }`}
                >
                  {c.label}
                  {active && (
                    <span className="absolute inset-x-0 -bottom-px h-[2.5px] bg-red-600 rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="pt-4">
        <AvatarRow
          key={activeCategory.key}
          category={activeCategory}
          userName={userName}
          selectedAvatar={selectedAvatar}
          onPick={onPick}
          saving={saving}
        />
      </div>
    </div>
  );
}

function UserProfileModal({
  user,
  prefs,
  onPrefsSaved,
  onPassword,
  onClose,
}: {
  user: UserData;
  prefs: UserProfilePrefs;
  onPrefsSaved: (prefs: UserProfilePrefs) => void;
  onPassword: () => void;
  onClose: () => void;
}) {
  const [savingAvatar, setSavingAvatar] = useState(false);
  const selectedAvatar = prefs.avatarId || getStableProfileAvatar(user);

  useEffect(() => {
    const selectedUri = getAvatarUri(selectedAvatar);
    warmAvatarUrls(selectedUri ? [selectedUri] : [], "high");
    if (AVATAR_CATEGORIES[0]) warmAvatarCategory(AVATAR_CATEGORIES[0].key, "high");
  }, [selectedAvatar]);

  const saveAvatar = async (avatarId: string) => {
    if (savingAvatar) return;
    if (avatarId === prefs.avatarId) return;

    // Global cooldown for free profiles: block preemptively so we don't
    // even hit the server if the window is still open.
    if (user.isFree) {
      const cd = getFreeAvatarCooldown();
      const lastMs = cd.lastAt ? Date.parse(cd.lastAt) : 0;
      const windowMs = (cd.minutes || 5) * 60_000;
      const remainMs = lastMs ? windowMs - (Date.now() - lastMs) : 0;
      if (remainMs > 0) {
        const s = Math.ceil(remainMs / 1000);
        const label = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
        notify.info("Profile icon recently updated", {
          description: `Please wait ${label} before changing again.`,
        });
        return;
      }
    }

    const nextPrefs = { ...prefs, avatarId };
    setSavingAvatar(true);
    onPrefsSaved(nextPrefs);
    try {
      const stored = JSON.parse(sessionGet("user" as any) || "{}");
      stored.profilePrefs = nextPrefs;
      stored.profileAvatar = avatarId;
      sessionSet("user" as any, JSON.stringify(stored));
    } catch {}
    if (user?.id) {
      patchBootstrapCacheUser(user.id, { profile_prefs: nextPrefs, profileAvatar: avatarId });
    }
    try {
      const res: any = await apiCall("manage-app", { action: "update_profile_prefs", profile_prefs: nextPrefs });
      if (res && res.success === false && res.code === "AVATAR_COOLDOWN") {
        // Server rejected — sync local cooldown state, revert optimistic patch.
        setFreeAvatarCooldown({ minutes: Number(res.minutes) || 5, lastAt: res.lastAt || null });
        const s = Math.max(1, Number(res.retryAfterSec) || 1);
        const label = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
        notify.info("Profile icon recently updated", {
          description: `Please wait ${label} before changing again.`,
        });
        onPrefsSaved(prefs);
        refreshBootstrap().catch(() => {});
        return;
      }
      if (res?.freeAvatarCooldown) setFreeAvatarCooldown(res.freeAvatarCooldown);
      notify.success("Profile icon updated");
      refreshBootstrap().catch(() => {});
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Could not save icon");
    } finally {
      setSavingAvatar(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-end justify-center"
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ y: "100%", opacity: 0, scale: 1 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: "100%", opacity: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        className="bg-white w-full max-w-lg rounded-t-[28px] shadow-2xl overflow-hidden max-h-[92vh] h-[88vh] flex flex-col"
      >
        {/* Drag-handle — shown on every device for the same look */}
        <div className="flex justify-center pt-2.5 pb-1.5 flex-shrink-0">
          <span className="block w-10 h-1.5 rounded-full bg-slate-300" aria-hidden="true" />
        </div>
        <div className="px-4 pt-2 pb-3 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <ProfileAvatar avatarId={selectedAvatar} name={user.name} className="w-11 h-11 sm:w-12 sm:h-12" fallbackColor="bg-red-500" eager />
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-black text-slate-900 leading-tight truncate">{user.name}</h2>
              {user.username ? (
                <p className="text-xs text-slate-500 truncate">@{user.username}</p>
              ) : user.isFree ? (
                <p className="text-[10px] font-black tracking-[0.14em] uppercase text-emerald-600">Free profile</p>
              ) : null}
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 hover:bg-slate-100 rounded-full transition-colors" aria-label="Close profile">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>


        <div className="flex-1 overflow-y-auto">
          <AvatarPicker
            userName={user.name}
            selectedAvatar={selectedAvatar}
            onPick={saveAvatar}
            saving={savingAvatar}
          />
        </div>
      </motion.div>
    </motion.div>
  );
}

// ==================== EMAIL VIEWER ====================
function EmailViewer() {
  usePageHead("Email Inbox — Netflix Mail", "Secure viewer for Netflix sign-in codes, OTPs, and household verification emails.", "/viewer");
  const { user: authUser, checkAuth } = useAuth();
  const user = useMemo<UserData>(() => {
    let stored: UserData | null = null;
    try { stored = JSON.parse(sessionGet("user" as any) || "{}"); }
    catch { stored = null; }
    try {
      const impersonating = (stored as any)?.impersonated === true;
      if (impersonating && stored?.id) return stored;
    } catch {}
    if (authUser?.id) return authUser as UserData;
    return stored || ({} as UserData);
  }, [authUser]);
  const refreshAccountLabels = useMemo(() => getUserRefreshAccountLabels(user), [user]);
  const [profilePrefs, setProfilePrefs] = useState<UserProfilePrefs>(() => user.profilePrefs || {});
  const viewerAvatarId = profilePrefs.avatarId || getStableProfileAvatar(user);
  // Change password modal (self-service, works for admin + regular users; hidden for free profiles)
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [cpCurrent, setCpCurrent] = useState("");
  const [cpNext, setCpNext] = useState("");
  const [cpConfirm, setCpConfirm] = useState("");
  const [cpShow, setCpShow] = useState(false);
  const [cpBusy, setCpBusy] = useState(false);
  const canChangePassword = !!user.id && !user.isFree;
  const submitChangePassword = useCallback(async () => {
    if (!user.id) return;
    if (!cpCurrent.trim()) { notify.error("Enter your current password"); return; }
    if (cpNext.length < 6) { notify.error("New password must be at least 6 characters"); return; }
    if (cpNext !== cpConfirm) { notify.error("New passwords do not match"); return; }
    if (cpNext === cpCurrent) { notify.error("New password must be different"); return; }
    setCpBusy(true);
    try {
      await apiCall("manage-app", { action: "change_password", id: user.id, current_password: cpCurrent, new_password: cpNext });
      notify.success("Password changed successfully");
      setCpCurrent(""); setCpNext(""); setCpConfirm(""); setShowChangePwd(false);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "Failed to change password");
    } finally { setCpBusy(false); }
  }, [user.id, cpCurrent, cpNext, cpConfirm]);
  const saveProfilePrefsLocally = useCallback((nextPrefs: UserProfilePrefs) => {
    setProfilePrefs(nextPrefs);
    try {
      const stored = JSON.parse(sessionGet("user" as any) || "{}");
      stored.profilePrefs = nextPrefs;
      stored.profileAvatar = nextPrefs.avatarId || null;
      sessionSet("user" as any, JSON.stringify(stored));
    } catch {}
  }, []);
  const [emails, setEmailsRaw] = useState<Email[]>([]);
  const emailsRef = useRef<Email[]>([]);
  const setEmails = useCallback((next: Email[]) => {
    const visible = filterVisibleEmails(next, profilePrefs, user)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    emailsRef.current = visible;
    setEmailsRaw(visible);
  }, [profilePrefs, user]);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [loadingEmailHtmlId, setLoadingEmailHtmlId] = useState<string | null>(null);
  const [emailHtmlLoadError, setEmailHtmlLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [otpCopied, setOtpCopied] = useState(false);
  const navigate = useNavigate();
  const [showChangePassword, setShowChangePassword] = useState(!!user.mustChangePassword);
  const [showProfile, setShowProfile] = useState(false);
  const [forcedPasswordChange] = useState(!!user.mustChangePassword);
  // Impersonation state is server-signed and backed by the parent admin session row.
  const isImpersonating = (user as any)?.impersonated === true;
  // TV Auto-Login visibility priority: per-user override ALWAYS wins over
  // the global switch. Show = forced visible even if admin's global is OFF.
  // Hide = forced hidden even if admin's global is ON. No override = follow global.

  const [viewerTvOverride, setViewerTvOverride] = useState<"on" | "off" | null>(() => normalizeTvOverride((user as any)?.tvOverride));
  const [tvGlobalOn, setTvGlobalOn] = useState<boolean>(() => {
    if (typeof (user as any)?.tvFeatureEnabled === "boolean") return (user as any).tvFeatureEnabled !== false;
    const bs = readBootstrapCache();
    return bs?.tvFeature?.enabled !== false;
  });
  useEffect(() => {
    setViewerTvOverride(normalizeTvOverride((user as any)?.tvOverride));
    if (typeof (user as any)?.tvFeatureEnabled === "boolean") setTvGlobalOn((user as any).tvFeatureEnabled !== false);
  }, [user?.id, (user as any)?.tvOverride, (user as any)?.tvFeatureEnabled]);
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      // Ground-truth check: hit get_settings directly so a stale bootstrap
      // cache (local or worker) can't leave the TV icon visible after admin
      // flipped the global toggle OFF.
      try {
        const res: any = await apiCall("manage-app", { action: "get_settings", key: "tv_feature" });
        if (cancelled) return;
        const enabled = res?.value?.enabled !== false;
        setTvGlobalOn(enabled);
      } catch {
        // Fall back to bootstrap if get_settings fails.
        try {
          const bs = await refreshBootstrap();
          if (!cancelled) setTvGlobalOn(bs?.tvFeature?.enabled !== false);
        } catch {}
      }
    };
    sync();
    const onVis = () => { if (document.visibilityState === "visible") sync(); };
    const applyEvent = (event: TvFeatureEvent) => {
      if (!event || typeof event !== "object") return;
      if (event.type === "tv-global") {
        setTvGlobalOn(event.enabled !== false);
        return;
      }
      if (event.type === "tv-profile" && event.userId === user.id) {
        const next = normalizeTvOverride(event.tvOverride);
        setViewerTvOverride(next);
        applyTvOverrideToStoredUser(user.id, next);
      }
    };
    const onWindowEvent = (event: Event) => applyEvent((event as CustomEvent<TvFeatureEvent>).detail);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener(TV_FEATURE_CHANNEL, onWindowEvent);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(TV_FEATURE_CHANNEL);
      channel.onmessage = (event) => applyEvent(event.data as TvFeatureEvent);
    } catch {}
    const id = window.setInterval(sync, 60_000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener(TV_FEATURE_CHANNEL, onWindowEvent);
      try { channel?.close(); } catch {}
      window.clearInterval(id);
    };
  }, [user.id]);
  const tvVisible = useMemo(() => {
    const ov = viewerTvOverride;
    if (ov === "on") return true; // per-user override always wins over global
    if (ov === "off") return false;
    return tvGlobalOn;
  }, [viewerTvOverride, tvGlobalOn]);

  // Per-user feature flags (Gmail / TV / Direct Link). Admin-controlled.
  const userFeatures = useMemo(() => {
    const f = resolveFeatures(user);
    // Respect existing tvVisible layering (global switch + per-user override)
    return { ...f, tv: f.tv && tvVisible };
  }, [user, tvVisible]);
  const { view: workflowView, setChoice: setWorkflowViewRaw } = useWorkflowView(user, userFeatures);
  const setWorkflowView = useCallback((v: "gmail" | "tv" | "link") => {
    setWorkflowViewRaw(v);
    // Persist to the server so the choice follows the user across browsers/devices.
    // Fire-and-forget — a network hiccup should never block the UI transition.
    try {
      apiCall("manage-app", { action: "set_workflow_view", view: v })
        .then(() => { try { (user as any).lastWorkflowView = v; } catch {} })
        .catch(() => {});
    } catch {}
  }, [setWorkflowViewRaw, user]);
  const [tvModalTrigger, setTvModalTrigger] = useState(0);
  // Prefetch TV / Link accounts as soon as features resolve — avoids the 5s wait later.
  useEffect(() => { try { prefetchWorkflowAccounts(apiCall, userFeatures); } catch {} }, [userFeatures.tv, userFeatures.link]);



  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const refreshPollRef = useRef<number | null>(null);
  const [resolvedWorkerUrls, setResolvedWorkerUrls] = useState<string[]>(() => getStoredWorkerUrls());
  const [workerUrlMap, setWorkerUrlMap] = useState<WorkerUrlMap>({ primary: [], byAccount: {} });
  const [workerUrlsLoading, setWorkerUrlsLoading] = useState(true);
  const workerUrlLoaded = React.useRef(false);
  const inboxSessionStartedRef = useRef(false);
  const markInboxReady = useCallback(() => {
    if (inboxSessionStartedRef.current) return;
    inboxSessionStartedRef.current = true;
    if (!sessionGet("session_started_at" as any)) markSessionStart();
  }, []);

  const refreshEmailFiltersForViewer = useCallback(async () => {
    try {
      const fresh = await apiCall("manage-app", { action: "get_settings", key: "email_filters" });
      if (fresh?.value && typeof fresh.value === "object") setEmailFiltersCache(fresh.value);
      else setEmailFiltersCache({ showSignInCodes: true, showPasswordResets: true, showAccountUpdates: true });
    } catch {
      setEmailFiltersCache({ showSignInCodes: true, showPasswordResets: true, showAccountUpdates: true });
    }
  }, []);

  // F7: refresh diagnostics — records each worker hit while the
  // spinner is running so we can tell WHY it never stops.
  type DiagEntry = {
    ts: number; kind: "worker" | "sync" | "iframe" | "cache";
    endpoint: string; status?: number; ms?: number;
    cacheStatus?: string; cacheAge?: string; cacheKey?: string;
    error?: string; note?: string;
  };
  const [diag, setDiag] = useState<DiagEntry[]>([]);
  const [showDiag, setShowDiag] = useState(false);
  const pushDiag = useCallback((e: DiagEntry) => {
    setDiag((prev) => [e, ...prev].slice(0, 40));
  }, []);
  const clearDiag = useCallback(() => setDiag([]), []);

  const backToAdmin = async () => {
    // Preferred path: server swaps the impersonated session for a fresh admin
    // session via the adminId captured at impersonate time. Survives refresh
    // because no client-side backup is required.
    try {
      notify.loading("Returning to admin…", { id: "back-to-admin" });
      const data = await apiCall("manage-app", { action: "back_to_admin" });
      notify.dismiss("back-to-admin");
      if (data?.sessionToken) sessionSet("session_token" as any, data.sessionToken);
      if (data?.user) sessionSet("user" as any, JSON.stringify(data.user));
      try { sessionRemove("admin_backup" as any); } catch {}
      try { if (!sessionGet("session_started_at" as any)) markSessionStart(); } catch {}
      checkAuth();
      navigate("/admin/dashboard");
      return;
    } catch (err) {
      notify.dismiss("back-to-admin");
      notify.error(err instanceof Error ? err.message : "Failed to return to admin");
      navigate("/admin");
    }
  };


  useEffect(() => {
    if (workerUrlLoaded.current) return;
    workerUrlLoaded.current = true;
    (async () => {
      const primaryUrls: string[] = [];
      const accountUrls: Record<string, string[]> = {};

      try {
        const pcf = await apiCall("manage-app", { action: "get_settings", key: "primary_cloudflare_urls" });
        if (pcf.value && Array.isArray(pcf.value)) {
          for (const u of pcf.value) {
            const trimmed = u.trim().replace(/\/+$/, "");
            if (trimmed && !primaryUrls.includes(trimmed)) primaryUrls.push(trimmed);
          }
        }
      } catch { }
      try {
        const data = await apiCall("manage-app", { action: "get_settings", key: "email_accounts" });
        if (data.value && Array.isArray(data.value)) {
          for (const acc of data.value) {
            const label = acc.label || acc.user;
            const accUrls: string[] = [];
            if (acc.cloudflareUrls && Array.isArray(acc.cloudflareUrls)) {
              for (const u of acc.cloudflareUrls) {
                const trimmed = u.trim().replace(/\/+$/, "");
                if (trimmed) accUrls.push(trimmed);
              }
            }
            if (acc.cloudflareUrl && acc.cloudflareUrl.trim()) {
              const trimmed = acc.cloudflareUrl.trim().replace(/\/+$/, "");
              if (!accUrls.includes(trimmed)) accUrls.push(trimmed);
            }
            if (accUrls.length > 0 && label) {
              accountUrls[label] = accUrls;
            }
          }
        }
      } catch { }

      // Only primary URLs go into the general pool (used by apiCall)
      const normalizedPrimaryRaw = primaryUrls
        .map((u) => u.trim().replace(/\/+$/, ""))
        .filter(Boolean)
        .filter((u, i, arr) => arr.indexOf(u) === i);

      const primaryChecks = await Promise.all(normalizedPrimaryRaw.map(async (url) => ({ url, ok: await isUsableEmailWorker(url) })));
      const normalizedPrimary = primaryChecks.filter((x) => x.ok).map((x) => x.url);

      const usableAccountUrls: Record<string, string[]> = {};
      await Promise.all(Object.entries(accountUrls).map(async ([label, urls]) => {
        const unique = Array.from(new Set(urls.map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean)));
        const checks = await Promise.all(unique.map(async (url) => ({ url, ok: await isUsableEmailWorker(url) })));
        const valid = checks.filter((x) => x.ok).map((x) => x.url);
        if (valid.length > 0) usableAccountUrls[label] = valid;
      }));

      setResolvedWorkerUrls(normalizedPrimary);
      setWorkerUrlMap({ primary: normalizedPrimary, byAccount: usableAccountUrls });
      if (normalizedPrimary.length > 0) storeWorkerUrls(normalizedPrimary);
      setWorkerUrlsLoading(false);
    })();
  }, []);

  // Op#2: Worker-first list_delta. Steady-state polls hit the 30s KV cache
  // and return a tiny empty-diff, cutting cached_emails DB reads by ~97%.
  // Falls through to direct Supabase edge on any worker miss/error.
  const fetchListDelta = useCallback(async (params: { since: number; limit: number; baseline?: boolean }) => {
    const token = getSessionToken();
    const workerUrls = resolvedWorkerUrls || [];
    if (token && workerUrls.length > 0) {
      const workerBase = workerUrls[Math.floor(Math.random() * workerUrls.length)].replace(/\/+$/, "");
      try {
        const res = await fetchWithTimeout(`${workerBase}/api/inbox/list`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Session-Token": token },
          body: JSON.stringify(params),
        }, 8000);
        if (res.ok) {
          const data = await res.json();
          if (data?.success) {
            pushDiag({
              ts: Date.now(), kind: "cache", endpoint: `${workerBase}/api/inbox/list`,
              status: res.status,
              cacheStatus: res.headers.get("X-Cache-Status") || undefined,
              cacheAge: res.headers.get("X-Cache-Age") || undefined,
            });
            return data;
          }
        }
      } catch (e) {
        pushDiag({ ts: Date.now(), kind: "cache", endpoint: `${workerBase}/api/inbox/list`, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return await apiCall("manage-app", { action: "list_delta", ...params });
  }, [resolvedWorkerUrls, pushDiag]);

  const loadCachedEmailsDirect = useCallback(async (limit = 200): Promise<Email[]> => {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const started = performance.now();
    const delta = await fetchListDelta({ since: 0, limit: safeLimit, baseline: true });
    const rows = Array.isArray(delta?.rows) ? delta.rows as Email[] : [];
    pushDiag({
      ts: Date.now(),
      kind: "sync",
      endpoint: "list_delta:baseline",
      ms: Math.round(performance.now() - started),
      note: `${rows.length} cached rows`,
      error: delta?.success === false ? (delta?.error || "Cache load failed") : undefined,
    });
    const currentEmails = emailsRef.current;
    if (rows.length === 0 && currentEmails.length > 0) {
      pushDiag({ ts: Date.now(), kind: "sync", endpoint: "list_delta:baseline", note: "empty response ignored; preserving visible inbox" });
      return currentEmails;
    }
    // Baseline reads are a snapshot of what the server returned right now, not
    // an explicit delete list. Never let a shorter/filtered baseline erase rows
    // already painted from IndexedDB; only delta removedIds may remove emails.
    const merged = currentEmails.length > 0 ? mergeEmailsById([rows, currentEmails]) : rows;
    setEmails(merged);
    setError(null);
    setLastUpdated(new Date());
    return merged;
  }, [pushDiag, setEmails, emails, fetchListDelta]);

  const loadCachedEmails = useCallback(async (opts?: { bust?: boolean; limit?: number }) => {
    const bust = !!opts?.bust;
    const limit = opts?.limit || 3;
    try {
      const { ensureFreshAccess } = await import("./lib/sessionRefresh");
      await ensureFreshAccess(30_000).catch(() => {});
      const token = getSessionToken();
      const headers: Record<string, string> = {};
      if (token) headers["X-Session-Token"] = token;

      const labels = refreshAccountLabels;
      if (labels === undefined) {
        pushDiag({ ts: Date.now(), kind: "cache", endpoint: "loadCachedEmails", note: "account scope hydrating; keeping current inbox" });
        return filterVisibleEmails(emailsRef.current, profilePrefs, user).length;
      }
      if (labels && labels.length === 0) {
        setEmails([]);
        setError(null);
        setLastUpdated(new Date());
        return 0;
      }

      // Source of truth first: read the signed, server-filtered inbox directly.
      // Cloudflare workers are only a fallback cache; if they are stale/misconfigured
      // they must not hide newly synced rows from assigned accounts.
      const directFirst = await loadCachedEmailsDirect(limit).catch(() => null);
      if (directFirst) return filterVisibleEmails(directFirst, profilePrefs, user).length;

      const groups = buildWorkerRequestGroups(labels, workerUrlMap, resolvedWorkerUrls);
      if (groups.length === 0) {
        // No usable Worker configured — load the real cached inbox directly from Supabase.
        const direct = await loadCachedEmailsDirect(limit).catch(() => null);
        return direct ? filterVisibleEmails(direct, profilePrefs, user).length : filterVisibleEmails(emailsRef.current, profilePrefs, user).length;
      }

      const lists = await Promise.all(groups.map(async (group) => {
        const params = new URLSearchParams({ limit: String(limit) });
        if (bust) params.set("bust", "1");
        appendAccountLabelParams(params, group.labels);
        const workerEndpoint = `${group.url}/api/emails?${params.toString()}`;
        const started = performance.now();
        const res = await fetchWithTimeout(workerEndpoint, { headers }, 12000);
        const text = await res.text();
        pushDiag({
          ts: Date.now(),
          kind: "worker",
          endpoint: workerEndpoint,
          status: res.status,
          ms: Math.round(performance.now() - started),
          cacheStatus: res.headers.get("X-Cache-Status") || undefined,
          cacheAge: res.headers.get("X-Cache-Age") || undefined,
          cacheKey: res.headers.get("X-Cache-Key") || undefined,
          note: `${bust ? "bust=1" : "kv"}${group.labels ? ` · ${group.labels.join(", ")}` : ""}`,
        });
        if (!res.ok) {
          // Never surface raw transport JSON like `{"error":"encrypted transport required"}`.
          // Treat as an empty response and keep existing emails visible.
          return { ok: false, emails: [] as Email[] };
        }
        let data: any = [];
        try { data = text ? JSON.parse(text) : []; } catch { data = []; }
        return { ok: true, emails: Array.isArray(data) ? data as Email[] : [] };
      }));

      const okCount = lists.filter((item) => item.ok).length;
      if (okCount === 0) {
        const direct = await loadCachedEmailsDirect(limit).catch(() => null);
        return direct ? filterVisibleEmails(direct, profilePrefs, user).length : filterVisibleEmails(emailsRef.current, profilePrefs, user).length;
      }
      const currentEmails = emailsRef.current;
      const emailList = mergeEmailsById([...lists.map((item) => item.emails), currentEmails]);
      if (emailList.length === 0 && currentEmails.length > 0) {
        const direct = await loadCachedEmailsDirect(limit).catch(() => null);
        return direct ? filterVisibleEmails(direct, profilePrefs, user).length : filterVisibleEmails(currentEmails, profilePrefs, user).length;
      }
      setEmails(emailList);
      setError(null);
      setLastUpdated(new Date());
      return filterVisibleEmails(emailList, profilePrefs, user).length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load emails";
      pushDiag({ ts: Date.now(), kind: "cache", endpoint: "loadCachedEmails", error: msg });
      // Preserve currently-shown emails; do not blank the inbox on transient error.
      return filterVisibleEmails(emailsRef.current, profilePrefs, user).length;
    }
  }, [profilePrefs, setEmails, pushDiag, resolvedWorkerUrls, workerUrlMap, refreshAccountLabels, user, loadCachedEmailsDirect]);


  const syncViaWorker = useCallback(async (): Promise<{ emails: Email[]; inserted: number; warning: string | null; fallback: boolean } | null> => {
    const labels = refreshAccountLabels;
    if (labels && labels.length === 0) return null;
    const { ensureFreshAccess } = await import("./lib/sessionRefresh");
    await ensureFreshAccess(30_000).catch(() => {});
    const token = sessionGet("session_token" as any);
    const groups = buildWorkerRequestGroups(labels, workerUrlMap, resolvedWorkerUrls || []);
    if (groups.length === 0 || !token) {
      pushDiag({ ts: Date.now(), kind: "sync", endpoint: "worker:sync", error: "No Cloudflare Worker URL configured" });
      return null;
    }
    const results = await Promise.all(groups.map(async (group) => {
      const workerBase = group.url.replace(/\/+$/, "");
      const started = performance.now();
      try {
        const res = await fetchWithTimeout(`${workerBase}/api/emails/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Session-Token": String(token) },
          body: JSON.stringify({
            mode: "user_sync",
            source: "user_refresh",
            limit: 200,
            accountLabels: group.labels || undefined,
          }),
        }, 15000);
        const data = await res.json().catch(() => null);
        pushDiag({
          ts: Date.now(),
          kind: "sync",
          endpoint: `${workerBase}/api/emails/sync`,
          status: res.status,
          ms: Math.round(performance.now() - started),
          note: group.labels ? group.labels.join(", ") : "all accounts",
          error: !res.ok ? (data?.error || `HTTP ${res.status}`) : undefined,
        });
        if (!res.ok || !data || data.success === false) return null;
        return {
          emails: Array.isArray(data?.emails) ? data.emails as Email[] : [],
          inserted: Number(data?.inserted ?? data?.stats?.inserted ?? 0) || 0,
          warning: typeof data?.warning === "string" ? data.warning : null,
          fallback: data?.fallback === true,
        };
      } catch (err) {
        pushDiag({ ts: Date.now(), kind: "sync", endpoint: `${workerBase}/api/emails/sync`, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }));
    const ok = results.filter((r): r is { emails: Email[]; inserted: number; warning: string | null; fallback: boolean } => r !== null);
    if (ok.length === 0) return null;
    return {
      emails: mergeEmailsById(ok.map((r) => r.emails)),
      inserted: ok.reduce((sum, r) => sum + r.inserted, 0),
      warning: ok.map((r) => r.warning).filter(Boolean).join(" • ") || null,
      fallback: ok.some((r) => r.fallback),
    };
  }, [pushDiag, refreshAccountLabels, resolvedWorkerUrls, workerUrlMap]);

  const syncDirectFromSupabase = useCallback(async (): Promise<EmailSyncResult | null> => {
    const labels = refreshAccountLabels;
    if (labels && labels.length === 0) return null;
    try {
      const data: any = await apiCall("fetch-emails", {
        mode: "user_sync",
        source: "user_refresh_direct",
        limit: 200,
        accountLabels: labels || undefined,
      });
      pushDiag({
        ts: Date.now(),
        kind: "sync",
        endpoint: "supabase:functions/fetch-emails",
        status: data?.success === false ? 502 : 200,
        note: labels ? labels.join(", ") : "all accounts",
        error: data?.success === false ? (data?.error || "Sync failed") : undefined,
      });
      if (!data || data.success === false) return null;
      return {
        emails: Array.isArray(data?.emails) ? data.emails as Email[] : [],
        inserted: Number(data?.inserted ?? data?.stats?.inserted ?? 0) || 0,
        warning: typeof data?.warning === "string" ? data.warning : null,
        fallback: data?.fallback === true,
      };
    } catch (err) {
      pushDiag({ ts: Date.now(), kind: "sync", endpoint: "supabase:functions/fetch-emails", error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }, [pushDiag, refreshAccountLabels]);


  const fetchEmails = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const beforeIds = new Set(emails.map((e) => e.id));
    const toastId = "nf-refresh";
    notify.loading("Checking Netflix mail…", { id: toastId });
    const runRefresh = async () => {
      await refreshEmailFiltersForViewer();
      await loadCachedEmails({ limit: 200 });
      // Manual refresh must not depend on Cloudflare Worker health/config.
      // Use the Supabase IMAP sync first; Worker is only a last-resort cache path.
      return (await syncDirectFromSupabase()) || (await syncViaWorker());
    };
    try {
      let synced: Awaited<ReturnType<typeof syncViaWorker>> = null;
      try {
        synced = await runRefresh();
      } catch (transient) {
        const tmsg = transient instanceof Error ? transient.message : String(transient);
        if (/Secure connection|handshake|Failed to fetch|NetworkError|busy/i.test(tmsg)) {
          await new Promise((r) => setTimeout(r, 700));
          synced = await runRefresh();
        } else {
          throw transient;
        }
      }
      let merged: Email[] = emailsRef.current;
      if (synced) {
        // fetch-emails returns only newly fetched rows. Repaint from the full
        // cached inbox after sync so a zero-new refresh never blanks the inbox.
        const cachedAfterSync = await loadCachedEmailsDirect(200).catch(() => null);
        const currentEmails = emailsRef.current;
        merged = cachedAfterSync || (synced.emails.length > 0 ? mergeEmailsById([synced.emails, currentEmails]) : currentEmails);
        setEmails(merged);
        setError(null);
        setLastUpdated(new Date());
      }
      const visible = filterVisibleEmails(merged, profilePrefs, user);
      const newCount = visible.filter((e) => !beforeIds.has(e.id)).length;
      notify.dismiss(toastId);
      // "skipped by recipient filter" just means the mail belongs to a different
      // mailbox account — it's not an error, silently ignore that warning.
      const benignWarning = synced?.warning && /skipped by recipient filter/i.test(synced.warning);
      if (synced?.warning && !benignWarning) {
        // Server-side sync had a real problem (IMAP down, fallback, etc.).
        notify.warning("Mail server issue", {
          description: synced.warning,
          duration: 4000,
        });
      } else if (newCount > 0) {
        notify.info(`${newCount} new email${newCount === 1 ? "" : "s"} arrived`, {
          description: "Freshly delivered to your inbox",
          duration: 2600,
        });
      } else if (synced && synced.inserted > 0) {
        // Server saved new rows but our visible filter hid them (assigned-account scope, etc.)
        notify.info(`${synced.inserted} new email${synced.inserted === 1 ? "" : "s"} synced`, {
          description: "Not visible in this inbox view",
          duration: 3000,
        });
      } else if (!synced) {
        notify.error("Sync did not run", { description: "Worker and direct email function both failed", duration: 3400 });
      } else {
        notify.success(visible.length > 0 ? "No new mail yet" : "No Netflix emails yet", {
          duration: 2000,
        });
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load";
      notify.dismiss(toastId);
      if (/Secure connection|handshake|Failed to fetch|NetworkError|busy|timeout|temporar/i.test(msg)) {
        await loadCachedEmails({ limit: 200 });
        notify.info("Inbox is still available", { description: "Mail check is retrying in the background.", duration: 2600 });
      } else {
        notify.error("Mail check needs attention", { description: msg, duration: 3200 });
      }



    } finally {
      if (refreshPollRef.current) {
        clearTimeout(refreshPollRef.current);
        refreshPollRef.current = null;
      }
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };


  // On mount/login: load cached emails only. NO auto sync — sync happens
  // exclusively when the user clicks the Refresh button (fetchEmails).
  const didAutoRefreshRef = useRef(false);
  useEffect(() => {
    setLoading(false);

    if (workerUrlsLoading) return;
    if (didAutoRefreshRef.current) return;
    didAutoRefreshRef.current = true;

    (async () => {
      try {
        await refreshEmailFiltersForViewer();
        await loadCachedEmails({ limit: 200 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err || "");
        pushDiag({ ts: Date.now(), kind: "sync", endpoint: "login cache load", error: msg });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerUrlsLoading]);


  // F7: listen for iframe self-report messages verifying that the link/button
  // click hijack is actually attached inside the sandboxed email preview.
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d: any = ev.data;
      if (!d || typeof d !== "object" || d.__nf !== "iframe-links") return;
      pushDiag({
        ts: Date.now(),
        kind: "iframe",
        endpoint: "email preview",
        note: `links=${d.links} buttons=${d.buttons} hijack=${d.hijack ? "ON" : "OFF"} target=${d.baseTarget || "?"}`,
        error: d.hijack ? undefined : "link hijack not active",
      });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [pushDiag]);



  // ============================================================================
  // INSTANT INBOX — Gmail-style stale-while-revalidate via IndexedDB + delta sync
  //  1) Open per-user IDB, read latest 50 rows → paint (target < 50ms)
  //  2) Fire /list_delta with last cursor → merge new/updated/removed → repaint
  // Runs in parallel with the existing worker refresh path (which stays as
  // a redundant sync). Falls back silently on any error — no user-visible break.
  // ============================================================================
  const idbRef = useRef<Awaited<ReturnType<typeof openInboxDB>> | null>(null);
  const instantInboxRunKeyRef = useRef("");
  const instantInboxAccountKey = useMemo(
    () => refreshAccountLabels === undefined
      ? "unknown"
      : JSON.stringify(refreshAccountLabels === null ? null : [...refreshAccountLabels].sort()),
    [refreshAccountLabels],
  );
  useEffect(() => {
    // Hard-gate: no Gmail/IMAP work unless the user is in the Gmail workflow.
    // TV and Direct-Link views must never trigger list_delta, IDB paint,
    // worker refresh, or any fetch-emails call.
    if (workflowView !== "gmail") return;
    const runKey = `${user?.id || ""}:${instantInboxAccountKey}`;
    if (instantInboxRunKeyRef.current === runKey) return;
    if (!user?.id) return;
    if (refreshAccountLabels === undefined) {
      pushDiag({ ts: Date.now(), kind: "cache", endpoint: "idb:instant-paint", note: "account scope hydrating, painting local cache only" });
      (async () => {
        try {
          const db = await openInboxDB(user.id);
          idbRef.current = db;
          const cached = await readLatestEmails(db, 200, undefined);
          if (cached.length > 0) {
            setEmails(cached as unknown as Email[]);
            setLastUpdated(new Date());
            markInboxReady();
            pushDiag({ ts: Date.now(), kind: "cache", endpoint: "idb:instant-paint", note: `${cached.length} rows while account scope hydrates` });
          }
        } catch (err) {
          pushDiag({ ts: Date.now(), kind: "cache", endpoint: "idb:instant-paint", error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }
    instantInboxRunKeyRef.current = runKey;

    const t0 = performance.now();
    (async () => {
      let db: Awaited<ReturnType<typeof openInboxDB>> | null = null;
      try {
        db = await openInboxDB(user.id);
        idbRef.current = db;
        
        await purgeEmailsOutsideScope(db, refreshAccountLabels);
        await refreshEmailFiltersForViewer();

        // ---- (1) Instant paint from IDB ----
        const cached = await readLatestEmails(db, 200, refreshAccountLabels);
        
        if (cached.length > 0) {
          setEmails(cached as unknown as Email[]);
          setLastUpdated(new Date());
          markInboxReady();
          const dt = performance.now() - t0;
          pushDiag({ ts: Date.now(), kind: "cache", endpoint: "idb:instant-paint", ms: Math.round(dt), note: `${cached.length} rows` });
          
        }

        // ---- (2) Delta sync via Supabase edge function ----
        const storedCursor = await getSyncCursor(db);
        // If the cache is empty but a cursor exists (stale/corrupt IDB, profile/account switch,
        // or an older failed rollout), force a baseline snapshot instead of asking only for
        // changes after that cursor. Otherwise old emails can never backfill.
        const cursor = cached.length === 0 ? 0 : storedCursor;
        const started = performance.now();
        const delta = await fetchListDelta({ since: cursor, limit: cursor === 0 ? 1000 : 500 });
        pushDiag({
          ts: Date.now(),
          kind: "sync",
          endpoint: "list_delta",
          ms: Math.round(performance.now() - started),
          note: `since=${cursor} +${delta?.rows?.length || 0}/-${delta?.removedIds?.length || 0} → ${delta?.newCursor || 0}`,
        });

        const rows: CachedEmail[] = Array.isArray(delta?.rows) ? delta.rows : [];
        const removedIds: string[] = Array.isArray(delta?.removedIds) ? delta.removedIds : [];
        const newCursor = Number(delta?.newCursor || 0);

        if (rows.length > 0 || removedIds.length > 0 || newCursor > cursor) {
          await writeDelta(db, { rows, removedIds, newCursor });
          const fresh = await readLatestEmails(db, 200, refreshAccountLabels);
          
          if (fresh.length > 0) {
            setEmails(fresh as unknown as Email[]);
            setLastUpdated(new Date());
          } else if (cached.length === 0 && emailsRef.current.length === 0) {
            setEmails([]);
            setLastUpdated(new Date());
          } else {
            pushDiag({ ts: Date.now(), kind: "cache", endpoint: "idb:post-delta", note: "empty local result ignored; preserving visible inbox" });
          }
          if (fresh.length > 0) markInboxReady();
        }
        setError(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err || "");
        console.error("[inbox] instant-inbox error:", msg, err);
        pushDiag({ ts: Date.now(), kind: "cache", endpoint: "instant-inbox", error: msg });
      } finally {
        // Start the countdown only after the instant cache/delta load has had a chance to paint.
        markInboxReady();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, instantInboxAccountKey, markInboxReady, workflowView]);


  // Wrap email selection so full HTML is lazy-fetched on first click.
  // List rows from list_delta don't include HTML (kept payload tiny). On click:
  //  1) show the row instantly (preview text renders in iframe as fallback)
  //  2) check IDB for cached html — use if present
  //  3) otherwise call get_email_html, cache to IDB + update state
  const openEmail = useCallback(async (email: Email) => {
    setSelectedEmail(email);
    setEmailHtmlLoadError(null);
    if (email.html && email.html.length > 0) return;
    setLoadingEmailHtmlId(email.id);
    try {
      const db = idbRef.current || (user?.id ? await openInboxDB(user.id) : null);
      if (db) {
        idbRef.current = db;
        const localHtml = await withTimeout(getEmailHtml(db, email.id), 1200, "Local email cache timed out").catch(() => null);
        if (localHtml) {
          setSelectedEmail({ ...email, html: localHtml });
          setLoadingEmailHtmlId((id) => (id === email.id ? null : id));
          return;
        }
      }

      // Source of truth first. The full-email view must never depend on a
      // possibly stale/hanging Worker response; Worker is only a cache fallback.
      let html = "";
      try {
        const res: any = await withTimeout(
          apiCall("manage-app", { action: "get_email_html", id: email.id }),
          10_000,
          "Full email request timed out",
        );
        if (res?.success && typeof res.html === "string") {
          html = res.html;
          pushDiag({ ts: Date.now(), kind: "cache", endpoint: "get_email_html", status: 200, note: `${html.length} chars` });
        }
      } catch (e) {
        pushDiag({ ts: Date.now(), kind: "cache", endpoint: "get_email_html", error: e instanceof Error ? e.message : String(e) });
      }

      const token = sessionGet("session_token" as any);
      const workerUrls = resolvedWorkerUrls || [];
      if (!html && workerUrls.length > 0 && token) {
        const workerBase = workerUrls[Math.floor(Math.random() * workerUrls.length)];
        try {
          const wRes = await withTimeout(
            fetchWithTimeout(`${workerBase}/api/inbox/html`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Session-Token": token },
              body: JSON.stringify({ id: email.id }),
            }, 8000),
            9_000,
            "Worker email cache timed out",
          );
          if (wRes.ok) {
            const wJson = await withTimeout(wRes.json(), 2500, "Worker email body timed out").catch(() => null);
            if (wJson?.success && typeof wJson.html === "string") {
              html = wJson.html;
              pushDiag({ ts: Date.now(), kind: "cache", endpoint: `${workerBase}/api/inbox/html`, status: wRes.status, cacheStatus: wRes.headers.get("X-Cache-Status") || undefined, cacheAge: wRes.headers.get("X-Cache-Age") || undefined });
            }
          }
        } catch (e) {
          pushDiag({ ts: Date.now(), kind: "cache", endpoint: `${workerBase}/api/inbox/html`, error: e instanceof Error ? e.message : String(e) });
        }
      }


      if (html) {
        setSelectedEmail((cur) => (cur && cur.id === email.id ? { ...cur, html } : cur));
        if (db) { try { await cacheEmailHtml(db, email.id, html); } catch { /* quota etc. */ } }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || "");
      pushDiag({ ts: Date.now(), kind: "cache", endpoint: "get_email_html", error: msg });
    } finally {
      setLoadingEmailHtmlId((id) => (id === email.id ? null : id));
    }
  }, [user?.id, resolvedWorkerUrls, pushDiag]);

  const copyOtp = (otp: string) => {
    navigator.clipboard.writeText(otp);
    setOtpCopied(true);
    setTimeout(() => setOtpCopied(false), 2000);
  };


  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <h1 className="sr-only">Email Inbox — Netflix Mail</h1>
      {showChangePassword && (
        <ChangePasswordModal user={user} onDone={() => setShowChangePassword(false)} forced={forcedPasswordChange && showChangePassword} />
      )}
      <AnimatePresence>
        {showProfile && (
          <UserProfileModal
            user={user}
            prefs={profilePrefs}
            onPrefsSaved={saveProfilePrefsLocally}
            onPassword={() => setShowChangePassword(true)}
            onClose={() => setShowProfile(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showDiag && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={() => setShowDiag(false)}
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-2xl bg-white sm:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              <div className="p-4 border-b bg-slate-50 flex items-center justify-between">
                <div>
                  <h3 className="font-black text-slate-900 text-base flex items-center gap-2"><Info className="w-4 h-4" /> Refresh Diagnostics</h3>
                  <p className="text-[11px] text-slate-500">Live view of worker endpoints, KV cache status & fetch errors</p>
                </div>
                <button onClick={() => setShowDiag(false)} className="p-1.5 rounded-full hover:bg-slate-200"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-3 text-[11px] text-slate-600 border-b bg-slate-50/50 flex flex-wrap gap-x-4 gap-y-1">
                <span>Refreshing: <b className={refreshing ? "text-amber-600" : "text-emerald-600"}>{refreshing ? "yes" : "idle"}</b></span>
                <span>Primary workers: <b>{workerUrlMap.primary.length}</b></span>
                <span>Per-account: <b>{Object.keys(workerUrlMap.byAccount).length}</b></span>
                <span>Last update: <b>{lastUpdated.toLocaleTimeString()}</b></span>
              </div>
              <div className="flex-1 overflow-auto divide-y divide-slate-100">
                {diag.length === 0 && (
                  <div className="p-6 text-center text-slate-400 text-sm">No activity yet — hit Refresh to see live worker calls.</div>
                )}
                {diag.map((e, i) => {
                  const color = e.error ? "text-red-600" :
                    e.cacheStatus === "HIT" ? "text-emerald-600" :
                    e.cacheStatus === "STALE" ? "text-amber-600" :
                    e.cacheStatus === "BYPASS" ? "text-blue-600" :
                    e.cacheStatus === "MISS" ? "text-fuchsia-600" : "text-slate-600";
                  return (
                    <div key={i} className="p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`font-bold uppercase tracking-wide ${color}`}>{e.kind}{e.status ? ` · ${e.status}` : ""}{e.cacheStatus ? ` · ${e.cacheStatus}` : ""}</span>
                        <span className="text-slate-400">{new Date(e.ts).toLocaleTimeString()}{e.ms != null ? ` · ${e.ms}ms` : ""}</span>
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-slate-700 break-all">{e.endpoint}</div>
                      {e.cacheAge && <div className="text-[10.5px] text-slate-500">cache age: {e.cacheAge}s</div>}
                      {e.cacheKey && <div className="text-[10.5px] text-slate-500 truncate">key: {e.cacheKey}</div>}
                      {e.note && <div className="text-[10.5px] text-slate-500">{e.note}</div>}
                      {e.error && <div className="mt-1 text-[11px] text-red-700 font-semibold">✗ {e.error}</div>}
                    </div>
                  );
                })}
              </div>
              <div className="p-3 border-t bg-slate-50 flex flex-wrap gap-2">
                <button onClick={clearDiag} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-slate-200 hover:bg-slate-100">Clear</button>
                <button
                  onClick={async () => {
                    const token = sessionGet("session_token" as any);
                    const urls = resolvedWorkerUrls || [];
                    if (!token || urls.length === 0) {
                      notify.info("No worker configured or not signed in");
                      return;
                    }
                    let totalInbox = 0, totalHtml = 0, okCount = 0;
                    await Promise.all(urls.map(async (base) => {
                      const t0 = Date.now();
                      try {
                        const res = await fetchWithTimeout(`${base}/api/cache/purge`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json", "X-Session-Token": token },
                          body: "{}",
                        }, 8000);
                        const j = await res.json().catch(() => ({} as any));
                        if (res.ok && j?.ok) {
                          okCount++;
                          totalInbox += Number(j.purged || 0);
                          totalHtml += Number(j.htmlPurged || 0);
                        }
                        pushDiag({ ts: Date.now(), kind: "cache", endpoint: `${base}/api/cache/purge`, status: res.status, ms: Date.now() - t0, note: `inbox:${j?.purged ?? 0} html:${j?.htmlPurged ?? 0}` });
                      } catch (e) {
                        pushDiag({ ts: Date.now(), kind: "cache", endpoint: `${base}/api/cache/purge`, error: e instanceof Error ? e.message : String(e) });
                      }
                    }));
                    if (okCount > 0) notify.success(`Purged ${totalInbox} inbox + ${totalHtml} HTML keys on ${okCount}/${urls.length} workers`);
                    else notify.error("Cache purge failed on all workers");
                  }}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-red-600 text-white hover:bg-red-700"
                >Purge KV cache</button>
                <button
                  onClick={() => { void loadCachedEmails({ bust: true }); }}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-900 text-white hover:bg-slate-800"
                >Force fresh fetch</button>
                <button
                  onClick={async () => {
                    pushDiag({ ts: Date.now(), kind: "worker", endpoint: "worker /api/health", note: "blocked in encrypted-only mode" });
                    notify.info("Worker health ping is disabled in encrypted-only mode");
                  }}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200"
                >Ping /api/health</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ============ MOBILE HEADER (clean white) ============ */}
      <header className="sm:hidden sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200 shadow-sm">
        <div className="px-3 h-14 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowProfile(true)}
            className="relative flex-shrink-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-500/60 active:scale-95 transition-transform"
            aria-label="Open profile settings"
            title="Profile settings"
          >
            <ProfileAvatar
              avatarId={viewerAvatarId}
              name={user.name}
              className="w-9 h-9 rounded-xl overflow-hidden ring-1 ring-slate-200"
              fallbackColor="bg-red-600"
              eager
            />
            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-white" aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="font-black text-[15px] leading-tight tracking-tight text-red-600 truncate">
              Netflix Mail
            </h2>
            <span className="text-[11px] text-slate-500 truncate block">{user.name}</span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {isImpersonating && (
              <button
                onClick={backToAdmin}
                className="flex items-center gap-1 px-2.5 h-8 bg-amber-500 text-white rounded-full text-[11px] font-bold shadow-sm active:scale-95"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Admin
              </button>
            )}
            <WorkflowSwitcher features={userFeatures} view={workflowView} onChange={setWorkflowView} compact />
            <TvAutoLoginButton visible={false} />
            <NotificationBell />
            {workflowView === "gmail" && (
            <button
              onClick={() => fetchEmails()}
              disabled={refreshing}
              className="flex items-center justify-center w-9 h-9 bg-slate-900 text-white rounded-full transition-all active:scale-95 disabled:opacity-60"
              aria-label="Refresh inbox"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            )}
            {canChangePassword && (
              <button
                onClick={() => setShowChangePwd(true)}
                className="flex items-center justify-center w-9 h-9 bg-indigo-600 text-white rounded-full transition-all active:scale-95 hover:bg-indigo-700"
                title="Change password"
                aria-label="Change password"
              >
                <KeyRound className="w-4 h-4" />
              </button>
            )}
            {!isImpersonating && (
              <button
                onClick={fastClearCookiesRedirect}
                className="flex items-center justify-center w-9 h-9 bg-red-600 text-white rounded-full transition-all active:scale-95 hover:bg-red-700"
                title="Logout"
                aria-label="Logout"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </header>


      {/* ============ DESKTOP HEADER ============ */}
      <header className="hidden sm:block bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-shrink-0 flex items-center gap-1.5">
              <NetflixNLogo className="w-8 h-8" />
              <div className="h-8 w-px bg-slate-200 ml-1" />
              <button
                type="button"
                onClick={() => setShowProfile(true)}
                className="ml-1 rounded-full focus:outline-none focus:ring-2 focus:ring-red-600/60 active:scale-95 transition-transform"
                aria-label="Open profile settings"
                title="Profile settings"
              >
                <ProfileAvatar avatarId={viewerAvatarId} name={user.name} className="w-9 h-9" fallbackColor="bg-red-600" eager />
              </button>
            </div>
            <div className="min-w-0">
              <h2 className="font-bold text-lg tracking-tight leading-tight text-red-600">Netflix Mail</h2>
              <span className="text-xs text-slate-500 truncate block max-w-[180px]">{user.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isImpersonating && (
              <button onClick={backToAdmin}
                className="flex items-center gap-1.5 px-3 py-2 bg-amber-500 text-white rounded-full text-xs font-bold hover:bg-amber-600 transition-all active:scale-95">
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Admin
              </button>
            )}
            <WorkflowSwitcher features={userFeatures} view={workflowView} onChange={setWorkflowView} />
            <TvAutoLoginButton visible={false} />
            <NotificationBell />
            {workflowView === "gmail" && (
            <button onClick={() => fetchEmails()}
              disabled={refreshing}
              className="flex items-center px-4 py-2 bg-slate-900 text-white rounded-full text-sm font-bold hover:bg-slate-800 transition-all active:scale-95 disabled:opacity-60">
              <RefreshCw className={`w-5 h-5 ${refreshing ? "animate-spin" : ""}`} />
              <span className="ml-1.5">Refresh</span>
            </button>
            )}
            <button onClick={() => setShowProfile(true)}
              className="flex items-center px-3 py-2 bg-gradient-to-r from-violet-500 to-purple-600 text-white rounded-full text-sm font-bold hover:from-violet-600 hover:to-purple-700 transition-all active:scale-95 shadow-md shadow-purple-200"
              title="Profile">
              <UserCircle className="w-5 h-5" />
              <span className="ml-1.5">Profile</span>
            </button>
            {canChangePassword && (
              <button
                onClick={() => setShowChangePwd(true)}
                className="flex items-center justify-center w-10 h-10 bg-indigo-600 text-white rounded-full transition-all active:scale-95 hover:bg-indigo-700 shadow-sm"
                title="Change password"
                aria-label="Change password"
              >
                <KeyRound className="w-5 h-5" />
              </button>
            )}
            {!isImpersonating && (
              <button
                onClick={fastClearCookiesRedirect}
                className="flex items-center justify-center w-10 h-10 bg-red-600 text-white rounded-full transition-all active:scale-95 hover:bg-red-700 shadow-sm"
                title="Logout"
                aria-label="Logout"
              >
                <LogOut className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </header>


      <AnimatePresence mode="wait" initial={false}>
        {workflowView === null && countEnabled(userFeatures) >= 2 ? (
          <motion.main key="wf-chooser"
            className="h-[calc(100dvh-3.5rem)] sm:h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain"
            initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(6px)" }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
            <WorkflowChooser features={userFeatures} user={user} lastView={(user as any)?.lastWorkflowView || null} onPick={setWorkflowView} onLogout={fastClearCookiesRedirect} />
          </motion.main>
        ) : workflowView === "link" && userFeatures.link ? (
          <motion.main key="wf-link" className="max-w-6xl mx-auto"
            initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(6px)" }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
            <DirectLinkView apiCall={apiCall} notify={notify} />
          </motion.main>
        ) : workflowView === "tv" ? (
          <motion.main key="wf-tv" className="max-w-6xl mx-auto"
            initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(6px)" }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
            <TvSignInPage />
          </motion.main>
        ) : workflowView === "gmail" || countEnabled(userFeatures) < 2 ? (
      <motion.main key="wf-gmail" className="max-w-6xl mx-auto px-2 sm:px-4 min-h-[calc(100dvh-3.5rem)] md:h-[calc(100vh-4rem)] overflow-visible md:overflow-hidden"
        initial={{ opacity: 0, y: 12, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: -12, filter: "blur(6px)" }} transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 sm:gap-8 md:h-full py-2 sm:py-4 pb-28 md:pb-4">
          <div className={`${selectedEmail ? "hidden md:block" : "block"} md:col-span-5 xl:col-span-4 flex flex-col overflow-visible md:overflow-hidden md:h-full`}>
            <section className="flex-1 overflow-visible md:overflow-y-auto min-h-0 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  Inbox
                  <span className="bg-slate-200 text-slate-600 text-[10px] px-2 py-0.5 rounded-full">{emails.length}</span>
                </h3>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 rounded-xl p-3 mb-2">
                  <p className="text-red-600 text-xs flex items-center gap-2"><AlertCircle className="w-3 h-3" />{error}</p>
                </div>
              )}

              <div className="space-y-2 flex-1 overflow-visible md:overflow-y-auto min-h-0">
                {emails.length === 0 && !error ? (
                  <div className="bg-white border border-dashed border-slate-200 rounded-xl p-12 text-center">
                    <div className="bg-slate-50 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Mail className="text-slate-200 w-6 h-6" />
                    </div>
                    <p className="text-[10px] sm:text-xs text-slate-400 font-medium">
                      No Netflix emails found
                    </p>
                  </div>
                ) : (
                  emails.map(email => (
                    <button key={email.id} onClick={() => { void openEmail(email); }}
                      className={`w-full text-left p-3 rounded-xl border transition-all ${
                        selectedEmail?.id === email.id
                          ? "bg-white border-red-200 shadow-md ring-1 ring-red-100"
                          : "bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm"
                      }`}>
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-[10px] font-bold text-red-600 uppercase tracking-tight truncate max-w-[70%]">
                          {email.from?.split("<")[0]?.trim() || "Unknown"}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(email.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true })}
                        </span>
                      </div>
                      <h4 className="text-sm font-bold text-slate-900 truncate mb-1">{email.subject}</h4>
                      <p className="text-xs text-slate-500 line-clamp-1">{email.preview}</p>
                      {email.otp && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="bg-slate-900 text-white text-[10px] font-mono px-2 py-0.5 rounded">OTP: {email.otp}</div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase">Ready</span>
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>

          <div className={`${selectedEmail ? "block" : "hidden md:flex"} md:col-span-7 xl:col-span-8 flex flex-col overflow-visible md:overflow-hidden md:h-full`}>
            {selectedEmail ? (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col md:h-full overflow-visible md:overflow-hidden">
                <div className="p-3 sm:p-6 border-b border-slate-100 bg-white md:sticky md:top-0 z-10 rounded-t-2xl">
                  <div className="flex items-center gap-2 sm:gap-4 mb-3 sm:mb-6">
                    <button onClick={() => setSelectedEmail(null)}
                      className="flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-colors font-bold text-xs sm:text-sm active:scale-95">
                      <ArrowLeft className="w-4 h-4" />Inbox
                    </button>
                  </div>
                  <h2 className="text-base sm:text-2xl font-bold text-slate-900 mb-2 sm:mb-4 leading-tight">{selectedEmail.subject}</h2>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      {/netflix\.com/i.test(selectedEmail.from || "") ? (
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-black flex items-center justify-center flex-shrink-0 ring-1 ring-slate-200">
                          <span className="text-red-600 font-black text-base sm:text-xl leading-none" style={{ fontFamily: "'Bebas Neue', 'Arial Black', system-ui, sans-serif", letterSpacing: "-0.05em" }}>N</span>
                        </div>
                      ) : (
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-bold text-sm sm:text-lg flex-shrink-0">
                          {(selectedEmail.from?.charAt(0) || "?").toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <span className="font-bold text-xs sm:text-sm text-slate-900 truncate block">
                          {selectedEmail.from?.split("<")[0]?.trim() || "Unknown Sender"}
                        </span>
                        <p className="text-[10px] sm:text-xs text-slate-500 truncate">{selectedEmail.from}</p>
                      </div>
                    </div>
                    <p className="text-[10px] sm:text-xs text-slate-400">{new Date(selectedEmail.date).toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}</p>
                  </div>
                </div>

                <div className="flex-1 overflow-visible md:overflow-auto p-2 sm:p-6 bg-white rounded-b-2xl">
                  <div className="email-html-wrapper">
                    {loadingEmailHtmlId === selectedEmail.id && !selectedEmail.html ? (
                      <div className="flex items-center justify-center py-16">
                        <RefreshCw className="w-6 h-6 animate-spin text-slate-400" />
                      </div>
                    ) : (
                      <iframe
                        srcDoc={responsiveEmailSrcDoc(selectedEmail)}
                        sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts"
                        className="w-full border-0 block"
                        scrolling="no"
                        style={{ minHeight: "220px", height: "220px", overflow: "hidden" }}
                        title="Email content"
                        data-email-iframe="true"
                        data-email-iframe-id={String(selectedEmail.id || "email-preview").replace(/[^a-zA-Z0-9_-]/g, "_")}
                      />

                    )}
                  </div>
                </div>
              </motion.div>
            ) : (
              <div className="bg-white rounded-2xl border border-dashed border-slate-200 flex flex-col items-center justify-center h-full text-center p-6 sm:p-12">
                <div className="bg-slate-50 w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center mb-4 sm:mb-6">
                  <Mail className="text-slate-200 w-8 h-8 sm:w-10 sm:h-10" />
                </div>
                <h3 className="text-base sm:text-xl font-bold text-slate-800 mb-2">Select an email to read</h3>
                <p className="text-sm sm:text-base text-slate-400 max-w-xs mx-auto">Click on any email from the inbox list.</p>
              </div>
            )}
          </div>
        </div>
      </motion.main>
      ) : null}
      </AnimatePresence>


      {/* ============ CHANGE PASSWORD MODAL ============ */}
      <AnimatePresence>
        {showChangePwd && canChangePassword && (
          <motion.div
            key="cp-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[70] bg-slate-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={() => !cpBusy && setShowChangePwd(false)}
          >
            <motion.div
              initial={{ y: 40, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 40, opacity: 0, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
              className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sm:hidden flex justify-center pt-2.5 pb-1"><div className="w-10 h-1 rounded-full bg-slate-300" /></div>
              <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center">
                    <KeyRound className="w-4.5 h-4.5 text-red-600" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 leading-tight">Change password</h3>
                    <p className="text-[11px] text-slate-500">Keep your account safe</p>
                  </div>
                </div>
                <button
                  onClick={() => !cpBusy && setShowChangePwd(false)}
                  className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-500"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <form
                onSubmit={(e) => { e.preventDefault(); void submitChangePassword(); }}
                className="px-5 py-4 space-y-3"
              >
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">Current password</label>
                  <div className="relative mt-1">
                    <input
                      type={cpShow ? "text" : "password"}
                      value={cpCurrent}
                      onChange={(e) => setCpCurrent(e.target.value)}
                      autoComplete="current-password"
                      className="w-full h-11 pl-10 pr-11 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:border-red-500 focus:ring-2 focus:ring-red-500/20 outline-none text-sm"
                      placeholder="Enter current password"
                    />
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <button type="button" onClick={() => setCpShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" tabIndex={-1} aria-label={cpShow ? "Hide" : "Show"}>
                      {cpShow ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">New password</label>
                  <div className="relative mt-1">
                    <input
                      type={cpShow ? "text" : "password"}
                      value={cpNext}
                      onChange={(e) => setCpNext(e.target.value)}
                      autoComplete="new-password"
                      className="w-full h-11 pl-10 pr-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:border-red-500 focus:ring-2 focus:ring-red-500/20 outline-none text-sm"
                      placeholder="At least 6 characters"
                    />
                    <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">Confirm new password</label>
                  <div className="relative mt-1">
                    <input
                      type={cpShow ? "text" : "password"}
                      value={cpConfirm}
                      onChange={(e) => setCpConfirm(e.target.value)}
                      autoComplete="new-password"
                      className="w-full h-11 pl-10 pr-3 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:border-red-500 focus:ring-2 focus:ring-red-500/20 outline-none text-sm"
                      placeholder="Repeat the new password"
                    />
                    <CheckCircle2 className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${cpConfirm && cpConfirm === cpNext ? "text-emerald-500" : "text-slate-400"}`} />
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => !cpBusy && setShowChangePwd(false)}
                    className="flex-1 h-11 rounded-xl border border-slate-200 text-slate-700 font-semibold text-sm hover:bg-slate-50"
                    disabled={cpBusy}
                  >Cancel</button>
                  <button
                    type="submit"
                    disabled={cpBusy}
                    className="flex-1 h-11 rounded-xl bg-red-600 text-white font-bold text-sm hover:bg-red-700 disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {cpBusy ? <><RefreshCw className="w-4 h-4 animate-spin" /> Saving…</> : <>Update password</>}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>


      <style>{`
        .email-html-wrapper {
          overflow: hidden;
          max-width: 100%;
          width: 100%;
        }
        .email-html-wrapper iframe {
          display: block;
          width: 100%;
        }
      `}</style>
    </div>
  );
}

// ==================== MAINTENANCE GATE ====================
// Admin bypass has been removed entirely — the maintenance screen applies to
// everyone. The only carve-out is /admin* routes so admins can still sign in
// and toggle maintenance off from the panel.

function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading, checkAuth } = useAuth();
  const navigate = useNavigate();
  const cached = useMemo(() => readBootstrapCache(), []);
  const [maint, setMaint] = useState<MaintenanceInfo>(
    cached?.maintenance || { enabled: false }
  );

  // Legacy: sweep any old bypass token from sessionStorage so upgrades don't
  // leave a stale key that could be resurrected by a future regression.
  useEffect(() => {
    try { sessionStorage.removeItem("maintenance_admin_bypass"); } catch {}
  }, []);

  // 🚨 Force-kick non-admin users the moment maintenance turns ON.
  useEffect(() => {
    if (!maint.enabled) return;
    if (authLoading) return; // wait for server hydration so we don't kick a stale-cached impersonation
    if (!user) return;
    if (user.role === "admin") return;
    // Admin impersonating a user: keep the session alive so they can QA the
    // real user experience during maintenance. Source of truth is the
    // server-signed `impersonated` flag backed by the parent admin session row.
    if (user.impersonated === true) return;
    const path = typeof window !== "undefined" ? window.location.pathname : "/";
    if (path.startsWith("/admin")) return;
    notify.info("🛠 Maintenance started", {
      id: "maint-kick",
      description: "You've been signed out while we perform updates.",
      duration: 4000,
    });
    // Silent full reset via /clearcookies (Clear-Site-Data + JS fallback → 0 B).
    fastClearCookiesRedirect();
  }, [maint.enabled, authLoading, user?.id, user?.role, user?.impersonated]);


  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const bs = await refreshBootstrap();
        if (!cancelled) setMaint(bs.maintenance || { enabled: false });
      } catch {}
    };
    const isAdminPath = window.location.pathname.startsWith("/admin");
    const adminLike = user?.role === "admin" || user?.impersonated === true;
    if (!isAdminPath && !adminLike) load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !window.location.pathname.startsWith("/admin")) load();
    }, 120000);
    const onChange = () => load();
    window.addEventListener("maintenance:changed", onChange);
    if (!isAdminPath) window.addEventListener("focus", onChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("maintenance:changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [user?.role, user?.impersonated]);

  // Local auto-expiry: when endsAt passes on the client, flip off immediately
  // without waiting for the next server poll.
  useEffect(() => {
    if (!maint.enabled || !maint.endsAt) return;
    const ms = new Date(maint.endsAt).getTime() - Date.now();
    if (ms <= 0) {
      setMaint((m) => ({ ...m, enabled: false }));
      return;
    }
    const t = setTimeout(() => {
      setMaint((m) => ({ ...m, enabled: false }));
      refreshBootstrap().catch(() => {});
    }, ms + 500);
    return () => clearTimeout(t);
  }, [maint.enabled, maint.endsAt]);

  // Always let the admin login flow through, even during maintenance.
  // Also let admins who are impersonating a user (via "View as user") through,
  // so they can QA the real user experience while the site is locked down.
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const isAdminRoute = path.startsWith("/admin");
  const isAdminImpersonating =
    user?.role === "admin" ||
    user?.impersonated === true;

  const screenProps = {
    title: maint.title,
    message: maint.message,
    endsAt: maint.endsAt || null,
    versionFrom: maint.versionFrom || "",
    versionTo: maint.versionTo || "",
  };

  // While auth is still hydrating on refresh, hold off on the maintenance
  // screen — the /me response may reveal an impersonated admin session that
  // should bypass maintenance. Cached user (which now includes impersonated=true)
  // is checked above via isAdminImpersonating, but a first-time refresh in a
  // new tab may not have it yet.
  if (maint.enabled && !isAdminRoute && !isAdminImpersonating && !authLoading) {
    return <MaintenanceScreen {...screenProps} />;
  }


  return <>{children}</>;
}


// ============================================================================
// ⚠️  Netflix-style /clearcookies endpoint — site storage → 0 B ⚠️
// ----------------------------------------------------------------------------
// PRIMARY mechanism: the /clearcookies route ships with a `Clear-Site-Data: "*"`
// response header (see netlify.toml + vercel.json). Merely LOADING this URL
// tells the browser to purge cookies (incl. httpOnly), localStorage,
// sessionStorage, IndexedDB, Cache Storage, service workers, HTTP cache, and
// running execution contexts at the HTTP layer. That's the same trick
// netflix.com/clearcookies uses.
//
// SECONDARY (JS fallback via nukeBrowserIdentity): for local dev / hosts that
// strip the header, we also wipe every surface from JavaScript. Both run.
// ============================================================================
// One-shot guard so React StrictMode / re-renders can't re-enter the wipe
// and cause a redirect loop when the user pastes /clearcookies in the URL bar.
let __clearCookiesFired = false;
function ClearCookiesPage() {
  // Fire synchronously during render (module scope, guarded) so navigation
  // starts BEFORE effects — Clear-Site-Data killing the execution context
  // no longer strands us on a "loading" screen.
  if (!__clearCookiesFired && typeof window !== "undefined") {
    __clearCookiesFired = true;
    try { revokeSessionInBackground(); } catch {}
    try { clearBrowserIdentityNow(); } catch {}
    try { nukeBrowserIdentity().catch(() => {}); } catch {}
    try { window.location.replace("/?_cc=" + Date.now()); } catch { window.location.href = "/"; }
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-200">
      {/* Belt-and-suspenders: if JS is killed mid-navigation the browser
          still bounces home after 1 s. */}
      <meta httpEquiv="refresh" content="1;url=/" />
      <div className="text-sm opacity-80">Signing out…</div>
    </div>
  );
}

// Fuzzy catch-all: if the typed path looks even vaguely like a logout /
// clear intent (handles typos like /clesrcatch, /cler, /signot, /rest,
// /cokie), route it through the same instant-wipe flow the in-app logout
// button uses. Everything else silently bounces to `/`.
function CatchAllRoute() {
  const path = typeof window !== "undefined" ? window.location.pathname.toLowerCase() : "";
  // Skip admin routes entirely — admins have their own logout flow and we
  // don't want a typo like /admin/dashbord to wipe an admin session.
  if (path.startsWith("/admin")) return <Navigate to="/" replace />;
  // Strip non-letters so "/clear-cstch", "/viewer/clear", "/clear_cache/"
  // all collapse to the same fuzzy string. This makes the check work at
  // ANY depth (top-level `/clear` AND nested `/viewer/clear` alike).
  const norm = path.replace(/[^a-z]/g, "");
  const KEYWORDS = [
    "clear", "cler", "clr", "clean",
    "cookie", "cokie", "cookis",
    "cache", "cach", "catch", "cstch",
    "logout", "logot", "loout", "signout", "signot", "signoff", "sinout",
    "reset", "rest",
    "wipe", "purge", "nuke",
  ];
  const looksLikeClear = KEYWORDS.some((k) => norm.includes(k));
  if (looksLikeClear) return <ClearCookiesPage />;
  return <Navigate to="/" replace />;
}







// Global "Plan Finished" modal. Shown when any edge call returns
// { success: false, error: "plan_finished" }. Displays admin contact info
// and forces the user out of any active session.
function PlanFinishedModal() {
  const [state, setState] = useState<{ open: boolean; contactInfo: any; planEndsAt: string | null }>({ open: false, contactInfo: null, planEndsAt: null });
  useEffect(() => {
    const handler = (e: any) => {
      const detail = e?.detail || {};
      // MERGE — never overwrite existing contact info with an empty payload.
      // Two dispatchers race: the client-side plan-ends pill fires a "bare"
      // event (planEndsAt only) the moment the timer hits 0, and shortly
      // after the server "me" refresh returns full contactInfo. Without a
      // merge the modal would flicker between "with contacts" and "no
      // contacts" as the two events arrived in unpredictable order.
      setState(prev => ({
        open: true,
        contactInfo: (detail.contactInfo && Object.keys(detail.contactInfo).length ? detail.contactInfo : prev.contactInfo) || null,
        planEndsAt: detail.planEndsAt || prev.planEndsAt || null,
      }));
      // Kill any active session so protected routes bounce out.
      try {
        sessionSet("session_token" as any, "");
        sessionSet("user" as any, "");
      } catch {}
    };
    window.addEventListener("app:plan-finished", handler as any);
    return () => window.removeEventListener("app:plan-finished", handler as any);
  }, []);
  if (!state.open || typeof document === "undefined") return null;
  const c = state.contactInfo || {};
  const endedOn = state.planEndsAt ? new Date(state.planEndsAt).toLocaleString() : null;
  const toList = (plural: any, singular: any): string[] => {
    if (Array.isArray(plural) && plural.length) return plural.map((x: any) => String(x || "")).filter(Boolean);
    if (typeof singular === "string" && singular.trim()) return [singular.trim()];
    return [];
  };
  const tgs = toList(c.telegrams, c.telegram);
  const was = toList(c.whatsapps, c.whatsapp);
  const ems = toList(c.emails, c.email);
  const tgHref = (v: string) => v.startsWith("http") ? v : `https://t.me/${String(v).replace(/^@/, "")}`;
  const waHref = (v: string) => `https://wa.me/${String(v).replace(/[^\d]/g, "")}`;
  const hasAny = tgs.length || was.length || ems.length || (c.note && String(c.note).trim());
  return createPortal(
    <div className="fixed inset-0 z-[10050] flex items-end sm:items-center justify-center p-0 sm:p-4">
      {/* Solid opaque backdrop — no bleed-through of profile grid behind. */}
      <div aria-hidden className="absolute inset-0 bg-slate-950/95 backdrop-blur-2xl" />
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(239,68,68,0.15),transparent_60%)] pointer-events-none" />
      <div className="relative w-full sm:w-auto sm:min-w-[24rem] sm:max-w-md max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white shadow-2xl border border-slate-200 p-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] sm:pb-6">
        <div aria-hidden className="sm:hidden flex justify-center -mt-1 mb-3">
          <div className="w-10 h-1 rounded-full bg-slate-300" />
        </div>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-red-100 text-red-600 flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-black text-slate-900 leading-tight">Plan Finished</div>
            <div className="text-xs text-slate-500 mt-0.5">Contact admin to renew</div>
          </div>
        </div>
        <p className="text-sm text-slate-700 leading-relaxed">Your plan has ended. Sign-in features are paused until it's renewed.</p>
        {endedOn && (
          <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">Ended on <span className="font-semibold text-slate-900">{endedOn}</span></div>
        )}
        <div className="mt-4 space-y-2">
          {tgs.map((v, i) => (
            <a key={`tg-${i}`} href={tgHref(v)} target="_blank" rel="noreferrer"
              className="flex items-center gap-3 rounded-xl bg-sky-50 border border-sky-200 px-3.5 py-2.5 text-sm font-semibold text-sky-900 hover:bg-sky-100 transition">
              <Send className="w-4 h-4 flex-shrink-0" />
              <span className="text-xs uppercase tracking-wide font-bold text-sky-700/80">Telegram</span>
              <span className="ml-auto text-xs opacity-80 truncate">{v}</span>
            </a>
          ))}
          {was.map((v, i) => (
            <a key={`wa-${i}`} href={waHref(v)} target="_blank" rel="noreferrer"
              className="flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-sm font-semibold text-emerald-900 hover:bg-emerald-100 transition">
              <MessageSquare className="w-4 h-4 flex-shrink-0" />
              <span className="text-xs uppercase tracking-wide font-bold text-emerald-700/80">WhatsApp</span>
              <span className="ml-auto text-xs opacity-80 truncate">{v}</span>
            </a>
          ))}
          {ems.map((v, i) => (
            <a key={`em-${i}`} href={`mailto:${v}`}
              className="flex items-center gap-3 rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-100 transition">
              <Mail className="w-4 h-4 flex-shrink-0" />
              <span className="text-xs uppercase tracking-wide font-bold text-slate-600">Email</span>
              <span className="ml-auto text-xs opacity-80 truncate">{v}</span>
            </a>
          ))}
          {c.note && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-900 whitespace-pre-wrap">{c.note}</div>
          )}
          {!hasAny && (
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-600">Please contact the admin to renew your plan.</div>
          )}
        </div>
        <button
          onClick={() => { setState({ open: false, contactInfo: null, planEndsAt: null }); try { window.location.replace("/"); } catch {} }}
          className="mt-5 w-full h-11 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 active:scale-[0.98] transition"
        >
          Back to sign-in
        </button>
      </div>
    </div>,
    document.body
  );
}



function SessionRouteBoundary() {
  const location = useLocation();
  const { checkAuth } = useAuth();

  useEffect(() => {
    const path = location.pathname;
    if (path !== "/admin" && path !== "/admin-auth") return;

    const storedUser = readStoredSessionUser();
    const token = getSessionToken();
    // Preserve the transient pending-admin identity on BOTH /admin and
    // /admin-auth. The password step lives on /admin and, on success, sets
    // { user (pending:true), pending_admin_token } synchronously before it
    // calls navigate("/admin-auth"). A React re-render can re-fire this
    // effect on /admin between those two steps — if we clear here, the
    // pending token is wiped and the 2FA page bounces back with no OTP.
    const isPendingAdmin =
      (path === "/admin" || path === "/admin-auth") &&
      storedUser?.role === "admin" &&
      storedUser?.pending === true &&
      !!sessionGet("pending_admin_token" as any);

    // finalize_admin_session stores the real admin session while the current
    // route is still /admin-auth, then navigates to /admin/dashboard. Do not
    // clear that fresh session during the tiny render window between those two
    // steps, otherwise the user only sees the success toast and gets bounced.
    const isActiveAdminSession =
      (path === "/admin" || path === "/admin-auth") &&
      storedUser?.role === "admin" &&
      storedUser?.pending !== true &&
      !!token;

    if (isPendingAdmin || isActiveAdminSession) return;

    // The public admin login/2FA routes must never inherit a normal user or
    // impersonated profile session. Clear the tab-scoped identity immediately
    // so profile data and countdown pills cannot bleed into admin screens.
    if (token || storedUser) {
      clearRouteSessionState();
      checkAuth();
    }
  }, [location.pathname, checkAuth]);

  return null;
}


// ==================== MAIN APP ====================
export default function App() {
  return (
    <Router>
      <AuthProvider>
        <ToastProvider />
        <AdminSyncStatus />
        <SessionRouteBoundary />
        <GlobalSessionOverlay />
        <PlanFinishedModal />
        <ErrorBoundary>
          <MaintenanceGate>
            <Routes>
              <Route path="/" element={<ProfileSelectPage />} />
              <Route path="/admin" element={<AdminLoginPage />} />
              <Route path="/admin-auth" element={<AdminAuthPage />} />
              <Route path="/admin/dashboard" element={<ProtectedRoute role="admin"><AdminPanel /></ProtectedRoute>} />
              <Route path="/admin/viewer" element={<AdminUserViewRoute><EmailViewer /></AdminUserViewRoute>} />
              <Route path="/viewer" element={<ProtectedRoute role="user"><EmailViewer /></ProtectedRoute>} />
              <Route path="/guides/netflix-household-verification" element={<NetflixHouseholdVerificationGuide />} />
              <Route path="/guides/netflix-tv-activation" element={<NetflixTvActivationGuide />} />
              {/* Any URL that "looks like" a logout/clear intent runs the
                  same instant-wipe flow. Covers typos like /clesrcatch,
                  /cler, /signot, /logot, /rest, /cokie, etc. */}
              <Route path="*" element={<CatchAllRoute />} />
            </Routes>



          </MaintenanceGate>
        </ErrorBoundary>
      </AuthProvider>
    </Router>
  );
}

function GlobalSessionOverlay() {
  const { user: authUser } = useAuth();
  const location = useLocation();
  const readSessionState = useCallback(() => {
    const token = sessionGet("session_token" as any);
    const storedUser = readStoredSessionUser();
    return { token, storedUser };
  }, []);
  const [sessionState, setSessionState] = useState(readSessionState);

  useEffect(() => {
    const sync = () => setSessionState(readSessionState());
    sync();
    const id = window.setInterval(sync, 500);
    window.addEventListener("app:session-change", sync as EventListener);
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("app:session-change", sync as EventListener);
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
    };
  }, [readSessionState]);

  // Prefer the latest server-hydrated sessionStorage user fields over the
  // React auth snapshot. Token refresh / /me can update planEndsAt while the
  // overlay is mounted, so merging here keeps the plan countdown live without
  // waiting for a route remount.
  const effectiveUser = authUser || sessionState.storedUser
    ? (() => {
      const merged = { ...(authUser || {}), ...(sessionState.storedUser || {}) } as any;
      if (!merged.planEndsAt && merged.plan_ends_at) merged.planEndsAt = merged.plan_ends_at;
      if (!merged.planStartsAt && merged.plan_starts_at) merged.planStartsAt = merged.plan_starts_at;
      return merged;
    })()
    : null;
  const role: "admin" | "user" = effectiveUser?.role === "admin" ? "admin" : "user";
  const hasSessionToken = !!sessionState.token;
  const isLoggedIn = !!effectiveUser && hasSessionToken;
  const isImpersonating = (effectiveUser as any)?.impersonated === true;
  const isPendingAdmin = (effectiveUser as any)?.pending === true;
  const isAdminRoute = location.pathname.startsWith("/admin");

  useSessionTimeoutGuard(role, isLoggedIn && !isImpersonating && !isPendingAdmin);

  if (!isLoggedIn || isPendingAdmin) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {!isImpersonating && <SessionCountdown role={role} />}
      {role === "user" && <FreeExpiryPill userOverride={effectiveUser} />}
      {role === "user" && <PlanEndsPill userOverride={effectiveUser} />}
    </>,
    document.body
  );
}


const ProtectedRoute = ({ children, role }: { children: React.ReactNode; role: "admin" | "user" }) => {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!user) return <Navigate to={role === "admin" ? "/admin" : "/"} />;
  if (role === "user" && (user as any)?.impersonated === true && window.location.pathname === "/viewer") return <Navigate to="/admin/viewer" replace />;
  if (role === "user" && user.role === "admin") return <Navigate to="/admin/dashboard" replace />;
  if (role === "admin" && user.role !== "admin") return <Navigate to={(user as any)?.impersonated === true ? "/admin/viewer" : "/"} replace />;
  return <>{children}</>;
};

const AdminUserViewRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  useSessionTimeoutGuard("user", false);
  if (loading) return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!user) return <Navigate to="/admin" replace />;
  if (user.role !== "user") return <Navigate to="/admin/dashboard" replace />;
  if ((user as any)?.impersonated !== true) return <Navigate to="/viewer" replace />;
  return <>{children}</>;
};
