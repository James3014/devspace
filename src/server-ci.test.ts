process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "init.defaultBranch";
process.env.GIT_CONFIG_VALUE_0 = "main";

await import("./server.test.js");
