import fs from "node:fs";
import path from "node:path";

const AUTH_FILE_PATH = path.resolve(process.cwd(), "auth.json");

export interface AuthData {
  cookie: string;
  [key: string]: any;
}

export type AllAuthData = Record<string, AuthData>;

function readAuthFile(): AllAuthData {
  try {
    if (fs.existsSync(AUTH_FILE_PATH)) {
      const content = fs.readFileSync(AUTH_FILE_PATH, "utf8");
      return JSON.parse(content) as AllAuthData;
    }
  } catch (error) {
    console.error("Error reading auth.json:", error);
  }
  return {};
}

function writeAuthFile(data: AllAuthData): void {
  try {
    fs.writeFileSync(AUTH_FILE_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing auth.json:", error);
  }
}

export function loadAuth(providerId: string): AuthData | null {
  const allAuth = readAuthFile();
  return allAuth[providerId] || null;
}

export function saveAuth(providerId: string, credentials: Record<string, any>): void {
  const allAuth = readAuthFile();
  allAuth[providerId] = {
    cookie: credentials.cookie,
    ...credentials,
  };
  writeAuthFile(allAuth);
}

export function listAuth(): { providerId: string; hasCredentials: boolean }[] {
  const allAuth = readAuthFile();
  // We can query this list from web-providers.ts or a hardcoded list, but let's just return what is in auth.json for now,
  // or return the full list of supported zero-token providers.
  // Let's use the keys from allAuth first.
  const activeKeys = Object.keys(allAuth);
  return activeKeys.map((key) => ({
    providerId: key,
    hasCredentials: !!allAuth[key]?.cookie,
  }));
}

export function clearAuth(providerId: string): void {
  const allAuth = readAuthFile();
  delete allAuth[providerId];
  writeAuthFile(allAuth);
}
