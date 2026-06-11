# AeroLink 航材交易平台 — UI 显示问题审查报告

> 审查方式：代码静态分析 + 组件使用一致性检查
> 审查范围：左侧导航全部 27 个页面 + 共享布局/组件
> 审查维度：按钮、弹窗、空状态、加载状态、国际化、响应式、主题一致性

---

## 一、🔴 严重问题（需优先修复）

### 1. 原生弹窗/通知滥用（跨页面）

多个页面使用原生 `alert()` / `confirm()` / `prompt()`，打断用户操作流程，与项目统一的 Toast/Dialog 风格严重冲突：

| 页面 | 问题位置 | 具体表现 |
|------|---------|---------|
| IngestionHub | `index.tsx:176` | `handleCreateRFQ` 成功/失败调用 `alert()` |
| RFQManagement | `index.tsx:917` | `handleConvertToQuote` 使用 `alert()` 提示跳转 |
| Quotations | `index.tsx:1221, 1307` | 发送/撤回报价使用 `alert()` |
| Customers | `index.tsx:495` | 保存失败使用 `alert(t('customers.saveFailed'))` |
| SupplierQuotes | `index.tsx:132, 143, 147` | 比价/选择供应商/成功提示均用 `alert()` |
| SupplierPortal | `index.tsx:142, 160, 275, 417, 423` | 提交报价/邀请/选择最优供应商使用 `alert()` |
| CertificateTemplates | `index.tsx:353-364` | 删除确认使用 `window.confirm()` |
| Settings/AgentManagement | `AgentManagement.tsx:121, 168, 532, 621` | 大量使用 `alert()/confirm()` |

**修复建议**：统一替换为 `sonner` Toast 或 `shadcn/ui` Dialog 组件。

---

### 2. 原生 `<select>` 与 shadcn Select 混用严重（跨页面）

大量页面在表单中使用原生 HTML `<select>`，与项目统一的 `shadcn/ui Select` 组件视觉风格不一致：

| 页面 | 问题位置 | 具体表现 |
|------|---------|---------|
| AgentWorkbench | `index.tsx:351, 377, 421, 470` | 供应商选择、未选原因、RFQ取消原因等 |
| RFQManagement | `index.tsx:589, 636, 651, 818` | 客户选择、计量单位、状态代码、紧急度 |
| Quotations | `index.tsx:530, 629, 646, 782` | 关联RFQ、销售类型、贸易条款、原产国 |
| Sourcing | `index.tsx:387` | RFQ排序下拉 |
| Suppliers | `index.tsx:1273-1297` | 供应商等级和类型 |
| SupplierQuotes | `index.tsx:228-237` | RFQ筛选 |
| Settings/AgentManagement | `AgentManagement.tsx:121, 168` | 模型选择、代理类型 |
| Settings/ApprovalWorkflow | `ApprovalWorkflowSettings.tsx:447, 518, 541, 553, 677` | 步骤配置 |
| Settings/UserManagement | `UserManagement.tsx:244` | 角色下拉 |

**修复建议**：统一替换为 `@/components/ui/select` 的 `Select` 组件。

---

### 3. 按钮主题色硬编码泛滥（跨页面）

大量页面直接使用 `bg-[#64b5f6] hover:bg-[#42a5f5]` 等硬编码品牌色，未通过 Tailwind 配置或 CSS 变量管理：

- **影响范围**：Dashboard、Orders、Quotations、Inventory、Suppliers、SupplierPortal 等几乎所有页面
- **典型代码**：`bg-[#64b5f6]/10 text-[#64b5f6]`、`bg-[#ef4444]`、`text-[#64b5f6]`
- **风险**：后续换主题成本高；暗黑模式适配困难

**修复建议**：在 `tailwind.config.js` 或 `index.css` 中定义品牌色变量（如 `--brand-primary`），所有组件引用变量。

---

### 4. Sidebar 导航图标重复严重

多个导航项使用相同图标，降低辨识度：

| 图标 | 重复使用的导航项 |
|------|----------------|
| `FileText` | RFQ管理、报价管理 |
| `Truck` | 智能寻源、供应商 |
| `Users` | 客户/供应商分组、客户管理 |
| `Package` | 订单/库存分组、库存中心 |
| `ShieldCheck` | 质量分组、证书管理、区块链验证 |
| `Globe` | 供应商门户、API平台 |
| `TrendingUp` | 定价/BI、FMV平台 |

**修复建议**：为每个导航项分配独立图标，参考 `lucide-react` 图标库中的替代选项。

---

### 5. Sidebar 分组展开状态双重触发冲突

`src/components/Layout/Sidebar.tsx:393-403`

- `Collapsible` 的 `onOpenChange` 与 `GroupButton` 的 `onClick` 同时操作同一 `openGroups` 状态
- 点击分组标题时，`setGroupOpen` 可能被调用两次，导致状态竞争

