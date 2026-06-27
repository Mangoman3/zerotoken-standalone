import type { OpenClawConfig, BrowserConfig, BrowserProfileConfig } from "../types.js";
import {
  deriveDefaultBrowserCdpPortRange,
  deriveDefaultBrowserControlPort,
  DEFAULT_BROWSER_CONTROL_PORT,
} from "./port-defaults.js";
import type { SsrFPolicy } from "../types.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./browser-constants.js";
import { CDP_PORT_RANGE_START, getUsedPorts } from "./browser-profiles.js";
import { isLoopbackHost } from "./browser-cdp.js";

export type ResolvedBrowserConfig = {
  enabled: boolean;
  evaluateEnabled: boolean;
  controlPort: number;
  cdpPortRangeStart: number;
  cdpPortRangeEnd: number;
  cdpProtocol: "http" | "https";
  cdpHost: string;
  cdpIsLoopback: boolean;
  remoteCdpTimeoutMs: number;
  remoteCdpHandshakeTimeoutMs: number;
  color: string;
  executablePath?: string;
  headless: boolean;
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<string, BrowserProfileConfig>;
  ssrfPolicy?: SsrFPolicy;
  extraArgs: string[];
  relayBindHost?: string;
};

export type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  color: string;
  driver: "openclaw" | "extension";
  attachOnly: boolean;
};

const DEFAULT_GATEWAY_PORT = 18789;

function resolveGatewayPort(cfg?: Pick<OpenClawConfig, "gateway">, env: NodeJS.ProcessEnv = process.env): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }
  return DEFAULT_GATEWAY_PORT;
}

function normalizeHexColor(raw: string | undefined) {
  const value = (raw ?? "").trim();
  if (!value) {
    return DEFAULT_OPENCLAW_BROWSER_COLOR;
  }
  const normalized = value.startsWith("#") ? value : `#${value}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return DEFAULT_OPENCLAW_BROWSER_COLOR;
  }
  return normalized.toUpperCase();
}

function normalizeTimeoutMs(raw: number | undefined, fallback: number) {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return value < 0 ? fallback : value;
}

function resolveCdpPortRangeStart(rawStart: number | undefined, fallbackStart: number, rangeSpan: number) {
  const start =
    typeof rawStart === "number" && Number.isFinite(rawStart)
      ? Math.floor(rawStart)
      : fallbackStart;
  if (start < 1 || start > 65535) {
    throw new Error(`browser.cdpPortRangeStart must be between 1 and 65535, got: ${start}`);
  }
  const maxStart = 65535 - rangeSpan;
  if (start > maxStart) {
    throw new Error(
      `browser.cdpPortRangeStart (${start}) is too high for a ${rangeSpan + 1}-port range; max is ${maxStart}.`,
    );
  }
  return start;
}

function normalizeStringList(raw: string[] | undefined): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const values = raw
    .map((value) => value.trim())
    .filter((value): value is string => value.length > 0);
  return values.length > 0 ? values : undefined;
}

function resolveBrowserSsrFPolicy(cfg: BrowserConfig | undefined): SsrFPolicy | undefined {
  const allowPrivateNetwork = cfg?.ssrfPolicy?.allowPrivateNetwork;
  const dangerouslyAllowPrivateNetwork = cfg?.ssrfPolicy?.dangerouslyAllowPrivateNetwork;
  const allowedHostnames = normalizeStringList(cfg?.ssrfPolicy?.allowedHostnames);
  const hostnameAllowlist = normalizeStringList(cfg?.ssrfPolicy?.hostnameAllowlist);
  const hasExplicitPrivateSetting =
    allowPrivateNetwork !== undefined || dangerouslyAllowPrivateNetwork !== undefined;
  const resolvedAllowPrivateNetwork =
    dangerouslyAllowPrivateNetwork === true ||
    allowPrivateNetwork === true ||
    !hasExplicitPrivateSetting;

  if (
    !resolvedAllowPrivateNetwork &&
    !hasExplicitPrivateSetting &&
    !allowedHostnames &&
    !hostnameAllowlist
  ) {
    return undefined;
  }

  return {
    ...(resolvedAllowPrivateNetwork ? { dangerouslyAllowPrivateNetwork: true } : {}),
    ...(allowedHostnames ? { allowedHostnames } : {}),
    ...(hostnameAllowlist ? { hostnameAllowlist } : {}),
  };
}

export function parseHttpUrl(raw: string, label: string) {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  const allowed = ["http:", "https:", "ws:", "wss:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`${label} must be http(s) or ws(s), got: ${parsed.protocol.replace(":", "")}`);
  }

  const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const port =
    parsed.port && Number.parseInt(parsed.port, 10) > 0
      ? Number.parseInt(parsed.port, 10)
      : isSecure
        ? 443
        : 80;

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} has invalid port: ${parsed.port}`);
  }

  return {
    parsed,
    port,
    normalized: parsed.toString().replace(/\/$/, ""),
  };
}

