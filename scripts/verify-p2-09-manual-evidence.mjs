import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_CHECKS = ['A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19'];
const SENSITIVE_KEY = /password|secret|token|authorization|cookie|private[_-]?key|api[_-]?key|payload|email[_-]?body/i;
const SENSITIVE_VALUE = /-----BEGIN|\bBearer\s+|(?:password|secret|token|api[_-]?key)\s*[:=]/i;

function parseArgs(argv) {
  const values = new Map();
  let positional;
  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      if (argument !== '--' && !positional) positional = argument;
      continue;
    }
    const [key, value = 'true'] = argument.slice(2).split('=', 2);
    values.set(key, value);
  }
  const evidence = values.get('evidence') || positional;
  if (!evidence) throw new Error('--evidence=<path> (or a positional path) is required');
  return { evidencePath: path.resolve(evidence) };
}

function addError(errors, message) {
  errors.push(message);
}

function scanForSensitiveData(value, location, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSensitiveData(item, `${location}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && SENSITIVE_VALUE.test(value)) addError(errors, `${location} contains a credential-like value`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (SENSITIVE_KEY.test(key)) addError(errors, `${childLocation} is not allowed in manual evidence`);
    scanForSensitiveData(child, childLocation, errors);
  }
}

function requiredString(value, field, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    addError(errors, `${field} is required`);
    return undefined;
  }
  return value.trim();
}

function parseDate(value, field, errors) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    addError(errors, `${field} must be an ISO-8601 timestamp`);
    return undefined;
  }
  return Date.parse(value);
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || value.includes('\0')) return false;
  return !value.split(/[\\/]/u).some((segment) => segment === '..');
}

export function verifyEvidence(evidence) {
  const errors = [];
  scanForSensitiveData(evidence, '$', errors);

  if (evidence?.schemaVersion !== 1) addError(errors, 'schemaVersion must be 1');
  const executor = requiredString(evidence?.executor, 'executor', errors);
  const browser = requiredString(evidence?.browser, 'browser', errors);
  const evidenceRoot = requiredString(evidence?.evidenceRoot, 'evidenceRoot', errors);
  const executedAt = parseDate(evidence?.executedAt, 'executedAt', errors);
  if (evidenceRoot && !isSafeRelativePath(evidenceRoot)) addError(errors, 'evidenceRoot must be a safe relative path');

  const viewport = evidence?.viewport;
  if (!Number.isInteger(viewport?.width) || viewport.width <= 0) addError(errors, 'viewport.width must be a positive integer');
  if (!Number.isInteger(viewport?.height) || viewport.height <= 0) addError(errors, 'viewport.height must be a positive integer');

  const checks = Array.isArray(evidence?.checks) ? evidence.checks : [];
  if (checks.length !== REQUIRED_CHECKS.length) addError(errors, `checks must contain exactly ${REQUIRED_CHECKS.length} entries`);
  const seen = new Set();
  const passedChecks = [];

  checks.forEach((check, index) => {
    const location = `checks[${index}]`;
    const id = requiredString(check?.id, `${location}.id`, errors);
    if (id) {
      if (!REQUIRED_CHECKS.includes(id)) addError(errors, `${location}.id must be one of ${REQUIRED_CHECKS.join(', ')}`);
      if (seen.has(id)) addError(errors, `${location}.id is duplicated`);
      seen.add(id);
    }
    requiredString(check?.page, `${location}.page`, errors);
    for (const field of ['zoom200', 'zoom400', 'keyboardReadingOrder']) {
      if (check?.[field] !== 'pass') addError(errors, `${location}.${field} must be pass`);
    }
    if (!Array.isArray(check?.evidence) || check.evidence.length === 0) {
      addError(errors, `${location}.evidence must contain at least one relative path`);
    } else {
      check.evidence.forEach((evidencePath, evidenceIndex) => {
        if (!isSafeRelativePath(evidencePath)) addError(errors, `${location}.evidence[${evidenceIndex}] must be a safe relative path`);
      });
    }
    if (id && REQUIRED_CHECKS.includes(id) && !errors.some((error) => error.startsWith(`${location}.`))) {
      passedChecks.push(id);
    }
  });

  for (const id of REQUIRED_CHECKS) if (!seen.has(id)) addError(errors, `missing manual check ${id}`);
  if (executedAt !== undefined && executedAt > Date.now() + 5 * 60 * 1000) addError(errors, 'executedAt cannot be materially in the future');

  return {
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    schemaVersion: 1,
    executor,
    browser,
    evidenceRoot,
    executedAt: executedAt === undefined ? undefined : new Date(executedAt).toISOString(),
    viewport: viewport && Number.isInteger(viewport.width) && Number.isInteger(viewport.height)
      ? { width: viewport.width, height: viewport.height }
      : undefined,
    passedChecks: passedChecks.sort(),
    errors,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = JSON.parse(await fs.readFile(options.evidencePath, 'utf8'));
  const result = verifyEvidence(evidence);
  console.log(JSON.stringify({ evidence: options.evidencePath, ...result }, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
