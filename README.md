# Puppeteer API Web app

A simple Node.js + Express + Puppeteer API server to fetch rendered HTML of JS-heavy sites.

## Usage

Build and Run Docker image:

```bash
# Build the image
docker build -t puppeteer-api .

# Run the container
docker run -p 3000:3000 --name puppeteer-api puppeteer-api

# With resource limits (recommended)
docker run -p 3000:3000 --memory=512m --cpus=1 --name puppeteer-api puppeteer-api
```

Example request:

```bash
curl http://localhost:3000/html?url=https://mageartic.com
```
