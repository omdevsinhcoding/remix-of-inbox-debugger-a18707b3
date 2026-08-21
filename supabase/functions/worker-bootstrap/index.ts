// Worker bootstrap endpoint — returns SUPABASE_URL, SUPABASE_KEY, SESSION_SECRET
// to Cloudflare Workers Builds during `npm run deploy`.
//
// Universal mode: any active Cloudflare Builds API token can bootstrap this
// Worker. There is no Cloudflare account allow/disallow gate here. Accounts are
// recorded only for audit/Telegram visibility, never for blocking deployment.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cf-token, x-bootstrap-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendTelegramAlert(text: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("[worker-bootstrap] telegram alert failed:", (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const cfToken = (req.headers.get("x-cf-token") || "").trim();
  if (!cfToken) {
    return json({ error: "Missing X-CF-Token header" }, 401);
  }





  // 1. Verify the CF token is valid & active
  let verifyRes: any = null;
  try {
    const r = await fetch(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      { headers: { Authorization: `Bearer ${cfToken}` } },
    );
    verifyRes = await r.json();
  } catch (e) {
    return json({ error: "Could not reach Cloudflare API", detail: (e as Error).message }, 502);
  }
  if (!verifyRes?.success || verifyRes?.result?.status !== "active") {
    return json({ error: "Invalid or inactive Cloudflare API token", cf: verifyRes }, 403);
  }

  // 2. Get the account(s) this token can access
  let accountsRes: any = null;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { Authorization: `Bearer ${cfToken}` },
    });
    accountsRes = await r.json();
  } catch (e) {
    return json({ error: "Could not list Cloudflare accounts", detail: (e as Error).message }, 502);
  }
  const accounts: Array<{ id: string; name: string }> = accountsRes?.result || [];
  if (!accounts.length) {
    return json({ error: "Token has no accessible accounts" }, 403);
  }
  // Use first account (CF Builds runs against one specific account)
  const account = accounts[0];

  // 3. Universal mode: any valid CF token is accepted. No allowlist.
  //    User has 20+ CF accounts and wants zero manual setup — the CF API
  //    token itself (auto-injected by CF Workers Builds) is proof of
  //    account ownership. We only log for visibility.
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: "Server not configured" }, 500);
  }

  // Fire-and-forget: record account for audit trail only.
  // Never blocks or fails the bootstrap.
  (async () => {
    try {
      const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: row } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "worker_account_audit")
        .maybeSingle();
      const list: Array<{ id: string; name: string; added_at: string }> =
        Array.isArray(row?.value) ? row.value : [];
      if (!list.find((x) => x.id === account.id)) {
        const updated = [...list, { id: account.id, name: account.name, added_at: new Date().toISOString() }];
        await supabase
          .from("app_settings")
          .upsert({ key: "worker_account_audit", value: updated }, { onConflict: "key" });
        await sendTelegramAlert(
          `✅ New Cloudflare account bootstrapped worker.\n` +
          `Name: <b>${account.name}</b>\nID: <code>${account.id}</code>\nTotal: ${updated.length}`,
        );
      }
    } catch (e) {
      console.warn("[worker-bootstrap] audit log failed:", (e as Error).message);
    }
  })();


  const SUPABASE_KEY =
    Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    "";
  const SESSION_SECRET =
    Deno.env.get("SESSION_SIGNING_SECRET") ||
    Deno.env.get("SESSION_SECRET") ||
    "";

  if (!SUPABASE_KEY || !SESSION_SECRET) {
    return json({
      error: "Server missing SUPABASE_KEY or SESSION_SECRET",
      missing: { SUPABASE_KEY: !SUPABASE_KEY, SESSION_SECRET: !SESSION_SECRET },
    }, 500);
  }

  return json({
    SUPABASE_URL,
    SUPABASE_KEY,
    SESSION_SECRET,
    account: { id: account.id, name: account.name },
  });
});
