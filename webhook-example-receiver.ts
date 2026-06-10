import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your_webhook_secret_here';
const PORT = process.env.PORT || 4000;

type WebhookPayload = {
  rfqNumber?: string;
  partNumber?: string;
  quantity?: number | string;
  quantityUnit?: string;
  urgency?: string;
  previousStatus?: string;
  newStatus?: string;
  supplierCount?: number;
  quotationNumber?: string;
  supplierName?: string;
  currency?: string;
  unitPrice?: number | string;
  leadTime?: number | string;
  approvedBy?: string;
  orderNumber?: string;
  customerId?: string;
  totalAmount?: number | string;
  deliveryDate?: string;
  trackingNumber?: string;
  carrier?: string;
  taskType?: string;
  result?: unknown;
  error?: string;
};

interface LoggedWebhookEvent {
  deliveryId: string;
  eventId: string;
  eventType: string;
  payload: WebhookPayload;
  receivedAt: Date;
  status: 'SUCCESS';
}

// 内存存储（生产环境应使用数据库）
const eventLog: LoggedWebhookEvent[] = [];

// ─────────────────────────────────────────────────────────────
// 签名验证函数
// ─────────────────────────────────────────────────────────────
function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  secret: string
): boolean {
  // Webhook 平台签名计算方式:
  // hmac_sha256(secret, timestamp + '.' + body) 
  const message = timestamp + '.' + rawBody;
  const expectedSignature = 'sha256=' + 
    crypto.createHmac('sha256', secret)
      .update(message)
      .digest('hex');
  
  // 时间戳有效期检查（防重放）: 5 分钟
  const signedTime = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - signedTime) > 300) {
    console.warn(`⚠️  Timestamp expired: ${timestamp}`);
    return false;
  }
  
  // 对比签名（恒定时间比较，防时序攻击）
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(signature)
  );
}

