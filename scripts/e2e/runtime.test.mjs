import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import {
  capture,
  classifyFailure,
  collectFailureDiagnostics,
  copyRelevantDiagnosticReports,
  endWritable,
  run,
  runMaestroSuite,
  shouldAbortMaestroSuite,
  warmUpApp,
} from "./runtime.mjs";

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test("capture bounds an unresponsive diagnostic command", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-timeout-"));
  const command = join(directory, "hang");
  writeExecutable(command, "#!/bin/sh\nsleep 1\n");

  const startedAt = Date.now();
  const result = capture(command, [], { allowFailure: true, timeoutMs: 50 });

  assert.equal(result, null);
  assert.ok(Date.now() - startedAt < 500);
});

test("capture preserves bounded multi-megabyte diagnostic output", () => {
  const result = capture(process.execPath, ["-e", 'process.stdout.write("x".repeat(2_000_000))']);
  assert.equal(result.length, 2_000_000);
});

test("run preserves complete command output beyond the writable high-water mark", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-command-output-"));
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

test("run rejects an artifact write failure without an uncaught stream error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-command-write-error-"));

  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      outputPath: join(directory, "missing", "command.log"),
      stdio: "ignore",
    }),
    /Unable to write command output/,
  );
});

test("final writable flush failures are propagated", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      callback(new Error("final flush failed"));
    },
  });
  output.write("evidence");

  await assert.rejects(endWritable(output), /final flush failed/);
});

test("suite abort policy distinguishes shared infrastructure from flow-local failures", () => {
  assert.equal(shouldAbortMaestroSuite("metro-transport"), true);
  assert.equal(shouldAbortMaestroSuite("metro-bundle"), true);
  assert.equal(shouldAbortMaestroSuite("system-ui"), true);
  assert.equal(shouldAbortMaestroSuite("xctest-driver"), false);
  assert.equal(shouldAbortMaestroSuite("app-crash"), false);
  assert.equal(shouldAbortMaestroSuite("business-assertion"), false);
});

test("Maestro suite stops after a shared infrastructure failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-suite-abort-"));
  const binaries = join(directory, "bin");
  const flows = join(directory, "e2e", "flows");
  const invocationLog = join(directory, "invocations.log");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "f00-first.yaml"), "appId: test\n---\n");
  writeFileSync(join(flows, "f01-second.yaml"), "appId: test\n---\n");
  writeExecutable(
    join(binaries, "pnpm"),
    `#!/bin/sh
for argument in "$@"; do target="$argument"; done
printf '%s\n' "$target" >> "$FAKE_INVOCATION_LOG"
printf '%s\n' 'Metro bundling failed' >&2
exit 1
`,
  );
  const previousPath = process.env.PATH;
  const previousInvocationLog = process.env.FAKE_INVOCATION_LOG;
  process.env.PATH = `${binaries}:${previousPath}`;
  process.env.FAKE_INVOCATION_LOG = invocationLog;
  try {
    await assert.rejects(
      runMaestroSuite({
        artifactRoot: join(directory, "artifacts"),
        cleanup: { add() {} },
        device: { platform: "android", deviceId: "emulator-test" },
        flow: null,
        root: directory,
      }),
      /Maestro flow failed \[metro-bundle\]/,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousInvocationLog === undefined) delete process.env.FAKE_INVOCATION_LOG;
    else process.env.FAKE_INVOCATION_LOG = previousInvocationLog;
  }

  assert.equal(readFileSync(invocationLog, "utf8").trim().split("\n").length, 1);
});

