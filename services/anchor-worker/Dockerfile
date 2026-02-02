FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN corepack enable && pnpm install
COPY . .
RUN pnpm build
EXPOSE 3333
CMD ["node", "dist/index.js"]
