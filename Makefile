# ============================================
# AeroLink Docker 开发命令
# ============================================

.PHONY: help build up down dev logs test clean

help:
	@echo "AeroLink Docker 开发命令:"
	@echo "  make build    - 构建 Docker 镜像"
	@echo "  make up       - 启动所有服务"
	@echo "  make down     - 停止所有服务"
	@echo "  make dev      - 开发模式启动(前台)"
	@echo "  make logs     - 查看日志"
	@echo "  make test     - 运行测试"
	@echo "  make clean    - 清理 Docker 资源"

# 构建镜像
build:
	docker-compose build --no-cache

# 启动服务(后台)
up:
	docker-compose up -d
	@echo "服务已启动:"
	@echo "  前端: http://localhost:5173"
	@echo "  后端: http://localhost:3000"

# 停止服务
down:
	docker-compose down

# 开发模式启动(前台运行)
dev:
	docker-compose up

# 查看日志
logs:
	docker-compose logs -f

# 查看后端日志
logs-backend:
	docker-compose logs -f backend

# 查看前端日志
logs-frontend:
	docker-compose logs -f frontend

# 清理 Docker 资源
clean:
	docker-compose down -v --remove-orphans
	docker system prune -f

# 重新构建并启动
rebuild: down clean build up

# 进入后端容器
shell-backend:
	docker-compose exec backend sh

# 进入前端容器
shell-frontend:
	docker-compose exec frontend sh

# 运行测试
test:
	docker-compose exec backend npm test

# 运行后端构建
build-backend:
	docker-compose exec backend npm run build

# 数据库迁移
db-migrate:
	docker-compose exec backend npx prisma migrate dev

# 数据库重置
db-reset:
	docker-compose exec backend npx prisma db push --force-reset
	docker-compose exec backend npm run db:seed

# 查看后端健康状态
health:
	@curl -s http://localhost:3000/api/health || echo "后端未启动"
