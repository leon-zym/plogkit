import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import {
  captureIosHostSnapshot,
  createIosObservationRecorder,
  summarizeIosMaestroArtifacts,
} from "./ios-observation.mjs";

function readSnapshot(directory) {
  return JSON.parse(readFileSync(join(directory, "ios-observation.json"), "utf8"));
}

test("iOS observations atomically retain monotonic stage timing without primary details", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-");
  const wallClock = [1000, 1000, 1125];
  const monotonicClock = [0, 25, 150];
  const recorder = createIosObservationRecorder({
    directory,
    environment: {
      E2E_IOS_RUNNER_LABEL: "macos-26",
      GITHUB_JOB: "ios-maestro",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "12345",
      GITHUB_SHA: "432fa49df8c7e3c234c6af3025a89a32267adc5e",
      ImageVersion: "20260728.0273.1",
    },
    monotonicNow: () => monotonicClock.shift(),
    now: () => wallClock.shift(),
  });
  const primary = Object.assign(
    new Error("Command timed out: /Users/runner/work/private --url http://127.0.0.1:4111/token"),
    { code: "E2E_COMMAND_TIMEOUT", e2eStage: "ios-fixture-addmedia" },
  );

  await assert.rejects(
    recorder.run("ios-fixture-addmedia", async () => {
      throw primary;
    }),
    (error) => error === primary,
  );
  await recorder.finish("failed", primary);

  const snapshot = readSnapshot(directory);
  assert.deepEqual(snapshot, {
    completeness: {
      execution: true,
      maestro: null,
      recorder: true,
      telemetry: true,
    },
    events: [
      {
        elapsedMs: 25,
        event: "stage-started",
        sequence: 1,
        stage: "ios-fixture-addmedia",
        timestampMs: 1000,
      },
      {
        durationMs: 125,
        elapsedMs: 150,
        error: { code: "E2E_COMMAND_TIMEOUT", name: "Error" },
        event: "stage-finished",
        sequence: 2,
        stage: "ios-fixture-addmedia",
        status: "failed",
        timestampMs: 1125,
      },
    ],
    limits: {
      events: 128,
      hostProbeTimeoutMs: 2000,
      hostSampleIntervalMs: 30_000,
      hostSamples: 24,
      snapshotBytes: 262_144,
    },
    outcome: {
      error: { code: "E2E_COMMAND_TIMEOUT", name: "Error" },
      status: "failed",
    },
    run: {
      attempt: 2,
      id: 12345,
      imageVersion: "20260728.0273.1",
      job: "ios-maestro",
      mode: "full",
      runner: "macos-26",
      sha: "432fa49df8c7e3c234c6af3025a89a32267adc5e",
    },
    schemaVersion: 2,
    startedAtMs: 1000,
  });
  const published = readFileSync(join(directory, "ios-observation.json"), "utf8");
  assert.doesNotMatch(published, /Users|127\.0\.0\.1|private|token|Command timed out/);
  assert.deepEqual(readdirSync(directory), ["ios-observation.json"]);
});

test("iOS observations reject runner labels unavailable to this workflow", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-runner-");
  createIosObservationRecorder({
    directory,
    environment: {
      E2E_IOS_RUNNER_LABEL: "macos-26-xlarge",
      GITHUB_JOB: "ios-maestro",
    },
  });

  assert.equal(readSnapshot(directory).run.runner, null);
});

test("iOS observations distinguish the Intel same-host and fresh-host experiment jobs", (t) => {
  for (const job of ["ios-isolation-control", "ios-isolation-fresh-host"]) {
    const directory = createTemporaryTestDirectory(t, `plogkit-ios-observation-${job}-`);
    createIosObservationRecorder({
      directory,
      environment: {
        E2E_IOS_RUNNER_LABEL: "macos-26-intel",
        GITHUB_JOB: job,
      },
    });

    assert.equal(readSnapshot(directory).run.runner, "macos-26-intel");
    assert.equal(readSnapshot(directory).run.job, job);
  }
});

