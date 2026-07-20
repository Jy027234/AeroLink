import { PrismaClient } from '@prisma/client';
import { recordDatabaseQuery } from './metrics.js';

type PrismaObservabilityOptions = {
  log: [
    { emit: 'event'; level: 'query' },
    { emit: 'event'; level: 'error' },
  ];
};
type ObservabilityPrismaClient = PrismaClient<PrismaObservabilityOptions>;

const globalForPrisma = globalThis as unknown as {
  prisma: ObservabilityPrismaClient | undefined;
};

const prisma = globalForPrisma.prisma ?? new PrismaClient<PrismaObservabilityOptions>({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
  ],
});

if (!globalForPrisma.prisma) {
  prisma.$on('query', (event) => recordDatabaseQuery(event.duration));
  prisma.$on('error', () => recordDatabaseQuery(0, 'error'));
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
