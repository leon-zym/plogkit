import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { createMaestroEnvironment } from "./environment.mjs";

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

async function endWritable(stream) {
  const completion = finished(stream, { cleanup: true });
  stream.end();
  await completion;
}

function processTreeIsAlive(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcessTree(child, signal) {
  if (!child?.pid || !processTreeIsAlive(child)) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadlineMs = Date.now() + timeoutMs;
  while (processTreeIsAlive(child) && Date.now() < deadlineMs) {
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, Math.min(50, Math.max(1, deadlineMs - Date.now()))),
    );
  }
  return !processTreeIsAlive(child);
}

export async function terminateProcessTree(
  child,
  { gracefulTimeoutMs = 5000, killTimeoutMs = 5000 } = {},
) {
  if (!processTreeIsAlive(child)) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForProcessTreeExit(child, gracefulTimeoutMs)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForProcessTreeExit(child, killTimeoutMs))) {
    throw new Error(`Process tree ${child.pid} did not exit after SIGKILL.`);
  }
}

function createBoundedCapture(maxBytes) {
  let first = Buffer.alloc(0);
  let last = Buffer.alloc(0);
  let sourceBytes = 0;
  return {
    append(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      sourceBytes += chunk.length;
      if (first.length < maxBytes) {
        first = Buffer.concat([first, chunk.subarray(0, maxBytes - first.length)]);
      }
      last = Buffer.concat([last, chunk]);
      if (last.length > maxBytes) last = last.subarray(last.length - maxBytes);
    },
    finish() {
      if (sourceBytes <= maxBytes) {
        return { output: first, sourceBytes, truncated: false };
      }
      const marker = Buffer.from(
        `\n--- diagnostic bytes omitted from ${sourceBytes}-byte output ---\n`,
      );
      if (marker.length >= maxBytes) {
        return { output: first.subarray(0, maxBytes), sourceBytes, truncated: true };
      }
      const contentBytes = maxBytes - marker.length;
      const headBytes = Math.floor(contentBytes / 2);
      const tailBytes = contentBytes - headBytes;
      return {
        output: Buffer.concat([
          first.subarray(0, headBytes),
          marker,
          last.subarray(Math.max(0, last.length - tailBytes)),
        ]),
        sourceBytes,
        truncated: true,
      };
    },
  };
}

async function captureDiagnostic(
  command,
  args,
  { captureStdout = false, cleanup, cwd, env = process.env, maxBytes, timeoutMs },
) {
  const captureWindow = createBoundedCapture(maxBytes);
  const stdoutWindow = captureStdout ? createBoundedCapture(maxBytes) : null;
  const killGraceMs = Math.min(100, Math.max(1, Math.floor(timeoutMs / 4)));
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      ...captureWindow.finish(),
      error,
      ok: false,
      stdout: stdoutWindow?.finish().output,
      timedOut: false,
    };
  }
  child.stdout.on("data", (value) => {
    captureWindow.append(value);
    stdoutWindow?.append(value);
  });
  child.stderr.on("data", (value) => captureWindow.append(value));

  return new Promise((resolvePromise) => {
    let exitCode = null;
    let exitSignal = null;
    let finalizing = false;
    let spawnError = null;
    let stopPromise = null;
    let timeoutHandle = null;
    const stopTree = () =>
      (stopPromise ??= terminateProcessTree(child, {
        gracefulTimeoutMs: killGraceMs,
        killTimeoutMs: killGraceMs,
      }));
    cleanup?.add(stopTree);
    const finish = async (timedOut = false) => {
      if (finalizing) return;
      finalizing = true;
      clearTimeout(timeoutHandle);
      let terminationError = null;
      try {
        await stopTree();
      } catch (error) {
        terminationError = error;
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      const captured = captureWindow.finish();
      resolvePromise({
        ...captured,
        error: spawnError,
        exitCode,
        exitSignal,
        ok: !timedOut && !spawnError && !terminationError && !captured.truncated && exitCode === 0,
        stdout: stdoutWindow?.finish().output,
        terminationError,
        timedOut,
      });
    };
    child.once("error", (error) => {
      spawnError = error;
      void finish();
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      void stopTree().catch(() => {});
    });
    child.once("close", (code, signal) => {
      exitCode ??= code;
      exitSignal ??= signal;
      void finish();
    });
    const commandTimeoutMs = Math.max(1, timeoutMs - killGraceMs * 2);
    timeoutHandle = setTimeout(() => void finish(true), commandTimeoutMs);
  });
}

