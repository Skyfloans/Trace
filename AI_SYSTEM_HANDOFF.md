# Trace system handoff

Last updated: July 14, 2026

This document is the operational and architectural handoff for Trace. It is
intended for another GPT-5.6 Sol coding agent continuing work in Cursor.

## 1. Product summary

Trace is a Roblox observability product:

- Roblox clients and servers capture errors, warnings, sessions, and server-job
  lifecycle data.
- Roblox clients relay their logs to the Roblox server through a `RemoteEvent`.
- The Roblox server batches and gzip-compresses telemetry.
- A Fastify API authenticates and stores telemetry in PostgreSQL.
- A React portal reads grouped errors, occurrences, sessions, players, and
  server jobs through a separate authenticated read API.
- Detailed telemetry is retained for at least 24 hours; hourly aggregates are
  retained for three days.

The primary design goals are:

1. Cheap ingestion and storage.
2. Fast investigation-oriented reads.
3. Grouping repeated errors rather than displaying every occurrence.
4. Correct attribution to client session and server job.
5. No production secrets in source control or frontend bundles.

## 2. Repositories and important paths

### Backend, database, and Roblox SDK

Repository:

```text
/Users/dimitriantunes/Trace
https://github.com/Skyfloans/Trace
```

Main areas:

```text
api/                         Fastify + TypeScript API
database/migrations/         PostgreSQL migrations
src/server/TraceServer/      Roblox server SDK
src/client/                  Roblox client SDK
src/ReplicatedStorage/       Shared Roblox modules
default.project.json         Rojo project mapping
docker-compose.yml           Local PostgreSQL
```

The repository was deliberately restarted with clean Trace-only history.
The previous BreedAPet Git metadata was moved to:

```text
/Users/dimitriantunes/.Trace-breedapet-git-backup
```

### Frontend portal

```text
/Users/dimitriantunes/Trace/portal
```

The portal now belongs to the main Trace Git repository and deploys as a second
Railway service with root directory `/portal` and config file path
`/portal/railway.json`. The former
`/Users/dimitriantunes/Trace_Portal` directory remains only as a local safety
copy and is not the canonical deployment source.

Useful frontend documentation:

```text
/Users/dimitriantunes/Trace/portal/DESIGN.md
/Users/dimitriantunes/Trace/api/READ_API.md
```

## 3. Production infrastructure

### API

Public production URL:

```text
https://api.tracestack.gg
```

Railway provider URL (retain for deployment diagnostics, not public setup):

```text
https://trace-production-c9d4.up.railway.app
```

Health check:

```text
GET https://api.tracestack.gg/health
```

Expected body:

```json
{"status":"ok"}
```

Railway deployment configuration:

```text
GitHub repository: Skyfloans/Trace
Root directory: /api
Build command: npm run build
Start command: npm start
```

Required Railway variables:

```text
DATABASE_URL=<Neon pooled PostgreSQL connection string with sslmode=require>
HOST=0.0.0.0
WEB_ORIGIN=https://tracestack.gg
ROBLOX_OAUTH_REDIRECT_URI=https://api.tracestack.gg/v1/auth/roblox/callback
LOG_LEVEL=info
```

Do not manually set `PORT`; Railway supplies it.

The production CORS origin is the exact portal origin above, without a trailing
slash. Keep localhost values only in local development environments.

### Database

Production PostgreSQL is hosted on Neon. The API must use the pooled connection
string.

Applied migrations:

```text
database/migrations/001_initial_schema.sql
database/migrations/002_ingestion_api.sql
database/migrations/003_read_api.sql
database/migrations/004_compact_occurrences.sql
database/migrations/005_tiered_retention.sql
database/migrations/006_feedback.sql
database/migrations/007_feedback_length.sql
database/migrations/008_roblox_oauth_and_project_management.sql
```

Apply them once, in order, to a new database. They are normal sequential
migrations, not repeatedly idempotent setup scripts.

Neon Auth is not used. Trace owns its `users`, `project_memberships`,
`web_sessions`, Roblox sign-in flow, ingestion verification, and invitation
tables.

