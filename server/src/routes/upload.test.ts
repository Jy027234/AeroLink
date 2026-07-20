import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { isUploadSizeAllowed, MAX_UPLOAD_BYTES, verifyFileSignature } from './upload.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('upload content validation', () => {
  it('enforces the 10 MB size ceiling and rejects zero-byte uploads', () => {
    expect(isUploadSizeAllowed(1)).toBe(true);
    expect(isUploadSizeAllowed(MAX_UPLOAD_BYTES)).toBe(true);
    expect(isUploadSizeAllowed(MAX_UPLOAD_BYTES + 1)).toBe(false);
    expect(isUploadSizeAllowed(0)).toBe(false);
  });

  it('accepts a matching PDF magic header and rejects a forged MIME declaration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-upload-'));
    temporaryDirectories.push(root);
    const pdf = path.join(root, 'document.bin');
    const text = path.join(root, 'not-a-pdf.bin');
    await fs.writeFile(pdf, '%PDF-1.7\ncontent');
    await fs.writeFile(text, 'plain text');

    expect(verifyFileSignature(pdf, 'application/pdf')).toBe(true);
    expect(verifyFileSignature(text, 'application/pdf')).toBe(false);
  });

  it('rejects empty, unknown-MIME and missing files safely', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-upload-'));
    temporaryDirectories.push(root);
    const empty = path.join(root, 'empty');
    await fs.writeFile(empty, '');

    expect(verifyFileSignature(empty, 'application/pdf')).toBe(false);
    expect(verifyFileSignature(empty, 'application/x-secret')).toBe(false);
    expect(verifyFileSignature(path.join(root, 'missing'), 'application/pdf')).toBe(false);
  });
});
