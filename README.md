# Puppeteer API Web app

A simple Node.js + Express + Puppeteer API server to fetch rendered HTML of JS-heavy sites.

## Usage

Build Docker image:
```bash
docker build -t puppeteer-api .
```

Run:
```bash
docker run -p 3000:3000 puppeteer-api
```

Example request:
```bash
curl http://localhost:3000/html?url=https://mageartic.com
```
