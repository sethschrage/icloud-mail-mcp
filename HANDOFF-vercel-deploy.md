# Handoff: deploying the cloud version to Vercel

Written 2026-10-12 by the cloud session that built the cloud version. Seth moved the rest to a
Claude Desktop session on his Mac, which has a browser (Claude in Chrome) for the one step the
Vercel API can't do. **Delete this file once the deploy is done.**

## Where things stand

- **Code.**
  - Branch `claude/vercel-cloud`, commit `ba2a0ca`: the cloud version, plus this note.
  - Design and deploy guide: `docs/CLOUD.md`, and `docs/SPEC.md` §10.
  - Tests: typecheck clean, 398 unit and 225 integration tests passed (Linux) at `ba2a0ca`.
- **Not reviewed yet.** A pre-deploy security review was started and then stopped because of the
  move, before it produced findings. Run it first (see below).
- **Merge needed.** `main` has `32c858e` ("Make two unit tests pass on macOS", made from Seth's
  Mac). It touches `test/unit/log-audit.test.ts`, which this branch also changes (it allows the
  cloud audit line in the "no stdout writes" guard), so expect a small conflict and keep both
  changes.
- **Branch to delete.** Seth wants `claude/gmail-imap` deleted (the Gmail connector will be a
  separate repo later; its commit `885276c` is the reference). This cloud session wasn't allowed to
  delete branches. Delete it in GitHub's UI, or with `git push origin --delete claude/gmail-imap`
  from the Mac.

## Vercel (team `seth-schrage`, `team_dwBSy7RPb5YcgO9oBnZTaj2C`)

- **Project:** `icloud-mail-mcp`, id `prj_czJsTANmeluFTfJ8HD9QjPpEX2Al`.
  - Linked to GitHub `sethschrage/icloud-mail-mcp`; production branch `main`.
  - Node 24.x, framework Other.
  - Standard deployment protection: generated URLs are protected, the production domain is public.
- **Not deployed yet.** The first production deploy happens when `main` contains `api/`
  (merge and push) or on a manual deploy. Before the merge, deployments of `main` contain no
  function.
- **Env vars set (Production):**

  | Variable | Type | Value |
  |---|---|---|
  | `MCP_ACCESS_KEY` | Sensitive | Seth has it, saved in Apple Passwords |
  | `ICLOUD_EMAIL` | Encrypted | `sethschrage@mac.com` |
  | `MAIL_TIMEZONE` | Plain | `America/New_York` |

  If the key is lost, generate a new one and upsert it:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

## Remaining steps, in order

1. **Review, then fix.** Run the pre-deploy review below on `git diff main...claude/vercel-cloud`,
   verify each finding, fix the confirmed ones with regression tests, and commit on the branch.
2. **App-specific password.** Seth creates a new one for the cloud version (account.apple.com →
   Sign-In and Security → App-Specific Passwords). Store it as `ICLOUD_PASSWORD`, Sensitive,
   Production: either Seth pastes it into the project's environment-variables page himself, or the
   session upserts it via the Vercel API.
3. **Upstash for Redis.** This needs the browser: Marketplace consent can't be given through the API.
   - Open https://vercel.com/seth-schrage/icloud-mail-mcp/stores → Create Database →
     Upstash for Redis → Free plan.
   - Name `icloud-mail-limits`, region `iad1`.
   - Connect it to `icloud-mail-mcp` for Production, with the default prefix.
   - Then check that the project got `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or
     `UPSTASH_REDIS_REST_*`. The server reads both name pairs; any other prefix needs code or env
     changes.
4. **Merge and deploy.** Merge `main` into the branch, resolve the conflict, and rerun
   `npm run typecheck`, `npm run test:unit` and `npm run build:vercel`. Then merge the branch into
   `main` and push; Vercel deploys it.
   - The integration suite needs the Linux Dovecot test server in `test-infra/`. Its Dovecot 2.3
     config does not load on Homebrew's Dovecot 2.4, so on a Mac run the unit tests and the build,
     and note that the integration tests were not rerun.
   - Watch the build log: `npm run vercel-build` must produce `build/vercel/handler.mjs`, and the
     function `api/icloud-mail.js` must exist.
5. **Verify live** (the first test against real iCloud, which also checks the Mac version's iCloud
   assumptions):
   - POST without the key → 401.
   - `initialize` with the key → 200.
   - `tools/call get_account_info`: login works (sethschrage@mac.com, or the local-part
     fallback); special folders are *Sent Messages*, *Deleted Messages*, *Archive*, *Drafts*,
     *Junk*; `shared_send_limits.store` is `upstash`; the time is Eastern.
   - Then `search_messages` and `save_draft`.
   - Only with Seth's OK: one test send to himself, then check that exactly one copy is in
     *Sent Messages*.
6. **Connect Claude.** Seth adds a custom connector in claude.ai → Settings → Connectors → Add
   custom connector:
   - Name `iCloud Mail`, URL
     `https://<production-domain>/api/icloud-mail?key=<MCP_ACCESS_KEY>`, OAuth fields empty.
   - The production domain is assigned on the first deploy; likely `icloud-mail-mcp.vercel.app`.
   - If the Mac extension is also enabled in Claude Desktop, tell him that both sets of tools will
     show up.
