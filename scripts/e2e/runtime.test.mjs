import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import {
  capture,
  captureBoundedCommand,
  acquireE2ePlatformLock,
  collectFailureDiagnostics,
  publicE2eErrorText,
  createCleanupManager,
  createArtifactRoot,
  finalizeCleanup,
  run,
  runMaestroSuite,
  terminateProcessTree,
  validateMaestroVersion,
  waitUntil,
  withFailureDiagnostics,
} from "./runtime.mjs";

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function totalFileBytes(directory) {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(directory, entry.name);
    return total + (entry.isDirectory() ? totalFileBytes(path) : statSync(path).size);
  }, 0);
}

test("capture bounds an unresponsive diagnostic command", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-timeout-");
  const command = join(directory, "hang");
  writeExecutable(command, "#!/bin/sh\nsleep 1\n");

  const startedAt = Date.now();
  const result = capture(command, [], { allowFailure: true, timeoutMs: 50 });

  assert.equal(result, null);
  assert.ok(Date.now() - startedAt < 500);
});

test("public E2E errors redact command arguments, loopback endpoints, and private paths", () => {
  const source = Object.assign(
    new Error(
      "Command failed (1): /Users/runner/work/plogkit/maestro --env PLOGKIT_EXPORT_ASSERTION_URL=http://127.0.0.1:4312/private-token /var/folders/private/output\n" +
        "artifact: /home/runner/work/plogkit/private.log\n" +
        "endpoint: http://127.0.0.1:9876/another-token",
    ),
    { e2eStage: "ios-app-install" },
  );
  const output = publicE2eErrorText(source);

  assert.equal(
    output,
    "[ios-app-install] Command failed (1): maestro <arguments redacted>\n" +
      "artifact: <PRIVATE_PATH>\n" +
      "endpoint: <LOOPBACK_ENDPOINT>",
  );
  assert.doesNotMatch(output, /Users|127\.0\.0\.1|private-token|var\/folders/);
});

test("public E2E text redacts JSON-escaped private paths and loopback capabilities", () => {
  const output = publicE2eErrorText(
    String.raw`{"path":"\/Users\/runner\/Library\/private","temp":"\/private\/var\/folders\/secret","endpoint":"http:\/\/127.0.0.1:4312\/private-token"}`,
  );

  assert.equal((output.match(/<PRIVATE_PATH>/g) ?? []).length, 2);
  assert.match(output, /<LOOPBACK_ENDPOINT>/);
  assert.doesNotMatch(output, /Users|127\.0\.0\.1|private-token/);
});

test("public E2E text redacts prefixed commands and every loopback spelling", () => {
  const output = publicE2eErrorText(
    "original error: Command timed out after 120000ms: /usr/bin/xcrun simctl boot PRIVATE-UDID\n" +
      "driver: 127.0.0.1:53168 <127.0.0.1> localhost:4312/token http://[::1]:9876/private",
  );

  assert.equal(
    output,
    "original error: Command timed out after 120000ms: xcrun <arguments redacted>\n" +
      "driver: <LOOPBACK_ENDPOINT> <LOOPBACK_ENDPOINT> <LOOPBACK_ENDPOINT> <LOOPBACK_ENDPOINT>",
  );
  assert.doesNotMatch(output, /PRIVATE-UDID|127\.0\.0\.1|localhost|::1|token|private/);
});

test("signal cleanup publishes bounded evidence before the runner exits", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-signal-publication-");
  const eventLog = join(directory, "events.log");
  const runtimeUrl = new URL("./runtime.mjs", import.meta.url).href;
  const source = `
import { appendFileSync } from "node:fs";
import { createCleanupManager, installSignalHandlers } from ${JSON.stringify(runtimeUrl)};
const cleanup = createCleanupManager();
cleanup.add(() => appendFileSync(${JSON.stringify(eventLog)}, "cleanup\\n"));
installSignalHandlers(cleanup, {
  publishFailureArtifacts: () => appendFileSync(${JSON.stringify(eventLog)}, "publish\\n"),
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
  await Promise.race([
    new Promise((resolvePromise) => {
      child.stdout.once("data", resolvePromise);
    }),
    new Promise((_, rejectPromise) =>
      setTimeout(() => rejectPromise(new Error("signal fixture did not become ready")), 2000),
    ),
  ]);

  child.kill("SIGTERM");
  const [exitCode, signal] = await once(child, "exit");

  assert.equal(exitCode, 143);
  assert.equal(signal, null);
  assert.equal(readFileSync(eventLog, "utf8"), "cleanup\npublish\n");
});

test("bounded commands can omit sensitive output from their primary error", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-private-command-output-");
  const command = join(directory, "private-output");
  writeExecutable(command, "#!/bin/sh\nprintf '%s\\n' '/Users/runner/private-catalog'\nexit 7\n");

  await assert.rejects(
    captureBoundedCommand(command, [], {
      includeOutputInError: false,
      maxBytes: 1024,
      timeoutMs: 1000,
    }),
    (error) => {
      assert.doesNotMatch(error.message, /Users\/runner|private-catalog/);
      assert.match(error.message, /Command failed \(7\)/);
      return true;
    },
  );
});

test(
  "bounded command capture kills a TERM-resistant process tree retaining output pipes",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = createTemporaryTestDirectory(t, "plogkit-e2e-bounded-command-tree-");
    const command = join(directory, "retain-pipe");
    const leakMarker = join(directory, "descendant-survived");
    writeExecutable(
      command,
      `#!/bin/sh
printf '%s\n' 'bounded-command-started' >&2
(
  trap '' TERM
  sleep 4
  printf '%s\n' 'descendant survived' > ${JSON.stringify(leakMarker)}
) &
wait
`,
    );

    const startedAt = Date.now();
    await assert.rejects(
      captureBoundedCommand(command, [], { maxBytes: 1024, timeoutMs: 2000 }),
      (error) => {
        assert.equal(error.code, "E2E_COMMAND_TIMEOUT");
        assert.match(error.message, /bounded-command-started/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2800);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 4200));
    assert.equal(existsSync(leakMarker), false);
  },
);

test("waitUntil propagates a channel failure without retrying it", async () => {
  const channelError = new Error("ADB_CHANNEL_FAILED");
  let attempts = 0;

  await assert.rejects(
    waitUntil(
      () => {
        attempts += 1;
        throw channelError;
      },
      100,
      "a device state",
      1,
    ),
    (error) => error === channelError,
  );
  assert.equal(attempts, 1);
});

test("Android diagnostics use the device-owned adb and preserve fresh raw evidence", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-android-diagnostics-");
  const adbPath = join(directory, "sdk", "platform-tools", "adb");
  const artifacts = join(directory, "artifacts");
  const invocationLog = join(directory, "adb.log");
  mkdirSync(join(directory, "sdk", "platform-tools"), { recursive: true });
  writeExecutable(
    adbPath,
    `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(invocationLog)}
