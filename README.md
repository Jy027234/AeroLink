# AeroLink 航材智能销售系统

AeroLink 是一套面向航空器材销售、寻源、报价、订单跟踪与库存管理的业务系统，覆盖从需求归集、智能寻源到销售成交的完整工作流。

## 产品简介

系统以航空器材交易场景为核心，帮助销售、采购、供应商协同处理 RFQ、报价、订单、库存与物流追踪等业务。前端采用 React + TypeScript + Vite，后端采用 Express + Prisma，目标生产库为 PostgreSQL，同时保留 SQLite 兼容配置用于现网过渡。

## 核心功能

- 智能需求归集：统一收集邮件和询价需求，识别 AOG 紧急单。
- 智能寻源：根据需求单自动匹配库存和供应商。
- 报价管理：管理报价审批、发送、撤回、客户确认与合同生成。
- 订单管理：跟踪订单状态、交付进度、订单金额与自动生成合同下载。
- 库存中心：管理自有库存、在途库存和虚拟库存。
- 客户与供应商管理：维护客户档案、供应商等级和评分。
- 物流追踪：查看订单运输状态和轨迹信息（Beta）。
- 技术资料库：IPC 件号搜索与兼容性检查。
- 换件与 VMI：换件报价与 VMI 补货建议（Beta）。
- 定价情报：市场情报与丢单分析（Beta）。
- 系统设置：管理基础配置、权限、邮箱账户与合同模板。

## 技术栈

- 前端：React、TypeScript、Vite、Tailwind CSS
- 后端：Node.js、Express、Prisma、PostgreSQL（兼容 SQLite 过渡发布）
- 组件库：shadcn/ui 风格组件
- 部署：Docker / Docker Compose

## 本地启动

### 前端

```bash
npm install
npm run dev -- --host
```

### 后端

```bash
cd server
npm install
npm run dev
```

### Docker

```bash
make dev
```

更多 Docker 说明见 [docker-readme.md](docker-readme.md)。

## 生产部署

项目提供单端口生产编排，前端静态资源、`/api`、`/uploads` 和 `socket.io` 全部统一走 `8080` 端口。

生产发布目前有两套 profile：

- `docker-compose.prod.yml`：目标 PostgreSQL profile，适合新环境和正式迁移后的默认方案。
- `docker-compose.prod.sqlite.yml`：SQLite 兼容 profile，用于当前云端存量环境过渡。

1. 复制环境变量样例并填写生产值：

```bash
cp .env.production.example .env.production
```

2. 至少设置以下变量：

```bash
PUBLIC_ORIGIN=http://<服务器IP>:8080
JWT_SECRET=<一段足够长的随机密钥>
DB_PASSWORD=<PostgreSQL profile 必填，SQLite profile 可忽略>
```

3. 准备 Docker secret（如果未使用环境变量回退）：

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/encryption_key.txt
```

4. 选择 profile 启动：

PostgreSQL：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

SQLite 兼容：

```bash
docker compose --env-file .env.production -f docker-compose.prod.sqlite.yml up -d --build
```

5. 查看状态与日志：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f
```

SQLite 兼容 profile 请把上面的 compose 文件名替换为 `docker-compose.prod.sqlite.yml`。

6. 更完整的重启、更新、日志、备份与恢复命令见 [docs/生产运维手册.md](docs/%E7%94%9F%E4%BA%A7%E8%BF%90%E7%BB%B4%E6%89%8B%E5%86%8C.md)。

默认行为：

- 前端通过 Nginx 在 `8080` 提供 SPA 页面。
- 后端容器内部监听 `3000`，由前端网关反向代理。
- PostgreSQL profile 将数据存放在 Docker volume `postgres-data`。
- SQLite 兼容 profile 将数据存放在 Docker volume `backend-data`。
- 上传文件存放在 Docker volume `backend-uploads`。
- 启动时会自动执行 `prisma db push`，并仅在 `users` 表为空时写入演示种子数据。

## 访问地址

| 服务 | 地址 |
|------|------|
| 前端 | http://localhost:5173 |
| 后端 | http://localhost:3000 |
| 健康检查 | http://localhost:3000/api/health |

## 默认管理员账号

以下账号来自初始化种子数据，默认密码均为 `password123`。

| 角色 | 邮箱 | 说明 |
|------|------|------|
| 管理员 / 销售经理 | zhang@aerolink.com | 张经理，销售部 |
| 财务 | li@aerolink.com | 李财务，财务部 |
| 总经理 | wang@aerolink.com | 王总监，总经理室 |

## 数据初始化

如果需要重新生成演示数据，可在后端目录执行：

```bash
npm run db:seed
```

## 测试与回归

### 报价合同聚焦回归

用于交付前快速验证报价发送、撤回、客户确认、合同生成与模板管理这一条关键业务链。执行命令：

```bash
npm run test:e2e:quotation-contract-regression
```

该脚本会通过 Playwright 配置自动拉起前后端服务，并运行以下聚焦场景：

- 报价确认后自动建单，并在订单页下载合同。
- 报价详情、订单详情、合同模板列表加载失败时显示错误横幅并支持重试恢复。
- 客户确认失败、发送失败、撤回失败、报价 PDF 下载失败、订单合同下载失败、模板保存失败时显示正确提示，并保持界面状态不被错误污染。
- 发送报价后列表刷新失败时显示错误横幅，并在重试后恢复到最新状态。

当前聚焦回归位于 `e2e/quotation-contract-flow.spec.ts` 与 `e2e/contract-template-management.spec.ts`，共 11 条 Chromium 场景。

### 导航路由聚焦回归

用于交付前快速验证 URL 深链接、登录后页面保留、浏览器前进/后退以及刷新保留页面。执行命令：

```bash
npm run test:e2e:navigation-regression
```

当前导航回归位于 `e2e/navigation.spec.ts`，覆盖登录态下的订单页深链接、页面间切换、history 往返与刷新保留场景。

### 全量端到端测试

如果需要执行完整 Playwright 回归，可在项目根目录运行：

```bash
npm run test:e2e
```

GitHub Actions CI 会先运行导航路由聚焦回归，再运行报价合同聚焦回归，最后继续执行全量 E2E，以便优先暴露核心导航与关键成交链路回归问题。

## 目录说明

- `src/`：前端应用源码
- `server/`：后端 API 与数据库逻辑
- `e2e/`：端到端测试
- `docs/`：产品与功能文档

## 相关文档

- [docker-readme.md](docker-readme.md)
- [info.md](info.md)
- [docs/功能补全计划.md](docs/功能补全计划.md)
