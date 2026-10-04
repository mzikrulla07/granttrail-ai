/**
 * Document storage.
 *
 *  local — development: files on disk under LOCAL_STORAGE_DIR.
 *  s3    — production: Amazon S3 with server-side encryption (SSE-KMS when a
 *          key is configured, otherwise SSE-S3/AES-256). The bucket should
 *          block all public access and enforce TLS via bucket policy.
 *
 * Storage keys are always server-generated (`agreements/<uuid>.pdf`). User
 * supplied filenames are never used as paths, preventing path traversal.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../config.js';

export interface DocumentStorage {
  readonly driver: 'local' | 's3';
  put(buf: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
}

const KEY_PATTERN = /^agreements\/[0-9a-f-]{36}\.pdf$/;

export function newStorageKey(): string {
  return `agreements/${crypto.randomUUID()}.pdf`;
}

function assertKey(key: string) {
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
}

export class LocalStorage implements DocumentStorage {
  readonly driver = 'local' as const;
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Path escapes storage root');
    return full;
  }

  async put(buf: Buffer): Promise<string> {
    const key = newStorageKey();
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf, { flag: 'wx', mode: 0o600 });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }
}

export class S3Storage implements DocumentStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
    private readonly kmsKeyId?: string,
  ) {
    // Credentials come from the ECS task role (no access keys in env/config).
    this.client = new S3Client({ region });
  }

  async put(buf: Buffer, contentType: string): Promise<string> {
    const key = newStorageKey();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buf,
        ContentType: contentType,
        ServerSideEncryption: this.kmsKeyId ? 'aws:kms' : 'AES256',
        SSEKMSKeyId: this.kmsKeyId,
      }),
    );
    return key;
  }

  async get(key: string): Promise<Buffer> {
    assertKey(key);
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await out.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
}

export function createStorage(config: AppConfig): DocumentStorage {
  if (config.storage.driver === 's3') {
    return new S3Storage(config.storage.s3Bucket!, config.storage.awsRegion, config.storage.s3KmsKeyId);
  }
  return new LocalStorage(config.storage.localDir);
}
