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

try {
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