New games no longer require an OAuth universe claim. Linking immediately
creates a project and ingestion key in a pending state. Each authenticated
batch must have a `job.universeId` matching the linked universe; batches from
any other universe are rejected. A project is considered verified once its
first matching job is stored.

### Roblox live configuration

Current uncommitted SDK configuration:

```text
Endpoint: https://api.tracestack.gg
Experience secret name: TraceKey
```

The Roblox experience secret value is a project-scoped `tr_ingest_...` key.
Never place the value in this document, committed Luau, or a frontend bundle.

The secret's allowed domain should be:

```text
api.tracestack.gg
```

Roblox must also have **Allow HTTP Requests** enabled.

`src/server/TraceServer/LocalConfig.luau` is gitignored and contains local
development settings. Never commit or print its key. Live servers do not load
`LocalConfig`; it is only checked when `RunService:IsStudio()`.

## 4. Current Git and deployment state

The initial clean repository commit was:

```text
92808fb Initialize Trace telemetry platform
```

The following work is currently uncommitted in `/Users/dimitriantunes/Trace`:

```text
M  api/src/read/auth.ts
M  api/src/read/index.ts
M  api/src/read/sessions-logs.ts
M  api/test/read-api.test.ts
M  src/server/TraceServer/Config.luau
?? api/src/read/roblox.ts
?? .codex/
```

Review `.codex/` before deciding whether it belongs in the repository.

The uncommitted backend work includes:

- Fifteen-second in-process caching and in-flight deduplication for valid web
  sessions and project membership checks.
- Optional empty player search that returns recent retained players.
- Roblox game metadata and player headshot proxy routes with one-hour caches.
- A batched player-headshot route accepting up to 50 IDs.
- Tests for auth caching and batched headshots.
- The production Roblox endpoint and `TraceKey` secret name.

The recent backend performance changes are not deployed until they are
committed and pushed.

The portal source is versioned in:

```text
portal/src/api.ts
portal/src/TraceApp.tsx
```

Those changes include:

- A 30-second shared resource cache.
- In-flight request deduplication across React mounts.
- Minute-rounded time windows so URLs and HTTP caches can be reused.
- Batched player-avatar loading.
- Cached grouped Logs page navigation.
- Keeping loaded data visible during background refreshes.

The production API currently returns `404` for the new batched-headshots route
until the backend is deployed. The development frontend has an individual
headshot fallback for this situation.

## 5. Database model

### `projects`

One row per integrated Roblox game/project.

Important fields:

- `id`
- `name`
- `roblox_universe_id`
- `icon_url`

The ingestion API key determines the project. The Roblox universe ID is also
learned from ingestion and stored if missing.

### `project_api_keys`

Stores only SHA-256 hashes of ingestion keys.

- Keys are project-scoped.
- Keys can be revoked.
- Plaintext keys must only be shown once at creation.
- Ingestion keys cannot authenticate read endpoints.

### `jobs`

One row per Roblox server instance.

Stores:

- Trace job UUID
- Roblox `game.JobId`
- project
- place and universe information
- release/place version
- region when available
- `started_at`, `last_seen_at`, `ended_at`

### `sessions`

One row per player session.

Stores:

- session UUID
- project and job
- Roblox user ID as a PostgreSQL `BIGINT`, returned to JSON as a string
- username and display name
- device/platform
- `started_at`, `last_seen_at`, `ended_at`
- end reason

### `error_groups`

Stores the identity of a grouped event:

- SHA-256 fingerprint
- client/server side
- severity
- normalized message
- normalized stack
- source script
- first/last seen
- total occurrence count

### `occurrences`

Stores individual event evidence:

- occurrence UUID
- project, group, job, and optional session
- event timestamp and received timestamp
- last event timestamp and repeat count for a short-window aggregate
- original message and stack
- context JSON

It is partitioned by `occurred_at` for cheap whole-partition raw cleanup.

### Website authorization

```text
users
project_memberships
web_sessions
```

Read tokens are opaque values. Only their SHA-256 hashes are stored in
`web_sessions`.

