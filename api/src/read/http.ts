import { z } from "zod";

export const severitySchema = z.enum(["trace", "info", "warning", "error"]);
export const sideSchema = z.enum(["client", "server"]);

const cursorEnvelopeSchema = z.object({
  version: z.literal(1),
  values: z.array(z.union([z.string(), z.number(), z.null()])),
});

export function encodeCursor(
  values: Array<string | number | null>,
): string {
  return Buffer.from(JSON.stringify({ version: 1, values })).toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): Array<string | number | null> {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    return cursorEnvelopeSchema.parse(decoded).values;
  } catch {
    throw new ReadApiError(400, "invalid_cursor", "Invalid cursor.");
  }
}

export function parseCsvEnum<T extends string>(
  input: string | undefined,
  schema: z.ZodType<T>,
): T[] | undefined {
  if (!input) {
    return undefined;
  }

  const values = [...new Set(input.split(",").filter(Boolean))];
  return z.array(schema).min(1).parse(values);
}

export function parseTimeRange(
  from: string | undefined,
  to: string | undefined,
): { from: Date; to: Date } {
  const parsedTo = to ? new Date(to) : new Date();
  const parsedFrom = from
    ? new Date(from)
    : new Date(parsedTo.getTime() - 24 * 60 * 60 * 1_000);

  if (
    Number.isNaN(parsedFrom.getTime()) ||
    Number.isNaN(parsedTo.getTime()) ||
    parsedFrom >= parsedTo
  ) {
    throw new ReadApiError(
      400,
      "invalid_time_range",
      "`from` must be a valid timestamp earlier than `to`.",
    );
  }

  if (parsedTo.getTime() - parsedFrom.getTime() > 3 * 24 * 60 * 60 * 1_000) {
    throw new ReadApiError(
      400,
      "time_range_too_large",
      "Raw queries are limited to the three-day retention window.",
    );
  }

  return { from: parsedFrom, to: parsedTo };
}

export function clampLimit(
  input: string | number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  if (input === undefined) {
    return defaultValue;
  }

  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ReadApiError(
      400,
      "invalid_limit",
      "`limit` must be a positive integer.",
    );
  }
  return Math.min(parsed, maximum);
}

export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export class ReadApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
