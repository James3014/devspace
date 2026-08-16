import { isString, type JsonObject } from "./value-types.js";

function metadataString(meta: JsonObject | undefined): string | undefined {
  const value = meta?.["openai/session"];
  return isString(value) && value.length > 0 ? value : undefined;
}

export function openAiConversationScopeId(
  meta: JsonObject | undefined,
): string | undefined {
  return metadataString(meta);
}
