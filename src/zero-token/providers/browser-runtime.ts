import fs from "node:fs";
import JSON5 from "json5";
import { resolveConfigPathCandidate } from "./config-paths.js";
import type { OpenClawConfig } from "../types.js";
import {
  resolveBrowserConfig,
  resolveProfile,
  type ResolvedBrowserConfig,
  type ResolvedBrowserProfile,
} from "./browser-config.js";

type BrowserRuntimeRootConfig = Pick<OpenClawConfig, "browser" | "gateway">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRuntimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadZeroTokenBrowserRootConfig(): BrowserRuntimeRootConfig {
  const configPath = resolveConfigPathCandidate();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("Config file must contain an object.");
    }
    return parsed as BrowserRuntimeRootConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {};
    }
    throw new Error(
      `Failed to read OpenClaw browser config from ${configPath}: ${formatRuntimeError(error)}`,
    );
  }
}

export function resolveZeroTokenBrowserRuntime(): {
  rootConfig: BrowserRuntimeRootConfig;
  browserConfig: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
} {
  const rootConfig = loadZeroTokenBrowserRootConfig();
  const browserConfig = resolveBrowserConfig(
    rootConfig.browser,
    rootConfig as OpenClawConfig,
  );

  // Apply environment variable overrides for standalone proxy server / CLI
  if (process.env.ZEROTOKEN_ATTACH === "true") {
    browserConfig.attachOnly = true;
  } else if (process.env.ZEROTOKEN_ATTACH === "false") {
    browserConfig.attachOnly = false;
  }
  if (process.env.ZEROTOKEN_HEADLESS === "true") {
    browserConfig.headless = true;
  } else if (process.env.ZEROTOKEN_HEADLESS === "false") {
    browserConfig.headless = false;
  }

  const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
  if (!profile) {
    throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
  }

  // Sync profile attachOnly flag with browserConfig
  profile.attachOnly = browserConfig.attachOnly;

  return { rootConfig, browserConfig, profile };
}
