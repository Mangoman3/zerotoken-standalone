import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { getHeadersWithAuth } from "./browser-cdp.js";
import {
  launchOpenClawChrome,
  stopOpenClawChrome,
  getChromeWebSocketUrl,
  type RunningChrome,
} from "./browser-chrome.js";
import { resolveZeroTokenBrowserRuntime } from "./browser-runtime.js";
import { getSharedBrowser, releaseSharedBrowser } from "./shared-browser.js";
import type { ModelDefinitionConfig } from "../types.js";

export interface KimiWebClientOptions {
  cookie?: string;
  accessToken?: string;
  refreshToken?: string;
  userAgent?: string;
}

/**
 * Kimi Web Client using CDP attach
 * 使用 Connect RPC 纯 API（/apiv2/kimi.gateway.chat.v1.ChatService/Chat），kimi-auth 从 Cookie 提取
 */
export class KimiWebClientBrowser {
  private cookie: string;
  private accessToken: string;
  private refreshToken: string;
  private userAgent: string;
  private baseUrl = "https://www.kimi.com";
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private running: RunningChrome | null = null;

  constructor(options: KimiWebClientOptions | string) {
    if (typeof options === "string") {
      try {
        const parsed = JSON.parse(options) as KimiWebClientOptions;
        this.cookie = parsed.cookie || "";
        this.accessToken = parsed.accessToken || "";
        this.refreshToken = parsed.refreshToken || "";
        this.userAgent = parsed.userAgent || "Mozilla/5.0";
      } catch {
        this.cookie = options;
        this.accessToken = "";
        this.refreshToken = "";
        this.userAgent = "Mozilla/5.0";
      }
    } else {
      this.cookie = options.cookie || "";
      this.accessToken = options.accessToken || "";
      this.refreshToken = options.refreshToken || "";
      this.userAgent = options.userAgent || "Mozilla/5.0";
    }
  }

  private async ensureBrowser() {
    if (this.browser && this.page) {
      return { browser: this.browser, page: this.page };
    }

    const { context, page } = await getSharedBrowser("Kimi Web Browser", "https://www.kimi.com/");
    this.browser = context;
    this.page = page;

    if (this.cookie.trim()) {
      const pageUrl = this.page?.url() ?? this.baseUrl;
      const domain = pageUrl.includes("moonshot.cn") ? ".moonshot.cn" : ".kimi.com";

      const rawCookies = this.cookie.split(";").map((c) => {
        const [name, ...valueParts] = c.trim().split("=");
        const nameStr = name?.trim() ?? "";
        const valueStr = valueParts.join("=").trim();
        if (!nameStr) {
          return null;
        }
        const cookie: {
          name: string;
          value: string;
          domain: string;
          path: string;
          secure?: boolean;
        } = {
          name: nameStr,
          value: valueStr,
          domain,
          path: "/",
        };
        if (nameStr.startsWith("__Secure-") || nameStr.startsWith("__Host-")) {
          cookie.secure = true;
        }
        return cookie;
      });
      const cookies = rawCookies.filter((c): c is NonNullable<typeof c> => c !== null);
      if (cookies.length > 0) {
        try {
          await this.browser.addCookies(cookies);
        } catch (err) {
          console.warn(
            `[Kimi Web] addCookies failed (page may already have session): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return { browser: this.browser, page: this.page };
  }

  async init() {
    await this.ensureBrowser();
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const { browser, page } = await this.ensureBrowser();

    const cookies = await browser.cookies([this.baseUrl]);
    const kimiAuthCookie = cookies.find((c) => c.name === "kimi-auth")?.value;
    // Prefer accessToken (from localStorage) over kimi-auth cookie
    const authToken = this.accessToken || kimiAuthCookie;
    if (!authToken) {
      throw new Error(
        "Kimi: 未找到认证凭证（accessToken 或 kimi-auth Cookie）。请重新登录 www.kimi.com。",
      );
    }

    const result = await page.evaluate(
      async ({
        baseUrl,
        message,
        kimiAuthToken,
        scenario,
      }: {
        baseUrl: string;
        message: string;
        kimiAuthToken: string;
        scenario: string;
      }) => {
        // Connect RPC binary encoding
        const req = {
          scenario,
          message: {
            role: "user" as const,
            blocks: [{ message_id: "", text: { content: message } }],
            scenario,
          },
          options: { thinking: false },
        };
        const enc = new TextEncoder().encode(JSON.stringify(req));
        const buf = new ArrayBuffer(5 + enc.byteLength);
        const dv = new DataView(buf);
        dv.setUint8(0, 0x00);
        dv.setUint32(1, enc.byteLength, false);
        new Uint8Array(buf, 5).set(enc);

        const res = await fetch(`${baseUrl}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/connect+json",
            "Connect-Protocol-Version": "1",
            Accept: "*/*",
            Origin: baseUrl,
            Referer: `${baseUrl}/`,
            "X-Language": "zh-CN",
            "X-Msh-Platform": "web",
            Authorization: `Bearer ${kimiAuthToken}`,
          },
          body: buf,
        });

        if (!res.ok) {
          const text = await res.text();
          if (res.status === 401 || res.status === 403) {
            return { ok: false as const, error: `登录已过期（HTTP ${res.status}），请重新登录 www.kimi.com` };
          }
          return { ok: false as const, error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
        }
        const arr = await res.arrayBuffer();
        const u8 = new Uint8Array(arr);
        const texts: string[] = [];
        let o = 0;
        while (o + 5 <= u8.length) {
          const len = new DataView(u8.buffer, u8.byteOffset + o + 1, 4).getUint32(0, false);
          if (o + 5 + len > u8.length) {
            break;
          }
          const chunk = u8.slice(o + 5, o + 5 + len);
          try {
            const obj = JSON.parse(new TextDecoder().decode(chunk));
            if (obj.error) {
              return {
                ok: false as const,
                error:
                  obj.error.message || obj.error.code || JSON.stringify(obj.error).slice(0, 200),
              };
            }
            if (obj.block?.text?.content && ["set", "append"].includes(obj.op || "")) {
              texts.push(obj.block.text.content);
            }
            if (obj.done) {
              break;
            }
          } catch {
            // ignore parse errors for non-JSON chunks
          }
          o += 5 + len;
        }
        return { ok: true as const, text: texts.join("") };
      },
      {
        baseUrl: this.baseUrl,
        message: params.message,
        kimiAuthToken: authToken,
        scenario: params.model.includes("search")
          ? "SCENARIO_SEARCH"
          : params.model.includes("research")
            ? "SCENARIO_RESEARCH"
            : params.model.includes("k1")
              ? "SCENARIO_K1"
              : "SCENARIO_K2",
      },
    );

    if (!result.ok) {
      throw new Error(`Kimi API 错误: ${result.error}`);
    }

    console.log(`[Kimi Web] API response: textLen=${result.text.length}`);

    const escaped = JSON.stringify(result.text);
    const sse = `data: {"text":${escaped}}\n\ndata: [DONE]\n\n`;
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    });
  }

  async close() {
    await releaseSharedBrowser();
    this.browser = null;
    this.page = null;
  }

  async discoverModels(): Promise<ModelDefinitionConfig[]> {
    return [
      {
        id: "moonshot-v1-128k",
        name: "Moonshot v1 128K",
        api: "kimi-web",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ] as ModelDefinitionConfig[];
  }
}