test("Maestro suite continues after a flow-local assertion failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-suite-continue-"));
  const binaries = join(directory, "bin");
  const flows = join(directory, "e2e", "flows");
  const invocationLog = join(directory, "invocations.log");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "f00-first.yaml"), "appId: test\n---\n");
  writeFileSync(join(flows, "f01-second.yaml"), "appId: test\n---\n");
  writeExecutable(
    join(binaries, "pnpm"),
    `#!/bin/sh
for argument in "$@"; do target="$argument"; done
printf '%s\n' "$target" >> "$FAKE_INVOCATION_LOG"
case "$target" in
  *f00-first.yaml) printf '%s\n' 'Assertion is false' >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
  );

  const previousPath = process.env.PATH;
  const previousInvocationLog = process.env.FAKE_INVOCATION_LOG;
  process.env.PATH = `${binaries}:${previousPath}`;
  process.env.FAKE_INVOCATION_LOG = invocationLog;
  try {
    await assert.rejects(
      runMaestroSuite({
        artifactRoot: join(directory, "artifacts"),
        cleanup: { add() {} },
        device: { platform: "android", deviceId: "emulator-test" },
        flow: null,
        root: directory,
      }),
      /1\/2 flows failed/,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousInvocationLog === undefined) delete process.env.FAKE_INVOCATION_LOG;
    else process.env.FAKE_INVOCATION_LOG = previousInvocationLog;
  }

  assert.equal(readFileSync(invocationLog, "utf8").trim().split("\n").length, 2);
});

test("diagnostic write failures do not replace the original E2E failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-diagnostic-write-"));
  const blockingFile = join(directory, "not-a-directory");
  writeFileSync(blockingFile, "blocked");

  await assert.doesNotReject(
    collectFailureDiagnostics({
      diagnosticDirectory: join(blockingFile, "diagnostics"),
      device: { platform: "ios", deviceId: "simulator-test" },
      error: "original Maestro failure",
      kind: "xctest-driver",
    }),
  );
});

test("failure classification covers Metro, app crashes, and root-cause priority", () => {
  assert.equal(classifyFailure("Metro bundling failed"), "metro-bundle");
  assert.equal(classifyFailure("FATAL EXCEPTION: main\nAndroidRuntime"), "app-crash");
  assert.equal(
    classifyFailure("XCTest failed with kAXErrorInvalidUIElement\napp stopped"),
    "xctest-driver",
  );
  assert.equal(classifyFailure("System UI isn't responding\nFATAL EXCEPTION: main"), "system-ui");
});

test("a real XCTest timeout remains a driver failure", () => {
  assert.equal(
    classifyFailure("XCTest timed out waiting for the application to become idle"),
    "xctest-driver",
  );
});

test("explicit XCTestDriver failures remain driver failures", async (context) => {
  const cases = [
    ["communication failure", "XCTestDriver failed to communicate with testmanagerd"],
    ["driver timeout", "XCTestDriver timed out waiting for the target session"],
    ["driver unavailable", "XCTestDriver unavailable while resolving the hierarchy"],
    [
      "failed pending request",
      "XCTestDriver: Recorded pending request for target session <session> with timeout 120.0; failed to communicate",
    ],
  ];

  for (const [name, evidence] of cases) {
    await context.test(name, () => {
      assert.equal(classifyFailure(evidence), "xctest-driver");
    });
  }
});

test("an XCTest pending-request record is not itself a driver failure", () => {
  const benignXCTestArtifact = [
    "XCTestDriver: Recorded pending request for target session <session> with timeout 120.0",
    "Assertion is false: id: home-screen is visible",
  ].join("\n");

  assert.equal(classifyFailure(benignXCTestArtifact), "business-assertion");
});

test("a cold-bundle warm-up is classified as Metro infrastructure", () => {
  const coldBundleArtifact = [
    "XCTestDriver: Recorded pending request for target session <session> with timeout 120.0",
    "Bundling 71%…",
    "Assertion is false: id: home-screen is visible",
  ].join("\n");

  assert.equal(classifyFailure(coldBundleArtifact), "metro-bundle");
});

test("bundle progress alone does not override an unrelated business assertion", () => {
  assert.equal(
    classifyFailure("Bundling 71%…\nAssertion is false: id: editor-canvas is visible"),
    "business-assertion",
  );
});

test("a premature-close signature takes priority over benign XCTest session records", () => {
  const metroTransportArtifact = [
    "Error [ERR_STREAM_PREMATURE_CLOSE]: Premature close",
    "XCTestDriver: Recorded pending request for target session <session> with timeout 120.0",
    "Searching for development servers…",
    "Assertion is false: id: home-screen is visible",
  ].join("\n");

  assert.equal(classifyFailure(metroTransportArtifact), "metro-transport");
});

test("warm-up attributes a shared owned-Metro transport failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-metro-transport-"));
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  writeFileSync(
    join(artifactRoot, "metro.log"),
    "Error [ERR_STREAM_PREMATURE_CLOSE]: Premature close\n",
  );
  writeExecutable(
    join(binaries, "pnpm"),
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    --test-output-dir=*) output_dir="\${argument#--test-output-dir=}" ;;
  esac
done
run_dir="$output_dir/fake-run/warmup"
mkdir -p "$run_dir/screen-hierarchy"
printf '%s\n' '{"accessibilityText":"Searching for development servers..."}' > "$run_dir/screen-hierarchy/failed.json"
printf '%s\n' 'Assertion is false: id: home-screen is visible' >&2
exit 1
`,
  );
  writeExecutable(join(binaries, "xcrun"), "#!/bin/sh\nprintf '%s\\n' 'simulator transport log'\n");

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      warmUpApp({
        artifactRoot,
        cleanup: { add() {} },
        device: { platform: "ios", deviceId: "simulator-test" },
        root: directory,
      }),
      /Warm-up failed \[metro-transport\]/,
    );
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(
    readFileSync(join(artifactRoot, "ios", "warmup", "simulator-system.log"), "utf8"),
    "simulator transport log",
  );
});