function boundedCommandError(command, args, result, { maxBytes, timeoutMs }) {
  const details = result.output.toString("utf8").trim();
  let error;
  if (result.timedOut) {
    error = Object.assign(
      new Error(
        `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}${
          details ? `\n${details}` : ""
        }`,
      ),
      { code: "E2E_COMMAND_TIMEOUT" },
    );
  } else if (result.error) {
    error = Object.assign(
      new Error(
        `Command could not be executed (${result.error.code ?? "unknown error"}): ` +
          `${command} ${args.join(" ")}${details ? `\n${details}` : ""}`,
        { cause: result.error },
      ),
      { code: result.error.code },
    );
  } else if (result.truncated) {
    error = Object.assign(
      new Error(
        `Command output exceeded ${maxBytes} bytes: ${command} ${args.join(" ")}\n${details}`,
      ),
      { code: "E2E_COMMAND_OUTPUT_LIMIT" },
    );
  } else {
    error = new Error(
      `Command failed (${result.exitCode ?? result.exitSignal ?? "unknown"}): ` +
        `${command} ${args.join(" ")}${details ? `\n${details}` : ""}`,
    );
  }

  if (!result.terminationError) return error;
  const aggregate = new AggregateError(
    [error, result.terminationError],
    `${error.message}\nUnable to terminate the bounded command process tree: ` +
      result.terminationError.message,
    { cause: error },
  );
  aggregate.code = "E2E_PROCESS_TREE_TERMINATION_FAILED";
  return aggregate;
}

export async function captureBoundedCommand(
  command,
  args,
  { cleanup, cwd, env = process.env, maxBytes, timeoutMs },
) {
  const result = await captureDiagnostic(command, args, {
    captureStdout: true,
    cleanup,
    cwd,
    env,
    maxBytes,
    timeoutMs,
  });
  if (!result.ok) throw boundedCommandError(command, args, result, { maxBytes, timeoutMs });
  return result.stdout.toString("utf8").trim();
}

