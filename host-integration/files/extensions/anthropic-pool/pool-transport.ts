import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AnthropicStreamSimpleDelegate } from "./host-transport.js";
import type { AccountPoolStore } from "./pool-store.js";
import { shapeAnthropicOAuthPayload } from "./request-shaping.js";
import { modelIdToDisplayName } from "./usage-tracker.js";

function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("usage limit") ||
    lower.includes("extra usage") ||
    lower.includes("quota exceeded") ||
    lower.includes("too many requests") ||
    lower.includes("overloaded_error") ||
    lower.includes("usage limit reached")
  );
}

export function createPoolStreamSimple(
  delegate: AnthropicStreamSimpleDelegate,
  pool: AccountPoolStore,
) {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const callerOnPayload = options?.onPayload;

    // If options.apiKey is provided and is NOT an oauth token (e.g. standard sk-ant-api key),
    // pass through directly without rotation
    if (
      options?.apiKey &&
      !options.apiKey.includes("sk-ant-oat") &&
      pool.getAccounts().length === 0
    ) {
      return delegate(model as Model<"anthropic-messages">, context, options);
    }

    const outputStream = createAssistantMessageEventStream();

    void (async () => {
      const accounts = pool.getAccounts();
      if (accounts.length === 0) {
        // Fall back to standard delegate
        try {
          const stream = delegate(
            model as Model<"anthropic-messages">,
            context,
            options,
          );
          for await (const event of stream) {
            outputStream.push(event);
          }
        } catch (err) {
          outputStream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "error",
              errorMessage: err instanceof Error ? err.message : String(err),
              timestamp: Date.now(),
            },
          });
        }
        outputStream.end();
        return;
      }

      let attempts = 0;
      const maxAttempts = Math.max(accounts.length, 1);
      let success = false;

      while (attempts < maxAttempts && !success) {
        attempts++;
        const currentAccount = await pool.getOrRotateValidAccount(modelIdToDisplayName(model.id));
        if (!currentAccount) {
          break;
        }

        const apiKey = currentAccount.credentials.access;

        const onPayload: SimpleStreamOptions["onPayload"] = async (
          payload: unknown,
          payloadModel: unknown,
        ) => {
          const upstream = callerOnPayload
            ? ((await callerOnPayload(payload, payloadModel as Model<Api>)) ?? payload)
            : payload;
          return shapeAnthropicOAuthPayload(upstream);
        };

        const attemptOptions: SimpleStreamOptions = {
          ...options,
          apiKey,
          onPayload,
        };

        try {
          const underlyingStream = delegate(
            model as Model<"anthropic-messages">,
            context,
            attemptOptions,
          );

          let hasEmittedTokens = false;
          let hadRateLimit = false;

          for await (const event of underlyingStream) {
            if (
              event.type === "text_delta" ||
              event.type === "thinking_delta" ||
              event.type === "toolcall_delta"
            ) {
              hasEmittedTokens = true;
            }

            if (event.type === "error") {
              const errMsg = event.error.errorMessage || "";
              if (isRateLimitError(errMsg) && !hasEmittedTokens && attempts < maxAttempts) {
                console.warn(
                  `[Claude Pool] ${currentAccount.name} hit rate limit / usage cap (${errMsg}). Rotating to next account...`,
                );
                pool.markRateLimited(currentAccount.id, undefined, errMsg);
                hadRateLimit = true;
                break; // Break stream iteration to try next account in while loop
              }
              // Normal error or mid-stream error
              outputStream.push(event);
              pool.recordError(currentAccount.id);
              success = true;
              break;
            }

            // Forward event
            outputStream.push(event);

            if (event.type === "done") {
              pool.recordSuccess(currentAccount.id);
              success = true;
            }
          }

          if (hadRateLimit) {
            // continue while loop to next account
            continue;
          }

          if (success) {
            outputStream.end();
            return;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (isRateLimitError(errMsg) && attempts < maxAttempts) {
            console.warn(
              `[Claude Pool] ${currentAccount.name} error: ${errMsg}. Rotating to next account...`,
            );
            pool.markRateLimited(currentAccount.id, undefined, errMsg);
            continue;
          }

          pool.recordError(currentAccount.id);
          outputStream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "error",
              errorMessage: errMsg,
              timestamp: Date.now(),
            },
          });
          outputStream.end();
          return;
        }
      }

      // If we exhausted all accounts
      if (!success) {
        outputStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error",
            errorMessage:
              "All Claude accounts in the pool are currently rate limited or unavailable.",
            timestamp: Date.now(),
          },
        });
      }

      outputStream.end();
    })();

    return outputStream;
  };
}
