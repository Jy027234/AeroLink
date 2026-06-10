# AeroLink 库存中心优化方案

> 版本：v1.0  
> 日期：2026-06-05  
> 状态：待评审

---

## 一、现状问题

### 1.1 数据模型缺陷

当前 `Inventory` 为**扁平单表结构**，所有航材共用同一套字段：

| 问题 | 现状 | 业务影响 |
|------|------|---------|
| 无航材分类 | 仅有 `partNumber` + `description`，不区分周转件/消耗件/化工品 | 无法按类别设置库存策略、校验规则、UI 展示 |
| 追踪方式混用 | `serialNumber` 和 `batchNumber` 同时存在且均为可选 | 序号件数量应为 1 但系统无法强制约束 |
| 数量语义模糊 | 单一 `quantity` 字段 | 批次件支持多数量；序号件应强制为 1 |
| 化工品属性缺失 | 无保质期预警、温控要求、危险品等级 | 化工品过期风险无法系统管控 |
| 库存健康度一刀切 | 所有件号共用同一套安全库存阈值 | 周转件和螺钉的安全库存逻辑完全不同 |
| 表单字段无序 | 所有字段平铺展示，无分组优先级 | 用户填写效率低，关键字段不突出 |

### 1.2 行业规范对标

根据厦航、波音 U-File、空客 CML 等航材管理规范：

- **周转件 (Rotable)**：高价值、可修复重复使用，**以序号跟踪**（发动机、起落架、航电设备）
- **消耗件 (Consumable)**：一次性使用或不可修复，**以批次跟踪**，可细分为：
  - 标准件（螺钉、垫片、卡箍）
  - 化工品（润滑油、液压油、密封胶、清洁剂）— 有保质期、温控要求、危险品分类
  - 原材料（金属板材、线材、管材）
  - 一般消耗件（滤芯、灯泡、O-ring）

---

## 二、数据模型优化

### 2.1 Prisma Schema 变更

```prisma
model Inventory {
  id                String   @id @default(uuid())
  partNumber        String
  description       String
  
  // ===== 新增：航材分类体系 =====
  partCategory      String   @default("CONSUMABLE")
  // 枚举值：ROTABLE | REPAIRABLE | CONSUMABLE | CHEMICAL | STANDARD_PART | RAW_MATERIAL
  
  trackingType      String   @default("BATCH")
  // 枚举值：SERIAL | BATCH
  // 规则：ROTABLE/REPAIRABLE → SERIAL；其余 → BATCH
  
  quantity          Int
  serialNumber      String?
  batchNumber       String?
  
  // ===== 新增：化工品专用字段 =====
  shelfLifeDays     Int?     // 保质期（天），由生产日期自动计算
  storageTempMin    Float?   // 最低存储温度（℃）
  storageTempMax    Float?   // 最高存储温度（℃）
  hazardClass       String?  // 危险品等级：NON_HAZARDOUS | CLASS_3 | CLASS_8 | CLASS_9 ...
  
  // 状态与条件
  conditionCode     String   @default("NE")
  certificateType     String   @default("NONE")
  certificateNumber String?
  certificateFileUrl String?
  
  // 时寿与寿命（LLP/Time-Controlled）
  lifeLimited       Boolean @default(false)
  totalHours        Float?
  totalCycles       Float?
  remainingHours    Float?
  remainingCycles   Float?
  manufactureDate   DateTime?
  shelfLifeDate     DateTime?
  overhaulDate      DateTime?
  nextOverhaulDue   DateTime?
  
  // 适航与维修状态
  adStatus          String?
  sbStatus          String?
  repairScheme      String?
  
  // 来源追溯（二手件）
  previousOperator  String?
  removalAircraftReg String?
  removalDate       DateTime?
  removalReason     String?
  nonIncidentStatement Boolean @default(false)
  militarySource    Boolean @default(false)
  traceabilityDocs  String?
  
  // 存储与包装
  location          String
  warehouse         String?
  shelf             String?
  storageCondition  String?
  ata300Packaging   Boolean @default(false)
  
  // 商务属性
  unitCost          Float
  unitOfMeasure     String   @default("EA")
  countryOfOrigin   String?
  hsCode            String?
  
  type              String   @default("OWN")
  supplierId        String?
  eta               DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  supplier Supplier? @relation(fields: [supplierId], references: [id])
  certificates Certificate[]
  
  @@map("inventory")
}
```

### 2.2 业务规则约束