test("iOS observations keep only bounded numeric host evidence", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-host-observation-");
  const recorder = createIosObservationRecorder({
    captureHostSnapshot: async () => ({
      complete: true,
      cpuCount: 3,
      diskAvailableBytes: 12_345,
      loadAverage: [1.25, 2.5, 3.75],
      memoryFreeBytes: 456,
      memoryPressureFreePercent: 63,
      memoryTotalBytes: 789,
      processes: [
        {
          count: 1,
          cpuPercent: 31.5,
          executable: "CoreSimulatorService",
          family: "core-simulator",
          maxCpuPercent: 31.5,
          maxRssBytes: 1024,
          rssBytes: 1024,
        },
        {
          count: 1,
          cpuPercent: 8,
          executable: "assetsd",
          family: "photo-services",
          maxCpuPercent: 8,
          maxRssBytes: 2048,
          rssBytes: 2048,
        },
      ],
      swapUsedBytes: 64,
    }),
    directory,
    environment: {},
    monotonicNow: () => 200,
    now: () => 2000,
  });

  await recorder.run(
    "ios-release-build",
    () => new Promise((resolvePromise) => setImmediate(resolvePromise)),
  );
  await recorder.finish("passed");

  assert.deepEqual(
    readSnapshot(directory).hostSamples.map(({ host, reason, stage }) => ({
      host,
      reason,
      stage,
    })),
    [
      {
        host: {
          complete: true,
          cpuCount: 3,
          diskAvailableBytes: 12_345,
          loadAverage: [1.25, 2.5, 3.75],
          memoryFreeBytes: 456,
          memoryPressureFreePercent: 63,
          memoryTotalBytes: 789,
          processes: [
            {
              count: 1,
              cpuPercent: 31.5,
              executable: "CoreSimulatorService",
              family: "core-simulator",
              maxCpuPercent: 31.5,
              maxRssBytes: 1024,
              rssBytes: 1024,
            },
            {
              count: 1,
              cpuPercent: 8,
              executable: "assetsd",
              family: "photo-services",
              maxCpuPercent: 8,
              maxRssBytes: 2048,
              rssBytes: 2048,
            },
          ],
          swapUsedBytes: 64,
        },
        reason: "job-start",
        stage: "ios-release-build",
      },
      {
        host: {
          complete: true,
          cpuCount: 3,
          diskAvailableBytes: 12_345,
          loadAverage: [1.25, 2.5, 3.75],
          memoryFreeBytes: 456,
          memoryPressureFreePercent: 63,
          memoryTotalBytes: 789,
          processes: [
            {
              count: 1,
              cpuPercent: 31.5,
              executable: "CoreSimulatorService",
              family: "core-simulator",
              maxCpuPercent: 31.5,
              maxRssBytes: 1024,
              rssBytes: 1024,
            },
            {
              count: 1,
              cpuPercent: 8,
              executable: "assetsd",
              family: "photo-services",
              maxCpuPercent: 8,
              maxRssBytes: 2048,
              rssBytes: 2048,
            },
          ],
          swapUsedBytes: 64,
        },
        reason: "build-finished",
        stage: "ios-release-build",
      },
    ],
  );
});

test("observation capture and persistence failures never replace the E2E result", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-failure-");
  let writes = 0;
  const recorder = createIosObservationRecorder({
    captureHostSnapshot: async () => {
      throw Object.assign(new Error("/Users/runner/private host failure"), {
        code: "HOST_PROBE_FAILED",
      });
    },
    directory,
    environment: {},
    monotonicNow: () => 300,
    now: () => 3000,
    writeSnapshot: ({ body, path, writeDefault }) => {
      writes += 1;
      if (writes === 2) throw Object.assign(new Error("write failed"), { code: "ENOSPC" });
      return writeDefault(path, body);
    },
  });

  const value = await recorder.run("ios-device-create", async () => "kept");
  await recorder.finish("passed");

  assert.equal(value, "kept");
  const snapshot = readSnapshot(directory);
  assert.equal(snapshot.completeness.execution, true);
  assert.equal(snapshot.completeness.recorder, false);
  assert.equal(snapshot.completeness.telemetry, false);
  assert.deepEqual(snapshot.observationErrors, [
    {
      code: "ENOSPC",
      dimension: "recorder",
      name: "Error",
      operation: "snapshot-write",
    },
    { dimension: "telemetry", name: "Error", operation: "host-capture" },
  ]);
  const published = readFileSync(join(directory, "ios-observation.json"), "utf8");
  assert.doesNotMatch(published, /Users|private host failure|write failed/);
});

