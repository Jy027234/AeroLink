# P2 遗留建议执行计划

## 任务1: 空状态统一设计

将全站简陋空状态（仅有 `text-center py-8 text-gray-500` 文字）统一为：图标 + 文案 + 操作引导按钮。

统一空状态组件模式：
```tsx
<div className="text-center py-12 text-gray-500">
  <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
  <p className="text-sm">{tx('暂无数据', 'No data')}</p>
  <Button variant="outline" size="sm" className="mt-3" onClick={...}>
    <Plus className="w-4 h-4 mr-1" />
    {tx('新建', 'Create')}
  </Button>
</div>
```

涉及文件（15+ 处）：
- `src/sections/AgentWorkbench/index.tsx`
- `src/sections/Dashboard/index.tsx` (2处)
- `src/sections/ExchangeVMI/index.tsx`
- `src/sections/RFQManagement/index.tsx`
- `src/sections/Settings/EmailSettings.tsx`
- `src/sections/Settings/UserManagement.tsx`
- `src/sections/Sourcing/index.tsx` (2处)
- `src/sections/SupplierPortal/index.tsx` (2处)
- `src/sections/SupplierQuotes/index.tsx`
- `src/sections/TechnicalKit/index.tsx` (3处)

## 任务2: 弹窗关闭体验统一

为缺少 DialogFooter 的弹窗添加显式关闭按钮：
- `src/sections/ExchangeVMI/index.tsx`
- `src/sections/OrderTracking/index.tsx`
- `src/sections/TechnicalKit/index.tsx`

## 任务3: 移动端适配优化

- `src/components/Layout/Sidebar.tsx` — Sheet 抽屉 `w-[280px]` 改为 `w-[280px] max-w-[85vw]`
- `src/components/Layout/Sidebar.tsx` — Collapsed Sidebar Tooltip 在触摸设备上改为点击触发

## 任务4: 页面切换动画

- `src/components/Layout/index.tsx` — 为 `children` 添加 fade/slide 过渡动画

## 任务5: 错误边界完善

- `src/components/ErrorBoundary.tsx` — 添加错误上报到 localStorage + 错误计数防循环
