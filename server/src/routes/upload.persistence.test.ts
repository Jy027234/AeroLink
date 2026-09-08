import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ putFile: vi.fn(), deleteObject: vi.fn(), create: vi.fn(), deleteMany: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'reviewer' }; next(); } }));
vi.mock('../lib/prisma.js', () => ({ default: { storedObject: { create: mocks.create, deleteMany: mocks.deleteMany } } }));
vi.mock('../lib/objectStorage.js', () => ({ objectStorage: { putFile: mocks.putFile, delete: mocks.deleteObject } }));
import router from './upload.js';
import { errorHandler } from '../middleware/errorHandler.js';

let root: string;
const previousStaging = process.env.UPLOAD_STAGING_DIR;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-upload-persistence-'));
  process.env.UPLOAD_STAGING_DIR = path.join(root, 'staging');
  await fs.mkdir(path.join(root, 'objects'));
  mocks.putFile.mockImplementation(async (input) => {
    await fs.copyFile(input.sourcePath, path.join(root, 'objects', input.objectKey));
    return { objectKey: input.objectKey, version: 1, sha256: 'test-hash', sizeBytes: 20, mimeType: input.mimeType };
  });
  mocks.create.mockImplementation(async ({ data }) => ({ id: data.objectKey, ...data }));
  mocks.deleteMany.mockResolvedValue({ count: 1 });
  mocks.deleteObject.mockImplementation(async (key) => { await fs.rm(path.join(root, 'objects', key), { force: true }); });
});
afterEach(async () => {
  if (previousStaging === undefined) delete process.env.UPLOAD_STAGING_DIR;
  else process.env.UPLOAD_STAGING_DIR = previousStaging;
  await fs.rm(root, { recursive: true, force: true });
});

function app() { const server = express(); server.use('/upload', router); server.use(errorHandler); return server; }
const pdf = Buffer.from('%PDF-1.4\n% upload test');

describe('upload staging and rollback', () => {
  it('preserves stored bytes and removes the separate temporary copy after success', async () => {
    const response = await request(app()).post('/upload').attach('file', pdf, 'proof.pdf');
    expect(response.status).toBe(200);
    expect(await fs.readdir(path.join(root, 'staging'))).toEqual([]);
    expect(await fs.readFile(path.join(root, 'objects', response.body.data.filename))).toEqual(pdf);
  });

  it('removes earlier object metadata and bytes when a later file cannot be registered', async () => {
    mocks.create.mockImplementationOnce(async ({ data }) => ({ id: 'first-object', ...data })).mockRejectedValueOnce(new Error('registration failed'));
    const response = await request(app()).post('/upload/multiple').attach('files', pdf, 'first.pdf').attach('files', pdf, 'second.pdf');
    expect(response.status).toBe(500);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['first-object'] } } });
    expect(await fs.readdir(path.join(root, 'staging'))).toEqual([]);
    expect(await fs.readdir(path.join(root, 'objects'))).toEqual([]);
  });
});
