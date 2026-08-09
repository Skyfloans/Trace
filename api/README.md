# Trace ingestion API

Accepts authenticated telemetry batches from Roblox servers and stores them in
PostgreSQL. Request bodies may be normal JSON or gzip-compressed JSON.

The website-facing query contract is documented in [`READ_API.md`](READ_API.md).

## Run locally

Start PostgreSQL from the repository root, then start the API:

```sh
docker compose up -d
cd api
npm install
npm run dev
```

The local configuration is read from `api/.env`. Never commit that file or an
ingestion API key.

## Roblox account sign-in and game ownership

Trace uses the Roblox OAuth 2.0 authorization code flow with PKCE. Production
sign-in requests only `openid profile`. The optional place-access flow requests
`universe:read legacy-asset:manage` in addition to the identity scopes. The
first scope binds the grant to the selected experience; the second is the scope
Roblox's Open Cloud Asset Delivery endpoint currently declares for retrieving
the place asset.

Configure the OAuth app with:

```text
Identity scopes: openid, profile
Place access scopes: universe:read, legacy-asset:manage
Local redirect: http://localhost:5173/api/v1/auth/roblox/callback
Production redirect: https://api.tracestack.gg/v1/auth/roblox/callback
```

Production uses `tracestack.gg` for the portal and `api.tracestack.gg` for this
API. Because both hosts share the same registrable domain, the secure
`SameSite=Lax` session cookie remains same-site while the API keeps a strict
CORS origin. Keep the OAuth client secret only in the API environment:

```text
ROBLOX_OAUTH_CLIENT_ID=...
ROBLOX_OAUTH_CLIENT_SECRET=...
ROBLOX_OAUTH_REDIRECT_URI=...
ROBLOX_OAUTH_TOKEN_ENCRYPTION_KEY=...
```

Generate the token encryption key once with `openssl rand -base64 32`. Keep it
stable across deploys and back it up as a secret; rotating it without a
credential migration makes existing place grants unreadable. Access and
single-use rotating refresh tokens are encrypted with AES-256-GCM and bound to
their Trace project before storage. Plaintext tokens are never written to the
database or object store.

The production values are:

```text
WEB_ORIGIN=https://tracestack.gg
ROBLOX_OAUTH_REDIRECT_URI=https://api.tracestack.gg/v1/auth/roblox/callback
```

Roblox user IDs—not mutable usernames—are the account and invitation identity.
Each universe can belong to only one Trace project. Its owner may invite other
Roblox users as administrators, members, or viewers. Ingestion keys are stored
only as SHA-256 hashes and the plaintext value is returned once on creation or
rotation.

## Roblox place access and snapshots

Place access intentionally separates the Trace telemetry project from the
editable Roblox target. This lets the real Unbox ASMR project supply its bug
history while fixes are tested against duplicate universe `10587551620`.

Apply `database/migrations/025_roblox_place_access.sql` with the verified
one-off command below, configure the OAuth scopes above, and configure the
existing S3-compatible object store variables.

```bash
npm run migrate:roblox-place-access
```

Place snapshots use the same verified object store under
`roblox-places/<project UUID>/`; `ARCHIVE_ENABLED` does not need to be enabled,
but all `ARCHIVE_S3_*` connection values must be present.

While signed into Trace as a project owner or administrator, start the grant:

```text
GET /v1/auth/roblox/start
    ?intent=place_access
    &projectId=<Trace project UUID>
    &targetUniverseId=10587551620
```

Roblox returns to the existing OAuth callback. Trace verifies that the same
Roblox account completed the flow, verifies that the selected OAuth resources
contain the target universe, resolves its root place, and stores the encrypted
rotating grant. It does not change `projects.roblox_universe_id`; that remains
the telemetry source.

The management endpoints are:

```text
GET    /v1/manage/projects/:projectId/roblox-place-access
POST   /v1/manage/projects/:projectId/roblox-place-snapshots
DELETE /v1/manage/projects/:projectId/roblox-place-access
```

