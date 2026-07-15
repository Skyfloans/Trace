import { iso } from "./http.js";

type AnyRow = Record<string, unknown>;

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function playerFromRow(row: AnyRow) {
  if (row.player_id === null || row.player_id === undefined) {
    return null;
  }

  const username = nullableString(row.player_name) ?? String(row.player_id);
  return {
    robloxUserId: String(row.player_id),
    username,
    displayName: nullableString(row.player_display_name) ?? username,
    avatarUrl: nullableString(row.avatar_url),
  };
}

export function mapOccurrence(row: AnyRow) {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    occurredAt: iso(row.occurred_at as Date | string),
    lastOccurredAt: iso(row.last_occurred_at as Date | string),
    repeatCount: Number(row.repeat_count ?? 1),
    receivedAt: iso(row.received_at as Date | string),
    severity: String(row.severity),
    side: String(row.side),
    message: String(row.message),
    source: nullableString(row.source),
    stackTrace: nullableString(row.stack_trace),
    fingerprint: nullableString(row.fingerprint),
    serverJobId: String(row.server_job_id),
    sessionId: nullableString(row.session_id),
    player: playerFromRow(row),
    attributes: (row.attributes as Record<string, unknown> | null) ?? {},
  };
}

export function mapSession(row: AnyRow) {
  const endedAt = nullableString(row.ended_at);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    player: playerFromRow(row),
    serverJob: {
      id: String(row.job_id),
      robloxJobId: String(row.roblox_job_id),
      placeId: String(row.place_id),
      region: nullableString(row.region),
      startedAt: iso(row.job_started_at as Date | string),
      endedAt: row.job_ended_at
        ? iso(row.job_ended_at as Date | string)
        : null,
    },
    startedAt: iso(row.started_at as Date | string),
    endedAt: endedAt ? iso(endedAt) : null,
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined
        ? null
        : Number(row.duration_ms),
    device: nullableString(row.device),
    platform: nullableString(row.platform),
    errorCount: Number(row.error_count ?? 0),
    warningCount: Number(row.warning_count ?? 0),
  };
}

export const occurrenceSelect = `
  o.id,
  o.project_id,
  o.occurred_at,
  COALESCE(o.last_occurred_at, o.occurred_at) AS last_occurred_at,
  o.repeat_count,
  o.received_at,
  eg.level AS severity,
  eg.source AS side,
  COALESCE(o.original_message, eg.normalized_message) AS message,
  eg.source_script AS source,
  COALESCE(o.original_stack, eg.normalized_stack) AS stack_trace,
  eg.fingerprint,
  o.job_id AS server_job_id,
  o.session_id,
  s.player_id,
  s.player_name,
  s.player_display_name,
  s.avatar_url,
  o.context AS attributes
`;

export const sessionSelect = `
  s.id,
  s.project_id,
  s.player_id,
  s.player_name,
  s.player_display_name,
  s.avatar_url,
  s.started_at,
  s.ended_at,
  s.device,
  s.platform,
  EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.started_at)) * 1000 AS duration_ms,
  j.id AS job_id,
  j.roblox_job_id,
  j.place_id,
  j.region,
  j.started_at AS job_started_at,
  j.ended_at AS job_ended_at,
  COALESCE(ec.error_count, 0) AS error_count,
  COALESCE(ec.warning_count, 0) AS warning_count
`;

export const sessionCountJoin = `
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.level = 'error'), 0)::int AS error_count,
      COALESCE(SUM(o.repeat_count) FILTER (WHERE eg.level = 'warning'), 0)::int AS warning_count
    FROM occurrences o
    JOIN error_groups eg ON eg.id = o.group_id
    WHERE o.project_id = s.project_id
      AND o.session_id = s.id
  ) ec ON true
`;
