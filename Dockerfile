# Atoms Demo 生产镜像：构建前端静态产物，运行时用 tsx 直接跑 TypeScript 服务端
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY script ./script
COPY tsconfig.json ./
EXPOSE 3000
VOLUME /data
CMD ["npx", "tsx", "src/server/index.ts"]
