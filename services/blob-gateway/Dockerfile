FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY dist/ ./dist/

USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
