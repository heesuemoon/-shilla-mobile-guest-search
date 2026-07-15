FROM node:20-bookworm

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev \
  && npx playwright install --with-deps chromium

COPY server.js ./server.js

EXPOSE 3000

CMD ["npm", "start"]
