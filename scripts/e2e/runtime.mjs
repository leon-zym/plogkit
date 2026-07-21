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

const MAESTRO_CI_BASELINE = "2.7.0";

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
      `Maestro ${MAESTRO_CI_BASELINE} or newer is required but was not found on PATH.`,
    );
  }
  const installedVersion = output.match(/\d+\.\d+\.\d+/)?.[0];
  if (!installedVersion) {
    throw new Error(`Unable to determine the installed Maestro version from: ${output}`);
  }
  if (compareVersions(installedVersion, MAESTRO_CI_BASELINE) < 0) {
    throw new Error(
      `Maestro ${MAESTRO_CI_BASELINE} or newer is required; found ${installedVersion}.`,
    );
  }
  if (installedVersion === MAESTRO_CI_BASELINE) {
    log("setup", `Maestro ${installedVersion}.`);
  } else {
    log(
      "setup",
      `Maestro ${installedVersion} is newer than the CI baseline ${MAESTRO_CI_BASELINE}; full E2E results determine compatibility.`,
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

export async function startMetro({ artifactRoot, cleanup, root }) {
  const logPath = join(artifactRoot, "metro.log");
  const logStream = createWriteStream(logPath, { flags: "w" });
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
  for (const [stream, destination] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.on("data", (chunk) => {
      destination.write(chunk);
      logStream.write(chunk);
    });
  }
  child.once("error", (error) => {
    console.error(`[e2e:metro] ${String(error)}`);
  });
  cleanup.add(async () => {
    if (child.exitCode === null) {
      log("metro", "Stopping Metro.");
      child.kill("SIGINT");
      await Promise.race([
        new Promise((resolvePromise) => child.once("exit", resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 10000)),
      ]);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await new Promise((resolvePromise) => logStream.end(resolvePromise));
  });
  await waitUntil(
    async () => {
      if (child.exitCode !== null) throw new Error(`Metro exited early. See ${logPath}`);
      return metroIsHealthy();
    },
    60000,
    "Metro to become healthy on 127.0.0.1:8081",
  );
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
    const evidence = `${message}\n${readArtifactEvidence(outputDirectory)}`;
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

const SUITE_ABORT_CATEGORIES = new Set(["metro", "system-ui"]);

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
  /\b(kAXErrorInvalidUIElement|AXErrorInvalidUIElement|hierarchy\s+(failed|error)|cannot\s+determine\s+UI)\b|XCTest.{0,100}\b(failed|error|timed?\s*out|unavailable)\b/i;
const METRO_FAILURE_PATTERNS =
  /\b(?:Metro|packager).{0,100}\b(?:exited|failed|error|unavailable|not\s+running)\b|\b(?:exited|failed|error|unavailable).{0,100}\b(?:Metro|packager)\b|\b(?:bundling\s+failed|ECONNREFUSED(?:\s+127\.0\.0\.1)?:8081)\b/i;
const SYSTEM_UI_PATTERNS =
  /\b(System\s+UI\s+(?:(?:isn['’]t|is\s+not)\s+responding|has\s+stopped)|Application\s+Not\s+Responding:\s*System\s+UI|AppNotRespondingDialog|android:id\/aerr_(?:close|wait)|device\s+(offline|not\s+found)|simulator\s+(unavailable|failed|error)|emulator\s+(exited|failed))\b|(?:ANR|not\s+responding).{0,100}com\.android\.systemui|com\.android\.systemui.{0,100}(?:ANR|not\s+responding)/i;
const BUSINESS_ASSERTION_PATTERNS =
  /\b(Assertion is false|No visible element found|Could not find a visible element matching selector)\b/i;

const TEXT_ARTIFACT_EXTENSIONS = /\.(json|log|txt|xml|yaml|yml)$/i;

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

export function classifyFailure(message) {
  if (METRO_FAILURE_PATTERNS.test(message)) return "metro";
  if (SYSTEM_UI_PATTERNS.test(message)) return "system-ui";
  if (XCTEST_DRIVER_PATTERNS.test(message)) return "xctest-driver";
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
  if (kind === "app-crash" || kind === "xctest-driver" || kind === "system-ui") {
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
