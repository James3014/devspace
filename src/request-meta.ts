function metadataString(
  meta: unknown,
  key: string,
): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

import { createHash } from "node:crypto";

export const CHAT_SWARM_IDENTITY_KEYS = [
  "openai/session",
  "openai/conversation_id",
  "openai/conversationId",
  "chatgpt/session",
] as const;

export interface ChatSwarmIdentityEvidence {
  source: (typeof CHAT_SWARM_IDENTITY_KEYS)[number];
  fingerprint: string;
}

export class ChatSwarmIdentityError extends Error {
  constructor(readonly code: "MISSING" | "AMBIGUOUS" | "MALFORMED", message: string) {
    super(message);
    this.name = "ChatSwarmIdentityError";
  }
}

export function resolveChatSwarmIdentity(meta: unknown): ChatSwarmIdentityEvidence {
  if (typeof meta !== "object" || meta === null) throw new ChatSwarmIdentityError("MISSING", "ChatGPT conversation identity evidence is required");
  const values: Array<{ source: (typeof CHAT_SWARM_IDENTITY_KEYS)[number]; value: string }> = [];
  for (const key of CHAT_SWARM_IDENTITY_KEYS) {
    if (!(key in (meta as Record<string, unknown>))) continue;
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.trim().length === 0) throw new ChatSwarmIdentityError("MALFORMED", `identity evidence '${key}' is malformed`);
    values.push({ source: key, value });
  }
  if (values.length === 0) throw new ChatSwarmIdentityError("MISSING", "no allowlisted ChatGPT conversation identity evidence was provided");
  const fingerprints = new Set(values.map(({ value }) => createHash("sha256").update(value).digest("hex")));
  if (fingerprints.size !== 1) throw new ChatSwarmIdentityError("AMBIGUOUS", "allowlisted conversation identity evidence conflicts");
  return { source: values[0]!.source, fingerprint: [...fingerprints][0]! };
}

export function openAiConversationScopeId(
  meta: unknown,
): string | undefined {
  return metadataString(meta, "openai/session");
}
