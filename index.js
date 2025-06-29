const express = require("express");
const puppeteer = require("puppeteer");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const puppeteerConfigs = {
  headless: "new",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-zygote",
    "--single-process",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-extensions",
    "--disable-plugins",
    "--disable-default-apps",
    "--disable-web-security",
    "--disable-features=TranslateUI",
    "--disable-ipc-flooding-protection",
  ],
};

const pageBrowserConfigs = {
  waitUntil: "networkidle0",
  timeout: 30000,
};

const app = express();
app.use(express.json());

// Browser pool for optimization
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch(puppeteerConfigs);
  }
  return browserInstance;
}

// Graceful shutdown
process.on("SIGINT", async () => {
  if (browserInstance) {
    await browserInstance.close();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (browserInstance) {
    await browserInstance.close();
  }
  process.exit(0);
});

// Utility function for URL validation
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Utility function for page operations
async function performPageOperation(url, operation) {
  if (!isValidUrl(url)) {
    throw new Error("Invalid URL format");
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Set user agent and viewport for better compatibility
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 720 });

    // Block unnecessary resources for faster loading
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, pageBrowserConfigs);
    return await operation(page);
  } finally {
    await page.close();
  }
}

app.get("/html", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    const html = await performPageOperation(url, async (page) => {
      return await page.content();
    });

    res.type("text/html").send(html);
  } catch (error) {
    console.error("HTML extraction error:", error.message);
    res.status(500).json({ error: "Failed to extract HTML content" });
  }
});

app.get("/text", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    const text = await performPageOperation(url, async (page) => {
      return await page.evaluate(() => {
        // Remove script and style elements
        const scripts = document.querySelectorAll("script, style, noscript");
        scripts.forEach((el) => el.remove());

        return document.body.innerText || "";
      });
    });

    res.type("text/plain").send(text);
  } catch (error) {
    console.error("Text extraction error:", error.message);
    res.status(500).json({ error: "Failed to extract text content" });
  }
});

app.get("/clean-text", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  try {
    const cleanText = await extractMainContent(url);
    res.type("text/plain").send(cleanText);
  } catch (error) {
    console.error("Clean text extraction error:", error.message);
    res.status(500).json({ error: "Failed to extract clean content" });
  }
});

async function extractMainContent(url) {
  return await performPageOperation(url, async (page) => {
    const html = await page.content();

    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article) {
        throw new Error("Could not parse article content");
      }

      return article.textContent.trim().replace(/\s+/g, " ");
    } catch (readabilityError) {
      console.warn(
        "Readability parsing failed, falling back to basic text extraction"
      );
      // Fallback to basic text extraction
      return await page.evaluate(() => {
        const scripts = document.querySelectorAll(
          "script, style, noscript, nav, header, footer, aside"
        );
        scripts.forEach((el) => el.remove());
        return document.body.innerText || "";
      });
    }
  });
}

// Enhanced healthcheck with system info
app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "Puppeteer + Readability API",
    endpoints: [
      "GET /html?url=<url> - Extract raw HTML",
      "GET /text?url=<url> - Extract plain text",
      "GET /clean-text?url=<url> - Extract main content using Readability",
    ],
    timestamp: new Date().toISOString(),
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Puppeteer + Readability API listening on port ${PORT}`);
});
