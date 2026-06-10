# Webhook MVP 部署验证清单

## 📦 交付物清单

本 MVP 包含以下文件和功能：

### 核心代码变更
- ✅ `server/prisma/schema.prisma` - 新增 3 张表（WebhookEndpoint, WebhookSubscription, WebhookDelivery）
- ✅ `server/src/lib/webhookService.ts` - 核心 webhook 业务逻辑
- ✅ `server/src/routes/webhooks.ts` - 5 个 API 端点类
- ✅ `server/src/index.ts` - 路由注册 + Worker 启动
- ✅ `server/src/lib/validation.ts` - webhook 校验 schema
- ✅ `server/src/routes/rfqs.ts` - 事件发布集成
- ✅ `server/src/routes/quotations.ts` - 事件发布集成
- ✅ `server/src/routes/orders.ts` - 事件发布集成
- ✅ `server/src/routes/agents.ts` - 事件发布集成

### 文档与示例
- ✅ `webhook-api.postman_collection.json` - 可导入 Postman 的完整 API 集合
- ✅ `webhook-example-receiver.ts` - 本地接收端示例（含签名验证）
- ✅ `WEBHOOK_OPERATIONS_GUIDE.md` - 运维手册（监控、故障排查、DLQ）
- ✅ `WEBHOOK_INTEGRATION_GUIDE.md` - 集成快速参考（代码示例、cURL）
- ✅ `WEBHOOK_MVP_DEPLOYMENT_CHECKLIST.md` - 本文件（部署验证）

---

## 🔧 部署前验证

### 1. 代码完整性检查

```bash
# 检查是否所有必需文件都存在
ls -la server/src/lib/webhookService.ts       # ✓ 存在
ls -la server/src/routes/webhooks.ts          # ✓ 存在
grep -q "publishWebhookEvent" server/src/routes/rfqs.ts        # ✓ 有事件发布
grep -q "publishWebhookEvent" server/src/routes/quotations.ts  # ✓ 有事件发布
grep -q "publishWebhookEvent" server/src/routes/orders.ts      # ✓ 有事件发布
grep -q "publishWebhookEvent" server/src/routes/agents.ts      # ✓ 有事件发布
```

### 2. TypeScript 编译检查

```bash
cd server
npm run build  # 或 tsc

# 期望输出: 0 errors
# 如有错误，检查:
# - emailAccounts.ts 中的 requireAdmin 调用是否正确
# - emailService.ts 中的 headerPart.body 类型是否使用 as any
```

### 3. 数据库迁移检查

```bash
cd server

# 生成 Prisma Client（必需）
npm run db:generate

# 如果遇到 EPERM 锁错误（Windows 常见）:
# 手动删除锁文件后重试
# rm -rf node_modules/.prisma/client/query_engine-windows.dll.node.tmp*
# npm run db:generate

# 创建/更新数据库表
npm run db:migrate

# 验证表已创建
npm run db:studio  # 打开 Prisma Studio 查看表结构
```

### 4. 路由注册检查

```bash
# 检查 server/src/index.ts 中是否包含:
grep -n "webhookRoutes\|/api/webhooks" server/src/index.ts

# 期望输出:
# - import { webhookRoutes } from './routes/webhooks'
# - app.use('/api/webhooks', authenticate, webhookRoutes)
```

### 5. Worker 启动检查

```bash
# 检查是否已启动 30 秒重试 worker
grep -n "setInterval" server/src/index.ts | grep -i webhook

# 期望输出:
# setInterval(retryFailedDeliveries, 30 * 1000);
```

---

## 🚀 本地开发环境验证

### 步骤 1: 启动后端服务

```bash
cd server
npm run dev

# 期望日志输出:
# ✓ tsc compiled successfully
# ✓ Server listening on http://localhost:3000
# ✓ Starting webhook retry worker (every 30s)
```

### 步骤 2: 启动前端服务

```bash
# 新终端窗口
npm run dev

# 期望日志输出:
# ✓ VITE v... dev server running at:
# ✓ ➜  Local:   http://localhost:5173/
```

### 步骤 3: 健康检查

