import { loadJsonConfigurationShadowReconciliation } from '../lib/jsonConfigurationShadows.js';

const result = await loadJsonConfigurationShadowReconciliation();
console.log(JSON.stringify(result, null, 2));

if (result.status !== 'PASS') {
  process.exitCode = 1;
}
