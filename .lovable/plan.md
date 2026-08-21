
# Serverless Netflix TV Auto-Login via GitHub Actions

## Why GitHub Actions (the only truly-free serverless browser)

I looked at every option that fits "no paid add-on, no persistent VPS":

| Option | Can run Chromium? | Cost | Verdict |
|---|---|---|---|
| Supabase Edge Functions (Deno) | No — no browser binary allowed | Free tier | Impossible |
| Cloudflare Workers (regular) | No — no long-lived process, no Chromium | Free | Impossible |
| Cloudflare Browser Rendering | Yes | **Paid add-on (~$5/mo)** | Rejected by you |
| Deno Deploy / Vercel Edge | No | Free | Impossible |
| Browserless / Browserbase | Yes | Paid | Rejected by you |
| Fly.io / Railway free tier | Yes | Free tiers removed in 2024–25 | Not viable |
| **GitHub Actions (`ubuntu-latest`)** | **Yes — full Ubuntu VM + Chromium preinstalled** | **2000 free minutes/month private; unlimited on public repos** | **Winner** |
| Admin-triggered ephemeral VPS | Yes | Pay-per-second (~$0.007/run) | Fallback tier 2 |

A Netflix TV login run takes ~15–25 seconds. On the free 2000-min/month allowance that's **~5,000–8,000 logins per month for free** — well above real usage. Zero recurring cost, zero VPS to babysit, no new Supabase egress beyond a single webhook write.

## Architecture

```text
User clicks TV icon
      │
      ▼
Select IMAP account (existing UI)
      │
      ▼
Enter 8-digit code
      │
      ▼
manage-app  ─┐  tv_submit_code  (existing)
             │  1. verify code + cookies exist
             │  2. write tv_login_events row (status=queued)
             │  3. POST /repos/{owner}/{repo}/dispatches
             ▼        with { event_type: "tv-login",
                              client_payload: { event_id, code,
                              cookies_url, account_key } }
   GitHub Actions runner (ubuntu-latest, ~10s cold start)
      │
      │  playwright-core + preinstalled Chromium
      │  1. GET cookies from R2 signed URL (no Supabase egress)
      │  2. context.addCookies(...)
      │  3. goto https://www.netflix.com/tv8
      │  4. type 8-digit code, submit
      │  5. read on-page result: "Success" | "Invalid" | "Expired"
      │  6. POST result → manage-app?action=tv_login_report
      │       with HMAC of event_id + status (shared secret)
      ▼
manage-app tv_login_report
      │  updates tv_login_events row (status, message, screenshot_url)
      ▼
Client polls tv_login_events every 2s (existing pattern)
      │  shows "Login success" / "Invalid code" / "Cookies expired"
      ▼
On success → performSignOut() → nukeBrowserIdentity()
```

## Component breakdown

### 1. Cookie storage — Cloudflare R2 (already wired)
Reuse existing `imap_cookies` vault, but export the selected Netflix cookies to R2 as `tv/{event_id}.json` with a 5-minute signed URL. Cookies never traverse GitHub logs; the runner fetches and holds them in memory only.

### 2. GitHub Actions workflow (`.github/workflows/tv-login.yml`)
- Trigger: `repository_dispatch: types: [tv-login]`
- Job: `runs-on: ubuntu-latest`
- Steps: checkout → `bun install playwright-core` → `node scripts/tv-login.mjs`
- Timeout: 90 seconds hard cap
- Secrets: `TV_REPORT_URL`, `TV_REPORT_HMAC_KEY` (added via `add_secret` on the Lovable side, mirrored to GitHub Actions secrets)

### 3. Runner script (`scripts/tv-login.mjs`)
Playwright-core + system Chromium. Reads `client_payload` from `$GITHUB_EVENT_PATH`, loads cookies, submits code, parses one of three result states from the DOM, POSTs signed result. Never logs cookies or code.

### 4. manage-app additions
- `tv_submit_code` (extend): after validation, insert `tv_login_events` row, sign a short-lived R2 URL for the cookies, and fire the `repository_dispatch` webhook using a fine-scoped GitHub PAT.
- `tv_login_report` (new, public but HMAC-verified): validates `X-Tv-Signature`, updates the event row, deletes the R2 object.

### 5. Client UI (`TvAutoLoginButton`)
Replace the current "processing" spinner with a live status subscription:
- `queued` → "Preparing secure runner…"
- `running` → "Signing in to Netflix on your TV…"
- `success` → green check, auto-close after 2s, trigger sign-out
- `invalid_code` → red, "Code was rejected. Try again."
- `cookies_expired` → amber, "This account's cookies expired. Please refresh in Cookies vault."

Poll every 2s (already used elsewhere; no realtime egress).

### 6. Fallback tier — admin-abstracted ephemeral VPS (only if GitHub Actions is later blocked)
Design (not built now, wired for future): admin panel button "Provision Runner" calls a Hetzner/Vultr API using a stored token to spin up a $0.007/hr VPS, cloud-init installs Node+Playwright, worker script picks up jobs from the same `tv_login_events` queue, admin panel shows live logs via SSE, and a 10-minute idle-shutdown script destroys it. Zero permanent infrastructure. This is an interface, not a runtime — implement only if GitHub free minutes ever run out.

## Setup steps the user does once

1. Create a GitHub fine-grained PAT with `Contents: write` + `Actions: write` on this repo → I'll request it via `add_secret` as `GITHUB_DISPATCH_PAT`.
2. Add two matching secrets to GitHub Actions (`Settings → Secrets → Actions`): `TV_REPORT_URL` (the manage-app URL) and `TV_REPORT_HMAC_KEY` (I'll generate).
3. Push the new workflow file (Lovable commits it; GitHub picks it up automatically).

No VPS, no paid service, no Supabase edge quota beyond one dispatch call + one report call per TV login.

## Technical details

- **Egress:** ~2 KB per login on Supabase (dispatch + report). Cookies flow R2 ↔ GitHub, bypassing Supabase entirely.
- **Latency:** ~10s runner cold start + ~5–8s Netflix flow = **~15–20s total**. Shown live in UI so it doesn't feel blank.
- **Security:** cookies via 5-min signed R2 URL (single-use, deleted after report); report auth via HMAC-SHA256 over `event_id|status|timestamp`; PAT scoped to this repo only; runner logs redact cookies + code.
- **Session teardown:** on any terminal status the client calls the existing `performSignOut()` + `nukeBrowserIdentity()` path — matches your Netflix-style silent wipe requirement.
- **Concurrency:** GitHub Actions runs jobs in parallel; each event_id is independent.
- **Observability:** GitHub Actions log link stored on the `tv_login_events` row for admin diagnostics.

Approve this and I'll implement in one pass: workflow file, runner script, `tv_login_report` action, R2 signed-URL helper, dispatch call, and updated `TvAutoLoginButton` status UI.
