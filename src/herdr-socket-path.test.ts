import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHerdrDefaultSocketPath } from "./local-agent-herdr.js";

assert.equal(
  resolveHerdrDefaultSocketPath({ HERDR_SOCKET_PATH: "/custom/herdr.sock", HOME: "/home/alice" }),
  "/custom/herdr.sock",
);

assert.equal(
  resolveHerdrDefaultSocketPath({ HERDR_SOCKET_PATH: "", HOME: "/home/alice" }),
  join("/home/alice", ".config", "herdr", "herdr.sock"),
);

assert.equal(
  resolveHerdrDefaultSocketPath({ HOME: "/home/alice" }),
  join("/home/alice", ".config", "herdr", "herdr.sock"),
);

assert.equal(
  resolveHerdrDefaultSocketPath({}),
  join(homedir(), ".config", "herdr", "herdr.sock"),
);