case "$*" in
  *"for report in /data/tombstones/"*)
    printf '%s\n' '${Math.floor(Date.now() / 1000)}|16|/data/tombstones/tombstone_fresh'
    ;;
  *"for report in /data/anr/"*) exit 0 ;;
  *"exec-out cat /data/tombstones/tombstone_fresh"*) printf '%s\n' 'fresh tombstone' ;;
  *"logcat -b main"*) printf '%s\n' 'raw crash log' ;;
  *"logcat -b events"*) printf '%s\n' 'raw event log' ;;
  *"dumpsys window"*) printf '%s\n' 'raw window state' ;;
  *"dumpsys activity"*) printf '%s\n' 'raw activity state' ;;
esac
`,
  );

  const result = await collectFailureDiagnostics({
    diagnosticDirectory: artifacts,
    device: { platform: "android", deviceId: "emulator-test", adbPath },
    error: new Error("original Android failure"),
    sinceMs: Date.now(),
  });

  assert.deepEqual(result, { complete: true });
  assert.match(readFileSync(join(artifacts, "logcat.txt"), "utf8"), /raw crash log/);
  assert.match(readFileSync(join(artifacts, "events-logcat.txt"), "utf8"), /raw event log/);
  assert.match(
    readFileSync(join(artifacts, "tombstones", "tombstone_fresh"), "utf8"),
    /fresh tombstone/,
  );
  assert.match(
    readFileSync(join(artifacts, "failure-summary.txt"), "utf8"),
    /diagnostics: complete\noriginal error: original Android failure/,
  );
  assert.match(readFileSync(invocationLog, "utf8"), /-s emulator-test logcat/);
});

test(
  "diagnostics bound a TERM-resistant process tree that retains output pipes",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = createTemporaryTestDirectory(t, "plogkit-e2e-diagnostic-tree-timeout-");
    const adbPath = join(directory, "adb");
    const artifacts = join(directory, "artifacts");
    const descendantReadyMarker = join(directory, "descendant-started");
    const leakMarker = join(directory, "descendant-survived");
    const descendantSource = `
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      setTimeout(() => writeFileSync(${JSON.stringify(leakMarker)}, "leaked"), 2500);
      setInterval(() => {}, 1000);
    `;
    writeExecutable(
      adbPath,
      `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(${JSON.stringify(descendantReadyMarker)}, "ready");
