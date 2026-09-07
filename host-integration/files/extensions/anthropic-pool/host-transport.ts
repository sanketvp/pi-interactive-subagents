import type {
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai";

export type AnthropicStreamSimpleDelegate = StreamFunction<
  "anthropic-messages",
  SimpleStreamOptions
>;

export type PiAiNamespace = Record<string, unknown>;

type AnthropicMessagesApi = () => { streamSimple?: unknown };

export function pickAnthropicStreamSimple(
  namespace: PiAiNamespace,
): AnthropicStreamSimpleDelegate {
  const factory = namespace.anthropicMessagesApi;
  if (typeof factory === "function") {
    const transport = (factory as AnthropicMessagesApi)().streamSimple;
    if (typeof transport === "function") {
      return transport as AnthropicStreamSimpleDelegate;
    }
  }

  throw new Error(
    "Could not resolve built-in Anthropic streamSimple transport: " +
      "@earendil-works/pi-ai/compat exported no callable " +
      "`anthropicMessagesApi` factory returning a `streamSimple` function.",
  );
}

export async function resolveBuiltinAnthropicStreamSimple(): Promise<AnthropicStreamSimpleDelegate> {
  const namespace = (await import(
    "@earendil-works/pi-ai/compat"
  )) as PiAiNamespace;
  return pickAnthropicStreamSimple(namespace);
}
