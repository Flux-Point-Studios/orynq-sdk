# Build from the repository root; the worker depends on workspace packages:
#   docker build -f services/anchor-worker/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@fluxpointstudios/anchor-worker..." \
 && pnpm --filter "@fluxpointstudios/anchor-worker..." build \
 && pnpm --filter @fluxpointstudios/anchor-worker deploy --prod /out

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
EXPOSE 3333
CMD ["node", "dist/index.js"]