setInterval(() => {}, 1000);
`,
    );

    const startedAt = Date.now();
    const result = await collectFailureDiagnostics({
      diagnosticDirectory: artifacts,
      device: { platform: "android", deviceId: "emulator-test", adbPath },
      error: "original failure",
      timeoutMs: 1200,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(result, { complete: false });
    assert.ok(elapsedMs < 1800, `diagnostics took ${elapsedMs}ms`);
    assert.equal(existsSync(descendantReadyMarker), true);
    assert.match(readFileSync(join(artifacts, "failure-summary.txt"), "utf8"), /incomplete/);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2600));
    assert.equal(existsSync(leakMarker), false);
  },
);

test("run preserves complete command output beyond the writable high-water mark", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-command-output-");
  const outputPath = join(directory, "command.log");
  const bodyLength = 256 * 1024;

  await run(
    process.execPath,
    ["-e", `process.stdout.write("x".repeat(${bodyLength})); process.stdout.write("END")`],
    { outputPath, stdio: "ignore" },
  );

  const output = readFileSync(outputPath, "utf8");
  assert.equal(output.length, bodyLength + 3);
  assert.equal(output.endsWith("END"), true);
});

test("run rejects an artifact write failure without an uncaught stream error", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-command-write-error-");

  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      outputPath: join(directory, "missing", "command.log"),
      stdio: "ignore",
    }),
    /Unable to write command output/,
  );
});

test("run preserves a command failure when its output artifact also fails", async (t) => {
  const outputPath = createTemporaryTestDirectory(t, "plogkit-e2e-command-combined-error-");

  await assert.rejects(
    run(process.execPath, ["-e", "process.exit(23)"], {
      outputPath,
      stdio: "ignore",
      terminate: async () => {},
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.cause.message, /Command failed \(23\):/);
      assert.equal(error.errors[0], error.cause);
      assert.match(error.errors[1].message, /Unable to write command output/);
      return true;
    },
  );
});

test("run bounds a hung process tree and reports the stage timeout", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      timeoutMs: 50,
    }),
    (error) => {
      assert.equal(error.code, "E2E_COMMAND_TIMEOUT");
      assert.match(error.message, /Command timed out after 50ms/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 2000);
});

test(
  "process cleanup escalates TERM to KILL and waits for the entire process group",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = createTemporaryTestDirectory(t, "plogkit-e2e-process-tree-");
    const descendantPidPath = join(directory, "descendant.pid");
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'process.on("SIGTERM", () => {});',
          'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "writeFileSync(process.argv[1], String(descendant.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
        descendantPidPath,
      ],
      { detached: true, stdio: "ignore" },
    );
    try {
      const deadline = Date.now() + 2000;
      while (!existsSync(descendantPidPath) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      assert.equal(existsSync(descendantPidPath), true);
      const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));

      await terminateProcessTree(child, { gracefulTimeoutMs: 100, killTimeoutMs: 1000 });

      assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The expected path already terminated the whole group.
      }
    }
  },
);

test("cleanup runs every task and preserves the primary operation error", async () => {
  const cleanup = createCleanupManager();
  const completed = [];
  const primaryError = new Error("primary operation failed");
  const cleanupError = new Error("device shutdown failed");
  cleanup.add(() => completed.push("last"));
  cleanup.add(() => {
    completed.push("first");
    throw cleanupError;
  });

  await assert.rejects(finalizeCleanup(cleanup, primaryError), (error) => {
    assert.equal(error.cause, primaryError);
    assert.equal(error.errors.includes(primaryError), true);
    assert.equal(error.errors.includes(cleanupError), true);
    return true;
  });
  assert.deepEqual(completed, ["first", "last"]);
});

test("device ownership lock rejects a concurrent runner and recovers a stale owner", async (t) => {
  const lockRoot = createTemporaryTestDirectory(t, "plogkit-e2e-device-lock-test-");
  const firstCleanup = createCleanupManager();
  acquireE2ePlatformLock("android", firstCleanup, { lockRoot, ownerPid: process.pid });

  assert.throws(
    () =>
      acquireE2ePlatformLock("android", createCleanupManager(), {
        lockRoot,
        ownerPid: process.pid + 1,
      }),
    /already owned by runner PID/,
  );
  await firstCleanup.run();

  const staleDirectory = join(lockRoot, "android");
  mkdirSync(staleDirectory);
  writeFileSync(
    join(staleDirectory, "owner.json"),
    `${JSON.stringify({ ownerPid: 999999, token: "stale" })}\n`,
  );
  const recoveredCleanup = createCleanupManager();
  acquireE2ePlatformLock("android", recoveredCleanup, {
    isProcessAlive: () => false,
    lockRoot,
    ownerPid: process.pid,
  });
  await recoveredCleanup.run();
  assert.equal(existsSync(staleDirectory), false);
});

test("configured artifacts use a unique run directory below the upload root", (t) => {
  const uploadRoot = createTemporaryTestDirectory(t, "plogkit-e2e-artifact-root-");
  const previous = process.env.E2E_ARTIFACTS_DIR;
  process.env.E2E_ARTIFACTS_DIR = uploadRoot;
  try {
    const first = createArtifactRoot();
    const second = createArtifactRoot();
    assert.equal(dirname(first), resolve(uploadRoot));
    assert.equal(dirname(second), resolve(uploadRoot));
    assert.notEqual(first, second);
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(second), true);
  } finally {
    if (previous === undefined) delete process.env.E2E_ARTIFACTS_DIR;
    else process.env.E2E_ARTIFACTS_DIR = previous;
  }
});

test("the acceptance transaction preserves an Android log-boundary failure", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-log-boundary-");
  const binaries = join(directory, "bin");
  const flows = join(directory, "e2e", "flows");
  const invocationLog = join(directory, "invocations.log");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "f00-first.yaml"), "appId: test\n---\n");
  writeExecutable(
    join(binaries, "maestro"),
    `#!/bin/sh
printf '%s\n' started >> "${invocationLog}"
exit 0
`,
  );
  writeExecutable(
    join(binaries, "adb"),
    `#!/bin/sh
case "$*" in
  *"logcat -b all -c"*) exit 1 ;;
  *) exit 0 ;;
esac
`,
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    const device = {
      platform: "android",
      deviceId: "emulator-test",
      adbPath: join(binaries, "adb"),
    };
    await assert.rejects(
      withFailureDiagnostics({
        diagnosticDirectory: join(directory, "artifacts", "android", "acceptance-failure"),
        device,
        operation: () =>
          runMaestroSuite({
            artifactRoot: join(directory, "artifacts"),
            cleanup: { add() {} },
            device,
            e2eRoot: join(directory, "e2e"),
            flow: null,
            root: directory,
          }),
      }),
      /Command failed \(1\): .*\/adb /,
    );
  } finally {
    process.env.PATH = previousPath;
  }

  assert.equal(existsSync(invocationLog), false);
  assert.match(
    readFileSync(
      join(directory, "artifacts", "android", "acceptance-failure", "failure-summary.txt"),
      "utf8",
    ),
    /original error: Command failed \(1\): adb <arguments redacted>/,
  );
});

test("Maestro validation and execution use the same PATH executable", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-maestro-path-");
  const binaries = join(directory, "bin");
  const packageBinaries = join(directory, "node_modules", ".bin");
  const invocationLog = join(directory, "path-maestro.log");
  const shadowSentinel = join(directory, "shadow-maestro-ran");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(packageBinaries, { recursive: true });
  mkdirSync(join(directory, "e2e", "flows"), { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"private":true}\n');
  writeFileSync(join(directory, "e2e", "config.yaml"), "flows:\n  - flows/*.yaml\n");
  writeExecutable(
    join(binaries, "maestro"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' version >> ${JSON.stringify(invocationLog)}
  printf '%s\n' 2.8.0
  exit 0
fi
printf '%s\n' "$*" >> ${JSON.stringify(invocationLog)}
exit 0
`,
  );
  writeExecutable(
    join(packageBinaries, "maestro"),
    `#!/bin/sh
printf '%s\n' shadow > ${JSON.stringify(shadowSentinel)}
exit 79
`,
  );
  writeExecutable(join(binaries, "adb"), "#!/bin/sh\nexit 0\n");

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    validateMaestroVersion();
    await runMaestroSuite({
      artifactRoot: join(directory, "artifacts"),
      cleanup: { add() {} },
      device: {
        platform: "android",
        deviceId: "emulator-test",
        adbPath: join(binaries, "adb"),
      },
      e2eRoot: join(directory, "e2e"),
      flow: null,
      flowEnvironment: {
        PLOGKIT_EXPORT_ASSERTION_URL: "http://127.0.0.1:12345/export-token",
      },
      root: directory,
    });
  } finally {
    process.env.PATH = previousPath;
  }

  const invocations = readFileSync(invocationLog, "utf8").trim().split("\n");
  assert.equal(invocations[0], "version");
  assert.match(invocations[1], /^--device emulator-test test /);
  assert.match(
    invocations[1],
    /--env PLOGKIT_EXPORT_ASSERTION_URL=http:\/\/127\.0\.0\.1:12345\/export-token/,
  );
  assert.equal(existsSync(shadowSentinel), false);
});