**修复建议**：移除 `GroupButton` 上的 `onClick`，仅通过 `Collapsible` 的 `onOpenChange` 控制状态。

---

### 6. 登录页未包裹 ErrorBoundary

`src/App.tsx:260-268`

- 认证后的内容有 `<ErrorBoundary>` 保护
- 但登录页直接在 `Suspense` 中渲染，若登录组件报错会导致白屏

**修复建议**：将登录页也包裹在 `ErrorBoundary` 中。

---

### 7. 多个页面表格无分页

| 页面 | 问题 |
|------|------|
| RFQManagement | RFQ列表全量渲染 |
| Quotations | 报价单列表无分页 |
| Orders | 订单列表无分页 |
| Customers | 客户列表无分页 |
| Suppliers | 供应商列表无分页 |
| SupplierQuotes | 报价列表无分页 |
| ExchangeVMI | 换件订单/VMI协议/补货建议无分页 |
| SupplierPortal | 供应商列表无分页 |

**修复建议**：为数据表格添加 `<DataTable>` 分页组件或基于 `react-table` 实现分页。

---

### 8. 国际化硬编码/不完整（跨页面）

| 页面 | 问题 |
|------|------|
| AgentWorkbench | `taskTypeConfig` 标签只有英文 |
| IngestionHub | Sheet底部"Create RFQ"硬编码英文 |
| RFQManagement | 下拉菜单"Create Quotation"等硬编码英文 |
| Certificates | 签发弹窗证书类型下拉全部硬编码英文 |
| CertificateTemplates | 模板类型下拉硬编码英文 |
| Workflows | 实体类型、状态、步骤类型大量硬编码中英文混合 |
| AuditLogs | 操作类型/资源类型下拉直接暴露英文常量 |
| Reports | 顶部"选择日期"/"筛选"/"导出"按钮无功能且硬编码 |
| Suppliers | 表头全部硬编码英文 |
| SupplierPortal | 详情页标签硬编码英文 |

**修复建议**：统一接入 `useTranslation` 的 `t()` 或 `tx()` 函数。

---

### 9. 空按钮/无功能按钮

| 页面 | 问题位置 | 具体表现 |
|------|---------|---------|
| OrderTracking | `index.tsx:379-385` | "查看详情"和"处理"按钮无 `onClick` |
| Quotations | `index.tsx:1587-1590` | "筛选"按钮 `disabled` 且无实现 |
| Orders | `index.tsx:1231` | "筛选"按钮无 `onClick` |
| Inventory | `index.tsx:1781-1788` | 导入/导出按钮无功能 |
| ExchangeVMI | `index.tsx:448` | "生成退运标签"按钮无功能 |
| Reports | `index.tsx:117-130` | "选择日期"/"筛选"/"导出"三个按钮均为占位 |

**修复建议**：补充实现逻辑或添加 `Tooltip` 说明"即将上线"。

---

### 10. 硬编码数据/写死逻辑

| 页面 | 问题位置 | 具体表现 |
|------|---------|---------|
| ExchangeVMI | `index.tsx:136` | 换件表格件号列写死为 `"2341-123-050"` |
| OrderTracking | `index.tsx:194` | 物流进度按 `(events.length / 8) * 100%` 计算，假设最多8个事件 |
| SupplierPortal | `index.tsx:706` | 交付可靠性 `Math.max(0, 100 - leadTime * 2)`，假设50天为0分 |
| Quotations | `index.tsx:1664` | 毛利率 `Progress` 无最大值限制，可能溢出 |

---

## 二、🟡 警告问题（建议修复）

### 1. 弹窗关闭体验不一致

| 页面 | 问题 |
|------|------|
| OrderTracking | 物流详情弹窗缺少 `DialogFooter` 和显式关闭按钮 |
| ExchangeVMI | 换件详情弹窗无 `DialogFooter` |
| IngestionHub | `SheetContent` 依赖自带关闭按钮，底部只有"取消"和"丢弃" |
| RFQManagement | 新建/编辑弹窗缺少 `DialogDescription` |
| SupplierPortal | 比价弹窗缺少 `DialogDescription` |

### 2. 空状态体验参差不齐

- **仅有文字**：OrderTracking customs、AuditLogs
- **图标+文字**：Inventory、Orders
- **图标+文字+操作按钮**：Dashboard（部分）
- **完全缺失**：OrderTracking Tracking Tab、Workflows 定义/实例列表

**建议**：统一为空状态插图 + 文案 + 操作引导按钮。

### 3. 错误处理风格不统一