test("unknown observation stages cannot change the acceptance result", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-stage-");
  const recorder = createIosObservationRecorder({ directory, environment: {} });
  const result = await recorder.run("arbitrary-user-value", async () => "kept");

  assert.equal(result, "kept");
  assert.deepEqual(readSnapshot(directory).observationErrors, [
    {
      code: "E2E_OBSERVATION_STAGE_INVALID",
      dimension: "recorder",
      name: "Error",
      operation: "stage",
    },
  ]);
});

test("host snapshots summarize pressure and relevant processes without retaining paths", async () => {
  const commands = [];
  const snapshot = await captureIosHostSnapshot({
    availableMemory: () => 6_000,
    captureCommand: async (command, args) => {
      commands.push([command, ...args].join(" "));
      if (command === "/usr/bin/memory_pressure") {
        return "System-wide memory free percentage: 42%\n";
      }
      if (command === "/usr/sbin/sysctl") {
        return "total = 2048.00M  used = 256.50M  free = 1791.50M  (encrypted)\n";
      }
      return [
        "  100 31.5 1024 /Library/Private/CoreSimulatorService",
        "  101 8.0 2048 /Users/runner/private/assetsd",
        "  103 7.0 4096 /Library/Private/CoreSimulatorBridge",
        "  104 6.0 1024 /Library/Private/SpringBoard",
        "  105 5.0 1024 /Library/Private/backboardd",
        "  102 99.0 9999 /Users/runner/private/unrelated-secret",
      ].join("\n");
    },
    cpuCount: () => 3,
    diskAvailable: () => 12_345,
    loadAverage: () => [1.25, 2.5, 3.75],
    totalMemory: () => 7_000,
  });

  assert.deepEqual(commands, [
    "/usr/bin/memory_pressure -Q",
    "/usr/sbin/sysctl -n vm.swapusage",
    "/bin/ps -axo pid=,pcpu=,rss=,comm=",
  ]);
  assert.deepEqual(snapshot, {
    complete: true,
    cpuCount: 3,
    diskAvailableBytes: 12_345,
    errors: [],
    loadAverage: [1.25, 2.5, 3.75],
    memoryFreeBytes: 6_000,
    memoryPressureFreePercent: 42,
    memoryTotalBytes: 7_000,
    processes: [
      {
        count: 1,
        cpuPercent: 31.5,
        executable: "CoreSimulatorService",
        family: "core-simulator",
        maxCpuPercent: 31.5,
        maxRssBytes: 1_048_576,
        rssBytes: 1_048_576,
      },
      {
        count: 1,
        cpuPercent: 8,
        executable: "assetsd",
        family: "photo-services",
        maxCpuPercent: 8,
        maxRssBytes: 2_097_152,
        rssBytes: 2_097_152,
      },
      {
        count: 1,
        cpuPercent: 7,
        executable: "CoreSimulatorBridge",
        family: "core-simulator",
        maxCpuPercent: 7,
        maxRssBytes: 4_194_304,
        rssBytes: 4_194_304,
      },
      {
        count: 1,
        cpuPercent: 6,
        executable: "SpringBoard",
        family: "guest-ui",
        maxCpuPercent: 6,
        maxRssBytes: 1_048_576,
        rssBytes: 1_048_576,
      },
      {
        count: 1,
        cpuPercent: 5,
        executable: "backboardd",
        family: "guest-ui",
        maxCpuPercent: 5,
        maxRssBytes: 1_048_576,
        rssBytes: 1_048_576,
      },
    ],
    swapUsedBytes: 268_959_744,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /Users|Library|private|unrelated-secret/);
});

test("host snapshots explicitly mark missing or unrecognized metrics", async () => {
  const snapshot = await captureIosHostSnapshot({
    availableMemory: () => 100,
    captureCommand: async (command) => {
      if (command === "/usr/bin/memory_pressure") {
        throw Object.assign(new Error("private output"), { code: "E2E_COMMAND_TIMEOUT" });
      }
      if (command === "/usr/sbin/sysctl") return "invalid swap output";
      return "";
    },
    cpuCount: () => 3,
    diskAvailable: () => 200,
    loadAverage: () => [0, 0, 0],
    totalMemory: () => 300,
  });

  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.memoryPressureFreePercent, null);
  assert.equal(snapshot.swapUsedBytes, null);
  assert.deepEqual(
    snapshot.errors.map(({ metric }) => metric),
    ["memory-pressure", "swap", "processes"],
  );
});