```bash
# 检查后端健康
curl http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer your_jwt_token"

# 期望响应: 200 OK，返回空数组 []

# 检查前端加载
curl http://localhost:5173/ | grep -i "aerolink\|航材"

# 期望响应: 200 OK，包含应用标题
```

---

## 🧪 功能测试（分阶段）

### 第 1 阶段: API 端点可达性

```bash
# 使用 Postman 或 cURL 测试

# 1.1 创建 Webhook 端点
curl -X POST http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://webhook.site/your-unique-id",
    "authMethod": "HMAC",
    "secret": "test_secret",
    "maxRetries": 3,
    "timeoutSeconds": 30
  }'

# ✓ 期望: 201 Created，返回 endpointId

# 1.2 查看端点列表
curl -X GET http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer ${JWT_TOKEN}"

# ✓ 期望: 200 OK，返回刚创建的端点

# 1.3 创建订阅
curl -X POST http://localhost:3000/api/webhooks/subscriptions \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "ENDPOINT_ID_FROM_1.1",
    "eventTypes": ["rfq.created"],
    "filters": { "urgency": ["AOG"] },
    "active": true
  }'

# ✓ 期望: 201 Created，返回 subscriptionId
```

### 第 2 阶段: 事件投递测试

```bash
# 2.1 测试投递（模拟事件）
curl -X POST http://localhost:3000/api/webhooks/test \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "ENDPOINT_ID_FROM_PHASE1",
    "eventType": "test.delivery",
    "payload": {
      "message": "Test webhook payload"
    }
  }'

# ✓ 期望: 200 OK，webhook.site 页面收到 POST 请求

# 2.2 查看投递日志
curl -X GET "http://localhost:3000/api/webhooks/deliveries" \
  -H "Authorization: Bearer ${JWT_TOKEN}"

# ✓ 期望: 200 OK，返回投递记录，status 为 "DELIVERED"

# 2.3 查看投递详情
DELIVERY_ID="..."  # 从 2.2 中获取
curl -X GET "http://localhost:3000/api/webhooks/deliveries/${DELIVERY_ID}" \
  -H "Authorization: Bearer ${JWT_TOKEN}"

# ✓ 期望: 包含 response_body, response_status_code 等详情
```

### 第 3 阶段: 业务事件发布测试

```bash
# 3.1 创建 RFQ（应触发 rfq.created 事件）
# 使用前端 UI: http://localhost:5173/ → RFQ Management → Create RFQ

# 3.2 检查 webhook 投递日志
curl -X GET "http://localhost:3000/api/webhooks/deliveries" \
  -H "Authorization: Bearer ${JWT_TOKEN}" | jq '.[] | select(.event_type == "rfq.created")'

# ✓ 期望: status 为 "DELIVERED"，webhook.site 收到有效负载

# 3.3 测试其他事件
# - 创建报价 → quotation.created
# - 提交报价 → quotation.submitted
# - 批准报价 → quotation.approved
# - 创建订单 → order.created
# - 修改订单状态 → order.status.changed
```

### 第 4 阶段: 签名验证测试

```bash
# 4.1 本地运行接收端示例
npx ts-node webhook-example-receiver.ts

# ✓ 期望: 🚀 Webhook receiver running on http://localhost:4000

# 4.2 创建指向本地接收端的 Webhook 端点
curl -X POST http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://localhost:4000/webhooks/receiver",
    "authMethod": "HMAC",
    "secret": "local_test_secret",
    "maxRetries": 2
  }'

# 记录返回的 endpointId

# 4.3 创建本地订阅
curl -X POST http://localhost:3000/api/webhooks/subscriptions \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "LOCAL_ENDPOINT_ID",
    "eventTypes": ["rfq.created"],
    "active": true
  }'

# 4.4 发送测试事件
curl -X POST http://localhost:3000/api/webhooks/test \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "LOCAL_ENDPOINT_ID",
    "eventType": "test.delivery",
    "payload": { "test": "data" }
  }'

# ✓ 期望: 
#   - 本地接收端日志显示: ✅ Webhook received
#   - 签名验证成功
#   - 投递日志显示 status 为 "DELIVERED"
```

### 第 5 阶段: 重试机制测试