```typescript
// 校验规则矩阵
const inventoryValidationRules = {
  // 周转件
  ROTABLE: {
    trackingType: 'SERIAL',
    quantity: { exact: 1, readonly: true },
    requiredFields: ['serialNumber'],
    forbiddenFields: ['batchNumber'],
    optionalTabs: ['lifelimited', 'traceability'],
  },
  // 可修件
  REPAIRABLE: {
    trackingType: 'SERIAL',
    quantity: { exact: 1, readonly: true },
    requiredFields: ['serialNumber'],
    forbiddenFields: ['batchNumber'],
    optionalTabs: ['lifelimited', 'traceability'],
  },
  // 化工品
  CHEMICAL: {
    trackingType: 'BATCH',
    quantity: { min: 1 },
    requiredFields: ['batchNumber', 'shelfLifeDate', 'storageCondition'],
    optionalFields: ['hazardClass', 'storageTempMin', 'storageTempMax'],
    forbiddenFields: ['serialNumber', 'lifeLimited', 'totalHours', 'totalCycles'],
    shelfLifeWarning: { yellow: 90, red: 30 },
  },
  // 标准件
  STANDARD_PART: {
    trackingType: 'BATCH',
    quantity: { min: 1 },
    requiredFields: ['batchNumber'],
    forbiddenFields: ['serialNumber', 'lifeLimited'],
  },
  // 原材料
  RAW_MATERIAL: {
    trackingType: 'BATCH',
    quantity: { min: 1 },
    requiredFields: ['batchNumber'],
    forbiddenFields: ['serialNumber', 'lifeLimited'],
  },
  // 一般消耗件
  CONSUMABLE: {
    trackingType: 'BATCH',
    quantity: { min: 1 },
    requiredFields: ['batchNumber'],
    forbiddenFields: ['serialNumber', 'lifeLimited'],
  },
};
```

---

## 三、表单显示顺序优化（核心新增）

### 3.1 设计原则

1. **分类驱动**：选择 `partCategory` 后，表单字段、顺序、必填项、Tab 可见性全部动态变化
2. **关键字段优先**：件号、描述、分类、追踪标识放在最前面
3. **逻辑分组**：按"标识 → 数量/状态 → 证书 → 位置 → 成本 → 特殊属性"顺序排列
4. **减少干扰**：当前分类无关的字段隐藏或置灰，不展示无用 Tab

### 3.2 通用字段（所有类型共享，固定在最上方）

```
┌─────────────────────────────────────────────────────────────┐
│  ① 件号 *              ② 描述 *                            │
│  ③ 航材分类 *          ④ 追踪方式 *（由分类自动推断）        │
│  ⑤ 制造商              ⑥ CAGE Code                          │
│  ⑦ ATA 章节            ⑧ 互换件号                          │
└─────────────────────────────────────────────────────────────┘
```

**说明**：
- ③ 航材分类为新增字段，选择后触发整个表单重构
- ④ 追踪方式默认由分类自动填充（ROTABLE/REPAIRABLE → SERIAL；其余 → BATCH），允许手动修正
- ①② 件号和描述保持最前，因为它们是 IPC 自动填充的触发字段

### 3.3 按分类的差异化表单顺序

#### A. 周转件（Rotable）— 序号管理

```
┌─────────────────────────────────────────────────────────────┐
│ 【通用字段】                                                  │
│  件号 * | 描述 * | 分类 * | 追踪方式 * | 制造商 | CAGE ...  │
├─────────────────────────────────────────────────────────────┤
│ 【核心标识】（第1优先级）                                     │
│  ⑨ 序号 *              ⑩ 数量 = 1（只读）                   │
├─────────────────────────────────────────────────────────────┤
│ 【状态与证书】（第2优先级）                                   │
│  ⑪ Condition Code *    ⑫ Certificate Type *                │
│  ⑬ 证书编号            ⑭ 证书文件                           │
├─────────────────────────────────────────────────────────────┤
│ 【位置信息】（第3优先级）                                     │
│  ⑮ 仓库                ⑯ 货架                              │
│  ⑰ 库位 *                                                        │
├─────────────────────────────────────────────────────────────┤
│ 【成本信息】（第4优先级）                                     │
│  ⑱ 成本                ⑲ 计量单位（默认 EA，只读）           │
│  ⑳ 原产国              ㉑ 海关编码                         │
├─────────────────────────────────────────────────────────────┤
│ 【时寿件 Tab】（仅 lifeLimited = true 时展开）               │
│  总使用小时 | 剩余小时 | 总循环 | 剩余循环                   │
│  制造日期 | 上次大修 | 下次大修 | 库存寿命到期日             │
│  AD 状态 | SB 状态 | 修理方案                                │
├─────────────────────────────────────────────────────────────┤
│ 【二手件追溯 Tab】（AR/RP 状态时必填）                        │
│  前运营人 | 拆下飞机注册号 | 拆下日期 | 拆下原因             │
│  无事故声明(NIS) | 军方来源 | 追溯文件清单                   │
├─────────────────────────────────────────────────────────────┤
│ 【存储与包装 Tab】                                            │
│  存储条件 | ATA-300 包装                                     │
└─────────────────────────────────────────────────────────────┘
```

