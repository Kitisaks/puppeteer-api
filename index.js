const express = require("express");
const puppeteer = require("puppeteer");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const puppeteerConfigs = {
  headless: true, // Use stable headless mode instead of "new"
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    // Essential Docker flags
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",

    // Memory and performance optimization
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI",
    "--disable-extensions",
    "--disable-plugins",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-background-mode",

    // Memory limits
    "--memory-pressure-off",
    "--max_old_space_size=256",

    // Process management - removed problematic flags
    "--no-first-run",
    "--disable-default-apps",
    "--disable-component-update",

    // Network optimization
    "--aggressive-cache-discard",
    "--disable-background-networking",

    // Security (keeping minimal)
    "--disable-web-security",
    "--ignore-certificate-errors",
    "--ignore-ssl-errors",
    "--ignore-certificate-errors-spki-list",
  ],
  ignoreHTTPSErrors: true,
  timeout: 30000,
  defaultViewport: { width: 800, height: 600 },
  devtools: false,
  // Add pipe mode for better stability in containers
  pipe: true,
};

const pageBrowserConfigs = {
  waitUntil: "domcontentloaded", // Changed from networkidle0 to be faster
  timeout: 20000, // Reduced timeout
};

const app = express();
app.use(express.json());

// Browser pool with health checking and resource management
let browserInstance = null;
let browserLaunchPromise = null;
let activePages = 0;
const MAX_CONCURRENT_PAGES = 2; // Limit concurrent pages

async function getBrowser() {
  // If there's already a launch in progress, wait for it
  if (browserLaunchPromise) {
    return await browserLaunchPromise;
  }

  // Check if current browser is healthy
  if (browserInstance) {
    try {
      // Simple health check without version call which can be problematic
      const pages = await Promise.race([
        browserInstance.pages(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), 3000)
        ),
      ]);

      // Check if we have too many pages
      if (pages.length > 5) {
        // Reduced threshold
        console.log("Too many pages open, restarting browser");
        await closeBrowser();
      } else {
        return browserInstance;
      }
    } catch (error) {
      console.log(
        "Browser instance unhealthy, creating new one:",
        error.message
      );
      await closeBrowser();
    }
  }

  // Add delay before launching new browser to prevent rapid restarts
  if (browserInstance === null) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Launch new browser instance with better error handling
  browserLaunchPromise = (async () => {
    try {
      console.log("Launching new browser instance...");
      const browser = await puppeteer.launch(puppeteerConfigs);

      // Test browser immediately after launch
      const pages = await browser.pages();
      console.log(
        `Browser launched successfully with ${pages.length} initial pages`
      );

      return browser;
    } catch (launchError) {
      console.error("Browser launch failed:", launchError.message);

      // Try with even more conservative settings
      console.log("Retrying with conservative settings...");
      const conservativeConfig = {
        ...puppeteerConfigs,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--no-first-run",
          "--disable-default-apps",
        ],
        pipe: false, // Disable pipe mode for fallback
      };

      return await puppeteer.launch(conservativeConfig);
    }
  })();

  try {
    browserInstance = await browserLaunchPromise;
    console.log("Browser instance ready");

    // Handle browser disconnect
    browserInstance.on("disconnected", () => {
      console.log(
        "Browser disconnected, will create new instance on next request"
      );
      browserInstance = null;
      browserLaunchPromise = null;
      activePages = 0;
    });

    // Monitor browser process
    const process = browserInstance.process();
    if (process) {
      process.on("close", (code) => {
        console.log(`Browser process closed with code ${code}`);
        browserInstance = null;
        browserLaunchPromise = null;
        activePages = 0;
      });
    }

    return browserInstance;
  } catch (error) {
    console.error("Failed to launch browser:", error);
    browserInstance = null;
    browserLaunchPromise = null;
    throw new Error(`Browser launch failed: ${error.message}`);
  } finally {
    browserLaunchPromise = null;
  }
}

// Graceful shutdown with timeout
async function closeBrowser() {
  if (browserInstance) {
    try {
      // Close all pages first
      const pages = await browserInstance.pages();
      await Promise.all(
        pages.map((page) =>
          page
            .close()
            .catch((e) => console.log("Error closing page:", e.message))
        )
      );

      // Close browser with timeout
      await Promise.race([
        browserInstance.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Browser close timeout")), 10000)
        ),
      ]);
    } catch (error) {
      console.error("Error closing browser:", error.message);
      // Force kill the process if graceful close fails
      if (browserInstance.process()) {
        browserInstance.process().kill("SIGKILL");
      }
    }
    browserInstance = null;
    browserLaunchPromise = null;
    activePages = 0;
  }
}

