# ============================================
# AeroLink Docker 开发环境指南
# ============================================

## 快速开始

### 方式一：使用 Make 命令（推荐）

```bash
# 构建并启动所有服务
make dev

# 或分步操作
make build   # 构建镜像
make up      # 启动服务

# 查看日志
make logs

# 停止服务
make down
```

### 方式二：直接使用 Docker Compose

```bash
# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

## 访问地址

| 服务 | 地址 | 说明 |
|------|------|------|
| 前端 | http://localhost:5173 | React 应用 |
| 后端 | http://localhost:3000 | Express API |
| 健康检查 | http://localhost:3000/api/health | 后端状态 |

## 测试账号

- 邮箱: `zhang@aerolink.com`
- 密码: `password123`

## 常用命令

```bash
# 进入后端容器
make shell-backend

# 数据库迁移
make db-migrate

# 重置数据库
make db-reset

# 查看后端健康状态
make health
```

## 文件挂载说明

开发模式下，代码目录已挂载到容器：
- `./server:/app` - 后端代码热更新
- `./:/app` (前端) - 前端代码热更新

## 环境变量

- `.env.docker` - Docker 环境变量
- `server/.env.docker` - 后端环境变量

## 清理

```bash
# 停止并清理 Docker 资源
make clean
```
