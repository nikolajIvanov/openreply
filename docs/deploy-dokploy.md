# Self-Hosting on Dokploy

This guide covers deploying OpenReply on your own server using [Dokploy](https://dokploy.com), as an alternative to the Vercel + Railway setup covered in `docs/setup.md`. Running everything on your own Dokploy instance means no per-seat hosting fees and no usage caps — but there are a few gotchas specific to this setup worth knowing up front.

## Overview

OpenReply needs four services running:
- **Web app** — the Next.js dashboard, OAuth callback, and webhook receiver
- **Worker** — a long-running Node process that sends the DMs (cannot run as a serverless function)
- **Postgres**
- **Redis**

On Dokploy, these become: one Postgres database service, one Redis database service, and **two separate Applications** pointing at the same repo (one for the web app, one for the worker), each with different start commands.

Since everything runs on the same Dokploy server, you don't need the "public vs internal database URL" split that the Vercel/Railway guide requires — both apps can just use Dokploy's internal service hostnames directly.

## Gotcha #1 — Node version

The repo doesn't pin a Node version, so Nixpacks (Dokploy's default build system) will default to an old version — too old for this project's dependencies (Prisma 7 and Next.js 16 both require Node 20.19+, 22.12+, or 24+).

Depending on which Nixpacks version your Dokploy instance ships, you may also find:
- Requesting Node 22 via `NIXPACKS_NODE_VERSION=22` resolves to a patch (e.g. 22.11.0) just below Prisma's 22.12 minimum
- Requesting Node 24 fails outright with `undefined variable 'nodejs_24'`, if the pinned Nix package snapshot predates Node 24's availability

**Fix:** add a `nixpacks.toml` file to the repo root to pin a newer, known-good Nix package snapshot:

```toml
[phases.setup]
nixpkgsArchive = "51ad838b03a05b1de6f9f2a0fffecee64a9788ee"
```

This snapshot provides Node 22.13.1, which satisfies Prisma's requirement. Then set:

```
NIXPACKS_NODE_VERSION=22
```

as an environment variable on both the web app and worker app in Dokploy.

## Gotcha #2 — No dedicated "Build Command" field

Unlike Vercel/Railway, Dokploy's Nixpacks builder reads `package.json` scripts automatically and has no separate Build Command / Start Command UI field. To override the detected commands, set these as **environment variables** instead:

**Web app:**
```
NIXPACKS_BUILD_CMD=npx prisma generate && next build
NIXPACKS_START_CMD=npx prisma migrate deploy && npm start
```

**Worker app:**
```
NIXPACKS_BUILD_CMD=npm run db:generate
NIXPACKS_START_CMD=npm run worker
```

## Gotcha #3 — Migrations must run at start, not build

This is the one most likely to trip people up: **`prisma migrate deploy` cannot run during the Docker build step.** Docker builds run in an isolated environment with no access to Dokploy's internal service network, so the database isn't reachable yet — you'll see:

```
Error: P1001: Can't reach database server at `<db-service-name>:5432`
```

if you try to run migrations as part of the build (e.g. via the `vercel-build` script, which bundles `prisma generate && prisma migrate deploy && next build` together). The fix is the build/start command split shown above — `prisma generate` and `next build` happen at build time (no DB needed), while `prisma migrate deploy` runs in the start command, once the container is actually live and on the network.

## Gotcha #4 — Nothing runs the cron jobs

The three jobs under `/api/cron` are scheduled by the `crons` block in
`vercel.json`. Nothing outside Vercel reads that file, so on a self-hosted
instance they simply never run — and none of them fails loudly:

- **`refresh-tokens`** is the one that hurts. The Instagram token expires and
  every automation stops, with no error anywhere: comments keep arriving and
  nothing answers them.
- **`attach-next-reel`** binds a campaign created ahead of time to the reel
  published after it. Without it, a "next reel" campaign stays inert forever.
- **`snapshot-followers`** keeps the follower history, which Instagram only
  retains for ~30 days.

**Fix:** run `scripts/cron.sh` as a fourth service, from the same image as the
web app — the same pattern as the worker, so the jobs live and die with the app
they belong to:

```yaml
  cron:
    image: <same image as web>
    restart: unless-stopped
    command: ["sh", "scripts/cron.sh"]
    environment:
      CRON_BASE_URL: http://web:3000
      CRON_SECRET: ${CRON_SECRET}
    depends_on:
      web:
        condition: service_healthy
```

`condition: service_healthy` matters: started alone, the first run fires while
the web app is still booting and dies on connection refused.

The script calls `attach-next-reel` every five minutes and the other two once a
day. Five minutes is deliberate — on Vercel this runs daily, which means a
campaign prepared before publishing stays inactive for the whole first evening,
when most of the comments arrive.

## Step-by-step

