import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import prisma from '../lib/prisma.js';
import { objectStorage } from '../lib/objectStorage.js';
import { summarizeUploadEntries, type UploadManifest, type UploadManifestEntry } from '../lib/uploadManifest.js';

const MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const [key, value = 'true'] = argument.slice(2).split('=', 2);
    values.set(key, value);
  }
  return {
    apply: values.get('apply') === 'true',
    sourceDir: path.resolve(values.get('source') || process.env.UPLOADS_DIR || path.resolve(process.cwd(), 'uploads')),
    manifestPath: values.get('manifest') ? path.resolve(values.get('manifest')!) : undefined,
    after: values.get('after') || '',
    limit: values.get('limit') ? Math.max(1, Number(values.get('limit'))) : Number.POSITIVE_INFINITY,
  };
}

async function listFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const stat = await fs.stat(rootDir);
    if (!stat.isDirectory()) return result;
  } catch {
    return result;
  }
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  };
  await visit(rootDir);
  return result;
}

async function checksum(filePath: string) {
  const content = await fs.readFile(filePath);
  return {
    content,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function summarize(entries: UploadManifestEntry[]) {
  return entries.reduce<Record<string, number>>((result, entry) => {
    result[entry.status] = (result[entry.status] || 0) + 1;
    return result;
  }, {});
}

async function readPreviousEntries(manifestPath: string | undefined, sourceDir: string) {
  if (!manifestPath) return [] as UploadManifestEntry[];
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as UploadManifestEntry[];
    throw error;
  }
  const previous = JSON.parse(raw) as Partial<UploadManifest>;
  if (previous.sourceDir && path.resolve(previous.sourceDir) !== sourceDir) {
    throw new Error(`Manifest sourceDir does not match current source: ${previous.sourceDir}`);
  }
  return Array.isArray(previous.entries) ? previous.entries : [];
}

function mergeEntries(previous: UploadManifestEntry[], current: UploadManifestEntry[]) {
  const byObjectKey = new Map(previous.map((entry) => [entry.objectKey, entry]));
  for (const entry of current) byObjectKey.set(entry.objectKey, entry);
  return [...byObjectKey.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey));
}

async function writeManifest(manifestPath: string | undefined, manifest: UploadManifest) {
  const serialized = JSON.stringify(manifest, null, 2);
  if (manifestPath) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${serialized}\n`, 'utf8');
  }
  process.stdout.write(`${serialized}\n`);
}

/**
 * Enumerates legacy uploads and optionally copies them into the configured
 * ObjectStorage adapter. The default is a read-only dry run. This script never
 * deletes source files; a later, separately approved cleanup can use the
 * checksum manifest as its only input.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configuredLocalRoot = path.resolve(process.env.UPLOADS_DIR || path.resolve(process.cwd(), 'uploads'));
  if (
    options.apply
    && process.env.OBJECT_STORAGE_DRIVER?.toLowerCase() !== 's3'
    && configuredLocalRoot === options.sourceDir
  ) {
    throw new Error('Refusing --apply when source directory is the local object-storage root; set a distinct UPLOADS_DIR first');
  }
  const files = await listFiles(options.sourceDir);
  const previousEntries = await readPreviousEntries(options.manifestPath, options.sourceDir);
  const entries: UploadManifestEntry[] = [];

  for (const sourcePath of files) {
    const objectKey = path.relative(options.sourceDir, sourcePath).split(path.sep).join('/');
    if (objectKey <= options.after) continue;
    if (entries.length >= options.limit) break;

    const { content, sha256 } = await checksum(sourcePath);
    const stat = await fs.stat(sourcePath);
    const existing = await prisma.storedObject.findUnique({ where: { objectKey } });
    if (existing) {
      entries.push({
        objectKey,
        sourcePath,
        sizeBytes: stat.size,
        sha256,
        status: existing.status === 'AVAILABLE'
          && existing.domain === 'legacy-upload'
          && existing.sha256 === sha256
          && existing.sizeBytes === stat.size
          ? 'already-migrated'
          : 'mismatch',
      });
      continue;
    }

    const entry: UploadManifestEntry = { objectKey, sourcePath, sizeBytes: stat.size, sha256, status: 'pending' };
    if (options.apply) {
      let uploadedObjectKey: string | undefined;
      try {
        const metadata = await objectStorage.putFile({
          sourcePath,
          objectKey,
          mimeType: MIME_TYPES[path.extname(sourcePath).toLowerCase()] || 'application/octet-stream',
          originalName: path.basename(sourcePath),
          domain: 'legacy-upload',
        });
        uploadedObjectKey = metadata.objectKey;
        if (metadata.sha256 !== sha256 || metadata.sizeBytes !== content.byteLength) {
          throw new Error('Object storage checksum or size mismatch after upload');
        }
        await prisma.storedObject.create({
          data: {
            objectKey: metadata.objectKey,
            version: metadata.version,
            sha256: metadata.sha256,
            sizeBytes: metadata.sizeBytes,
            mimeType: metadata.mimeType,
            originalName: metadata.originalName,
            domain: metadata.domain,
            status: 'AVAILABLE',
          },
        });
        entry.status = 'migrated';
      } catch (error) {
        if (uploadedObjectKey) {
          await objectStorage.delete(uploadedObjectKey).catch(() => undefined);
        }
        entry.status = 'failed';
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }
    entries.push(entry);
  }

  const completeScan = !options.after && options.limit === Number.POSITIVE_INFINITY;
  const manifestEntries = completeScan ? entries : mergeEntries(previousEntries, entries);
  const manifest: UploadManifest = {
    generatedAt: new Date().toISOString(),
    sourceDir: options.sourceDir,
    apply: options.apply,
    entries: manifestEntries,
    summary: summarize(manifestEntries),
    reconciliation: summarizeUploadEntries(
      manifestEntries,
      completeScan,
    ),
  };
  await writeManifest(options.manifestPath, manifest);
  if (manifestEntries.some((entry) => entry.status === 'failed' || entry.status === 'mismatch')) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