test("the acceptance transaction saves bounded evidence without rewriting a Maestro failure", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-platform-evidence-");
  const binaries = join(directory, "bin");
  const flows = join(directory, "e2e", "flows");
  const artifactRoot = join(directory, "artifacts");
  const invocationLog = join(directory, "invocations.log");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "f00-first.yaml"), "appId: test\n---\n");
  writeFileSync(join(flows, "f01-second.yaml"), "appId: test\n---\n");
  writeExecutable(
    join(binaries, "maestro"),
    `#!/bin/sh
for argument in "$@"; do target="$argument"; done
printf '%s\n' "$target" >> "${invocationLog}"
printf '%s\n' 'Assertion is false: id: home-screen is visible' >&2
exit 1
`,
  );
  writeExecutable(join(binaries, "adb"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    join(binaries, "adb"),
    `#!/bin/sh
case "$*" in
  *"for report in /data/tombstones/"*)
    printf '%s\n' '${Math.floor(Date.now() / 1000)}|0|/data/tombstones/tombstone_00'
    ;;
  *"for report in /data/anr/"*) exit 0 ;;
  *"/data/tombstones/tombstone_00"*)
    printf '%s\n' 'Cmdline: com.leonzym.plogkit' 'signal 11 (SIGSEGV)'
    ;;
  *"logcat -b main -b system -b crash"*)
    printf '%s\n' 'Cmdline: com.leonzym.plogkit' 'Fatal signal 11 (SIGSEGV), code 2'
    ;;
esac
`,
  );

  const device = {
    platform: "android",
    deviceId: "emulator-test",
    adbPath: join(binaries, "adb"),
  };
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      withFailureDiagnostics({
        diagnosticDirectory: join(artifactRoot, "android", "acceptance-failure"),
        device,
        operation: () =>
          runMaestroSuite({
            artifactRoot,
            cleanup: { add() {} },
            device,
            e2eRoot: join(directory, "e2e"),
            flow: null,
            root: directory,
          }),
      }),
      /Command failed \(1\): maestro /,
    );
  } finally {
    process.env.PATH = previousPath;
  }

  assert.equal(readFileSync(invocationLog, "utf8").trim().split("\n").length, 1);
  const diagnosticDirectory = join(artifactRoot, "android", "acceptance-failure");
  assert.match(
    readFileSync(join(diagnosticDirectory, "failure-summary.txt"), "utf8"),
    /Command failed/,
  );
  assert.match(readFileSync(join(diagnosticDirectory, "logcat.txt"), "utf8"), /SIGSEGV/);
  assert.match(
    readFileSync(join(diagnosticDirectory, "tombstones", "tombstone_00"), "utf8"),
    /SIGSEGV/,
  );
});

test("Maestro owns full-suite ordering and fail-fast execution in one process", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-single-suite-");
  const binaries = join(directory, "bin");
  const flows = join(directory, "e2e", "flows");
  const invocationLog = join(directory, "invocations.log");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "f00-first.yaml"), "appId: test\n---\n");
  writeFileSync(join(flows, "f01-second.yaml"), "appId: test\n---\n");
  writeFileSync(
    join(directory, "e2e", "config.yaml"),
    "flows:\n  - flows/*.yaml\nexecutionOrder:\n  continueOnFailure: false\n",
  );
  writeExecutable(
    join(binaries, "maestro"),
    `#!/bin/sh
printf '%s\n' "$*" >> "${invocationLog}"
exit 0
`,
  );
  writeExecutable(join(binaries, "adb"), "#!/bin/sh\nexit 0\n");

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await runMaestroSuite({
      artifactRoot: join(directory, "artifacts"),
      cleanup: { add() {} },
      device: {
        platform: "android",
        deviceId: "emulator-test",
        adbPath: join(binaries, "adb"),
      },
      e2eRoot: join(directory, "e2e"),
      flow: null,
      root: directory,
    });
  } finally {
    process.env.PATH = previousPath;
  }

  const invocations = readFileSync(invocationLog, "utf8").trim().split("\n");
  assert.equal(invocations.length, 1);
  assert.match(invocations[0], /--config=.*\/e2e\/config\.yaml/);
  assert.match(invocations[0], /\s.*\/e2e$/);
  assert.doesNotMatch(invocations[0], /f00-first\.yaml|f01-second\.yaml/);
});