function ensureDefaultProfile(
  profiles: Record<string, BrowserProfileConfig> | undefined,
  defaultColor: string,
  legacyCdpPort?: number,
  derivedDefaultCdpPort?: number,
  legacyCdpUrl?: string,
): Record<string, BrowserProfileConfig> {
  const result = { ...profiles };
  if (!result[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]) {
    result[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME] = {
      cdpPort: legacyCdpPort ?? derivedDefaultCdpPort ?? CDP_PORT_RANGE_START,
      color: defaultColor,
      ...(legacyCdpUrl ? { cdpUrl: legacyCdpUrl } : {}),
    };
  }
  return result;
}

function ensureDefaultChromeExtensionProfile(
  profiles: Record<string, BrowserProfileConfig>,
  controlPort: number,
): Record<string, BrowserProfileConfig> {
  const result = { ...profiles };
  if (result.chrome) {
    return result;
  }
  const relayPort = controlPort + 1;
  if (!Number.isFinite(relayPort) || relayPort <= 0 || relayPort > 65535) {
    return result;
  }
  if (getUsedPorts(result).has(relayPort)) {
    return result;
  }
  result.chrome = {
    driver: "extension",
    cdpUrl: `http://127.0.0.1:${relayPort}`,
    color: "#00AA00",
  };
  return result;
}

