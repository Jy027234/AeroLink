#!/bin/sh
set -eu

mkdir -p /app/prisma/data /app/uploads

schema_path="${PRISMA_SCHEMA_PATH:-prisma/schema.prisma}"

npx prisma db push --schema "$schema_path"

should_seed="$(node --input-type=module <<'NODE'
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  const count = await prisma.user.count();
  process.stdout.write(count === 0 ? '1' : '0');
} finally {
  await prisma.$disconnect();
}
NODE
)"

if [ "$should_seed" = "1" ]; then
  npm run db:seed
fi

exec npm start
