import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { captureBoundedCommand } from "./runtime.mjs";

const schemaVersion = 1;
const maximumEvents = 128;
const maximumHostSamples = 24;
const maximumSnapshotBytes = 256 * 1024;
const maximumProcesses = 16;
const hostProbeTimeoutMs = 2000;
const hostProbeMaxBytes = 2 * 1024 * 1024;
const allowedStages = new Set([
  "ios-app-install",
  "ios-app-service-readiness",
  "ios-boot",
  "ios-cleanup",
  "ios-device-create",
  "ios-fixture-addmedia",
  "ios-input-snapshot",
  "ios-locale",
  "ios-maestro-suite",
  "ios-photo-index",
  "ios-release-build",
  "ios-simulator-environment",
  "ios-springboard-service-readiness",
]);
const preparationStages = new Set([
  "ios-app-install",
  "ios-app-service-readiness",
  "ios-boot",
  "ios-device-create",
  "ios-fixture-addmedia",
  "ios-locale",
  "ios-photo-index",
  "ios-springboard-service-readiness",
]);
const allowedErrorNames = new Set([
  "AggregateError",
  "Error",
  "RangeError",
  "SyntaxError",
  "TypeError",
]);
const allowedErrorCodes = new Set([
  "E2E_COMMAND_TIMEOUT",
  "E2E_COMMAND_OUTPUT_LIMIT",
  "E2E_OBSERVATION_EVENT_LIMIT",
  "E2E_OBSERVATION_HOST_INVALID",
  "E2E_OBSERVATION_SAMPLE_LIMIT",
  "E2E_OBSERVATION_SIZE_LIMIT",
  "E2E_OBSERVATION_STAGE_INVALID",
  "E2E_PROCESS_TREE_TERMINATION_FAILED",
  "ENOSPC",
]);
const processFamilies = new Map([
  ["CoreSimulatorBridge", "core-simulator"],
  ["CoreSimulatorService", "core-simulator"],
  ["PUPickerExtension", "photo-services"],
  ["PhotosUIService", "photo-services"],
  ["Simulator", "simulator-ui"],
  ["SimulatorTrampoline", "simulator-ui"],
  ["SpringBoard", "guest-ui"],
  ["XCTRunner", "test-driver"],
  ["assetsd", "photo-services"],
  ["appinstalld", "install-services"],
  ["backboardd", "guest-ui"],
  ["containermanagerd", "install-services"],
  ["installd", "install-services"],
  ["java", "test-driver"],
  ["launchd_sim", "launchd-sim"],
  ["lsd", "install-services"],
  ["maestro", "test-driver"],
  ["mediaanalysisd", "photo-services"],
  ["node", "runner"],
  ["photoanalysisd", "photo-services"],
  ["photolibraryd", "photo-services"],
  ["simctl", "core-simulator"],
  ["xcodebuild", "native-build"],
]);
const allowedProcessFamilies = new Set(processFamilies.values());
const allowedProcessExecutables = new Set(processFamilies.keys());
const maestroSupportDirectories = new Set(["logs", "screen-hierarchy", "screenshots"]);

