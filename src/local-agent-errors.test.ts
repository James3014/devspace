import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentProviderFailureError,
  describeAgentProviderError,
  redactSensitiveText,
} from "./local-agent-errors.js";

const sentinel = "synthetic-secret-value-9f3a";
const input = [
  `Bearer ${sentinel}`,
  "Authorization: Basic dXNlcjpzZWNyZXQ=",
  `OPENAI_API_KEY=${sentinel}`,
  `access_token=${sentinel}`,
  `api key=${sentinel}`,
  `access token: ${sentinel}`,
  `{"client_secret":"${sentinel}"}`,
  `private key: ${sentinel}`,
  `private-key: ${sentinel}`,
  "ghp_synthetic-secret-value-9f3a",
  "sk-proj-ABCDEF12345",
].join(" | ");
const redacted = redactSensitiveText(input);
assert.equal(redacted.includes(sentinel), false);
assert.match(redacted, /Bearer \[REDACTED\]/);
assert.match(redacted, /Authorization=\[REDACTED\]/);
assert.match(redacted, /OPENAI_API_KEY=\[REDACTED\]/);
assert.match(redacted, /access_token=\[REDACTED\]/);
assert.match(redacted, /api key=\[REDACTED\]/);
assert.match(redacted, /access token=\[REDACTED\]/);
assert.match(redacted, /"client_secret":"\[REDACTED\]"/);
assert.match(redacted, /private key=\[REDACTED\]/);
assert.match(redacted, /private-key=\[REDACTED\]/);
assert.doesNotMatch(redacted, /dXNlcjpzZWNyZXQ|ghp_synthetic-secret-value-9f3a|sk-proj-ABCDEF12345/);
assert.equal(redactSensitiveText('TOKEN="alpha\\"beta"').includes('alpha'), false);
assert.equal(redactSensitiveText('PASSWORD="alpha beta').includes('alpha'), false);
const nested = redactSensitiveText(
  `{"wrapper":{"token":"${sentinel}"},"items":[{"password":"${sentinel}"}]}`,
);
assert.equal(nested.includes(sentinel), false);
assert.match(nested, /"token":"\[REDACTED\]"/);
assert.match(nested, /"password":"\[REDACTED\]"/);
assert.match(redactSensitiveText(`log says "token": "${sentinel}"`), /"token": "\[REDACTED\]"/);
assert.match(redactSensitiveText(`prefix! token=${sentinel}`), /prefix! token=\[REDACTED\]/);

const providerError = new AgentProviderFailureError({
  code: "PROVIDER_AUTH_ERROR",
  errorClass: "AUTH_FAILURE",
  provider: "opencode",
  operation: "run",
  retryable: false,
  providerMessage: `${"x".repeat(500)} token=${sentinel}`,
  message: "authentication failed",
});
const details = describeAgentProviderError(providerError);
assert.equal(details.providerMessage?.includes(sentinel), false);
assert.ok((details.providerMessage?.length ?? 0) > 400, "redaction precedes diagnostic truncation");

test("redaction stays bounded on long non-key input", { timeout: 3_000 }, () => {
  const input = `${"a- ".repeat(50_000)} token=${sentinel}`;
  const redacted = redactSensitiveText(input);
  assert.equal(redacted.includes(sentinel), false);
  assert.match(redacted, /token=\[REDACTED\]/);
});
