# Trace read API

The read API is served by the same Fastify process as ingestion, but uses a
separate authentication table and token type. An ingestion key cannot
authenticate any read endpoint.

## Local frontend configuration

- Base URL: `http://127.0.0.1:3000`
- Allowed web origin: `http://localhost:5173`
- Local read token: `TRACE_DEV_READ_TOKEN` in the gitignored `api/.env`
- Header during local development:

```text
Authorization: Bearer <TRACE_DEV_READ_TOKEN>
```

Production website authentication should set the same opaque token in an
`HttpOnly`, `Secure`, `SameSite=Lax` cookie named `trace_session`. Login and
account provisioning are intentionally separate from this read-only API.

## Response behavior

- All timestamps are UTC ISO 8601 strings.
- All Roblox identifiers are JSON strings.
- List endpoints use opaque keyset cursors, never offsets.
- High-volume queries default to the last 24 hours. Detailed occurrence data is
  retained for at least 24 hours; compact hourly activity totals remain
  available for three days.
- Responses include `X-Request-Id`.
- Read responses use gzip when supported.
- Cacheable private responses include short `max-age` and
  `stale-while-revalidate` directives.

Errors use:

```json
{
  "error": {
    "code": "invalid_time_range",
    "message": "`from` must be a valid timestamp earlier than `to`.",
    "requestId": "req-123"
  }
}
```

## Routes

```text
GET /v1/projects
GET /v1/projects/{projectId}

GET /v1/projects/{projectId}/activity
GET /v1/projects/{projectId}/errors
GET /v1/projects/{projectId}/errors/{fingerprint}
GET /v1/projects/{projectId}/errors/{fingerprint}/occurrences

GET /v1/projects/{projectId}/logs
GET /v1/projects/{projectId}/logs/{occurrenceId}

GET /v1/projects/{projectId}/players
GET /v1/projects/{projectId}/players/{robloxUserId}
GET /v1/projects/{projectId}/players/{robloxUserId}/sessions
GET /v1/projects/{projectId}/sessions/{sessionId}
GET /v1/projects/{projectId}/sessions/{sessionId}/timeline

GET /v1/projects/{projectId}/server-jobs
GET /v1/projects/{projectId}/server-jobs/{serverJobId}
GET /v1/projects/{projectId}/server-jobs/{serverJobId}/logs
GET /v1/projects/{projectId}/server-jobs/{serverJobId}/sessions
```

Occurrence objects include `repeatCount` and `lastOccurredAt`. `occurredAt` is
the first event represented by that sampled row. Group, activity, session, and
job counts sum `repeatCount`, so compact storage does not change displayed
event totals. Occurrence lists return sampled aggregate rows rather than
expanding repeated events back into duplicate JSON objects.

Activity buckets older than raw retention are reconstructed from hourly
rollups. Minute buckets in that older period place the hour's total at the
start of the hour because per-minute detail has intentionally expired.

Query parameters and response shapes follow
`Trace_Portal/READ_API_HANDOFF.md`.

## Session timeline correlation

Client events are attached directly through `sessionId`. Server events are
included only when they occur in the same job and within two seconds of a
client event from the selected session. These fallback events include:

```json
{
  "correlation": {
    "kind": "time_window",
    "confidence": "low",
    "relatedOccurrenceId": "uuid",
    "deltaMs": 126
  }
}
```

The `around`, `before`, and `after` parameters restore stable selected-event
links without downloading an entire session.
