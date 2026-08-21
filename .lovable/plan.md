# Bulletproof Security Overhaul — Live Checklist

Status legend: ✅ done & verified · 🟡 partial · ⬜ not started · 🚫 blocked

Feature flag: `app_settings.security_mode` — currently `"v2_strict"` (set, but only enforced where noted).

---

## PHASE A — Kill plaintext-response leak

- ✅ **A.1** Every response in `manage-app` + `fetch-emails` routed through `maybeEncryptResponse(__res, __ctx)`. Verified end-to-end with Node ECDH test (1525-byte octet-stream, decrypts to valid JSON).
- ✅ **A.1** `crypto-handshake` returns binary.
- ✅ **A.2** Client plaintext tolerance removed from `src/lib/secureTransport.ts` (strict — non-binary response → resetSession + throw).
- ✅ Fixed `supabase/config.toml` `project_id` (was pointing at wrong project → all handshakes 404). Redeployed all functions.
- ✅ **A.1** Server-side strict enforcement: plaintext requests to `manage-app` return `426 Upgrade Required` (`{"error":"encrypted transport required"}`). `fetch-emails` still allows plaintext ONLY when `x-cron-secret` header is present (cron path). Verified with curl.
- ✅ **A.3** Wire format v2 — every encrypted request carries `{ __v:2, n:<b64 16-byte nonce>, t:<unix_ms>, o:<sha256(origin)>, b:<body> }`. Server validates ±30s window (`stale request`), unique nonce per session via `crypto_nonces` table (`replay`), and origin_hash match (`origin mismatch`). All 3 failure modes verified end-to-end.
- ✅ **A.3** ECDH session TTL = 15 min (`crypto_sessions.expires_at`). Handshake response now includes 8-byte big-endian `expiresAt` suffix (90-byte total). Client rotates 60s before expiry via `getSession()`.
- ✅ **A.4** `handshake_rate(ip, minute_bucket, count)` table + per-IP limits (10/min, 100/hour) enforced in `handleHandshake`; over-limit returns 429. Verified table increments correctly.
- ✅ **A.4** Origin binding: `sha256(Origin)` stored in `crypto_sessions.origin_hash` at handshake, checked against envelope `o` on every request. Mismatch → 403.
- ✅ **A.4** `Sec-Fetch-Site` enforcement: browser requests where the header is present must be `same-origin`/`same-site`/`none`; anything else → 403. Non-browser clients (no header) bypass, so cron still works.

---

## PHASE B — Metadata + endpoint scrub

- ⬜ **B.1** Remove all direct browser calls to `supabase.rest.v1.*` — route via `manage-app` actions.
- ⬜ **B.1** Disable Supabase Realtime for sensitive tables; switch to encrypted polling.
- ⬜ **B.1** Proxy `auth/v1/*` sign-in behind `manage-app action:'auth.signIn'`.
- ⬜ **B.1** Move R2 `pub-*.r2.dev` avatar host behind app-owned CNAME.
- ⬜ **B.2** Remove `workerUrls` from bootstrap response. Worker URLs → `WORKER_URLS_JSON` env var, used only inside `fetch-emails`.
- ⬜ **B.2** Remove `siteKey`, `avatarBaseUrl`, `updated_at`, `versionFrom` from non-admin bootstrap.
- ⬜ **B.2** Restrict `users: [...]` directory to admin scope only.
- ⬜ **B.3** HMAC-sign every edge→worker call (`X-Signature`, `X-Ts`, 30s skew).
- ⬜ **B.3** Allow-list Supabase Functions egress IPs at Cloudflare Worker.

---

## PHASE C — Session hijack resistance

