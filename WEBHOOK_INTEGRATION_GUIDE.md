# Webhook 集成快速参考

## 签名验证（核心）

### 签名计算流程

**平台端（发送方）**：
```
1. message = timestamp + '.' + raw_body
2. signature = 'sha256=' + hmac_sha256(secret, message)
3. 发送请求头: X-Webhook-Signature: {signature}
```

**接收端**：
```
1. 提取 X-Webhook-Signature 头
2. 提取 X-Event-Timestamp 头
3. 重新计算: expected = 'sha256=' + hmac_sha256(secret, timestamp + '.' + body)
4. 对比: timingSafeEqual(received_signature, expected_signature)
```

---

## 代码示例

### Node.js / Express（接收端）

```typescript
import crypto from 'crypto';

// ✅ 验证签名
function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  secret: string
): boolean {
  const message = timestamp + '.' + rawBody;
  const expectedSig = 'sha256=' + 
    crypto.createHmac('sha256', secret)
      .update(message)
      .digest('hex');
  
  // 防时序攻击
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSig)
  );
}

// 使用
app.post('/webhooks/receiver', (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  const ts = req.headers['x-event-timestamp'];
  const body = JSON.stringify(req.body);
  
  if (!verifyWebhookSignature(body, sig, ts, 'your_secret')) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // 处理事件
  res.json({ ok: true });
});
```

### Python（接收端）

```python
import hmac
import hashlib
from flask import Flask, request

def verify_webhook(raw_body, signature, timestamp, secret):
    """验证 webhook 签名"""
    message = f"{timestamp}.{raw_body}"
    expected_sig = 'sha256=' + hmac.new(
        secret.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()
    
    # 防时序攻击
    return hmac.compare_digest(signature, expected_sig)

@app.route('/webhooks/receiver', methods=['POST'])
def receive_webhook():
    raw_body = request.get_data(as_text=True)
    sig = request.headers.get('X-Webhook-Signature')
    ts = request.headers.get('X-Event-Timestamp')
    
    if not verify_webhook(raw_body, sig, ts, 'your_secret'):
        return {'error': 'Invalid signature'}, 401
    
    # 处理事件
    return {'ok': True}
```

### C# / .NET（接收端）

```csharp
using System;
using System.Security.Cryptography;
using System.Text;

public static bool VerifyWebhookSignature(
    string rawBody, 
    string signature, 
    string timestamp, 
    string secret)
{
    var message = $"{timestamp}.{rawBody}";
    using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
    {
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(message));
        var expectedSig = "sha256=" + BitConverter.ToString(hash)
            .Replace("-", "").ToLower();
        
        // 防时序攻击
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(signature),
            Encoding.UTF8.GetBytes(expectedSig)
        );
    }
}
```

---

## cURL 测试参考

### 1. 创建 Webhook 端点

```bash
curl -X POST http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://webhook.site/unique-id",
    "authMethod": "HMAC",
    "secret": "test_secret_key_here",
    "maxRetries": 5,
    "timeoutSeconds": 30
  }'

# 响应示例:
# {
#   "id": "endpoint_uuid",
#   "url": "https://webhook.site/unique-id",
#   "status": "ACTIVE",
#   ...
# }
```

### 2. 列出所有端点

```bash
curl -X GET http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer ${JWT_TOKEN}"
```

### 3. 创建事件订阅

```bash
curl -X POST http://localhost:3000/api/webhooks/subscriptions \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "endpoint_uuid",
    "eventTypes": ["rfq.created", "order.created"],
    "filters": {
      "urgency": ["AOG"],
      "status": ["PENDING", "CONFIRMED"]
    },
    "active": true
  }'
```

### 4. 测试投递

```bash
curl -X POST http://localhost:3000/api/webhooks/test \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointId": "endpoint_uuid",
    "eventType": "test.delivery",
    "payload": {
      "message": "Hello from webhook test",
      "timestamp": "'$(date -u +%s)'"
    }
  }'
```

### 5. 查看投递日志

```bash
# 所有投递
curl -X GET "http://localhost:3000/api/webhooks/deliveries?limit=20" \
  -H "Authorization: Bearer ${JWT_TOKEN}"

# 按端点过滤
curl -X GET "http://localhost:3000/api/webhooks/deliveries?endpointId=endpoint_uuid" \
  -H "Authorization: Bearer ${JWT_TOKEN}"

# 只看失败的投递
curl -X GET "http://localhost:3000/api/webhooks/deliveries?status=FAILED" \
  -H "Authorization: Bearer ${JWT_TOKEN}"
```

### 6. 查看单条投递详情

```bash
curl -X GET http://localhost:3000/api/webhooks/deliveries/delivery_uuid \
  -H "Authorization: Bearer ${JWT_TOKEN}"
```

### 7. 手动重试失败投递

```bash
curl -X POST http://localhost:3000/api/webhooks/deliveries/delivery_uuid/retry \
  -H "Authorization: Bearer ${JWT_TOKEN}"
```

### 8. 删除端点

```bash
curl -X DELETE http://localhost:3000/api/webhooks/endpoints/endpoint_uuid \
  -H "Authorization: Bearer ${JWT_TOKEN}"
```

---

## 事件类型速查表