## 6. Retention and maintenance

The API starts by running:

```sql
SELECT ensure_occurrence_partitions(3);
SELECT purge_expired_trace_data();
```

It repeats maintenance hourly.

Occurrence partitions are created from three days in the past through three
days ahead. Before an expired raw partition is dropped, migration 005 compacts
its counts into hourly rollups retained for three days.

The ingestion API rejects events:

- Older than 24 hours.
- More than ten minutes in the future.

## 7. Roblox SDK flow

### Shared protocol

```text
src/ReplicatedStorage/TraceShared/Protocol.luau
```

Important limits:

```text
Remote name: TraceClientLog
Message: 4,000 characters
Stack: 16,000 characters
Source script: 512 characters
Client rate limit: 30 events per 10 seconds per player
```

### Client

```text
src/client/TraceClient.client.luau
```

The client:

- Hooks `ScriptContext.Error`.
- Hooks `LogService.MessageOut`.
- Uses the shared `LogCollector`.
- Detects a rough device category.
- Combines identical events for five seconds and sends sanitized aggregates to
  the server `RemoteEvent`.

Clients do not call the external API directly.

### Server

```text
src/server/TraceServer/init.server.luau
```

The server:

- Creates the `RemoteEvent` if needed.
- Creates player sessions on join.
- Updates sessions from client telemetry.
- Ends sessions on player removal.
- Captures server logs.
- Adds server events without a session ID.
- Updates active sessions every 60 seconds.
- Marks sessions and jobs ended during `BindToClose`.
- Forces remaining batches to flush during shutdown.

### Batcher

```text
src/server/TraceServer/Batcher.luau
```

Current behavior:

```text
Flush interval: 5 seconds
Event aggregation window: 60 seconds
Heartbeat interval: configurable per game; 300 seconds by default
Maximum events per batch: 100
Maximum uncompressed JSON per SDK batch: approximately 256 KiB
Maximum sessions per batch: 100
Maximum queued events: 1,000
Compression: gzip through HttpService.RequestAsync
Retry backoff: exponential, capped at 60 seconds
Shutdown flush: up to 20 batches
```

Identical events for the same client session or server job are combined during
a 60-second event window while lifecycle updates remain on a five-second
transport cadence. One row retains a representative full stack plus
`repeatCount`, `occurredAt`, and `lastOccurredAt`. Session starts and events are
normally sent within about five seconds. Session
and job `lastSeenAt` values are refreshed while active. Session end data is sent
when the player leaves or the server closes.

## 8. Ingestion API

Entry points:

```text
api/src/server.ts
api/src/app.ts
```

Endpoint:

```text
POST /v1/batches
Authorization: Bearer <project ingestion key>
Content-Type: application/json
Content-Encoding: gzip
```

Limits:

```text
512 KiB decompressed body
100 sessions per batch
100 events per batch
120 requests/minute per project key and Roblox server job
```

Ingestion is transactional:

1. Resolve project from hashed API key.
2. Upsert server job.
3. Bulk-upsert session updates with one set-based query.
4. Normalize and fingerprint events.
5. Bulk-upsert distinct error groups.
6. Bulk-insert idempotent compact occurrences.
7. Increment group counters by newly inserted logical repeat counts.

Occurrence event UUIDs make retried batches idempotent.

Valid ingestion-key lookups use a 15-second in-process cache with in-flight
deduplication. Rate limiting is per Roblox server job; the former project-wide
bucket would reject heartbeats once a project exceeded roughly 120 live jobs.

## 9. Fingerprinting and deduplication

Implementation:

```text
api/src/fingerprint.ts
```

Normalization currently replaces:

- Roblox job ID
- player usernames present in the batch
- player IDs present in the batch
- UUIDs
- ISO timestamps
- memory addresses

Current fingerprint identity:

```text
source + severity + normalized source script + normalized message
```

The full normalized stack is intentionally excluded from identity because line
numbers and caller details split visually identical bugs. A representative full
stack remains on each compact occurrence for investigation. Groups created by
the former fingerprint naturally expire after three days.

