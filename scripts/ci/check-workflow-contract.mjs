import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'ci.yml');
const workflow = await readFile(workflowPath, 'utf8');
const auditScript = await readFile(path.join(repositoryRoot, 'scripts', 'ci', 'run-npm-audit.mjs'), 'utf8');
const errors = [];

function jobSection(jobId) {
  const start = workflow.search(new RegExp(`^  ${jobId}:\\s*$`, 'm'));
  if (start < 0) return '';
  const remainder = workflow.slice(start + 1);
  const end = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return end < 0 ? remainder : remainder.slice(0, end);
}

const requiredNodeVersion = '22.23.2';
const requiredNodeRange = '>=22.23.2 <23';
const exactNodeSetupCount = (workflow.match(/node-version:\s*['"]22\.23\.2['"]/g) ?? []).length;
if (exactNodeSetupCount < 5) errors.push(`expected exact Node ${requiredNodeVersion} setup in every Node job, found ${exactNodeSetupCount}`);

const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const serverPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'server', 'package.json'), 'utf8'));
for (const [label, packageJson] of [['root', rootPackage], ['server', serverPackage]]) {
  if (packageJson.engines?.node !== requiredNodeRange) errors.push(`${label} package must declare ${requiredNodeRange}`);
}

const auditFrontend = jobSection('audit_frontend');
const auditBackend = jobSection('audit_backend');
for (const [label, section] of [['frontend', auditFrontend], ['backend', auditBackend]]) {
  if (!section) errors.push(`missing audit job ${label}`);
  for (const token of ['--mode production', '--mode development', 'continue-on-error: true', 'actions/upload-artifact@v4']) {
    if (!section.includes(token)) errors.push(`${label} audit job must retain ${token}`);
  }
}
for (const token of ['--omit=dev', '--include=dev', '--package-lock-only', 'https://registry.npmjs.org']) {
  if (!auditScript.includes(token)) errors.push(`audit helper must retain ${token}`);
}

for (const [label, jobId] of [['backend', 'backend'], ['frontend', 'frontend']]) {
  const section = jobSection(jobId);
  if (!section) errors.push(`missing functional job ${label}`);
  if (section.includes('npm audit')) errors.push(`${label} functional job must not be blocked by dependency audit`);
  if (!section.includes('check-node-runtime.mjs')) errors.push(`${label} functional job must verify the Node runtime`);
}

const e2e = jobSection('e2e');
if (!e2e.includes('needs: [backend, frontend]')) errors.push('E2E must depend on backend and frontend functional jobs');
if (e2e.includes('continue-on-error:')) errors.push('E2E must retain hard dependency and test failures');

const releaseGate = jobSection('release_gate');
if (!releaseGate.includes('if: always()')) errors.push('release gate must run when an upstream job fails or is skipped');
for (const jobId of ['secret_scan', 'ci_contract', 'audit_frontend', 'audit_backend', 'backend', 'frontend', 'e2e']) {
  if (!releaseGate.includes(jobId)) errors.push(`release gate must include ${jobId}`);
}
for (const token of ['needs.audit_frontend.outputs.production', 'needs.audit_frontend.outputs.development', 'needs.audit_backend.outputs.production', 'needs.audit_backend.outputs.development']) {
  if (!releaseGate.includes(token)) errors.push(`release gate must evaluate ${token}`);
}

if (errors.length > 0) {
  console.error(['CI workflow contract failed:', ...errors.map((error) => `- ${error}`)].join('\n'));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ workflow: path.relative(repositoryRoot, workflowPath), nodeSetupCount: exactNodeSetupCount, status: 'pass' }));
}
