import fs from 'node:fs/promises';
import path from 'node:path';

const SENSITIVE_KEY = /password|secret|token|authorization|cookie|private[_-]?key|api[_-]?key|payload|email[_-]?body/i;
const SENSITIVE_VALUE = /-----BEGIN|\bBearer\s+|(?:password|secret|token|api[_-]?key)\s*[:=]/i;
const SHA256 = /^[a-f0-9]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

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
    if (SENSITIVE_KEY.test(key)) addError(errors, `${childLocation} is not allowed in retention evidence`);
    scanForSensitiveData(child, childLocation, errors);
  }
}

function parseDate(value, field, errors) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    addError(errors, `${field} must be an ISO-8601 timestamp`);
    return undefined;
  }
  return Date.parse(value);
}

function positiveInteger(value, field, errors) {
  if (!Number.isInteger(value) || value <= 0) {
    addError(errors, `${field} must be a positive integer`);
    return undefined;
  }
  return value;
}

function verifyEvidence(evidence) {
  const errors = [];
  scanForSensitiveData(evidence, '$', errors);

  if (evidence?.schemaVersion !== 1) addError(errors, 'schemaVersion must be 1');
  if (typeof evidence?.environment !== 'string' || !evidence.environment.trim()) addError(errors, 'environment is required');
  if (typeof evidence?.releaseSha !== 'string' || !FULL_SHA.test(evidence.releaseSha)) addError(errors, 'releaseSha must be a full lowercase Git SHA');
  const capturedAt = parseDate(evidence?.capturedAt, 'capturedAt', errors);

  const collector = evidence?.collector;
  if (!collector || typeof collector.name !== 'string' || !collector.name.trim()) addError(errors, 'collector.name is required');
  let collectorOrigin;
  if (typeof collector?.endpoint !== 'string' || !collector.endpoint.trim()) {
    addError(errors, 'collector.endpoint is required');
  } else {
    try {
      const url = new URL(collector.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        addError(errors, 'collector.endpoint must be an HTTP(S) URL without credentials, query, or fragment');
      } else {
        collectorOrigin = url.origin;
      }
    } catch {
      addError(errors, 'collector.endpoint must be a valid HTTP(S) URL');
    }
  }

  const metricsDays = positiveInteger(evidence?.policy?.metricsRetentionDays, 'policy.metricsRetentionDays', errors);
  const traceHours = positiveInteger(evidence?.policy?.traceRetentionHours, 'policy.traceRetentionHours', errors);
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : [];
  if (checks.length === 0) addError(errors, 'checks must contain at least one deletion probe');
  const requiredSignals = new Set(['metrics', 'traces']);
  const deletedSignals = new Set();
  const sanitizedChecks = [];
  let latestQueryAt = 0;

  checks.forEach((check, index) => {
    const location = `checks[${index}]`;
    if (!requiredSignals.has(check?.signal)) addError(errors, `${location}.signal must be metrics or traces`);
    if (typeof check?.probeHash !== 'string' || !SHA256.test(check.probeHash)) addError(errors, `${location}.probeHash must be a SHA-256 digest`);
    const createdAt = parseDate(check?.createdAt, `${location}.createdAt`, errors);
    const queriedAt = parseDate(check?.queriedAt, `${location}.queriedAt`, errors);
    if (queriedAt !== undefined) latestQueryAt = Math.max(latestQueryAt, queriedAt);
    if (createdAt !== undefined && queriedAt !== undefined) {
      if (queriedAt < createdAt) addError(errors, `${location}.queriedAt cannot precede createdAt`);
      const thresholdMs = check.signal === 'metrics' ? (metricsDays ?? 0) * 24 * 60 * 60 * 1000 : (traceHours ?? 0) * 60 * 60 * 1000;
      const ageMs = queriedAt - createdAt;
      if (check.observed === 'deleted') {
        if (ageMs < thresholdMs) addError(errors, `${location} reports deleted before the configured retention window`);
        deletedSignals.add(check.signal);
      } else if (check.observed === 'retained') {
        if (ageMs >= thresholdMs) addError(errors, `${location} reports retained beyond the configured retention window`);
      } else {
        addError(errors, `${location}.observed must be deleted or retained`);
      }
      sanitizedChecks.push({ signal: check.signal, observed: check.observed, ageHours: Math.round(ageMs / 360000) / 10 });
    }
  });

  for (const signal of requiredSignals) if (!deletedSignals.has(signal)) addError(errors, `a deleted probe is required for ${signal}`);
  if (capturedAt !== undefined && latestQueryAt > capturedAt) addError(errors, 'capturedAt cannot precede a probe query time');
  if (!evidence?.source || typeof evidence.source.kind !== 'string' || typeof evidence.source.reference !== 'string') {
    addError(errors, 'source.kind and source.reference are required');
  }

  return {
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    schemaVersion: 1,
    environment: typeof evidence?.environment === 'string' ? evidence.environment : undefined,
    releaseSha: typeof evidence?.releaseSha === 'string' ? evidence.releaseSha : undefined,
    collector: collectorOrigin ? { name: collector.name, origin: collectorOrigin } : undefined,
    policy: typeof metricsDays === 'number' && typeof traceHours === 'number'
      ? { metricsRetentionDays: metricsDays, traceRetentionHours: traceHours }
      : undefined,
    checks: sanitizedChecks,
    source: evidence?.source ? { kind: evidence.source.kind, reference: evidence.source.reference } : undefined,
    errors,
  };
}

const options = parseArgs(process.argv.slice(2));
const evidence = JSON.parse(await fs.readFile(options.evidencePath, 'utf8'));
const result = verifyEvidence(evidence);
console.log(JSON.stringify({ evidence: options.evidencePath, ...result }, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
