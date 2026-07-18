import { promisify } from "node:util";
import { gunzipSync, gzip as gzipCallback } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import type { ArchiveStorage } from "./archive-storage.js";

const ARCHIVE_PAGE_SIZE = 2_500;
const PARTITION_PATTERN = /^occurrences_(\d{4})_(\d{2})_(\d{2})$/;
const gzip = promisify(gzipCallback);

export type ArchivedOccurrence = {
  attributes: Record<string, unknown>;
  fingerprint: string;
  id: string;
  lastOccurredAt: string;
  message: string;
  occurredAt: string;
  player: {
    avatarUrl: string | null;
    displayName: string;
    robloxUserId: string;
    username: string;
  } | null;
  projectId: string;
  receivedAt: string;
  repeatCount: number;
  serverJobId: string;
  sessionId: string | null;
  severity: string;
  side: string;
  source: string | null;
  stackTrace: string | null;
};

type ArchiveChunk = {
  bytes: number;
  count: number;
  firstOccurredAt: string;
  jobId: string;
  key: string;
  lastOccurredAt: string;
  projectId: string;
  sha256: string;
};

export type ArchiveManifest = {
  archivedAt: string;
  chunks: ArchiveChunk[];
  occurrenceCount: number;
  partition: string;
  partitionDate: string;
  version: 1;
};

