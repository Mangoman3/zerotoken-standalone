export type ModelCostConfig = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ModelDefinitionConfig = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCostConfig;
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
};

export type ZeroTokenModelProviderConfig = {
  api: string;
  baseUrl?: string;
  apiKey?: string;
  auth?: string;
  models?: ModelDefinitionConfig[];
  headers?: Record<string, string>;
  [key: string]: unknown;
};

export type SsrFPolicy = {
  allowPrivateNetwork?: boolean;
  dangerouslyAllowPrivateNetwork?: boolean;
  allowedHostnames?: string[];
  hostnameAllowlist?: string[];
};

export type BrowserProfileConfig = {
  cdpPort?: number;
  cdpUrl?: string;
  color?: string;
  driver?: "openclaw" | "extension";
  attachOnly?: boolean;
};

export type BrowserConfig = {
  enabled?: boolean;
  evaluateEnabled?: boolean;
  cdpUrl?: string;
  cdpPortRangeStart?: number;
  color?: string;
  remoteCdpTimeoutMs?: number;
  remoteCdpHandshakeTimeoutMs?: number;
  headless?: boolean;
  noSandbox?: boolean;
  attachOnly?: boolean;
  executablePath?: string;
  defaultProfile?: string;
  profiles?: Record<string, BrowserProfileConfig>;
  ssrfPolicy?: SsrFPolicy;
  extraArgs?: string[];
  relayBindHost?: string;
};

export type OpenClawConfigLike = {
  gateway?: {
    port?: number;
  };
  browser?: BrowserConfig;
  models?: {
    providers?: Record<string, ZeroTokenModelProviderConfig>;
  };
};

export type OpenClawConfig = OpenClawConfigLike;