7. Delete this file and push.

## The pre-deploy review to run (five lenses, each finding verified by a skeptic before fixing)

1. **Security of the public endpoint.**
   - Can anything be served before `checkAccess`? Try OPTIONS/HEAD, odd methods, malformed URLs,
     a duplicated `?key=`, the key in both query and header, URL-encoding, whitespace and unicode
     trimming.
   - Is the 503-vs-401 split acceptable?
   - Can secrets (access key, `ICLOUD_PASSWORD`, header passwords) leak into logs, error responses,
     tool results, SDK `onerror` or uncaught exceptions? Is `registerSecret` coverage complete?
   - Can headers redirect IMAP/SMTP hosts (SSRF)?
   - Can logins leak into each other? Check env identity in header logins, and LRU eviction closing
     a service that an in-flight request is still using.
   - Memory/DoS: cache size, body size.
   - Send tools must still be destructive and `requiresUserInteraction`.
2. **Protocol as a claude.ai connector.**
   - SDK 2.1.0 `createMcpHandler` legacy `stateless`: Accept headers, JSON vs SSE, protocol
     versions 2025-06-18/2025-11-25 (and the 2026-07-28 modern path), notifications (202),
     batches, GET/DELETE/HEAD/OPTIONS, a client-sent `Mcp-Session-Id`, Origin/Host checks.
   - Simulate a realistic connector exchange with raw `fetch`.
   - Two concurrent requests on one warm instance share one IMAP connection: check locks,
     mailbox-selection races, and whether one request's abort closes the shared connection for
     another.
   - Fluid compute suspending the instance: idle timers, sockets left open, the first call after a
     long pause.
3. **Shared limits** (`src/quota.ts`, `src/smtp/send.ts`).
   - Check against the real Upstash REST docs: the `/pipeline` body, response shape, per-command
     errors.
   - Check against the env names Vercel's Upstash integration actually injects.
   - Sliding-window edge cases; **a key recreated by DECRBY without a TTL**; negative counters;
     release on every failure path (SMTP failure, abort or timeout mid-send).
   - Interaction with the in-process limiters; limits set to 0; fail-closed messages.
4. **Deploy.**
   - Does Vercel run `vercel-build` before bundling functions?
   - Does the bundler follow the static re-export into the gitignored `build/vercel/`, or is
     `includeFiles` needed?
   - ESM with named GET/POST/DELETE exports; Node 24.
   - `.vercelignore` effects; `npm ci` with the lockfile (esbuild linux binaries); devDependencies
     during the build; `maxDuration` 60 on the plan; `vercel.json` validity.
5. **Docs.**
   - Every claim in `docs/CLOUD.md` and the README cloud section against the code (env names,
     status codes, headers, limits, 50 s vs 60 s, the audit prefix, Upstash names).
   - The curl commands; `claude mcp add --transport http … --header` syntax; the custom connector
     steps.
   - Cloud-mode tool descriptions and messages (`CLOUD_NO_LOGIN`, the `MissingSharedQuota` text,
     the 503 detail).

Fixed decisions (don't relitigate):
- buxfer-style access key with header-or-env login;
- sending on, with Upstash shared limits that fail closed;
- no attaching from disk in the cloud (share files through other connectors' links; forwarding
  existing attachments is fine);
- the audit trail goes to the Vercel logs;
- a new Vercel project;
- the local stdio version stays unchanged.
