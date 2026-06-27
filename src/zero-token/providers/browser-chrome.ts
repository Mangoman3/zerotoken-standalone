import { type ChildProcessWithoutNullStreams, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { resolveStateDir } from "./config-paths.js";

/**
 * Stealth script to hide automation markers from websites.
 * Inject via context.addInitScript() or page.addInitScript() after connecting via CDP.
 * Prevents Google/OpenAI from detecting automated browser and forcing re-login.
 */
export const BROWSER_STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = { connect: function(){}, sendMessage: function(){} };
  }
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ],
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en'],
  });
`;
import { appendCdpPath, getHeadersWithAuth, normalizeCdpWsUrl } from "./browser-cdp.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./browser-config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./browser-constants.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

async function ensurePortAvailable(port: number, host = "127.0.0.1"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(port, host, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

function resolveBrowserExecutable(resolved: ResolvedBrowserConfig): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(resolved, process.platform);
}

export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams;
};

export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(resolveStateDir(), "browser", profileName, "user-data");
}

/**
 * Detect the user's real browser user-data directory based on the executable path.
 * Returns null if the browser type can't be determined.
 */
function detectUserBrowserDataDir(exePath: string): string | null {
  if (process.platform !== "win32") return null;

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const exeLower = exePath.toLowerCase();
  if (exeLower.includes("msedge")) {
    return path.join(localAppData, "Microsoft", "Edge", "User Data");
  }
  if (exeLower.includes("chrome")) {
    return path.join(localAppData, "Google", "Chrome", "User Data");
  }
  if (exeLower.includes("brave")) {
    return path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data");
  }
  return null;
}

/**
 * Copy the user's entire browser Default profile to the auth browser profile.
 * This gives the auth browser access to:
 *   - Google account login state (Cookies + Preferences)
 *   - Saved passwords (Login Data)
 *   - Autofill data (Web Data)
 *   - All site sessions
 *
 * Large directories (Cache, Code Cache, etc.) are excluded.
 * The Local State file's os_crypt key is force-synced so encrypted data
 * can be decrypted by the auth browser.
 */
function copyUserBrowserProfile(exePath: string, targetUserDataDir: string): void {
  try {
    const sourceDir = detectUserBrowserDataDir(exePath);
    if (!sourceDir || !exists(sourceDir)) return;

    const sourceDefault = path.join(sourceDir, "Default");
    if (!exists(sourceDefault)) return;

    const targetDefault = path.join(targetUserDataDir, "Default");
    fs.mkdirSync(targetDefault, { recursive: true });

    // Skip these large/unnecessary directories
    const skipDirs = new Set([
      "cache", "code cache", "service worker", "gpucache", "dawncache",
      "shader cache", "file system", "blob_storage", "session storage",
      "local storage", "indexeddb", "databases", "platform_notifications",
      "storage", "webrtc internals", "video decoding stats", "jumplists",
      "optimization guide", "segmentation platform", "browsing topics",
      "commerce_hint_data", "commerce", "autofill_ai", "crowd deny",
      "download service", "shared proto db", "site characteristics database",
      "smartscreen", "trust tokens", "visited links",
    ]);

    // Marker file to avoid re-copying on every launch
    const markerFile = path.join(targetDefault, ".zero-token-profile-copied");
    if (exists(markerFile)) {
      // Profile already copied — only sync cookies (they change often)
      const cookieSrc = path.join(sourceDefault, "Cookies");
      const cookieDst = path.join(targetDefault, "Cookies");
      if (exists(cookieSrc)) {
        try {
          const data = fs.readFileSync(cookieSrc);
          fs.writeFileSync(cookieDst, data);
        } catch { /* non-fatal */ }
      }
      // Also sync Local State encryption key
      syncOsCryptKey(sourceDir, targetUserDataDir);
      return;
    }

    // First-time copy: recursively copy all profile files (excluding caches)
    console.log("[zero-token] First-time profile sync from user browser...");
    let copied = 0;

    const copyDir = (srcDir: string, dstDir: string, depth: number) => {
      if (depth > 3) return; // Don't go too deep
      try {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(srcDir, entry.name);
          const dstPath = path.join(dstDir, entry.name);

          if (entry.isDirectory()) {
            if (skipDirs.has(entry.name.toLowerCase())) continue;
            fs.mkdirSync(dstPath, { recursive: true });
            copyDir(srcPath, dstPath, depth + 1);
          } else if (entry.isFile()) {
            // Skip very large files (>50MB)
            try {
              const stat = fs.statSync(srcPath);
              if (stat.size > 50 * 1024 * 1024) continue;
            } catch { continue; }

            try {
              const data = fs.readFileSync(srcPath);
              fs.writeFileSync(dstPath, data);
              copied++;
            } catch {
              // File locked or inaccessible — skip
            }
          }
        }
      } catch {
        // Directory access error — skip
      }
    };

    copyDir(sourceDefault, targetDefault, 0);
    console.log(`[zero-token] Copied ${copied} profile files from user browser`);

    // Sync the encryption key
    syncOsCryptKey(sourceDir, targetUserDataDir);

    // Write marker so we don't re-copy everything next time
    try {
      fs.writeFileSync(markerFile, new Date().toISOString());
    } catch { /* non-fatal */ }
  } catch (err) {
    console.warn(`[zero-token] Profile sync error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Force-sync the os_crypt encryption key from the user's browser to auth browser.
 * Without this, encrypted cookies/passwords can't be decrypted.
 */