## 10. Error-capture coverage and known gaps

Trace captures most uncaught Luau errors, including typical `error()`,
`assert()`, event callback, coroutine, and `task.spawn` failures.

It does not guarantee every Roblox-generated error.

Known gaps:

1. `LogCollector` currently ignores every `Enum.MessageType.MessageError` to
   avoid duplicates with `ScriptContext.Error`. Engine/service errors emitted
   only through `LogService` may therefore be lost.
2. When the 1,000-event queue is full, `Batcher:AddEvent` returns `false`, but
   the caller does not persist or report a dropped-event metric.
3. Errors before Trace finishes initializing cannot be captured.
4. Errors handled by game code through `pcall`/`xpcall` are not globally
   observable unless reported manually.
5. A hard crash may not execute `BindToClose`.
6. Secret authorization is loaded once when the batcher starts; a temporary
   secret failure is not retried.
7. Warning stack reconstruction tracks one active warning stack and can
   misassociate highly concurrent warning output.
8. Messages beginning with `[Trace]` are intentionally filtered to prevent
   recursive internal telemetry, but legitimate game messages with that prefix
   would also be hidden.

Recommended first fix: capture `MessageError` as a delayed fallback and
deduplicate it against recent `ScriptContext.Error` events.

`CaptureOutputMessages` is currently `false`, so ordinary `print()` output is
not stored. This is intentional for cost.

## 11. Read API

Documentation:

```text
api/READ_API.md
```

Main route families:

```text
GET /v1/projects
GET /v1/projects/:projectId
GET /v1/projects/:projectId/activity
GET /v1/projects/:projectId/errors
GET /v1/projects/:projectId/errors/:fingerprint
GET /v1/projects/:projectId/errors/:fingerprint/occurrences
GET /v1/projects/:projectId/logs
GET /v1/projects/:projectId/logs/:occurrenceId
GET /v1/projects/:projectId/players
GET /v1/projects/:projectId/players/:robloxUserId
GET /v1/projects/:projectId/players/:robloxUserId/sessions
GET /v1/projects/:projectId/sessions/:sessionId
GET /v1/projects/:projectId/sessions/:sessionId/timeline
GET /v1/projects/:projectId/server-jobs
GET /v1/projects/:projectId/server-jobs/:serverJobId
GET /v1/projects/:projectId/server-jobs/:serverJobId/logs
GET /v1/projects/:projectId/server-jobs/:serverJobId/sessions
```

Uncommitted additions:

```text
GET /v1/projects/:projectId/roblox-metadata
GET /v1/projects/:projectId/player-headshots?ids=...
GET /v1/projects/:projectId/players/:robloxUserId/headshot
```

Read behavior:

- Opaque cursor pagination, not offsets.
- Detailed occurrence data is guaranteed for at least 24 hours; hourly
  activity totals remain available for three days.
- UTC ISO timestamps.
- Roblox identifiers returned as strings.
- Gzip responses.
- `X-Request-Id`.
- Short private `Cache-Control` and `stale-while-revalidate`.
- Project membership enforced on every project-scoped route.

Session timelines include direct client events. Server events are correlated
only when they occur in the same job and within two seconds of a client event.
Those fallback events are marked low-confidence.

## 12. Read authentication

An ingestion key cannot read website data.

The read API accepts:

```text
Authorization: Bearer <opaque web session token>
```

or:

```text
Cookie: trace_session=<opaque token>
```

Production cookies should be:

```text
HttpOnly
Secure
SameSite=Lax
```

Browser requests must use:

```ts
credentials: "include"
```

Production login, account provisioning, session creation, and logout are not
implemented yet.

A temporary development user was created:

```text
email: dev@trace.local
```

The temporary read token was created with a seven-day expiration. Its plaintext
value must remain only in a local ignored frontend environment file. It may
already be expired when this document is read; create a new session if needed.

Cross-origin cookie warning: `SameSite=Lax` will not authenticate fetches when
the portal and API are on unrelated sites such as `vercel.app` and
`railway.app`. Trace uses the same-site production setup:

