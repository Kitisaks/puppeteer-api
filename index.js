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
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--memory-pressure-off",
    "--max_old_space_size=4096",
  ],
  ignoreHTTPSErrors: true,
  timeout: 30000,
};

const pageBrowserConfigs = {
  waitUntil: "networkidle0",
  timeout: 30000,
};

const app = express();
app.use(express.json());

// Browser pool with health checking
let browserInstance = null;
let browserLaunchPromise = null;

async function getBrowser() {
  // If there's already a launch in progress, wait for it
  if (browserLaunchPromise) {
    return await browserLaunchPromise;
  }

  // Check if current browser is healthy
  if (browserInstance) {
    try {
      // Test if browser is still connected
      await browserInstance.version();
      return browserInstance;
    } catch (error) {
      console.log("Browser instance unhealthy, creating new one");
      browserInstance = null;
    }
  }

  // Launch new browser instance
  browserLaunchPromise = puppeteer.launch(puppeteerConfigs);

  try {
    browserInstance = await browserLaunchPromise;
    console.log("New browser instance created");

    // Handle browser disconnect
    browserInstance.on("disconnected", () => {
      console.log(
        "Browser disconnected, will create new instance on next request"
      );
      browserInstance = null;
      browserLaunchPromise = null;
    });

    return browserInstance;
  } catch (error) {
    console.error("Failed to launch browser:", error);
    throw error;
  } finally {
    browserLaunchPromise = null;
  }
}

// Graceful shutdown
async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (error) {
      console.error("Error closing browser:", error);
    }
    browserInstance = null;
    browserLaunchPromise = null;
  }
}

process.on("SIGINT", async () => {
  console.log("Received SIGINT, shutting down gracefully");
  await closeBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Received SIGTERM, shutting down gracefully");
  await closeBrowser();
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

// Utility function for page operations with retry logic
async function performPageOperation(url, operation, retries = 2) {
  if (!isValidUrl(url)) {
    throw new Error("Invalid URL format");
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let browser = null;
    let page = null;

    try {
      browser = await getBrowser();
      page = await browser.newPage();

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
      const result = await operation(page);

      return result;
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed:`, error.message);
      lastError = error;

      // Force browser recreation on protocol errors
      if (
        error.message.includes("Protocol error") ||
        error.message.includes("Target closed")
      ) {
        await closeBrowser();
      }

      if (attempt === retries) {
        throw lastError;
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    } finally {
      if (page) {
        try {
          await page.close();
        } catch (error) {
          console.error("Error closing page:", error.message);
        }
      }
    }
  }

  throw lastError;
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
        // Remove script, style, and other non-content elements
        const elementsToRemove = document.querySelectorAll(
          "script, style, noscript, nav, header, footer, aside, .advertisement, .ads"
        );
        elementsToRemove.forEach((el) => el.remove());

        // Get text content and normalize whitespace
        const text = document.body.innerText || document.body.textContent || "";
        return text.trim().replace(/\s+/g, " ");
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
    try {
      // Try Readability with completely disabled CSS
      const html = await page.content();

      // Aggressively clean HTML - remove ALL CSS-related content
      const cleanedHtml = html
        .replace(/<!--[\s\S]*?-->/g, "") // HTML comments
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // Style blocks
        .replace(
          /<link[^>]*(?:rel=["']?stylesheet["']?|type=["']?text\/css["']?)[^>]*>/gi,
          ""
        ) // CSS links
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") // Scripts
        .replace(/\sstyle=["'][^"']*["']/gi, "") // Inline styles
        .replace(/\/\*[\s\S]*?\*\//g, "") // CSS comments
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ""); // Noscript

      // Create JSDOM with minimal configuration
      const dom = new JSDOM(cleanedHtml, {
        url,
        pretendToBeVisual: false,
        resources: "usable",
        runScripts: "outside-only",
      });

      // Disable all stylesheets in the document
      const styleSheets = dom.window.document.styleSheets;
      for (let i = 0; i < styleSheets.length; i++) {
        if (styleSheets[i]) {
          styleSheets[i].disabled = true;
        }
      }

      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article && article.textContent) {
        return article.textContent.trim().replace(/\s+/g, " ");
      }

      throw new Error("Readability could not extract content");
    } catch (readabilityError) {
      console.warn(
        "Readability extraction failed, using Puppeteer fallback:",
        readabilityError.message
      );

      // Fallback: Use Puppeteer's evaluation for text extraction
      return await page.evaluate(() => {
        // Remove all non-content elements
        const elementsToRemove = document.querySelectorAll(
          [
            "script",
            "style",
            "noscript",
            "iframe",
            "object",
            "embed",
            "nav",
            "header",
            "footer",
            "aside",
            "menu",
            ".advertisement",
            ".ads",
            ".social-share",
            ".comments",
            ".sidebar",
            ".widget",
            ".popup",
            ".modal",
            '[class*="ad-"]',
            '[class*="ads-"]',
            '[id*="ad-"]',
            '[id*="ads-"]',
          ].join(", ")
        );

        elementsToRemove.forEach((el) => {
          try {
            el.remove();
          } catch (e) {
            // Ignore errors when removing elements
          }
        });

        // Try to find main content area
        const contentSelectors = [
          "main",
          "article",
          '[role="main"]',
          ".content",
          ".post-content",
          ".entry-content",
          ".article-content",
          ".main-content",
          ".page-content",
          ".text-content",
          "#content",
          "#main",
          "#article",
          "#post",
        ];

        let mainContent = null;
        for (const selector of contentSelectors) {
          mainContent = document.querySelector(selector);
          if (
            mainContent &&
            mainContent.innerText &&
            mainContent.innerText.trim().length > 100
          ) {
            break;
          }
        }

        // Fallback to body if no main content found
        const textSource = mainContent || document.body;
        const text = textSource.innerText || textSource.textContent || "";

        return text.trim().replace(/\s+/g, " ");
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