```bash
# 5.1 创建一个指向无效 URL 的端点
curl -X POST http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://invalid.example.com/webhooks",
    "authMethod": "HMAC",
    "secret": "test",
    "maxRetries": 3,
    "timeoutSeconds": 5
  }'

# 5.2 创建订阅
curl -X POST http://localhost:3000/api/webhooks/subscriptions \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "INVALID_ENDPOINT_ID",
    "eventTypes": ["test.delivery"],
    "active": true
  }'

# 5.3 触发测试投递
curl -X POST http://localhost:3000/api/webhooks/test \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"endpointId": "INVALID_ENDPOINT_ID", "eventType": "test.delivery", "payload": {}}'

# 5.4 立即检查投递状态（应为 FAILED）
curl -X GET "http://localhost:3000/api/webhooks/deliveries?status=FAILED" \
  -H "Authorization: Bearer ${JWT_TOKEN}"

# ✓ 期望: 
#   - 第一次投递: FAILED
#   - retry_count: 0

# 5.5 等待 35 秒让 Worker 运行（30s interval + 5s 缓冲）
sleep 35

# 5.6 再次检查投递状态（应为 FAILED，retry_count > 0）
curl -X GET "http://localhost:3000/api/webhooks/deliveries?status=FAILED" \
  -H "Authorization: Bearer ${JWT_TOKEN}" | jq '.[] | {retry_count, status}'

# ✓ 期望: 
#   - retry_count: 1 或更高
#   - status: 仍为 FAILED（因为端点无效）

# 5.7 测试手动重试
FAILED_DELIVERY_ID="..."  # 从上面获取
curl -X POST "http://localhost:3000/api/webhooks/deliveries/${FAILED_DELIVERY_ID}/retry" \
  -H "Authorization: Bearer ${JWT_TOKEN}"

# ✓ 期望: 200 OK，retry_count 增加
```

---

## 📊 建立监控基线

### 数据库查询验证

```bash
# 连接到 SQLite 数据库
sqlite3 server/dev.db

# 查询表是否存在
.tables

# 期望输出: 应包含 webhook_endpoints, webhook_subscriptions, webhook_deliveries

# 查询表结构
.schema webhook_endpoints
.schema webhook_subscriptions
.schema webhook_deliveries

# 查询初始数据
SELECT COUNT(*) FROM webhook_endpoints;
SELECT COUNT(*) FROM webhook_subscriptions;
SELECT COUNT(*) FROM webhook_deliveries;

# 查询失败投递
SELECT * FROM webhook_deliveries WHERE status = 'FAILED';
```

### 日志验证

```bash
# 检查后端日志中是否有 webhook 相关的日志
tail -f server.log | grep -i webhook

# 期望日志示例:
# [INFO] Starting webhook retry worker
# [DEBUG] publishWebhookEvent: rfq.created
# [DEBUG] Creating webhook delivery for endpoint: ...
# [INFO] Webhook delivered successfully
```

---

## 🔒 生产环境前检查

### 安全性检查

- [ ] **JWT 密钥强度**
  ```bash
  echo -n "${JWT_SECRET}" | wc -c  # 应 > 32 字符
  ```

- [ ] **HTTPS 配置**
  ```bash
  curl -I https://your-domain.com/api/webhooks/endpoints
  # 应返回 200，不应有 SSL 警告
  ```

- [ ] **签名验证测试**
  ```bash
  # 尝试篡改请求体后重新发送
  # 应返回 401 Unauthorized
  ```

- [ ] **时间戳验证**
  ```bash
  # 使用超过 5 分钟前的时间戳发送
  # 应返回 401 Unauthorized
  ```

- [ ] **速率限制**
  ```bash
  # 快速发送 100 个请求
  # 应能正常处理或返回 429 Too Many Requests
  ```

### 性能基准

```bash
# 测试单个投递的延迟
for i in {1..10}; do
  time curl -X POST http://localhost:3000/api/webhooks/test \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{...}'
done

# 期望: 平均延迟 < 100ms
```

### 容量规划