```text
tracestack.gg
api.tracestack.gg
```

Otherwise evaluate `SameSite=None; Secure` plus proper CSRF protection.

## 13. Frontend portal behavior

Primary files:

```text
portal/src/TraceApp.tsx
portal/src/api.ts
portal/src/App.css
portal/src/index.css
portal/vite.config.ts
```

Stack:

```text
React 19
Vite 8
TypeScript
lucide-react
```

The portal currently uses internal page state rather than a router.

Main views:

- Overview/dashboard
- Player search and sessions
- Grouped logs
- Session timeline
- Grouped error detail and occurrences
- Server job detail

The intended UX is grouped errors with occurrence counts. Raw occurrences are
opened only when investigating a group/session/job.

Local development:

```sh
cd /Users/dimitriantunes/Trace/portal
npm install
npm run dev
```

The Vite proxy reads the temporary development read token server-side and does
not expose it to browser source. Do not put a read token in a `VITE_...`
variable because Vite variables are bundled into client JavaScript.

## 14. Performance work and measurements

Measured before the recent local optimization:

```text
GET /v1/projects: approximately 302 ms
GET /activity: approximately 370 ms
GET /errors: approximately 799 ms
Roblox metadata: approximately 1.17 s
Player page: approximately 20 API headshot calls plus 20 Roblox calls
```

Measured during local frontend verification:

```text
GET /errors: approximately 360 ms on a warm request
Player headshots: reduced to one batch request after backend deployment
Recently visited pages: served immediately from the 30-second client cache
```

Validation completed after the changes:

```text
API: 9 tests passing
API: TypeScript typecheck passing
Portal: production build passing
Portal: oxlint passing
IDE diagnostics: no errors
Portal bundle: approximately 239 KB JS / 74 KB gzip
```

The most important future read bottlenecks are database aggregation, not the
bundle:

1. `/errors` scans raw occurrences and performs counts/distinct counts for every
   first-page request.
2. `/activity` scans raw occurrences and groups with `date_trunc`.
3. Session lists run a per-session lateral query for error/warning counts.
4. Recent-player listing needs an index on
   `(project_id, player_id, last_seen_at DESC, id DESC)` or a player summary
   table.
5. Session/job pages can request up to 500 full events and should progressively
   paginate or virtualize.

Recommended structural read optimization:

- Add hourly error/activity rollup tables.
- Add maintained session error/warning counters.
- Add a combined dashboard endpoint that authenticates once and runs project,
  grouped-error, and activity queries concurrently.
- Use `EXPLAIN (ANALYZE, BUFFERS)` on production-shaped test data before and
  after changing SQL.

## 15. Observed production volume and cost model

Observed Nuke RNG sample:

```text
Approximately 15 active players
789 occurrences in about 59 minutes
778 client events
11 server events
Approximately 53.5 events per player-hour
91.3% of events came from four noisy grouped rows
```

The sample is intentionally a worst-case/noisy workload, not a healthy target.

Linear projections at that unchanged rate:

```text
1,000 CCU: approximately 1.28 million events/day
10,000 CCU: approximately 12.8 million events/day
```

The deployed ingestion repository executes roughly three sequential SQL
statements per event, plus auth, transaction, job, and session queries. The
local compact-ingestion work replaces those event writes and session updates
with set-based batch queries but is not deployed yet.

Conservative unoptimized/partially optimized estimates discussed:

```text
1,000 CCU: roughly $100–220/month
10,000 CCU: roughly $380–850/month
```

An optimized managed target around 10,000 CCU may be roughly $40–100/month,
depending on actual healthy event volume, by doing all of the following:

Implemented locally but not deployed yet:

1. Aggregate repeated events in Roblox into
   `{fingerprint, repeatCount, firstSeen, lastSeen}`.
2. Store one representative full stack instead of every repeated stack.
3. Bulk-ingest a batch with a few set-based SQL statements instead of three
   sequential statements per event.

Implemented locally but not deployed yet:

4. Five-minute configurable session/job heartbeats, with join and leave still
   delivered independently on the five-second transport cadence.
