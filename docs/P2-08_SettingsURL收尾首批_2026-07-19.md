# P2-08 Settings URL 收尾首批

日期：2026-07-19（Asia/Shanghai）
状态：首批完成，定向 Playwright 已在隔离 PostgreSQL/API/前端环境通过

用户点击页签现在使用 `pushState`，浏览器前进/后退能够逐项恢复页签；未知/无权限页签仍使用规范化 `replaceState`，不会把非法状态写入历史栈。URL 仍保持 `/settings?tab=<key>`，中英文切换不改变 key。

## 验收证据

验收单测：`src/sections/Settings/tabUrlState.test.ts`；新增 `e2e/p2-settings-url.spec.ts` 覆盖合法深链接、点击后的 pushState、前进/后退和未知页签规范化。

```powershell
$env:E2E_PASSWORD='ci-demo-password-2026'
$env:PLAYWRIGHT_EXTERNAL='true'
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:5174'
$env:PLAYWRIGHT_API_ORIGIN='http://127.0.0.1:3310'
npx playwright test e2e/p2-settings-url.spec.ts --project=chromium
# 2 passed
```

本次使用临时 PostgreSQL（`127.0.0.1:55432`）和独立 API/前端端口；测试完成后应清理临时容器。代码未改变权限可见性逻辑。

## 回滚与下一步

本批无数据库迁移。若回归发现 URL 历史行为异常，可回退 `src/sections/Settings/tabUrlState.ts`、Settings 壳层和对应测试，恢复原有兼容页签适配；不得删除已有权限可见性逻辑或改变 `tab` key。回退后重新执行 Settings 单测、`e2e/p2-settings-url.spec.ts`、根 lint 和构建。当前实现保留 `/settings?tab=<key>` 兼容格式，下一步只需在持续回归中保持该契约。