export function run(
  command,
  args,
  {
    cleanup,
    cwd,
    env = process.env,
    input,
    outputPath,
    stdio = "inherit",
    terminate = terminateProcessTree,
    timeoutMs,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env,
      stdio: outputPath ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : stdio,
    });
    const output = outputPath ? createWriteStream(outputPath, { flags: "w" }) : null;
    let processTreeActive = true;
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
      if (!processTreeActive) return;
      await terminate(child);
      processTreeActive = false;
      if (output && !output.destroyed) await endWritable(output);
    });
    let settled = false;
    let timeoutHandle = null;
    let commandOutcome;
    let outputError = null;
    let terminationError = null;
    let terminationPromise = null;
    let outputCompletionPromise = null;
    let commandCompletionPromise = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const errors = [
        commandOutcome instanceof Error ? commandOutcome : null,
        outputError,
        terminationError,
      ].filter(Boolean);
      if (errors.length === 0) {
        resolvePromise();
        return;
      }
      if (errors.length === 1 && !terminationError) {
        reject(errors[0]);
        return;
      }
      const primaryError = errors[0];
      const additionalErrors = errors.slice(1);
      const aggregate = new AggregateError(
        errors,
        additionalErrors.length === 0
          ? `Process tree ${child.pid} could not be terminated: ${primaryError.message}`
          : `${primaryError.message}\nAdditional command finalization failure: ${additionalErrors
              .map((error) => error.message)
              .join("; ")}`,
        { cause: primaryError },
      );
      if (terminationError) {
        aggregate.code = "E2E_PROCESS_TREE_TERMINATION_FAILED";
      } else if (primaryError.code) {
        aggregate.code = primaryError.code;
      }
      reject(aggregate);
    };
    const terminateOnce = () => {
      terminationPromise ??= (async () => {
        try {
          await terminate(child);
          processTreeActive = false;
        } catch (error) {
          terminationError = error;
        }
      })();
      return terminationPromise;
    };
    const recordOutputError = (error) => {
      outputError ??= new Error(
        `Unable to write command output to ${outputPath}: ${error.message}`,
        { cause: error },
      );
      return outputError;
    };
    const finishOutput = () => {
      outputCompletionPromise ??= (async () => {
        if (!output || output.destroyed) return;
        try {
          await endWritable(output);
        } catch (error) {
          recordOutputError(error);
        }
      })();
      return outputCompletionPromise;
    };
    const finishCommand = () => {
      commandCompletionPromise ??= (async () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        await terminateOnce();
        await finishOutput();
        settle();
      })();
      return commandCompletionPromise;
    };
    const failOutput = (error) => {
      recordOutputError(error);
      if (settled || commandCompletionPromise) return;
      void terminateOnce().then(() => {
        if (terminationError && commandOutcome === undefined) settle();
      });
    };
    output?.on("error", failOutput);
    child.once("error", (error) => {
      processTreeActive = false;
      commandOutcome = error;
      void finishCommand();
    });
    child.once("close", (code, signal) => {
      commandOutcome ??=
        code === 0
          ? null
          : new Error(
              `Command failed (${code ?? signal ?? "unknown"}): ${command} ${args.join(" ")}`,
            );
      void finishCommand();
    });
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        if (settled || commandCompletionPromise) return;
        commandOutcome = Object.assign(
          new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`),
          { code: "E2E_COMMAND_TIMEOUT" },
        );
        void finishCommand();
      }, timeoutMs);
    }
    if (input !== undefined && child.stdin) child.stdin.end(input);
  });
}

export async function waitUntil(check, timeoutMs, description, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check(deadline);
    if (value) return value;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(intervalMs, remainingMs)),
      );
    }
  }
  throw new Error(`Timed out waiting for ${description}`);
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
        const errors = [];
        for (const task of tasks.reverse()) {
          try {
            await task();
          } catch (error) {
            console.error(`[e2e:cleanup] ${String(error)}`);
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "Multiple E2E cleanup tasks failed.");
      })();
      return cleanupPromise;
    },
  };
}

export async function finalizeCleanup(cleanup, operationError = null) {
  try {
    await cleanup.run();
  } catch (cleanupError) {
    if (operationError) {
      throw new AggregateError(
        [operationError, cleanupError],
        "The E2E operation failed and its cleanup also failed.",
        { cause: operationError },
      );
    }
    throw cleanupError;
  }
  if (operationError) throw operationError;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireE2ePlatformLock(
  platform,
  cleanup,
  {
    isProcessAlive = processIsAlive,
    lockRoot = join(tmpdir(), "plogkit-e2e-device-locks"),
    ownerPid = process.pid,
  } = {},
) {
  if (!new Set(["android", "ios"]).has(platform)) {
    throw new Error(`Unsupported E2E device lock platform: ${platform}`);
  }
  mkdirSync(lockRoot, { recursive: true });
  const lockDirectory = join(lockRoot, platform);
  const ownerPath = join(lockDirectory, "owner.json");
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(lockDirectory);
      try {
        writeFileSync(
          ownerPath,
          `${JSON.stringify({ ownerPid, startedAt: new Date().toISOString(), token })}\n`,
        );
      } catch (error) {
        rmSync(lockDirectory, { force: true, recursive: true });
        throw error;
      }
      cleanup.add(() => {
        let owner;
        try {
          owner = JSON.parse(readFileSync(ownerPath, "utf8"));
        } catch (error) {
          throw new Error(`Unable to verify the ${platform} E2E device lock owner.`, {
            cause: error,
          });
        }
        if (owner.token !== token || owner.ownerPid !== ownerPid) {
          throw new Error(`The ${platform} E2E device lock owner changed before cleanup.`);
        }
        rmSync(lockDirectory, { recursive: true });
      });
      return lockDirectory;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let owner = null;
    try {
      owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch {
      throw new Error(
        `The ${platform} E2E device is locked by another runner whose owner is not yet readable.`,
      );
    }
    if (isProcessAlive(owner.ownerPid)) {
      throw new Error(
        `The ${platform} E2E device is already owned by runner PID ${owner.ownerPid}.`,
      );
    }
    const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
    try {
      renameSync(lockDirectory, staleDirectory);
      rmSync(staleDirectory, { force: true, recursive: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Unable to acquire the ${platform} E2E device lock after stale-owner recovery.`);
}

