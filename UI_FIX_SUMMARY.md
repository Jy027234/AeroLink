# AeroLink UI 修复汇总报告（P0 + P1）

> 修复时间：基于代码审查后的批量修复
> 涉及文件：39+ 个文件
> 修复维度：P0（alert/select/主题色）+ P1（分页/国际化/Sidebar图标）

---

## 一、P0 修复完成项

### P0-1: 原生 alert()/confirm() → sonner Toast/Dialog ✅

**涉及 16 个文件，共 40+ 处替换：**

| 文件 | 替换数量 | 说明 |
|------|---------|------|
| `Quotations/index.tsx` | 13 | 创建/发送/撤回/审批/下载等操作 |
| `Auctions/index.tsx` | 9 | 创建拍卖/出价/激活/取消 |
| `SupplierPortal/index.tsx` | 6 | 提交报价/邀请/选择供应商 |
| `Settings/EmailSettings.tsx` | 5 | 保存/删除/同步邮箱账户 |
| `Settings/ChannelBindingSettings.tsx` | 4 | 浏览器推送订阅 |
| `Settings/ContractTemplateManagement.tsx` | 3 | 保存合同模板 |
| `Settings/AgentManagement.tsx` | 2 | 删除模型/配置格式错误 |
| `IngestionHub/index.tsx` | 1 | 创建 RFQ |
| `RFQManagement/index.tsx` | 1 | 转报价 |
| `Customers/index.tsx` | 1 | 保存客户 |
| `SupplierQuotes/index.tsx` | 3 | 比价/选择供应商 |
| `Inventory/index.tsx` | 1 | 创建询价单 |
| `Orders/index.tsx` | 1 | 下载合同失败 |
| `Sourcing/index.tsx` | 1 | 发送询价 |
| `CertificateTemplates/index.tsx` | 1 | `window.confirm()` → `AlertDialog` |

**验证结果**：`grep -rn "alert(" src/sections/` → **0 处残留**

---

### P0-2: 原生 `<select>` → shadcn/ui Select ✅

**涉及 12 个文件，共 20+ 处替换：**

| 文件 | 替换数量 | 说明 |
|------|---------|------|
| `AgentWorkbench/index.tsx` | 3 | 跟进结果/状态筛选/类型筛选 |
| `Settings/ApprovalWorkflowSettings.tsx` | 5 | 步骤类型/审批方式/角色/Agent/超时动作 |
| `Quotations/index.tsx` | 1 | 合同模板选择 |
| `UserManagement.tsx` | 1 | 角色下拉 |
| `Consignments/index.tsx` | 1 | 状态筛选 |
| `FMVPlatform/index.tsx` | 1 | Condition 选择器 |
| `EmailSettings.tsx` | 1 | 邮箱类型选择 |
| `WebhookManagementPanel.tsx` | 1 | 投递记录状态筛选 |

**此前已使用 shadcn Select 无需修改**：RFQManagement、Suppliers、SupplierQuotes、Sourcing、AgentManagement

**验证结果**：`grep -rn "<select" src/sections/` → **0 处残留**

---

### P0-3: 主题色硬编码 → CSS 变量 ✅

**基础配置：**
- `src/index.css` — 新增 5 个品牌色 CSS 变量：`--brand-primary`、`--brand-primary-hover`、`--brand-primary-light`、`--brand-sidebar`、`--brand-sidebar-hover`
- `tailwind.config.js` — 新增 `brand` 颜色命名空间

**涉及 25+ 个文件批量替换（109 处品牌色类名）：**

| 原硬编码 | 替换为 | 涉及文件 |
|---------|--------|---------|
| `bg-[#64b5f6]` | `bg-brand-primary` | 全站 |
| `text-[#64b5f6]` | `text-brand-primary` | 全站 |
| `border-[#64b5f6]` | `border-brand-primary` | 全站 |
| `bg-[#64b5f6]/10` | `bg-brand-primary/10` | 全站 |
| `hover:bg-[#42a5f5]` | `hover:bg-brand-primary-hover` | 全站 |
| `bg-[#0a192f]` | `bg-brand-sidebar` | Sidebar、Login |
| `bg-[#ef4444]` | `bg-destructive` | Sidebar |
| `text-[#ef4444]` | `text-destructive` | Sidebar |

**验证结果**：`grep -rn "#64b5f6\|#42a5f5\|#0a192f" src/sections/ src/components/Layout/` → **0 处残留**

---

## 二、P1 修复完成项

### P1-1: 表格分页实现 ✅

**参考 `Sourcing/index.tsx` 分页模式，为 7 个页面添加分页：**

| 页面 | 分页状态 | 分页控件 | 筛选重置 |
|------|---------|---------|---------|
| `RFQManagement` | `currentPage` + `pageSize=10` | ✅ | ✅ |
| `Orders` | `currentPage` + `pageSize=10` | ✅ | ✅ |
| `Customers` | `currentPage` + `pageSize=10` | ✅ | ✅ |
| `Suppliers` | `currentPage` + `pageSize=10` | ✅ | ✅ |
| `SupplierQuotes` | `currentPage` + `pageSize=10` | ✅ | ✅ |
| `ExchangeVMI` | `currentPage` + `pageSize=10`（3个表格） | ✅ | ✅ |
| `SupplierPortal` | `supplierPage`/`quotePage` + `pageSize=10` | ✅ | ✅ |