test("an iOS Maestro failure is classified at the single suite lifecycle", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-ios-maestro-stage-");
  const binaries = join(directory, "bin");
  const flows = join(directory, "e2e", "flows");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "target-flow.yaml"), "appId: test\n---\n");
  writeExecutable(
    join(binaries, "maestro"),
    "#!/bin/sh\nprintf 'startup=%s\\n' \"$MAESTRO_DRIVER_STARTUP_TIMEOUT\" >&2\nprintf '%s\\n' 'Device became unreachable during deviceInfo' >&2\nexit 1\n",
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      runMaestroSuite({
        artifactRoot: join(directory, "artifacts"),
        cleanup: { add() {} },
        device: { platform: "ios", deviceId: "simulator-test" },
        e2eRoot: join(directory, "e2e"),
        flow: "target-flow",
        root: directory,
      }),
      (error) => {
        assert.equal(error.e2eStage, "ios-maestro-suite");
        assert.match(error.message, /Command failed/);
        return true;
      },
    );
  } finally {
    process.env.PATH = previousPath;
  }

  assert.match(
    readFileSync(join(directory, "artifacts", "ios", "flows", "runner-output.log"), "utf8"),
    /startup=120000.*Device became unreachable during deviceInfo/s,
  );
});

test("full and targeted iOS suites each start exactly one Maestro test lifecycle", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-ios-single-driver-");
  const binaries = join(directory, "bin");
  const e2eRoot = join(directory, "e2e");
  const flows = join(e2eRoot, "flows");
  const invocationLog = join(directory, "invocations.log");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(e2eRoot, "config.yaml"), "flows:\n  - flows/*.yaml\n");
  writeFileSync(join(flows, "target-flow.yaml"), "appId: test\n---\n");
  writeExecutable(
    join(binaries, "maestro"),
    `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(invocationLog)}
exit 0
`,
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    for (const flow of [null, "target-flow"]) {
      await runMaestroSuite({
        artifactRoot: join(directory, "artifacts"),
        cleanup: { add() {} },
        device: { platform: "ios", deviceId: "simulator-test" },
        e2eRoot,
        flow,
        root: directory,
      });
    }
  } finally {
    process.env.PATH = previousPath;
  }

  const invocations = readFileSync(invocationLog, "utf8").trim().split("\n");
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((invocation) => /--device simulator-test test /.test(invocation)));
  assert.ok(invocations.every((invocation) => !/\bhierarchy\b/.test(invocation)));
  assert.match(invocations[0], /--config=.*\/e2e\/config\.yaml .*\/e2e$/);
  assert.match(invocations[1], /\/e2e\/flows\/target-flow\.yaml$/);
});

test("Maestro execution requires an immutable E2E run snapshot root", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-snapshot-root-");
  const binaries = join(directory, "bin");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(join(directory, "e2e"), { recursive: true });
  writeFileSync(join(directory, "e2e", "config.yaml"), "flows:\n  - flows/*.yaml\n");
  writeExecutable(join(binaries, "maestro"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(binaries, "adb"), "#!/bin/sh\nexit 0\n");

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      runMaestroSuite({
        artifactRoot: join(directory, "artifacts"),
        cleanup: { add() {} },
        device: {
          platform: "android",
          deviceId: "emulator-test",
          adbPath: join(binaries, "adb"),
        },
        flow: null,
        root: directory,
      }),
      /immutable E2E run snapshot root is required/,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("Android diagnostics mark an accessible fresh report read failure incomplete", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-report-read-failure-");
  const adbPath = join(directory, "adb");
  const artifacts = join(directory, "artifacts");
  writeExecutable(
    adbPath,
    `#!/bin/sh
case "$*" in
  *"for report in /data/tombstones/"*)
    printf '%s\n' '${Math.floor(Date.now() / 1000)}|64|/data/tombstones/tombstone_lost'
    ;;
  *"exec-out cat /data/tombstones/tombstone_lost"*) exit 1 ;;
  *) exit 0 ;;
esac
`,
  );

  const result = await collectFailureDiagnostics({
    diagnosticDirectory: artifacts,
    device: { platform: "android", deviceId: "emulator-test", adbPath },
    error: "original failure",
    sinceMs: Date.now(),
    timeoutMs: 2000,
  });

  assert.deepEqual(result, { complete: false });
  assert.equal(existsSync(join(artifacts, "tombstones", "tombstone_lost")), false);
  assert.match(readFileSync(join(artifacts, "failure-summary.txt"), "utf8"), /incomplete/);
});

test("Android diagnostics keep the head and tail of a bounded fresh report", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-report-truncation-");
  const adbPath = join(directory, "adb");
  const artifacts = join(directory, "artifacts");
  writeExecutable(
    adbPath,
    `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args.includes("for report in /data/tombstones/")) {
  process.stdout.write(${JSON.stringify(`${Math.floor(Date.now() / 1000)}|3145738|/data/tombstones/tombstone_large\n`)});
} else if (args.includes("exec-out cat /data/tombstones/tombstone_large")) {
  process.stdout.write("HEAD\\n" + "x".repeat(3 * 1024 * 1024) + "\\nTAIL");
}
`,
  );

  const result = await collectFailureDiagnostics({
    diagnosticDirectory: artifacts,
    device: { platform: "android", deviceId: "emulator-test", adbPath },
    error: "original failure",
    sinceMs: Date.now(),
    timeoutMs: 3000,
  });

  const excerpt = readFileSync(
    join(artifacts, "tombstones", "tombstone_large.excerpt.txt"),
    "utf8",
  );
  assert.deepEqual(result, { complete: false });
  assert.equal(excerpt.startsWith("HEAD"), true);
  assert.match(excerpt, /diagnostic bytes omitted/);
  assert.equal(excerpt.endsWith("TAIL"), true);
});