export function installSignalHandlers(cleanup) {
  let handlingSignal = false;
  const handle = (exitCode) => {
    if (handlingSignal) return;
    handlingSignal = true;
    void cleanup
      .run()
      .catch((error) => console.error(`[e2e:cleanup] ${String(error)}`))
      .finally(() => process.exit(exitCode));
  };
  process.once("SIGINT", () => handle(130));
  process.once("SIGTERM", () => handle(143));
}

export function createArtifactRoot() {
  const configured = process.env.E2E_ARTIFACTS_DIR;
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const baseDirectory = configured ? resolve(configured) : join(tmpdir(), "plogkit-maestro");
  const directory = join(baseDirectory, `${timestamp}-${process.pid}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAESTRO_VERSION = readFileSync(join(runtimeRoot, ".maestro-version"), "utf8").trim();
const MAESTRO_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const MAESTRO_SUITE_TIMEOUT_MS = 60 * 60 * 1000;

export function validateMaestroVersion() {
  let output;
  try {
    output = capture("maestro", ["--version"], {
      env: createMaestroEnvironment(),
      timeoutMs: 15000,
    });
  } catch {
    throw new Error(`Maestro ${MAESTRO_VERSION} is required but was not found on PATH.`);
  }
  const installedVersion = output.match(/\d+\.\d+\.\d+/)?.[0];
  if (!installedVersion) {
    throw new Error(`Unable to determine the installed Maestro version from: ${output}`);
  }
  if (installedVersion !== MAESTRO_VERSION) {
    throw new Error(
      `Maestro ${MAESTRO_VERSION} is required, but ${installedVersion} is installed. ` +
        "Install the repository-pinned version from .maestro-version.",
    );
  }
}

async function runMaestro({
  artifactRoot,
  cleanup,
  device,
  flowEnvironment = {},
  root,
  target,
  timeoutMs,
}) {
  const outputDirectory = join(artifactRoot, device.platform, "flows");
  mkdirSync(outputDirectory, { recursive: true });
  log(
    device.platform,
    `Running Maestro flows on ${device.deviceId}; artifacts: ${outputDirectory}`,
  );
  if (device.platform === "android") {
    capture(device.adbPath, ["-s", device.deviceId, "logcat", "-b", "all", "-c"], {
      timeoutMs: 15000,
    });
  }
  await run(
    "maestro",
    [
      "--device",
      device.deviceId,
      "test",
      `--test-output-dir=${outputDirectory}`,
      ...(target.endsWith("/e2e") ? [`--config=${resolve(target, "config.yaml")}`] : []),
      ...Object.entries(flowEnvironment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      target,
    ],
    {
      cleanup,
      cwd: root,
      env: createMaestroEnvironment(),
      outputPath: join(outputDirectory, "runner-output.log"),
      timeoutMs,
    },
  );
}

export async function runMaestroSuite(options) {
  const { artifactRoot, cleanup, device, e2eRoot, flow, flowEnvironment, root } = options;
  if (!e2eRoot) {
    throw new Error("An immutable E2E run snapshot root is required for Maestro execution.");
  }
  const target = flow ? resolve(e2eRoot, "flows", `${flow}.yaml`) : e2eRoot;
  return runMaestro({
    artifactRoot,
    cleanup,
    device,
    flowEnvironment,
    root,
    target,
    timeoutMs: flow ? MAESTRO_FLOW_TIMEOUT_MS : MAESTRO_SUITE_TIMEOUT_MS,
  });
}

const DIAGNOSTIC_TIMEOUT_MS = 20000;
const DIAGNOSTIC_PROBE_TIMEOUT_MS = 5000;
const DIAGNOSTIC_TOTAL_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_SUMMARY_BYTES = 16 * 1024;
const DIAGNOSTIC_FILE_BYTES = 2 * 1024 * 1024;
const DIAGNOSTIC_REPORT_BYTES = 8 * 1024 * 1024;
const DIAGNOSTIC_REPORT_FILES = 8;
const DIAGNOSTIC_CLOCK_SKEW_MS = 5000;
const IOS_REPORT_EXTENSION = /\.(ips|crash|diag)$/i;
const IOS_RELEVANT_REPORT =
  /(PlogKit|Maestro|XCTest|XCTRunner|SpringBoard|backboardd|CoreSimulator)/i;
const ANDROID_REPORT_DIRECTORIES = [
  { artifactName: "tombstones", remotePath: "/data/tombstones" },
  { artifactName: "anr", remotePath: "/data/anr" },
];

function readFileChunk(fileDescriptor, length, position) {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const count = readSync(
      fileDescriptor,
      buffer,
      bytesRead,
      length - bytesRead,
      position + bytesRead,
    );
    if (count === 0) break;
    bytesRead += count;
  }
  return buffer.subarray(0, bytesRead);
}

function readBoundedFile(path, byteLimit) {
  const size = statSync(path).size;
  const bytesToRead = Math.min(size, byteLimit);
  const fileDescriptor = openSync(path, "r");
  try {
    if (size <= bytesToRead) {
      const body = readFileChunk(fileDescriptor, bytesToRead, 0);
      return { body, size };
    }
    const marker = Buffer.from(`\n--- evidence bytes omitted from ${size}-byte file ---\n`);
    if (marker.length >= bytesToRead) {
      return { body: readFileChunk(fileDescriptor, bytesToRead, 0), size };
    }
    const contentBytes = bytesToRead - marker.length;
    const headBytes = Math.floor(contentBytes / 2);
    const tailBytes = contentBytes - headBytes;
    return {
      body: Buffer.concat([
        readFileChunk(fileDescriptor, headBytes, 0),
        marker,
        readFileChunk(fileDescriptor, tailBytes, size - tailBytes),
      ]),
      size,
    };
  } finally {
    closeSync(fileDescriptor);
  }
}

function createDiagnosticState(timeoutMs) {
  return {
    complete: true,
    deadlineMs: Date.now() + Math.max(0, timeoutMs),
    remainingBytes: DIAGNOSTIC_TOTAL_BYTES - DIAGNOSTIC_SUMMARY_BYTES,
  };
}

function diagnosticTimeout(state, maximumMs = DIAGNOSTIC_PROBE_TIMEOUT_MS) {
  const timeoutMs = Math.max(0, Math.min(maximumMs, state.deadlineMs - Date.now()));
  if (timeoutMs === 0) state.complete = false;
  return timeoutMs;
}

function storeEvidence(path, value, state, knownTruncated = false) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (state.remainingBytes < source.length) knownTruncated = true;
  const body = source.subarray(0, state.remainingBytes);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    state.remainingBytes -= body.length;
  } catch {
    state.complete = false;
    return 0;
  }
  if (knownTruncated) state.complete = false;
  return body.length;
}

async function runDiagnostic(command, args, state, maximumBytes, maximumMs) {
  const timeoutMs = diagnosticTimeout(state, maximumMs);
  const maxBytes = Math.min(maximumBytes, state.remainingBytes);
  if (timeoutMs === 0 || maxBytes === 0) {
    state.complete = false;
    return null;
  }
  let result;
  try {
    result = await captureDiagnostic(command, args, { maxBytes, timeoutMs });
  } catch {
    state.complete = false;
    return null;
  }
  if (!result.ok) state.complete = false;
  if (Date.now() >= state.deadlineMs) state.complete = false;
  return result;
}

async function captureEvidence(path, command, args, state, maximumBytes, maximumMs) {
  const result = await runDiagnostic(command, args, state, maximumBytes, maximumMs);
  if (!result) return null;
  storeEvidence(path, result.output, state, result.truncated);
  return result;
}

function parseAndroidReportListing(output, remotePath, sinceMs) {
  const minimumMtimeMs = Math.max(0, sinceMs - DIAGNOSTIC_CLOCK_SKEW_MS);
  return output
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^(\d+)\|(\d+)\|(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      mtimeMs: Number(match[1]) * 1000,
      path: match[3],
      size: Number(match[2]),
    }))
    .filter((report) => {
      const prefix = `${remotePath}/`;
      const name = report.path.slice(prefix.length);
      return (
        report.path.startsWith(prefix) &&
        report.mtimeMs >= minimumMtimeMs &&
        name.length > 0 &&
        !name.includes("/") &&
        /^[A-Za-z0-9._-]+$/.test(name) &&
        Number.isFinite(report.size) &&
        report.size >= 0
      );
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
}

async function collectAndroidReports(diagnosticDirectory, device, sinceMs, state) {
  const adb = (args) => ["-s", device.deviceId, ...args];
  let groupRemainingBytes = Math.min(DIAGNOSTIC_REPORT_BYTES, state.remainingBytes);
  let storedFiles = 0;
  for (const directory of ANDROID_REPORT_DIRECTORIES) {
    if (groupRemainingBytes === 0 || storedFiles >= DIAGNOSTIC_REPORT_FILES) {
      state.complete = false;
      break;
    }
    const listingCommand =
      `for report in ${directory.remotePath}/*; do ` +
      `if [ -f "$report" ]; then stat -c '%Y|%s|%n' "$report"; fi; done`;
    const listing = await runDiagnostic(
      device.adbPath,
      adb(["shell", listingCommand]),
      state,
      256 * 1024,
    );
    if (!listing?.ok) continue;
    const reports = parseAndroidReportListing(listing.output, directory.remotePath, sinceMs);
    for (const report of reports) {
      if (groupRemainingBytes === 0 || storedFiles >= DIAGNOSTIC_REPORT_FILES) {
        state.complete = false;
        break;
      }
      const allocation = Math.min(DIAGNOSTIC_FILE_BYTES, groupRemainingBytes, state.remainingBytes);
      const captured = await runDiagnostic(
        device.adbPath,
        adb(["exec-out", "cat", report.path]),
        state,
        allocation,
      );
      if (!captured) continue;
      const truncated = captured.truncated || report.size > captured.sourceBytes;
      const name = report.path.slice(report.path.lastIndexOf("/") + 1);
      const storedBytes = storeEvidence(
        join(diagnosticDirectory, directory.artifactName, truncated ? `${name}.excerpt.txt` : name),
        captured.output,
        state,
        truncated,
      );
      groupRemainingBytes -= storedBytes;
      storedFiles += 1;
    }
  }
}

async function collectAndroidDiagnostics(diagnosticDirectory, device, sinceMs, state) {
  if (!device.adbPath) {
    state.complete = false;
    return;
  }
  const adb = (args) => ["-s", device.deviceId, ...args];
  for (const [artifact, args, maxBytes] of [
    [
      "logcat.txt",
      ["logcat", "-b", "main", "-b", "system", "-b", "crash", "-d", "-t", "4000"],
      4 * 1024 * 1024,
    ],
    ["events-logcat.txt", ["logcat", "-b", "events", "-d", "-t", "4000"], DIAGNOSTIC_FILE_BYTES],
    ["dumpsys-window.txt", ["shell", "dumpsys", "window"], DIAGNOSTIC_FILE_BYTES],
    ["dumpsys-activity.txt", ["shell", "dumpsys", "activity", "activities"], 1024 * 1024],
  ]) {
    await captureEvidence(
      join(diagnosticDirectory, artifact),
      device.adbPath,
      adb(args),
      state,
      maxBytes,
    );
  }
  await collectAndroidReports(diagnosticDirectory, device, sinceMs, state);
}

function listIosReports(reportsDirectory, artifactDirectory, sinceMs, state) {
  if (!existsSync(reportsDirectory)) return [];
  let entries;
  try {
    entries = readdirSync(reportsDirectory).sort();
  } catch {
    state.complete = false;
    return [];
  }
  const reports = [];
  for (const entry of entries) {
    if (!IOS_REPORT_EXTENSION.test(entry) || !IOS_RELEVANT_REPORT.test(entry)) continue;
    if (Date.now() >= state.deadlineMs) {
      state.complete = false;
      break;
    }
    const source = join(reportsDirectory, entry);
    try {
      const mtimeMs = statSync(source).mtimeMs;
      if (mtimeMs < sinceMs - DIAGNOSTIC_CLOCK_SKEW_MS) continue;
      reports.push({ artifactDirectory, entry, mtimeMs, source });
    } catch {
      state.complete = false;
    }
  }
  return reports;
}

function copyIosReports(diagnosticDirectory, reportsDirectory, sinceMs, state) {
  const reports = [
    ...listIosReports(reportsDirectory, "", sinceMs, state),
    ...listIosReports(join(reportsDirectory, "Retired"), "Retired", sinceMs, state),
  ].sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      join(left.artifactDirectory, left.entry).localeCompare(
        join(right.artifactDirectory, right.entry),
      ),
  );
  let groupRemainingBytes = Math.min(DIAGNOSTIC_REPORT_BYTES, state.remainingBytes);
  let storedFiles = 0;
  for (const { artifactDirectory, entry, source } of reports) {
    if (Date.now() >= state.deadlineMs) {
      state.complete = false;
      break;
    }
    if (storedFiles >= DIAGNOSTIC_REPORT_FILES || groupRemainingBytes === 0) {
      state.complete = false;
      break;
    }
    let report;
    try {
      report = readBoundedFile(
        source,
        Math.min(DIAGNOSTIC_FILE_BYTES, groupRemainingBytes, state.remainingBytes),
      );
    } catch {
      state.complete = false;
      continue;
    }
    const truncated = report.size > report.body.length;
    const storedBytes = storeEvidence(
      join(diagnosticDirectory, artifactDirectory, truncated ? `${entry}.excerpt.txt` : entry),
      report.body,
      state,
      truncated,
    );
    groupRemainingBytes -= storedBytes;
    storedFiles += 1;
  }
}

async function collectIosDiagnostics(
  diagnosticDirectory,
  device,
  iosReportsDirectory,
  sinceMs,
  state,
) {
  const lookbackSeconds = Math.max(30, Math.ceil((Date.now() - sinceMs) / 1000) + 5);
  await captureEvidence(
    join(diagnosticDirectory, "simulator-system.log"),
    "xcrun",
    [
      "simctl",
      "spawn",
      device.deviceId,
      "log",
      "show",
      "--style",
      "compact",
      "--last",
      `${lookbackSeconds}s`,
      "--predicate",
      'process == "PlogKit" OR process == "SpringBoard" OR process == "backboardd" OR process == "XCTRunner" OR eventMessage CONTAINS[c] "crash" OR eventMessage CONTAINS[c] "jetsam"',
    ],
    state,
    8 * 1024 * 1024,
    10000,
  );
  copyIosReports(
    diagnosticDirectory,
    iosReportsDirectory ?? join(homedir(), "Library", "Logs", "DiagnosticReports"),
    sinceMs,
    state,
  );
}

function writeFailureSummary(diagnosticDirectory, error, state) {
  const originalError = error instanceof Error ? error.message : String(error);
  const prefix = `diagnostics: ${state.complete ? "complete" : "incomplete"}\noriginal error: `;
  const availableErrorBytes = DIAGNOSTIC_SUMMARY_BYTES - Buffer.byteLength(prefix) - 1;
  const errorBuffer = createBoundedCapture(availableErrorBytes);
  errorBuffer.append(originalError);
  const boundedError = errorBuffer.finish();
  if (boundedError.truncated) state.complete = false;
  const body = Buffer.concat([
    Buffer.from(`diagnostics: ${state.complete ? "complete" : "incomplete"}\noriginal error: `),
    boundedError.output,
    Buffer.from("\n"),
  ]);
  try {
    writeFileSync(join(diagnosticDirectory, "failure-summary.txt"), body);
    return true;
  } catch {
    state.complete = false;
    return false;
  }
}

export async function collectFailureDiagnostics({
  diagnosticDirectory,
  device,
  error,
  iosReportsDirectory,
  sinceMs = Date.now(),
  timeoutMs = DIAGNOSTIC_TIMEOUT_MS,
}) {
  const state = createDiagnosticState(timeoutMs);
  try {
    mkdirSync(diagnosticDirectory, { recursive: true });
  } catch {
    return { complete: false };
  }
  try {
    if (device.platform === "android") {
      await collectAndroidDiagnostics(diagnosticDirectory, device, sinceMs, state);
    } else if (device.platform === "ios") {
      await collectIosDiagnostics(diagnosticDirectory, device, iosReportsDirectory, sinceMs, state);
    } else {
      state.complete = false;
    }
  } catch {
    state.complete = false;
  }
  writeFailureSummary(diagnosticDirectory, error, state);
  return { complete: state.complete };
}

export async function withFailureDiagnostics({
  diagnosticDirectory,
  device,
  iosReportsDirectory,
  operation,
  sinceMs = Date.now(),
}) {
  try {
    return await operation();
  } catch (error) {
    await collectFailureDiagnostics({
      diagnosticDirectory,
      device,
      error,
      iosReportsDirectory,
      sinceMs,
    });
    throw error;
  }
}