**关键变化**：
- 序号放在通用字段之后的第一位，因为它是周转件的核心标识
- 数量固定为 1，以只读标签展示，不显示输入框
- 计量单位固定为 EA，不显示选择器
- 时寿件 Tab 默认折叠，勾选 `lifeLimited` 后展开
- 二手件追溯 Tab 仅在 Condition Code 为 AR/RP 时显示

#### B. 化工品（Chemical）— 批次管理

```
┌─────────────────────────────────────────────────────────────┐
│ 【通用字段】                                                  │
│  件号 * | 描述 * | 分类 * | 追踪方式 * | 制造商 | CAGE ...  │
├─────────────────────────────────────────────────────────────┤
│ 【核心标识】（第1优先级）                                     │
│  ⑨ 批次号 *            ⑩ 数量 *                             │
├─────────────────────────────────────────────────────────────┤
│ 【化工品专用】（第2优先级，新增区域）                         │
│  ⑪ 保质期到期日 *      ⑫ 存储条件 *                         │
│  ⑬ 危险品等级          ⑭ 存储温度范围（℃）                 │
│      最低：___  最高：___                                   │
├─────────────────────────────────────────────────────────────┤
│ 【状态与证书】（第3优先级）                                   │
│  ⑮ Condition Code *   ⑯ Certificate Type *                │
│  ⑰ 证书编号            ⑱ 证书文件                           │
├─────────────────────────────────────────────────────────────┤
│ 【位置信息】（第4优先级）                                     │
│  ⑲ 仓库                ⑳ 货架                              │
│  ㉑ 库位 *                                                        │
├─────────────────────────────────────────────────────────────┤
│ 【成本信息】（第5优先级）                                     │
│  ㉒ 成本                ㉓ 计量单位                         │
│  ㉔ 原产国              ㉕ 海关编码                         │
├─────────────────────────────────────────────────────────────┤
│ 【存储与包装 Tab】（唯一 Tab，无时寿/二手件）                 │
│  存储条件 | ATA-300 包装                                     │
└─────────────────────────────────────────────────────────────┘
```

**关键变化**：
- 新增"化工品专用"区域，放在核心标识之后、证书之前
- 保质期到期日必填，入库时校验 ≥ 当前日期 + 30 天
- 存储条件必填，选项：常温区 / 空调区(15-18℃) / 低温区(5-8℃) / 超低温区(-18℃) / 危险品区
- 危险品等级选项：NON_HAZARDOUS / CLASS_3(易燃液体) / CLASS_8(腐蚀品) / CLASS_9(杂项)
- **隐藏时寿件 Tab**（化工品无小时/循环概念）
- **隐藏二手件追溯 Tab**（化工品不涉及拆机追溯）
- 保质期到期前 90 天表单顶部显示黄色横幅预警，30 天显示红色横幅

#### C. 标准件 / 原材料 / 一般消耗件（Consumable）— 批次管理

```
┌─────────────────────────────────────────────────────────────┐
│ 【通用字段】                                                  │
│  件号 * | 描述 * | 分类 * | 追踪方式 * | 制造商 | CAGE ...  │
├─────────────────────────────────────────────────────────────┤
│ 【核心标识】（第1优先级）                                     │
│  ⑨ 批次号 *            ⑩ 数量 *                             │
│  ⑪ 计量单位 *                                                   │
├─────────────────────────────────────────────────────────────┤
│ 【状态与证书】（第2优先级）                                   │
│  ⑫ Condition Code *   ⑬ Certificate Type *                │
│  ⑭ 证书编号            ⑮ 证书文件                           │
├─────────────────────────────────────────────────────────────┤
│ 【位置信息】（第3优先级）                                     │
│  ⑯ 仓库                ⑰ 货架                              │
│  ⑱ 库位 *                                                        │
├─────────────────────────────────────────────────────────────┤
│ 【成本信息】（第4优先级）                                     │
│  ⑲ 成本                ⑳ 计量单位（已在上文）                │
│  ㉑ 原产国              ㉒ 海关编码                         │
├─────────────────────────────────────────────────────────────┤
│ 【存储与包装 Tab】（唯一 Tab，无时寿/二手件）                 │
│  存储条件 | ATA-300 包装                                     │
└─────────────────────────────────────────────────────────────┘
```

