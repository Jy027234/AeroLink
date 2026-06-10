# ============================================
# AeroLink 前端 - 开发环境 Docker 配置
# ============================================
# 使用 Node 官方镜像作为基础，复用缓存层

FROM node:22-alpine AS base
WORKDIR /app

# 安装依赖阶段 - 复用缓存
FROM base AS deps
COPY package*.json ./
RUN npm ci

# 构建阶段
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx vite build

# 开发阶段
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# 生产阶段
FROM base AS production
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 5173
CMD ["npx", "serve", "dist", "-l", "5173"]
