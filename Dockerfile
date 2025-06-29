FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libnspr4 \
  libnss3 \
  libxss1 \
  xdg-utils &&
  rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY index.js .

EXPOSE 3000
CMD ["node", "index.js"]