test("telemetry gaps do not make a completed E2E execution structurally incomplete", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-completeness-");
  const recorder = createIosObservationRecorder({
    captureHostSnapshot: async () => ({
      complete: false,
      cpuCount: 3,
      diskAvailableBytes: 1,
      errors: [],
      loadAverage: [0, 0, 0],
      memoryFreeBytes: 1,
      memoryPressureFreePercent: null,
      memoryTotalBytes: 1,
      processes: [],
      swapUsedBytes: 0,
    }),
    directory,
    environment: {},
  });

  await recorder.run("ios-device-create", async () => {});
  await recorder.finish("passed");

  const snapshot = readSnapshot(directory);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal("complete" in snapshot, false);
  assert.deepEqual(snapshot.completeness, {
    execution: true,
    maestro: null,
    recorder: true,
    telemetry: false,
  });
});

test("preparation host sampling does not delay the operation it observes", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-nonblocking-");
  let operationStarted = false;
  let releaseCapture;
  let captures = 0;
  const hostSnapshot = {
    complete: true,
    cpuCount: 3,
    diskAvailableBytes: 1,
    loadAverage: [0, 0, 0],
    memoryFreeBytes: 1,
    memoryPressureFreePercent: 100,
    memoryTotalBytes: 1,
    processes: [],
    swapUsedBytes: 0,
  };
  const recorder = createIosObservationRecorder({
    captureHostSnapshot: () => {
      captures += 1;
      if (captures > 1) return Promise.resolve(hostSnapshot);
      return new Promise((resolvePromise) => {
        releaseCapture = () => resolvePromise(hostSnapshot);
      });
    },
    directory,
    environment: {},
  });

  const stage = recorder.run("ios-device-create", async () => {
    operationStarted = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(operationStarted, true);
  releaseCapture();
  await stage;
  await recorder.finish("passed");
});

test("a pending first host sample is not requested again by the next stage", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-first-sample-");
  let captures = 0;
  let releaseCapture;
  const hostSnapshot = {
    complete: true,
    cpuCount: 3,
    diskAvailableBytes: 1,
    loadAverage: [0, 0, 0],
    memoryFreeBytes: 1,
    memoryPressureFreePercent: 100,
    memoryTotalBytes: 1,
    processes: [],
    swapUsedBytes: 0,
  };
  const recorder = createIosObservationRecorder({
    captureHostSnapshot: () => {
      captures += 1;
      return new Promise((resolvePromise) => {
        releaseCapture = () => resolvePromise(hostSnapshot);
      });
    },
    directory,
    environment: {},
  });

  await recorder.run("ios-simulator-environment", async () => {});
  await recorder.run("ios-release-build", async () => {});
  assert.equal(captures, 1);
  assert.deepEqual(readSnapshot(directory).omissions, {
    overlaps: [{ reason: "build-start" }, { reason: "build-finished" }],
  });
  releaseCapture();
  await recorder.finish("passed");

  const snapshot = readSnapshot(directory);
  assert.equal(snapshot.hostSamples[0].reason, "job-start");
  assert.equal(snapshot.completeness.telemetry, false);
});

test("the host sampler is non-overlapping, fixed-rate, and stops before Maestro", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-sampler-");
  const scheduled = [];
  const cancelled = [];
  let captures = 0;
  let capturesInsideMaestro = null;
  const recorder = createIosObservationRecorder({
    cancelTimer: (token) => cancelled.push(token),
    captureHostSnapshot: async () => {
      captures += 1;
      return {
        complete: true,
        cpuCount: 3,
        diskAvailableBytes: 1,
        loadAverage: [0, 0, 0],
        memoryFreeBytes: 1,
        memoryPressureFreePercent: 100,
        memoryTotalBytes: 1,
        processes: [],
        swapUsedBytes: 0,
      };
    },
    directory,
    environment: {},
    scheduleTimer: (callback, delayMs) => {
      const token = { callback, delayMs, unref() {} };
      scheduled.push(token);
      return token;
    },
  });

  await recorder.run("ios-device-create", async () => {});
  assert.equal(captures, 1);
  assert.equal(scheduled[0].delayMs, 30_000);
  await scheduled[0].callback();
  assert.equal(captures, 2);

  await recorder.run("ios-maestro-suite", async () => {
    capturesInsideMaestro = captures;
  });
  await recorder.finish("passed");

  assert.equal(captures, 4);
  assert.equal(capturesInsideMaestro, 3);
  assert.equal(cancelled.length, 1);
  assert.deepEqual(
    readSnapshot(directory).hostSamples.map(({ reason }) => reason),
    ["job-start", "interval", "pre-maestro", "maestro-finished"],
  );
});