export function resolveBrowserConfig(
  cfg: BrowserConfig | undefined,
  rootConfig?: Pick<OpenClawConfig, "gateway">,
): ResolvedBrowserConfig {
  const enabled = cfg?.enabled ?? DEFAULT_OPENCLAW_BROWSER_ENABLED;
  const evaluateEnabled = cfg?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;
  const gatewayPort = resolveGatewayPort(rootConfig);
  const controlPort = deriveDefaultBrowserControlPort(gatewayPort ?? DEFAULT_BROWSER_CONTROL_PORT);
  const defaultColor = normalizeHexColor(cfg?.color);
  const remoteCdpTimeoutMs = normalizeTimeoutMs(cfg?.remoteCdpTimeoutMs, 1500);
  const remoteCdpHandshakeTimeoutMs = normalizeTimeoutMs(
    cfg?.remoteCdpHandshakeTimeoutMs,
    Math.max(2000, remoteCdpTimeoutMs * 2),
  );

  const derivedCdpRange = deriveDefaultBrowserCdpPortRange(controlPort);
  const cdpRangeSpan = derivedCdpRange.end - derivedCdpRange.start;
  const cdpPortRangeStart = resolveCdpPortRangeStart(
    cfg?.cdpPortRangeStart,
    derivedCdpRange.start,
    cdpRangeSpan,
  );
  const cdpPortRangeEnd = cdpPortRangeStart + cdpRangeSpan;

  const rawCdpUrl = (cfg?.cdpUrl ?? "").trim();
  let cdpInfo:
    | {
        parsed: URL;
        port: number;
        normalized: string;
      }
    | undefined;
  if (rawCdpUrl) {
    cdpInfo = parseHttpUrl(rawCdpUrl, "browser.cdpUrl");
  } else {
    const derivedPort = controlPort + 1;
    if (derivedPort > 65535) {
      throw new Error(
        `Derived CDP port (${derivedPort}) is too high; check gateway port configuration.`,
      );
    }
    const derived = new URL(`http://127.0.0.1:${derivedPort}`);
    cdpInfo = {
      parsed: derived,
      port: derivedPort,
      normalized: derived.toString().replace(/\/$/, ""),
    };
  }

  const headless = cfg?.headless === true;
  const noSandbox = cfg?.noSandbox === true;
  const attachOnly = cfg?.attachOnly === true;
  const executablePath = cfg?.executablePath?.trim() || undefined;
  const defaultProfileFromConfig = cfg?.defaultProfile?.trim() || undefined;
  const legacyCdpPort = rawCdpUrl ? cdpInfo.port : undefined;
  const isWsUrl = cdpInfo.parsed.protocol === "ws:" || cdpInfo.parsed.protocol === "wss:";
  const legacyCdpUrl = rawCdpUrl && isWsUrl ? cdpInfo.normalized : undefined;
  const profiles = ensureDefaultChromeExtensionProfile(
    ensureDefaultProfile(
      cfg?.profiles,
      defaultColor,
      legacyCdpPort,
      cdpPortRangeStart,
      legacyCdpUrl,
    ),
    controlPort,
  );
  const cdpProtocol = cdpInfo.parsed.protocol === "https:" ? "https" : "http";
  const defaultProfile =
    defaultProfileFromConfig ??
    (profiles[DEFAULT_BROWSER_DEFAULT_PROFILE_NAME]
      ? DEFAULT_BROWSER_DEFAULT_PROFILE_NAME
      : profiles[DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]
        ? DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME
        : "chrome");
  const extraArgs = Array.isArray(cfg?.extraArgs)
    ? cfg.extraArgs.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0)
    : [];

  return {
    enabled,
    evaluateEnabled,
    controlPort,
    cdpPortRangeStart,
    cdpPortRangeEnd,
    cdpProtocol,
    cdpHost: cdpInfo.parsed.hostname,
    cdpIsLoopback: isLoopbackHost(cdpInfo.parsed.hostname),
    remoteCdpTimeoutMs,
    remoteCdpHandshakeTimeoutMs,
    color: defaultColor,
    executablePath,
    headless,
    noSandbox,
    attachOnly,
    defaultProfile,
    profiles,
    ssrfPolicy: resolveBrowserSsrFPolicy(cfg),
    extraArgs,
    relayBindHost: cfg?.relayBindHost?.trim() || undefined,
  };
}

export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  const profile = resolved.profiles[profileName];
  if (!profile) {
    return null;
  }

  const rawProfileUrl = profile.cdpUrl?.trim() ?? "";
  let cdpHost = resolved.cdpHost;
  let cdpPort = profile.cdpPort ?? 0;
  let cdpUrl = "";
  const driver = profile.driver === "extension" ? "extension" : "openclaw";

  if (rawProfileUrl) {
    const parsed = parseHttpUrl(rawProfileUrl, `browser.profiles.${profileName}.cdpUrl`);
    cdpHost = parsed.parsed.hostname;
    cdpPort = parsed.port;
    cdpUrl = parsed.normalized;
  } else if (cdpPort) {
    cdpUrl = `${resolved.cdpProtocol}://${resolved.cdpHost}:${cdpPort}`;
  } else {
    throw new Error(`Profile "${profileName}" must define cdpPort or cdpUrl.`);
  }

  return {
    name: profileName,
    cdpPort,
    cdpUrl,
    cdpHost,
    cdpIsLoopback: isLoopbackHost(cdpHost),
    color: profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR,
    driver,
    attachOnly: profile.attachOnly ?? resolved.attachOnly,
  };
}
