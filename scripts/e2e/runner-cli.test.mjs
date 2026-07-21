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

test("Android build phase rejects Maestro versions older than the supported baseline", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-version-"));
  const binaries = join(directory, "bin");
  const adbLog = join(directory, "adb-commands.log");
  mkdirSync(binaries);
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.6.1'\n");
  writeExecutable(
    join(binaries, "adb"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
`,
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/e2e/run.mjs", "android", "--phase", "build"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ANDROID_HOME: "",
        ANDROID_SDK_ROOT: "",
        FAKE_ADB_LOG: adbLog,
        PATH: `${binaries}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Maestro 2\.7\.0 or newer is required; found 2\.6\.1/);
  assert.equal(existsSync(adbLog), false);
});

test("a newer local Maestro version reaches deterministic CLI validation", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-newer-version-"));
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.8.1'\n");

  const result = spawnSync(
    process.execPath,
    ["scripts/e2e/run.mjs", "android", "--phase", "test", "--flow", "runner-version-probe"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaries}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Maestro 2\.8\.1 is newer than the CI baseline 2\.7\.0/);
  assert.doesNotMatch(result.stderr, /Maestro 2\.7\.0 or newer is required/);
  assert.match(result.stderr, /Unknown E2E flow: runner-version-probe/);
});

test("iOS test phase reports a missing Maestro before host validation", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-missing-version-"));
  const result = spawnSync(process.execPath, ["scripts/e2e/run.mjs", "ios", "--phase", "test"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: directory,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Maestro 2\.7\.0 or newer is required but was not found on PATH/);
});

test("iOS rejects an external device before invoking simulator tooling", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-runner-ios-device-"));
  const binaries = join(directory, "bin");
  const xcrunLog = join(directory, "xcrun-commands.log");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
`,
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/e2e/run.mjs", "ios", "--phase", "test", "--device", "daily-simulator"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_XCRUN_LOG: xcrunLog,
        PATH: `${binaries}:${process.env.PATH}`,
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--device is supported only for Android/);
  assert.equal(existsSync(xcrunLog), false);
});
