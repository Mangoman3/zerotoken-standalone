import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { loadAuth, listAuth } from "./auth-store.js";
import { resolveModel, getAllModels } from "./model-router.js";
import { getWebStreamFactory } from "./zero-token/streams/web-stream-factories.js";
import { wrapWithToolCalling } from "./zero-token/tool-calling/web-stream-middleware.js";
import { pipeStreamToResponse, accumulateStreamToJSON } from "./sse-adapter.js";
import type { OpenClawConfig } from "./zero-token/types.js";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Logger middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// GET /v1/models
app.get("/v1/models", async (req, res) => {
  try {
    const authList = listAuth();
    const activeProviderIds = new Set(
      authList.filter((a) => a.hasCredentials).map((a) => a.providerId)
    );

    const allModels = await getAllModels();
    
    // Filter models to only show the ones where the user is logged in
    const activeModels = allModels.filter((model) => {
      // Find the provider for this model
      const providerId = model.api as string; // in ModelDefinitionConfig, model.api refers to the provider/API id (e.g. 'deepseek-web')
      return providerId && activeProviderIds.has(providerId);
    });

    const data = activeModels.map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: model.api || "system",
    }));

    res.json({
      object: "list",
      data,
    });
  } catch (error) {
    console.error("Error listing models:", error);
    res.status(500).json({
      error: {
        message: "Internal server error while retrieving models.",
        type: "api_error",
        param: null,
        code: null,
      },
    });
  }
});

// POST /v1/chat/completions
app.post("/v1/chat/completions", async (req, res) => {
  const { model: modelName, messages, stream = false, tools } = req.body;

  if (!modelName) {
    return res.status(400).json({
      error: {
        message: "The 'model' parameter is required.",
        type: "invalid_request_error",
      },
    });
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: {
        message: "The 'messages' parameter is required and must be an array.",
        type: "invalid_request_error",
      },
    });
  }

  try {
    // Resolve model to provider
    const resolved = await resolveModel(modelName);
    if (!resolved) {
      return res.status(404).json({
        error: {
          message: `Model '${modelName}' is not supported or not recognized.`,
          type: "invalid_request_error",
        },
      });
    }

    const { providerId, modelId, definition } = resolved;

    // Load credentials
    const credentials = loadAuth(providerId);
    if (!credentials || !credentials.cookie) {
      return res.status(401).json({
        error: {
          message: `Provider '${providerId}' is not logged in. Run 'npm run login -- --provider ${providerId}' first.`,
          type: "invalid_request_error",
        },
      });
    }

    // Get stream factory
    const streamFactory = getWebStreamFactory(providerId);
    if (!streamFactory) {
      return res.status(400).json({
        error: {
          message: `No stream factory registered for provider '${providerId}'.`,
          type: "invalid_request_error",
        },
      });
    }

    // Prepare context
    let systemPrompt = "";
    const filteredMessages = messages.filter((m: any) => {
      if (m.role === "system") {
        systemPrompt = m.content;
        return false;
      }
      return true;
    });

    const contextConfig: any = {
      messages: filteredMessages,
      systemPrompt,
      tools: tools || [],
    };

    const modelConfig: any = {
      id: modelId,
      api: providerId,
      provider: providerId,
    };

    // Instantiate stream function
    // Pass cookie/options JSON string or simple cookie depending on provider implementation
    const cookieOrJson = JSON.stringify(credentials);
    let streamFn = streamFactory(cookieOrJson);

    // Apply tool calling wrapper if tools are present
    if (tools && tools.length > 0) {
      streamFn = wrapWithToolCalling(streamFn, providerId);
    }

    // Execute the stream
    const eventStream = await streamFn(modelConfig, contextConfig, {
      signal: (req as any).signal,
    });

    if (stream) {
      await pipeStreamToResponse(eventStream, modelId, res);
    } else {
      const responseJSON = await accumulateStreamToJSON(eventStream, modelId);
      res.json(responseJSON);
    }
  } catch (error) {
    console.error("Error processing completions:", error);
    res.status(500).json({
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "api_error",
      },
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  const authList = listAuth();
  res.json({
    status: "ok",
    providers: authList,
  });
});

app.listen(PORT, () => {
  console.log(`\n\x1b[1m\x1b[32m✓ Zero-Token Proxy Server is running on http://localhost:${PORT}\x1b[0m`);
  console.log(`OpenAI Base URL: \x1b[36mhttp://localhost:${PORT}/v1\x1b[0m\n`);
});
