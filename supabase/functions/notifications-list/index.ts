// Dedicated notifications-list endpoint for the Cloudflare worker cache.
// Mirrors the email-html pattern: plaintext JSON, self-contained session auth,
// no encrypted-transport handshake required from the worker.
//
// Body: { if_etag?: string }
//   if_etag matches → returns { success:true, unchanged:true, etag } (~80 B)
//   else → returns { success:true, notifications:[...], etag } (full list)
//
// Egress win: worker fronts this with per-user KV cache (60 s TTL) so
// steady-state Supabase invocations drop by ~95% at 5000 users.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function verifyToken(token: string, secret: string): Promise<any | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["verify"],
    );
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, enc.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  try {
    const token = req.headers.get("x-session-token") || "";
    if (!token) return json({ success: false, error: "session required" }, 401);

    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SIGNING = Deno.env.get("SESSION_SIGNING_SECRET") || SERVICE_ROLE;
    const LEGACY = SERVICE_ROLE;

    let session = await verifyToken(token, SIGNING);
    if (!session && LEGACY !== SIGNING) session = await verifyToken(token, LEGACY);
    if (!session?.userId) return json({ success: false, error: "invalid session" }, 401);

    let body: any = {};
    try { body = await req.json(); } catch {}
    const clientEtag = typeof body?.if_etag === "string" ? body.if_etag : null;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

    // Live session check (revocation-aware)
    const tokenHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(tokenHashBuf))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const { data: sessRow } = await supabase
      .from("app_sessions")
      .select("id, revoked_at, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!sessRow) return json({ success: false, error: "session not found" }, 401);
    if (sessRow.revoked_at) return json({ success: false, error: "session revoked" }, 401);
    if (sessRow.expires_at && new Date(sessRow.expires_at).getTime() < Date.now()) {
      return json({ success: false, error: "session expired" }, 401);
    }

    const nowIso = new Date().toISOString();

    // ---- Etag pre-check ----
    const [aggN, aggR] = await Promise.all([
      supabase
        .from("notifications")
        .select("id, created_at, expires_at, publish_at")
        .or(`audience.eq.all,target_user_id.eq.${session.userId}`),
      supabase
        .from("notification_reads")
        .select("read_at, seen_at, deleted_at, snoozed_until, dismissed_at, archived_at")
        .eq("user_id", session.userId),
    ]);
    let etagStr: string | null = null;
    if (!aggN.error && !aggR.error) {
      let cn = 0;
      let mxN = 0;
      for (const n of aggN.data || []) {
        if (n.expires_at && n.expires_at <= nowIso) continue;
        if (n.publish_at && n.publish_at > nowIso) continue;
        cn++;
        const t = n.created_at ? new Date(n.created_at).getTime() : 0;
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
        return json({ success: true, unchanged: true, etag: etagStr });
      }
    }

    const { data: notes, error: nErr } = await supabase
      .from("notifications")
      .select("id, title, body, description, body_markdown, image_url, category, priority, icon, platform_icon, kind, sub_kind, locked, show_frequency, mode, action_url, action_label, action2_url, action2_label, audience, target_user_id, created_at, expires_at, publish_at, group_key")
      .or(`audience.eq.all,target_user_id.eq.${session.userId}`)
      .order("created_at", { ascending: false })
      .limit(100);
    if (nErr) return json({ success: false, error: nErr.message }, 500);

    const active = (notes || []).filter((n: any) => {
      if (n.expires_at && n.expires_at <= nowIso) return false;
      if (n.publish_at && n.publish_at > nowIso) return false;
      return true;
    });
    const ids = active.map((n: any) => n.id);
    const readSet = new Set<string>();
    const seenSet = new Set<string>();
    const deletedSet = new Set<string>();
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
        if (r.deleted_at) deletedSet.add(r.notification_id);
        if (r.snoozed_until) snoozeMap.set(r.notification_id, r.snoozed_until);
      }
    }
    const payload = active
      .filter((n: any) => !deletedSet.has(n.id))
      .map((n: any) => ({
        id: n.id, title: n.title, body: n.body,
        description: n.description, body_markdown: n.body_markdown, image_url: n.image_url,
        category: n.category, priority: n.priority, icon: n.icon,
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
    return json({ success: true, notifications: payload, etag: etagStr });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