The snapshot POST refreshes OAuth under a database row lock when needed,
requests the current root-place asset from Roblox Open Cloud, validates the
temporary CDN host, enforces Roblox's 100 MB place-file limit, uploads the RBXL
with a SHA-256 checksum, and only then creates its database record. The OAuth
bearer token is never forwarded to the temporary CDN.

## Roblox Studio plugin pairing

Apply `database/migrations/026_roblox_plugin_pairing.sql` after migration 025:

```bash
npm run migrate:roblox-plugin-pairing
```

The Studio plugin creates a ten-minute request with the current Studio Roblox
user, universe, place, and a stable random install ID. Trace returns separate
high-entropy browser and client proofs. The signed-in website account must
match the asserted Roblox user and have an owner or admin membership on either
the source universe or the active place-access target universe.

After website approval, a two-digit code is bound to the request ID and client
proof, limited to five attempts, and never stored in plaintext. Successful
verification returns a random 90-day plugin credential. Only its SHA-256 hash
is stored in PostgreSQL; the credential is scoped to the approving user,
project, source universe, target universe, Studio place, and plugin install.
The plugin never receives the Roblox OAuth grant.

```text
POST /v1/plugin-auth/requests
GET  /v1/manage/plugin-auth/:browserToken
POST /v1/manage/plugin-auth/:browserToken/approve
POST /v1/plugin-auth/requests/:requestId/verify
GET  /v1/plugin-auth/session
POST /v1/plugin-auth/revoke
```

## Roblox Autofix reviews

Apply migration 027 after the place-access and plugin-pairing migrations:

```bash
npm run migrate:roblox-autofix
```

Apply migration 030 to enable the shared seven-day script-version history:

```bash
npm run migrate:roblox-autofix-history
```

Autofix is enabled by an active Studio plugin connection and a verified place
snapshot. The scheduler checks eligible projects immediately on startup and
every ten minutes. It fills only vacant review slots, so a project never has
more than 15 unresolved queued, processing, ready, or conflicted requests.
Selection is ordered critical, high, medium, then low, with impact count and
recency as tie-breakers. Requests are deduplicated by their normalized AI error
family, including slightly different messages for the same underlying issue.
An active request blocks another in that family, and an accepted fix suppresses
the family for seven days.

The single-concurrency worker downloads and checksum-verifies the RBXL, reads
its LZ4- or ZSTD-compressed Script, LocalScript, and ModuleScript sources,
selects a bounded set of relevant scripts, and makes one OpenRouter request per
bug. Each request has a 45-second timeout, a 5,000-token output ceiling, and the
whole run has a 120,000 input / 45,000 output token budget. Results below 0.80
confidence, ambiguous source matches, oversized scripts, invented paths,
unchanged source, or more than five edited scripts are recorded as `unable`
without retry. Autofix defaults to `openai/gpt-5.6-luna` through
`AUTOFIX_MODEL`, which can be upgraded independently of the classification
model later.

To retry requests from the pre-ZSTD parser failure once, while preserving the
15-request ceiling:

```bash
npm run retry:roblox-zstd-autofix
```

The plugin-scoped review contract is:

```text
GET  /v1/plugin-autofix/proposals
POST /v1/plugin-autofix/runs
GET  /v1/plugin-autofix/proposals/:proposalId
POST /v1/plugin-autofix/proposals/:proposalId/review
GET  /v1/plugin-autofix/history
GET  /v1/plugin-autofix/history/:historyId
POST /v1/plugin-autofix/history/:historyId/restored
```

Accepted proposals are still not published by the API. Studio applies the
reviewed hunks against its current editor source and reports a conflict without
changing any script when a hunk no longer matches.

## AI classification

Trace classifies normalized display-level errors and individual feedback in a
background queue. OpenRouter is never called inside an ingestion transaction.
Repeated occurrences and raw message variants therefore reuse the one
classification attached to their normalized display group.

