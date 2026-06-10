# Webhook 运维检查清单

## 📋 快速开始

### 1. 部署前检查清单

- [ ] **数据库准备**
  - [ ] 执行 Prisma 迁移: `npm run db:generate && npm run db:migrate`
  - [ ] 确认三张表已创建: `WebhookEndpoint`, `WebhookSubscription`, `WebhookDelivery`
  - [ ] 验证表权限: `SELECT COUNT(*) FROM webhook_endpoints;`

- [ ] **环境变量配置**
  ```bash
  WEBHOOK_RETRY_INTERVAL=30000          # 重试轮询间隔（毫秒）
  WEBHOOK_MAX_RETRIES=5                 # 最大重试次数
  WEBHOOK_TIMEOUT_SECONDS=30            # 投递超时
  NODE_ENV=production
  ```

- [ ] **权限检查**
  - [ ] 所有管理员用户已关联角色: `SELECT userId, role FROM users WHERE role = 'admin';`
  - [ ] JWT 密钥已配置: `echo $JWT_SECRET | wc -c` (需 > 32 字符)

- [ ] **网络配置**
  - [ ] 防火墙已开放 3000 端口（或配置端口）
  - [ ] HTTPS/TLS 已配置（生产环境强制）
  - [ ] 目标 webhook 端点可访问性已验证

---

## 🚀 部署步骤

### 步骤 1: 启动服务

```bash
# 开发环境
npm run dev

# 生产环境
npm run build
npm run start

# 或使用 Docker
docker-compose up -d server
```

### 步骤 2: 验证 Webhook 服务

```bash
# 检查 /health 端点
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" http://localhost:3000/api/webhooks/endpoints

# 期望响应: 200 OK 且返回 endpoints 列表（初始为空）
```

### 步骤 3: 创建第一个 Webhook 端点

```bash
curl -X POST http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-receiver.com/webhooks/receiver",
    "authMethod": "HMAC",
    "secret": "your_webhook_secret_key",
    "maxRetries": 5,
    "timeoutSeconds": 30
  }'

# 记录返回的 endpointId
```

### 步骤 4: 创建事件订阅

```bash
curl -X POST http://localhost:3000/api/webhooks/subscriptions \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "ENDPOINT_UUID_FROM_STEP_3",
    "eventTypes": ["rfq.created", "order.created"],
    "filters": {
      "urgency": ["AOG"]
    },
    "active": true
  }'
```

### 步骤 5: 测试投递

```bash
curl -X POST http://localhost:3000/api/webhooks/test \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "ENDPOINT_UUID",
    "eventType": "test.delivery",
    "payload": {
      "message": "This is a test"
    }
  }'

# 检查目标端点是否收到了请求
```

---

## 📊 监控指标

### 关键性能指标 (KPI)

#### 1. **投递成功率** (Delivery Success Rate)
- **指标**: `(successful_deliveries / total_deliveries) * 100`
- **目标**: > 99%
- **告警阈值**: < 95%
- **查询**:
  ```sql
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as succeeded,
    ROUND(100.0 * SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate
  FROM webhook_deliveries
  WHERE created_at > NOW() - INTERVAL '1 hour';
  ```

#### 2. **平均投递延迟** (Average Delivery Latency)
- **指标**: 从事件发布到端点接收的平均时间（秒）
- **目标**: < 2 秒
- **告警阈值**: > 5 秒
- **查询**:
  ```sql
  SELECT 
    AVG(EXTRACT(EPOCH FROM (delivered_at - created_at))) as avg_latency_seconds,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - created_at))) as p95_latency
  FROM webhook_deliveries
  WHERE status = 'DELIVERED' AND delivered_at > NOW() - INTERVAL '1 hour';
  ```

#### 3. **重试率** (Retry Rate)
- **指标**: 需要重试的投递占比
- **目标**: < 2%
- **告警阈值**: > 5%
- **查询**:
  ```sql
  SELECT 
    COUNT(*) as total_deliveries,
    SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) as retried,
    ROUND(100.0 * SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) / COUNT(*), 2) as retry_rate
  FROM webhook_deliveries
  WHERE created_at > NOW() - INTERVAL '1 hour';
  ```

#### 4. **失败投递数** (Failed Delivery Count)
- **指标**: 超过最大重试次数的投递数
- **目标**: 0
- **告警阈值**: > 1（立即告警）
- **查询**:
  ```sql
  SELECT COUNT(*) as failed_deliveries
  FROM webhook_deliveries
  WHERE status = 'FAILED' AND retry_count >= max_retries;
  ```

