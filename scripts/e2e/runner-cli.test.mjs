import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runCli(arguments_, options) {
  return spawnSync(process.execPath, arguments_, { timeout: 15000, ...options });
}

function writeLivePlatformLock(directory, platform) {
  const lockDirectory = join(directory, "plogkit-e2e-device-locks", platform);
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(
    join(lockDirectory, "owner.json"),
    `${JSON.stringify({ ownerPid: process.pid, startedAt: new Date().toISOString(), token: "owner" })}\n`,
  );
}

function writePinnedRunnerHostBinaries(binaries) {
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.8.0'\n");
  writeExecutable(join(binaries, "pnpm"), "#!/bin/sh\nprintf '%s\\n' '11.21.0'\n");
  writeExecutable(
    join(binaries, "java"),
    "#!/bin/sh\nprintf '%s\\n' '    java.home = /tmp/temurin' '    java.runtime.version = 17.0.20+8' '    java.vendor = Eclipse Adoptium' >&2\n",
  );
}

test("a Maestro version older than the pinned version is rejected", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-runner-version-");
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.6.1'\n");

  const result = runCli(["scripts/e2e/run.mjs", "android", "--flow", "runner-version-probe"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH}`,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Maestro 2\.8\.0 is required, but 2\.6\.1 is installed/);
  assert.doesNotMatch(result.stderr, /Unknown E2E flow/);
});

test("a Maestro version newer than the pinned version is rejected", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-runner-newer-version-");
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.9.0'\n");

  const result = runCli(["scripts/e2e/run.mjs", "android", "--flow", "runner-version-probe"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH}`,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Maestro 2\.8\.0 is required, but 2\.9\.0 is installed/);
  assert.doesNotMatch(result.stderr, /Unknown E2E flow/);
});