test("iOS Metro prewarm resolves the manifest bundle and records its timeline", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      accept: request.headers.accept,
      platform: request.headers["expo-platform"],
      url: request.url,
    });
    if (request.url === "/") {
      const address = server.address();
      response.setHeader("content-type", "application/expo+json");
      response.end(
        JSON.stringify({
          launchAsset: {
            url: `http://127.0.0.1:${address.port}/node_modules/expo-router/entry.bundle?platform=ios`,
          },
        }),
      );
      return;
    }
    response.setHeader("content-type", "application/javascript");
    response.end("globalThis.__PLOGKIT_PREWARM__ = true;\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-metro-prewarm-"));
  const address = server.address();
  try {
    const { prewarmMetroBundle } = await import("./runtime.mjs");
    await prewarmMetroBundle({
      artifactRoot: directory,
      baseUrl: `http://127.0.0.1:${address.port}`,
      platform: "ios",
      timeoutMs: 1000,
    });
  } finally {
    server.close();
    await once(server, "close");
  }

  assert.deepEqual(requests, [
    {
      accept: "application/expo+json",
      platform: "ios",
      url: "/",
    },
    {
      accept: "application/javascript",
      platform: "ios",
      url: "/node_modules/expo-router/entry.bundle?platform=ios",
    },
  ]);
  const timeline = JSON.parse(readFileSync(join(directory, "metro-ios-prewarm.json"), "utf8"));
  assert.equal(timeline.platform, "ios");
  assert.equal(timeline.bundleBytes, 39);
  assert.match(timeline.bundleUrl, /expo-router\/entry\.bundle\?platform=ios$/);
  assert.equal(typeof timeline.startedAt, "string");
  assert.equal(typeof timeline.manifestReadyAt, "string");
  assert.equal(typeof timeline.bundleReadyAt, "string");
});

