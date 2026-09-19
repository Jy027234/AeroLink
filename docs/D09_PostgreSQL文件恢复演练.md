# D09 PostgreSQL 与关联文件隔离恢复演练

本演练验证当前 PostgreSQL profile 的数据库逻辑备份、关联文件快照和隔离恢复。脚本只写入调用者指定的本地 PostgreSQL 16 测试容器，并在其中创建带 `aerolink_recovery_drill_` / `aerolink_recovery_restore_` 前缀的临时数据库；它不会连接或写入生产库，也不会读取真实上传文件、JWT 密钥或加密密钥。

## 运行边界

- `D09_PG_CONTAINER` 必须明确指定隔离的 `postgres:16` review/test/drill 容器；脚本拒绝未指定容器或看起来像生产容器的名称。
- `D09_PG_ADMIN_DB` 默认是 `aerolink_review`，只用于创建和删除演练数据库。不要把生产数据库名传给该变量。
- 演练工作目录默认在系统临时目录，且必须位于仓库外；脚本只认领一个本次新建的目录，任何预先存在的路径都会被拒绝，避免误删已有文件。
- 默认 `D09_KEEP` 未开启，演练结束会删除脚本创建的两个数据库和临时文件。设置 `D09_KEEP=true` 只用于保留合成证据，结束后应按输出的数据库名和目录单独清理。

## 可复现命令

在本地已运行的 PostgreSQL 16 测试容器上执行：

```powershell
$env:D09_PG_CONTAINER = 'aerolink-review-test-20260908'
$env:D09_PG_USER = 'aerolink_test'
$env:D09_PG_ADMIN_DB = 'aerolink_review'
Push-Location server
node --import tsx src/scripts/checkRecoveryDrill.ts
Pop-Location
```

Linux/macOS 使用同一个脚本：

```bash
export D09_PG_CONTAINER=aerolink-review-test-20260908
export D09_PG_USER=aerolink_test
export D09_PG_ADMIN_DB=aerolink_review
(cd server && node --import tsx src/scripts/checkRecoveryDrill.ts)
```

脚本会：

1. 检查容器镜像和服务版本确实是 PostgreSQL 16。
2. 在新建源库执行当前 `server/prisma/migrations` 的完整 `prisma migrate deploy`，再通过 Prisma Client 写入真实应用模型的合成关联数据：User、Customer、Supplier、Inventory/InventoryItem/InventoryDetail、RFQ、SupplierQuote、Quotation、Approval、Order、InventoryTransaction 和 StoredObject。
3. 对源库执行 `pg_dump --format=custom`，对两个合成附件创建文件快照，并记录每个文件的大小和 SHA-256；同时以现有库存与金额 shadow 对账逻辑校验源数据。
4. 删除并篡改源文件，创建独立恢复库，用 `pg_restore` 恢复数据库，用快照恢复文件。
5. 用 Prisma Client 读回恢复库的业务模型与迁移历史，比对数据库行、库存/金额对账、附件元数据、恢复文件数量/总字节/SHA-256，并确认备份后的篡改文件没有进入恢复结果。

成功时输出 `status: "PASS"`，并包含迁移状态、实际应用模型读回结果、数据库 dump 的大小/SHA-256、文件 manifest 和恢复检查结果。`D09_KEEP=true` 时，同时保留 `recovery-report.json` 供审阅；该报告只含合成数据和临时路径。若容器没有 `POSTGRES_PASSWORD` 环境变量，可显式提供 `D09_PG_PASSWORD`；密码不会写入报告。

## 已取得的隔离证据

2026-09-08 在 `aerolink-review-test-20260908`（`postgres:16-alpine`，PostgreSQL 16.14）完成一次真实应用 schema 演练（run `20260908043415_052523e7`）。本次源库为 `aerolink_recovery_drill_20260908043415_052523e7`，恢复库为 `aerolink_recovery_restore_20260908043415_052523e7`，随后已删除；`aerolink_review` 与其他已有测试库未被改写。源库执行并恢复了当前 19 条 Prisma migration，业务链路记录通过 Prisma Client 读回。

- 数据库 dump：193383 bytes，SHA-256 `c00e924675a830b106c4ef0f0a9d07b7da9b878ba538c7372307c5a39ce24f40`
- 关联文件：2 个，135 bytes；源、备份、恢复 manifest SHA-256 均为 `b4fbc7061425877eb0ffbdc5006380f9060d1065e5059661bc8dc2a2585a10fe`
- 迁移历史、真实应用模型读回、数据库行、库存对账、金额 shadow 对账、附件元数据、文件字节和备份后篡改隔离检查均为 `true`

这证明演练脚本和恢复路径可复现，不等同于真实历史业务库或生产对象存储的完整性验收。真实验收仍需在批准的隔离环境使用实际 PostgreSQL dump、实际对象/文件 manifest 和必要的加密配置恢复；生产密钥不得复制到仓库或本地演练目录。

## 现有运维文档的数据库边界

正式 PostgreSQL profile 的数据库备份应使用 `pg_dump`（发布记录中的 `DB_BACKUP` 也是 PostgreSQL dump），关联文件应按当前对象存储驱动备份：本地驱动备份 `backend-uploads` 卷，S3-compatible 驱动使用对象存储自身的版本/备份策略，再用 `storage:verify-manifest` 做逐对象 SHA/大小核验。`secrets/encryption_key.txt` 属于部署密钥，须由受控的密钥/备份系统单独保管并在恢复窗口注入。

`aerolink-prod_backend-data`、`prod.db`、`prisma db push --schema prisma/schema.sqlite.prisma` 以及对 SQLite 数据卷执行 `find ... -delete && tar ...` 的命令，只适用于仍在运行的 SQLite 兼容过渡 profile 和正式 PostgreSQL 切库前的 SQLite 副本。它们不能作为 PostgreSQL 运行态的数据库备份或恢复步骤；请在 [生产运维手册](生产运维手册.md) 中按 profile 选择命令，先在隔离环境完成本演练再安排真实恢复。