1. Fork this repo.
2. In Dokploy: **Create → Database → PostgreSQL** and **Create → Database → Redis**. Note their internal service hostnames.
3. In Dokploy: **Create → Application**, connect your fork, `main` branch. This is the web app.
4. Add the `nixpacks.toml` file (Gotcha #1) to your fork's root, and set the environment variables from Gotchas #1 and #2 (web app version) plus the standard variables from `.env.example` — pointing `DATABASE_URL` and `REDIS_URL` at the internal hostnames from step 2.
5. Assign a domain to the web app only (not the worker) in Dokploy's Domains section, container port `3000`. This becomes your `NEXTAUTH_URL`.
6. Repeat step 3 for a second Application — this is the worker. Use the worker's build/start commands from Gotcha #2, and the same full set of environment variables as the web app, especially `DATABASE_URL`, `REDIS_URL`, and `ENCRYPTION_KEY` (these three must match exactly between both apps, or DM sends will fail to decrypt).
7. Deploy both apps.
8. Add the cron service from Gotcha #4, so the scheduled jobs actually run.
9. Check `https://your-domain/api/health` — confirms database, Redis, queue, and worker heartbeat are all healthy.

From here, the Meta app setup, OAuth redirect, and webhook configuration are identical to the standard setup in `docs/setup.md`.

## Creator workflow extension (2026-10-03)

This fork adds drafts/archives, a shared deterministic campaign selector,
priority/exclusion keywords, immutable delivery snapshots, observable stages,
workspace resource/template copies and read/draft-only service integrations.
Existing `isActive` rows are backfilled to ACTIVE/PAUSED by additive migration
`20261003090000_campaign_workspace_extensions`. Historical rows are not paused
or deleted. Archived campaigns retain their tracking links and shared reports.
Copies and service-created campaigns start as DRAFT and cannot send.

### Safe release order

1. Check existing active overlaps and pending-next-reel campaigns. Specific-post
   campaigns now beat global campaigns, then priority, then creation time/id.
   A retry reserves the original winner before external effects. If a historical
   account has several active pending campaigns, attachment stops for manual
   resolution rather than choosing an arbitrary new reel.
2. Make a fresh database dump; restore it to a separate database and check counts.
   A configured schedule is not proof of a successful backup. Keep dump checksum,
   path, restore result and previous release SHA in the operations record.
3. Temporarily disable worker autodeploy without stopping the running old worker.
   Push the reviewed source; deploy Web first. The Dockerfile runs
   `prisma migrate deploy` at runtime, not during the network-isolated build.
4. Confirm migration success, public health `release` and Dokploy Git SHA. Only
   then deploy the worker from the same SHA; confirm its heartbeat `release` and
   new start timestamp. Restore worker autodeploy after success.
5. Check authenticated campaigns, editor, library and delivery history. A green
   build/heartbeat is not an Instagram delivery test. Use a designated test post
   and recipient for a later bounded real send, never random customer comments.

Old application code can be rolled back without removing these additive columns
and tables. Do not run destructive schema rollback on the live database.
`CLAIMED` after a crash means potentially delivered: inspect Instagram manually,
do not auto-resend. Old follow-up jobs without an interaction-window anchor are
recorded SKIPPED. New follow-ups retain their content and original interaction
timestamp; outside the known 24-hour window they are skipped.

### Library and integrations

- `/library`: store RESOURCE (description, URL, message, category) or save a
  TEMPLATE snapshot from an existing campaign. Changes never rewrite copied
  campaigns or previously sent links. Resource/template lists show latest200.
- Campaign detail → Verlauf: latest100 delivery stages, latest50 version snapshots
  and reported conversion counts. Raw link requests may include bot previews and
  repeats; clicks/100 sends is not a unique-recipient conversion percentage.
- `/integrations`: an admin creates scoped, revocable service keys with max90-day
  expiry (UI defaults30 days). Raw token returned only once; store in the client
  secret store, never in URLs, logs or workflows exported to GitHub.
- `/api/v1/campaigns`: GET list (latest100), `?id=…` detail, `?id=…&stats` outcomes;
  POST creates only a DRAFT. Payload includes `instagramAccountId`, `name`, content
  and stable `idempotencyKey`. Retrying identical input returns the same campaign;
  reusing the key for changed content returns409. No service key can publish/send.
- `/api/mcp`: stateless Streamable HTTP with Bearer header, initialize, tools/list,
  tools/call and notifications. Tools: list_campaigns, get_campaign,
  get_campaign_stats, create_draft, validate_campaign (completeness only).
  Tested with the official MCP client. Not an OAuth/dynamic-registration server;
  use a client supporting custom Authorization headers, not an assumed Claude-Web
  connector. Origin checked; accept JSON and event-stream; GET stream returns405.
- `/api/v1/events`: events:read scope, immutable integration rows plus persisted
  delivery outcomes. Poll `since` ISO timestamp; follow all `nextCursor` pages;
  only checkpoint after successful processing. Start next poll using returned
  `nextSince` (15-minute overlap). Dedupe by eventId + status at the consumer.
  A transaction delayed longer than the overlap requires a wider replay. This is
  at-least-once, not exactly-once. No arbitrary outbound webhook URL/SSRF sink.
- `/api/v1/conversions`: conversions:write scope; POST campaignId, stable externalId,
  type resource_downloaded/form_completed/qualified_inquiry and optional opaque
  subjectRef/value. The same event is deduplicated; foreign campaigns return404.
  Trusted backend credentials only, never embed the key in public landing-page JS.
  A resource request does not imply a HubSpot deal or an email identity.

Screenshot/text AI drafting can happen in the connected assistant, then call
create_draft with reviewed facts. Missing URLs stay missing; never invent links.
No new paid AI provider, autonomous public replies, TikTok integration, A/B split
or no-click reminders are enabled here. Those require confirmed access and
recipient-level signals first. Existing reminders are time-based only.

### Verification

Run `npm run db:generate`, `npm run typecheck`, `npm run build`, `npm test`.
Real PostgreSQL suites use TEST_DATABASE_URL and their own disposable schemas.
`scripts/verify-extensions.ts` additionally exercises actual session HTTP routes,
two-workspace isolation, concurrent draft dedupe, input bounds, conversion dedupe,
key revocation and official MCP initialize/list/call against a local Next server.
It refuses non-local TEST_DATABASE_URL/TEST_BASE_URL and never calls Meta.
Check `npm audit --omit=dev` separately from tooling advisories; don't downgrade
Next/Prisma across major versions just because `npm audit fix --force` suggests it.
