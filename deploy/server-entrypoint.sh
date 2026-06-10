#!/bin/sh
set -eu

mkdir -p /app/data /app/uploads

first_boot=0
if [ ! -f /app/data/prod.db ]; then
  first_boot=1
fi

npx prisma db push

if [ "$first_boot" = "1" ]; then
  npm run db:seed
fi

exec npm start