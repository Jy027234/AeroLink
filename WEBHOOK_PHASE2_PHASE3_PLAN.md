# Webhook 完整功能实施计划

## 🎯 总体目标

从 MVP 扩展到**生产级 Webhook 平台**，分三个阶段逐步增强。

---

## 📅 Phase 2: 可靠性与易用性（第 1-2 周）

### 2.1 自动重试 + DLQ 管理 ✅ 优先级 1

#### 当前状态（MVP）
```
失败投递 → 30s worker 轮询 → 指数退避重试 → max_retries 后标记 FAILED
```

#### Phase 2 增强
```
新增 DLQ 工作流:
  1. 投递失败 5 次 → DLQ 隔离 (QUARANTINED)
  2. 管理员审核 → 编辑重试参数 (延迟、次数)
  3. 选择: 立即重试 / 延迟重试 / 永久放弃 / 转发给告警
  
新增监控:
  - DLQ 年龄分布 (< 1h / 1-24h / > 24h)
  - DLQ 失败原因分类 (4xx/5xx/timeout/connection)
  - DLQ 恢复率 (重试成功 / 总 DLQ)
```

#### 实现清单
- [ ] 扩展 `webhook_deliveries` 表
  - 新字段: `quarantine_reason`, `quarantine_at`, `dlq_reviewed_by`, `dlq_action`
- [ ] 新建 `DLQService`
  - `moveToQuarantine()` - 失败 5 次后隔离
  - `analyzeFailureReason()` - 分类失败原因
  - `listQuarantined()` - 查询 DLQ
  - `resolveQuarantined(action)` - 处理 DLQ 消息
- [ ] 新增 API 路由
  - `GET /api/webhooks/dlq` - 查看 DLQ
  - `POST /api/webhooks/dlq/:id/review` - 标记已审核
  - `POST /api/webhooks/dlq/:id/retry` - 重试 DLQ 消息
  - `POST /api/webhooks/dlq/:id/abandon` - 放弃处理
- [ ] 前端页面: DLQ 管理面板

---

### 2.2 高级过滤规则 ✅ 优先级 2

#### 当前状态（MVP）
```json
{
  "eventTypes": ["rfq.created"],
  "filters": {
    "urgency": ["AOG"],
    "status": ["PENDING"]
  }
}
```

#### Phase 2 增强
```json
{
  "eventTypes": ["rfq.created", "order.created"],
  "filters": {
    "logic": "AND",  // 新: AND / OR / NOT
    "rules": [
      {
        "field": "urgency",
        "operator": "in",  // in, not_in, equals, gt, lt, contains, regex
        "value": ["AOG", "STOCK"]
      },
      {
        "field": "partNumber",
        "operator": "regex",
        "value": "^SN72.*"  // 正则匹配
      },
      {
        "field": "quantity",
        "operator": "gt",
        "value": 100
      }
    ]
  }
}
```

#### 实现清单
- [ ] 新建 `FilterEngine`
  - `compileFilter(rules)` - 编译规则为判定函数
  - `evaluate(payload, rules)` - 评估 payload 是否符合规则
  - 支持操作符: in, not_in, equals, gt, lt, gte, lte, contains, regex, exists
- [ ] 扩展 `webhook_subscriptions` 表
  - 替换 `filters` JSON 为新格式（带 `logic` 和 `rules`）
- [ ] 新增 API 端点
  - `POST /api/webhooks/subscriptions/:id/test-filter` - 测试规则
- [ ] 迁移脚本: 将 MVP 的简单过滤迁移到新格式

---

### 2.3 批量重放 ✅ 优先级 3

#### 功能需求
```
1. 按条件查询已投递的事件 (日期范围、事件类型、端点、状态)
2. 生成重放计划 (预览将影响多少个端点)
3. 批量重新投递 (支持并发控制、进度跟踪)
4. 可以修改 payload 后再投递 (如调整金额、状态等)
```

#### 实现清单
- [ ] 新建 `BulkReplayService`
  - `listForReplay(query)` - 按条件查询可重放的投递
  - `estimateImpact(deliveryIds)` - 预估影响范围
  - `replayBatch(deliveryIds, options)` - 执行批量重放
  - `getReplayProgress(replayBatchId)` - 查询进度
- [ ] 新表: `webhook_replay_batches`
  ```
  id, triggered_at, triggered_by, 
  filter_query, total_deliveries, 
  succeeded, failed, pending, status
  ```
- [ ] 新增 API 路由
  - `POST /api/webhooks/replay/query` - 查询重放候选
  - `POST /api/webhooks/replay/estimate` - 预估影响
  - `POST /api/webhooks/replay/execute` - 执行重放
  - `GET /api/webhooks/replay/:batchId` - 查看批次进度
- [ ] 前端页面: 批量重放向导
  - Step 1: 选择过滤条件
  - Step 2: 预览受影响端点
  - Step 3: 确认执行

---

## 📅 Phase 3: 企业级特性（第 3-6 周）

### 3.1 入站 Webhook 📥 优先级 1