function finiteNumber(value, { integer = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const normalized = integer ? Math.round(value) : Math.round(value * 100) / 100;
  return Math.min(normalized, maximum);
}

function safeError(error) {
  const rawName = error instanceof Error ? error.name : "NonErrorFailure";
  const name = allowedErrorNames.has(rawName) ? rawName : "Error";
  const rawCode = error?.code;
  const code = allowedErrorCodes.has(rawCode) ? rawCode : null;
  return code ? { code, name } : { name };
}

function integerEnvironment(value) {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizedRun(environment) {
  const sha = environment.GITHUB_SHA;
  const runner = environment.E2E_IOS_RUNNER_LABEL;
  const imageVersion = environment.ImageVersion;
  return {
    attempt: integerEnvironment(environment.GITHUB_RUN_ATTEMPT),
    id: integerEnvironment(environment.GITHUB_RUN_ID),
    imageVersion:
      typeof imageVersion === "string" && /^\d{8}\.\d+\.\d+$/.test(imageVersion)
        ? imageVersion
        : null,
    job: environment.GITHUB_JOB === "ios-maestro" ? "ios-maestro" : null,
    mode: environment.E2E_FLOW ? "targeted" : "full",
    runner: new Set(["macos-26", "macos-26-xlarge"]).has(runner) ? runner : null,
    sha: typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null,
  };
}

function normalizedHostSnapshot(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return null;
  const host = {
    complete: source.complete === true,
    cpuCount: finiteNumber(source.cpuCount, { integer: true, maximum: 1024 }),
    diskAvailableBytes: finiteNumber(source.diskAvailableBytes, { integer: true }),
    loadAverage: Array.isArray(source.loadAverage)
      ? source.loadAverage.slice(0, 3).map((value) => finiteNumber(value, { maximum: 100_000 }))
      : [],
    memoryFreeBytes: finiteNumber(source.memoryFreeBytes, { integer: true }),
    memoryPressureFreePercent: finiteNumber(source.memoryPressureFreePercent, { maximum: 100 }),
    memoryTotalBytes: finiteNumber(source.memoryTotalBytes, { integer: true }),
    processes: Array.isArray(source.processes)
      ? source.processes.slice(0, maximumProcesses).flatMap((process) => {
          const family = allowedProcessFamilies.has(process?.family) ? process.family : null;
          const executable = allowedProcessExecutables.has(process?.executable)
            ? process.executable
            : null;
          const count = finiteNumber(process?.count, { integer: true, maximum: 100_000 });
          const cpuPercent = finiteNumber(process?.cpuPercent, { maximum: 100_000 });
          const maxCpuPercent = finiteNumber(process?.maxCpuPercent, { maximum: 100_000 });
          const maxRssBytes = finiteNumber(process?.maxRssBytes, { integer: true });
          const rssBytes = finiteNumber(process?.rssBytes, { integer: true });
          return family !== null &&
            executable !== null &&
            count !== null &&
            cpuPercent !== null &&
            maxCpuPercent !== null &&
            maxRssBytes !== null &&
            rssBytes !== null
            ? [{ count, cpuPercent, executable, family, maxCpuPercent, maxRssBytes, rssBytes }]
            : [];
        })
      : [],
    swapUsedBytes: finiteNumber(source.swapUsedBytes, { integer: true }),
  };
  if (Array.isArray(source.errors)) {
    host.errors = source.errors.slice(0, 8).flatMap((entry) => {
      const metric = new Set(["memory-pressure", "processes", "swap"]).has(entry?.metric)
        ? entry.metric
        : null;
      return metric ? [{ ...safeError(entry.error), metric }] : [];
    });
  }
  return host;
}

function parseMemoryPressure(output) {
  const match = output.match(/System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  const value = match ? Number.parseFloat(match[1]) : Number.NaN;
  return finiteNumber(value, { maximum: 100 });
}

function parseByteQuantity(value, unit) {
  const multipliers = { B: 1, G: 1024 ** 3, K: 1024, M: 1024 ** 2, T: 1024 ** 4 };
  const multiplier = multipliers[unit.toUpperCase()];
  return multiplier ? Math.round(Number.parseFloat(value) * multiplier) : null;
}

function parseSwapUsage(output) {
  const match = output.match(/\bused\s*=\s*([0-9]+(?:\.[0-9]+)?)([BKMGT])\b/i);
  return match ? parseByteQuantity(match[1], match[2]) : null;
}

function parseRelevantProcesses(output) {
  const processRows = output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*\d+\s+([0-9]+(?:\.[0-9]+)?)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) return [];
    const executable = basename(match[3]);
    const family = processFamilies.get(executable);
    if (!family) return [];
    return [
      {
        cpuPercent: Number.parseFloat(match[1]),
        executable,
        family,
        rssBytes: Number.parseInt(match[2], 10) * 1024,
      },
    ];
  });
  const families = new Map();
  for (const process of processRows) {
    const key = process.executable;
    const aggregate = families.get(key) ?? {
      count: 0,
      cpuPercent: 0,
      executable: process.executable,
      family: process.family,
      maxCpuPercent: 0,
      maxRssBytes: 0,
      rssBytes: 0,
    };
    aggregate.count += 1;
    aggregate.cpuPercent += process.cpuPercent;
    aggregate.rssBytes += process.rssBytes;
    aggregate.maxCpuPercent = Math.max(aggregate.maxCpuPercent, process.cpuPercent);
    aggregate.maxRssBytes = Math.max(aggregate.maxRssBytes, process.rssBytes);
    families.set(key, aggregate);
  }
  return [...families.values()]
    .map((process) => ({
      ...process,
      cpuPercent: finiteNumber(process.cpuPercent, { maximum: 100_000 }),
      maxCpuPercent: finiteNumber(process.maxCpuPercent, { maximum: 100_000 }),
    }))
    .sort(
      (left, right) =>
        right.cpuPercent - left.cpuPercent || left.executable.localeCompare(right.executable),
    )
    .slice(0, maximumProcesses);
}