#### 5. **端点可用性** (Endpoint Availability)
- **指标**: 每个端点的成功投递率
- **目标**: > 99% 每个端点
- **告警阈值**: < 90%
- **查询**:
  ```sql
  SELECT 
    ep.id,
    ep.url,
    COUNT(wd.*) as total_deliveries,
    SUM(CASE WHEN wd.status = 'DELIVERED' THEN 1 ELSE 0 END) as succeeded,
    ROUND(100.0 * SUM(CASE WHEN wd.status = 'DELIVERED' THEN 1 ELSE 0 END) / COUNT(wd.*), 2) as success_rate
  FROM webhook_endpoints ep
  LEFT JOIN webhook_deliveries wd ON ep.id = wd.endpoint_id
  WHERE wd.created_at > NOW() - INTERVAL '24 hours'
  GROUP BY ep.id, ep.url
  HAVING success_rate < 90;
  ```

---

## 🔴 故障排查指南

### 问题 1: 投递持续失败

**症状**:
- 多条投递显示 `FAILED` 状态
- `retry_count` 达到 `max_retries`

**原因排查**:
```bash
# 1. 查看最近失败的投递
curl -X GET "http://localhost:3000/api/webhooks/deliveries?status=FAILED&limit=10" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 2. 查看特定投递的详情（包括错误信息）
curl -X GET "http://localhost:3000/api/webhooks/deliveries/DELIVERY_ID" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 3. 检查目标端点的可访问性
curl -I https://your-receiver.com/webhooks/receiver

# 4. 验证端点配置
SELECT * FROM webhook_endpoints WHERE id = 'ENDPOINT_UUID' \G
```

**解决方案**:
- ✅ 如果目标端点离线: 更新端点 URL 或停用订阅
  ```bash
  curl -X PUT "http://localhost:3000/api/webhooks/endpoints/ENDPOINT_ID" \
    -H "Authorization: Bearer YOUR_JWT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"status": "INACTIVE"}'
  ```
- ✅ 如果签名验证失败: 确认 `secret` 在两端一致
- ✅ 如果超时: 增加 `timeoutSeconds` 并手动重试
  ```bash
  curl -X POST "http://localhost:3000/api/webhooks/deliveries/DELIVERY_ID/retry" \
    -H "Authorization: Bearer YOUR_JWT_TOKEN"
  ```

---

### 问题 2: 事件未投递

**症状**:
- 创建了 RFQ/订单，但未收到 webhook 事件
- `webhook_deliveries` 表中无新记录

**原因排查**:
```bash
# 1. 确认订阅是否活跃
SELECT * FROM webhook_subscriptions WHERE active = true \G

# 2. 检查事件类型过滤
SELECT event_types FROM webhook_subscriptions WHERE id = 'SUB_ID' \G

# 3. 检查业务逻辑是否触发事件发布
# 查看后端日志: grep "publishWebhookEvent" server/src/routes/rfqs.ts
```

**解决方案**:
- ✅ 确保订阅 `active = true`
  ```bash
  curl -X PUT "http://localhost:3000/api/webhooks/subscriptions/SUB_ID" \
    -H "Authorization: Bearer YOUR_JWT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"active": true}'
  ```
- ✅ 验证 `eventTypes` 和 `filters` 配置正确
- ✅ 检查后端日志中是否有 `publishWebhookEvent` 调用

---

### 问题 3: 重复投递

**症状**:
- 目标系统收到了相同的事件多次

**原因排查**:
- Worker 多次启动导致重复重试
- 网络超时后的自动重试

**解决方案**:
- ✅ 确保接收端实现了幂等性检查（使用 `deliveryId` + `eventId` 组合）
- ✅ 示例代码已在 `webhook-example-receiver.ts` 中提供
- ✅ 增加 `timeoutSeconds` 减少超时重试

---

### 问题 4: 内存泄漏或 Worker 未启动

**症状**:
- 后端进程占用内存不断增加
- 失败投递未被自动重试（30 秒 worker 未运行）

**原因排查**:
```bash
# 检查后端进程
ps aux | grep node

# 查看内存占用
free -h

# 查看日志中是否有 "Starting webhook retry worker"
tail -f server.log | grep "retry worker"
```

**解决方案**:
- ✅ 重启后端服务: `npm run dev` 或容器重启
- ✅ 确认 `server/src/index.ts` 中的 `setInterval` 已正确注册

---

## 🛑 死信队列 (DLQ) 管理