// ─────────────────────────────────────────────────────────────
// Webhook 接收端点（所有 POST 请求的入口）
// ─────────────────────────────────────────────────────────────
app.post('/webhooks/receiver', (req, res) => {
  const signature = req.headers['x-webhook-signature'] as string;
  const timestamp = req.headers['x-event-timestamp'] as string;
  const eventId = req.headers['x-event-id'] as string;
  const webhookId = req.headers['x-webhook-id'] as string;

  // 1. 验证必需的头部
  if (!signature || !timestamp || !eventId) {
    console.error('❌ Missing required headers');
    return res.status(400).json({ error: 'Missing required headers' });
  }

  // 2. 获取原始请求体（用于签名验证）
  const rawBody = JSON.stringify(req.body);

  // 3. 验证签名
  if (!verifyWebhookSignature(rawBody, signature, timestamp, WEBHOOK_SECRET)) {
    console.error('❌ Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 4. 检查幂等性（防重复处理）
  const deliveryId = `${eventId}:${webhookId}`;
  if (eventLog.some(e => e.deliveryId === deliveryId)) {
    console.warn(`⚠️  Duplicate delivery detected: ${deliveryId}`);
    return res.json({ 
      message: 'Webhook processed successfully (idempotent)',
      deliveryId,
      isDuplicate: true
    });
  }

  // 5. 处理事件
  const eventType = req.body.eventType;
  const payload = (req.body.data ?? {}) as WebhookPayload;

  console.log(`\n✅ Webhook received`);
  console.log(`   Event Type: ${eventType}`);
  console.log(`   Event ID: ${eventId}`);
  console.log(`   Timestamp: ${req.body.timestamp}`);
  console.log(`   Delivery ID: ${deliveryId}`);

  // 6. 根据事件类型处理
  handleWebhookEvent(eventType, payload);

  // 7. 记录事件日志
  eventLog.push({
    deliveryId,
    eventId,
    eventType,
    payload,
    receivedAt: new Date(),
    status: 'SUCCESS',
  });

  // 8. 返回成功响应（webhook 平台会重试直到收到 2xx）
  res.status(200).json({ 
    message: 'Webhook processed successfully',
    eventId,
    deliveryId
  });
});

// ─────────────────────────────────────────────────────────────
// 事件处理函数
// ─────────────────────────────────────────────────────────────
function handleWebhookEvent(eventType: string, payload: WebhookPayload) {
  switch (eventType) {
    // ─── RFQ 事件 ───
    case 'rfq.created':
      console.log(`   📋 New RFQ: ${payload.rfqNumber}`);
      console.log(`      Part: ${payload.partNumber} (${payload.quantity} ${payload.quantityUnit})`);
      console.log(`      Urgency: ${payload.urgency}`);
      // 触发下游系统（ERP、CRM等）
      syncRFQToERP(payload);
      break;

    case 'rfq.status.changed':
      console.log(`   📋 RFQ Status Changed: ${payload.rfqNumber}`);
      console.log(`      ${payload.previousStatus} → ${payload.newStatus}`);
      console.log(`      Suppliers Responded: ${payload.supplierCount}`);
      updateRFQStatus(payload);
      break;

    // ─── 报价事件 ───
    case 'quotation.created':
      console.log(`   💰 New Quote: ${payload.quotationNumber}`);
      console.log(`      From: ${payload.supplierName}`);
      console.log(`      Price: ${payload.currency} ${payload.unitPrice}`);
      notifyBuyerOfNewQuote(payload);
      break;

    case 'quotation.submitted':
      console.log(`   💰 Quote Submitted: ${payload.quotationNumber}`);
      console.log(`      Lead Time: ${payload.leadTime} days`);
      logQuotationEvent(payload);
      break;

    case 'quotation.approved':
      console.log(`   ✅ Quote Approved: ${payload.quotationNumber}`);
      console.log(`      Approved By: ${payload.approvedBy}`);
      triggerOrderCreation(payload);
      break;

    case 'quotation.rejected':
      console.log(`   ❌ Quote Rejected: ${payload.quotationNumber}`);
      notifySupplierOfRejection(payload);
      break;

    case 'quotation.sent':
      console.log(`   📤 Quote Sent to Customer: ${payload.quotationNumber}`);
      trackQuotationSent(payload);
      break;

    // ─── 订单事件 ───
    case 'order.created':
      console.log(`   🛒 New Order: ${payload.orderNumber}`);
      console.log(`      Customer: ${payload.customerId}`);
      console.log(`      Amount: ${payload.currency} ${payload.totalAmount}`);
      console.log(`      Delivery: ${payload.deliveryDate}`);
      syncOrderToWMS(payload);
      break;

    case 'order.status.changed':
      console.log(`   🚚 Order Status Changed: ${payload.orderNumber}`);
      console.log(`      ${payload.previousStatus} → ${payload.newStatus}`);
      if (payload.trackingNumber) {
        console.log(`      Tracking: ${payload.trackingNumber} (${payload.carrier})`);
        updateShipmentTracking(payload);
      }
      break;

    // ─── Agent 事件 ───
    case 'agent.task.completed':
      console.log(`   🤖 Agent Task Completed: ${payload.taskType}`);
      console.log(`      Result: ${JSON.stringify(payload.result)}`);
      storeAgentAnalysis(payload);
      break;

    case 'agent.task.failed':
      console.log(`   ⚠️  Agent Task Failed: ${payload.taskType}`);
      console.log(`      Error: ${payload.error}`);
      alertOnTaskFailure(payload);
      break;

    default:
      console.warn(`   ⚠️  Unknown event type: ${eventType}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 示例处理函数（演示集成点）
// ─────────────────────────────────────────────────────────────
function syncRFQToERP(payload: WebhookPayload) {
  // 示例: 调用 ERP API
  console.log(`   → Syncing to ERP: RFQ ${payload.rfqNumber}`);
}

function updateRFQStatus() {
  // 示例: 更新本地数据库
  console.log(`   → Updating RFQ status in local DB`);
}

function notifyBuyerOfNewQuote() {
  // 示例: 发送电子邮件
  console.log(`   → Sending email notification to buyer`);
}

function logQuotationEvent() {
  // 示例: 记录日志
  console.log(`   → Logging quotation event`);
}

function triggerOrderCreation() {
  // 示例: 创建订单
  console.log(`   → Creating purchase order`);
}

function notifySupplierOfRejection() {
  // 示例: 发送拒绝通知
  console.log(`   → Notifying supplier of rejection`);
}

function trackQuotationSent() {
  // 示例: 追踪报价发送
  console.log(`   → Tracking quotation sent`);
}

function syncOrderToWMS() {
  // 示例: 同步到仓库管理系统
  console.log(`   → Syncing order to WMS`);
}

function updateShipmentTracking() {
  // 示例: 更新跟踪信息
  console.log(`   → Updating shipment tracking`);
}

function storeAgentAnalysis() {
  // 示例: 存储 AI 分析结果
  console.log(`   → Storing agent analysis result`);
}

function alertOnTaskFailure() {
  // 示例: 发送告警
  console.log(`   → Sending alert for task failure`);
}

// ─────────────────────────────────────────────────────────────
// 管理接口
// ─────────────────────────────────────────────────────────────

// 查看所有接收的事件
app.get('/admin/events', (req, res) => {
  res.json({
    totalEvents: eventLog.length,
    events: eventLog.map(e => ({
      eventId: e.eventId,
      deliveryId: e.deliveryId,
      eventType: e.eventType,
      receivedAt: e.receivedAt,
      status: e.status,
    })),
  });
});

// 查看特定事件详情
app.get('/admin/events/:eventId', (req, res) => {
  const event = eventLog.find(e => e.eventId === req.params.eventId);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }
  res.json(event);
});

// 重新处理已接收的事件（用于测试重放）
app.post('/admin/events/:eventId/replay', (req, res) => {
  const event = eventLog.find(e => e.eventId === req.params.eventId);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  console.log(`\n🔄 Replaying event: ${req.params.eventId}`);
  handleWebhookEvent(event.eventType, event.payload, event.eventId);

  res.json({ message: 'Event replayed successfully', eventId: req.params.eventId });
});

// 查看事件统计
app.get('/admin/stats', (req, res) => {
  const statsByType: Record<string, number> = {};
  eventLog.forEach(e => {
    statsByType[e.eventType] = (statsByType[e.eventType] || 0) + 1;
  });

  res.json({
    totalEvents: eventLog.length,
    eventTypes: Object.keys(statsByType),
    statsByType,
    oldestEvent: eventLog[0]?.receivedAt,
    latestEvent: eventLog[eventLog.length - 1]?.receivedAt,
  });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', receivedEvents: eventLog.length });
});

// ─────────────────────────────────────────────────────────────
// 启动服务器
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Webhook receiver running on http://localhost:${PORT}`);
  console.log(`   POST   http://localhost:${PORT}/webhooks/receiver`);
  console.log(`   GET    http://localhost:${PORT}/admin/events`);
  console.log(`   GET    http://localhost:${PORT}/admin/stats`);
  console.log(`   POST   http://localhost:${PORT}/admin/events/:eventId/replay`);
});
