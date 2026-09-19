import assert from "node:assert/strict";
import test from "node:test";
import { createBoundLaunchdRestartActuator, createLaunchdSelfRestartActuator } from "./cutover-restart.js";

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


test("bound restart actuator requires the approved target to own the live pid", () => {
  assert.equal(
    createBoundLaunchdRestartActuator({
      platform: "darwin",
      uid: 501,
      livePid: 4321,
      serviceLabel: "com.example.devspace",
      launchdTarget: "gui/501/other.service",
      inspectLaunchdTarget: () => ({ status: 0, stdout: "pid = 4321\n" }),
    }),
    undefined,
  );
  assert.equal(
    createBoundLaunchdRestartActuator({
      platform: "darwin",
      uid: 501,
      livePid: 4321,
      serviceLabel: "com.example.devspace",
      launchdTarget: "gui/501/com.example.devspace",
      inspectLaunchdTarget: () => ({ status: 0, stdout: "pid = 9999\n" }),
    }),
    undefined,
  );
});

test("bound restart actuator rechecks pid before one exact kickstart", () => {
  let inspections = 0;
  const launches: Array<{ command: string; args: string[] }> = [];
  const actuator = createBoundLaunchdRestartActuator({
    platform: "darwin",
    uid: 501,
    livePid: 4321,
    serviceLabel: "com.example.devspace",
    launchdTarget: "gui/501/com.example.devspace",
    inspectLaunchdTarget: (command, args) => {
      inspections += 1;
      assert.equal(command, "/bin/launchctl");
      assert.deepEqual(args, ["print", "gui/501/com.example.devspace"]);
      return { status: 0, stdout: "pid = 4321\n" };
    },
    kickstart: (command, args) => {
      launches.push({ command, args });
      return { status: 0 };
    },
  });
  assert.ok(actuator);
  assert.deepEqual(actuator.schedule(), {
    scheduled: true,
    actuator: "launchd-self",
    serviceLabel: "com.example.devspace",
    launchdTarget: "gui/501/com.example.devspace",
  });
  assert.equal(inspections, 2);
  assert.deepEqual(launches, [{
    command: "/bin/launchctl",
    args: ["kickstart", "-k", "gui/501/com.example.devspace"],
  }]);
});

test("bound restart actuator fails closed when launchd pid changes after binding", () => {
  let inspections = 0;
  let launches = 0;
  const actuator = createBoundLaunchdRestartActuator({
    platform: "darwin",
    uid: 501,
    livePid: 4321,
    serviceLabel: "com.example.devspace",
    launchdTarget: "gui/501/com.example.devspace",
    inspectLaunchdTarget: () => {
      inspections += 1;
      return { status: 0, stdout: inspections === 1 ? "pid = 4321\n" : "pid = 9999\n" };
    },
    kickstart: () => {
      launches += 1;
      return { status: 0 };
    },
  });
  assert.ok(actuator);
  assert.throws(() => actuator.schedule(), /PID changed/i);
  assert.equal(launches, 0);
});
