import {
  buildDeepseekWebProvider,
  buildDoubaoWebProvider,
  buildClaudeWebProvider,
  buildChatGPTWebProvider,
  buildQwenWebProvider,
  buildQwenCNWebProvider,
  buildKimiWebProvider,
  buildGeminiWebProvider,
  buildGrokWebProvider,
  buildZWebProvider,
  buildGlmIntlWebProvider,
  buildPerplexityWebProvider,
  buildXiaomiMimoWebProvider,
  buildSakanaWebProvider,
} from "./zero-token/bridge/web-providers.js";
import type { ModelDefinitionConfig } from "./zero-token/types.js";

export interface ResolvedModel {
  providerId: string;
  modelId: string;
  definition: ModelDefinitionConfig;
}

// Static default mapping dictionary for quick lookup
const STATIC_MODEL_MAPPING: Record<string, string> = {
  // DeepSeek
  "deepseek-chat": "deepseek-web",
  "deepseek-reasoner": "deepseek-web",
  "deepseek-chat-search": "deepseek-web",
  "deepseek-chat-web": "deepseek-web",
  // Claude
  "claude-sonnet-4-6": "claude-web",
  "claude-opus-4-6": "claude-web",
  "claude-haiku-4-6": "claude-web",
  "claude-3-5-sonnet": "claude-web",
  // ChatGPT
  "gpt-4": "chatgpt-web",
  "gpt-4o": "chatgpt-web",
  "gpt-4-turbo": "chatgpt-web",
  "gpt-3.5-turbo": "chatgpt-web",
  // Qwen
  "qwen3.5-plus": "qwen-web",
  "qwen3.5-turbo": "qwen-web",
  "Qwen3.5-Plus": "qwen-cn-web",
  "Qwen3.5-Turbo": "qwen-cn-web",
  // Kimi
  "moonshot-v1-32k": "kimi-web",
  "moonshot-v1-8k": "kimi-web",
  // Gemini
  "gemini-pro": "gemini-web",
  "gemini-ultra": "gemini-web",
  "gemini-1.5-pro": "gemini-web",
  "gemini-1.5-flash": "gemini-web",
  // Grok
  "grok-1": "grok-web",
  "grok-2": "grok-web",
  "grok-2-search": "grok-web",
  // GLM
  "glm-4-plus": "glm-web",
  "glm-4-think": "glm-web",
  "glm-intl-4-plus": "glm-intl-web",
  "glm-intl-4-think": "glm-intl-web",
  // Perplexity
  "perplexity-web": "perplexity-web",
  "perplexity-pro": "perplexity-web",
  // Doubao
  "doubao-seed-2.0": "doubao-web",
  "doubao-pro": "doubao-web",
  // Xiaomi
  "xiaomimo-chat": "xiaomimo-web",
  // Sakana
  "namazu": "sakana-web",
  "namazu-thinking": "sakana-web",
};

let providersCache: Record<string, { api: string; models: ModelDefinitionConfig[] }> | null = null;

async function getProviders(): Promise<Record<string, { api: string; models: ModelDefinitionConfig[] }>> {
  if (providersCache) {
    return providersCache;
  }

  const cache: Record<string, { api: string; models: ModelDefinitionConfig[] }> = {};
  
  try {
    const list = await Promise.all([
      buildDeepseekWebProvider(),
      buildDoubaoWebProvider(),
      buildClaudeWebProvider(),
      buildChatGPTWebProvider(),
      buildQwenWebProvider(),
      buildQwenCNWebProvider(),
      buildKimiWebProvider(),
      buildGeminiWebProvider(),
      buildGrokWebProvider(),
      buildZWebProvider(),
      buildGlmIntlWebProvider(),
      buildPerplexityWebProvider(),
      buildXiaomiMimoWebProvider(),
      buildSakanaWebProvider(),
    ]);

    for (const p of list) {
      if (p && p.api) {
        const models = (p.models || []).map((m) => ({
          ...m,
          api: m.api || p.api,
        }));
        cache[p.api] = {
          api: p.api,
          models,
        };
      }
    }
    providersCache = cache;
  } catch (error) {
    console.error("Error building providers list:", error);
  }

  return cache;
}

export async function getAllModels(): Promise<ModelDefinitionConfig[]> {
  const providers = await getProviders();
  const all: ModelDefinitionConfig[] = [];
  for (const p of Object.values(providers)) {
    all.push(...p.models);
  }
  return all;
}

export async function resolveModel(modelName: string): Promise<ResolvedModel | null> {
  const providers = await getProviders();

  // 1. Prefixed format: <providerId>/<modelId>
  if (modelName.includes("/")) {
    const [providerId, modelId] = modelName.split("/", 2);
    const provider = providers[providerId];
    if (provider) {
      const def = provider.models.find((m) => m.id === modelId);
      if (def) {
        return { providerId, modelId, definition: def };
      }
    }
  }

  // 2. Static mapping lookup
  const staticProviderId = STATIC_MODEL_MAPPING[modelName];
  if (staticProviderId) {
    const provider = providers[staticProviderId];
    if (provider) {
      const def = provider.models.find((m) => m.id === modelName);
      if (def) {
        return { providerId: staticProviderId, modelId: modelName, definition: def };
      }
      // Fallback: if not exactly matching model ID, return first model of provider
      if (provider.models.length > 0) {
        return { providerId: staticProviderId, modelId: provider.models[0].id, definition: provider.models[0] };
      }
    }
  }

  // 3. Dynamic scan across all models
  for (const provider of Object.values(providers)) {
    const def = provider.models.find((m) => m.id === modelName);
    if (def) {
      return { providerId: provider.api, modelId: modelName, definition: def };
    }
  }

  return null;
}
