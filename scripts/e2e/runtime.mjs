import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  { allowFailure = false, cwd, env = process.env, input } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw commandError(command, args, result);
  }
  return result.stdout.trim();
}

export function run(
  command,
  args,
  { cleanup, cwd, env = process.env, input, stdio = "inherit" } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio });
    cleanup?.add(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
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
  mkdirSync(outputDirectory, { recursive: true });
  log(
    device.platform,
    `${kind === "warmup" ? "Warming the app" : "Running Maestro flows"} on ${device.deviceId}; artifacts: ${outputDirectory}`,
  );
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
    { cleanup, cwd: root },
  );
}

export function warmUpApp(options) {
  return runMaestro({
    ...options,
    kind: "warmup",
    target: "e2e/subflows/warmup.yaml",
  });
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
      const category = classifyFailure(message);
      log(device.platform, `Flow ${flowName} FAILED [${category}]: ${message}`);
      await collectFailureDiagnostics({
        artifactRoot,
        device,
        error: message,
        flowName,
        kind: category,
      });
      failures.push({ flow: flowName, error: message, category });
      // Continue with remaining flows — do not let one failure cascade.
    }
  }

  if (failures.length > 0) {
    const summary = failures
      .map((f) => `  ${f.flow} [${f.category}]`)
      .join("\n");
    throw new Error(
      `${failures.length}/${flowFiles.length} flows failed:\n${summary}\n` +
        "See per-flow artifact directories for details.",
    );
  }
}

const APP_CRASH_PATTERNS = /\b(app\s+(stopped|not\s+running|crash)|FATAL\s+EXCEPTION|AndroidRuntime|SIGABRT|SIGSEGV|EXC_CRASH|EXC_BAD_ACCESS)\b/i;
const XCTEST_DRIVER_PATTERNS = /\b(kAXError|AXError|XCTest|hierarchy\s+(failed|error)|terminateApp|cannot\s+determine\s+UI)\b/i;
const METRO_FAILURE_PATTERNS = /\b(Metro|packager|ECONNREFUSED|8081|bundling\s+failed)\b/i;
const SYSTEM_UI_PATTERNS = /\b(System\s+UI|ANR|not\s+responding|device\s+(offline|not\s+found)|simulator\s+(unavailable|failed|error)|emulator\s+(exited|failed))\b/i;

function classifyFailure(message) {
  if (METRO_FAILURE_PATTERNS.test(message)) return "metro";
  if (XCTEST_DRIVER_PATTERNS.test(message)) return "xctest-driver";
  if (SYSTEM_UI_PATTERNS.test(message)) return "system-ui";
  if (APP_CRASH_PATTERNS.test(message)) return "app-crash";
  return "business-assertion";
}

async function collectFailureDiagnostics({ artifactRoot, device, error, flowName, kind }) {
  const diagDir = join(artifactRoot, device.platform, `flows/${flowName}`);
  mkdirSync(diagDir, { recursive: true });

  // Always save the failure classification and error message.
  appendFileSync(join(diagDir, "failure-summary.txt"), `category: ${kind}\nerror: ${error}\n`);

  // Collect platform-specific crash diagnostics.
  if (kind === "app-crash" || kind === "xctest-driver") {
    if (device.platform === "ios") {
      try {
        const reportsDir = join(
          homedir(),
          "Library",
          "Logs",
          "DiagnosticReports",
        );
        if (existsSync(reportsDir)) {
          for (const entry of readdirSync(reportsDir)) {
            if (/\.(ips|crash|diag)$/i.test(entry)) {
              copyFileSync(join(reportsDir, entry), join(diagDir, entry));
            }
          }
        }

        // Capture the simulator system log if the device is still reachable.
        const log = capture(
          "xcrun",
          ["simctl", "spawn", device.deviceId, "log", "show", "--last", "30s"],
          { allowFailure: true },
        );
        if (log) appendFileSync(join(diagDir, "simulator-system.log"), log);
      } catch {
        // Diagnostic collection is best-effort.
      }
    } else {
      try {
        // Capture logcat buffer for crash analysis.
        const logcat = capture("adb", ["-s", device.deviceId, "logcat", "-d"], {
          allowFailure: true,
        });
        if (logcat) appendFileSync(join(diagDir, "logcat.txt"), logcat);

        // Capture ANR traces if any.
        const anr = capture(
          "adb",
          ["-s", device.deviceId, "shell", "cat", "/data/anr/traces.txt"],
          { allowFailure: true },
        );
        if (anr) appendFileSync(join(diagDir, "anr-traces.txt"), anr);
      } catch {
        // Diagnostic collection is best-effort.
      }
    }
  }
}