- **Toast/Sonner**：Orders、Inventory、Suppliers
- **alert()**：Customers、SupplierQuotes、SupplierPortal
- **仅 console.error**：部分页面
- **简单文本**：OrderTracking 仅用 `<p className="text-sm text-red-500">`

### 4. 移动端适配问题

| 问题 | 位置 |
|------|------|
| 移动端搜索按钮无功能 | `Header.tsx:73-75` |
| Sheet抽屉固定 `w-[280px]`，小屏幕拥挤 | `Sidebar.tsx:534` |
| Collapsed Sidebar Tooltip在触摸设备上不可用 | `Sidebar.tsx:445-450` |
| 表格操作列小屏幕下可能挤压 | 多个页面 |

### 5. 组件级问题

| 组件 | 问题 | 位置 |
|------|------|------|
| Dialog | 关闭按钮使用不存在的 `rounded-xs` 类 | `dialog.tsx:70` |
| Sheet | 打开动画 `duration-500` 与关闭 `duration-300` 不一致 | `sheet.tsx:59` |
| Drawer | 无内置关闭按钮，与 Dialog/Sheet 不一致 | `drawer.tsx:48-72` |
| Table | `TableHead` 用 `h-10 px-2`，`TableCell` 用 `p-2`，垂直对齐偏差 | `table.tsx:71, 84` |
| Button | `destructive` 有 dark 模式处理，其他变体没有 | `button.tsx:14-15` |

### 6. 其他代码质量问题

| 页面 | 问题 |
|------|------|
| Customers | 联系人 `logistics` 角色错误映射到 `roleEngineering` |
| Inventory | `handleSave` 直接调用 `window.location.reload()`，破坏SPA体验 |
| Inventory | IPC自动填充逻辑疑似错误，`delete` 应为 `add` |
| Quotations | `handleApprove`/`handleReject` 中 `void comment;` 写法怪异，审批意见未传递 |
| AgentWorkbench | `ConfirmationDialog` 渲染为内联 `<div>` 而非 `<Dialog>`，缺少标准弹窗行为 |
| Dashboard | `FunnelStage` 使用原生 `<button>` 而非 `<Button>` 组件 |

---

## 三、🟢 建议优化（体验提升）

1. **页面切换过渡动画**：`Layout/index.tsx` 直接渲染 children，无 fade/slide 过渡
2. **路由 404 处理**：`App.tsx` 默认回退到 Dashboard，未告知用户页面不存在
3. **Header 高度与 main padding 不匹配**：Header `h-16`（64px） vs main `pt-20`（80px）
4. **ScrollBar 颜色未适配暗黑模式**：`index.css:85-101` 硬编码浅色滚动条
5. **ErrorBoundary 无上报机制**：仅 `console.error`，生产环境无法追踪
6. **日期格式硬编码**：Suppliers 页面固定使用 `'en-US'` locale
7. **AI推荐样式依赖硬编码关键词**：SupplierQuotes 通过判断"强烈推荐"等关键词设置颜色

---

## 四、修复优先级矩阵

| 优先级 | 问题类型 | 涉及页面数 | 预估工作量 |
|--------|---------|-----------|-----------|
| P0 | 原生 alert/confirm 替换为 Toast/Dialog | 10+ | 2-3天 |
| P0 | 原生 select 替换为 shadcn Select | 8+ | 2-3天 |
| P0 | 硬编码主题色迁移到 CSS 变量 | 全站 | 1-2天 |
| P1 | 表格分页实现 | 8 | 2-3天 |
| P1 | 国际化补全（硬编码英文） | 10+ | 2-3天 |
| P1 | Sidebar 图标重复+状态冲突修复 | 1 | 0.5天 |
| P2 | 空状态统一设计 | 全站 | 1-2天 |
| P2 | 弹窗关闭体验统一 | 5+ | 1天 |
| P2 | 移动端适配优化 | 3+ | 1-2天 |
| P3 | 页面切换动画 | 1 | 0.5天 |
| P3 | 错误边界完善 | 1 | 0.5天 |

---

## 五、最严重页面排名（按问题密度）

1. **Settings/AgentManagement** — 原生弹窗 + 原生select + 国际化缺失
2. **Quotations** — 原生select + alert + 无分页 + 硬编码颜色
3. **RFQManagement** — 原生select + alert + 无分页 + 国际化缺失
4. **SupplierPortal** — alert滥用 + 无功能按钮 + 国际化缺失
5. **Workflows** — 大量硬编码中英文混合 + 空状态缺失
6. **OrderTracking** — 空按钮 + 弹窗关闭体验差 + 硬编码进度算法
7. **AuditLogs** — 英文常量暴露 + 分页无标签
8. **Reports** — 全部按钮为占位符 + 空状态简陋

---

*报告生成时间：基于代码静态分析*
*建议配合实际浏览器渲染验证，确认部分问题的视觉表现*
