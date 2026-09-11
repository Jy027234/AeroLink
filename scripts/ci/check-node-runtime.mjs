import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const requiredNodeRange = '>=22.23.2 <23';

function versionTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Unable to parse Node version: ${version}`);
  return match.slice(1).map(Number);
}

function isSupportedNode(version) {
  const [major, minor, patch] = versionTuple(version);
  return major === 22 && (minor > 23 || (minor === 23 && patch >= 2));
}

const nodeVersion = process.versions.node;
if (!isSupportedNode(nodeVersion)) {
  console.error(`Unsupported Node.js runtime ${nodeVersion}; expected ${requiredNodeRange}.`);
  process.exitCode = 1;
} else {
  const packagePaths = ['package.json', 'server/package.json'];
  const packageEngines = [];
  for (const relativePath of packagePaths) {
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
    packageEngines.push({ file: relativePath, engine: packageJson.engines?.node ?? null });
  }

  const invalidDeclarations = packageEngines.filter(({ engine }) => engine !== requiredNodeRange);
  if (invalidDeclarations.length > 0) {
    console.error(`Node engine declarations must be ${requiredNodeRange}:`);
    for (const declaration of invalidDeclarations) console.error(`- ${declaration.file}: ${declaration.engine ?? '(missing)'}`);
    process.exitCode = 1;
  }

  if (!process.exitCode) {
    console.log(JSON.stringify({ node: nodeVersion, required: requiredNodeRange, engines: packageEngines }));
  }
}