Configure the API service with:

```text
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openai/gpt-5.4-nano
AI_CLASSIFICATION_BATCH_SIZE=32
AI_CLASSIFICATION_CONCURRENCY=3
```

The error rubric is explicitly Roblox/Luau-aware. It receives normalized
message, severity, client/server side, and source script, but no player identity
or project name. New error/warning groups and feedback are prioritized over the
historical queue. Apply migrations 019 and 020 before deploying the worker,
then run `api/scripts/enqueue-ai-classification-backfill.mjs` to enqueue active
three-day error/warning groups and retained feedback.

## Endpoint

`POST /v1/batches`

Headers:

```text
Authorization: Bearer <project ingestion key>
Content-Type: application/json
Content-Encoding: gzip
```

The API accepts at most 100 sessions, 100 events, and 512 KiB of decompressed
JSON per request. Events older than 24 hours or more than ten minutes in the
future are rejected.

Valid ingestion-key lookups are cached in-process for 15 seconds. Rate limits
are isolated per authenticated project key and Roblox server job at 120
requests per minute, so separate live servers do not consume one shared bucket.

`events` may be empty so join, leave, heartbeat, and job lifecycle updates can
be recorded even when no errors occur.

```json
{
  "version": 1,
  "batchId": "a UUID",
  "job": {
    "id": "a UUID generated once when the server starts",
    "robloxJobId": "game.JobId",
    "placeId": "123456",
    "release": "optional release name",
    "startedAt": "2026-07-13T23:00:00.000Z",
    "lastSeenAt": "2026-07-13T23:01:00.000Z"
  },
  "sessions": [
    {
      "id": "a UUID generated when the player joins",
      "playerId": "12345",
      "playerName": "PlayerName",
      "startedAt": "2026-07-13T23:00:10.000Z",
      "lastSeenAt": "2026-07-13T23:01:00.000Z"
    }
  ],
  "events": [
    {
      "id": "a unique UUID",
      "sessionId": "required for client events",
      "occurredAt": "2026-07-13T23:00:30.000Z",
      "lastOccurredAt": "2026-07-13T23:00:34.000Z",
      "repeatCount": 47,
      "source": "client",
      "level": "error",
      "message": "PlayerName is not a valid member of Workspace",
      "stack": "Script Test, Line 10",
      "sourceScript": "Players.PlayerName.PlayerScripts.Test",
      "context": {
        "device": "mobile"
      }
    }
  ]
}
```

Server events omit `sessionId`; they are associated with the server job.

`repeatCount` defaults to `1`. Roblox clients combine identical events for five
seconds before relaying them to the Roblox server. The server keeps lifecycle
delivery on a five-second cadence but holds identical errors in configurable
60-second buckets. Leaving finalizes that player's open buckets, and server
shutdown flushes every remaining bucket. The first bucket carries a full stack;
later buckets for the same exact error carry counts and timestamps only. This
keeps grouped counts and session/job attribution while avoiding one database
row per repeat. A repeat aggregate is capped at 10,000 events. The SDK also
caps uncompressed batches at approximately 256 KiB before gzip, safely below
the API's 512 KiB decompressed limit.

Ingestion uses set-based group, occurrence, and session writes. Retried
aggregate UUIDs remain idempotent, and accepted counts represent logical events
rather than physical occurrence rows.

Migration 004 is rolling-deploy compatible: the old API can continue writing
one-count rows while Railway replaces it, and reads treat a temporarily absent
`lastOccurredAt` as equal to `occurredAt`.

## Roblox transport compression

JSON is already the serialization format. Let `HttpService` gzip the complete
batch instead of compressing individual fields or base64-encoding compressed
data:

```luau
local response = HttpService:RequestAsync({
    Url = endpoint .. "/v1/batches",
    Method = "POST",
    Headers = {
        ["Authorization"] = "Bearer " .. ingestionKey,
        ["Content-Type"] = "application/json",
    },
    Body = HttpService:JSONEncode(batch),
    Compress = Enum.HttpCompression.Gzip,
})
```