### DLQ 定义

失败且无法恢复的投递（`status = 'FAILED'` 且 `retry_count >= max_retries`）进入 DLQ。

### 查看 DLQ

```sql
-- 查看所有 DLQ 消息
SELECT 
  id, 
  endpoint_id, 
  event_type, 
  status_code, 
  error_message, 
  retry_count, 
  created_at 
FROM webhook_deliveries 
WHERE status = 'FAILED' AND retry_count >= max_retries
ORDER BY created_at DESC;
```

### DLQ 处理策略

#### 策略 1: 手动检查与重放

```bash
# 1. 查看 DLQ 消息
curl -X GET "http://localhost:3000/api/webhooks/deliveries?status=FAILED&limit=20" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 2. 调查失败原因（读取错误日志）
curl -X GET "http://localhost:3000/api/webhooks/deliveries/DELIVERY_ID" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 3. 修复目标系统或端点配置

# 4. 手动重试
curl -X POST "http://localhost:3000/api/webhooks/deliveries/DELIVERY_ID/retry" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### 策略 2: 批量重试 DLQ

```bash
# 示例脚本（PowerShell）
$token = "YOUR_JWT_TOKEN"
$baseUrl = "http://localhost:3000"

# 获取所有失败的投递
$response = Invoke-RestMethod -Uri "$baseUrl/api/webhooks/deliveries?status=FAILED" `
  -Headers @{"Authorization" = "Bearer $token"} -Method Get

# 重试每个失败投递
foreach ($delivery in $response.deliveries) {
  Write-Host "Retrying delivery: $($delivery.id)"
  Invoke-RestMethod -Uri "$baseUrl/api/webhooks/deliveries/$($delivery.id)/retry" `
    -Headers @{"Authorization" = "Bearer $token"} -Method Post
}
```

#### 策略 3: 定期清理过期 DLQ

```sql
-- 删除 30 天前的永久失败投递（谨慎执行）
DELETE FROM webhook_deliveries 
WHERE status = 'FAILED' 
  AND retry_count >= max_retries 
  AND created_at < NOW() - INTERVAL '30 days';
```

---

## 🔐 安全检查清单

- [ ] **签名验证**
  - [ ] 所有入站 webhook 请求都验证了 `X-Webhook-Signature`
  - [ ] 时间戳有效期检查已启用（5 分钟窗口）
  - [ ] 使用恒定时间比较防止时序攻击

- [ ] **认证与授权**
  - [ ] 所有 webhook API 端点都需要有效的 JWT Bearer Token
  - [ ] 仅管理员可管理 endpoints 和 subscriptions
  - [ ] 普通用户只能查看日志

- [ ] **数据保护**
  - [ ] 日志中不记录敏感数据（如信用卡、密码）
  - [ ] 加密传输（HTTPS/TLS）
  - [ ] 定期备份 `webhook_deliveries` 表

- [ ] **速率限制**
  - [ ] 实现了单个端点的投递速率限制（如：5 req/sec）
  - [ ] 防止目标系统被淹没

---

## 📅 维护计划

### 日常（每天）
- [ ] 检查失败投递数: `SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'FAILED';`
- [ ] 确认 Worker 正常运行（日志中有 "retry" 消息）

### 周末（每周）
- [ ] 生成投递成功率报告
- [ ] 查看哪些端点失败率高
- [ ] 检查是否有重复投递

### 月度（每月）
- [ ] 审查和清理 DLQ
- [ ] 分析事件模式和高峰期
- [ ] 更新订阅过滤条件

---

## 🚨 告警规则

建议在监控系统中配置以下告警：

| 指标 | 条件 | 严重性 | 行动 |
|------|------|--------|------|
| 投递成功率 | < 95% (1h 内) | 🔴 高 | 页面告警，Slack 通知 |
| 失败投递数 | > 5 (实时) | 🔴 高 | 立即告警，中断响应 |
| 平均延迟 | > 5s (5m 内) | 🟡 中 | 电子邮件告警 |
| DLQ 消息数 | > 20 (每日) | 🟡 中 | 每日摘要报告 |
| Webhook Worker | 无响应 > 5m | 🔴 高 | 页面告警，自动重启 |

---

## 📞 支持与联系

- **技术问题**: 查看 webhook 服务日志 - `tail -f server.log | grep -i webhook`
- **集成问题**: 参考 `webhook-example-receiver.ts` 示例代码
- **API 文档**: 导入 `webhook-api.postman_collection.json` 到 Postman
