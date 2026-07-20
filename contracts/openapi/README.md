# AeroLink OpenAPI 契约

## 文件职责

- `openapi.json`：OpenAPI 3.1 真相源；覆盖当前 `server/src/index.ts` 注册的 54 个路由 mount、315 个 route operations。
- `../../src/api/generated/openapi.d.ts`：由 `openapi-typescript` 生成，禁止手工编辑。
- `../../src/api/generated/client.ts`：基于生成类型的 `openapi-fetch` 客户端工厂；P2-02 前保留现有 `src/api/client.ts` 兼容层，不在本批替换生产页面。
- `../../scripts/openapi/route-catalog.mjs`：从后端注册入口和 `router.<method>` 定位实际操作，用于漂移检查。
- `../../scripts/openapi/check-route-coverage.mjs`：验证每个实际操作在契约中一一对应、operationId 唯一、响应和来源标记存在。

## 当前状态

P2-01 已完成契约真相源和自动覆盖门禁：当前 315 个 operation 全部为真实 DTO-specific 契约，覆盖核心六域及证书/文档、Webhook（含 Phase 2）、入站 Webhook、Outbox、健康检查、指标、受控文件下载、dashboard、notifications、reports、upload、inventory-items、inventory-transactions、shipment-tracking、inquiries、notification-preferences、channel-bindings、push、版本化只读 API、用户/邮件/邮箱账户、managed-user onboarding、supplier follow-up log、supplier quote/comparison、audit administration、API key、feature availability、IPC reference、pricing、inventory analytics、consignment、FMV、exchange/VMI、workflow、email-sync、blockchain、agent/model、AI 和 auction。当前不存在 `baseline-json-envelope` 或 inventory-only operation。

核心纵切的请求体和成功响应已引用 DTO-specific schema（例如 `RfqCreateRequest`、`QuotationCreateRequest`、`OrderCreateRequest`、`InventoryCreateRequest`），金额兼容 number/string 投影、RFC 3339 日期、分页摘要、状态/筛选参数均有明确约束。后续新增路由必须继续沿用同一生成与漂移门禁，不得回退到通用 JSON 包裹。

`npm run api:check` 是兼容性漂移门禁；`npm run api:check:strict` 当前已通过（315 operations、54 mounts、0 inventory-only）。严格门禁同时确认每条已注册路由都有 DTO-specific 请求/响应契约。

已固化的代表性边界包括：

- 登录、刷新、退出的 HttpOnly refresh-token `Set-Cookie` 响应头。
- 核心列表的 `page`、`limit`、`search`、`sort`、`direction` 查询参数。
- 非 auth 写入的 `Idempotency-Key` 请求头。
- 上传 multipart、PDF 下载、CSV 导出的媒体类型。
- 入站 Webhook 的 `X-Webhook-Signature` 请求头。
- 统一成功/错误 envelope、RFC 3339 日期时间和 Decimal 字符串约定。

## 工作流

```powershell
# 发现路由并生成初始清册（仅在契约文件不存在时运行）
npm run api:scaffold

# 明确放弃当前手工完善的契约并重新生成骨架（通常不应运行）
npm run api:scaffold:reset

# 生成类型
npm run api:generate

# 本地门禁
npm run api:check

# P2-01 当前批次的严格门禁
npm run api:check:strict
```

业务契约完善后，先更新 `openapi.json` 和代表性契约测试，再运行生成和门禁。不得反向修改生成的 `.d.ts`；不得让新 feature 绕过生成客户端新增散落的 `fetch`。
