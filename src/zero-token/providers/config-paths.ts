import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveHomeDir(): string {
  return os.homedir();
}

function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return path.resolve(input);
  }
  return path.resolve(path.join(resolveHomeDir(), input.slice(1)));
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return expandHome(override);
  }
  return path.join(resolveHomeDir(), ".openclaw");
}

export function resolveConfigPathCandidate(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return expandHome(explicit);
  }

  const home = resolveHomeDir();
  const stateDir = resolveStateDir(env);
  const candidates = [
    path.join(stateDir, "openclaw.json"),
    path.join(home, ".openclaw", "openclaw.json"),
    path.join(home, ".clawdbot", "clawdbot.json"),
    path.join(home, ".moldbot", "moldbot.json"),
    path.join(home, ".moltbot", "moltbot.json"),
  ];

  const existing = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  return existing ?? candidates[0] ?? path.join(stateDir, "openclaw.json");
}
