import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const inputPath = path.join(repoRoot, 'contracts', 'openapi', 'openapi.json');
const generatedPath = path.join(repoRoot, 'src', 'api', 'generated', 'openapi.d.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerolink-openapi-'));
const expectedPath = path.join(tempDir, 'openapi.d.ts');
const configPath = path.join(tempDir, 'redocly.yaml');
const cliPath = path.join(repoRoot, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
const inputSpecifier = path.relative(repoRoot, inputPath).replaceAll('\\', '/');

function failContract(message) {
  console.error(`OpenAPI multi-line contract failed: ${message}`);
  process.exit(1);
}

function assertContractShape(contract) {
  const schemas = contract.components?.schemas ?? {};
  const refName = (value) => value?.$ref?.split('/').pop();
  const hasRef = (schema, name) => (schema?.oneOf ?? []).some((branch) => refName(branch) === name);
  const scalarDemandFields = ['partNumber', 'quantity', 'unitPrice', 'costPrice', 'costSourceType', 'costSourceId', 'costSourceReason'];

  if (!hasRef(schemas.RfqCreateRequest, 'RfqLegacyCreateRequest') || !hasRef(schemas.RfqCreateRequest, 'RfqMultiLineCreateRequest')) {
    failContract('RfqCreateRequest must retain legacy and modern branches');
  }
  if (!hasRef(schemas.RfqUpdateRequest, 'RfqLegacyUpdateRequest') || !hasRef(schemas.RfqUpdateRequest, 'RfqMultiLineUpdateRequest')) {
    failContract('RfqUpdateRequest must retain legacy and modern branches');
  }
  const rfqModern = schemas.RfqMultiLineCreateRequest;
  if (rfqModern?.properties?.lines?.minItems !== 1 || rfqModern?.properties?.lines?.maxItems !== 100) {
    failContract('RfqMultiLineCreateRequest.lines must be bounded to 1..100');
  }
  if (scalarDemandFields.some((field) => Object.hasOwn(rfqModern?.properties ?? {}, field))) {
    failContract('RfqMultiLineCreateRequest must not expose scalar demand fields');
  }

  if (!hasRef(schemas.QuotationCreateRequest, 'QuotationLegacyCreateRequest') || !hasRef(schemas.QuotationCreateRequest, 'QuotationMultiLineCreateRequest')) {
    failContract('QuotationCreateRequest must retain legacy and modern branches');
  }
  const quotationModern = schemas.QuotationMultiLineCreateRequest;
  if (quotationModern?.properties?.currency?.const !== 'USD' || quotationModern?.properties?.lines?.minItems !== 1 || quotationModern?.properties?.lines?.maxItems !== 100) {
    failContract('QuotationMultiLineCreateRequest must require USD and bounded lines');
  }
  if (scalarDemandFields.some((field) => Object.hasOwn(quotationModern?.properties ?? {}, field))) {
    failContract('QuotationMultiLineCreateRequest must not expose scalar demand or cost fields');
  }
  const lineCreate = schemas.QuotationLineCreateRequest;
  if (!lineCreate?.required?.includes('rfqLineId') || !lineCreate?.required?.includes('costSourceType')) {
    failContract('QuotationLineCreateRequest must require RFQ line and cost source identity');
  }

  const accept = schemas.QuotationAcceptRequest;
  if (!accept?.properties?.lines || !accept?.allOf?.some((entry) => entry.oneOf?.some((branch) => branch.required?.includes('version') && branch.required?.includes('lines')))) {
    failContract('QuotationAcceptRequest modern branch must require version and lines');
  }

  for (const [name, lineName] of [['Quotation', 'QuotationLine'], ['Order', 'OrderLine']]) {
    const resource = schemas[name];
    if (resource?.properties?.lineItemsMode?.type !== 'boolean' || refName(resource?.properties?.lines?.items) !== lineName) {
      failContract(`${name} must expose lineItemsMode and ordered ${lineName} lines`);
    }
  }
  for (const field of ['unitPrice', 'lineTotal']) {
    if (schemas.QuotationLine?.properties?.[field]?.type !== 'string' || schemas.OrderLine?.properties?.[field]?.type !== 'string') {
      failContract(`QuotationLine and OrderLine ${field} must serialize Decimal values as strings`);
    }
  }
}

try {
  assertContractShape(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  // Do not inherit the repository Redocly multi-API config here: it is useful
  // for linting, but openapi-typescript would otherwise require a per-API
  // output entry and ignore the temporary output path.
  fs.writeFileSync(configPath, 'extends: []\n', 'utf8');
  const result = spawnSync(process.execPath, [cliPath, inputSpecifier, '-o', expectedPath, '--redocly', configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`Unable to run openapi-typescript: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);

  if (!fs.existsSync(generatedPath)) {
    console.error(`Generated client types are missing: ${path.relative(repoRoot, generatedPath)}`);
    process.exit(1);
  }

  const normalize = (value) => value.replace(/\r\n/g, '\n').trimEnd();
  const expected = normalize(fs.readFileSync(expectedPath, 'utf8'));
  const actual = normalize(fs.readFileSync(generatedPath, 'utf8'));
  if (expected !== actual) {
    console.error('OpenAPI generated types are out of date. Run npm run api:generate.');
    process.exit(1);
  }
  console.log('OpenAPI generated types are up to date.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