| 事件类型 | 触发时机 | 关键字段 |
|---------|---------|--------|
| `rfq.created` | 创建 RFQ | rfqNumber, partNumber, quantity, urgency |
| `rfq.status.changed` | RFQ 状态变更 | previousStatus, newStatus, supplierCount |
| `quotation.created` | 创建报价 | quotationNumber, unitPrice, leadTime |
| `quotation.submitted` | 报价提交 | quotationNumber, supplierName, currency |
| `quotation.approved` | 报价批准 | quotationNumber, approvedBy |
| `quotation.rejected` | 报价拒绝 | quotationNumber, rejectionReason |
| `quotation.sent` | 报价发送客户 | quotationNumber, sentAt |
| `order.created` | 创建订单 | orderNumber, totalAmount, deliveryDate |
| `order.status.changed` | 订单状态变更 | previousStatus, newStatus, trackingNumber |
| `agent.task.completed` | Agent 任务完成 | taskType, result |
| `agent.task.failed` | Agent 任务失败 | taskType, error |

---

## 请求/响应头参考

### 入站请求头（接收方会收到）

```
X-Webhook-Signature: sha256=abc123def456...  # HMAC 签名
X-Webhook-ID: delivery-uuid                 # 投递 ID，用于幂等性
X-Event-ID: event-uuid                      # 事件 ID
X-Event-Timestamp: 1715504400               # Unix 时间戳
Content-Type: application/json
```

### 出站响应（接收方应返回）

**成功响应**（状态码 200-299）：
```json
{
  "ok": true
}
```

**失败响应**（状态码 4xx/5xx，触发重试）：
```json
{
  "error": "Processing failed",
  "details": "..."
}
```

---

## 幂等性设计

```typescript
// ❌ 错误做法：只依赖 eventId
const eventExists = await db.events.findOne({ eventId });
if (eventExists) return res.status(200).json({ duplicate: true });

// ✅ 正确做法：使用 deliveryId（eventId + webhookId 组合）
const deliveryExists = await db.deliveries.findOne({ 
  deliveryId: `${eventId}:${webhookId}` 
});
if (deliveryExists) {
  console.log('Duplicate delivery, skipping');
  return res.status(200).json({ ok: true, duplicate: true });
}

// 处理事件
const result = await processEvent(payload);

// 记录已处理
await db.deliveries.create({
  deliveryId: `${eventId}:${webhookId}`,
  eventId,
  webhookId,
  status: 'processed',
  processedAt: new Date()
});

return res.status(200).json({ ok: true });
```

---

## 故障排查流程

### 快速诊断

```bash
# 1. 验证 Webhook 服务活跃
curl http://localhost:3000/api/webhooks/endpoints \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -v

# 如果返回 401: 检查 JWT_TOKEN
# 如果返回 500: 检查后端日志

# 2. 查看最近的失败投递
curl "http://localhost:3000/api/webhooks/deliveries?status=FAILED&limit=5" \
  -H "Authorization: Bearer ${JWT_TOKEN}" | jq .

# 3. 查看特定失败的详情
curl "http://localhost:3000/api/webhooks/deliveries/{id}" \
  -H "Authorization: Bearer ${JWT_TOKEN}" | jq .

# 4. 测试端点连接
curl -I -X POST https://your-endpoint.com/webhooks/receiver

# 5. 手动重试失败投递
curl -X POST "http://localhost:3000/api/webhooks/deliveries/{id}/retry" \
  -H "Authorization: Bearer ${JWT_TOKEN}"
```

### 常见问题速解

**Q: "Invalid signature" 错误**
- ✅ 检查 `secret` 是否在两端一致
- ✅ 检查时间戳差异是否超过 5 分钟
- ✅ 确认使用的是原始 JSON body，不是解析后的对象

**Q: 投递状态一直是 "PENDING"**
- ✅ 检查目标端点是否返回 2xx 状态码
- ✅ 增加 `timeoutSeconds`
- ✅ 确认防火墙允许出站连接

**Q: "404 Not Found" 错误**
- ✅ 验证端点 URL 是否正确（包括协议和路径）
- ✅ 确认目标服务在运行

---

## 性能优化建议

### 1. 批量操作（创建多个订阅）

```bash
# ❌ 逐个创建（慢）
for endpoint_id in $endpoint_ids; do
  curl -X POST http://localhost:3000/api/webhooks/subscriptions \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -d "{\"endpointId\": \"$endpoint_id\", ...}"
done

# ✅ 批量 API（如果支持，待补充）
```

### 2. 过滤优化

```json
{
  "endpointId": "...",
  "eventTypes": ["rfq.created"],  // 只监听需要的事件
  "filters": {
    "urgency": ["AOG"]            // 缩小投递范围
  }
}
```

### 3. 重试策略

```json
{
  "maxRetries": 5,              // 不要设置过高
  "timeoutSeconds": 30          // 合理超时，避免堆积
}
```

---

## 监控 Dashboard 查询（Prometheus/Grafana）

```promql
# 投递成功率
rate(webhook_deliveries_succeeded[5m]) / rate(webhook_deliveries_total[5m])

# 平均延迟
histogram_quantile(0.95, webhook_delivery_latency_seconds)

# 失败率
rate(webhook_deliveries_failed[5m]) / rate(webhook_deliveries_total[5m])

# 活跃端点数
count(webhook_endpoints{status="ACTIVE"})

# 待处理的重试
count(webhook_deliveries{status="FAILED", retry_count < max_retries})
```

---

## 完整集成检查清单

- [ ] 已创建 Webhook 端点
- [ ] 已创建事件订阅
- [ ] 已验证签名验证逻辑
- [ ] 已实现幂等性检查
- [ ] 已测试 webhook 投递
- [ ] 已处理错误响应（4xx/5xx）
- [ ] 已设置监控告警
- [ ] 已记录审计日志
- [ ] 已验证 HTTPS/TLS（生产环境）
- [ ] 已配置 DLQ 处理流程
