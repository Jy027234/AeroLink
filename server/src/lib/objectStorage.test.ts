import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalObjectStorage, S3CompatibleObjectStorage } from './objectStorage.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('LocalObjectStorage', () => {
  it('stores immutable metadata with a checksum and rejects traversal keys', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-object-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'source.pdf');
    await fs.writeFile(source, '%PDF-1.7 test');
    const storage = new LocalObjectStorage(path.join(root, 'objects'));

    const metadata = await storage.putFile({
      sourcePath: source,
      objectKey: 'certificates/object-1.pdf',
      mimeType: 'application/pdf',
      originalName: 'certificate.pdf',
      domain: 'certificate',
      ownerId: 'user-1',
    });

    expect(metadata).toMatchObject({
      objectKey: 'certificates/object-1.pdf',
      version: 1,
      sizeBytes: 13,
      mimeType: 'application/pdf',
      originalName: 'certificate.pdf',
    });
    expect(metadata.sha256).toHaveLength(64);
    expect(await storage.exists(metadata.objectKey)).toBe(true);
    await expect(storage.createReadStream('../secret')).rejects.toThrow('Invalid object key');
  });

  it('rejects zero-byte objects before persistence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-object-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'empty.bin');
    await fs.writeFile(source, '');
    const storage = new LocalObjectStorage(path.join(root, 'objects'));

    await expect(storage.putFile({ sourcePath: source, objectKey: 'empty.bin', mimeType: 'application/octet-stream' }))
      .rejects.toThrow('non-empty file');
  });
});

describe('S3CompatibleObjectStorage', () => {
  it('uses the same object contract against an injected S3-compatible transport', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-s3-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 's3 contract body');
    const objects = new Map<string, Buffer>();
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl = async (input: string, init: RequestInit = {}) => {
      requests.push({ input, init });
      const key = decodeURIComponent(new URL(input).pathname.split('/').slice(2).join('/'));
      const method = init.method || 'GET';
      if (method === 'PUT') {
        objects.set(key, Buffer.from(init.body as Uint8Array));
        return new Response(null, { status: 200, headers: { 'x-amz-version-id': '1' } });
      }
      if (method === 'HEAD') return objects.has(key) ? new Response(null, { status: 200 }) : new Response(null, { status: 404 });
      if (method === 'GET') {
        const body = objects.get(key);
        return body ? new Response(body as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
      }
      if (method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    };
    const storage = new S3CompatibleObjectStorage({
      endpoint: 'https://s3.example.test',
      bucket: 'aerolink-test',
      region: 'us-east-1',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      fetchImpl,
    });

    const metadata = await storage.putFile({ sourcePath: source, objectKey: 'docs/object.txt', mimeType: 'text/plain' });
    expect(metadata).toMatchObject({ objectKey: 'docs/object.txt', version: 1, sizeBytes: 16, mimeType: 'text/plain' });
    expect(requests[0]?.init.headers).toEqual(expect.objectContaining({
      authorization: expect.stringContaining('Credential=test-access/'),
      host: 's3.example.test',
    }));
    expect(JSON.stringify(requests[0])).not.toContain('test-secret');
    expect(await storage.exists(metadata.objectKey)).toBe(true);
    const stream = await storage.createReadStream(metadata.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('s3 contract body');
    await storage.delete(metadata.objectKey);
    expect(await storage.exists(metadata.objectKey)).toBe(false);
  });

  it('fails closed when an S3 upload is interrupted or rejected', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-s3-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 'interrupted body');
    const storage = new S3CompatibleObjectStorage({
      endpoint: 'https://s3.example.test',
      bucket: 'aerolink-test',
      region: 'us-east-1',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      fetchImpl: async () => new Response(null, { status: 503 }),
    });

    await expect(storage.putFile({ sourcePath: source, objectKey: 'docs/interrupted.txt', mimeType: 'text/plain' }))
      .rejects.toThrow('S3 PUT failed with status 503');
  });
});
