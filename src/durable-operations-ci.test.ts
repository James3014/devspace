// This test suite verifies durable operation semantics, not Git's platform EOL
// conversion policy. Keep Git's logical text checkout stable within this test
// process only; child git commands inherit these process-scoped config values.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
process.env.GIT_CONFIG_VALUE_0 = "false";

await import("./durable-operations.test.js");
