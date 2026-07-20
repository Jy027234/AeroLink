import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulesRoot = path.join(repoRoot, 'server', 'src', 'modules');
const routesRoot = path.join(repoRoot, 'server', 'src', 'routes');

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute);
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

const moduleNames = fs.existsSync(modulesRoot)
  ? fs.readdirSync(modulesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [];
const violations = [];

for (const file of [...filesUnder(modulesRoot), ...filesUnder(routesRoot)]) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
  const currentModule = relative.match(/^server\/src\/modules\/([^/]+)/)?.[1] ?? null;
  for (const match of source.matchAll(/from\s+['"](?:[^'"]*\/)?modules\/([^'"]+)['"]/g)) {
    const imported = match[1].replace(/\.(js|ts|tsx)$/, '');
    const importedModule = moduleNames.find((name) => imported.startsWith(`${name}/`) || imported === name);
    if (!importedModule) continue;
    const isPublicEntry = imported === importedModule || imported.endsWith('/index');
    const isSameModule = currentModule === importedModule;
    if (!isPublicEntry && (!isSameModule || relative.startsWith('server/src/routes/'))) {
      violations.push(`${relative}: import modules/${imported} (use the module public index)`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Server module boundaries failed:\n${violations.join('\n')}`);
  process.exit(1);
}

console.log(`Server module boundaries OK: ${moduleNames.length} module public entry points checked.`);
