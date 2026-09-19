import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vendor = path.join(root, 'vendor/pptxgenjs');
const provenance = JSON.parse(await readFile(path.join(vendor, 'UPSTREAM.json'), 'utf8'));
assert.equal(provenance.runtimeModified, false);
for (const [name, expected] of Object.entries(provenance.sha256)) {
  assert.ok(!name.includes('..') && !path.isAbsolute(name), 'Unsafe provenance path');
  const content = await readFile(path.join(vendor, name));
  assert.equal(createHash('sha256').update(content).digest('hex'), expected, `Unexpected change in ${name}`);
  if (/\.(?:js|map|ts)$/.test(name)) assert.ok(!content.toString().includes('image-size'), `Unexpected image-size reference in ${name}`);
}
const manifest = JSON.parse(await readFile(path.join(vendor, 'package.json'), 'utf8'));
assert.equal(manifest.dependencies['image-size'], undefined);
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
assert.ok(!Object.keys(lock.packages).some((name) => name.endsWith('/image-size')), 'Vulnerable parser is still installed');
const require = createRequire(path.join(root, 'package.json'));
const CjsPptx = require('pptxgenjs');
const { default: EsmPptx } = await import(pathToFileURL(path.join(vendor, 'dist/pptxgen.es.js')).href);
for (const Constructor of [CjsPptx, EsmPptx]) {
  const pptx = new Constructor();
  pptx.addSlide().addText('AeroLink distribution verification', { x: 1, y: 1, w: 8, h: 1 });
  const bytes = await pptx.write({ outputType: 'nodebuffer' });
  assert.ok(Buffer.isBuffer(bytes) && bytes[0] === 0x50 && bytes[1] === 0x4b, 'PPTX output is invalid');
}
console.log('Vendored PptxGenJS: upstream checksums, parser absence, ESM/CJS generation passed.');
