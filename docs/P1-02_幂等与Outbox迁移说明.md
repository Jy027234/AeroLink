# P1-02：Idempotency-Key 与事务 Outbox

## 目标与边界

本批为核心交易链路提供可重试写入与可靠异步副作用：

| 范围 | 已覆盖的写操作 |
| --- | --- |
| RFQ | 创建、编辑、状态变更 |
| 报价 | 创建、提交、审批/驳回、发送、撤回、客户确认 |
| 订单 | 创建、编辑、状态变更 |
| 外部副作用 | Webhook、Socket.IO、报价邮件和撤回通知 |

库存、供应商门户及其他非核心写接口保持现有行为，留待后续工作包接入。

## Idempotency-Key 合约

核心写接口接受 `Idempotency-Key` 请求头。首个成功请求会与业务变更、状态历史和 Outbox 记录在同一数据库事务中提交。

- 相同用户、相同接口范围、相同请求内容、相同键：返回首次缓存的 HTTP 状态与响应体，不重复写业务数据。
- 同一个键对应不同请求内容：返回 `409 IDEMPOTENCY_KEY_REUSED`。
- 同一个键仍在处理：返回 `409 IDEMPOTENCY_IN_PROGRESS`。
- 回放响应带 `Idempotency-Replayed: true`；服务也回显 `Idempotency-Key`。
- 缓存窗口为 24 小时，过期记录由后台清理。

为平滑兼容历史客户端，缺少该头时请求仍可执行；Web 前端会为所有非认证的变更请求自动生成键，并在鉴权刷新重试时复用同一个键。外部集成应始终自行生成并在网络重试时复用该键。

## Outbox 投递语义

`outbox_events` 与业务实体采用同一个 PostgreSQL 事务。服务进程每 5 秒拉取待处理事件；异常中断超过 5 分钟的锁会自动回收。

| 通道 | 处理方式 |
| --- | --- |
| `WEBHOOK` | 生成带稳定事件 ID 的 `webhook_deliveries`；随后继续沿用现有 Webhook 重试/DLQ 链路。 |
| `SOCKET` | 在提交后异步发送到受控 Socket 房间；Socket 未初始化时按 Outbox 策略重试。 |
| `EMAIL` | 查询数据库中的发件账户后发送 SMTP，不把任何凭据写入 Outbox payload。报价状态只在邮件实际成功后变为 `SENT`。 |

Outbox 采用至少一次投递语义。SMTP 重试会使用稳定的 `Message-ID`，帮助下游邮件系统去重；不能把 SMTP 视为严格的端到端“恰好一次”协议。

运行邮件通道前必须配置 `ENCRYPTION_KEY`：本地环境使用 64 位十六进制的环境变量，Docker/生产环境优先使用 `/run/secrets/encryption_key`。该密钥用于加解密发件账户授权码，不能提交到仓库，也不能在缺失时降级为明文。

报价发送接口现在返回 `202` 与 `emailDeliveryStatus: "queued"`。邮件最终成功后，工作器会更新 `outbound_emails`、推进报价状态并再写入报价已发送的 Webhook/Socket Outbox 事件。最终失败会将邮件记录标为 `FAILED`，并给发起人创建系统通知；管理员或总经理可人工重试。

## 运维与补偿

仅管理员或总经理可访问：

- `GET /api/outbox?page=1&limit=20&status=FAILED&channel=EMAIL`
- `GET /api/outbox/stats`
- `POST /api/outbox/:id/retry`
- `POST /api/outbox/:id/cancel`

重试间隔按指数退避，从 1 秒开始，最长 1 小时；默认最多 5 次。Webhooks 成功入队后由既有 delivery 重试和 DLQ 继续处理，二者的失败域彼此独立。

## 数据库迁移

迁移目录：`server/prisma/migrations/20260716102000_idempotency_outbox`。

它新增：

- `idempotency_records`
- `outbox_events`
- `webhook_deliveries.outboxEventId` 与 `(endpointId, outboxEventId)` 唯一索引

该迁移不改写已有业务行，因此没有数据回填步骤。部署前应先备份，并在应用新版本前完成：

```powershell
cd server
npx prisma migrate deploy --schema prisma/schema.prisma
npx prisma migrate status --schema prisma/schema.prisma
```

回滚应先停掉 Outbox 工作器、确认没有待处理的新事件，再由受控数据库变更删除新增索引、列和表；不要在仍有 `PENDING`、`RETRYING` 或 `PROCESSING` Outbox 记录时直接回滚。

## 验证清单

1. 同一 `Idempotency-Key` 重复创建 RFQ，响应 ID 相同且第二次带回放响应头。
2. 同键不同请求体返回 `409 IDEMPOTENCY_KEY_REUSED`。
3. 创建/状态变更后，同时存在对应 `WEBHOOK` 与 `SOCKET` Outbox 记录。
4. 报价邮件先返回 `202 queued`，SMTP 成功后报价才显示 `sent`。
5. 让 SMTP 或 Webhook 失败，确认 Outbox 重试状态、错误原因和最终邮件失败补偿可见。
