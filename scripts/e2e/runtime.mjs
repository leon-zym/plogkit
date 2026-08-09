import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";

export function log(scope, message) {
  console.log(`[e2e:${scope}] ${message}`);
}

function commandError(command, args, result) {
  const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  return new Error(
    `Command failed (${result.status ?? "no exit code"}): ${command} ${args.join(" ")}${
      details ? `\n${details}` : ""
    }`,
  );
}

export function capture(
  command,
  args,
  { allowFailure = false, cwd, env = process.env, input, timeoutMs } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (result.error) {
    if (allowFailure) return null;
    throw result.error;
  }
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw commandError(command, args, result);
  }
  return result.stdout.trim();
}

export async function endWritable(stream) {
  const completion = finished(stream, { cleanup: true });
  stream.end();
  await completion;
}

export function run(
  command,
  args,
  { cleanup, cwd, env = process.env, input, outputPath, stdio = "inherit" } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: outputPath ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : stdio,
    });
    const output = outputPath ? createWriteStream(outputPath, { flags: "w" }) : null;
    if (output) {
      for (const [stream, destination] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ]) {
        if (stdio !== "ignore") stream.pipe(destination, { end: false });
        stream.pipe(output, { end: false });
      }
    }
    cleanup?.add(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    let finalizing = false;
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const failOutput = (error) => {
      if (settled) return;
      if (child.exitCode === null) child.kill("SIGTERM");
      settle(() =>
        reject(
          new Error(`Unable to write command output to ${outputPath}: ${error.message}`, {
            cause: error,
          }),
        ),
      );
    };
    const finish = (callback) => {
      if (settled || finalizing) return;
      if (output && !output.destroyed) {
        finalizing = true;
        void endWritable(output).then(() => settle(callback), failOutput);
      } else {
        settle(callback);
      }
    };
    output?.once("error", failOutput);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(
            new Error(
              `Command failed (${code ?? signal ?? "unknown"}): ${command} ${args.join(" ")}`,
            ),
          );
        }
      });
    });
    if (input !== undefined && child.stdin) child.stdin.end(input);
  });
}

export async function waitUntil(check, timeoutMs, description, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

export function createCleanupManager() {
  const tasks = [];
  let cleanupPromise = null;
  return {
    add(task) {
      tasks.push(task);
    },
    run() {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        for (const task of tasks.reverse()) {
          try {
            await task();
          } catch (error) {
            console.error(`[e2e:cleanup] ${String(error)}`);
          }
        }
      })();
      return cleanupPromise;
    },
  };
}

export function installSignalHandlers(cleanup) {
  let handlingSignal = false;
  const handle = (exitCode) => {
    if (handlingSignal) return;
    handlingSignal = true;
    void cleanup.run().finally(() => process.exit(exitCode));
  };
  process.once("SIGINT", () => handle(130));
  process.once("SIGTERM", () => handle(143));
}

export function createArtifactRoot() {
  const configured = process.env.E2E_ARTIFACTS_DIR;
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const directory = configured ? resolve(configured) : join(tmpdir(), "plogkit-maestro", timestamp);
  mkdirSync(directory, { recursive: true });
  return directory;
}

const MAESTRO_MIN_VERSION = "2.7.0";

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

export function validateMaestroVersion() {
  let output;
  try {
    output = capture("maestro", ["--version"]);
  } catch {
    throw new Error(
      `Maestro ${MAESTRO_MIN_VERSION} or newer is required but was not found on PATH.`,
    );
  }
  const installedVersion = output.match(/\d+\.\d+\.\d+/)?.[0];
  if (!installedVersion) {
    throw new Error(`Unable to determine the installed Maestro version from: ${output}`);
  }
  if (compareVersions(installedVersion, MAESTRO_MIN_VERSION) < 0) {
    log(
      "setup",
      `Maestro ${installedVersion} is older than the minimum supported version ${MAESTRO_MIN_VERSION}; flows are verified on ${MAESTRO_MIN_VERSION} or newer.`,
    );
  }
}

function portIsOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once("error", () => resolvePromise(false));
  });
}