test("iOS Metro prewarm records a manifest transport failure at the warm-up seam", async () => {
  const server = createServer((_request, response) => response.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-metro-manifest-failure-"));
  const address = server.address();
  try {
    const { prewarmMetroBundle } = await import("./runtime.mjs");
    await assert.rejects(
      prewarmMetroBundle({
        artifactRoot: directory,
        baseUrl: `http://127.0.0.1:${address.port}`,
        platform: "ios",
        timeoutMs: 1000,
      }),
      /Metro manifest prewarm failed \[metro-transport\]/,
    );
  } finally {
    server.close();
    await once(server, "close");
  }

  assert.match(
    readFileSync(join(directory, "ios", "warmup", "failure-summary.txt"), "utf8"),
    /category: metro-transport/,
  );
  const timeline = JSON.parse(readFileSync(join(directory, "metro-ios-prewarm.json"), "utf8"));
  assert.equal(timeline.category, "metro-transport");
  assert.equal(timeline.phase, "manifest");
});

test("iOS Metro prewarm records an incomplete cold bundle separately", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      const address = server.address();
      response.setHeader("content-type", "application/expo+json");
      response.end(
        JSON.stringify({
          launchAsset: {
            url: `http://127.0.0.1:${address.port}/entry.bundle?platform=ios`,
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/javascript" });
    response.write("partial bundle");
    response.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-metro-bundle-failure-"));
  const address = server.address();
  try {
    const { prewarmMetroBundle } = await import("./runtime.mjs");
    await assert.rejects(
      prewarmMetroBundle({
        artifactRoot: directory,
        baseUrl: `http://127.0.0.1:${address.port}`,
        platform: "ios",
        timeoutMs: 1000,
      }),
      /Metro bundle prewarm failed \[metro-bundle\]/,
    );
  } finally {
    server.close();
    await once(server, "close");
  }

  const summary = readFileSync(join(directory, "ios", "warmup", "failure-summary.txt"), "utf8");
  assert.match(summary, /category: metro-bundle/);
  const timeline = JSON.parse(readFileSync(join(directory, "metro-ios-prewarm.json"), "utf8"));
  assert.equal(timeline.category, "metro-bundle");
  assert.equal(timeline.phase, "bundle");
});

test("owned Metro lifecycle detects a fragmented premature-close signature", async () => {
  const { createMetroFailureSignal } = await import("./runtime.mjs");
  const lifecycle = createMetroFailureSignal("/artifacts/metro.log");

  lifecycle.observeOutput("Error [ERR_STREAM_PREMATURE_");
  lifecycle.observeOutput("CLOSE]: Premature close\n");

  const failure = await lifecycle.failure;
  assert.match(failure.message, /Owned Metro transport failed/);
  assert.match(failure.message, /ERR_STREAM_PREMATURE_CLOSE/);
  assert.match(failure.message, /\/artifacts\/metro\.log/);
});

test("iOS diagnostics copy only fresh relevant reports and isolate per-file failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-diagnostic-reports-"));
  const reports = join(directory, "reports");
  const destination = join(directory, "artifacts");
  mkdirSync(reports);
  mkdirSync(destination);
  const startedAt = Date.now();

  writeFileSync(join(reports, "PlogKit-fresh.ips"), "app crash");
  writeFileSync(join(reports, "MaestroDriver-fresh.crash"), "driver crash");
  writeFileSync(join(reports, "Unrelated-fresh.diag"), "unrelated");
  writeFileSync(join(reports, "PlogKit-old.ips"), "old app crash");
  utimesSync(join(reports, "PlogKit-old.ips"), new Date(0), new Date(0));
  symlinkSync(join(reports, "missing.ips"), join(reports, "PlogKit-broken.ips"));

  copyRelevantDiagnosticReports({
    destinationDirectory: destination,
    reportsDirectory: reports,
    sinceMs: startedAt,
  });

  assert.equal(readFileSync(join(destination, "PlogKit-fresh.ips"), "utf8"), "app crash");
  assert.equal(
    readFileSync(join(destination, "MaestroDriver-fresh.crash"), "utf8"),
    "driver crash",
  );
  assert.equal(existsSync(join(destination, "Unrelated-fresh.diag")), false);
  assert.equal(existsSync(join(destination, "PlogKit-old.ips")), false);
});

test("warm-up classifies System UI failures from Maestro artifacts and saves diagnostics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-runtime-"));
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const adbLog = join(directory, "adb-commands.log");
  mkdirSync(binaries);

  writeExecutable(
    join(binaries, "pnpm"),
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    --test-output-dir=*) output_dir="\${argument#--test-output-dir=}" ;;
  esac
