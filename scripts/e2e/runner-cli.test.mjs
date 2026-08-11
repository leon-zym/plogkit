import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("a Maestro version older than the pinned version is rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-version-"));
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.6.1'\n");

  const result = runCli(["scripts/e2e/run.mjs", "android", "--flow", "runner-version-probe"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Maestro 2\.8\.0 is required, but 2\.6\.1 is installed/);
  assert.doesNotMatch(result.stderr, /Unknown E2E flow/);
});

test("a Maestro version newer than the pinned version is rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-newer-version-"));
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.9.0'\n");

  const result = runCli(["scripts/e2e/run.mjs", "android", "--flow", "runner-version-probe"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Maestro 2\.8\.0 is required, but 2\.9\.0 is installed/);
  assert.doesNotMatch(result.stderr, /Unknown E2E flow/);
});

test("the pinned Maestro version continues to E2E input validation", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-pinned-version-"));
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

test("Android environment validation stays before its platform lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-android-validation-order-"));
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

test("iOS reports a missing Maestro before host validation", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-missing-version-"));
  const result = runCli(["scripts/e2e/run.mjs", "ios"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: directory,
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

test("iOS acquires its platform lock before CoreSimulator host initialization", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-ios-lock-order-"));
  const binaries = join(directory, "bin");
  const runtimeProbeMarker = join(directory, "runtime-probe-invoked");
  mkdirSync(binaries);
  writeLivePlatformLock(directory, "ios");
  writePinnedRunnerHostBinaries(binaries);
  writeExecutable(
    join(binaries, "xcode-select"),
    "#!/bin/sh\nprintf '%s\\n' '/Applications/Xcode_26.6.app/Contents/Developer'\n",
  );
  writeExecutable(
    join(binaries, "xcodebuild"),
    "#!/bin/sh\nprintf '%s\\n' 'Xcode 26.6' 'Build version 17F113'\n",
  );
  writeExecutable(join(binaries, "pod"), "#!/bin/sh\nprintf '%s\\n' '1.17.0'\n");
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' invoked > "$FAKE_RUNTIME_PROBE_MARKER"
case "$*" in
  "simctl list runtimes -j") printf '%s\n' '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","isAvailable":true,"name":"iOS 26.5","version":"26.5"}]}' ;;
  "simctl list devicetypes -j") printf '%s\n' '{"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","name":"iPhone 17 Pro"}]}' ;;
esac
`,
  );

  const result = runCli(["scripts/e2e/run.mjs", "ios"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      E2E_ARTIFACTS_DIR: join(directory, "artifacts"),
      FAKE_RUNTIME_PROBE_MARKER: runtimeProbeMarker,
      PATH: `${binaries}:${process.env.PATH}`,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`already owned by runner PID ${process.pid}`));
  assert.equal(existsSync(runtimeProbeMarker), false);
});