export async function captureIosHostSnapshot({
  availableMemory = freemem,
  captureCommand,
  cpuCount = availableParallelism,
  diskAvailable = () => {
    const fileSystem = statfsSync("/");
    return Number(fileSystem.bavail) * Number(fileSystem.bsize);
  },
  loadAverage = loadavg,
  totalMemory = totalmem,
}) {
  const probes = [
    { args: ["-Q"], command: "/usr/bin/memory_pressure", metric: "memory-pressure" },
    { args: ["-n", "vm.swapusage"], command: "/usr/sbin/sysctl", metric: "swap" },
    { args: ["-axo", "pid=,pcpu=,rss=,comm="], command: "/bin/ps", metric: "processes" },
  ];
  const results = await Promise.allSettled(
    probes.map(({ args, command }) => captureCommand(command, args)),
  );
  const errors = [];
  const value = (index) => {
    const result = results[index];
    if (result.status === "fulfilled") return result.value;
    errors.push({ error: result.reason, metric: probes[index].metric });
    return null;
  };
  const memoryPressureOutput = value(0);
  const swapOutput = value(1);
  const processOutput = value(2);
  const memoryPressureFreePercent =
    memoryPressureOutput === null ? null : parseMemoryPressure(memoryPressureOutput);
  const swapUsedBytes = swapOutput === null ? null : parseSwapUsage(swapOutput);
  if (memoryPressureOutput !== null && memoryPressureFreePercent === null) {
    errors.push({
      error: Object.assign(new Error("Invalid memory pressure output."), {
        code: "E2E_OBSERVATION_HOST_INVALID",
      }),
      metric: "memory-pressure",
    });
  }
  if (swapOutput !== null && swapUsedBytes === null) {
    errors.push({
      error: Object.assign(new Error("Invalid swap output."), {
        code: "E2E_OBSERVATION_HOST_INVALID",
      }),
      metric: "swap",
    });
  }
  const processes = processOutput === null ? [] : parseRelevantProcesses(processOutput);
  if (processOutput !== null && processes.length === 0) {
    errors.push({
      error: Object.assign(new Error("No relevant host processes were observed."), {
        code: "E2E_OBSERVATION_HOST_INVALID",
      }),
      metric: "processes",
    });
  }
  return {
    complete: errors.length === 0,
    cpuCount: cpuCount(),
    diskAvailableBytes: diskAvailable(),
    errors,
    loadAverage: loadAverage(),
    memoryFreeBytes: availableMemory(),
    memoryPressureFreePercent,
    memoryTotalBytes: totalMemory(),
    processes,
    swapUsedBytes,
  };
}