**关键变化**：
- 计量单位选择器提前到核心标识区域（标准件常用 KG/M/FT/RL，不是 EA）
- **隐藏时寿件 Tab**（消耗件无小时/循环概念）
- **隐藏二手件追溯 Tab**（消耗件不涉及拆机追溯）
- 原材料可额外显示规格字段（厚度/宽度/长度，未来扩展）

### 3.4 Tab 可见性规则

| Tab | ROTABLE | REPAIRABLE | CHEMICAL | STANDARD_PART | RAW_MATERIAL | CONSUMABLE |
|-----|---------|------------|----------|---------------|--------------|------------|
| 基本信息 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 时寿件 | ✅（可选） | ✅（可选） | ❌ | ❌ | ❌ | ❌ |
| 二手件追溯 | ✅（AR/RP时） | ✅（AR/RP时） | ❌ | ❌ | ❌ | ❌ |
| 存储与包装 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 化工品专用 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

### 3.5 表单顶部动态预警横幅

```
┌─────────────────────────────────────────────────────────────┐
│ 🔴 该化工品保质期将于 2026-08-15 到期（剩余 28 天）        │  ← 红色：≤30 天
├─────────────────────────────────────────────────────────────┤
│ 🟡 该化工品保质期将于 2026-10-15 到期（剩余 89 天）        │  ← 黄色：≤90 天
├─────────────────────────────────────────────────────────────┤
│ 🔴 该序号件剩余小时仅 320 小时，低于 500 小时阈值          │  ← 时寿件红色预警
├─────────────────────────────────────────────────────────────┤
│ ⚠️  该件号已被 MS20426-3 替代，请核实                      │  ← IPC 替代警告（现有）
└─────────────────────────────────────────────────────────────┘
```

---

## 四、库存列表页优化

### 4.1 分类筛选栏

```
┌─────────────────────────────────────────────────────────────┐
│ [全部 128] [周转件 12] [化工品 48] [标准件 52] [原材料 8] [消耗件 8] │
│                                                             │
│ 🔍 搜索件号/描述    [分类 ▼] [状态 ▼] [仓库 ▼] [保质期预警 ▼] │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 列表列定义（按分类动态）

**通用列**：件号 | 描述 | 分类 | 总数量 | 可用数量 | 状态

**周转件额外列**：序号 | 剩余小时 | 剩余循环 | 时寿状态

**化工品额外列**：批次号 | 保质期 | 存储条件 | 危险品标识

**标准件/原材料额外列**：批次号 | 计量单位 | 仓库

### 4.3 行内标识

```
┌─────────────────────────────────────────────────────────────┐
│ MS20426  螺钉           标准件   1,250   1,200   充足      │
│ BMS5-95  密封胶         化工品   48      42      偏低  🧪⚠️ │  ← 化工品图标 + 保质期预警
│ 738234-5 液压作动筒     周转件   3       2       充足  🔧  │  ← 周转件图标
│ CFM56-7B 发动机核心机   周转件   1       0       紧急  🔴🔧│  ← 时寿红色预警
└─────────────────────────────────────────────────────────────┘
```

---

## 五、库存健康度算法优化

### 5.1 按分类的安全库存策略

```typescript
const safetyStockRules = {
  ROTABLE: {
    formula: 'POISSON',        // 泊松分布
    leadTimeWeeks: 12,
    targetFillRate: 0.95,
    minStock: 1,                // 周转件至少备 1 个
  },
  REPAIRABLE: {
    formula: 'POISSON',
    leadTimeWeeks: 8,
    targetFillRate: 0.90,
  },
  CHEMICAL: {
    formula: 'FIXED_MIN_MAX',   // 固定 min/max
    minStock: 1,
    maxStock: 6,                // 考虑保质期，不能多囤
    reorderPoint: 2,
    shelfLifeConstraint: true,  // 保质期约束参与计算
  },
  STANDARD_PART: {
    formula: 'EOQ',             // 经济订货量
    reorderPoint: 50,
    orderQuantity: 200,
  },
  RAW_MATERIAL: {
    formula: 'EOQ',
    reorderPoint: 10,
    orderQuantity: 100,
  },
  CONSUMABLE: {
    formula: 'FIXED_MIN_MAX',
    minStock: 5,
    maxStock: 50,
  },
};
```

### 5.2 化工品保质期预警

```typescript
const shelfLifeAlerts = {
  CRITICAL: { days: 30,  color: 'red',    action: '禁止出库，启动报废流程' },
  WARNING:  { days: 90,  color: 'yellow', action: '优先出库，暂停采购' },
  NOTICE:   { days: 180, color: 'blue',   action: '关注，纳入采购评估' },
};
```

---

## 六、对其他模块的影响

### 6.1 报价 / 订单模块

| 影响点 | 当前问题 | 优化方案 |
|--------|---------|---------|
| 库存检查 | 仅检查件号总数量 | 检查具体批次/序号的可用性 |
| 订单出库 | 扣减总数量 | 必须指定出库的 batchNumber / serialNumber |
| 化工品报价 | 无特殊处理 | 校验保质期是否满足客户要求（如剩余 ≥ 6 个月） |
| 序号件报价 | 无特殊处理 | 报价绑定具体 serialNumber，带出时寿信息 |

**出库流程**：
```
1. 客户确认报价 → 生成订单
2. 系统锁定库存（Reservation）：
   - BATCH 类型：锁定具体 batchNumber 的数量
   - SERIAL 类型：锁定具体 serialNumber