test("the pinned Maestro version continues to E2E input validation", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-runner-pinned-version-");
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeLivePlatformLock(directory, "android");
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.8.0'\n");

  const result = runCli(["scripts/e2e/run.mjs", "android", "--flow", "runner-version-probe"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH}`,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    },
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Maestro .* is required/);
  assert.match(result.stderr, /Unknown E2E flow: runner-version-probe/);
  assert.doesNotMatch(result.stderr, /already owned by runner PID/);
});

test("Android environment validation stays before its platform lock", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-runner-android-validation-order-");
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeLivePlatformLock(directory, "android");
  writePinnedRunnerHostBinaries(binaries);

  const result = runCli(["scripts/e2e/run.mjs", "android"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ANDROID_HOME: join(directory, "missing-android-sdk"),
      PATH: `${binaries}:${process.env.PATH}`,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Android Emulator is missing/);
  assert.doesNotMatch(result.stderr, /already owned by runner PID/);
});

test("iOS reports a missing Maestro before host validation", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-runner-missing-version-");
  const result = runCli(["scripts/e2e/run.mjs", "ios"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: directory,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Maestro 2\.8\.0 is required but was not found on PATH/);
});

test("the runner rejects the removed cross-process phase interface", () => {
  const result = runCli(["scripts/e2e/run.mjs", "android", "--phase", "test"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --phase/);
});

test("the runner rejects an incomplete flow selector before validation", () => {
  const result = runCli(["scripts/e2e/run.mjs", "android", "--flow"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--flow requires a flow basename/);
});

test("photo resource assessment waits while fewer than the expected identities are present", async () => {
  const { assessPhotoResourceDelta } = await import("./export-assertion.mjs");
  const before = new Set(["fixture-1", "fixture-2"]);
  const after = new Set([...before, "export-1"]);

  assert.equal(assessPhotoResourceDelta(before, after, 2), null);
});

test("photo resource assessment accepts exactly the expected new identities", async () => {
  const { assessPhotoResourceDelta } = await import("./export-assertion.mjs");
  const before = new Set(["fixture-1", "fixture-2"]);
  const after = new Set([...before, "export-1", "export-2"]);

  assert.equal(assessPhotoResourceDelta(before, after, 2), after);
});

test("photo resource assessment rejects more than the expected new identities", async () => {
  const { assessPhotoResourceDelta } = await import("./export-assertion.mjs");
  const before = new Set(["fixture-1", "fixture-2"]);
  const after = new Set([...before, "export-1", "export-2", "unexpected-export"]);

  assert.throws(
    () => assessPhotoResourceDelta(before, after, 2),
    /Expected exactly 2 new system photo resources, but observed 3/,
  );
});

test("the export photo assertion server binds each request to its exact delta", async () => {
  const { startExportAssertionBridge } = await import("./export-assertion.mjs");
  const device = { platform: "ios" };
  const before = new Set(["fixture-1", "fixture-2"]);
  let resources = new Set([...before, "export-1"]);
  const bridge = await startExportAssertionBridge({
    beforePhotoResources: before,
    capturePhotoResources: () => resources,
    device,
    exportTimeoutMs: 100,
  });

  try {
    const assertionUrl = new URL(bridge.environment.PLOGKIT_EXPORT_ASSERTION_URL);
    assert.match(assertionUrl.pathname, /^\/[0-9a-f-]{36}$/);
    const unauthenticated = await fetch(new URL("/1", assertionUrl), { method: "POST" });
    assert.equal(unauthenticated.status, 404);
    const first = await fetch(`${bridge.environment.PLOGKIT_EXPORT_ASSERTION_URL}/1`, {
      method: "POST",
    });
    assert.equal(first.status, 204);
    resources = new Set([...resources, "export-2"]);
    const second = await fetch(`${bridge.environment.PLOGKIT_EXPORT_ASSERTION_URL}/2`, {
      method: "POST",
    });
    assert.equal(second.status, 204);
  } finally {
    await bridge.close();
  }
});

test("the first export assertion rejects a cumulative delta of two", async () => {
  const { startExportAssertionBridge } = await import("./export-assertion.mjs");
  const device = { platform: "android" };
  const before = new Set(["fixture-1", "fixture-2"]);
  const resources = new Set([...before, "export-1", "export-2"]);
  const bridge = await startExportAssertionBridge({
    beforePhotoResources: before,
    capturePhotoResources: () => resources,
    device,
    exportTimeoutMs: 100,
  });

  try {
    const response = await fetch(`${bridge.environment.PLOGKIT_EXPORT_ASSERTION_URL}/1`, {
      method: "POST",
    });
    assert.equal(response.status, 409);
    assert.match(
      await response.text(),
      /Expected exactly 1 new system photo resources, but observed 2/,
    );
  } finally {
    await bridge.close();
  }
});

test("export bridge close cancels active assertion polling", async () => {
  const { startExportAssertionBridge } = await import("./export-assertion.mjs");
  const requestStarted = Promise.withResolvers();
  const before = new Set(["fixture-1", "fixture-2"]);
  let captures = 0;
  const bridge = await startExportAssertionBridge({
    beforePhotoResources: before,
    capturePhotoResources() {
      captures += 1;
      requestStarted.resolve();
      return before;
    },
    closeTimeoutMs: 250,
    device: { platform: "ios" },
    exportTimeoutMs: 1000,
  });

  const request = fetch(`${bridge.environment.PLOGKIT_EXPORT_ASSERTION_URL}/1`, {
    method: "POST",
  }).catch(() => null);
  await requestStarted.promise;
  const closeStartedAt = Date.now();
  await bridge.close();
  assert.ok(Date.now() - closeStartedAt < 250);
  await request;
  const capturesAfterClose = captures;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  assert.equal(captures, capturesAfterClose);
});

test("sorted platform locks precede locked CoreSimulator validation", async () => {
  const { validateAfterAcquiringPlatformLocks } = await import("./run.mjs");
  assert.equal(typeof validateAfterAcquiringPlatformLocks, "function");

  const events = [];
  const cleanup = { add() {} };
  await validateAfterAcquiringPlatformLocks(
    ["ios", "android"],
    { artifactRoot: "/tmp/artifacts", cleanup },
    {
      acquirePlatformLock(platform, receivedCleanup) {
        assert.equal(receivedCleanup, cleanup);
        events.push(`lock:${platform}`);
      },
      async validateLockedEnvironment(platforms, options) {
        assert.equal(options.artifactRoot, "/tmp/artifacts");
        assert.equal(options.cleanup, cleanup);
        events.push(`validate:${platforms.join("+")}`);
      },
    },
  );

  assert.deepEqual(events, ["lock:android", "lock:ios", "validate:ios+android"]);
});

test(
  "iOS CLI fails fast on a non-macOS host before native toolchain validation",
  { skip: process.platform === "darwin" },
  (t) => {
    const directory = createTemporaryTestDirectory(t, "plogkit-runner-ios-non-macos-");
    const binaries = join(directory, "bin");
    mkdirSync(binaries);
    writePinnedRunnerHostBinaries(binaries);

    const result = runCli(["scripts/e2e/run.mjs", "ios"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaries}:${process.env.PATH}`,
        TEMP: directory,
        TMP: directory,
        TMPDIR: directory,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /iOS E2E requires macOS/);
    assert.doesNotMatch(result.stderr, /Xcode|CocoaPods|already owned by runner PID/);
  },
);
