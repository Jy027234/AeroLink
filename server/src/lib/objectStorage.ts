import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export interface StoredObjectMetadata {
  objectKey: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  originalName?: string;
  domain?: string;
  resourceId?: string;
  ownerId?: string;
}

export interface PutObjectInput {
  sourcePath: string;
  objectKey?: string;
  mimeType: string;
  originalName?: string;
  domain?: string;
  resourceId?: string;
  ownerId?: string;
}

export interface ObjectStorage {
  putFile(input: PutObjectInput): Promise<StoredObjectMetadata>;
  createReadStream(objectKey: string): Promise<Readable>;
  delete(objectKey: string): Promise<void>;
  exists(objectKey: string): Promise<boolean>;
}

function assertSafeObjectKey(objectKey: string) {
  if (!objectKey || objectKey.includes('\\') || objectKey.includes('..') || path.posix.isAbsolute(objectKey)) {
    throw new Error('Invalid object key');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(objectKey)) {
    throw new Error('Invalid object key');
  }
}

export class LocalObjectStorage implements ObjectStorage {
  readonly rootDir: string;

  constructor(rootDir = process.env.UPLOADS_DIR || path.resolve(process.cwd(), 'uploads')) {
    this.rootDir = path.resolve(rootDir);
  }

  private resolve(objectKey: string) {
    assertSafeObjectKey(objectKey);
    const resolved = path.resolve(this.rootDir, objectKey);
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid object key');
    return resolved;
  }

  async putFile(input: PutObjectInput): Promise<StoredObjectMetadata> {
    const sourcePath = path.resolve(input.sourcePath);
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('Object must be a non-empty file');

    const objectKey = input.objectKey || `${crypto.randomUUID()}${path.extname(input.originalName || '')}`;
    const destination = this.resolve(objectKey);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (sourcePath !== destination) await fs.copyFile(sourcePath, destination);

    const content = await fs.readFile(destination);
    return {
      objectKey,
      version: 1,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      sizeBytes: stat.size,
      mimeType: input.mimeType,
      ...(input.originalName ? { originalName: input.originalName } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    };
  }

  async createReadStream(objectKey: string) {
    const filePath = this.resolve(objectKey);
    if (!(await this.exists(objectKey))) throw new Error('Object not found');
    return createReadStream(filePath);
  }

  async delete(objectKey: string) {
    await fs.rm(this.resolve(objectKey), { force: true });
  }

  async exists(objectKey: string) {
    try {
      await fs.access(this.resolve(objectKey));
      return true;
    } catch {
      return false;
    }
  }
}

type S3Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface S3CompatibleObjectStorageOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
  fetchImpl?: S3Fetch;
}

function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeObjectPath(objectKey: string) {
  assertSafeObjectKey(objectKey);
  return objectKey.split('/').map(encodeRfc3986).join('/');
}

function hmac(key: crypto.BinaryLike, value: string) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function sha256(value: crypto.BinaryLike) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Minimal AWS Signature V4 S3 adapter. It deliberately depends only on the
 * platform fetch/crypto APIs so Local and S3-compatible contract tests share
 * the same ObjectStorage interface without requiring cloud credentials.
 */
export class S3CompatibleObjectStorage implements ObjectStorage {
  private readonly endpoint: URL;
  private readonly fetchImpl: S3Fetch;
  private readonly forcePathStyle: boolean;

  constructor(private readonly options: S3CompatibleObjectStorageOptions) {
    this.endpoint = new URL(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.forcePathStyle = options.forcePathStyle ?? true;
    if (!options.bucket || !options.region || !options.accessKeyId || !options.secretAccessKey) {
      throw new Error('S3 bucket, region and credentials are required');
    }
  }

  private requestUrl(objectKey: string) {
    const encodedKey = encodeObjectPath(objectKey);
    if (this.forcePathStyle) {
      return new URL(`${this.endpoint.toString().replace(/\/$/, '')}/${encodeRfc3986(this.options.bucket)}/${encodedKey}`);
    }
    const host = `${this.options.bucket}.${this.endpoint.host}`;
    const url = new URL(this.endpoint.toString());
    url.host = host;
    url.pathname = `/${encodedKey}`;
    return url;
  }

  private async signedRequest(method: string, objectKey: string, body?: Buffer, contentType?: string) {
    const url = this.requestUrl(objectKey);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? Buffer.alloc(0));
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;
    if (this.options.sessionToken) headers['x-amz-security-token'] = this.options.sessionToken;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim()}\n`).join('');
    const canonicalRequest = [
      method,
      url.pathname || '/',
      url.search.slice(1),
      canonicalHeaders,
      signedHeaderNames.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${this.options.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.options.secretAccessKey}`, dateStamp), this.options.region), 's3'),
      'aws4_request',
    );
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;

    return this.fetchImpl(url.toString(), {
      method,
      headers,
      ...(body ? { body: body as unknown as BodyInit } : {}),
    });
  }

  async putFile(input: PutObjectInput): Promise<StoredObjectMetadata> {
    const sourcePath = path.resolve(input.sourcePath);
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('Object must be a non-empty file');
    const objectKey = input.objectKey || `${crypto.randomUUID()}${path.extname(input.originalName || '')}`;
    const body = await fs.readFile(sourcePath);
    const response = await this.signedRequest('PUT', objectKey, body, input.mimeType);
    if (!response.ok) throw new Error(`S3 PUT failed with status ${response.status}`);
    const versionHeader = response.headers.get('x-amz-version-id');
    return {
      objectKey,
      version: versionHeader && /^\d+$/.test(versionHeader) ? Number(versionHeader) : 1,
      sha256: sha256(body),
      sizeBytes: body.byteLength,
      mimeType: input.mimeType,
      ...(input.originalName ? { originalName: input.originalName } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    };
  }

  async createReadStream(objectKey: string) {
    const response = await this.signedRequest('GET', objectKey);
    if (!response.ok || !response.body) throw new Error('Object not found');
    return Readable.fromWeb(response.body as any);
  }

  async delete(objectKey: string) {
    const response = await this.signedRequest('DELETE', objectKey);
    if (!response.ok && response.status !== 404) throw new Error(`S3 DELETE failed with status ${response.status}`);
  }

  async exists(objectKey: string) {
    const response = await this.signedRequest('HEAD', objectKey);
    return response.ok;
  }
}

function createConfiguredObjectStorage(): ObjectStorage {
  if (process.env.OBJECT_STORAGE_DRIVER?.toLowerCase() !== 's3') return new LocalObjectStorage();
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('OBJECT_STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
  return new S3CompatibleObjectStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.S3_REGION || 'us-east-1',
    sessionToken: process.env.S3_SESSION_TOKEN,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  });
}

export const objectStorage: ObjectStorage = createConfiguredObjectStorage();
