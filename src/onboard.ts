import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { saveAuth } from "./auth-store.js";

// Import all login functions
import { loginDeepseekWeb } from "./zero-token/providers/deepseek-web-auth.js";
import { loginClaudeWeb } from "./zero-token/providers/claude-web-auth.js";
import { loginChatGPTWeb } from "./zero-token/providers/chatgpt-web-auth.js";
import { loginQwenWeb } from "./zero-token/providers/qwen-web-auth.js";
import { loginQwenCNWeb } from "./zero-token/providers/qwen-cn-web-auth.js";
import { loginKimiWeb } from "./zero-token/providers/kimi-web-auth.js";
import { loginGeminiWeb } from "./zero-token/providers/gemini-web-auth.js";
import { loginGrokWeb } from "./zero-token/providers/grok-web-auth.js";
import { loginZWeb } from "./zero-token/providers/glm-web-auth.js";
import { loginGlmIntlWeb } from "./zero-token/providers/glm-intl-web-auth.js";
import { loginPerplexityWeb } from "./zero-token/providers/perplexity-web-auth.js";
import { loginDoubaoWeb } from "./zero-token/providers/doubao-web-auth.js";
import { loginXiaomiMimoWeb } from "./zero-token/providers/xiaomimo-web-auth.js";
import { loginSakanaWeb } from "./zero-token/providers/sakana-web-auth.js";

interface ProviderOption {
  id: string;
  name: string;
  loginFn: (params: any) => Promise<any>;
}

const PROVIDERS: ProviderOption[] = [
  { id: "deepseek-web", name: "DeepSeek (chat.deepseek.com)", loginFn: loginDeepseekWeb },
  { id: "claude-web", name: "Claude (claude.ai)", loginFn: loginClaudeWeb },
  { id: "chatgpt-web", name: "ChatGPT (chatgpt.com)", loginFn: loginChatGPTWeb },
  { id: "qwen-web", name: "Qwen International (chat.qwen.ai)", loginFn: loginQwenWeb },
  { id: "qwen-cn-web", name: "Qwen CN (chat2.qianwen.com)", loginFn: loginQwenCNWeb },
  { id: "kimi-web", name: "Kimi (kimi.com)", loginFn: loginKimiWeb },
  { id: "gemini-web", name: "Gemini (gemini.google.com)", loginFn: loginGeminiWeb },
  { id: "grok-web", name: "Grok (grok.com)", loginFn: loginGrokWeb },
  { id: "glm-web", name: "GLM CN / ChatGLM (chatglm.cn)", loginFn: loginZWeb },
  { id: "glm-intl-web", name: "GLM International (chat.z.ai)", loginFn: loginGlmIntlWeb },
  { id: "perplexity-web", name: "Perplexity (perplexity.ai)", loginFn: loginPerplexityWeb },
  { id: "doubao-web", name: "Doubao (doubao.com)", loginFn: loginDoubaoWeb },
  { id: "xiaomimo-web", name: "Xiaomi MiMo (aistudio.xiaomimimo.com)", loginFn: loginXiaomiMimoWeb },
  { id: "sakana-web", name: "Sakana Chat (chat.sakana.ai)", loginFn: loginSakanaWeb },
];

async function main() {
  const args = process.argv.slice(2);
  
  let providerId = "";
  let attach = false;
  let headless = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && i + 1 < args.length) {
      providerId = args[++i];
    } else if (args[i] === "--attach") {
      attach = true;
    } else if (args[i] === "--headless") {
      headless = true;
    }
  }

  // Set environment variables for config overrides
  if (attach) {
    process.env.ZEROTOKEN_ATTACH = "true";
  } else {
    process.env.ZEROTOKEN_ATTACH = "false";
  }

  if (headless) {
    process.env.ZEROTOKEN_HEADLESS = "true";
  } else {
    process.env.ZEROTOKEN_HEADLESS = "false";
  }

  // Interactive picker if provider not specified
  if (!providerId) {
    console.log("\n\x1b[1m\x1b[36m=== Zero-Token Standalone Onboarding ===\x1b[0m");
    console.log("Select a web provider to log in:\n");
    PROVIDERS.forEach((p, idx) => {
      console.log(`  \x1b[32m[${idx + 1}]\x1b[0m ${p.name} (${p.id})`);
    });
    console.log("");

    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(`Choose option (1-${PROVIDERS.length}): `);
      const choice = parseInt(answer.trim(), 10);
      if (isNaN(choice) || choice < 1 || choice > PROVIDERS.length) {
        console.error("\x1b[31mInvalid selection.\x1b[0m");
        process.exit(1);
      }
      providerId = PROVIDERS[choice - 1].id;
    } finally {
      rl.close();
    }
  }

  const selected = PROVIDERS.find((p) => p.id === providerId);
  if (!selected) {
    console.error(`\x1b[31mUnknown provider: ${providerId}\x1b[0m`);
    process.exit(1);
  }

  console.log(`\n\x1b[1mStarting login flow for provider: \x1b[33m${selected.name}\x1b[0m`);
  console.log(`Browser mode: \x1b[32m${attach ? "Attach to existing" : "Launch fresh Chrome instance"}\x1b[0m`);
  console.log(`Headless: \x1b[32m${headless ? "Yes" : "No (visible window)"}\x1b[0m\n`);

  try {
    const credentials = await selected.loginFn({
      onProgress: (msg: string) => {
        console.log(`\x1b[90m[Progress]\x1b[0m ${msg}`);
      },
      openUrl: async (url: string) => {
        console.log(`\n\x1b[1m\x1b[35m[Action Required]\x1b[0m Please visit: \x1b[4m${url}\x1b[0m\n`);
        return true;
      },
      headless,
    });

    if (credentials && credentials.cookie) {
      saveAuth(providerId, credentials);
      console.log(`\n\x1b[1m\x1b[32m✓ Success!\x1b[0m Credentials captured and saved to \x1b[36m./auth.json\x1b[0m\n`);
    } else {
      throw new Error("No cookie captured from browser session.");
    }
  } catch (error) {
    console.error(`\n\x1b[1m\x1b[31m✗ Login failed:\x1b[0m`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