function syncOsCryptKey(sourceDir: string, targetUserDataDir: string): void {
  const sourceLocalState = path.join(sourceDir, "Local State");
  const targetLocalState = path.join(targetUserDataDir, "Local State");
  if (!exists(sourceLocalState)) return;

  try {
    const sourceState = JSON.parse(fs.readFileSync(sourceLocalState, "utf-8"));
    if (!sourceState.os_crypt) return;

    let targetState: Record<string, unknown> = {};
    if (exists(targetLocalState)) {
      try {
        targetState = JSON.parse(fs.readFileSync(targetLocalState, "utf-8"));
      } catch { /* corrupt, overwrite */ }
    }

    targetState.os_crypt = sourceState.os_crypt;
    fs.writeFileSync(targetLocalState, JSON.stringify(targetState, null, 2));
  } catch {
    // non-fatal
  }
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

type ChromeVersion = {
  webSocketDebuggerUrl?: string;
};

async function fetchChromeVersion(cdpUrl: string, timeoutMs = 500): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const response = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: getHeadersWithAuth(versionUrl),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as ChromeVersion;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function isChromeReachable(cdpUrl: string, timeoutMs = 500): Promise<boolean> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = 500,
): Promise<string | null> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) {
    return null;
  }
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

async function canOpenWebSocket(wsUrl: string, timeoutMs = 800): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const headers = getHeadersWithAuth(wsUrl);
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: timeoutMs,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve(false);
    }, Math.max(50, timeoutMs + 25));

    ws.once("open", () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
  );

  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
    ];

    if (resolved.headless) {
      args.push("--headless=new", "--disable-gpu");
    }
    if (resolved.noSandbox) {
      args.push("--no-sandbox", "--disable-setuid-sandbox");
    }
    if (process.platform === "linux") {
      args.push("--disable-dev-shm-usage");
    }
    args.push("--disable-features=AutomationControlled");
    args.push("--disable-blink-features=AutomationControlled");
    if (resolved.extraArgs.length > 0) {
      args.push(...resolved.extraArgs);
    }
    args.push("about:blank");

    return spawn(exe.path, args, {
      stdio: "pipe",
      env: {
        ...process.env,
        HOME: os.homedir(),
      },
    });
  };

  const startedAt = Date.now();
  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + 5_000;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
      });
    } catch (error) {
      console.warn(`openclaw browser profile decoration failed: ${String(error)}`);
    }
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (error) {
    console.warn(`openclaw browser clean-exit prefs failed: ${String(error)}`);
  }

  // Copy user's browser profile AFTER bootstrap (so Chrome's generated Local State
  // doesn't overwrite our encryption key). Force-overwrite the os_crypt key.
  copyUserBrowserProfile(exe.path, userDataDir);

  const proc = spawnOnce();
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl, 500)) {
      const wsUrl = await getChromeWebSocketUrl(profile.cdpUrl, 500);
      if (!wsUrl || (await canOpenWebSocket(wsUrl, 800))) {
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (!(await isChromeReachable(profile.cdpUrl, 500))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".`,
    );
  }

  return {
    pid: proc.pid ?? -1,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
  };
}

export async function stopOpenClawChrome(running: RunningChrome, timeoutMs = 2500) {
  const proc = running.proc;
  if (proc.killed) {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc.exitCode && proc.killed) {
      break;
    }
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), 200))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}

export async function killExistingChromeOnPort(
  cdpPort: number,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  if (process.platform === "win32") {
    return false;
  }
  const cdpUrl = cdpUrlForPort(cdpPort);
  if (!(await isChromeReachable(cdpUrl, 300))) {
    return false;
  }
  const progress = onProgress ?? (() => {});
  progress("Detected existing browser, closing it first...");
  try {
    execSync(`pkill -f "remote-debugging-port=${cdpPort}" 2>/dev/null || true`, {
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    execSync(`pkill -9 -f "remote-debugging-port=${cdpPort}" 2>/dev/null || true`, {
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return !(await isChromeReachable(cdpUrl, 300));
  } catch {
    return false;
  }
}
