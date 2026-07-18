import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { config } from "./config.js";

type AppConfig = typeof config;

export type ArchiveProbeResult = {
  bucket: string;
  objectKey: string;
  provider: "s3" | "spaces" | "r2";
  sha256: string;
};

export type VerifiedArchiveObject = {
  bytes: number;
  objectKey: string;
  sha256: string;
};

function normalizePrefix(prefix: string): string {
  const withoutLeadingSlash = prefix.replace(/^\/+/, "");
  if (!withoutLeadingSlash) return "";
  return withoutLeadingSlash.endsWith("/")
    ? withoutLeadingSlash
    : `${withoutLeadingSlash}/`;
}

export class ArchiveStorage {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #provider: "s3" | "spaces" | "r2";

  constructor(options: {
    accessKeyId: string;
    bucket: string;
    endpoint: string;
    forcePathStyle: boolean;
    prefix: string;
    provider: "s3" | "spaces" | "r2";
    region: string;
    secretAccessKey: string;
  }) {
    this.#bucket = options.bucket;
    this.#prefix = normalizePrefix(options.prefix);
    this.#provider = options.provider;
    this.#client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async verifyReadWrite(): Promise<ArchiveProbeResult> {
    const probeId = randomUUID();
    const objectKey = `${this.#prefix}_probe/${probeId}.txt`;
    const body = Buffer.from(`trace-archive-probe:${probeId}`, "utf8");
    const sha256 = createHash("sha256").update(body).digest("hex");

    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          Body: body,
          ContentType: "text/plain; charset=utf-8",
          CacheControl: "no-store",
          Metadata: { sha256 },
        }),
      );

      const downloaded = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
      );
      if (!downloaded.Body) {
        throw new Error("archive probe returned an empty response body");
      }

      const downloadedBody = Buffer.from(
        await downloaded.Body.transformToByteArray(),
      );
      const downloadedSha256 = createHash("sha256")
        .update(downloadedBody)
        .digest("hex");
      if (downloadedSha256 !== sha256) {
        throw new Error("archive probe checksum mismatch");
      }

      return {
        bucket: this.#bucket,
        objectKey,
        provider: this.#provider,
        sha256,
      };
    } finally {
      await this.#client
        .send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: objectKey }))
        .catch(() => undefined);
    }
  }

  async putVerified(
    objectKey: string,
    body: Buffer,
    options: { contentEncoding?: string; contentType: string },
  ): Promise<VerifiedArchiveObject> {
    const sha256 = createHash("sha256").update(body).digest("hex");
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: options.contentType,
        ContentEncoding: options.contentEncoding,
        Metadata: { sha256 },
      }),
    );

    const stored = await this.#client.send(
      new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
    );
    if (
      stored.Metadata?.sha256 !== sha256 ||
      stored.ContentLength !== body.byteLength
    ) {
      throw new Error(`archive object verification failed for ${objectKey}`);
    }

    return { bytes: body.byteLength, objectKey, sha256 };
  }

  async verifyObject(
    objectKey: string,
    expectedSha256: string,
    expectedBytes?: number,
  ): Promise<void> {
    const stored = await this.#client.send(
      new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
    );
    if (
      stored.Metadata?.sha256 !== expectedSha256 ||
      (expectedBytes !== undefined && stored.ContentLength !== expectedBytes)
    ) {
      throw new Error(`archive object verification failed for ${objectKey}`);
    }
  }

  async get(objectKey: string): Promise<Buffer | null> {
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
      );
      if (!response.Body) return null;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (statusCode === 404) return null;
      throw error;
    }
  }

  key(relativeKey: string): string {
    return `${this.#prefix}${relativeKey.replace(/^\/+/, "")}`;
  }

  close(): void {
    this.#client.destroy();
  }
}

export function createArchiveStorage(appConfig: AppConfig): ArchiveStorage | null {
  if (
    !appConfig.ARCHIVE_STORAGE_PROVIDER ||
    !appConfig.ARCHIVE_S3_ENDPOINT ||
    !appConfig.ARCHIVE_S3_BUCKET ||
    !appConfig.ARCHIVE_S3_ACCESS_KEY_ID ||
    !appConfig.ARCHIVE_S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }

  return new ArchiveStorage({
    provider: appConfig.ARCHIVE_STORAGE_PROVIDER,
    endpoint: appConfig.ARCHIVE_S3_ENDPOINT,
    bucket: appConfig.ARCHIVE_S3_BUCKET,
    accessKeyId: appConfig.ARCHIVE_S3_ACCESS_KEY_ID,
    secretAccessKey: appConfig.ARCHIVE_S3_SECRET_ACCESS_KEY,
    region: appConfig.ARCHIVE_S3_REGION,
    forcePathStyle: appConfig.ARCHIVE_S3_FORCE_PATH_STYLE,
    prefix: appConfig.ARCHIVE_S3_PREFIX,
  });
}
