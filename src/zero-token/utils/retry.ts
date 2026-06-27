/**
 * Retry wrapper for API calls with exponential backoff.
 * Does NOT retry authentication errors (401/403/登录已过期).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelay = opts.delayMs ?? 1500;
  const label = opts.label ?? "API";

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Never retry auth errors — user needs to re-login
      const msg = lastError.message;
      if (
        msg.includes("登录已过期") ||
        msg.includes("Authentication failed") ||
        msg.includes("re-run onboarding") ||
        /\b(401|403)\b/.test(msg)
      ) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = baseDelay * (attempt + 1);
        console.log(
          `[zero-token] ${label} retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${msg.slice(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}