export async function assertMetroPortAvailable() {
  if (await portIsOpen(8081)) {
    throw new Error(
      "Port 8081 is already in use. Stop the existing Metro or other service before running E2E.",
    );
  }
}

async function metroIsHealthy() {
  try {
    const response = await fetch("http://127.0.0.1:8081/status", {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.text()).trim() === "packager-status:running";
  } catch {
    return false;
  }
}

function writeMetroPrewarmTimeline(artifactRoot, platform, timeline) {
  try {
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(
      join(artifactRoot, `metro-${platform}-prewarm.json`),
      `${JSON.stringify(timeline, null, 2)}\n`,
    );
  } catch {
    // Timeline capture is best-effort and must preserve the transport or bundle failure.
  }
}

function metroPrewarmError(category, phase, error) {
  const detail = error instanceof Error ? error.message : String(error);
  const failure = new Error(`Metro ${phase} prewarm failed [${category}]: ${detail}`, {
    cause: error,
  });
  failure.category = category;
  return failure;
}

export async function prewarmMetroBundle({
  artifactRoot,
  baseUrl = "http://127.0.0.1:8081",
  platform,
  timeoutMs = 120000,
}) {
  const startedAt = new Date();
  const timeline = {
    platform,
    manifestUrl: `${baseUrl.replace(/\/$/, "")}/`,
    startedAt: startedAt.toISOString(),
  };
  const signal = AbortSignal.timeout(timeoutMs);
  let phase = "manifest";
  try {
    const manifestResponse = await fetch(timeline.manifestUrl, {
      headers: {
        accept: "application/expo+json",
        "expo-platform": platform,
      },
      signal,
    });
    if (!manifestResponse.ok) {
      throw new Error(`HTTP ${manifestResponse.status} from ${timeline.manifestUrl}`);
    }
    const manifest = await manifestResponse.json();
    const bundleUrl = manifest?.launchAsset?.url;
    if (typeof bundleUrl !== "string") {
      throw new Error("Expo manifest does not contain launchAsset.url");
    }
    const manifestOrigin = new URL(timeline.manifestUrl).origin;
    if (new URL(bundleUrl).origin !== manifestOrigin) {
      throw new Error(`Expo manifest bundle URL is not owned by ${manifestOrigin}`);
    }
    timeline.manifestReadyAt = new Date().toISOString();
    timeline.bundleUrl = bundleUrl;

    phase = "bundle";
    const bundleResponse = await fetch(bundleUrl, {
      headers: {
        accept: "application/javascript",
        "expo-platform": platform,
      },
      signal,
    });
    if (!bundleResponse.ok) {
      throw new Error(`HTTP ${bundleResponse.status} from ${bundleUrl}`);
    }
    let bundleBytes = 0;
    if (bundleResponse.body) {
      for await (const chunk of bundleResponse.body) bundleBytes += chunk.byteLength;
    }
    timeline.bundleBytes = bundleBytes;
    timeline.bundleReadyAt = new Date().toISOString();
    writeMetroPrewarmTimeline(artifactRoot, platform, timeline);
    log("metro", `${platform} cold bundle ready (${bundleBytes} bytes): ${bundleUrl}`);
    return timeline;
  } catch (error) {
    const category = phase === "manifest" ? "metro-transport" : "metro-bundle";
    const failure = metroPrewarmError(category, phase, error);
    timeline.category = category;
    timeline.error = failure.message;
    timeline.failedAt = new Date().toISOString();
    timeline.phase = phase;
    writeMetroPrewarmTimeline(artifactRoot, platform, timeline);
    try {
      const failureDirectory = join(artifactRoot, platform, "warmup");
      mkdirSync(failureDirectory, { recursive: true });
      appendFileSync(
        join(failureDirectory, "failure-summary.txt"),
        `category: ${category}\nerror: ${failure.message}\n`,
      );
    } catch {
      // Failure summary capture is best-effort and must preserve the prewarm failure.
    }
    throw failure;
  }
}

export function createMetroFailureSignal(logPath, onFailure = () => {}) {
  let outputTail = "";
  let resolveFailure;
  let settled = false;
  let stopping = false;
  const failure = new Promise((resolvePromise) => {
    resolveFailure = resolvePromise;
  });
  const fail = (detail, cause) => {
    if (settled || stopping) return;
    settled = true;
    const error = new Error(`Owned Metro transport failed: ${detail}. See ${logPath}`, {
      cause,
    });
    error.category = "metro-transport";
    onFailure(error);
    resolveFailure(error);
  };
  return {
    failure,
    markStopping() {
      stopping = true;
    },
    observeError(error) {
      fail(error instanceof Error ? error.message : String(error), error);
    },
    observeExit(code, signal) {
      fail(`process exited (${code ?? signal ?? "unknown"})`);
    },
    observeOutput(chunk) {
      outputTail = `${outputTail}${String(chunk)}`.slice(-512);
      if (/ERR_STREAM_PREMATURE_CLOSE/i.test(outputTail)) {
        fail("ERR_STREAM_PREMATURE_CLOSE");
      }
    },
  };
}

export async function startMetro({ artifactRoot, cleanup, root }) {
  const logPath = join(artifactRoot, "metro.log");
  const lifecyclePath = join(artifactRoot, "metro-lifecycle.json");
  const lifecycleTimeline = {
    command: `${process.execPath} --dns-result-order=ipv4first ./node_modules/expo/bin/cli start --dev-client --localhost`,
    expoCliVersion: capture(process.execPath, ["./node_modules/expo/bin/cli", "--version"], {
      allowFailure: true,
      cwd: root,
    }),
    logPath,
    nodeVersion: process.version,
    port: 8081,
    startedAt: new Date().toISOString(),
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  };
  const writeLifecycleTimeline = () => {
    try {
      writeFileSync(lifecyclePath, `${JSON.stringify(lifecycleTimeline, null, 2)}\n`);
    } catch {
      // Lifecycle capture is best-effort and must not replace the Metro result.
    }
  };
  const logStream = createWriteStream(logPath, { flags: "w" });
  const lifecycle = createMetroFailureSignal(logPath, (error) => {
    lifecycleTimeline.category = error.category;
    lifecycleTimeline.error = error.message;
    lifecycleTimeline.failedAt = new Date().toISOString();
    lifecycleTimeline.status = "failed";
    writeLifecycleTimeline();
    try {
      appendFileSync(
        join(artifactRoot, "metro-failure-summary.txt"),
        `category: ${error.category}\nerror: ${error.message}\n`,
      );
    } catch {
      // Shared failure summary capture is best-effort.
    }
  });
  log("metro", `Starting an owned Metro server; log: ${logPath}`);
  const child = spawn(
    process.execPath,
    [
      "--dns-result-order=ipv4first",
      "./node_modules/expo/bin/cli",
      "start",
      "--dev-client",
      "--localhost",
    ],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  lifecycleTimeline.pid = child.pid;
  lifecycleTimeline.status = "starting";
  writeLifecycleTimeline();
  let cleanupStarted = false;
  const childExited = new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => {
      lifecycle.observeExit(code, signal);
      lifecycleTimeline.exitAt = new Date().toISOString();
      lifecycleTimeline.exitCode = code;
      lifecycleTimeline.exitSignal = signal;
      lifecycleTimeline.status = cleanupStarted ? "stopped" : "failed";
      writeLifecycleTimeline();
      resolvePromise();
    });
  });
  const childClosed = new Promise((resolvePromise) => child.once("close", resolvePromise));
  const childIsRunning = () => child.exitCode === null && child.signalCode === null;
  for (const [stream, destination] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.on("data", (chunk) => {
      lifecycle.observeOutput(chunk);
      destination.write(chunk);
      logStream.write(chunk);
    });
  }
  child.once("error", (error) => {
    lifecycle.observeError(error);
    console.error(`[e2e:metro] ${String(error)}`);
  });
  cleanup.add(async () => {
    cleanupStarted = true;
    lifecycle.markStopping();
    lifecycleTimeline.stoppingAt = new Date().toISOString();
    lifecycleTimeline.status = "stopping";
    writeLifecycleTimeline();
    if (childIsRunning()) {
      log("metro", "Stopping Metro.");
      child.kill("SIGINT");
      await Promise.race([
        childExited,
        new Promise((resolvePromise) => setTimeout(resolvePromise, 10000)),
      ]);
      if (childIsRunning()) {
        child.kill("SIGTERM");
        await Promise.race([
          childExited,
          new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
        ]);
      }
      if (childIsRunning()) child.kill("SIGKILL");
    }
    await Promise.race([
      childClosed,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 2000)),
    ]);
    await new Promise((resolvePromise) => logStream.end(resolvePromise));
  });
  await waitUntil(
    async () => {
      if (!childIsRunning()) throw new Error(`Metro exited early. See ${logPath}`);
      return metroIsHealthy();
    },
    60000,
    "Metro to become healthy on 127.0.0.1:8081",
  );
  lifecycleTimeline.healthyAt = new Date().toISOString();
  lifecycleTimeline.status = "healthy";
  writeLifecycleTimeline();
  return { failure: lifecycle.failure };
}