- ✅ **C.1 (partial)** Session state (session_token, user, admin_auth, admin_backup, pending_admin_token*, session_started_at) moved out of `localStorage` → in-memory `Map` + `sessionStorage` mirror (`src/lib/session.ts`). All 52 sites rewritten. Auto-migration from legacy localStorage on first load.
- ⬜ **C.1 (full)** Server-side session id in `Secure; HttpOnly; SameSite=Strict` cookie via new `session-issue` edge function. Access token in memory only. XSS-proof.
- ⬜ **C.1** New `src/lib/secureSession.ts` — Supabase auth storage adapter (in-memory + cookie).
- ⬜ **C.1** Netlify/Vercel same-origin rewrite `/api/*` → Supabase functions so cookie is same-origin.
- ⬜ **C.1** Force-logout all current users at cutover.
- ⬜ **C.2** Access token TTL 5 min, refresh TTL 12h, refresh rotates on every use.
- ⬜ **C.2** Refresh reuse detection → invalidate whole session family + Telegram alert. New `session-refresh` edge function.
- ⬜ **C.3** Device binding: `SHA-256(ua || accept-language || /24 IP)` stored on `app_sessions.binding_hash`, checked every call.
- ✅ **C.4** Vite version confirmed ≥ 5.4.6 (project on 6.4.3).
- ⬜ **C.4** DOMPurify wrapper on any user-rendered HTML.

---

## PHASE D — Admin path lockdown

- ⬜ **D.1** Server-side `has_role(auth.uid(),'admin')` check on every admin action. Audit that we never trust client-sent role field.
- ⬜ **D.1** Audit every JWT verification for `jwt.verify()` (never `jwt.decode()`).
- ⬜ **D.2** Fresh TOTP (or WebAuthn) required within last 5 min for every mutating admin action.
- ⬜ **D.2** Replace `sessionStorage.maintenance_admin_bypass` with signed short-lived JWS (10 min, single-use nonce).
- ⬜ **D.3** New `admin_audit_log` table: INSERT-only for service_role, no UPDATE/DELETE for anyone.
- ⬜ **D.3** Weekly digest to admin Telegram.

---

## PHASE E — DB & RLS sweep

- ✅ `notification_impressions` RLS scoped to owner (auth.uid()).
- ✅ `notification_translations` anon SELECT revoked.
- ✅ `security_events` table exists (service_role only, append-only).
- ⬜ **E.1** Run blanket audit: every public table has RLS enabled AND has ≥1 policy. Fix everything the query returns.
- ⬜ **E.2** Sweep `public.*`: `REVOKE ALL FROM anon` unless a policy explicitly needs anon. Only truly public tables keep `GRANT SELECT`.
- ⬜ **E.3** Every `SECURITY DEFINER` function: `SET search_path = public, pg_temp`, `SET LOCAL row_security = on`, revoke from PUBLIC/anon/authenticated, grant EXECUTE only to service_role.
- ⬜ **E.4** Column-level protection: `security_barrier` views excluding `users.email`, `users.telegram_chat_id`, `email_accounts.password_enc`, `crypto_sessions.aes_key`. Base-table SELECT `USING(false)`.
- ⬜ **E.5** Confirm Postgres patched for CVE-2024-10976 (≥ 15.9 / 16.5 / 17.1). Request platform upgrade if below.
- ⬜ **E.6** Index every RLS `USING` column.
- ⬜ **E.6** `ALTER ROLE anon SET statement_timeout = '5s'` and same for `authenticated`.

---

## PHASE F — Supply chain

