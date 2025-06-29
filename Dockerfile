# Use Alpine for smaller footprint
FROM node:18-alpine

# Install Chrome dependencies
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont && \
  rm -rf /var/cache/apk/*

# Tell Puppeteer to skip installing Chromium. We'll be using the installed package.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
  NODE_ENV=production \
  NODE_OPTIONS=--max-old-space-size=256

# Create app directory
WORKDIR /usr/src/app

# Add user for security
RUN addgroup -g 1001 -S nodejs && \
  adduser -S nextjs -u 1001

# Copy package files
COPY package*.json ./

# Install dependencies with production flag
RUN npm ci --only=production && npm cache clean --force

# Copy app source
COPY . .

# Change ownership
RUN chown -R nextjs:nodejs /usr/src/app
USER nextjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "const http=require('http');const options={timeout:2000,host:'localhost',port:3000,path:'/'};const request=http.request(options,(res)=>{process.exit(res.statusCode===200?0:1)});request.on('error',()=>process.exit(1));request.end();"

# Start the application
CMD ["node", "index.js"]
