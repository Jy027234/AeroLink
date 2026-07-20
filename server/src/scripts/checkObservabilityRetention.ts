import assert from 'node:assert/strict';
import { getObservabilityRetentionPolicy } from '../lib/observabilityRetention.js';

const policy = getObservabilityRetentionPolicy();
assert.equal(policy.configured, true, policy.issues.join('; '));
console.log(JSON.stringify({ status: 'PASS', ...policy }));