- ⬜ Add `npm audit --audit-level=high` as pre-build gate (fail on high/critical).
- ⬜ Pin all deps in lockfile (no `^` `~` in resolution). Enforce `npm ci` / `bun install --frozen-lockfile` in CI.
- ⬜ `package.json` `overrides` block for top 20 riskiest transitives (debug, chalk, color-convert, ansi-*, ua-parser-js, @tanstack/*).
- ⬜ No third-party CDN `<script>` without SRI.
- ⬜ Weekly Dependabot-equivalent checkpoint saved to project memory.
- ⬜ Commit BOTH `bun.lock` and `package-lock.json`; CI drift check.

---

## PHASE G — Strict CSP + security headers

- ⬜ Nonce-based CSP in `netlify.toml` + `vercel.json`:
      `default-src 'none'; script-src 'nonce-{R}' 'strict-dynamic'; style-src 'nonce-{R}'; img-src 'self' data: https://<r2-cname>; font-src 'self'; connect-src 'self' https://jsqchutnfdeljajkxmly.supabase.co; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; upgrade-insecure-requests`.
- ⬜ `<meta>` CSP fallback in `index.html`.
- ⬜ Additional headers: `Permissions-Policy`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- ⬜ Nonce injection at build step (Vite plugin).
- ⬜ Report-only rollout for 3 days first, then enforce.
- ⬜ `report-to` endpoint funnels violations into `security_events`.

---

## PHASE H — Client integrity attestation

- ⬜ `src/lib/clientIntegrity.ts` — computes SHA-256 of bundle on load.
- ⬜ Handshake includes `{bundle_hash}` inside encrypted envelope.
- ⬜ New `client_integrity_allowlist(bundle_hash, version, active)` table.
- ⬜ Server rejects handshake if bundle_hash not in active allow-list → binary 403.
- ⬜ `scripts/postbuild-registerHash.ts` — auto-inserts new hash on every deploy.
- ⬜ `vite.config.ts` — keep single-file build, add stable bundle hash.

---

## PHASE I — Monitoring & IR

- ✅ `security_events` table exists.
- ⬜ Wire up event types: `replay_detected, nonce_reuse, origin_mismatch, plaintext_downgrade_attempt, rate_limit_hit, handshake_flood, admin_step_up_failed, jwt_verify_failed, binding_mismatch, csp_report`.
- ⬜ New `security-alert` edge function → Telegram admin chat on severity ≥ high (rate-limited).
- ⬜ CSP `report-to` → `security_events`.
- ⬜ Weekly digest job.

---

## New files still to CREATE

- ⬜ `supabase/functions/_shared/respond.ts`
- ⬜ `supabase/functions/_shared/antiReplay.ts`
- ⬜ `supabase/functions/_shared/rateLimit.ts`
- ⬜ `supabase/functions/_shared/adminGuard.ts`
- ⬜ `supabase/functions/_shared/workerClient.ts`
- ⬜ `supabase/functions/session-issue/index.ts`
- ⬜ `supabase/functions/session-refresh/index.ts`
- ⬜ `supabase/functions/security-alert/index.ts`
- ⬜ `src/lib/secureSession.ts`
- ⬜ `src/lib/clientIntegrity.ts`
- ⬜ `scripts/postbuild-registerHash.ts`

## Files still to EDIT

- ⬜ `supabase/functions/_shared/crypto.ts` — v2 wire format
- ⬜ `supabase/functions/manage-app/index.ts` — strip workerUrls/siteKey/avatarBaseUrl from non-admin responses
- ⬜ `supabase/functions/fetch-emails/index.ts` — worker call fully server-side
- ⬜ `supabase/functions/crypto-handshake/index.ts` — origin bind, rate limit, HKDF context
- ⬜ `src/lib/secureTransport.ts` — v2 wire format, nonce+ts+origin, integrity attestation
- ⬜ `src/lib/bootstrap.ts` — stop consuming workerUrls; avatar base URL from build-time env
- ⬜ `src/App.tsx` — direct Supabase reads → invokeEdge
- ⬜ `index.html`, `netlify.toml`, `vercel.json` — CSP + security headers
- ⬜ `vite.config.ts` — bundle hash for integrity

## Migrations still to run (single bundle)

- ⬜ `crypto_nonces`, `handshake_rate`, `api_rate_limits`, `app_sessions`, `admin_audit_log`, `client_integrity_allowlist`, `purge_expired_nonces()` function.

---

## What was done in earlier turns (recap)

- Signing-secret raw value no longer returned from `manage-app` (fingerprint only).
- `notification_impressions` + `notification_translations` RLS tightened.
- Impersonation "kicks admin out" race fixed (`navigate` before `checkAuth`).
- `security_mode='v2_strict'` flag row inserted.