done
run_dir="$output_dir/fake-run/warmup"
mkdir -p "$run_dir/screen-hierarchy"
printf '%s' '{"text":"System UI isn'"'"'t responding","resource-id":"android:id/aerr_wait"}' > "$run_dir/screen-hierarchy/failed.json"
printf '%s\n' 'Maestro command failed' >&2
exit 1
`,
  );
  writeExecutable(
    join(binaries, "adb"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
if [ "$3" = "logcat" ]; then
  printf '%s\n' 'system-ui logcat evidence'
elif [ "$3" = "pull" ]; then
  mkdir -p "$5"
  printf '%s\n' 'system_server anr trace' > "$5/anr_001"
fi
`,
  );

  const previousPath = process.env.PATH;
  const previousAdbLog = process.env.FAKE_ADB_LOG;
  process.env.PATH = `${binaries}:${previousPath}`;
  process.env.FAKE_ADB_LOG = adbLog;
  try {
    await assert.rejects(
      warmUpApp({
        artifactRoot,
        cleanup: { add() {} },
        device: { platform: "android", deviceId: "emulator-test" },
        root: directory,
      }),
      /Warm-up failed \[system-ui\]/,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousAdbLog === undefined) delete process.env.FAKE_ADB_LOG;
    else process.env.FAKE_ADB_LOG = previousAdbLog;
  }

  const diagnosticDirectory = join(artifactRoot, "android", "warmup");
  assert.match(
    readFileSync(join(diagnosticDirectory, "failure-summary.txt"), "utf8"),
    /category: system-ui/,
  );
  assert.equal(
    readFileSync(join(diagnosticDirectory, "logcat.txt"), "utf8").trim(),
    "system-ui logcat evidence",
  );
  assert.equal(
    readFileSync(join(diagnosticDirectory, "anr", "anr_001"), "utf8").trim(),
    "system_server anr trace",
  );
});

test("warm-up classifies a failure from captured Maestro process output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-output-"));
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);

  writeExecutable(
    join(binaries, "pnpm"),
    `#!/bin/sh
printf '%s\n' "System UI isn't responding" >&2
exit 1
`,
  );
  writeExecutable(join(binaries, "adb"), "#!/bin/sh\nexit 0\n");

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      warmUpApp({
        artifactRoot,
        cleanup: { add() {} },
        device: { platform: "android", deviceId: "emulator-test" },
        root: directory,
      }),
      /Warm-up failed \[system-ui\]/,
    );
  } finally {
    process.env.PATH = previousPath;
  }

  assert.equal(
    readFileSync(join(artifactRoot, "android", "warmup", "runner-output.log"), "utf8").trim(),
    "System UI isn't responding",
  );
});

test("a benign XCTest session log does not turn a business assertion into a driver failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-xctest-log-"));
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);

  writeExecutable(
    join(binaries, "pnpm"),
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    --test-output-dir=*) output_dir="\${argument#--test-output-dir=}" ;;
  esac
done
run_dir="$output_dir/fake-run/warmup"
mkdir -p "$run_dir/logs"
printf '%s\n' \
  'XCTest session started successfully' \
  'sharingd: System UI Changed 0x0, CanTrigger yes' \
  'XCTAS Error: Error getting main window Unknown kAXError value -25218' \
  'XCTest session recovered and returned a valid hierarchy' \
  > "$run_dir/logs/xctest_runner.log"
printf '%s\n' '{"initialUrl":"http://localhost:8081"}' > "$run_dir/commands.json"
printf '%s\n' 'Assertion is false: id: home-screen is visible' >&2
exit 1
`,
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      warmUpApp({
        artifactRoot,
        cleanup: { add() {} },
        device: { platform: "ios", deviceId: "simulator-test" },
        root: directory,
      }),
      /Warm-up failed \[business-assertion\]/,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("an invalid XCTest UI element remains the root cause when a generic assertion also fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-e2e-invalid-ui-element-"));
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);

  writeExecutable(
    join(binaries, "pnpm"),
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    --test-output-dir=*) output_dir="\${argument#--test-output-dir=}" ;;
  esac
done
run_dir="$output_dir/fake-run/warmup"
mkdir -p "$run_dir/logs"
printf '%s\n' 'XCTest failed with kAXErrorInvalidUIElement while reading hierarchy' > "$run_dir/logs/xctest_runner.log"
printf '%s\n' 'Assertion is false: id: home-screen is visible' >&2
exit 1
`,
  );
  writeExecutable(join(binaries, "xcrun"), "#!/bin/sh\nexit 0\n");

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      warmUpApp({
        artifactRoot,
        cleanup: { add() {} },
        device: { platform: "ios", deviceId: "simulator-test" },
        root: directory,
      }),
      /Warm-up failed \[xctest-driver\]/,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});