// Periodic cleanup
setInterval(async () => {
  if (browserInstance && activePages === 0) {
    try {
      const pages = await browserInstance.pages();
      // If we have more than default about:blank page and no active operations
      if (pages.length > 1) {
        console.log("Cleaning up idle pages");
        for (let i = 1; i < pages.length; i++) {
          await pages[i]
            .close()
            .catch((e) => console.log("Cleanup error:", e.message));
        }
      }
    } catch (error) {
      console.log("Cleanup error:", error.message);
    }
  }
}, 60000); // Clean up every minute

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

// Handle uncaught exceptions
process.on("uncaughtException", async (error) => {
  console.error("Uncaught Exception:", error);
  await closeBrowser();
  process.exit(1);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  await closeBrowser();
  process.exit(1);
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

// Rate limiting check
function checkConcurrency() {
  if (activePages >= MAX_CONCURRENT_PAGES) {
    throw new Error("Too many concurrent requests. Please try again later.");
  }
}

// Utility function for page operations with retry logic and resource management
async function performPageOperation(url, operation, retries = 1) {
  if (!isValidUrl(url)) {
    throw new Error("Invalid URL format");
  }

  checkConcurrency();

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let browser = null;
    let page = null;

    try {
      activePages++;
      browser = await getBrowser();
      page = await browser.newPage();

      // Set memory limits for the page
      await page.setCacheEnabled(false);

      // Set user agent and smaller viewport for memory efficiency
      await page.setUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );
      await page.setViewport({ width: 800, height: 600 });

      // Enhanced request interception for memory optimization
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const resourceType = req.resourceType();
        const url = req.url();

        // Block more resource types and tracking
        if (
          [
            "image",
            "stylesheet",
            "font",
            "media",
            "websocket",
            "other",
            "texttrack",
            "eventsource",
            "manifest",
          ].includes(resourceType)
        ) {
          req.abort();
        } else if (
          url.includes("google-analytics") ||
          url.includes("googletagmanager") ||
          url.includes("facebook.com") ||
          url.includes("doubleclick") ||
          url.includes("googlesyndication")
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Set a timeout for the entire operation
      const result = await Promise.race([
        (async () => {
          await page.goto(url, pageBrowserConfigs);
          return await operation(page);
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Operation timeout")), 25000)
        ),
      ]);

      return result;
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed for ${url}:`, error.message);
      lastError = error;

      // Force browser recreation on various errors
      if (
        error.message.includes("Protocol error") ||
        error.message.includes("Target closed") ||
        error.message.includes("Session closed") ||
        error.message.includes("Connection closed") ||
        error.message.includes("timeout")
      ) {
        console.log("Forcing browser restart due to error type");
        await closeBrowser();
      }

      if (attempt === retries) {
        throw lastError;
      }

      // Wait before retry with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    } finally {
      activePages--;
      if (page) {
        try {
          await Promise.race([
            page.close(),
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]);
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
    if (error.message.includes("concurrent")) {
      res.status(429).json({ error: error.message });
    } else {
      res.status(500).json({ error: "Failed to extract HTML content" });
    }
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
    if (error.message.includes("concurrent")) {
      res.status(429).json({ error: error.message });
    } else {
      res.status(500).json({ error: "Failed to extract text content" });
    }
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
    if (error.message.includes("concurrent")) {
      res.status(429).json({ error: error.message });
    } else {
      res.status(500).json({ error: "Failed to extract clean content" });
    }
  }
});

async function extractMainContent(url) {
  return await performPageOperation(url, async (page) => {
    try {
      // Get HTML with timeout
      const html = await Promise.race([
        page.content(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Content timeout")), 10000)
        ),
      ]);

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
    stats: {
      activePages,
      browserActive: !!browserInstance,
    },
    timestamp: new Date().toISOString(),
  });
});

// Memory usage endpoint for monitoring
app.get("/stats", (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
    },
    activePages,
    browserActive: !!browserInstance,
    uptime: `${Math.round(process.uptime())}s`,
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
  console.log(`Memory limit: ${process.env.NODE_OPTIONS || "default"}`);
});
