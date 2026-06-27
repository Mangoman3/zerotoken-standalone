import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getHeadersWithAuth } from "./browser-cdp.js";
import { getChromeWebSocketUrl, launchOpenClawChrome } from "./browser-chrome.js";
import { resolveZeroTokenBrowserRuntime } from "./browser-runtime.js";
import { getSharedBrowser, releaseSharedBrowser } from "./shared-browser.js";

export interface ZWebClientOptions {
  cookie: string;
  userAgent: string;
  headless?: boolean;
}

/** Model ID -> ChatGLM assistant_id mapping */
const ASSISTANT_ID_MAP: Record<string, string> = {
  "glm-4-plus": "65940acff94777010aa6b796",
  "glm-4": "65940acff94777010aa6b796",
  "glm-4-think": "676411c38945bbc58a905d31",
  "glm-4-zero": "676411c38945bbc58a905d31",
};
const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";

const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";

const X_EXP_GROUPS =
  "na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a," +
  "na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a," +
  "desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4," +
  "app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add," +
  "mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A," +
  "homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A," +
  "memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user," +
  "app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5," +
  "ai_wallet:exp:ai_wallet_enable";

/** Generate X-Sign, X-Nonce, X-Timestamp headers required by chatglm.cn */
function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now();
  const A = e.toString();
  const t = A.length;
  const o = A.split("").map((c) => Number(c));
  const i = o.reduce((acc, v) => acc + v, 0) - o[t - 2];
  const a = i % 10;
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sign = crypto
    .createHash("md5")
    .update(`${timestamp}-${nonce}-${SIGN_SECRET}`)
    .digest("hex");
  return { timestamp, nonce, sign };
}

export class ZWebClientBrowser {
  private options: ZWebClientOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;
  private accessToken: string | null = null;
  private deviceId = crypto.randomUUID().replace(/-/g, "");

  constructor(options: ZWebClientOptions) {
    this.options = options;
  }

