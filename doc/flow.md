# System Flows — Zero-Token Standalone LLM Proxy

This document details the operational flows within the Zero-Token proxy, including the interactive CLI onboarding sequence and the completions request lifecycle.

---

## 1. Onboarding & Login Flow

The onboarding flow runs via `npm run login` to authenticate the web providers. It launches a visible browser instance to let users log in manually, bypass Turnstile checks, and automatically captures the resulting cookies.

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Developer
    participant CLI as Onboarding CLI (onboard.ts)
    participant Chrome as Chrome (Stealth Visible)
    participant AuthStore as Auth Store (auth-store.ts)
    participant Web as Target Chat UI (e.g. Sakana AI)

    User->>CLI: npm run login -- --provider sakana-web
    CLI->>Chrome: Launch Headful Chrome (Visible)
    CLI->>Chrome: Inject BROWSER_STEALTH_SCRIPT
    CLI->>Chrome: Navigate to target URL (https://chat.sakana.ai/)
    Chrome->>Web: Load Login Page & Cloudflare Challenge
    User->>Chrome: Solve Turnstile & Log In (Google/Email)
    Chrome->>Web: Successful authentication redirect
    loop Cookie Verification
        CLI->>Chrome: Check document.cookie periodically
    end
    Note over CLI,Chrome: Waiting for 'sakana-chat' and 'cf_clearance' cookies
    Chrome-->>CLI: Cookies detected!
    CLI->>Chrome: Extract context cookies & userAgent
    CLI->>AuthStore: Save credentials to ./auth.json
    CLI->>Chrome: Stop Chrome process
    CLI-->>User: "Authentication captured successfully!"
```

---

## 2. API Request & Completions Flow

When an external OpenAI client makes a request to `/v1/chat/completions`, the proxy coordinates the shared browser instance and streams standard OpenAI SSE responses in real-time.

```mermaid
sequenceDiagram
    autonumber
    participant Client as OpenAI API Client
    participant Express as Express Server (server.ts)
    participant Router as Model Router (model-router.ts)
    participant SharedBrowser as Shared Browser (shared-browser.ts)
    participant Chrome as Hidden Chrome (Off-screen)
    participant Stream as Stream Parser (sakana-web-stream.ts)
    participant WebAPI as Target Web API (SvelteKit / conversation)

    Client->>Express: POST /v1/chat/completions (model: namazu-thinking, messages)
    Express->>Router: resolveModel(modelName)
    Router-->>Express: resolved (providerId: sakana-web, modelId: namazu-thinking)
    Express->>SharedBrowser: getSharedBrowser("sakana-web", "https://chat.sakana.ai/")
    alt Browser not running
        SharedBrowser->>Chrome: Launch Chrome (-32000,-32000 off-screen)
        SharedBrowser->>Chrome: Inject stealth script
    end
    SharedBrowser->>Chrome: Get/Create tab for chat.sakana.ai
    SharedBrowser->>Chrome: Inject credentials (cookies)
    Express->>Stream: createSakanaWebStreamFn(authJSON)
    Stream->>Chrome: page.evaluate(fetch conversation v2)
    Chrome->>WebAPI: POST /conversation (Web auth header + cookies)
    WebAPI-->>Chrome: Return conversationId & systemMessageId
    Stream->>Chrome: page.evaluate(fetch stream endpoint with formData)
    Chrome->>WebAPI: POST /conversation/{id}
    WebAPI-->>Chrome: NDJSON Stream Response
    loop Stream Reading
        Chrome-->>Stream: Emits chunk string (raw NDJSON tokens)
        Stream->>Stream: Parse JSON line, extract token text
        Stream->>Stream: Run tag state machine (<plan>, <answer>)
        alt Current state: thinking
            Stream->>Express: Emit thinking_delta (reasoning_content)
            Express-->>Client: SSE: data: {"delta": {"reasoning_content": "..."}}
        else Current state: text
            Stream->>Express: Emit text_delta (content)
            Express-->>Client: SSE: data: {"delta": {"content": "..."}}
        end
    end
    Stream-->>Express: done event
    Express-->>Client: SSE: data: [DONE]
```

---

## Technical Details

1. **Off-Screen Windowing**:
   Chrome is started with args `--window-position=-32000,-32000 --window-size=1,1`. Since it is positioned well outside the display buffer coordinates, it is invisible to the developer, while operating fully as a headful browser (which helps pass anti-bot scripts that block headless runtimes).
2. **Page Re-use**:
   The shared browser checks `sharedContext.pages()` first. If a tab already exists for `chat.sakana.ai`, it reuses it instead of opening a new one, avoiding the overhead of navigating and compiling scripts repeatedly.
3. **Graceful Error Recovery**:
   If the browser crashes or is terminated by the OS, the proxy intercepts the failure (`Target page, context or browser has been closed`), destroys the dead context reference, and triggers a retry that spins up a fresh Chrome instance transparently.
