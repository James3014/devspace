import assert from "node:assert/strict";
import test from "node:test";
import { ChatSwarmIdentityError, openAiConversationScopeId, resolveChatSwarmIdentity } from "./request-meta.js";

test("undefined request metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId(undefined), undefined);
});

test("missing session metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({}), undefined);
});

test("an empty session string has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": "" }), undefined);
});

test("a non-string session value has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": 42 }), undefined);
  assert.equal(openAiConversationScopeId({ "openai/session": {} }), undefined);
});

test("valid OpenAI session metadata returns the raw opaque session value", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": "chat-session-opaque-value" }), "chat-session-opaque-value");
});

test("unrelated metadata fields do not alter the selected conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": "chat-session-opaque-value", "openai/subject": "user-1", "openai/organization": "org-1" }), "chat-session-opaque-value");
});

test("swarm identity accepts allowlisted keys and stores only a fingerprint", () => {
  const evidence = resolveChatSwarmIdentity({ "openai/conversation_id": "conversation-1" });
  assert.equal(evidence.source, "openai/conversation_id");
  assert.match(evidence.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(evidence.fingerprint.includes("conversation-1"), false);
});

test("same identity aliases are accepted but conflicting or transport-only metadata fails closed", () => {
  assert.equal(resolveChatSwarmIdentity({ "openai/session": "same", "chatgpt/session": "same" }).fingerprint, resolveChatSwarmIdentity({ "openai/session": "same" }).fingerprint);
  assert.throws(() => resolveChatSwarmIdentity({ "openai/session": "a", "openai/conversationId": "b" }), (error: unknown) => error instanceof ChatSwarmIdentityError && error.code === "AMBIGUOUS");
  assert.throws(() => resolveChatSwarmIdentity({ "mcp/session": "transport-only" }), (error: unknown) => error instanceof ChatSwarmIdentityError && error.code === "MISSING");
});