async function runMaestro({ artifactRoot, cleanup, device, kind, root, target }) {
  const outputDirectory = join(artifactRoot, device.platform, kind);
  const startedAtMs = Date.now();
  mkdirSync(outputDirectory, { recursive: true });
  log(
    device.platform,
    `${kind === "warmup" ? "Warming the app" : "Running Maestro flows"} on ${device.deviceId}; artifacts: ${outputDirectory}`,
  );
  try {
    await run(
      "pnpm",
      [
        "exec",
        "maestro",
        "--device",
        device.deviceId,
        "test",
        `--test-output-dir=${outputDirectory}`,
        target,
      ],
      { cleanup, cwd: root, outputPath: join(outputDirectory, "runner-output.log") },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const evidence = [
      message,
      readArtifactEvidence(outputDirectory),
      readTextEvidence(join(artifactRoot, "metro.log")),
    ].join("\n");
    const category = classifyFailure(evidence);
    await collectFailureDiagnostics({
      diagnosticDirectory: outputDirectory,
      device,
      error: message,
      kind: category,
      sinceMs: startedAtMs,
    });
    const label = kind === "warmup" ? "Warm-up" : "Maestro flow";
    const failure = new Error(`${label} failed [${category}]: ${message}`, { cause: error });
    failure.category = category;
    throw failure;
  }
}

export function warmUpApp(options) {
  return runMaestro({
    ...options,
    kind: "warmup",
    target: "e2e/subflows/warmup.yaml",
  });
}

const SUITE_ABORT_CATEGORIES = new Set(["metro-transport", "metro-bundle", "system-ui"]);

export function shouldAbortMaestroSuite(category) {
  return SUITE_ABORT_CATEGORIES.has(category);
}

export async function runMaestroSuite(options) {
  const { artifactRoot, cleanup, device, flow, root } = options;

  if (flow) {
    const target = `e2e/flows/${flow}.yaml`;
    return runMaestro({ artifactRoot, cleanup, device, kind: "flows", root, target });
  }

  // Isolate each flow in a separate maestro invocation so that a single
  // XCTest hierarchy failure or driver error cannot cascade and cause
  // subsequent independent flows to falsely report an app crash.
  const flowsDir = resolve(root, "e2e", "flows");
  const flowFiles = readdirSync(flowsDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();

  const failures = [];
  for (const flowFile of flowFiles) {
    const flowName = flowFile.replace(/\.yaml$/, "");
    const target = resolve(flowsDir, flowFile);
    try {
      await runMaestro({
        artifactRoot,
        cleanup,
        device,
        kind: `flows/${flowName}`,
        root,
        target,
      });
      log(device.platform, `Flow ${flowName} passed.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const category = error?.category ?? "business-assertion";
      log(device.platform, `Flow ${flowName} FAILED [${category}]: ${message}`);
      failures.push({ flow: flowName, error: message, category });
      if (shouldAbortMaestroSuite(category)) throw error;
      // A new Maestro process isolates the remaining flow-local failures.
    }
  }

  if (failures.length > 0) {
    const summary = failures.map((f) => `  ${f.flow} [${f.category}]`).join("\n");
    throw new Error(
      `${failures.length}/${flowFiles.length} flows failed:\n${summary}\n` +
        "See per-flow artifact directories for details.",
    );
  }
}

const APP_CRASH_PATTERNS =
  /\b(app\s+(stopped|not\s+running|crash)|FATAL\s+EXCEPTION|AndroidRuntime|SIGABRT|SIGSEGV|EXC_CRASH|EXC_BAD_ACCESS)\b/i;
const XCTEST_DRIVER_PATTERNS =
  /\b(kAXErrorInvalidUIElement|AXErrorInvalidUIElement|hierarchy\s+(failed|error)|cannot\s+determine\s+UI)\b|\bXCTest.{0,100}\b(failed|error|timed?\s*out|unavailable)\b/i;
const BENIGN_XCTEST_PENDING_RECORD_PATTERN =
  /\bXCTestDriver:\s+Recorded pending request for target session\b.*\btimeout\b/i;
const XCTEST_FAILURE_TERMS = /\b(failed|error|timed\s*out|unavailable)\b/i;
const METRO_EXPLICIT_TRANSPORT_FAILURE_PATTERN =
  /\b(?:ERR_STREAM_PREMATURE_CLOSE|ECONNREFUSED(?:\s+127\.0\.0\.1)?:8081)\b/i;
const METRO_PROCESS_FAILURE_PATTERNS =
  /\b(?:Metro|packager).{0,100}\b(?:exited|failed|error|unavailable|not\s+running)\b|\b(?:exited|failed|error|unavailable).{0,100}\b(?:Metro|packager)\b/i;
const METRO_BUNDLE_FAILURE_PATTERN = /\bbundling\s+failed\b/i;
const COLD_BUNDLE_PROGRESS_PATTERN = /\bBundling\s+\d{1,3}%/i;
const WARMUP_HOME_SCREEN_FAILURE_PATTERN =
  /\bAssertion is false:\s*(?:id:\s*)?home-screen is visible\b/i;
const SYSTEM_UI_PATTERNS =
  /\b(System\s+UI\s+(?:(?:isn['’]t|is\s+not)\s+responding|has\s+stopped)|Application\s+Not\s+Responding:\s*System\s+UI|AppNotRespondingDialog|android:id\/aerr_(?:close|wait)|device\s+(offline|not\s+found)|simulator\s+(unavailable|failed|error)|emulator\s+(exited|failed))\b|(?:ANR|not\s+responding).{0,100}com\.android\.systemui|com\.android\.systemui.{0,100}(?:ANR|not\s+responding)/i;
const BUSINESS_ASSERTION_PATTERNS =
  /\b(Assertion is false|No visible element found|Could not find a visible element matching selector)\b/i;

const TEXT_ARTIFACT_EXTENSIONS = /\.(json|log|txt|xml|yaml|yml)$/i;

function readTextEvidence(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readArtifactEvidence(directory) {
  if (!existsSync(directory)) return "";
  const evidence = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && TEXT_ARTIFACT_EXTENSIONS.test(entry.name)) {
        try {
          evidence.push(readFileSync(entryPath, "utf8"));
        } catch {
          // Failure classification is best-effort and must preserve the original error.
        }
      }
    }
  };
  visit(directory);
  return evidence.join("\n");
}

function withoutBenignXCTestPendingRecords(message) {
  return message
    .split(/\r?\n/)
    .filter(
      (line) => !BENIGN_XCTEST_PENDING_RECORD_PATTERN.test(line) || XCTEST_FAILURE_TERMS.test(line),
    )
    .join("\n");
}

export function classifyFailure(message) {
  if (METRO_EXPLICIT_TRANSPORT_FAILURE_PATTERN.test(message)) {
    return "metro-transport";
  }
  if (
    METRO_BUNDLE_FAILURE_PATTERN.test(message) ||
    (COLD_BUNDLE_PROGRESS_PATTERN.test(message) && WARMUP_HOME_SCREEN_FAILURE_PATTERN.test(message))
  ) {
    return "metro-bundle";
  }
  if (METRO_PROCESS_FAILURE_PATTERNS.test(message)) return "metro-transport";
  if (SYSTEM_UI_PATTERNS.test(message)) return "system-ui";
  if (XCTEST_DRIVER_PATTERNS.test(withoutBenignXCTestPendingRecords(message))) {
    return "xctest-driver";
  }
  if (APP_CRASH_PATTERNS.test(message)) return "app-crash";
  if (BUSINESS_ASSERTION_PATTERNS.test(message)) return "business-assertion";
  return "business-assertion";
}

const DIAGNOSTIC_REPORT_EXTENSION = /\.(ips|crash|diag)$/i;
const RELEVANT_DIAGNOSTIC_REPORT =
  /(PlogKit|Maestro|XCTest|XCTRunner|SpringBoard|backboardd|CoreSimulator)/i;
const DIAGNOSTIC_CLOCK_SKEW_MS = 5000;

export function copyRelevantDiagnosticReports({ destinationDirectory, reportsDirectory, sinceMs }) {
  if (!existsSync(reportsDirectory)) return;
  for (const entry of readdirSync(reportsDirectory)) {
    if (!DIAGNOSTIC_REPORT_EXTENSION.test(entry) || !RELEVANT_DIAGNOSTIC_REPORT.test(entry)) {
      continue;
    }
    const source = join(reportsDirectory, entry);
    try {
      if (statSync(source).mtimeMs < sinceMs - DIAGNOSTIC_CLOCK_SKEW_MS) continue;
      copyFileSync(source, join(destinationDirectory, entry));
    } catch {
      // One unreadable or concurrently removed report must not hide the remaining evidence.
    }
  }
}

export async function collectFailureDiagnostics({
  diagnosticDirectory: diagDir,
  device,
  error,
  kind,
  sinceMs = Date.now(),
}) {
  try {
    mkdirSync(diagDir, { recursive: true });
    // Always save the failure classification and error message.
    appendFileSync(join(diagDir, "failure-summary.txt"), `category: ${kind}\nerror: ${error}\n`);
  } catch {
    // Diagnostics are best-effort and must never replace the original E2E failure.
    return;
  }

  // Collect platform-specific crash and system UI diagnostics.
  if (
    kind === "app-crash" ||
    kind === "metro-bundle" ||
    kind === "metro-transport" ||
    kind === "xctest-driver" ||
    kind === "system-ui"
  ) {
    if (device.platform === "ios") {
      try {
        const reportsDir = join(homedir(), "Library", "Logs", "DiagnosticReports");
        copyRelevantDiagnosticReports({
          destinationDirectory: diagDir,
          reportsDirectory: reportsDir,
          sinceMs,
        });

        // Capture the simulator system log if the device is still reachable.
        const log = capture(
          "xcrun",
          ["simctl", "spawn", device.deviceId, "log", "show", "--last", "30s"],
          { allowFailure: true, timeoutMs: 15000 },
        );
        if (log) appendFileSync(join(diagDir, "simulator-system.log"), log);
      } catch {
        // Diagnostic collection is best-effort.
      }
    } else {
      try {
        // Capture logcat buffer for crash analysis.
        const logcat = capture("adb", ["-s", device.deviceId, "logcat", "-d", "-t", "4000"], {
          allowFailure: true,
          timeoutMs: 15000,
        });
        if (logcat) appendFileSync(join(diagDir, "logcat.txt"), logcat);

        // Capture ANR traces if any.
        const anr = capture(
          "adb",
          ["-s", device.deviceId, "shell", "cat", "/data/anr/traces.txt"],
          { allowFailure: true, timeoutMs: 15000 },
        );
        if (anr) appendFileSync(join(diagDir, "anr-traces.txt"), anr);

        capture("adb", ["-s", device.deviceId, "pull", "/data/anr", join(diagDir, "anr")], {
          allowFailure: true,
          timeoutMs: 15000,
        });
      } catch {
        // Diagnostic collection is best-effort.
      }
    }
  }
}