test("all diagnostic artifacts share one fixed total byte cap", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-total-byte-cap-");
  const adbPath = join(directory, "adb");
  const artifacts = join(directory, "artifacts");
  const nowSeconds = Math.floor(Date.now() / 1000);
  writeExecutable(
    adbPath,
    `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args.includes("for report in /data/tombstones/")) {
  for (let index = 0; index < 4; index += 1) {
    process.stdout.write(${JSON.stringify(`${nowSeconds}|4194304|/data/tombstones/tombstone_`)} + index + "\n");
  }
} else if (args.includes("exec-out cat /data/tombstones/")) {
  process.stdout.write(Buffer.alloc(4 * 1024 * 1024, "r"));
} else {
  process.stdout.write(Buffer.alloc(8 * 1024 * 1024, "e"));
}
`,
  );

  const result = await collectFailureDiagnostics({
    diagnosticDirectory: artifacts,
    device: { platform: "android", deviceId: "emulator-test", adbPath },
    error: "original failure",
    sinceMs: Date.now(),
    timeoutMs: 10000,
  });

  assert.deepEqual(result, { complete: false });
  assert.ok(totalFileBytes(artifacts) <= 16 * 1024 * 1024);
  assert.match(readFileSync(join(artifacts, "failure-summary.txt"), "utf8"), /incomplete/);
});

