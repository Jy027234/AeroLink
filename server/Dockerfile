# ============================================
# AeroLink 后端 - 开发环境 Docker 配置
# ============================================

FROM node:22-alpine AS base
RUN apk add --no-cache openssl openssl-dev
WORKDIR /app

# 安装依赖阶段
FROM base AS deps
COPY server/package*.json ./
RUN npm ci

# 开发阶段
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./
EXPOSE 3000
CMD ["npm", "run", "dev"]

# 构建阶段
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./
RUN npm run build

# 生产阶段
FROM base AS production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["npm", "start"]