#### 功能概述
系统不仅**发出** webhook（outbound），还能**接收**第三方的 webhook（inbound）

#### 使用场景
```
ERP 系统 → 投递订单更新 webhook → AeroLink /api/webhooks/inbound
  ↓
入站处理器 → 验证签名 → 更新本地订单状态 → 触发业务逻辑
```

#### 实现清单
- [ ] 新表: `InboundWebhookEndpoint`
  ```
  id, name, source_system, url_path, 
  auth_method, secret, is_active, 
  created_at, updated_at
  ```
- [ ] 新表: `InboundWebhookDelivery`
  ```
  id, endpoint_id, payload, 
  status (SUCCESS/FAILED), 
  error_message, attempts, processed_at
  ```
- [ ] 新建 `InboundWebhookService`
  - `registerInboundEndpoint()` - 创建入站端点
  - `receiveAndProcess()` - 接收并处理请求
  - `validateSignature()` - 验证签名（支持多种方式）
- [ ] 新 API 路由: `POST /api/webhooks/inbound/:path`
  - 支持任意 `:path`（由管理员配置）
- [ ] 入站处理器示例
  ```typescript
  // ERP 订单更新 → 更新本地订单
  registerInboundHandler('erp.order.updated', async (payload) => {
    const order = await Order.update(payload.orderId, {
      status: payload.status,
      lastUpdatedBy: 'ERP'
    });
    // 可选: 再次发出 outbound webhook
    await publishWebhookEvent('order.erp-updated', order);
  });
  ```

---

### 3.2 告警中心联动 🔔 优先级 2

#### 功能概述
Webhook 投递失败、性能异常时自动创建系统告警

#### 告警规则
```
1. 单个端点失败率 > 10% (最近 1h) → 告警: ENDPOINT_UNHEALTHY
2. 全局投递延迟 > 5s (p95) → 告警: HIGH_LATENCY
3. DLQ 消息数 > 20 → 告警: DLQ_BACKLOG_CRITICAL
4. Worker 未运行 (最近 2 分钟无心跳) → 告警: WORKER_DOWN
5. 连续 5 个失败相同错误 → 告警: REPEATED_FAILURE (可能是代码问题)
```

#### 实现清单
- [ ] 新建 `AlertService`
  - `createAlert(type, severity, details)` - 创建告警
  - `updateAlertStatus()` - 更新告警状态
  - `publishToAlertCenter()` - 发送到告警中心
- [ ] 与已有告警系统集成
  - 查询现有的 Alert/Notification 表结构
  - 创建桥接层 (AlertBridge)
- [ ] 监控 Worker
  - 每次投递尝试记录心跳
  - 检测心跳缺失
- [ ] 前端页面: 告警仪表盘

---

### 3.3 细粒度权限与审计 🔐 优先级 3

#### 权限模型（RBAC 增强）
```
当前权限: admin / regular user (二元)

增强后:
  - Admin
    - 管理 endpoints (创建/删除)
    - 管理 subscriptions (全部用户的)
    - 查看所有投递日志
    - 操作 DLQ (审核/重试/放弃)
    
  - Webhook Manager (新角色)
    - 管理 endpoints (仅自己的)
    - 管理 subscriptions (仅自己的)
    - 查看自己的投递日志
    - 无法操作其他用户的 DLQ
    
  - Webhook Viewer (新角色)
    - 查看 endpoints (仅自己的)
    - 查看 subscriptions (仅自己的)
    - 查看投递日志 (仅自己的)
    - 无法修改配置
```

#### 审计日志
```
记录所有变更操作:
  - 谁 (userId)
  - 做了什么 (action: CREATE/UPDATE/DELETE)
  - 操作对象 (resourceType: endpoint/subscription, resourceId)
  - 时间 (timestamp)
  - 变更详情 (before/after 对比)
  - IP 地址 (sourceIp)
  
示例:
  {
    userId: "user_123",
    action: "UPDATE",
    resourceType: "endpoint",
    resourceId: "endpoint_uuid",
    changes: {
      status: { before: "ACTIVE", after: "INACTIVE" },
      maxRetries: { before: 5, after: 10 }
    },
    timestamp: "2026-05-12T10:00:00Z",
    sourceIp: "192.168.1.1"
  }
```

#### 实现清单
- [ ] 扩展 `users` 表的 `role` 字段
  - 从 string 升级到 string[] (支持多角色)
  - 或新建 `UserRole` 表
- [ ] 新表: `WebhookAuditLog`
  ```
  id, user_id, action, resource_type, resource_id, 
  changes (JSON), timestamp, source_ip
  ```
- [ ] 新建 `AuditService`
  - `logAction()` - 记录操作
  - `getAuditTrail(resourceId)` - 查看资源的完整变更历史
- [ ] 权限检查中间件
  - 每个路由检查当前用户是否有权限
- [ ] 前端页面: 审计日志查看器

---

## 🏗️ 实施路线图

