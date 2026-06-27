import { loadZeroTokenBrowserRootConfig } from "../zero-token/providers/browser-runtime.js";
import type { OpenClawConfig } from "../zero-token/types.js";

export function loadConfig(): OpenClawConfig {
  return loadZeroTokenBrowserRootConfig() as OpenClawConfig;
}
