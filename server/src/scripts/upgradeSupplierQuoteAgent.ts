import prisma from '../lib/prisma.js';
import { upgradeSupplierQuoteAgent } from '../lib/upgradeSupplierQuoteAgent.js';

const argument = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

try {
  const result = await upgradeSupplierQuoteAgent({
    apply: process.argv.includes('--apply'),
    expectedVersion: Number(argument('expected-version')),
    expectedPromptsSha256: argument('expected-sha256') ?? '',
  });
  // Only version/hash metadata is logged. No prompts, model config or credentials.
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Extraction agent upgrade failed');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
