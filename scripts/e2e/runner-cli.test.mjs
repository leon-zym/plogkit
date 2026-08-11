import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nprintf '%s\\n' '2.8.0'\n");

  const result = runCli(["scripts/e2e/run.mjs", "android", "--flow", "runner-version-probe"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binaries}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Maestro .* is required/);
  assert.match(result.stderr, /Unknown E2E flow: runner-version-probe/);
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
