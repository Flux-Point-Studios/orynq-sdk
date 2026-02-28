FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY dist/ ./dist/

USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
