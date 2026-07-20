import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domains = ['rfqs', 'quotations', 'orders', 'inventory', 'customers', 'suppliers', 'integrations'];
const errors = [];

// Core pages must consume their domain's public feature entry. The compatibility
// hooks remain available to cross-domain/legacy screens, but the six migrated
// pages cannot silently regress to importing their own domain from useApi.
const corePageImports = {
  'src/sections/RFQManagement/index.tsx': ['useCreateRFQ', 'useRFQs', 'useUpdateRFQ', 'useUpdateRFQStatus'],
  'src/sections/Quotations/index.tsx': ['useAcceptQuotation', 'useApproveQuotation', 'useCreateQuotation', 'useQuotation', 'useQuotations', 'useSendQuotation', 'useWithdrawQuotation'],
  'src/sections/Orders/index.tsx': ['useOrders', 'useUpdateOrder'],
  'src/sections/Inventory/index.tsx': ['useCreateInventory', 'useInventory', 'useUpdateInventory'],
  'src/sections/Customers/index.tsx': ['useCreateCustomer', 'useCustomers', 'useUpdateCustomer'],
  'src/sections/Suppliers/index.tsx': ['useCreateSupplier', 'useSuppliers', 'useUpdateSupplier'],
};

// Cross-domain hooks used by the core pages must also come from the owning
// feature's public entry. Documents and notifications are now exposed by the
// integrations feature; legacy transaction helpers remain explicitly allowed
// until their own feature slice is migrated.
const migratedCrossDomainHooks = {
  'src/sections/RFQManagement/index.tsx': ['useCustomers', 'useSuppliers'],
  'src/sections/Quotations/index.tsx': ['useRFQs'],
  'src/sections/Orders/index.tsx': ['useInventoryItemByPartNumber', 'useInventoryTransactionsByOrder', 'useCreateInventoryReservation', 'useCreateOutbound'],
  'src/sections/Customers/index.tsx': ['useQuotations'],
  'src/sections/IngestionHub/index.tsx': ['useRFQs', 'useCreateRFQ', 'useCustomers'],
};

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(filePath);
    return /\.(ts|tsx)$/.test(entry.name) ? [filePath] : [];
  });
}

for (const filePath of walk(path.join(repoRoot, 'src'))) {
  const relative = path.relative(repoRoot, filePath).replaceAll('\\', '/');
  const source = fs.readFileSync(filePath, 'utf8');

  const forbiddenCoreHooks = corePageImports[relative];
  const legacyImport = source.match(/import\s*{([\s\S]*?)}\s*from\s*['"]@\/hooks\/useApi['"]/);
  if (forbiddenCoreHooks && legacyImport) {
    for (const hook of forbiddenCoreHooks) {
      if (new RegExp(`\\b${hook}\\b`).test(legacyImport[1])) {
        errors.push(`${relative}: core page must import ${hook} from its feature public entry, not @/hooks/useApi`);
      }
    }
  }

  const migratedCrossDomain = migratedCrossDomainHooks[relative];
  if (migratedCrossDomain && legacyImport) {
    for (const hook of migratedCrossDomain) {
      if (new RegExp(`\\b${hook}\\b`).test(legacyImport[1])) {
        errors.push(`${relative}: migrated cross-domain hook ${hook} must import from its feature public entry`);
      }
    }
  }

  const insideDomain = relative.match(/^src\/features\/([^/]+)\//)?.[1];

  for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(@\/features\/[^'"`]+)\1/g)) {
    const importPath = match[2].replace(/^@\/features\//, '');
    const [importDomain, ...suffix] = importPath.split('/');
    if (!domains.includes(importDomain)) continue;

    if (insideDomain && importDomain !== insideDomain) {
      errors.push(`${relative}: cross-feature import @/features/${importPath}`);
    }
    if (!insideDomain && suffix.length > 0) {
      errors.push(`${relative}: feature internals must be imported through @/features/${importDomain}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Feature boundary check failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Feature boundaries OK: ${domains.length} public feature entry points checked.`);
}
