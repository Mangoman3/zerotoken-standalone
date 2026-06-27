/**
 * Shared browser instance manager for API calls.
 *
 * Three key techniques for persistent login:
 *
 * 1. Persistent User Data Directory (UDD)
 *    - Fixed path at ~/.openclaw/browser/api-chrome/
 *    - Cookies, LocalStorage, IndexedDB survive across restarts
 *    - Google account sessions persist automatically
 *
 * 2. Persistent Context (launchPersistentContext)
 *    - User data bound at launch time, not after
 *    - OAuth popup windows share parent's storage in real-time
 *    - Credentials written to disk immediately, not just in-memory
 *
 * 3. Stealth / Anti-Fingerprinting
 *    - navigator.webdriver = false
 *    - AutomationControlled feature disabled
 *    - Chrome.runtime spoofed to avoid detection
 *    - Google/OpenAI won't force re-login due to "unsafe environment"
 */
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import * as path from "node:path";
import * as fs from "node:fs";
import { resolveZeroTokenBrowserRuntime } from "./browser-runtime.js";
import { resolveStateDir } from "./config-paths.js";

let sharedContext: BrowserContext | null = null;
let sharedRefCount = 0;

/** Fixed persistent path for the API browser profile */
function resolveApiBrowserDataDir(): string {
  return path.join(resolveStateDir(), "browser", "api-chrome");
}

/** Stealth script injected into every page to hide automation markers */
const STEALTH_SCRIPT = `
  // 1. Hide navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. Spoof chrome.runtime to look like a real browser
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() {},
      sendMessage: function() {},
    };
  }

  // 3. Hide Playwright/Puppeteer stack traces from Error objects
  const originalError = Error;
  function PatchedError(...args) {
    const err = new originalError(...args);
    const stack = err.stack || '';
    err.stack = stack.replace(/playwright|puppeteer|automation/gi, 'browser');
    return err;
  }
  PatchedError.prototype = originalError.prototype;

  // 4. Realistic plugins array (empty = bot fingerprint)
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ],
  });

  // 5. Realistic languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en'],
  });
`;

/**
 * Get or launch a shared hidden Chrome with persistent context for API calls.
 * This browser is completely separate from OpenClaw's browser tool.
 */
export async function getSharedBrowser(providerLabel: string, targetUrl: string): Promise<{
  context: BrowserContext;
  page: Page;
  isNew: boolean;
}> {
  // Check if context is still alive
  if (sharedContext) {
    try {
      // Quick liveness check
      sharedContext.pages();
    } catch {
      console.log(`[${providerLabel}] API Chrome context dead, resetting...`);
      sharedContext = null;
      sharedRefCount = 0;
    }
  }

  // Launch persistent context if not running
  if (!sharedContext) {
    const { browserConfig } = resolveZeroTokenBrowserRuntime();
    const executablePath = browserConfig.executablePath;
    const userDataDir = resolveApiBrowserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });

    console.log(`[${providerLabel}] Launching hidden API Chrome (persistent context)...`);
    console.log(`[${providerLabel}] User data dir: ${userDataDir}`);

    sharedContext = await chromium.launchPersistentContext(userDataDir, {
      executablePath: executablePath || undefined,
      headless: browserConfig.headless,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-translate",
        "--hide-scrollbars",
        "--mute-audio",
        // ── Stealth: hide automation markers ──
        "--disable-blink-features=AutomationControlled",
        "--disable-features=AutomationControlled",
        // ── Hidden window ──
        "--window-position=-32000,-32000",
        "--window-size=1,1",
      ],
      // Don't add Playwright's default "Headless" user-agent suffix
      ignoreDefaultArgs: ["--enable-automation"],
      bypassCSP: true,
    });

    // Inject stealth script into all pages (current and future)
    await sharedContext.addInitScript(STEALTH_SCRIPT);

    // Handle context close
    sharedContext.on("close", () => {
      console.log(`[SharedBrowser] API Chrome context closed`);
      sharedContext = null;
      sharedRefCount = 0;
    });

    console.log(`[${providerLabel}] Hidden API Chrome launched (persistent)`);
  } else {
    console.log(`[${providerLabel}] Reusing hidden API Chrome`);
  }

  sharedRefCount++;

  // Reuse existing page by domain, or find about:blank, or create new
  const targetDomain = new URL(targetUrl).hostname;
  const existingPage = sharedContext.pages().find((p) => {
    try { return new URL(p.url()).hostname.includes(targetDomain); } catch { return false; }
  });

  if (existingPage) {
    console.log(`[${providerLabel}] Reusing existing page for ${targetDomain}`);
    return { context: sharedContext, page: existingPage, isNew: false };
  }

  const page = sharedContext.pages().find((p) => p.url() === "about:blank") || await sharedContext.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  } catch (error: any) {
    if (error && error.message && error.message.includes("net::ERR_ABORTED")) {
      console.log(`[SharedBrowser] Navigation to ${targetUrl} was aborted (ERR_ABORTED), likely by Cloudflare/redirects. Continuing...`);
    } else {
      throw error;
    }
  }

  return { context: sharedContext, page, isNew: true };
}

/**
 * Release a reference to the shared browser.
 * Chrome is only stopped when all providers have released.
 */
export async function releaseSharedBrowser() {
  sharedRefCount = Math.max(0, sharedRefCount - 1);
  if (sharedRefCount === 0 && sharedContext) {
    console.log(`[SharedBrowser] All providers released, closing API Chrome`);
    try {
      await sharedContext.close();
    } catch {
      // already closed
    }
    sharedContext = null;
  }
}
