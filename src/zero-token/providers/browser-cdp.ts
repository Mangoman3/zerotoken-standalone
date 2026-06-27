export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  try {
    const parsed = new URL(url);
    const hasAuthHeader = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
    if (hasAuthHeader) {
      return headers;
    }
    if (parsed.username || parsed.password) {
      const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
      return { ...headers, Authorization: `Basic ${auth}` };
    }
  } catch {
    // Ignore invalid URLs and return best-effort headers.
  }
  return headers;
}

export function appendCdpPath(cdpUrl: string, extraPath: string): string {
  const url = new URL(cdpUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  const suffix = extraPath.startsWith("/") ? extraPath : `/${extraPath}`;
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

export function normalizeCdpWsUrl(wsUrl: string, cdpUrl: string): string {
  const ws = new URL(wsUrl);
  const cdp = new URL(cdpUrl);
  const isWildcardBind = ws.hostname === "0.0.0.0" || ws.hostname === "[::]";
  if ((isLoopbackHost(ws.hostname) || isWildcardBind) && !isLoopbackHost(cdp.hostname)) {
    ws.hostname = cdp.hostname;
    const cdpPort = cdp.port || (cdp.protocol === "https:" ? "443" : "80");
    if (cdpPort) {
      ws.port = cdpPort;
    }
    ws.protocol = cdp.protocol === "https:" ? "wss:" : "ws:";
  }
  if (cdp.protocol === "https:" && ws.protocol === "ws:") {
    ws.protocol = "wss:";
  }
  if (!ws.username && !ws.password && (cdp.username || cdp.password)) {
    ws.username = cdp.username;
    ws.password = cdp.password;
  }
  for (const [key, value] of cdp.searchParams.entries()) {
    if (!ws.searchParams.has(key)) {
      ws.searchParams.append(key, value);
    }
  }
  return ws.toString();
}
