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

## Endpoint

`POST /v1/batches`

Headers:

```text
Authorization: Bearer <project ingestion key>
Content-Type: application/json
Content-Encoding: gzip
```

The API accepts at most 100 sessions, 100 events, and 512 KiB of decompressed
JSON per request. Events older than three days or more than ten minutes in the
future are rejected.

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

For local Studio testing, `src/server/TraceServer/LocalConfig.luau` contains the
local endpoint and development key. This file is gitignored.

Before publishing:

1. Deploy the ingestion API over HTTPS.
2. Change `Endpoint` in `src/server/TraceServer/Config.luau`.
3. Add the ingestion key to the Roblox experience Secrets Store with the name
   `TRACE_INGEST_KEY`.
4. Enable **Allow HTTP Requests** in Experience Settings > Security.

The committed configuration never contains the production ingestion key.