test("iOS diagnostics copy only fresh relevant reports through the high-level seam", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-ios-diagnostics-");
  const binaries = join(directory, "bin");
  const reports = join(directory, "reports");
  const artifacts = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(reports);
  const startedAt = Date.now();
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
if [ "$1 $2 $3" = "simctl list devices" ]; then
  printf '%s\n' '{"devices":{"iOS 26.5":[{"udid":"simulator-test","state":"Booted"}]}}'
elif [ "$1 $2 $3" = "simctl listapps simulator-test" ]; then
  printf '%s\n' '{ "com.apple.mobilesafari" = {}; }'
elif [ "$1 $2 $3 $4" = "simctl spawn simulator-test launchctl" ]; then
  printf '%s\n' 'pid = 4242' 'state = running'
elif [ "$1" = simctl ] && [ "$2" = io ] && [ "$4" = screenshot ]; then
  printf '%s' 'PNG-EVIDENCE' > "$5"
else
  printf '%s\n' 'raw simulator log'
fi
`,
  );
  writeFileSync(join(reports, "PlogKit-fresh.ips"), "app crash /Users/runner/private/app");
  writeFileSync(
    join(reports, "MaestroDriver-fresh.crash"),
    String.raw`driver crash \/Users\/runner\/private\/driver`,
  );
  writeFileSync(join(reports, "PUPicker-fresh.ips"), "picker crash");
  writeFileSync(join(reports, "PhotosUIService-fresh.crash"), "photos ui crash");
  writeFileSync(
    join(reports, "photolibraryd-fresh.diag"),
    "photo library crash http://127.0.0.1:4312/private-token",
  );
  writeFileSync(join(reports, "assetsd-fresh.ips"), "photo assets crash");
  writeFileSync(join(reports, "Unrelated-fresh.diag"), "unrelated");
  writeFileSync(join(reports, "PlogKit-old.ips"), "old app crash");
  utimesSync(join(reports, "PlogKit-old.ips"), new Date(0), new Date(0));

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  let result;
  try {
    result = await collectFailureDiagnostics({
      diagnosticDirectory: artifacts,
      device: { platform: "ios", deviceId: "simulator-test" },
      error: "original iOS failure",
      iosReportsDirectory: reports,
      sinceMs: startedAt,
      timeoutMs: 2000,
    });
  } finally {
    process.env.PATH = previousPath;
  }

  assert.deepEqual(result, { complete: true });
  assert.equal(
    readFileSync(join(artifacts, "PlogKit-fresh.ips"), "utf8"),
    "app crash <PRIVATE_PATH>",
  );
  assert.equal(
    readFileSync(join(artifacts, "MaestroDriver-fresh.crash"), "utf8"),
    "driver crash <PRIVATE_PATH>",
  );
  assert.equal(readFileSync(join(artifacts, "PUPicker-fresh.ips"), "utf8"), "picker crash");
  assert.equal(
    readFileSync(join(artifacts, "PhotosUIService-fresh.crash"), "utf8"),
    "photos ui crash",
  );
  assert.equal(
    readFileSync(join(artifacts, "photolibraryd-fresh.diag"), "utf8"),
    "photo library crash <LOOPBACK_ENDPOINT>",
  );
  assert.equal(readFileSync(join(artifacts, "assetsd-fresh.ips"), "utf8"), "photo assets crash");
  assert.equal(existsSync(join(artifacts, "Unrelated-fresh.diag")), false);
  assert.equal(existsSync(join(artifacts, "PlogKit-old.ips")), false);
  assert.match(readFileSync(join(artifacts, "simulator-system.log"), "utf8"), /raw simulator/);
});

test("iOS diagnostics capture bounded device and XCTest readiness probes", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-ios-readiness-diagnostics-");
  const binaries = join(directory, "bin");
  const reports = join(directory, "reports");
  const artifacts = join(directory, "artifacts");
  const commandLog = join(directory, "xcrun.log");
  mkdirSync(binaries);
  mkdirSync(reports);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
if [ "$1 $2 $3" = "simctl list devices" ]; then
  printf '%s\n' '{"devices":{"iOS 26.5":[{"udid":"simulator-test","state":"Booted","dataPath":"/Users/runner/private-device"}]}}'
elif [ "$1 $2 $3" = "simctl listapps simulator-test" ]; then
  printf '%s\n' '{ "com.apple.mobilesafari" = { DataContainer = "file:///Users/runner/Library/private"; }; }'
elif [ "$1 $2 $3 $4" = "simctl spawn simulator-test launchctl" ]; then
  printf '%s\n' 'service = com.apple.SpringBoard' 'pid = 4242' 'state = running' 'SIMULATOR_HOST_HOME = /Users/runner/private-home'
elif [ "$1 $2 $3 $4" = "simctl io simulator-test screenshot" ]; then
  printf '%s' 'PNG-EVIDENCE' > "$5"
elif [ "$1 $2 $3 $4" = "simctl spawn simulator-test log" ]; then
  printf '%s\n' 'Maestro iOS driver waiting for XCTest bootstrap at /Users/runner/private-log http://127.0.0.1:4312/private-token'
else
  printf '%s\n' "unexpected xcrun command: $*" >&2
  exit 2
fi
`,
  );

  const previous = { path: process.env.PATH, log: process.env.FAKE_XCRUN_LOG };
  process.env.PATH = `${binaries}:${previous.path}`;
  process.env.FAKE_XCRUN_LOG = commandLog;
  let result;
  try {
    result = await collectFailureDiagnostics({
      diagnosticDirectory: artifacts,
      device: { platform: "ios", deviceId: "simulator-test" },
      error: Object.assign(new Error("hierarchy timed out"), { code: "E2E_COMMAND_TIMEOUT" }),
      iosReportsDirectory: reports,
      sinceMs: Date.now() - 1000,
      timeoutMs: 5000,
    });
  } finally {
    process.env.PATH = previous.path;
    if (previous.log === undefined) delete process.env.FAKE_XCRUN_LOG;
    else process.env.FAKE_XCRUN_LOG = previous.log;
  }

  assert.deepEqual(result, { complete: true });
  assert.match(readFileSync(join(artifacts, "host-simulator-devices.json"), "utf8"), /Booted/);
  const appServiceProbe = JSON.parse(
    readFileSync(join(artifacts, "device-app-service.probe.json"), "utf8"),
  );
  assert.ok(appServiceProbe.bytes > 0);
  assert.equal(existsSync(join(artifacts, "device-app-service.txt")), false);
  assert.match(readFileSync(join(artifacts, "springboard-service.json"), "utf8"), /"pid": 4242/);
  const safeProbeEvidence = [
    "host-simulator-devices.json",
    "device-app-service.probe.json",
    "springboard-service.json",
    "springboard-service.probe.json",
  ]
    .map((name) => readFileSync(join(artifacts, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(safeProbeEvidence, /Users\/runner|DataContainer|SIMULATOR_HOST_HOME/);
  assert.equal(readFileSync(join(artifacts, "springboard-screenshot.png"), "utf8"), "PNG-EVIDENCE");
  assert.match(
    readFileSync(join(artifacts, "simulator-system.log"), "utf8"),
    /Maestro iOS driver waiting for XCTest/,
  );
  assert.doesNotMatch(
    readFileSync(join(artifacts, "simulator-system.log"), "utf8"),
    /Users\/runner|127\.0\.0\.1|private-token/,
  );

  const screenshotMetadata = JSON.parse(
    readFileSync(join(artifacts, "springboard-screenshot.probe.json"), "utf8"),
  );
  assert.equal(screenshotMetadata.bytes, Buffer.byteLength("PNG-EVIDENCE"));
  assert.equal(screenshotMetadata.exitCode, 0);
  assert.equal(screenshotMetadata.signal, null);
  assert.equal(screenshotMetadata.timedOut, false);
  assert.equal(screenshotMetadata.retained, true);

  const commands = readFileSync(commandLog, "utf8");
  assert.match(commands, /^simctl list devices -j$/m);
  assert.match(commands, /launchctl print system\/com\.apple\.SpringBoard/);
  assert.match(commands, /log show .*process CONTAINS\[c\] "maestro"/);
  assert.match(commands, /log show .*process == "testmanagerd"/);
  assert.match(commands, /log show .*process == "PhotosUIService"/);
  assert.match(commands, /log show .*subsystem CONTAINS\[c\] "PhotoKit"/);
  assert.match(
    commands,
    /\(process == "SpringBoard" OR process CONTAINS\[c\] "CoreSimulator"\) AND \(/,
  );
  const predicate = commands.match(/--predicate (.+)$/m)?.[1] ?? "";
  assert.equal((predicate.match(/process == "backboardd"/g) ?? []).length, 1);
  assert.match(
    predicate,
    /process == "backboardd" AND \( eventMessage CONTAINS\[c\] "not responding"/,
  );
  assert.doesNotMatch(
    predicate,
    /process == "backboardd"[^)]*CONTAINS\[c\] "(?:failed|error|fault)"/,
  );
});

test("iOS readiness probe failures never replace the primary acceptance error", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-ios-probe-failure-");
  const binaries = join(directory, "bin");
  const artifacts = join(directory, "artifacts");
  const reports = join(directory, "reports");
  mkdirSync(binaries);
  mkdirSync(reports);
  writeExecutable(join(binaries, "xcrun"), "#!/bin/sh\nexit 9\n");
  const primaryError = Object.assign(new Error("hierarchy timed out"), {
    code: "E2E_COMMAND_TIMEOUT",
  });

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      withFailureDiagnostics({
        diagnosticDirectory: artifacts,
        device: { platform: "ios", deviceId: "simulator-test" },
        iosReportsDirectory: reports,
        operation: async () => {
          throw primaryError;
        },
        sinceMs: Date.now(),
      }),
      (error) => error === primaryError,
    );
  } finally {
    process.env.PATH = previousPath;
  }

  assert.match(
    readFileSync(join(artifacts, "failure-summary.txt"), "utf8"),
    /diagnostics: incomplete\noriginal error: hierarchy timed out/,
  );
  const metadata = JSON.parse(
    readFileSync(join(artifacts, "host-simulator-devices.probe.json"), "utf8"),
  );
  assert.equal(metadata.error, null);
  assert.equal(metadata.exitCode, 9);
  assert.equal(metadata.terminationError, null);
  assert.equal(metadata.timedOut, false);
});