function listMaestroCommandFiles(root) {
  const files = [];
  let scannedEntries = 0;
  let complete = true;
  const visit = (directory, depth) => {
    if (scannedEntries >= 256 || files.length >= 32) {
      complete = false;
      return;
    }
    let handle;
    try {
      handle = opendirSync(directory);
      let entry;
      while ((entry = handle.readSync()) !== null && scannedEntries < 256 && files.length < 32) {
        scannedEntries += 1;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth < 2) visit(path, depth + 1);
          else if (!maestroSupportDirectories.has(entry.name)) complete = false;
        } else if (entry.isFile() && entry.name === "commands.json") files.push(path);
      }
      if (entry !== null) complete = false;
    } catch {
      complete = false;
      return;
    } finally {
      handle?.closeSync();
    }
  };
  visit(root, 0);
  return { complete, files };
}

function maestroCommand(entry, name) {
  return entry?.command?.[name] ?? entry?.metadata?.evaluatedCommand?.[name] ?? null;
}

function commandTiming(entry) {
  const timestamp = finiteNumber(entry?.metadata?.timestamp, { integer: true });
  const duration = finiteNumber(entry?.metadata?.duration);
  return timestamp === null || duration === null
    ? null
    : { duration, finishedAt: timestamp + duration, startedAt: timestamp };
}

function summarizeMaestroFlow(entries) {
  let launch = null;
  let home = null;
  let pickerOpen = null;
  let pickerGrid = null;
  let pickerDone = null;
  let pickerFailed = false;
  let appHomeFailed = false;
  let failed = false;
  for (const entry of entries) {
    const status = entry?.metadata?.status;
    const timing = commandTiming(entry);
    if (status === "FAILED") failed = true;
    if (maestroCommand(entry, "launchAppCommand") && timing) launch ??= timing;
    const assertion = maestroCommand(entry, "assertConditionCommand");
    const visible = assertion?.condition?.visible;
    if (visible?.idRegex === "home-screen" && timing) {
      home ??= timing;
      if (status === "FAILED") appHomeFailed = true;
    }
    if (visible?.idRegex === "PXGGridLayout-Info" && String(visible.index) === "1" && timing) {
      pickerGrid ??= timing;
      if (status === "FAILED") pickerFailed = true;
    }
    if ((visible?.textRegex === "^Done$" || visible?.textRegex === "Done") && timing) {
      pickerDone ??= timing;
      if (status === "FAILED") pickerFailed = true;
    }
    const tap = maestroCommand(entry, "tapOnElement")?.selector;
    if (tap?.idRegex === "choose-photos" && timing) pickerOpen ??= timing;
    if (
      status === "FAILED" &&
      maestroCommand(entry, "runFlowCommand")?.sourceDescription === "select-two-photos-ios.yaml"
    ) {
      pickerFailed = true;
    }
  }
  return {
    appHomeFailed,
    failed,
    pickerFailed,
    summary: {
      appHomeReadyMs: launch && home ? finiteNumber(home.finishedAt - launch.startedAt) : null,
      pickerDoneReadyMs:
        pickerGrid && pickerDone
          ? finiteNumber(pickerDone.finishedAt - pickerGrid.finishedAt)
          : null,
      pickerGridReadyMs:
        pickerOpen && pickerGrid
          ? finiteNumber(pickerGrid.finishedAt - pickerOpen.startedAt)
          : null,
      status: failed ? "failed" : "passed",
    },
  };
}

