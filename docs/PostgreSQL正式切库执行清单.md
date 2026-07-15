# PostgreSQL 正式切库执行清单

本文档用于把当前云端 SQLite 兼容运行态正式迁移到 PostgreSQL profile。当前生产入口为 `http://101.43.50.30:8080`，应用目录为 `/home/ubuntu/aerolink-prod`。

## 当前结论

- 生产现网仍运行 SQLite 兼容 profile：`docker-compose.prod.sqlite.yml`。
- PostgreSQL profile 已在仓库内准备好：`docker-compose.prod.yml`。
- 真实生产 SQLite 备份已完成过离线彩排，导入 PostgreSQL 成功。
- 彩排已验证登录、健康检查、鉴权邮件记录接口，以及历史字段回填结果。
- 当前仓库迁移目录仍以增量迁移为主；正式切库前必须在备份/演练环境完成 baseline 解析，不能直接让生产入口在未确认时执行 `migrate deploy`。

## 停机窗口建议

建议预留 30-60 分钟窗口。以当前数据量看，实际数据迁移只需要数分钟，但需要给备份、验证、回滚决策留余量。

切库期间暂停用户访问，避免 SQLite 旧库继续写入。最简单的方式是停止当前 compose stack；如果需要展示维护页，可先准备 Nginx 静态维护页后再停后端。

## 前置检查

在服务器上进入应用目录：

```bash
cd /home/ubuntu/aerolink-prod
```

确认必要文件存在：

```bash
test -f docker-compose.prod.sqlite.yml
test -f docker-compose.prod.yml
test -f .env.production
test -f secrets/encryption_key.txt
test -f deploy/sqlite-legacy-backfill.sql
test -f server/prisma/schema.prisma
test -f server/prisma/schema.sqlite.prisma
test -f server/src/scripts/prepareLegacySqlite.ts
test -f server/src/scripts/importSqliteToPostgres.ts
```

确认 `.env.production` 至少包含：

```bash
PUBLIC_ORIGIN=https://<生产域名>
JWT_SECRET=<生产 JWT 密钥>
JWT_REFRESH_SECRET=<不同于 JWT_SECRET 的生产刷新密钥>
DB_PASSWORD=<PostgreSQL 强密码>
SCHEMA_MIGRATION_MODE=migrate
MIGRATION_BASELINE_CONFIRMED=false
REQUIRE_ACTIVE_ADMIN=true
```

切换前确认现网健康：

```bash
docker compose --env-file .env.production -f docker-compose.prod.sqlite.yml ps
wget -qO- http://127.0.0.1:8080/api/health
```

## 备份

创建本次迁移备份目录：

```bash
export MIGRATION_TS="$(date +%Y%m%d-%H%M%S)"
export BACKUP_DIR="/home/ubuntu/backups/aerolink-pg-cutover-$MIGRATION_TS"
mkdir -p "$BACKUP_DIR"
```

备份当前代码与环境文件：

```bash
tar czf "$BACKUP_DIR/code.tgz" -C /home/ubuntu aerolink-prod
cp .env.production "$BACKUP_DIR/.env.production"
```

备份 SQLite 数据库卷和上传文件卷：

```bash
docker run --rm -v aerolink-prod_backend-data:/from -v "$BACKUP_DIR":/to alpine sh -lc 'tar czf /to/backend-data.tgz -C /from .'
docker run --rm -v aerolink-prod_backend-uploads:/from -v "$BACKUP_DIR":/to alpine sh -lc 'tar czf /to/backend-uploads.tgz -C /from .'
```

导出当前 SQLite `prod.db` 作为可直接处理的文件：

```bash
docker run --rm -v aerolink-prod_backend-data:/from -v "$BACKUP_DIR":/to alpine sh -lc 'cp /from/prod.db /to/prod-source.db'
cp "$BACKUP_DIR/prod-source.db" "$BACKUP_DIR/prod-prepared.db"
```

## 构建迁移镜像

先构建 backend 镜像，后续准备 SQLite 副本、推送 PostgreSQL schema 和导入数据都使用一次性 backend 容器完成。这样命令会运行在 compose 网络内，不依赖宿主机是否暴露 PostgreSQL 端口。

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml build backend
```

## 准备 SQLite 副本

用一次性 backend 容器处理 SQLite 副本：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml run -T --rm --no-deps \
  --entrypoint sh \
  -v "$BACKUP_DIR:/migration" \
  backend -lc '
    cd /app &&
    SQLITE_DB_PATH=/migration/prod-prepared.db \
    BACKFILL_SQL_PATH=/app/deploy/sqlite-legacy-backfill.sql \
    npm run db:prepare:legacy-sqlite
  '
```

用 SQLite schema 收敛副本结构：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml run -T --rm --no-deps \
  --entrypoint sh \
  -v "$BACKUP_DIR:/migration" \
  backend -lc '
    cd /app &&
    DATABASE_URL=file:/migration/prod-prepared.db \
    npx prisma db push --schema prisma/schema.sqlite.prisma --accept-data-loss --skip-generate
  '
```

这一步会删除历史字段，但删除前已经回填到新字段：

- `customers.address` -> `customers.registeredAddress`
- `quotations.deliveryTerms` -> `quotations.incoterm`
- `quotations.paymentTerms` -> `quotations.commonNote`
- `inventory.status` -> `inventory.conditionCode`
- `inventory.certificateStatus` -> `inventory.certificateType`

## 停止现网写入

确认已经进入停机窗口后停止 SQLite 兼容 stack：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.sqlite.yml down
```

如果停止前后存在业务写入风险，需要重新复制一次 `prod.db` 并重新执行“准备 SQLite 副本”。

