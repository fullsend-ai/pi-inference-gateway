// Validation of user `compat` overrides against pi-ai's compat types.
//
// A wrong-typed compat value is not harmless: pi trusts its compat fields, and for example a string
// `allowedFallbackModels` makes the Anthropic transport throw `.map is not a function` before any
// request is sent. So every key pi declares for a transport is checked against its declared type,
// and wrong-typed values are dropped. Keys pi does not declare pass through unchanged, because a
// newer pi may have added them.
//
// The tables are checked against pi's interfaces with `satisfies`: a key that is misspelt here, or
// that pi removes, fails `npm run lint` on that pi version — the cue to update this file.

import type { AnthropicMessagesCompat, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { CompatOverride, GatewayApi } from "./config.ts";

type Flag = boolean | string | number;
type Check = (value: Flag) => boolean;

const bool: Check = (value) => typeof value === "boolean";
const finite: Check = (value) => typeof value === "number" && Number.isFinite(value);
const oneOf =
  (values: readonly string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);
/** Arrays and records in pi's types: not expressible as a JSON-primitive config flag. */
const structured: Check = () => false;

const OPENAI_SESSION_AFFINITY = ["openai", "openai-nosession", "openrouter"] as const satisfies readonly NonNullable<
  OpenAIResponsesCompat["sessionAffinityFormat"]
>[];
const ANTHROPIC_SESSION_AFFINITY = ["openrouter"] as const satisfies readonly NonNullable<
  AnthropicMessagesCompat["sessionAffinityFormat"]
>[];
const MAX_TOKENS_FIELDS = ["max_completion_tokens", "max_tokens"] as const satisfies readonly NonNullable<
  OpenAICompletionsCompat["maxTokensField"]
>[];
const THINKING_FORMATS = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "baseten",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
] as const satisfies readonly NonNullable<OpenAICompletionsCompat["thinkingFormat"]>[];
const THINKING_BUDGET_FIELDS = ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"] as const satisfies readonly NonNullable<
  OpenAICompletionsCompat["thinkingTokenBudgetField"]
>[];
const CACHE_CONTROL_FORMATS = ["anthropic"] as const satisfies readonly NonNullable<OpenAICompletionsCompat["cacheControlFormat"]>[];

const ANTHROPIC_FIELDS: Readonly<Record<string, Check>> = {
  supportsEagerToolInputStreaming: bool,
  supportsLongCacheRetention: bool,
  sendSessionAffinityHeaders: bool,
  sessionAffinityFormat: oneOf(ANTHROPIC_SESSION_AFFINITY),
  supportsCacheControlOnTools: bool,
  supportsTemperature: bool,
  forceAdaptiveThinking: bool,
  allowEmptySignature: bool,
  supportsStrictTools: bool,
  supportsMidConvoEffort: bool,
  supportsMidConvoSystemMessages: bool,
  supportsMidConvoToolChanges: bool,
  allowedFallbackModels: structured,
} satisfies { [K in keyof AnthropicMessagesCompat]?: Check };

const RESPONSES_FIELDS: Readonly<Record<string, Check>> = {
  supportsDeveloperRole: bool,
  supportsMidConvoSystemMessages: bool,
  sessionAffinityFormat: oneOf(OPENAI_SESSION_AFFINITY),
  supportsLongCacheRetention: bool,
  supportsStrictMode: bool,
  supportsOpenAIGrammarTools: bool,
  supportsAdditionalTools: bool,
  supportsToolSearch: bool,
  supportsExplicitPromptCacheMode: bool,
  supportsMaxOutputTokens: bool,
} satisfies { [K in keyof OpenAIResponsesCompat]?: Check };

const COMPLETIONS_FIELDS: Readonly<Record<string, Check>> = {
  supportsStore: bool,
  supportsDeveloperRole: bool,
  supportsReasoningEffort: bool,
  supportsUsageInStreaming: bool,
  supportsFinishReason: bool,
  maxTokensField: oneOf(MAX_TOKENS_FIELDS),
  requiresToolResultName: bool,
  requiresAssistantAfterToolResult: bool,
  requiresThinkingAsText: bool,
  requiresReasoningContentOnAssistantMessages: bool,
  thinkingFormat: oneOf(THINKING_FORMATS),
  chatTemplateKwargs: structured,
  chatTemplateArgs: structured,
  openRouterRouting: structured,
  vercelGatewayRouting: structured,
  zaiToolStream: bool,
  thinkingTokenBudgetField: oneOf(THINKING_BUDGET_FIELDS),
  supportsThinkingTokenBudget: bool,
  supportsOpenAIGrammarTools: bool,
  supportsMidConvoSystemMessages: bool,
  supportsMidConvoToolAdditions: bool,
  supportsStrictMode: bool,
  cacheControlFormat: oneOf(CACHE_CONTROL_FORMATS),
  sendSessionAffinityHeaders: bool,
  sessionAffinityFormat: oneOf(OPENAI_SESSION_AFFINITY),
  supportsLongCacheRetention: bool,
  vllmPriority: finite,
} satisfies { [K in keyof OpenAICompletionsCompat]?: Check };

const FIELDS: Readonly<Record<GatewayApi, Readonly<Record<string, Check>>>> = {
  "anthropic-messages": ANTHROPIC_FIELDS,
  "openai-responses": RESPONSES_FIELDS,
  "openai-completions": COMPLETIONS_FIELDS,
};

const ALL_APIS: readonly GatewayApi[] = ["anthropic-messages", "openai-responses", "openai-completions"];

export interface CompatValidation {
  kept: CompatOverride;
  /** One line per dropped key; values are flags, never credentials. */
  problems: string[];
}

/**
 * Check a user compat override. With an `api`, known keys must match that transport's type; without
 * one (the transport is decided later), a known key is kept when any transport that declares it
 * accepts the value — buildModel re-checks against the final transport. `allowedFallbackModels` is
 * always refused: it is a list of model ids, not a flag, and the gateway does its own routing (see
 * anthropicCompat in discovery.ts).
 */
export function validateCompat(override: CompatOverride, api?: GatewayApi): CompatValidation {
  const kept: Array<[string, Flag]> = [];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(override)) {
    if (key === "allowedFallbackModels") {
      problems.push(`compat.allowedFallbackModels is not supported (a list of model ids sent as a \`fallbacks\` request field; the gateway routes models itself); ignored`);
      continue;
    }
    const checks = (api ? [api] : ALL_APIS)
      .map((target) => (Object.hasOwn(FIELDS[target], key) ? FIELDS[target][key] : undefined))
      .filter((check): check is Check => check !== undefined);
    if (checks.length === 0 || checks.some((check) => check(value))) {
      kept.push([key, value]);
      continue;
    }
    problems.push(`compat.${key}: ${JSON.stringify(value)} does not match pi's type for this field${api ? ` on ${api}` : ""}; ignored`);
  }
  return { kept: Object.fromEntries(kept), problems };
}