3. 出库时：
   - BATCH 类型：按 FIFO 自动建议批次，允许人工调整
   - SERIAL 类型：必须扫描/选择具体序号
4. 生成出库单：记录 batchNumber / serialNumber，用于追溯
```

### 6.2 RFQ / 寻源模块

- 化工品 RFQ 只能发给有 `canSupplyChemical = true` 的供应商
- 周转件优先寻源 OEM / 145 维修站
- 化工品报价比较时需考虑保质期（不能只看单价）

### 6.3 供应商管理模块

```prisma
model Supplier {
  // ... 现有字段
  canSupplyRotable    Boolean @default(false)
  canSupplyChemical   Boolean @default(false)
  hasDangerousGoodsLicense Boolean @default(false)
  hasColdChain        Boolean @default(false)
}
```

### 6.4 证书管理模块

| 类型 | 证书关联方式 |
|------|-------------|
| 序号件 | 一对一：`Certificate` → `inventoryId` + `serialNumber` |
| 批次件 | 一对多：`Certificate` → `inventoryId` + `batchNumber`（该批次共享） |
| 化工品 | 必须包含 MSDS + COA |

---

## 七、实施计划

### Phase 1：分类体系落地（第 1-2 周）

**目标**：新增分类字段，改造表单入口

| 任务 | 负责人 | 交付物 |
|------|--------|--------|
| 数据库迁移：新增 `partCategory`、`trackingType` 等字段 | 后端 | Migration 脚本 |
| 数据清洗：为现有库存自动推断分类 | 后端 | 清洗脚本 + 人工复核清单 |
| 表单改造：新增"航材分类"选择器，选择后动态重构表单 | 前端 | InventoryFormDialog 改造 |
| 列表改造：增加分类筛选和标识 | 前端 | Inventory 列表页改造 |
| 校验规则：按分类实施字段必填/禁用逻辑 | 前后端 | 校验函数 + API 校验 |

**数据清洗规则**：
```
IF serialNumber IS NOT NULL → partCategory = 'ROTABLE', trackingType = 'SERIAL'
ELSE IF description MATCHES '(油|脂|胶|漆|剂|液|化工)' → partCategory = 'CHEMICAL', trackingType = 'BATCH'
ELSE IF description MATCHES '(螺钉|螺母|垫片|卡箍|销)' → partCategory = 'STANDARD_PART', trackingType = 'BATCH'
ELSE IF description MATCHES '(板|管|材|线|棒)' → partCategory = 'RAW_MATERIAL', trackingType = 'BATCH'
ELSE → partCategory = 'CONSUMABLE', trackingType = 'BATCH'
```

### Phase 2：表单顺序优化 + 化工品专项（第 3-4 周）

**目标**：按分类实施差异化表单顺序，化工品字段上线

| 任务 | 负责人 | 交付物 |
|------|--------|--------|
| 按 3.3 节设计，实现 6 种分类的差异化表单布局 | 前端 | 分类表单组件 |
| 化工品专用字段：保质期、存储条件、危险品等级 | 前后端 | 字段 + 校验 + UI |
| 保质期预警系统：入库校验 + 列表预警 + 表单横幅 | 前后端 | 预警组件 + 定时任务 |
| Tab 可见性控制：按分类动态显示/隐藏 Tab | 前端 | Tab 控制逻辑 |

### Phase 3：明细层重构（第 5-7 周）

**目标**：引入 `InventoryItem` + `InventoryDetail` 双层模型

| 任务 | 负责人 | 交付物 |
|------|--------|--------|
| 数据库：新增 `InventoryItem` + `InventoryDetail` 表 | 后端 | Prisma Schema + Migration |
| 数据迁移：现有 Inventory 数据拆分到明细表 | 后端 | 迁移脚本 |
| API 改造：所有库存接口适配双层模型 | 后端 | API 重构 |
| 前端适配：列表/详情/表单对接新数据结构 | 前端 | 组件改造 |
| 出库流程：支持指定 batch/serial | 前后端 | 出库模块改造 |

### Phase 4：跨模块联动（第 8-10 周）

**目标**：报价、订单、RFQ、供应商等模块按分类联动

| 任务 | 负责人 | 交付物 |
|------|--------|--------|
| 订单出库：绑定具体 batch/serial | 前后端 | 出库模块 |
| RFQ 寻源：按分类过滤供应商 | 前后端 | RFQ 模块 |
| 供应商资质：新增供应能力标签 | 前后端 | Supplier 模块 |
| 库存健康度：按分类差异化算法 | 后端 | 健康度计算引擎 |
| 报表模块：新增分类维度报表 | 前后端 | 报表中心 |

---

## 八、风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 数据迁移错误 | 库存数据丢失或分类错误 | 迁移前全量备份；分阶段迁移；人工复核关键件号 |
| 用户操作习惯改变 | 出库流程从"选件号"变为"选件号+批次/序号" | 渐进式引导；前 2 周允许旧模式并行；培训文档 |
| 化工品合规风险 | 危险品分类错误导致合规问题 | 咨询专业航材管理人员；参考 ICAO/IATA DGR 标准；分类变更需审批 |
| 性能下降 | 明细表 JOIN 导致查询变慢 | 对 `partNumber`、`serialNumber`、`batchNumber` 建立索引；列表页使用聚合表 |
| 前端复杂度增加 | 6 种分类 × 多个 Tab 的组合爆炸 | 抽象表单配置引擎（JSON 驱动）；统一表单渲染组件 |

---

## 九、附录

### 9.1 航材分类决策树

```
件号录入
  │
  ├─ 是否有序号？
  │   ├─ 是 → ROTABLE（周转件）或 REPAIRABLE（可修件）
  │   │         └─ 是否可修复后恢复寿命？
  │   │              ├─ 是 → REPAIRABLE
  │   │              └─ 否 → ROTABLE
  │   └─ 否 → 进入消耗件分支
  │
  └─ 消耗件分支
      ├─ 是否有保质期/温控要求？
      │   ├─ 是 → CHEMICAL（化工品）
      │   └─ 否 → 继续判断
      ├─ 是否为标准规格件（螺钉/螺母/垫片/卡箍）？
      │   ├─ 是 → STANDARD_PART（标准件）
      │   └─ 否 → 继续判断
      ├─ 是否为原材料（板材/管材/线材/棒材）？
      │   ├─ 是 → RAW_MATERIAL（原材料）
      │   └─ 否 → CONSUMABLE（一般消耗件）
```

### 9.2 危险品等级参考（ICAO/IATA DGR）

| 等级 | 名称 | 常见航化品示例 |
|------|------|---------------|
| NON_HAZARDOUS | 非危险品 | 一般清洁剂、部分润滑脂 |
| CLASS_3 | 易燃液体 | 航空汽油、液压油、部分溶剂 |
| CLASS_8 | 腐蚀品 | 电池电解液、部分除锈剂 |
| CLASS_9 | 杂项危险品 | 锂电池、磁性材料 |

### 9.3 存储条件选项

| 选项 | 温度范围 | 适用化工品 |
|------|---------|-----------|
| 常温区 | 15℃ ~ 35℃ | 一般密封胶、部分润滑脂 |
| 空调区 | 15℃ ~ 18℃ | 精密化工品、部分涂料 |
| 低温区 | 5℃ ~ 8℃ | 特殊密封胶、部分胶粘剂 |
| 超低温区 | -18℃ | 生物制品、特殊材料 |
| 危险品区 | 按等级隔离 | 易燃液体、腐蚀品 |

---

*文档结束*
