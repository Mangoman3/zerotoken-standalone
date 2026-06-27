# Zero-Token Standalone LLM Proxy

A lightweight, self-contained Node.js proxy server that maps standard OpenAI-compatible API calls directly to browser-authenticated web LLM chat providers. It bypasses Cloudflare Turnstile, browser TLS/fingerprint verification, and CSRF checks by routing API requests through a shared, hidden browser context running locally on your machine.

No API keys or payment tokens are required—only a standard free account on the target web chat platforms.

---

## Key Features

- **OpenAI API Compatibility**: Exposes standard `/v1/models` and `/v1/chat/completions` REST endpoints. Can be used as a direct drop-in replacement with any UI client (LibreChat, LobeChat, NextChat, etc.).
- **Stealth Browser Automation**: Employs Playwright-core with advanced anti-fingerprinting stealth scripts (spoofing `navigator.webdriver`, plugins, languages, and browser dimensions) to run in a hidden visible state (positioned out of view) without triggering bot detectors.
- **Persistent Sessions**: Stores session credentials inside a local `./auth.json` file. Browser profiles, cookies, and local storage persist under a unified state directory (`~/.openclaw/browser/api-chrome`).
- **Interactive Onboarding CLI**: A simple setup CLI to quickly login, execute Cloudflare checks, and capture session tokens automatically.
- **Thinking / Reasoning Blocks**: Parses and maps thinking tokens (e.g., DeepSeek's `<think>` or Sakana's `<plan>` tags) directly to OpenAI-compatible `reasoning_content` stream deltas in real-time.
- **Optimized Resource Sharing**: Reuses a single background Chrome instance across all active provider requests to minimize RAM and CPU usage.

---

## Supported Providers & Models

| Provider ID | Web Platform | Supported Model ID | Description | Features |
|---|---|---|---|---|
| `deepseek-web` | [DeepSeek Chat](https://chat.deepseek.com/) | `deepseek-chat`<br>`deepseek-reasoner` | DeepSeek V3 / R1 (Reasoning) | Text, Search, Reasoning Content |
| `sakana-web` | [Sakana Chat](https://chat.sakana.ai/) | `namazu`<br>`namazu-thinking` | Sakana AI's Japanese model | Text, Web Search, Reasoning Content |
| `chatgpt-web` | [ChatGPT](https://chatgpt.com/) | `gpt-4o`<br>`gpt-4-turbo`<br>`gpt-3.5-turbo` | OpenAI Web Models | Text, Vision, Streaming |
| `claude-web` | [Claude AI](https://claude.ai/) | `claude-3-5-sonnet`<br>`claude-opus-4-6` | Anthropic Web Models | Text, Vision, Document Parsing |
| `gemini-web` | [Gemini](https://gemini.google.com/) | `gemini-1.5-pro`<br>`gemini-1.5-flash` | Google Web Models | Text, Multi-modal |
| `grok-web` | [Grok](https://grok.com/) | `grok-2`<br>`grok-2-search` | xAI Web Models | Text, Real-time Search |
| `doubao-web` | [Doubao](https://www.doubao.com/) | `doubao-seed-2.0` | ByteDance Web Model | Text, Chinese Optimization |
| `kimi-web` | [Kimi Chat](https://kimi.com/) | `moonshot-v1-32k` | Moonshot Web Model | Long Context Text |
| `glm-web` / `glm-intl-web` | [GLM CN](https://chatglm.cn/) / [GLM Intl](https://chat.z.ai/) | `glm-4-plus`<br>`glm-4-think` | Zhipu GLM Models | Text, Reasoning (Chinese/English) |
| `perplexity-web` | [Perplexity](https://perplexity.ai/) | `perplexity-pro` | Perplexity Search Model | Real-time Search & Citations |
| `xiaomimo-web` | [Xiaomi MiMo](https://aistudio.xiaomimimo.com/) | `xiaomimo-chat` | Xiaomi MiMo AI Studio | Text Generation |

---

## Prerequisites

- **Node.js**: Version 22 or higher.
- **Browser**: Google Chrome or Microsoft Edge installed on macOS/Linux. Playwright will locate and connect to your system browser automatically.
- **Operating System**: macOS is fully supported out of the box (with hidden window positioning).

---

## Installation & Setup

1. **Clone and Install Dependencies**:
   ```bash
   git clone <repository-url> zerotoken-standalone
   cd zerotoken-standalone
   npm install
   ```

2. **Compile the TypeScript Code**:
   ```bash
   npm run build
   ```

3. **Onboard/Log In to a Provider**:
   Run the CLI tool to authenticate. This will open a browser window for you to log in. Once logged in, the tool will capture cookies/tokens and save them to `auth.json`.
   ```bash
   # Run the interactive setup to choose a provider
   npm run login
   
   # Or directly launch onboarding for a specific provider
   npm run login -- --provider sakana-web
   ```
   *Note: In the browser window, complete any Cloudflare checks or logins required. The CLI will log a success message once credentials are saved.*

---

## Running the Proxy Server

1. **Start the Proxy Server**:
   ```bash
   npm run start
   ```
   The proxy server will launch on `http://localhost:3000`.

2. **Verify Server Status**:
   ```bash
   curl http://localhost:3000/health
   ```
   This returns the proxy status and a list of authenticated web providers.

3. **List Active Models**:
   ```bash
   curl http://localhost:3000/v1/models
   ```
   This lists only the models whose web providers are currently authenticated in your `auth.json`.

---

## Usage Examples (OpenAI Compatibility)

You can query the proxy using standard OpenAI API payloads.

### Non-Streaming Request
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "namazu",
    "messages": [{"role": "user", "content": "こんにちは"}],
    "stream": false
  }'
```

### Streaming Request (with Reasoning Content)
```bash
curl -i http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "namazu-thinking",
    "messages": [{"role": "user", "content": "3 と 5 はどちらが大きいですか？簡潔に答えてください。"}],
    "stream": true
  }'
```

---

## Configuration & Environment Variables

Create a `.env` file in the root directory to customize behaviors:

```env
# Port the proxy server listens on (default: 3000)
PORT=3000

# Run browser in headless mode (default: false, recommended to keep false for Turnstile bypass)
ZEROTOKEN_HEADLESS=false

# Connect to an existing running debugging instance of Chrome instead of launching a new one
ZEROTOKEN_ATTACH=false
```

---

## Architecture & Flows

For a deep dive into the inner workings, component maps, and request sequence flows, please refer to the [Documentation Folder](file:///Users/arsalan/Custom/Learning/ProxyLLM_/zerotoken-standalone/doc/):
*   [Architecture Overview](file:///Users/arsalan/Custom/Learning/ProxyLLM_/zerotoken-standalone/doc/architecture.md)
*   [API Request Sequence Flow](file:///Users/arsalan/Custom/Learning/ProxyLLM_/zerotoken-standalone/doc/flow.md)

---

## License

MIT License. See [LICENSE](LICENSE) for details.
Disclaimer: This tool is for educational purposes only. Do not exceed the rate limits or terms of service of the respective web providers.
