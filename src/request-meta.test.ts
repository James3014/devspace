import assert from "node:assert/strict";
import test from "node:test";
import { openAiConversationScopeId } from "./request-meta.js";

test("OpenAI session metadata supplies the opaque conversation scope", () => {
  assert.equal(
    openAiConversationScopeId({
      "openai/session": "chat-1",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    "chat-1",
  );
});

test("missing or empty OpenAI session metadata has no conversation scope", () => {
  assert.deepEqual(
    [
      openAiConversationScopeId(undefined),
      openAiConversationScopeId({}),
      openAiConversationScopeId({ "openai/session": "" }),
    ],
    [undefined, undefined, undefined],
  );
});