export function summarizeIosMaestroArtifacts(directory, suiteStartedAtMs, suiteFailed = false) {
  let totalBytes = 0;
  const parsedFlows = [];
  const scan = listMaestroCommandFiles(directory);
  let complete = scan.complete;
  for (const path of scan.files) {
    try {
      const size = lstatSync(path).size;
      if (size > 2 * 1024 * 1024 || totalBytes + size > 4 * 1024 * 1024) {
        complete = false;
        break;
      }
      totalBytes += size;
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(value)) {
        complete = false;
        continue;
      }
      const timestamps = value
        .map((entry) => finiteNumber(entry?.metadata?.timestamp, { integer: true }))
        .filter((value) => value !== null);
      const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;
      if (firstTimestamp === null) {
        complete = false;
        continue;
      }
      parsedFlows.push({
        firstTimestamp,
        ...summarizeMaestroFlow(value),
      });
    } catch {
      complete = false;
    }
  }
  parsedFlows.sort(
    (left, right) =>
      (left.firstTimestamp ?? Number.MAX_SAFE_INTEGER) -
      (right.firstTimestamp ?? Number.MAX_SAFE_INTEGER),
  );
  const firstCommandAt = parsedFlows
    .map(({ firstTimestamp }) => firstTimestamp)
    .find((timestamp) => timestamp !== null);
  const anyFailed = parsedFlows.some(({ failed }) => failed);
  const failureBoundary =
    parsedFlows.length === 0
      ? "driver-startup"
      : parsedFlows.some(({ appHomeFailed }) => appHomeFailed)
        ? "app-home"
        : parsedFlows.some(({ pickerFailed }) => pickerFailed)
          ? "picker"
          : anyFailed
            ? "other-command"
            : suiteFailed
              ? "other-command"
              : "none";
  return {
    complete: complete && parsedFlows.length > 0,
    driverStartupMs:
      firstCommandAt === undefined ? null : finiteNumber(firstCommandAt - suiteStartedAtMs),
    failureBoundary,
    flows: parsedFlows.map(({ summary }) => summary),
  };
}

export function createIosRunObservationRecorder({
  artifactRoot,
  cleanup,
  directory,
  environment = process.env,
}) {
  return createIosObservationRecorder({
    captureHostSnapshot: () =>
      captureIosHostSnapshot({
        captureCommand: (command, args) =>
          captureBoundedCommand(command, args, {
            cleanup,
            includeOutputInError: false,
            maxBytes: hostProbeMaxBytes,
            timeoutMs: hostProbeTimeoutMs,
          }),
      }),
    directory,
    environment,
    hostProbeTimeoutMs,
    maestroDirectory: join(artifactRoot, "ios", "flows"),
  });
}

