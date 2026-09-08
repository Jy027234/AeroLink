import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

const mode = requiredArgument('--mode');
if (!['production', 'development'].includes(mode)) {
  throw new Error(`Unsupported audit mode ${mode}; use production or development`);
}

const packageDirectory = path.resolve(repositoryRoot, argument('--package-dir', '.'));
const label = requiredArgument('--label');
const outputDirectory = path.resolve(repositoryRoot, requiredArgument('--output-dir'));
await mkdir(outputDirectory, { recursive: true });

const npmArguments = [
  'audit',
  '--registry=https://registry.npmjs.org',
  '--json',
  '--package-lock-only',
  mode === 'production' ? '--omit=dev' : '--include=dev',
];

const result = await new Promise((resolve, reject) => {
  const child = spawn(npmCommand, npmArguments, {
    cwd: packageDirectory,
    env: { ...process.env, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' },
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
});

const prefix = `${label}-${mode}`;
await writeFile(path.join(outputDirectory, `${prefix}.json`), result.stdout, 'utf8');
await writeFile(path.join(outputDirectory, `${prefix}.stderr.log`), result.stderr, 'utf8');

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch {
  parsed = null;
}

const metadata = parsed?.metadata?.vulnerabilities ?? null;
const evidence = {
  package: label,
  packageDirectory,
  mode,
  command: `${npmCommand} ${npmArguments.join(' ')}`,
  exitCode: result.code,
  signal: result.signal,
  vulnerabilities: metadata,
  generatedAt: new Date().toISOString(),
};
await writeFile(path.join(outputDirectory, `${prefix}.summary.json`), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

if (metadata) {
  console.log(`${label} ${mode} audit: ${metadata.total ?? 0} vulnerabilities (high=${metadata.high ?? 0}, critical=${metadata.critical ?? 0})`);
} else {
  console.error(`${label} ${mode} audit did not return a JSON report; inspect ${prefix}.stderr.log`);
}

if (result.code !== 0) process.exitCode = result.code;