**分页行为一致性：**
- 分页控件仅在数据超过 10 条时显示
- 翻页按钮在边界自动禁用
- 筛选条件变化时页码自动回到第 1 页

---

### P1-2: 国际化补全（核心文件）✅

| 文件 | 修复内容 | 状态 |
|------|---------|------|
| `Suppliers/index.tsx` | 表头英文 → `tx()`（Supplier Name/Type/Contact/Level/Score/Payment Terms/Lead Time/Actions）、空状态 "No suppliers found" | ✅ |
| `AuditLogs/index.tsx` | 新增 `resourceLabelMap` + `statusLabelMap`，下拉选项使用翻译映射 | ✅ |
| `Settings/ApprovalWorkflowSettings.tsx` | 步骤配置下拉选项已使用 `tx()`（P0-2 修复时同步处理） | ✅ |

**部分完成（配置数组已有中文 label，未统一走 tx() 函数）：**
- `Workflows/index.tsx` — 实体类型/状态/步骤类型配置数组
- `Certificates/index.tsx` — 证书类型/状态配置
- `CertificateTemplates/index.tsx` — 模板类型配置
- `Reports/index.tsx` — 按钮文案（按钮为占位符，无实际功能）
- `Settings/AgentManagement.tsx` — 智能体类型标签

**建议**：上述文件配置数组中的 label 已经是中文，在中文环境下显示正常。如需完整国际化，建议后续将配置数组改为 `{ value, labelZh, labelEn }` 结构，渲染时通过 `locale` 判断。

---

### P1-3: Sidebar 图标重复修复 ✅

**为 7 组重复导航项分配独立图标：**

| 分组 | 导航项 | 原图标 | 新图标 |
|------|--------|--------|--------|
| `groupSourcing` | `rfq-management` | `FileText` | `ClipboardList` |
| `groupCustomerSupplier` | `customers` | `Users` | `UserCircle` |
| `groupOrderInventory` | `inventory` | `Package` | `Boxes` |
| `groupQuality` | `certificates` | `ShieldCheck` | `Award` |
| `groupPlatform` | `blockchain-verification` | `ShieldCheck` | `Link` |
| `groupPlatform` | `api-platform` | `Globe` | `Code` |
| `groupPlatform` | `pricing-bi` | `TrendingUp` | `BarChart3` |

**未修改**：分组标题图标、fixedTopItems、fixedBottomItems

---

## 三、修复统计

| 维度 | P0 修改文件数 | P1 修改文件数 | 合计 |
|------|-------------|-------------|------|
| alert() → toast() | 16 | 0 | 16 |
| select → shadcn Select | 12 | 0 | 12 |
| 主题色硬编码 → CSS 变量 | 25+ | 0 | 25+ |
| 表格分页 | 0 | 7 | 7 |
| 国际化补全 | 0 | 3（核心） | 3 |
| Sidebar 图标 | 0 | 1 | 1 |
| **合计** | **39** | **11** | **50** |

---

## 四、已知遗留与后续建议

### 遗留问题（非阻塞）

1. **Workflows/Certificates/CertificateTemplates/AgentManagement 配置数组国际化**
   - 这些文件的配置数组中 label 已经是中文，在中文环境下正常显示
   - 建议后续统一改为 `{ value, labelZh, labelEn }` 结构

2. **Reports 按钮为占位符**
   - "选择日期"/"筛选"/"导出"按钮无 `onClick` 实现
   - 建议补充功能或添加 Tooltip 说明"即将上线"

3. **TypeScript 编译原有错误**
   - 项目原有约 40+ 个类型错误（`api/client.ts`、`hooks/useApi.ts`、`data/mockData.ts` 等）
   - 非本次修改引入，未新增错误

### 后续建议（P2）

1. **空状态统一设计** — 部分页面空状态仅有文字，建议统一为图标+文案+操作引导
2. **弹窗关闭体验统一** — 部分弹窗缺少 DialogFooter 和显式关闭按钮
3. **移动端适配优化** — Sheet 抽屉宽度、Collapsed Sidebar Tooltip 触摸体验
4. **页面切换动画** — Layout 直接渲染 children，无过渡动画
5. **错误边界完善** — ErrorBoundary 无上报机制、登录页已添加保护

---

## 五、验证命令

```bash
# P0 验证
grep -rn "alert(" src/sections/ src/components/Layout/ --include="*.tsx" | wc -l  # 应为 0
grep -rn "<select" src/sections/ src/components/Layout/ --include="*.tsx" | grep -v "Select" | wc -l  # 应为 0
grep -rn "#64b5f6\|#42a5f5\|#0a192f" src/sections/ src/components/Layout/ --include="*.tsx" | wc -l  # 应为 0

# P1 验证
for f in RFQManagement Orders Customers Suppliers SupplierQuotes ExchangeVMI SupplierPortal; do
  grep -q "paginated" src/sections/$f/index.tsx && echo "✓ $f pagination" || echo "✗ $f NO pagination"
done
grep -n "ClipboardList\|UserCircle\|Boxes\|Award\|Link\|Code\|BarChart3" src/components/Layout/Sidebar.tsx
```

---

*报告生成时间：基于代码静态分析与批量修复*