### 第 1-2 周: Phase 2 核心
```
Week 1:
  Day 1-2: 自动重试 + DLQ 核心逻辑
  Day 3-4: 高级过滤规则引擎
  Day 5:   集成测试 + 修复 bug

Week 2:
  Day 1-3: 批量重放功能
  Day 4:   前端 UI 开发 (DLQ 面板 + 重放向导)
  Day 5:   全集成测试 + 部署验证
  
📦 Milestone: Phase 2a 完成，可生产部署
```

### 第 3-6 周: Phase 3 架构
```
Week 3:
  Day 1-2: 入站 webhook 数据模型 + 基础 API
  Day 3-4: 入站处理器框架
  Day 5:   处理器示例实现

Week 4:
  Day 1-2: 告警中心集成
  Day 3-4: 监控规则配置
  Day 5:   前端告警仪表盘

Week 5-6:
  Day 1-3: 权限模型升级 + RBAC 中间件
  Day 4-5: 审计日志完整实现
  
📦 Milestone: Phase 3 完成，企业级功能就绪
```

---

## 💾 数据库迁移计划

### Phase 2 迁移
```sql
-- 1. 扩展 webhook_deliveries
ALTER TABLE webhook_deliveries ADD COLUMN quarantine_reason TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN quarantine_at TIMESTAMP;
ALTER TABLE webhook_deliveries ADD COLUMN dlq_reviewed_by UUID REFERENCES users(id);
ALTER TABLE webhook_deliveries ADD COLUMN dlq_action TEXT;

-- 2. 新表: webhook_replay_batches
CREATE TABLE webhook_replay_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_at TIMESTAMP NOT NULL DEFAULT NOW(),
  triggered_by UUID NOT NULL REFERENCES users(id),
  filter_query JSON NOT NULL,
  total_deliveries INT NOT NULL,
  succeeded INT DEFAULT 0,
  failed INT DEFAULT 0,
  pending INT DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING'
);

-- 3. 更新 webhook_subscriptions 的 filters 格式
-- 迁移脚本会自动转换 {"urgency": [...]} → {"logic": "AND", "rules": [...]}
```

### Phase 3 迁移
```sql
-- 1. 新表: inbound_webhook_endpoints
CREATE TABLE inbound_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  source_system VARCHAR(100) NOT NULL,
  url_path VARCHAR(255) UNIQUE NOT NULL,
  auth_method VARCHAR(50) NOT NULL, -- HMAC / API_KEY / NONE
  secret TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. 新表: inbound_webhook_deliveries
CREATE TABLE inbound_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES inbound_webhook_endpoints(id),
  payload JSON NOT NULL,
  status VARCHAR(50) NOT NULL, -- SUCCESS / FAILED / RETRY
  error_message TEXT,
  attempts INT DEFAULT 1,
  processed_at TIMESTAMP,
  received_at TIMESTAMP DEFAULT NOW()
);

-- 3. 新表: webhook_audit_logs
CREATE TABLE webhook_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(50) NOT NULL, -- CREATE / UPDATE / DELETE / RETRY / REVIEW
  resource_type VARCHAR(100) NOT NULL, -- endpoint / subscription / dlq_message
  resource_id UUID NOT NULL,
  changes JSON, -- {field: {before, after}}
  source_ip VARCHAR(50),
  timestamp TIMESTAMP DEFAULT NOW()
);

-- 4. 扩展 users 表的权限模型
ALTER TABLE users ADD COLUMN roles VARCHAR(100)[] DEFAULT ARRAY['regular'];
-- 或
CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(50) NOT NULL,
  PRIMARY KEY (user_id, role)
);
```

---

## 🧪 测试计划

### Phase 2 测试
- [ ] DLQ 功能:
  - 失败 5 次后自动隔离
  - 管理员可查看 DLQ 列表
  - 支持重试/放弃/编辑参数
  - DLQ 恢复后自动从隔离移出
  
- [ ] 过滤规则:
  - 支持新操作符 (regex, gt, lt 等)
  - AND/OR/NOT 逻辑正确
  - 复杂规则性能测试
  - 规则编译缓存测试
  
- [ ] 批量重放:
  - 查询条件正确
  - 预估数字准确
  - 并发重放不冲突
  - 进度跟踪准确
  - 可中断/恢复

### Phase 3 测试
- [ ] 入站 webhook:
  - 签名验证正确
  - 处理器回调执行
  - 错误自动重试
  
- [ ] 告警:
  - 规则触发正确
  - 告警聚合去重
  - 与现有告警系统集成
  
- [ ] 权限与审计:
  - RBAC 检查在所有端点生效
  - 审计日志完整记录
  - 无权限用户无法访问

---

## 📊 验收标准

✅ Phase 2 完成时:
- 代码覆盖率 > 80%
- 无类型错误 (tsc 0 errors)
- 构建成功 (npm run build ✓)
- 5 阶段集成测试通过
- 文档完整 (API、部署、故障排查)

✅ Phase 3 完成时:
- 企业级功能就绪
- 权限系统全覆盖
- 审计日志完整
- 可支持多源系统集成

---

**计划开始时间**: 立即  
**Phase 2 目标完成**: 2 周  
**Phase 3 目标完成**: 4 周  
**总体上线时间**: 6 周内
