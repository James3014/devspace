import assert from "node:assert/strict";
import test from "node:test";
import { createLaunchdSelfRestartActuator } from "./cutover-restart.js";

test("self restart actuator is unavailable outside macOS launchd", () => {
  assert.equal(
    createLaunchdSelfRestartActuator({
      platform: "linux",
      env: { XPC_SERVICE_NAME: "com.example.devspace" },
      uid: 501,
    }),
    undefined,
  );
  assert.equal(
    createLaunchdSelfRestartActuator({
      platform: "darwin",
      env: {},
      uid: 501,
    }),
    undefined,
  );
  assert.equal(
    createLaunchdSelfRestartActuator({
      platform: "darwin",
      env: { XPC_SERVICE_NAME: "bad label;rm" },
      uid: 501,
    }),
    undefined,
  );
  assert.equal(
    createLaunchdSelfRestartActuator({
      platform: "darwin",
      env: { XPC_SERVICE_NAME: "0" },
      uid: 501,
    }),
    undefined,
  );
  assert.equal(
    createLaunchdSelfRestartActuator({
      platform: "darwin",
      env: { XPC_SERVICE_NAME: "com.example.devspace" },
      uid: 501,
      pid: 4321,
      inspectLaunchdTarget: () => ({ status: 0, stdout: "pid = 9999\n" }),
    }),
    undefined,
  );
});

test("self restart actuator schedules only the launchd-injected service label", () => {
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  const launches: Array<{ command: string; args: string[] }> = [];
  let unrefCount = 0;
  const actuator = createLaunchdSelfRestartActuator({
    platform: "darwin",
    env: { XPC_SERVICE_NAME: "com.example.devspace" },
    uid: 501,
    pid: 4321,
    delayMs: 321,
    inspectLaunchdTarget: (command, args) => {
      assert.equal(command, "/bin/launchctl");
      assert.deepEqual(args, ["print", "gui/501/com.example.devspace"]);
      return { status: 0, stdout: "\tpid = 4321\n" };
    },
    schedule: (scheduled, delayMs) => {
      callback = scheduled;
      delay = delayMs;
      return { unref: () => { unrefCount += 1; } };
    },
    spawnDetached: (command, args) => launches.push({ command, args }),
  });

  assert.ok(actuator);
  assert.equal(actuator.serviceLabel, "com.example.devspace");
  assert.equal(actuator.launchdTarget, "gui/501/com.example.devspace");
  assert.deepEqual(actuator.schedule(), {
    scheduled: true,
    actuator: "launchd-self",
    serviceLabel: "com.example.devspace",
    launchdTarget: "gui/501/com.example.devspace",
  });
  assert.equal(delay, 321);
  assert.equal(unrefCount, 1);
  assert.deepEqual(launches, []);

  callback?.();
  assert.deepEqual(launches, [{
    command: "/bin/launchctl",
    args: ["kickstart", "-k", "gui/501/com.example.devspace"],
  }]);
});
