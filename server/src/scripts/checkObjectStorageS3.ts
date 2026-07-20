import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { S3CompatibleObjectStorage } from '../lib/objectStorage.js';

const endpoint = process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  throw new Error('S3 contract requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-s3-contract-'));
const sourcePath = path.join(root, 'contract.txt');
const content = `AeroLink P2 S3 contract ${crypto.randomUUID()}\n`;
await fs.writeFile(sourcePath, content, 'utf8');

const storage = new S3CompatibleObjectStorage({
  endpoint,
  bucket,
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId,
  secretAccessKey,
  sessionToken: process.env.S3_SESSION_TOKEN,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
});

const objectKey = `p2-contract/${crypto.randomUUID()}.txt`;
try {
  const metadata = await storage.putFile({
    sourcePath,
    objectKey,
    mimeType: 'text/plain',
    originalName: 'contract.txt',
    domain: 'p2-contract',
  });
  const expectedSha = crypto.createHash('sha256').update(content).digest('hex');
  if (metadata.sha256 !== expectedSha || metadata.sizeBytes !== Buffer.byteLength(content)) {
    throw new Error('S3 metadata checksum/size mismatch');
  }
  if (!(await storage.exists(objectKey))) throw new Error('S3 object was not visible after upload');

  const stream = await storage.createReadStream(objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks).toString('utf8');
  if (downloaded !== content) throw new Error('S3 downloaded content mismatch');

  await storage.delete(objectKey);
  if (await storage.exists(objectKey)) throw new Error('S3 object still exists after delete');

  console.log(JSON.stringify({
    status: 'PASS',
    driver: 's3-compatible',
    bucket,
    objectKey,
    sizeBytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    deleteVerified: true,
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