```bash
# 估计数据库大小增长
# 假设:
# - 每天 1000 个 RFQ 事件
# - 每个 RFQ 平均 3 个报价
# - 每个报价 2 个事件
# - 每个订单平均 5 个状态变更

# 日投递数: 1000 + (1000*3*2) + (1000*5) = 12,000 条/天
# 月投递数: 360,000 条
# 数据库增长: ~360,000 * 500 bytes = 180 MB/月

# 建议: 每月清理 90 天前的已处理投递
DELETE FROM webhook_deliveries 
WHERE status = 'DELIVERED' 
  AND created_at < NOW() - INTERVAL '90 days';
```

---

## ✅ 最终验收清单

### 功能验收

- [ ] **端点管理** - 能创建、读取、更新、删除端点
- [ ] **订阅管理** - 能创建、读取、更新、删除订阅
- [ ] **事件过滤** - 订阅可按事件类型和自定义过滤器筛选
- [ ] **测试投递** - 能通过 API 测试端点连接
- [ ] **投递日志** - 能查看所有投递记录和详情
- [ ] **手动重试** - 能手动重试失败的投递
- [ ] **自动重试** - Worker 每 30 秒自动重试失败投递
- [ ] **签名验证** - 投递包含有效的 HMAC 签名
- [ ] **时间戳验证** - 防护时间戳重放攻击
- [ ] **幂等性** - 重复投递不导致重复处理（示例接收端已实现）

### 安全性验收

- [ ] **认证** - 所有 API 需要有效 JWT Token
- [ ] **授权** - 仅管理员可管理 endpoints/subscriptions
- [ ] **签名** - 入站请求签名验证正确
- [ ] **HTTPS** - 生产环境仅允许 HTTPS（dev 可豁免）
- [ ] **速率限制** - 实现了防止滥用的机制

### 可观测性验收

- [ ] **日志** - 关键操作都有记录（创建、投递、重试）
- [ ] **监控** - 关键指标可查询（成功率、延迟、失败数）
- [ ] **告警** - 高失败率时有通知机制

### 文档验收

- [ ] **Postman Collection** - 已导入，所有端点可测试
- [ ] **接收端示例** - 示例代码运行正常，签名验证成功
- [ ] **集成指南** - 包含代码示例和最佳实践
- [ ] **运维手册** - 包含故障排查和 DLQ 处理流程

---

## 🎯 上线前最后确认

```bash
# 完整构建测试
npm run build && npm run dev

# 完整功能测试
npm test  # (如果有单元测试)

# 压力测试
# 模拟 100 个并发 webhook 投递

# 性能基准
# 验证投递延迟 < 2 秒（99% 分位数）

# 灾难恢复测试
# 模拟数据库故障后恢复
```

---

## 📱 上线交接

### 交接物品

1. **代码仓库**
   - 所有 webhook 相关代码已提交到 main 分支
   - Tag: `webhook-mvp-v1.0`

2. **文档**
   - ✅ WEBHOOK_OPERATIONS_GUIDE.md - 运维交接
   - ✅ WEBHOOK_INTEGRATION_GUIDE.md - 开发交接
   - ✅ webhook-api.postman_collection.json - API 文档
   - ✅ webhook-example-receiver.ts - 参考实现

3. **监控配置**
   - [ ] 配置告警规则（见 OPERATIONS_GUIDE）
   - [ ] 配置日志聚合
   - [ ] 配置性能监控

4. **培训**
   - [ ] 后端团队培训（重试机制、签名验证）
   - [ ] 运维团队培训（监控、DLQ 处理）
   - [ ] 客户/集成方培训（接收端实现）

---

## 📞 故障响应联系

**生产问题联系**:
- 投递失败率 > 5%: 立即 page
- 无法创建端点: 检查数据库连接
- Worker 不运行: 重启后端服务
- 签名验证失败: 检查 secret 一致性

---

## 完成标记

- ✅ 开发完成: 所有代码已落地
- ✅ 构建验证: 编译无错误
- ✅ 本地测试: 完整功能测试通过
- ⏳ 生产部署: 待运维团队执行上述验收清单
- ⏳ 客户集成: 待客户团队使用示例代码集成

---

**最后更新**: 2026-05-12  
**版本**: Webhook MVP v1.0  
**维护人**: 架构团队
