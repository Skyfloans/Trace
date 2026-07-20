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

Website authentication sets an opaque token in an `HttpOnly`, `Secure`,
`SameSite=Lax` cookie named `trace_session`. When both the browser cookie and a
development bearer token are present, the browser cookie takes precedence so
the signed-in Roblox user's identity and project memberships are used.

## Response behavior

- All timestamps are UTC ISO 8601 strings.
- All Roblox identifiers are JSON strings.
- List endpoints use opaque keyset cursors, never offsets.
- Grouped error pages accept `sort=count` (the default) or `sort=recent`.
  After migration 009, list totals come from hourly summaries plus raw events
  at partial-hour edges. The list intentionally omits affected-player,
  affected-server, and latest-occurrence fields; those exact values are loaded
  only after opening a group. Before migration 009 is ready, recent pages use
  a bounded raw-data fallback.
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
event totals. Session counts combine events attached directly to the player
session with server events from the same job that occurred during that
session's time window. Occurrence lists return sampled aggregate rows rather
than expanding repeated events back into duplicate JSON objects.

Activity and grouped-error queries use hourly rollups for complete hours and
raw occurrences only for partial-hour edges. Minute buckets place an hourly
summary at the start of that hour. The portal aligns its standard 8-hour,
24-hour, and 3-day ranges to hour boundaries so those pages stay on the summary
path.

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