test("an asynchronous host sample retains the stage active when capture began", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-stage-race-");
  const scheduled = [];
  let releaseCapture;
  let captureCount = 0;
  const recorder = createIosObservationRecorder({
    captureHostSnapshot: async () => {
      captureCount += 1;
      if (captureCount === 2)
        await new Promise((resolvePromise) => (releaseCapture = resolvePromise));
      return {
        complete: true,
        cpuCount: 3,
        diskAvailableBytes: 1,
        loadAverage: [0, 0, 0],
        memoryFreeBytes: 1,
        memoryPressureFreePercent: 100,
        memoryTotalBytes: 1,
        processes: [],
        swapUsedBytes: 0,
      };
    },
    directory,
    environment: {},
    scheduleTimer: (callback) => {
      const token = { callback, unref() {} };
      scheduled.push(token);
      return token;
    },
  });

  await recorder.run("ios-device-create", async () => {});
  const pendingSample = scheduled[0].callback();
  while (!releaseCapture) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  let maestroStarted = false;
  const maestro = recorder.run("ios-maestro-suite", async () => {
    maestroStarted = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(maestroStarted, false);
  releaseCapture();
  await Promise.all([pendingSample, maestro]);

  assert.equal(readSnapshot(directory).hostSamples[1].stage, "ios-device-create");
  assert.equal(readSnapshot(directory).hostSamples[2].stage, "ios-device-create");
});

test("the preparation sampler stops at its exact host-sample budget", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-limit-");
  const scheduled = [];
  let captures = 0;
  const recorder = createIosObservationRecorder({
    captureHostSnapshot: async () => {
      captures += 1;
      return {
        complete: true,
        cpuCount: 3,
        diskAvailableBytes: 1,
        loadAverage: [0, 0, 0],
        memoryFreeBytes: 1,
        memoryPressureFreePercent: 100,
        memoryTotalBytes: 1,
        processes: [],
        swapUsedBytes: 0,
      };
    },
    directory,
    environment: {},
    scheduleTimer: (callback, delayMs) => {
      const token = { callback, delayMs, unref() {} };
      scheduled.push(token);
      return token;
    },
  });

  await recorder.run("ios-device-create", async () => {});
  for (let index = 0; index < 24; index += 1) {
    await scheduled[index].callback();
  }

  const snapshot = readSnapshot(directory);
  assert.equal(snapshot.hostSamples.length, 24);
  assert.equal(captures, 24);
  assert.equal(snapshot.completeness.recorder, true);
  assert.equal(snapshot.completeness.telemetry, false);
  assert.deepEqual(snapshot.observationErrors.at(-1), {
    code: "E2E_OBSERVATION_SAMPLE_LIMIT",
    dimension: "telemetry",
    name: "Error",
    operation: "sample-limit",
  });
  assert.equal(scheduled.length, 24);
});