function identifier(value: string): string {
  if (!PARTITION_PATTERN.test(value)) {
    throw new Error(`invalid occurrence partition name: ${value}`);
  }
  return `"${value}"`;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapArchivedOccurrence(row: Record<string, unknown>): ArchivedOccurrence {
  const playerId = row.player_id === null ? null : String(row.player_id);
  const playerName = row.player_name ? String(row.player_name) : playerId;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    occurredAt: iso(row.occurred_at),
    lastOccurredAt: iso(row.last_occurred_at),
    repeatCount: Number(row.repeat_count),
    receivedAt: iso(row.received_at),
    severity: String(row.severity),
    side: String(row.side),
    message: String(row.message),
    source: row.source_script ? String(row.source_script) : null,
    stackTrace: row.stack_trace ? String(row.stack_trace) : null,
    fingerprint: String(row.fingerprint),
    serverJobId: String(row.job_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    player:
      playerId && playerName
        ? {
            robloxUserId: playerId,
            username: playerName,
            displayName: row.player_display_name
              ? String(row.player_display_name)
              : playerName,
            avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
          }
        : null,
    attributes: (row.context as Record<string, unknown> | null) ?? {},
  };
}

export function archiveManifestKey(storage: ArchiveStorage, date: string): string {
  return storage.key(`occurrences/${date}/manifest.json`);
}

export function decodeArchiveChunk(body: Buffer): ArchivedOccurrence[] {
  const parsed = JSON.parse(gunzipSync(body).toString("utf8")) as {
    occurrences?: ArchivedOccurrence[];
    version?: number;
  };
  if (parsed.version !== 1 || !Array.isArray(parsed.occurrences)) {
    throw new Error("unsupported or invalid telemetry archive chunk");
  }
  return parsed.occurrences;
}

export async function readArchiveManifest(
  storage: ArchiveStorage,
  date: string,
): Promise<ArchiveManifest | null> {
  const body = await storage.get(archiveManifestKey(storage, date));
  if (!body) return null;
  const manifest = JSON.parse(body.toString("utf8")) as ArchiveManifest;
  if (manifest.version !== 1 || manifest.partitionDate !== date) {
    throw new Error(`invalid telemetry archive manifest for ${date}`);
  }
  return manifest;
}

async function archivePartition(
  client: PoolClient,
  storage: ArchiveStorage,
  partition: string,
): Promise<ArchiveManifest> {
  const match = PARTITION_PATTERN.exec(partition);
  if (!match) throw new Error(`invalid occurrence partition name: ${partition}`);
  const partitionDate = `${match[1]}-${match[2]}-${match[3]}`;
  const existing = await readArchiveManifest(storage, partitionDate);
  if (existing) {
    for (const chunk of existing.chunks) {
      await storage.verifyObject(chunk.key, chunk.sha256, chunk.bytes);
    }
    return existing;
  }

  const relation = identifier(partition);
  const jobs = await client.query<{ job_id: string; project_id: string }>(
    `SELECT DISTINCT project_id::text, job_id::text
     FROM ${relation}
     ORDER BY project_id, job_id`,
  );
  const chunks: ArchiveChunk[] = [];
  let occurrenceCount = 0;

  for (const job of jobs.rows) {
    let cursorTime: string | null = null;
    let cursorId: string | null = null;
    let chunkIndex = 0;

    while (true) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT
           o.id, o.project_id, o.occurred_at,
           COALESCE(o.last_occurred_at, o.occurred_at) AS last_occurred_at,
           o.repeat_count, o.received_at,
           eg.level AS severity, eg.source AS side,
           COALESCE(o.original_message, eg.normalized_message) AS message,
           eg.source_script, COALESCE(o.original_stack, eg.normalized_stack) AS stack_trace,
           eg.fingerprint, o.job_id, o.session_id, o.context,
           s.player_id, s.player_name, s.player_display_name, s.avatar_url
         FROM ${relation} o
         JOIN error_groups eg ON eg.id = o.group_id
         LEFT JOIN sessions s ON s.id = o.session_id
         WHERE o.project_id = $1
           AND o.job_id = $2
           AND ($3::timestamptz IS NULL OR (o.occurred_at, o.id) > ($3, $4::uuid))
         ORDER BY o.occurred_at, o.id
         LIMIT $5`,
        [job.project_id, job.job_id, cursorTime, cursorId, ARCHIVE_PAGE_SIZE],
      );
      if (result.rows.length === 0) break;

      const occurrences: ArchivedOccurrence[] = result.rows.map(
        mapArchivedOccurrence,
      );
      const first = occurrences[0]!;
      const last: ArchivedOccurrence = occurrences.at(-1)!;
      const key = storage.key(
        `occurrences/${partitionDate}/projects/${job.project_id}/jobs/${job.job_id}/${String(chunkIndex).padStart(6, "0")}.json.gz`,
      );
      const body = await gzip(
        Buffer.from(
          JSON.stringify({ version: 1, partitionDate, occurrences }),
          "utf8",
        ),
        { level: 6 },
      );
      const uploaded = await storage.putVerified(key, body, {
        contentType: "application/gzip",
      });
      chunks.push({
        key,
        bytes: uploaded.bytes,
        projectId: job.project_id,
        jobId: job.job_id,
        count: occurrences.length,
        firstOccurredAt: first.occurredAt,
        lastOccurredAt: last.lastOccurredAt,
        sha256: uploaded.sha256,
      });
      occurrenceCount += occurrences.length;
      cursorTime = last.occurredAt;
      cursorId = last.id;
      chunkIndex += 1;
      if (result.rows.length < ARCHIVE_PAGE_SIZE) break;
    }
  }

  const manifest: ArchiveManifest = {
    version: 1,
    partition,
    partitionDate,
    archivedAt: new Date().toISOString(),
    occurrenceCount,
    chunks,
  };
  await storage.putVerified(
    archiveManifestKey(storage, partitionDate),
    Buffer.from(JSON.stringify(manifest), "utf8"),
    { contentType: "application/json" },
  );
  return manifest;
}

export async function archiveEligiblePartitions(
  pool: Pool,
  storage: ArchiveStorage,
): Promise<{
  lockAcquired: boolean;
  occurrenceCount: number;
  partitionCount: number;
}> {
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('trace-archive-maintenance', 0)) AS acquired",
    );
    locked = lock.rows[0]?.acquired === true;
    if (!locked) {
      return { lockAcquired: false, occurrenceCount: 0, partitionCount: 0 };
    }

    const partitions = await client.query<{ partition_name: string }>(
      `SELECT child.relname AS partition_name
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_class child ON child.oid = pg_inherits.inhrelid
       WHERE parent.relname = 'occurrences'
         AND child.relname ~ '^occurrences_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
         AND to_date(substring(child.relname FROM 13), 'YYYY_MM_DD') + 1
             <= ((now() - INTERVAL '24 hours') AT TIME ZONE 'UTC')::date
       ORDER BY child.relname`,
    );
    let occurrenceCount = 0;
    for (const row of partitions.rows) {
      const manifest = await archivePartition(client, storage, row.partition_name);
      occurrenceCount += manifest.occurrenceCount;
    }
    return {
      lockAcquired: true,
      occurrenceCount,
      partitionCount: partitions.rows.length,
    };
  } finally {
    if (locked) {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended('trace-archive-maintenance', 0))",
      );
    }
    client.release();
  }
}
