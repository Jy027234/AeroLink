import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRouteCatalog } from './route-catalog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractPath = path.join(repoRoot, 'contracts', 'openapi', 'openapi.json');
const strict = process.argv.includes('--strict');

function toOpenApiPath(value) {
  return value.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function endpointKey(method, routePath) {
  return `${method.toUpperCase()} ${toOpenApiPath(routePath)}`;
}

function fail(message) {
  console.error(`OpenAPI route coverage failed: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(contractPath)) {
  fail(`missing ${path.relative(repoRoot, contractPath)}`);
} else {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const catalog = discoverRouteCatalog();
  const documented = new Map();
  const duplicateOperationIds = [];

  for (const [routePath, pathItem] of Object.entries(contract.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (method.startsWith('x-') || method === 'parameters' || method === '$ref') continue;
      const key = `${method.toUpperCase()} ${routePath}`;
      if (documented.has(key)) documented.get(key).push(operation);
      else documented.set(key, [operation]);
    }
  }

  const operationIds = new Set();
  for (const [key, entries] of documented) {
    for (const operation of entries) {
      if (!operation?.operationId) fail(`${key} has no operationId`);
      if (operation?.operationId && operationIds.has(operation.operationId)) duplicateOperationIds.push(operation.operationId);
      if (operation?.operationId) operationIds.add(operation.operationId);
      if (!operation?.responses || Object.keys(operation.responses).length === 0) fail(`${key} has no responses`);
      if (!operation?.['x-aerolink-source']?.file) fail(`${key} has no x-aerolink-source`);
      if (operation?.['x-aerolink-contract-status'] === 'inventory') {
        if (!operation?.['x-aerolink-owner']) fail(`${key} inventory operation has no x-aerolink-owner`);
        if (!operation?.['x-aerolink-deferred-reason']) fail(`${key} inventory operation has no x-aerolink-deferred-reason`);
      }
    }
  }
  if (duplicateOperationIds.length > 0) fail(`duplicate operationId: ${duplicateOperationIds.join(', ')}`);

  const expected = new Map(catalog.operations.map((endpoint) => [endpointKey(endpoint.method, endpoint.path), endpoint]));
  const missing = [...expected.keys()].filter((key) => !documented.has(key));
  const unexpected = [...documented.keys()].filter((key) => !expected.has(key));
  if (missing.length > 0) fail(`missing ${missing.length} route operations; first: ${missing.slice(0, 10).join(', ')}`);
  if (unexpected.length > 0) fail(`found ${unexpected.length} undocumented operations; first: ${unexpected.slice(0, 10).join(', ')}`);

  const missingMounts = catalog.mounts
    .filter((mount) => mount.kind === 'router')
    .filter((mount) => !catalog.operations.some((endpoint) => endpoint.mountPath === mount.mountPath));
  if (missingMounts.length > 0) fail(`router mounts without discoverable operations: ${missingMounts.map((mount) => mount.mountPath).join(', ')}`);

  const inventory = [...documented.entries()]
    .filter(([, entries]) => entries.some((operation) => operation?.['x-aerolink-contract-status'] === 'inventory'))
    .map(([key]) => key);
  if (strict && inventory.length > 0) fail(`${inventory.length} operations remain inventory-only; first: ${inventory.slice(0, 10).join(', ')}`);

  if (process.exitCode !== 1) {
    console.log(`OpenAPI route coverage OK: ${expected.size} operations, ${catalog.mounts.length} mounts, ${inventory.length} inventory-only`);
  }
}