test("Maestro artifacts expose bounded driver, app-home, and Picker semantic timings", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-maestro-observation-");
  const flowDirectory = join(directory, "2026-08-13_010203", "Import photos");
  mkdirSync(flowDirectory, { recursive: true });
  for (const name of ["logs", "screen-hierarchy", "screenshots"]) {
    mkdirSync(join(flowDirectory, name));
  }
  writeFileSync(
    join(flowDirectory, "commands.json"),
    `${JSON.stringify([
      {
        command: { defineVariablesCommand: {} },
        metadata: { duration: 10, status: "COMPLETED", timestamp: 1_100 },
      },
      {
        command: { launchAppCommand: {} },
        metadata: { duration: 200, status: "COMPLETED", timestamp: 1_200 },
      },
      {
        command: {
          assertConditionCommand: { condition: { visible: { idRegex: "home-screen" } } },
        },
        metadata: { duration: 300, status: "COMPLETED", timestamp: 1_400 },
      },
      {
        command: { tapOnElement: { selector: { idRegex: "choose-photos" } } },
        metadata: { duration: 100, status: "COMPLETED", timestamp: 1_800 },
      },
      {
        command: {
          assertConditionCommand: {
            condition: { visible: { idRegex: "PXGGridLayout-Info", index: "1" } },
          },
        },
        metadata: { duration: 900, status: "COMPLETED", timestamp: 2_000 },
      },
      {
        command: {
          assertConditionCommand: { condition: { visible: { textRegex: "^Done$" } } },
        },
        metadata: { duration: 20, status: "COMPLETED", timestamp: 2_900 },
      },
    ])}\n`,
  );

  assert.deepEqual(summarizeIosMaestroArtifacts(directory, 1_000), {
    complete: true,
    driverStartupMs: 100,
    failureBoundary: "none",
    flows: [
      {
        appHomeReadyMs: 500,
        failure: null,
        pickerDoneReadyMs: 20,
        pickerGridReadyMs: 1_100,
        status: "passed",
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(summarizeIosMaestroArtifacts(directory, 1_000)),
    /Import photos/,
  );
});

test("Maestro artifact interpretation fails closed on empty, failed, or bounded input", (t) => {
  const emptyDirectory = createTemporaryTestDirectory(t, "plogkit-ios-maestro-empty-");
  mkdirSync(join(emptyDirectory, "empty"));
  writeFileSync(join(emptyDirectory, "empty", "commands.json"), "[]\n");
  assert.deepEqual(summarizeIosMaestroArtifacts(emptyDirectory, 1_000, true), {
    complete: false,
    driverStartupMs: null,
    failureBoundary: "driver-startup",
    flows: [],
  });

  const failedDirectory = createTemporaryTestDirectory(t, "plogkit-ios-maestro-failed-");
  mkdirSync(join(failedDirectory, "flow"));
  writeFileSync(
    join(failedDirectory, "flow", "commands.json"),
    `${JSON.stringify([
      {
        command: { launchAppCommand: {} },
        metadata: { duration: 20, status: "COMPLETED", timestamp: 1_100 },
      },
    ])}\n`,
  );
  assert.equal(
    summarizeIosMaestroArtifacts(failedDirectory, 1_000, true).failureBoundary,
    "other-command",
  );

  const boundedDirectory = createTemporaryTestDirectory(t, "plogkit-ios-maestro-bounded-");
  for (let index = 0; index < 33; index += 1) {
    const flow = join(boundedDirectory, String(index));
    mkdirSync(flow);
    writeFileSync(
      join(flow, "commands.json"),
      `${JSON.stringify([
        {
          command: { launchAppCommand: {} },
          metadata: { duration: 1, status: "COMPLETED", timestamp: 1_100 + index },
        },
      ])}\n`,
    );
  }
  const bounded = summarizeIosMaestroArtifacts(boundedDirectory, 1_000, false);
  assert.equal(bounded.complete, false);
  assert.equal(bounded.flows.length, 32);
  assert.doesNotMatch(JSON.stringify(bounded), /Users|private|commands\.json/);

  const malformedDirectory = createTemporaryTestDirectory(t, "plogkit-ios-maestro-malformed-");
  mkdirSync(join(malformedDirectory, "flow"));
  writeFileSync(
    join(malformedDirectory, "flow", "commands.json"),
    `${JSON.stringify([
      {
        command: { launchAppCommand: {} },
        metadata: { timestamp: 1_100 },
      },
      {
        command: { hideKeyboardCommand: {} },
        metadata: { duration: 20, status: "FAILED", timestamp: 1_200 },
      },
    ])}\n`,
  );
  assert.equal(summarizeIosMaestroArtifacts(malformedDirectory, 1_000, true).complete, false);
});

test("Maestro artifacts classify failed product assertions with bounded action context", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-maestro-assertion-");
  const flowDirectory = join(directory, "flow");
  mkdirSync(flowDirectory);
  writeFileSync(
    join(flowDirectory, "commands.json"),
    `${JSON.stringify([
      {
        command: { launchAppCommand: {} },
        metadata: { duration: 20, status: "COMPLETED", timestamp: 1_100 },
      },
      {
        command: { tapOnElement: { selector: { idRegex: "draft-item-0" } } },
        metadata: { duration: 20, status: "COMPLETED", timestamp: 1_200 },
      },
      {
        command: { runFlowCommand: { sourceDescription: "open-draft.yaml" } },
        metadata: { duration: 20, status: "FAILED", timestamp: 1_250 },
      },
      {
        command: {
          assertConditionCommand: { condition: { visible: { idRegex: "editor-screen" } } },
        },
        metadata: { duration: 20, status: "FAILED", timestamp: 1_300 },
      },
    ])}\n`,
  );

  const summary = summarizeIosMaestroArtifacts(directory, 1_000, true);
  assert.equal(summary.failureBoundary, "business-assertion");
  assert.deepEqual(summary.flows[0].failure, {
    assertionId: "editor-screen",
    command: "assert-visible",
    lastSuccessfulCommand: "tap",
    lastSuccessfulTargetId: "draft-item-0",
  });
});

test("Maestro artifacts classify not-visible product assertions without leaking regexes", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-maestro-not-visible-");
  const flowDirectory = join(directory, "flow");
  mkdirSync(flowDirectory);
  writeFileSync(
    join(flowDirectory, "commands.json"),
    `${JSON.stringify([
      {
        command: { launchAppCommand: {} },
        metadata: { duration: 20, status: "COMPLETED", timestamp: 1_100 },
      },
      {
        command: {
          assertConditionCommand: {
            condition: { notVisible: { idRegex: "private.*regex" } },
          },
        },
        metadata: { duration: 20, status: "FAILED", timestamp: 1_200 },
      },
    ])}\n`,
  );

  const summary = summarizeIosMaestroArtifacts(directory, 1_000, true);
  assert.equal(summary.failureBoundary, "business-assertion");
  assert.deepEqual(summary.flows[0].failure, {
    assertionId: null,
    command: "assert-not-visible",
    lastSuccessfulCommand: "launch-app",
    lastSuccessfulTargetId: null,
  });
  assert.doesNotMatch(JSON.stringify(summary), /private|regex/);
});

