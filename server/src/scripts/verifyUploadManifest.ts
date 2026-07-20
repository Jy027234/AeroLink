import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import prisma from '../lib/prisma.js';
import { objectStorage } from '../lib/objectStorage.js';
import { summarizeUploadEntries, type UploadManifest, type UploadManifestEntry } from '../lib/uploadManifest.js';

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const [key, value = 'true'] = argument.slice(2).split('=', 2);
    values.set(key, value);
  }
  const manifestPath = values.get('manifest');
  if (!manifestPath) throw new Error('--manifest=<path> is required');
  return {
    manifestPath: path.resolve(manifestPath),
    sourceRoot: values.get('source') ? path.resolve(values.get('source')!) : undefined,
    allowMissingSource: values.get('allow-missing-source') === 'true',
  };
}

function sourcePathFor(entry: UploadManifestEntry, sourceRoot?: string) {
  if (!sourceRoot) return path.resolve(entry.sourcePath);
  const candidate = path.resolve(sourceRoot, ...entry.objectKey.split('/'));
  const relative = path.relative(sourceRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Manifest object key escapes source root: ${entry.objectKey}`);
  return candidate;
}

async function hashFile(filePath: string) {
  const content = await fs.readFile(filePath);
  return { sizeBytes: content.byteLength, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

async function hashObject(objectKey: string) {
  const stream = await objectStorage.createReadStream(objectKey);
  const digest = crypto.createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Uint8Array);
    sizeBytes += buffer.byteLength;
    digest.update(buffer);
  }
  return { sizeBytes, sha256: digest.digest('hex') };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await fs.readFile(options.manifestPath, 'utf8')) as UploadManifest;
  const failures: string[] = [];
  const observed: Array<Pick<UploadManifestEntry, 'objectKey' | 'sizeBytes' | 'sha256'>> = [];

  for (const entry of manifest.entries) {
    const sourcePath = sourcePathFor(entry, options.sourceRoot);
    try {
      const source = await hashFile(sourcePath);
      if (source.sizeBytes !== entry.sizeBytes || source.sha256 !== entry.sha256) {
        failures.push(`${entry.objectKey}: source checksum/size differs from manifest`);
      }
    } catch (error) {
      if (!options.allowMissingSource) failures.push(`${entry.objectKey}: source unavailable (${error instanceof Error ? error.message : String(error)})`);
    }

    const storedObject = await prisma.storedObject.findUnique({ where: { objectKey: entry.objectKey } });
    if (!storedObject) {
      failures.push(`${entry.objectKey}: StoredObject metadata is missing`);
      continue;
    }
    if (storedObject.status !== 'AVAILABLE') failures.push(`${entry.objectKey}: StoredObject status is ${storedObject.status}`);
    if (storedObject.sizeBytes !== entry.sizeBytes || storedObject.sha256 !== entry.sha256) {
      failures.push(`${entry.objectKey}: StoredObject metadata differs from manifest`);
    }

    try {
      const object = await hashObject(entry.objectKey);
      if (object.sizeBytes !== entry.sizeBytes || object.sha256 !== entry.sha256) {
        failures.push(`${entry.objectKey}: object bytes differ from manifest`);
      } else {
        observed.push({ objectKey: entry.objectKey, sizeBytes: object.sizeBytes, sha256: object.sha256 });
      }
    } catch (error) {
      failures.push(`${entry.objectKey}: object unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const expected = summarizeUploadEntries(manifest.entries);
  const actual = summarizeUploadEntries(observed);
  const result = {
    status: failures.length === 0 && expected.fileCount === actual.fileCount && expected.totalBytes === actual.totalBytes && expected.manifestSha256 === actual.manifestSha256 ? 'PASS' : 'FAIL',
    manifest: options.manifestPath,
    expected,
    actual,
    failures,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'PASS') process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