Batching usually saves more bandwidth and request overhead than compression
alone. Small individual events should not be sent as separate requests.

## Roblox configuration

For local Studio testing, `src/ReplicatedStorage/Trace/Server/LocalConfig.luau` contains the
local endpoint and development key. This file is gitignored.

Before publishing:

1. Deploy the ingestion API over HTTPS at `https://api.tracestack.gg`.
2. Confirm `Endpoint` in `src/ReplicatedStorage/Trace/Server/Config.luau` uses that origin.
3. Add the ingestion key to the Roblox experience Secrets Store with the name
   `TraceKey`.
4. Restrict the secret's allowed domain to `api.tracestack.gg`.
5. Enable **Allow HTTP Requests** in Experience Settings > Security.

The committed configuration never contains the production ingestion key.

Build the public Studio download from the production-only project manifest:

```sh
rojo build distribution.project.json -o Trace.rbxm
```

Do not build the public model from `default.project.json`; the development
project can see ignored Studio-only files such as `LocalConfig.luau`.

The public model is one `Trace` folder. Place it in `ReplicatedStorage`, then
create this `Script` in `ServerScriptService`:

```luau
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Trace = ReplicatedStorage.Trace

local Server = require(Trace.Server.Main)
Server.Start()
```

Create this `LocalScript` in `StarterPlayerScripts`:

```luau
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Trace = ReplicatedStorage.Trace

local Client = require(Trace.Client.Main)
Client.Start()
```

Those bootstrap scripts remain stable. Updating the SDK only requires replacing
the `ReplicatedStorage.Trace` folder.

`Config.luau` exposes the main per-game cost controls:

```luau
FlushIntervalSeconds = 5,             -- join/leave and ready-batch delivery
EventAggregationWindowSeconds = 60,  -- identical error bucket size
HeartbeatIntervalSeconds = 300,      -- set to 60 for higher-fidelity games
IgnoredMessagePrefixes = {           -- discard known noise before upload
    "Data loaded for player ",
},
```

Use `IgnoredMessagePrefixes` only for messages that are known to be
non-actionable. A matching client or server message is discarded in the game
server before it consumes ingestion bandwidth or database storage. Ordinary
diagnostic output should use `print()` instead of `warn()` while
`CaptureOutputMessages` is disabled.

Server warnings and errors that reference exactly one active player's username
or user ID are automatically linked to that session. Trace normalizes the
identity before fingerprinting, so messages such as `Failed for player Alice`
and `Failed for player Bob` appear as one grouped issue while retaining their
individual session evidence.

Join and leave are independent of the heartbeat interval, so a player who
leaves after one minute is still recorded immediately. The heartbeat mainly
improves liveness estimates when a client or server disappears without a clean
leave event.

## Tiered retention

Migration 005 keeps detailed occurrence partitions for at least 24 hours (and
at most roughly 48 hours because partitions are dropped by whole UTC day).
Before a partition is dropped, counts are compacted into hourly project/error
rollups retained for three days. Activity charts combine raw and rolled-up
counts without expanding repeats. Messages, stacks, sessions, and individual
occurrence inspection remain raw-data features.

Migration 009 makes those hourly rows a live read model. Ingestion updates the
raw occurrence and its hourly total in the same transaction. Grouped-log and
activity reads aggregate hourly totals for complete hours and touch raw
occurrences only at partial-hour edges. Apply it safely in this order:

1. Deploy the API code that dual-writes hourly totals.
2. Apply `database/migrations/009_live_error_group_rollups.sql` once. Its
   transaction briefly holds occurrence writes while it backfills and then
   publishes the readiness marker atomically.
3. Confirm the `live_error_group_rollups_v1` row exists in
   `trace_read_model_state`.

Until the marker exists, the API automatically uses raw-data queries, so the
code deployment and database cutover do not have to occur simultaneously.