test("a failed post-Maestro host checkpoint cannot replace the suite primary", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-maestro-checkpoint-");
  const primary = new Error("driver failed");
  const recorder = createIosObservationRecorder({
    captureHostSnapshot: async () => {
      throw Object.assign(new Error("host checkpoint failed"), { code: "PRIVATE_TOKEN" });
    },
    directory,
    environment: {},
  });

  await assert.rejects(
    recorder.run("ios-maestro-suite", async () => {
      throw primary;
    }),
    (error) => error === primary,
  );

  const snapshot = readSnapshot(directory);
  assert.equal(snapshot.events.at(-1).status, "failed");
  assert.deepEqual(snapshot.observationErrors, [
    { dimension: "telemetry", name: "Error", operation: "host-capture" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /PRIVATE_TOKEN|host checkpoint failed|driver failed/,
  );
});

test("SIGTERM durably records interruption before cleanup", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-observation-signal-");
  const observationUrl = new URL("./ios-observation.mjs", import.meta.url).href;
  const runtimeUrl = new URL("./runtime.mjs", import.meta.url).href;
  const source = `
import { createIosObservationRecorder } from ${JSON.stringify(observationUrl)};
import { createCleanupManager, installSignalHandlers } from ${JSON.stringify(runtimeUrl)};
const cleanup = createCleanupManager();
const observation = createIosObservationRecorder({
  directory: ${JSON.stringify(directory)},
  environment: {},
});
cleanup.add(() => {});
installSignalHandlers(cleanup, {
  recordInterruption: () => observation.finish("interrupted"),
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let readinessTimeout;
  try {
    await Promise.race([
      once(child.stdout, "data"),
      new Promise((_, rejectPromise) => {
        readinessTimeout = setTimeout(
          () => rejectPromise(new Error("observation signal fixture was not ready")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(readinessTimeout);
  }

  child.kill("SIGTERM");
  const [exitCode, signal] = await once(child, "exit");

  assert.equal(exitCode, 143);
  assert.equal(signal, null);
  assert.equal(readSnapshot(directory).outcome.status, "interrupted");
});