test("iOS diagnostics preserve fresh relevant reports retired by macOS", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-ios-retired-diagnostics-");
  const binaries = join(directory, "bin");
  const reports = join(directory, "reports");
  const retiredReports = join(reports, "Retired");
  const nestedReports = join(retiredReports, "nested");
  const artifacts = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(nestedReports, { recursive: true });
  const startedAt = Date.now();
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
if [ "$1 $2 $3" = "simctl list devices" ]; then
  printf '%s\n' '{"devices":{"iOS 26.5":[{"udid":"simulator-test","state":"Booted"}]}}'
elif [ "$1 $2 $3" = "simctl listapps simulator-test" ]; then
  printf '%s\n' '{ "com.apple.mobilesafari" = {}; }'
elif [ "$1 $2 $3 $4" = "simctl spawn simulator-test launchctl" ]; then
  printf '%s\n' 'pid = 4242' 'state = running'
elif [ "$1" = simctl ] && [ "$2" = io ] && [ "$4" = screenshot ]; then
  printf '%s' 'PNG-EVIDENCE' > "$5"
fi
exit 0
`,
  );
  writeFileSync(join(reports, "PlogKit-current.ips"), "current app crash");
  writeFileSync(join(retiredReports, "PlogKit-retired.ips"), "retired app crash");
  writeFileSync(join(retiredReports, "Unrelated-retired.ips"), "unrelated crash");
  writeFileSync(join(retiredReports, "PlogKit-old.ips"), "old retired crash");
  writeFileSync(join(nestedReports, "PlogKit-deep.ips"), "deep retired crash");
  utimesSync(join(retiredReports, "PlogKit-old.ips"), new Date(0), new Date(0));

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  let result;
  try {
    result = await collectFailureDiagnostics({
      diagnosticDirectory: artifacts,
      device: { platform: "ios", deviceId: "simulator-test" },
      error: new Error("original iOS dyld failure"),
      iosReportsDirectory: reports,
      sinceMs: startedAt,
      timeoutMs: 2000,
    });
  } finally {
    process.env.PATH = previousPath;
  }

  assert.deepEqual(result, { complete: true });
  assert.equal(readFileSync(join(artifacts, "PlogKit-current.ips"), "utf8"), "current app crash");
  assert.equal(
    readFileSync(join(artifacts, "Retired", "PlogKit-retired.ips"), "utf8"),
    "retired app crash",
  );
  assert.equal(existsSync(join(artifacts, "Retired", "Unrelated-retired.ips")), false);
  assert.equal(existsSync(join(artifacts, "Retired", "PlogKit-old.ips")), false);
  assert.equal(existsSync(join(artifacts, "Retired", "nested", "PlogKit-deep.ips")), false);
  assert.match(
    readFileSync(join(artifacts, "failure-summary.txt"), "utf8"),
    /original error: original iOS dyld failure/,
  );
});

test("iOS diagnostics prioritize the newest reports across current and Retired under one cap", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-ios-report-cap-");
  const binaries = join(directory, "bin");
  const reports = join(directory, "reports");
  const retiredReports = join(reports, "Retired");
  const artifacts = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(retiredReports, { recursive: true });
  const startedAt = Date.now();
  const currentDate = new Date(startedAt);
  const newestDate = new Date(startedAt + 1000);
  writeExecutable(join(binaries, "xcrun"), "#!/bin/sh\nexit 0\n");
  for (let index = 0; index < 8; index += 1) {
    const report = join(reports, `PlogKit-current-${index}.ips`);
    writeFileSync(report, `current crash ${index}`);
    utimesSync(report, currentDate, currentDate);
  }
  const newestReport = join(retiredReports, "PlogKit-retired-latest.ips");
  writeFileSync(newestReport, "latest retired app crash");
  utimesSync(newestReport, newestDate, newestDate);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  let result;
  try {
    result = await collectFailureDiagnostics({
      diagnosticDirectory: artifacts,
      device: { platform: "ios", deviceId: "simulator-test" },
      error: "original failure",
      iosReportsDirectory: reports,
      sinceMs: startedAt,
      timeoutMs: 2000,
    });
  } finally {
    process.env.PATH = previousPath;
  }

  assert.deepEqual(result, { complete: false });
  assert.equal(
    readFileSync(join(artifacts, "Retired", "PlogKit-retired-latest.ips"), "utf8"),
    "latest retired app crash",
  );
  assert.equal(
    readdirSync(artifacts).filter((entry) => entry.endsWith(".ips")).length +
      readdirSync(join(artifacts, "Retired")).filter((entry) => entry.endsWith(".ips")).length,
    8,
  );
});

test("iOS report read and artifact write failures make diagnostics incomplete", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-ios-report-failure-");
  const binaries = join(directory, "bin");
  const reports = join(directory, "reports");
  const artifacts = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(reports);
  mkdirSync(artifacts);
  writeExecutable(join(binaries, "xcrun"), "#!/bin/sh\nexit 0\n");
  symlinkSync(join(reports, "missing.ips"), join(reports, "PlogKit-broken.ips"));
  writeFileSync(join(reports, "PlogKit-write.ips"), "crash report");
  mkdirSync(join(artifacts, "PlogKit-write.ips"));

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  let result;
  try {
    result = await collectFailureDiagnostics({
      diagnosticDirectory: artifacts,
      device: { platform: "ios", deviceId: "simulator-test" },
      error: "original iOS failure",
      iosReportsDirectory: reports,
      sinceMs: Date.now(),
      timeoutMs: 2000,
    });
  } finally {
    process.env.PATH = previousPath;
  }

  assert.deepEqual(result, { complete: false });
  assert.match(readFileSync(join(artifacts, "failure-summary.txt"), "utf8"), /incomplete/);
});