## 初始化 PostgreSQL

拉起 PostgreSQL profile，但先不对外验收：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres
```

等待 PostgreSQL ready：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec postgres pg_isready -U aerolink -d aerolink
```

首次导入使用一次性、受控的 schema 准备命令。此处不启动 backend 服务，也不要把 `ALLOW_DB_PUSH=true` 留在正式运行环境：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml run -T --rm --no-deps \
  --entrypoint sh \
  backend -lc '
    cd /app &&
    NODE_ENV=staging \
    ALLOW_DB_PUSH=true \
    npx prisma db push --schema prisma/schema.prisma --skip-generate
  '
```

完成导入后，在同一套备份/演练环境建立并验证 PostgreSQL 迁移基线，执行 `prisma migrate resolve` 或等价的基线流程，并记录演练结果。只有确认基线、备份恢复和 `migrate deploy` 重复演练均成功后，才在 `.env.production` 设置 `MIGRATION_BASELINE_CONFIRMED=true`，再启动 backend。若基线尚未完成，生产入口会主动拒绝启动，避免把不可审计的 `db push` 当成正式迁移。

## 导入 PostgreSQL

导入前确认 PostgreSQL 目标库为空。导入脚本会自动检查目标表是否为空，如果发现已有数据会退出。

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml run -T --rm --no-deps \
  --entrypoint sh \
  -v "$BACKUP_DIR:/migration" \
  backend -lc '
    cd /app &&
    SQLITE_DB_PATH=/migration/prod-prepared.db \
    npm run db:import:sqlite-to-postgres
  '
```

导入成功标志：

```text
SQLite to PostgreSQL import finished successfully
```

## 启动新生产 profile

如果目标库没有活动特权账号，先执行一次管理员 bootstrap。该命令只创建未激活账号并输出一次性激活链接，不写入默认密码：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml run -T --rm --no-deps \
  -e BOOTSTRAP_ADMIN_EMAIL=<管理员邮箱> \
  -e BOOTSTRAP_ADMIN_NAME="平台管理员" \
  --entrypoint sh backend -lc 'npm run db:bootstrap-admin'
```

管理员完成激活并设置密码后，再确认 `.env.production` 中的 `MIGRATION_BASELINE_CONFIRMED=true`，然后启动服务：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

确认服务状态：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
wget -qO- http://127.0.0.1:8080/api/health
```

## 切后验收

外部健康检查：

```bash
curl -fsS https://<生产域名>/api/health
```

登录验证：

```bash
# 先通过一次性管理员初始化命令生成激活链接，并在激活页面设置新密码；
# 此处仅使用管理员自行设置的口令，不使用仓库内置或文档公开的默认密码。
curl -fsS -X POST https://<生产域名>/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<BOOTSTRAP_ADMIN_EMAIL>","password":"<PASSWORD_SET_IN_ACTIVATION>"}'
```

关键数据抽检：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml run -T --rm --no-deps \
  --entrypoint node \
  backend --input-type=module <<'NODE'
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const summary = {
  users: await prisma.user.count(),
  customers: await prisma.customer.count(),
  inventory: await prisma.inventory.count(),
  quotations: await prisma.quotation.count(),
  orders: await prisma.order.count(),
  registeredAddress: await prisma.customer.count({ where: { registeredAddress: { not: null } } }),
  incoterm: await prisma.quotation.count({ where: { incoterm: { not: null } } }),
  certificateType: await prisma.inventory.count({ where: { certificateType: { not: 'NONE' } } }),
};
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect();
NODE
```

建议人工打开页面验证：

- 登录与导航
- 仪表盘
- 客户列表
- 库存列表
- 报价列表与详情
- 订单列表
- 系统设置中的邮箱配置与鉴权邮件记录

## 回滚方案

只要 PostgreSQL profile 尚未通过验收，立即回滚到 SQLite profile。

停止 PostgreSQL profile：

```bash
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.yml down
```

恢复 SQLite 数据卷：

```bash
docker run --rm -v aerolink-prod_backend-data:/target -v "$BACKUP_DIR":/backup alpine sh -lc 'find /target -mindepth 1 -delete && tar xzf /backup/backend-data.tgz -C /target'
```

恢复上传文件卷：

```bash
docker run --rm -v aerolink-prod_backend-uploads:/target -v "$BACKUP_DIR":/backup alpine sh -lc 'find /target -mindepth 1 -delete && tar xzf /backup/backend-uploads.tgz -C /target'
```

恢复 SQLite profile：

```bash
docker compose --env-file .env.production -f docker-compose.prod.sqlite.yml up -d
wget -qO- http://127.0.0.1:8080/api/health
```

如果代码目录也需要回滚：

```bash
cd /home/ubuntu
mv aerolink-prod "aerolink-prod.failed-$MIGRATION_TS"
tar xzf "$BACKUP_DIR/code.tgz" -C /home/ubuntu
cd /home/ubuntu/aerolink-prod
docker compose --env-file .env.production -f docker-compose.prod.sqlite.yml up -d
```

## 切换完成后的收尾

切换成功后：

1. 保留 SQLite 备份至少 7 天。
2. 执行一次 PostgreSQL 逻辑备份：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec postgres \
  pg_dump -U aerolink -d aerolink > "$BACKUP_DIR/postgres-after-cutover.sql"
```

3. 将运维默认 compose 从 `docker-compose.prod.sqlite.yml` 改为 `docker-compose.prod.yml`。
4. 观察后端日志至少 30 分钟：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f backend
```

5. 确认无异常后，再安排清理旧 SQLite volume。不要在切换当天删除旧 volume。
