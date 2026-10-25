# iCloud Mail for Claude: cloud version (Vercel)

The same mail tools as the Claude Desktop extension, hosted on Vercel, so Claude can reach your
iCloud Mail from claude.ai, the Claude mobile apps or Claude Code without your Mac running.

The local extension keeps working exactly as before. The cloud version is a second entry point
(`api/icloud-mail.js`, built from `src/http/`) in the same repository.

**Contents**

- [How it works](#how-it-works)
- [What is different from the Mac extension](#what-is-different-from-the-mac-extension)
- [Deploy](#deploy): [1. Project](#1-create-the-vercel-project) · [2. Upstash](#2-add-upstash-for-redis-send-limits) ·
  [3. Environment variables](#3-environment-variables) · [4. Deploy and check](#4-deploy-and-check) · [5. Connect Claude](#5-connect-claude)
- [Logging in with connector headers instead](#logging-in-with-connector-headers-instead)
- [Send limits: why Upstash](#send-limits-why-upstash)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
Claude (claude.ai, mobile, Claude Code)
   │  HTTPS, MCP (stateless Streamable HTTP), access key in ?key= or Authorization: Bearer
   ▼
Vercel function  /api/icloud-mail          ← refuses every request without the access key
   │  IMAP (imap.mail.me.com:993, TLS)     ← iCloud login: connector headers, else Vercel env vars
   │  SMTP (smtp.mail.me.com:587, STARTTLS)
   ▼
iCloud Mail  ──sync──►  Apple Mail on your devices

Send limits ─► Upstash Redis (shared by every Vercel instance)
Audit trail ─► Vercel logs
```

Access and login follow the pattern of your buxfer-mcp:

- **Access key.** Every request needs `MCP_ACCESS_KEY` (32+ characters), either as `?key=…` in the
  connector URL or as `Authorization: Bearer …`. The check runs in constant time. Without the key
  the answer is `401 {"error":"unauthorized"}`. If `MCP_ACCESS_KEY` is missing or shorter than 32
  characters, every request is refused with `503`.
- **iCloud login.** It comes from connector headers (`X-ICloud-Email`, `X-ICloud-Password`, and
  optionally `X-ICloud-From`) if the caller sends them, otherwise from the Vercel env vars
  `ICLOUD_EMAIL` / `ICLOUD_PASSWORD`. Headers never replace the access key.
- **Connection reuse.** The IMAP connection for a login is kept while the Vercel instance stays
  warm. The cache is keyed by a SHA-256 of email + password, never the raw values. Up to 16
  logins are kept; the least recently used one is closed once no request is using it.
- **Secrets stay hidden.** Passwords and the access key are never logged or returned. Error
  messages repeat only what Apple's servers said, and the tests check that a password never
  appears in an error.

## What is different from the Mac extension

| | Mac extension | Cloud version |
|---|---|---|
| Runs | on your Mac, started by Claude Desktop | on Vercel; your Mac can be off |
| Works from | Claude Desktop, Claude Code on that Mac | claude.ai, Claude mobile apps, Claude Desktop, Claude Code anywhere |
| Password | macOS Keychain (via the extension settings) | Vercel env var (Sensitive), or a connector header |
| Opening attachments | saved to `~/Downloads/iCloud Mail Attachments`; images and text also shown | not saved (no disk): images up to 3 MB and text up to 200 KB come back inline; other files (PDFs, documents) are described by name, type and size |
| Attaching files | files from Desktop, Documents, Downloads | not available (no disk). Share files with a link from another connector (e.g. Google Drive) in the body, or forward an email with its attachments (`forward_message`, or `save_draft` with `forward_of`) |
| Confirmation before sending | Claude's approval prompt, plus an optional Mac dialog | Claude's approval prompt. Send tools are marked destructive and as always requiring approval, so Claude asks on every send (with `MAIL_FORWARD_ALWAYS_ALLOW=true`, forwarding can be *Always allow*, and the connector may default to that) |
| Send limits | counted in memory on your Mac | counted in Upstash Redis, shared by every Vercel instance |
| Audit trail | `~/Library/Logs/icloud-mail-mcp/audit.jsonl` | Vercel logs (lines start with `icloud-mail-audit`) |
| Time limit per tool call | 120 s | 50 s at most (the Vercel function may run 60 s) |

All 19 tools are available in both, with the same names. Permanent delete stays off unless you
set `MAIL_ALLOW_PERMANENT_DELETE=true`.

## Deploy

You need: a Vercel account (team `seth-schrage`), this GitHub repository, and an iCloud
app-specific password. Create one at **account.apple.com → Sign-In and Security →
App-Specific Passwords**. Use a new one just for the cloud version, so you can revoke it on its own.

### 1. Create the Vercel project

1. In Vercel: **Add New… → Project**. Import **sethschrage/icloud-mail-mcp**.
2. Framework preset: **Other**. Leave the build and output settings at their defaults:
   - Vercel runs `npm run vercel-build`, which bundles the server into `build/vercel/handler.mjs`.
   - `api/icloud-mail.js` re-exports that bundle.
   - The output directory is `public/`, which only holds a `robots.txt`. Vercel needs it because
     `package.json` has a `build` script (the Mac extension's); without it the build fails with
     "No Output Directory named "public" found".
3. Don't deploy yet; add the environment variables first (step 3). If Vercel deploys right away,
   that first deployment just answers `503` until the variables are set and you redeploy.

Pushing to `main` deploys to production from then on.

### 2. Add Upstash for Redis (send limits)

1. In the project: **Storage → Create Database → Upstash for Redis** (from the Marketplace; the
   free tier is plenty).
2. Connect it to the project for **Production** (and Preview, if you use previews). Type `KV` as
   the custom prefix: the form suggests `STORAGE`, which would create `STORAGE_REST_API_URL`,
   names the server does not read.
3. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (plus a read-only token and `KV_URL` /
   `KV_REDIS_URL`, which are not used); the server reads those two.
4. If you create the database on upstash.com instead, set `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` yourself.

Without Upstash, sending is refused with a message explaining this step. Drafts still work. To run
without it on purpose, set `MAIL_RATE_LIMIT_STORE=memory`; see
[Send limits: why Upstash](#send-limits-why-upstash).

### 3. Environment variables

In **Settings → Environment Variables**, for **Production**. Mark secrets **Sensitive**: Vercel
then never shows the value again, and only the deployed function can read it.

| Variable | Value | Sensitive |
|---|---|---|
| `MCP_ACCESS_KEY` | A new random key, see below. Keep it in Apple Passwords. | yes |
| `ICLOUD_EMAIL` | Your primary iCloud Mail address (e.g. @icloud.com, or the @me.com / @mac.com one if that is your primary address). Use it even if you send from a custom domain. | no |
| `ICLOUD_PASSWORD` | The app-specific password (`xxxx-xxxx-xxxx-xxxx`) | yes |
| `MAIL_TIMEZONE` | Your time zone, e.g. `America/Los_Angeles`. Vercel runs in UTC. | no |
| `MAIL_FROM_ADDRESS` | Only if you send from a custom-domain address or alias | no |
| `MAIL_FROM_NAME` | Your name as recipients should see it (optional) | no |

Generate the access key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Optional settings work exactly as in the Mac version, e.g.:
- `MAIL_ALLOW_SEND=false` for drafts only;
- `MAIL_READ_ONLY=true`;
- `MAIL_MAX_SENDS_PER_HOUR` / `MAIL_MAX_RECIPIENTS_PER_HOUR` / `MAIL_MAX_RECIPIENTS_PER_DAY`
  (defaults 30 / 150 / 500);
- `MAIL_ALLOW_PERMANENT_DELETE=true`;
- `MAIL_FORWARD_ALWAYS_ALLOW=true`, so forwarding can be *Always allow* in Claude. The connector
  may switch it to that on its own; set it to *Needs approval* to keep being asked. The README's
  Guardrails explain the risk.

The full list is in the [README](../README.md#configuration-reference). Settings about local
folders (`MAIL_ATTACHMENT_DIR`, `MAIL_ATTACH_FROM_DIRS`) are ignored in the cloud.
`MAIL_CONFIRM_DIALOG` is refused, because the dialog only exists on a Mac.

### 4. Deploy and check

Deploy (or redeploy after changing variables). Then:

The connector needs a public production domain. Vercel's Standard Protection keeps the URLs it
generates (including `<project>-<team>.vercel.app`) behind Vercel login, which a connector can't
pass, so add your own under **Settings → Domains → Add**: any free `<name>.vercel.app` will do.
This project uses `icloud-mail-connector-mcp.vercel.app`. Don't guess the name: `icloud-mail-mcp.vercel.app`
belongs to someone else's project, and a connector pointed there would hand them your access key.
Check that a request without the key gets the server's own `{"error":"unauthorized"}`, not a
Vercel login page.

```bash
URL="https://icloud-mail-connector-mcp.vercel.app/api/icloud-mail"
KEY="<the access key>"

# 401 without the key
curl -s -X POST "$URL" -H 'content-type: application/json' -d '{}'

# Initialize with it (prints one `data:` line whose serverInfo name is icloud-mail)
curl -s -X POST "$URL" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

### 5. Connect Claude

**claude.ai, Claude Desktop (and from there the mobile apps):**
1. Go to **Customize → Connectors**, click **+ Add → Add custom connector**. (On Team and
   Enterprise plans an Owner adds it under **Organization settings → Connectors**.)
2. Name: `iCloud Mail`.
3. URL: `https://icloud-mail-connector-mcp.vercel.app/api/icloud-mail`, then **Continue**.
4. Under **Authentication** choose **No sign-in**. The form pre-selects "Sign in now (Detected)"
   because the server answers 401 without the key; left that way, adding fails with "Couldn't
   register with … sign-in service". Under **Request headers** add `Authorization` with the
   value `Bearer <MCP_ACCESS_KEY>`. Then **Add**.
   - Custom connectors can't be added in the mobile apps; once added here they show up there.
     Turn the connector on in a chat's tools menu.
   - If your client has no Request headers field, append the key to the URL instead:
     `https://icloud-mail-connector-mcp.vercel.app/api/icloud-mail?key=<MCP_ACCESS_KEY>`.
5. Then ask: "Use iCloud Mail to show my account info." It should list your folders as
   *Sent Messages*, *Deleted Messages*, *Archive*, *Drafts* and *Junk*, and
   `shared_send_limits.store` should be `upstash`.

If you also have the Mac extension installed in Claude Desktop, give the two different names (or
turn one off). Otherwise Claude sees two sets of identical tools.

**Claude Code** (the key in a header instead of the URL):

```bash
claude mcp add --transport http icloud-mail https://icloud-mail-connector-mcp.vercel.app/api/icloud-mail \
  --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

## Logging in with connector headers instead

A client that can send custom headers (Claude Code, a claude.ai connector's Request headers, or
any MCP client) can bring its own iCloud login. The server's env login is then not used for that
request:

| Header | Value |
|---|---|
| `X-ICloud-Email` | iCloud Mail address (the @icloud.com one) |
| `X-ICloud-Password` | app-specific password (`xxxx-xxxx-xxxx-xxxx`; anything else is refused) |
| `X-ICloud-From` | optional default From (alias or custom-domain address) |

- **Both or neither.** Send both email and password, or neither. `X-ICloud-From` only works
  together with them; on its own it counts as an incomplete set. An incomplete or malformed set
  is reported (without repeating the header values), never mixed with the env login.
- **Separate identity.** A header login does not inherit the env's identity settings
  (`MAIL_FROM_ADDRESS`, `MAIL_ALLOWED_FROM`, `ICLOUD_IMAP_USER`, ...).
- **Separate send limits per address.** Limits are counted per iCloud address, so a header login
  for a different address has its own limits (and one for the same address shares them).
- **Still needs the access key.** The access key is required either way.

```bash
claude mcp add --transport http icloud-mail https://icloud-mail-connector-mcp.vercel.app/api/icloud-mail \
  --header "Authorization: Bearer <MCP_ACCESS_KEY>" \
  --header "X-ICloud-Email: you@icloud.com" --header "X-ICloud-Password: xxxx-xxxx-xxxx-xxxx"
```

In a claude.ai custom connector, add the same headers under **Request headers**. Without them it
uses the env login.

## Send limits: why Upstash

The hourly and daily caps exist so a runaway loop or a prompt-injected email can't send a flood of
mail (iCloud suspends sending at about 1,000 recipients a day). On a Mac there is one server
process, so counting in memory is exact. On Vercel it isn't:

- **Per-instance limits** (`MAIL_RATE_LIMIT_STORE=memory`):
  - Each Vercel instance counts on its own.
  - Two instances running at the same time each allow the full limit.
  - Every cold start or deploy resets the count, so the daily cap means little.
  - Nothing extra to set up.
- **Shared limits in Upstash Redis** (the default when sending is on):
  - Every instance counts in the same place, so the caps hold.
  - The cost is one free Marketplace database, two env vars, and a few milliseconds per send.
  - **It fails closed:** if Upstash can't be reached, nothing is sent (drafts still work), rather
    than sending without limits.
  - Limits are counted over an exact rolling hour (and rolling 24 hours): no 60-minute (or
    24-hour) span ever holds more than the limit, at the top of the hour or anywhere else.
  - Counters are keyed by a hash of the email address, never the address.

You chose shared limits. With `MAIL_ALLOW_SEND=false` (drafts only), Upstash isn't needed at all.

## Security notes

- **Who can use it.** Anyone with the access key can use your mailbox through this server.
  - Treat it (and a connector URL that contains it) like a password.
  - To revoke access, change `MCP_ACCESS_KEY` in Vercel, redeploy, and update the connector.
- **Password storage.** The app-specific password is stored as a Sensitive Vercel env var, not
  readable in the dashboard after it's saved.
  - It can read and send mail. Apple's app-specific passwords also work for iCloud contacts and
    calendars.
  - Revoke it at account.apple.com at any time. Every app-specific password is revoked when your
    Apple Account password changes.
  - Using a separate one for the cloud version lets you revoke it without breaking the Mac
    extension.
- **The key in the URL.** With `?key=`, the access key travels in the URL, as with buxfer-mcp.
  - The server never logs URLs or request headers.
  - Vercel's own request logs, visible to your team only, may show request paths.
  - Prefer `Authorization: Bearer` in clients that support headers (Claude Code, and claude.ai's
    Request headers).
- **Untrusted email content.** It's handled as in the Mac version: email content is marked as
  untrusted, and every send needs your approval in Claude.
- **Audit trail.** The Vercel logs keep an entry for every change and send (tool, account,
  recipients, subject, Message-ID; never bodies). Search the logs for `icloud-mail-audit`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `503 server not configured` | `MCP_ACCESS_KEY` is missing or under 32 characters. Set it, then redeploy. |
| `401 unauthorized` | The key in the connector URL (or Bearer header) does not match `MCP_ACCESS_KEY`. |
| "No iCloud login was provided" | Set `ICLOUD_EMAIL` and `ICLOUD_PASSWORD` (then redeploy), or send the login headers. |
| "Login headers not usable" | `X-ICloud-Email` must be an email address and `X-ICloud-Password` an app-specific password. Check that they aren't swapped. |
| iCloud rejected the login | Use your primary iCloud Mail address and an app-specific password (not your Apple Account password). Create a new one if you changed your Apple Account password. |
| "Not sent: … Upstash …" | Add Upstash for Redis (step 2) and redeploy, or check that its token is still valid. |
| Dates are in UTC | Set `MAIL_TIMEZONE`. |
| A tool times out | Each tool call stops after 50 s (`MAIL_OPERATION_TIMEOUT_SECONDS`; higher values are capped at 50 s), inside the function's 60 s `maxDuration` in `vercel.json`. Searches across all mailboxes can take longer; narrow the search. |
| Logs | Vercel → the project → **Logs**. Set `MAIL_LOG_LEVEL=info` for more detail (never passwords or message text). |

To run the cloud handler locally:
1. Build it with `npm run build:vercel`.
2. Run the tests: `test/unit/cloud.test.ts`, and `test/integration/cloud-e2e.test.ts` against the
   local test mail server.
