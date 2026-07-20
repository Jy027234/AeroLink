import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const serverRoot = path.join(repoRoot, 'server');
const indexPath = path.join(serverRoot, 'src', 'index.ts');

function normalizePath(value) {
  const normalized = value.replace(/\/+/g, '/');
  if (normalized === '/') return '/';
  return `/${normalized.replace(/^\/+|\/+$/g, '')}`;
}

function joinRoute(mount, routePath) {
  const left = normalizePath(mount);
  const right = routePath === '/' ? '' : normalizePath(routePath);
  return normalizePath(`${left}${right}`);
}

export function discoverRouteCatalog() {
  const indexSource = fs.readFileSync(indexPath, 'utf8');
  const routeImports = new Map();
  for (const match of indexSource.matchAll(/import\s+(\w+)\s+from\s+'\.\/routes\/([^']+)\.js';/g)) {
    routeImports.set(match[1], match[2]);
  }

  const mounts = [];
  const mountPattern = /^app\.use\(\s*'([^']+)'\s*,\s*(.*?)\);$/gm;
  for (const match of indexSource.matchAll(mountPattern)) {
    const mountPath = match[1];
    const args = match[2];
    const alias = args.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? null;
    const routeFile = alias ? routeImports.get(alias) ?? null : null;
    mounts.push({
      mountPath: normalizePath(mountPath),
      alias,
      routeFile,
      kind: routeFile ? 'router' : args.includes('express.static') ? 'static' : 'middleware',
    });
  }

  const directOperationPattern = /^app\.(get|post|put|patch|delete|options|head)\s*\(\s*(['"])([^'"]+)\2/gm;
  for (const match of indexSource.matchAll(directOperationPattern)) {
    const routePath = normalizePath(match[3]);
    mounts.push({ mountPath: routePath, alias: 'app', routeFile: 'index', kind: 'direct' });
  }

  const operations = [];
  for (const mount of mounts.filter((item) => item.kind === 'router')) {
    const routePath = path.join(serverRoot, 'src', 'routes', `${mount.routeFile}.ts`);
    const source = fs.readFileSync(routePath, 'utf8');
    const operationPattern = /router\.(get|post|put|patch|delete|options|head)\s*\(\s*(['"])([^'"]+)\2/g;
    for (const match of source.matchAll(operationPattern)) {
      operations.push({
        method: match[1].toUpperCase(),
        routePath: normalizePath(match[3]),
        path: joinRoute(mount.mountPath, match[3]),
        mountPath: mount.mountPath,
        routeFile: mount.routeFile,
        sourceLine: source.slice(0, match.index).split('\n').length,
      });
    }
  }

  for (const match of indexSource.matchAll(directOperationPattern)) {
    operations.push({
      method: match[1].toUpperCase(),
      routePath: normalizePath(match[3]),
      path: normalizePath(match[3]),
      mountPath: normalizePath(match[3]),
      routeFile: 'index',
      sourceLine: indexSource.slice(0, match.index).split('\n').length,
    });
  }

  return {
    source: 'server/src/index.ts and server/src/routes/*.ts',
    mounts,
    operations,
  };
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(discoverRouteCatalog(), null, 2)}\n`);
}