5. Daily raw partitions retained for at least 24 hours, compacted into hourly
   rollups retained for three days before the raw partition is dropped.

Still intentionally unchanged or deferred:

6. Fix or suppress known noisy game warnings.

Current Neon Launch pricing checked July 13, 2026:

```text
$0.106 per CU-hour
$0.35 per GB-month
```

Current Railway reference rates:

```text
$20 per vCPU-month
$10 per GB RAM-month
$0.05 per GB outbound transfer
```

Treat all cost totals as models, not guarantees. Measure actual Neon CU usage,
physical database size, Railway CPU/RAM, and compressed bytes per event.

## 16. Known production data observations

Nuke RNG has a project row, project-scoped ingestion key, and temporary
developer membership. The key was placed in the Nuke RNG experience secret
named `TraceKey`.

Observed high-volume groups included:

- Repeated infinite-yield warnings.
- A repeated client error:
  `Orienter is not a valid member of Model ...`
- Part cache warnings.
- Experience event warnings.
- Experience notification service failures.

The repeated infinite-yield warning appeared as two identical client groups due
to the full-stack fingerprint issue.

## 17. Tests intentionally retained

These scripts were explicitly kept at the user's request:

```text
src/client/Test.client.luau
src/server/test.server.luau
```

They intentionally generate test output/errors. Do not remove them without
asking. Be aware that they can generate production telemetry if published in
the live place.

## 18. Local development and verification

### Start PostgreSQL

```sh
cd /Users/dimitriantunes/Trace
docker compose up -d
```

### Start API

```sh
cd /Users/dimitriantunes/Trace/api
npm install
npm run dev
```

### API verification

```sh
npm test
npm run typecheck
npm run build
```

### Portal verification

```sh
cd /Users/dimitriantunes/Trace/portal
npm install
npm run build
npm run lint
```

### Roblox verification

```sh
cd /Users/dimitriantunes/Trace
stylua --check src
rojo build default.project.json -o /tmp/trace-validation.rbxlx
```

Rojo output must use a Roblox-supported extension such as `.rbxlx`; `/dev/null`
will be rejected.

## 19. Secret-handling rules

Never commit or print:

- `api/.env`
- `src/server/TraceServer/LocalConfig.luau`
- Any `tr_ingest_...` key
- Any temporary read token
- Neon connection strings
- Railway secret values
- Roblox Experience Secret values

Expected ignored local files include:

```text
.env
.env.*
LocalConfig.luau
.DS_Store
.cursor/
.impeccable/
node_modules/
dist/
```

`.env.example` is intentionally committed.

## 20. Recommended continuation order

1. Review all current uncommitted changes and do not overwrite unrelated user
   work.
2. Verify `api/src/read/roblox.ts` and auth caching one more time.
3. Commit and push backend changes only after explicit user approval. Railway
   should then redeploy automatically.
4. Verify:
   - `/health`
   - player list without a query
   - batch headshots
   - dashboard/error latency
5. Deploy `portal/` as a second Railway service with root directory `/portal`
   and config file path `/portal/railway.json`.
6. Attach `https://tracestack.gg` to the portal service and confirm:
   - frontend API base URL is `https://api.tracestack.gg`
   - Railway `WEB_ORIGIN` is `https://tracestack.gg`
   - Railway `ROBLOX_OAUTH_REDIRECT_URI` is
     `https://api.tracestack.gg/v1/auth/roblox/callback`
7. Implement proper production login/session issuance/logout.
8. Apply migration 005 before deploying the second optimization pass.
9. Verify 60-second repeat aggregation and five-minute heartbeats against live
   traffic.
10. Audit production index usage after enough representative traffic exists.
11. Improve `MessageError` fallback capture and dropped-event metrics.
12. Ask before deleting the intentionally retained Roblox test scripts.

## 21. Existing documentation to trust

Use these as source contracts rather than reconstructing behavior from UI
assumptions:

```text
api/README.md
api/READ_API.md
portal/DESIGN.md
```

When documentation and current code differ, verify current code and update the
documentation as part of the same change.