function defaultWriteSnapshot(path, body) {
  const temporaryPath = join(
    dirname(dirname(path)),
    `.ios-observation-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, body, { flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function createIosObservationRecorder({
  cancelTimer = clearTimeout,
  captureHostSnapshot = null,
  directory,
  environment = process.env,
  hostProbeTimeoutMs = 2000,
  maestroDirectory = null,
  monotonicNow = () => performance.now(),
  now = () => Date.now(),
  samplingIntervalMs = 30_000,
  scheduleTimer = setTimeout,
  writeSnapshot = ({ body, path, writeDefault }) => writeDefault(path, body),
}) {
  if (
    !Number.isInteger(samplingIntervalMs) ||
    samplingIntervalMs < 1000 ||
    samplingIntervalMs > 300_000 ||
    !Number.isInteger(hostProbeTimeoutMs) ||
    hostProbeTimeoutMs < 100 ||
    hostProbeTimeoutMs > 10_000
  ) {
    throw new RangeError("Invalid iOS observation sampling limits.");
  }
  mkdirSync(directory, { recursive: true });
  const outputPath = join(directory, "ios-observation.json");
  const recorderStartedAt = monotonicNow();
  const state = {
    complete: true,
    events: [],
    limits: {
      events: maximumEvents,
      hostProbeTimeoutMs,
      hostSampleIntervalMs: samplingIntervalMs,
      hostSamples: maximumHostSamples,
      snapshotBytes: maximumSnapshotBytes,
    },
    outcome: { status: "running" },
    run: normalizedRun(environment),
    schemaVersion,
    startedAtMs: finiteNumber(now(), { integer: true }),
  };
  let sequence = 0;
  let activeStage = null;
  let sampleInFlight = null;
  let samplerActive = false;
  let samplerTimer = null;

  const addRecorderError = (operation, error) => {
    state.complete = false;
    state.recorderErrors ??= [];
    const candidate = { ...safeError(error), operation };
    if (
      !state.recorderErrors.some(
        (existing) =>
          existing.operation === candidate.operation &&
          existing.name === candidate.name &&
          existing.code === candidate.code,
      )
    ) {
      state.recorderErrors.push(candidate);
    }
  };

  const persist = () => {
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(body) > maximumSnapshotBytes) {
      addRecorderError(
        "snapshot-size",
        Object.assign(new Error("iOS observation snapshot exceeded its byte budget."), {
          code: "E2E_OBSERVATION_SIZE_LIMIT",
        }),
      );
      return;
    }
    try {
      writeSnapshot({ body, path: outputPath, writeDefault: defaultWriteSnapshot });
    } catch (error) {
      addRecorderError("snapshot-write", error);
    }
  };

  const append = (event) => {
    if (state.events.length + (state.hostSamples?.length ?? 0) >= maximumEvents) {
      addRecorderError(
        "event-limit",
        Object.assign(new Error("iOS observation event limit reached."), {
          code: "E2E_OBSERVATION_EVENT_LIMIT",
        }),
      );
      persist();
      return;
    }
    sequence += 1;
    state.events.push({ ...event, sequence });
    persist();
  };

  const appendHostSample = (reason, host, durationMs, sampleContext) => {
    if (state.events.length + (state.hostSamples?.length ?? 0) >= maximumEvents) {
      addRecorderError(
        "event-limit",
        Object.assign(new Error("iOS observation event limit reached."), {
          code: "E2E_OBSERVATION_EVENT_LIMIT",
        }),
      );
      persist();
      return;
    }
    state.hostSamples ??= [];
    sequence += 1;
    state.hostSamples.push({
      durationMs: finiteNumber(durationMs),
      elapsedMs: finiteNumber(sampleContext.startedElapsedMs - recorderStartedAt),
      host,
      reason,
      sequence,
      stage: sampleContext.stage,
      timestampMs: finiteNumber(sampleContext.startedAtMs, { integer: true }),
    });
    if (host.complete !== true) state.complete = false;
    persist();
  };

  const sampleHost = async (reason) => {
    if (!captureHostSnapshot) return;
    if ((state.hostSamples?.length ?? 0) >= maximumHostSamples) {
      samplerActive = false;
      if (samplerTimer !== null) cancelTimer(samplerTimer);
      samplerTimer = null;
      addRecorderError(
        "sample-limit",
        Object.assign(new Error("iOS observation sample limit reached."), {
          code: "E2E_OBSERVATION_SAMPLE_LIMIT",
        }),
      );
      persist();
      return;
    }
    if (sampleInFlight) {
      state.omissions ??= { overlap: 0 };
      state.omissions.overlap += 1;
      persist();
      return;
    }
    const sampleStartedAt = monotonicNow();
    const sampleContext = {
      stage: activeStage,
      startedAtMs: now(),
      startedElapsedMs: sampleStartedAt,
    };
    sampleInFlight = (async () => {
      try {
        const host = normalizedHostSnapshot(await captureHostSnapshot());
        if (host === null) {
          const error = Object.assign(new Error("Invalid host snapshot."), {
            code: "E2E_OBSERVATION_HOST_INVALID",
          });
          addRecorderError("host-capture", error);
          appendHostSample(
            reason,
            { complete: false, error: safeError(error) },
            monotonicNow() - sampleStartedAt,
            sampleContext,
          );
        } else {
          appendHostSample(reason, host, monotonicNow() - sampleStartedAt, sampleContext);
        }
      } catch (error) {
        addRecorderError("host-capture", error);
        appendHostSample(
          reason,
          { complete: false, error: safeError(error) },
          monotonicNow() - sampleStartedAt,
          sampleContext,
        );
      }
    })();
    try {
      await sampleInFlight;
    } finally {
      sampleInFlight = null;
    }
  };

  const scheduleNextSample = () => {
    if (!samplerActive || !captureHostSnapshot) return;
    samplerTimer = scheduleTimer(async () => {
      samplerTimer = null;
      if (!samplerActive) return;
      await sampleHost("interval");
      scheduleNextSample();
    }, samplingIntervalMs);
    samplerTimer?.unref?.();
  };

  const startSampler = async (sampleImmediately) => {
    if (samplerActive || !captureHostSnapshot) return;
    samplerActive = true;
    if (sampleImmediately) await sampleHost("preparation-start");
    scheduleNextSample();
  };

  const stopSampler = async (reason, { captureFinal = true } = {}) => {
    if (!samplerActive) return;
    samplerActive = false;
    if (samplerTimer !== null) cancelTimer(samplerTimer);
    samplerTimer = null;
    if (sampleInFlight) {
      const inFlight = sampleInFlight;
      await inFlight;
      if (sampleInFlight === inFlight) sampleInFlight = null;
    }
    if (captureFinal) await sampleHost(reason);
  };

  persist();
  return {
    async finish(status, error = null) {
      if (!new Set(["failed", "interrupted", "passed"]).has(status)) {
        throw new Error(`Unsupported iOS observation outcome: ${status}`);
      }
      if (state.outcome.status === "failed" || state.outcome.status === "passed") return;
      if (state.outcome.status === "interrupted" && status !== "failed") return;
      if (status === "interrupted") {
        state.outcome = { status };
        persist();
      }
      await stopSampler("preparation-finished", { captureFinal: status !== "interrupted" });
      state.outcome = {
        ...(error ? { error: safeError(error) } : {}),
        status,
      };
      persist();
    },
    async run(stage, operation) {
      if (!allowedStages.has(stage)) {
        addRecorderError(
          "stage",
          Object.assign(new Error("Unsupported iOS observation stage."), {
            code: "E2E_OBSERVATION_STAGE_INVALID",
          }),
        );
        persist();
        return operation();
      }
      if (stage === "ios-maestro-suite") await stopSampler("pre-maestro");
      if (stage === "ios-cleanup") await stopSampler("pre-cleanup");
      activeStage = stage;
      const firstHostSample = (state.hostSamples?.length ?? 0) === 0;
      if (firstHostSample) await sampleHost("job-start");
      if (stage === "ios-release-build" && !firstHostSample) await sampleHost("build-start");
      if (preparationStages.has(stage)) await startSampler(!firstHostSample);
      const startedAtMs = now();
      const startedElapsedMs = monotonicNow();
      append({
        elapsedMs: finiteNumber(startedElapsedMs - recorderStartedAt),
        event: "stage-started",
        stage,
        timestampMs: finiteNumber(startedAtMs, { integer: true }),
      });
      try {
        const value = await operation();
        const finishedAtMs = now();
        const finishedElapsedMs = monotonicNow();
        if (stage === "ios-release-build") await sampleHost("build-finished");
        if (stage === "ios-boot") await sampleHost("post-boot");
        if (stage === "ios-maestro-suite" && maestroDirectory) {
          state.maestro = summarizeIosMaestroArtifacts(maestroDirectory, startedAtMs, false);
          if (!state.maestro.complete) state.complete = false;
        }
        if (stage === "ios-maestro-suite") await sampleHost("maestro-finished");
        append({
          durationMs: finiteNumber(finishedElapsedMs - startedElapsedMs),
          elapsedMs: finiteNumber(finishedElapsedMs - recorderStartedAt),
          event: "stage-finished",
          stage,
          status: "passed",
          timestampMs: finiteNumber(finishedAtMs, { integer: true }),
        });
        return value;
      } catch (error) {
        const finishedAtMs = now();
        const finishedElapsedMs = monotonicNow();
        if (samplerActive) await stopSampler("stage-failure");
        if (stage === "ios-maestro-suite" && maestroDirectory) {
          state.maestro = summarizeIosMaestroArtifacts(maestroDirectory, startedAtMs, true);
          if (!state.maestro.complete) state.complete = false;
        }
        if (stage === "ios-maestro-suite") await sampleHost("maestro-failed");
        append({
          durationMs: finiteNumber(finishedElapsedMs - startedElapsedMs),
          elapsedMs: finiteNumber(finishedElapsedMs - recorderStartedAt),
          error: safeError(error),
          event: "stage-finished",
          stage,
          status: "failed",
          timestampMs: finiteNumber(finishedAtMs, { integer: true }),
        });
        throw error;
      }
    },
  };
}