  private parseCookies(): Array<{ name: string; value: string; domain: string; path: string }> {
    return this.options.cookie
      .split(";")
      .filter((c) => c.trim().includes("="))
      .map((cookie) => {
        const [name, ...valueParts] = cookie.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".chatglm.cn",
          path: "/",
        };
      })
      .filter((c) => c.name.length > 0);
  }

  private getRefreshToken(): string | null {
    const cookies = this.parseCookies();
    const refreshCookie = cookies.find((c) => c.name === "chatglm_refresh_token");
    return refreshCookie?.value ?? null;
  }

  private getAccessTokenFromCookie(): string | null {
    const cookies = this.parseCookies();
    const tokenCookie = cookies.find((c) => c.name === "chatglm_token");
    return tokenCookie?.value ?? null;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const { context, page } = await getSharedBrowser("Z Web Browser", "https://chatglm.cn");
    this.context = context;
    this.page = page;

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies);
      } catch (e) {
        console.warn("[Z Web Browser] Failed to add some cookies:", e);
      }
    }

    await this.refreshAccessToken();

    this.initialized = true;
  }

  private tokenRefreshedViaApi = false;

  private async refreshAccessToken(forceApi = false): Promise<void> {
    // Only use cookie token on first call and if not forced to use API
    if (!forceApi && !this.tokenRefreshedViaApi) {
      const cookieToken = this.getAccessTokenFromCookie();
      if (cookieToken) {
        this.accessToken = cookieToken;
        console.log("[Z Web Browser] Using chatglm_token from cookies");
        return;
      }

      // Also try to get token from browser cookies
      if (this.context) {
        try {
          const browserCookies = await this.context.cookies(["https://chatglm.cn"]);
          const browserToken = browserCookies.find((c) => c.name === "chatglm_token");
          if (browserToken?.value) {
            this.accessToken = browserToken.value;
            console.log("[Z Web Browser] Using chatglm_token from browser cookies");
            return;
          }
        } catch {
          // ignore
        }
      }
    }

    const refreshToken = this.getRefreshToken();
    if (!refreshToken || !this.page) {
      console.warn("[Z Web Browser] No refresh token available, cannot refresh access token");
      return;
    }

    console.log("[Z Web Browser] Refreshing access token via API...");
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const result = await this.page.evaluate(
      async ({ refreshToken, deviceId, requestId, sign }) => {
        try {
          const res = await fetch("https://chatglm.cn/chatglm/user-api/user/refresh", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${refreshToken}`,
              "App-Name": "chatglm",
              "X-App-Platform": "pc",
              "X-App-Version": "0.0.1",
              "X-Device-Id": deviceId,
              "X-Request-Id": requestId,
              "X-Sign": sign.sign,
              "X-Nonce": sign.nonce,
              "X-Timestamp": sign.timestamp,
            },
            credentials: "include",
            body: JSON.stringify({}),
          });

          if (!res.ok) {
            return { ok: false, status: res.status, error: await res.text() };
          }

          const data = await res.json();
          const accessToken =
            data?.result?.access_token ?? data?.result?.accessToken ?? data?.accessToken;
          if (!accessToken) {
            return {
              ok: false,
              status: 200,
              error: `No accessToken in response: ${JSON.stringify(data).substring(0, 300)}`,
            };
          }
          return { ok: true, accessToken };
        } catch (err) {
          return { ok: false, status: 500, error: String(err) };
        }
      },
      { refreshToken, deviceId: this.deviceId, requestId, sign },
    );

    if (result.ok && result.accessToken) {
      this.accessToken = result.accessToken;
      this.tokenRefreshedViaApi = true;
      console.log("[Z Web Browser] Access token refreshed successfully via API");
    } else {
      console.warn(`[Z Web Browser] Failed to refresh access token: ${result.error}`);
    }
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("ZWebClientBrowser not initialized");
    }

    if (!this.accessToken) {
      await this.refreshAccessToken();
    }

    const { conversationId, message, model } = params;
    const assistantId = ASSISTANT_ID_MAP[model] ?? DEFAULT_ASSISTANT_ID;

    console.log(`[Z Web Browser] Sending request... model=${model} assistantId=${assistantId}`);

    const fetchTimeoutMs = 120_000;
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");

    const body = {
      assistant_id: assistantId,
      conversation_id: conversationId || "",
      project_id: "",
      chat_type: "user_chat",
      meta_data: {
        cogview: { rm_label_watermark: false },
        is_test: false,
        input_question_type: "xxxx",
        channel: "",
        draft_id: "",
        chat_mode: "zero",
        is_networking: false,
        quote_log_id: "",
        platform: "pc",
      },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: message }],
        },
      ],
    };

    const evalPromise = this.page.evaluate(
      async ({ accessToken, bodyStr, deviceId, requestId, timeoutMs, sign, xExpGroups }) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), timeoutMs);

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "App-Name": "chatglm",
            Origin: "https://chatglm.cn",
            "X-App-Platform": "pc",
            "X-App-Version": "0.0.1",
            "X-App-fr": "default",
            "X-Device-Brand": "",
            "X-Device-Id": deviceId,
            "X-Device-Model": "",
            "X-Exp-Groups": xExpGroups,
            "X-Lang": "zh",
            "X-Nonce": sign.nonce,
            "X-Request-Id": requestId,
            "X-Sign": sign.sign,
            "X-Timestamp": sign.timestamp,
          };
          if (accessToken) {
            headers["Authorization"] = `Bearer ${accessToken}`;
          }

          const res = await fetch("https://chatglm.cn/chatglm/backend-api/assistant/stream", {
            method: "POST",
            headers,
            credentials: "include",
            body: bodyStr,
            signal: controller.signal,
          });

          clearTimeout(timer);

          if (!res.ok) {
            const errorText = await res.text();
            return { ok: false, status: res.status, error: errorText.substring(0, 500) };
          }

          const reader = res.body?.getReader();
          if (!reader) {
            return { ok: false, status: 500, error: "No response body" };
          }

          const decoder = new TextDecoder();
          let fullText = "";
          let chunkCount = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const chunk = decoder.decode(value, { stream: true });
            fullText += chunk;
            chunkCount++;
          }

          return { ok: true, data: fullText, chunkCount };
        } catch (err) {
          if (timer) {
            clearTimeout(timer);
          }
          const msg = String(err);
          if (msg.includes("aborted") || msg.includes("signal")) {
            return {
              ok: false,
              status: 408,
              error: `ChatGLM API request timed out after ${timeoutMs}ms`,
            };
          }
          return { ok: false, status: 500, error: msg };
        }
      },
      {
        accessToken: this.accessToken,
        bodyStr: JSON.stringify(body),
        deviceId: this.deviceId,
        requestId,
        timeoutMs: fetchTimeoutMs,
        sign,
        xExpGroups: X_EXP_GROUPS,
      },
    );

    const externalTimeoutMs = fetchTimeoutMs + 10_000;
    const responseData = await Promise.race([
      evalPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `[Z Web Browser] page.evaluate timed out after ${externalTimeoutMs / 1000}s`,
              ),
            ),
          externalTimeoutMs,
        ),
      ),
    ]);

    if (!responseData || !responseData.ok) {
      if (responseData?.status === 401) {
        console.log("[Z Web Browser] Access token expired, refreshing...");
        await this.refreshAccessToken();
        throw new Error("Authentication expired. Token has been refreshed, please retry.");
      }
      throw new Error(
        `ChatGLM API error: ${responseData?.status || "unknown"} - ${responseData?.error || "Request failed"}`,
      );
    }

    console.log(
      `[Z Web Browser] Response: ${responseData.chunkCount} chunks, ${responseData.data?.length || 0} bytes`,
    );

    // Log short responses for debugging (likely errors or empty)
    if (responseData.data && responseData.data.length < 500) {
      console.log(`[Z Web Browser] Response content: ${responseData.data}`);
    }

    // If response is suspiciously short, it might be an auth error — retry once with refreshed token
    if (responseData.data && responseData.data.length < 200) {
      console.log("[Z Web Browser] Very short response, force-refreshing token via API and retrying...");
      this.accessToken = null;
      await this.refreshAccessToken(true);

      if (this.accessToken) {
        const retrySign = generateSign();
        const retryRequestId = crypto.randomUUID().replace(/-/g, "");
        const retryBody = { ...body };

        const retryData = await this.page!.evaluate(
          async ({ accessToken, bodyStr, deviceId, requestId, timeoutMs, sign, xExpGroups }) => {
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeoutMs);
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                "App-Name": "chatglm",
                Origin: "https://chatglm.cn",
                "X-App-Platform": "pc",
                "X-App-Version": "0.0.1",
                "X-App-fr": "default",
                "X-Device-Brand": "",
                "X-Device-Id": deviceId,
                "X-Device-Model": "",
                "X-Exp-Groups": xExpGroups,
                "X-Lang": "zh",
                "X-Nonce": sign.nonce,
                "X-Request-Id": requestId,
                "X-Sign": sign.sign,
                "X-Timestamp": sign.timestamp,
              };
              if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
              const res = await fetch("https://chatglm.cn/chatglm/backend-api/assistant/stream", {
                method: "POST", headers, credentials: "include", body: bodyStr, signal: controller.signal,
              });
              clearTimeout(timer);
              if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).substring(0, 500) };
              const reader = res.body?.getReader();
              if (!reader) return { ok: false, status: 500, error: "No response body" };
              const decoder = new TextDecoder();
              let fullText = ""; let chunkCount = 0;
              while (true) { const { done, value } = await reader.read(); if (done) break; fullText += decoder.decode(value, { stream: true }); chunkCount++; }
              return { ok: true, data: fullText, chunkCount };
            } catch (err) { return { ok: false, status: 500, error: String(err) }; }
          },
          { accessToken: this.accessToken, bodyStr: JSON.stringify(retryBody), deviceId: this.deviceId, requestId: retryRequestId, timeoutMs: fetchTimeoutMs, sign: retrySign, xExpGroups: X_EXP_GROUPS },
        );

        if (retryData?.ok && retryData.data && retryData.data.length > 200) {
          console.log(`[Z Web Browser] Retry succeeded: ${retryData.chunkCount} chunks, ${retryData.data.length} bytes`);
          const encoder = new TextEncoder();
          return new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(retryData.data)); controller.close(); } });
        }
        console.log(`[Z Web Browser] Retry also short: ${retryData?.data?.length || 0} bytes`);
      }
    }

    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(responseData.data));
        controller.close();
      },
    });
  }

  async close(): Promise<void> {
    await releaseSharedBrowser();
    this.page = null;
    this.context = null;
    this.browser = null;
    this.initialized = false;
    this.accessToken = null;
  }
}
