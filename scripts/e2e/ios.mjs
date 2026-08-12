import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import {
  capture,
  captureBoundedCommand,
  log,
  publicE2eErrorText,
  run,
  waitUntil,
} from "./runtime.mjs";
import {
  createMaestroEnvironment,
  createStandaloneBuildEnvironment,
  isHermesBytecode,
} from "./environment.mjs";
import { assertIosExpoModulesCoreAbi } from "./ios-native-abi.mjs";

const deviceNamePrefix = "PlogKit E2E";
const requiredXcodeVersion = "26.6";
const requiredXcodeBuild = "17F113";
const requiredCocoaPodsVersion = "1.17.0";
const runtimeIdentifier = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const deviceTypeName = "iPhone 17 Pro";
const deviceTypeIdentifier = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const appPath = "ios/build/Build/Products/Release-iphonesimulator/PlogKit.app";
const buildTimeoutMs = 45 * 60 * 1000;
const deviceLifecycleTimeoutMs = 3 * 60 * 1000;
const hostLifecycleProbeTimeoutMs = 2 * 60 * 1000;
const iosHostLifecycleEvidenceMaxBytes = 1024 * 1024;
const iosPrepareEvidenceMaxBytes = 1024 * 1024;
const iosPrepareEvidenceProbeTimeoutMs = 5000;
const iosReadinessTimeoutMs = 120000;
const iosGuestHealthTimeoutMs = 30000;
const iosGuestHealthMaxBytes = 1024 * 1024;
const iosCleanupStageErrorMaxBytes = 64 * 1024;

function boundedEvidence(value, maxBytes) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (source.length <= maxBytes) return source;
  const marker = Buffer.from(
    `\n--- diagnostic bytes omitted from ${source.length}-byte output ---\n`,
  );
  const contentBytes = maxBytes - marker.length;
  const headBytes = Math.floor(contentBytes / 2);
  const tailBytes = contentBytes - headBytes;
  return Buffer.concat([
    source.subarray(0, headBytes),
    marker,
    source.subarray(source.length - tailBytes),
  ]);
}

export function validateIosHost() {
  if (platform() !== "darwin") {
    throw new Error("iOS E2E requires macOS. Run the Android-only command on this host.");
  }
}

export function validateIosToolchain() {
  const xcodePath = capture("xcode-select", ["-p"], {
    allowFailure: true,
    timeoutMs: 15000,
  });
  const xcodeVersion = capture("xcodebuild", ["-version"], {
    allowFailure: true,
    timeoutMs: 15000,
  });
  log("ios", `Xcode: ${xcodePath ?? "unknown"}`);
  if (xcodeVersion) {
    for (const line of xcodeVersion.split("\n")) log("ios", `  ${line}`);
  }
  const cocoaPodsVersion = capture("pod", ["--version"], {
    allowFailure: true,
    timeoutMs: 15000,
  });
  log("ios", `CocoaPods: ${cocoaPodsVersion ?? "unknown"}`);
  const selectedXcodeVersion = xcodeVersion?.match(/^Xcode\s+(.+)$/m)?.[1] ?? "unknown";
  const selectedXcodeBuild = xcodeVersion?.match(/^Build version\s+(.+)$/m)?.[1] ?? "unknown";
  if (selectedXcodeVersion !== requiredXcodeVersion || selectedXcodeBuild !== requiredXcodeBuild) {
    throw new Error(
      `Xcode ${requiredXcodeVersion} (${requiredXcodeBuild}) is required, but ` +
        `Xcode ${selectedXcodeVersion} (${selectedXcodeBuild}) is selected.`,
    );
  }
  if (cocoaPodsVersion !== requiredCocoaPodsVersion) {
    throw new Error(
      `CocoaPods ${requiredCocoaPodsVersion} is required, but ${cocoaPodsVersion ?? "unknown"} is installed.`,
    );
  }
  log("ios", "iOS toolchain validation passed.");
}

export async function validateIosSimulatorEnvironment({
  artifactRoot,
  cleanup,
  hostLifecycleTimeoutMs = hostLifecycleProbeTimeoutMs,
  probeTimeoutMs = 15000,
} = {}) {
  const runtime = await requiredRuntime({
    artifactRoot,
    cleanup,
    timeoutMs: hostLifecycleTimeoutMs,
  });
  if (!runtime) {
    throw new Error(
      `iOS Simulator runtime ${runtimeIdentifier} is not available. ` +
        "Install it via Xcode → Settings → Platforms, then retry.",
    );
  }
  log("ios", `Simulator runtime: ${runtime.name} (${runtime.version})`);

  const deviceType = requiredDeviceType(probeTimeoutMs);
  if (!deviceType) {
    throw new Error(
      `Device type "${deviceTypeName}" is not available. ` +
        "Install the iOS Simulator platform via Xcode → Settings → Platforms.",
    );
  }

  log("ios", "iOS Simulator environment validation passed.");
}

function throwIosHostLifecycleFailure(artifactRoot, probe, error) {
  if (!artifactRoot) throw error;
  const details = publicE2eErrorText(error);
  const evidencePath = join(artifactRoot, "ios-host-lifecycle.log");
  try {
    writeFileSync(
      evidencePath,
      boundedEvidence(
        `=== iOS host lifecycle probe failure ===\nprobe: ${probe}\n${details}\n`,
        iosHostLifecycleEvidenceMaxBytes,
      ),
    );
  } catch (evidenceError) {
    const aggregate = new AggregateError(
      [error, evidenceError],
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Unable to preserve bounded iOS host lifecycle evidence at ${evidencePath}.`,
      { cause: error },
    );
    if (error?.code) aggregate.code = error.code;
    throw aggregate;
  }
  throw error;
}

async function requiredRuntime({ artifactRoot, cleanup, timeoutMs }) {
  const command = "xcrun simctl list runtimes -j";
  try {
    const output = await captureBoundedCommand("xcrun", ["simctl", "list", "runtimes", "-j"], {
      cleanup,
      maxBytes: iosHostLifecycleEvidenceMaxBytes,
      timeoutMs,
    });
    let runtimes;
    try {
      runtimes = JSON.parse(output);
    } catch (error) {
      const parseError = new SyntaxError(
        `Unable to parse output from ${command}: ${error.message}\n${output}`,
        { cause: error },
      );
      parseError.code = "E2E_COMMAND_OUTPUT_INVALID";
      throw parseError;
    }
    return runtimes.runtimes.find(
      (runtime) => runtime.isAvailable && runtime.identifier === runtimeIdentifier,
    );
  } catch (error) {
    throwIosHostLifecycleFailure(artifactRoot, "runtime-discovery", error);
  }
}

function requiredDeviceType(timeoutMs) {
  const result = JSON.parse(
    capture("xcrun", ["simctl", "list", "devicetypes", "-j"], { timeoutMs }),
  );
  return result.devicetypes.find((device) => device.identifier === deviceTypeIdentifier);
}

function simulatorState(deviceId) {
  const result = JSON.parse(
    capture("xcrun", ["simctl", "list", "devices", "-j"], { timeoutMs: 15000 }),
  );
  for (const devices of Object.values(result.devices)) {
    const device = devices.find((candidate) => candidate.udid === deviceId);
    if (device) return device.state;
  }
  return null;
}

export async function shutdownIosDevice(deviceId) {
  capture("xcrun", ["simctl", "shutdown", deviceId], {
    allowFailure: true,
    timeoutMs: 30000,
  });
  await waitUntil(
    () => simulatorState(deviceId) === "Shutdown",
    30000,
    `iOS Simulator ${deviceId} to shut down`,
    500,
  );
}

function createEphemeralIosDevice() {
  const name = `${deviceNamePrefix} ${process.pid} ${randomUUID()}`;
  const udid = capture(
    "xcrun",
    ["simctl", "create", name, deviceTypeIdentifier, runtimeIdentifier],
    { timeoutMs: 30000 },
  );
  if (!udid) throw new Error("simctl did not return an identifier for the new iOS Simulator.");
  return { name, udid };
}

function cleanupErrorText(error) {
  return boundedEvidence(publicE2eErrorText(error), iosCleanupStageErrorMaxBytes).toString("utf8");
}

function cleanupStage(error) {
  return error
    ? {
        error: cleanupErrorText(error),
        status: "failed",
      }
    : { status: "succeeded" };
}

async function deleteOwnedIosDevice(deviceId, artifactRoot, verificationTimeoutMs = 30000) {
  let shutdownError = null;
  let deleteError = null;
  let verificationError = null;
  try {
    await shutdownIosDevice(deviceId);
    log("ios", `Cleanup shutdown completed for owned simulator ${deviceId}.`);
  } catch (error) {
    shutdownError = error;
    log(
      "ios",
      `Cleanup shutdown did not complete for owned simulator ${deviceId}: ${cleanupErrorText(error)}`,
    );
  }
  try {
    capture("xcrun", ["simctl", "delete", deviceId], { timeoutMs: 30000 });
    log("ios", `Cleanup delete completed for owned simulator ${deviceId}.`);
  } catch (error) {
    deleteError = error;
    log("ios", `Cleanup delete failed for owned simulator ${deviceId}: ${cleanupErrorText(error)}`);
  }

  try {
    await waitUntil(
      () => simulatorState(deviceId) === null,
      verificationTimeoutMs,
      `owned iOS Simulator ${deviceId} to disappear after deletion`,
      500,
    );
    log("ios", `Cleanup verified owned simulator ${deviceId} is absent.`);
  } catch (error) {
    verificationError = error;
    log(
      "ios",
      `Cleanup could not verify owned simulator ${deviceId} is absent: ${cleanupErrorText(error)}`,
    );
  }

  let summaryError = null;
  if (artifactRoot) {
    const summaryPath = join(artifactRoot, "ios", "device-cleanup.json");
    try {
      mkdirSync(join(artifactRoot, "ios"), { recursive: true });
      writeFileSync(
        summaryPath,
        `${JSON.stringify(
          {
            deletion: cleanupStage(deleteError),
            deviceId,
            shutdown: cleanupStage(shutdownError),
            verification: verificationError
              ? { ...cleanupStage(verificationError), udidAbsent: false }
              : { status: "succeeded", udidAbsent: true },
          },
          null,
          2,
        )}\n`,
      );
      log(
        "ios",
        process.env.CI
          ? "Cleanup summary retained for workflow upload."
          : `Cleanup summary: ${summaryPath}`,
      );
    } catch (error) {
      summaryError = error;
      log("ios", `Unable to preserve iOS cleanup summary: ${cleanupErrorText(error)}`);
    }
  }

  const fatalErrors = [deleteError, verificationError, summaryError].filter(Boolean);
  if (fatalErrors.length === 0) return;
  const primaryError = fatalErrors[0];
  const errors = [primaryError, ...(shutdownError ? [shutdownError] : []), ...fatalErrors.slice(1)];
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(
    errors,
    `Unable to completely delete and verify owned iOS Simulator ${deviceId}.`,
    { cause: primaryError },
  );
}

export function isIosEnglishLocale({ languages, locale }) {
  return (
    /(?:^|[\s("'])en-US(?:$|[\s)"'])/.test(languages ?? "") && /^en_US(?:$|@)/.test(locale ?? "")
  );
}

function configureIosEnglishLocale(deviceId) {
  const spawnPrefix = ["simctl", "spawn", "--standalone", deviceId];
  for (const args of [
    ["defaults", "write", "NSGlobalDomain", "AppleLanguages", "-array", "en-US"],
    ["defaults", "write", "NSGlobalDomain", "AppleLocale", "-string", "en_US"],
  ]) {
    capture("xcrun", [...spawnPrefix, ...args], { timeoutMs: 15000 });
  }

  const languages = capture(
    "xcrun",
    [...spawnPrefix, "defaults", "read", "NSGlobalDomain", "AppleLanguages"],
    { timeoutMs: 15000 },
  );
  const locale = capture(
    "xcrun",
    [...spawnPrefix, "defaults", "read", "NSGlobalDomain", "AppleLocale"],
    { timeoutMs: 15000 },
  );
  if (!isIosEnglishLocale({ languages, locale })) {
    throw new Error(
      `iOS E2E simulator locale must be en-US, but AppleLanguages=${languages} and AppleLocale=${locale}.`,
    );
  }
  log("ios", "Simulator locale: en-US.");
}

export async function buildIos({ cleanup, root, workers }) {
  log("ios", "Building the standalone Release app without booting a simulator.");
  const args = [
    "-workspace",
    "ios/PlogKit.xcworkspace",
    "-scheme",
    "PlogKit",
    "-configuration",
    "Release",
    "-sdk",
    "iphonesimulator",
    "-destination",
    "generic/platform=iOS Simulator",
    "-derivedDataPath",
    "ios/build",
  ];
  if (workers) args.push("-jobs", workers);
  args.push("-quiet", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "CODE_SIGNING_ALLOWED=NO", "build");
  await run("xcodebuild", args, {
    cleanup,
    cwd: root,
    env: createStandaloneBuildEnvironment(),
    timeoutMs: buildTimeoutMs,
  });
  assertIosStandaloneArtifact(root);
}

export function assertIosStandaloneArtifact(root) {
  const artifact = iosBuildArtifact(root);
  const bundle = join(artifact, "main.jsbundle");
  if (!existsSync(artifact) || !existsSync(bundle) || !statSync(bundle).isFile()) {
    throw new Error(`iOS Release artifact is missing its embedded main.jsbundle: ${bundle}`);
  }
  if (statSync(bundle).size === 0) {
    throw new Error(`iOS Release embedded main.jsbundle is empty: ${bundle}`);
  }
  if (!isHermesBytecode(readFileSync(bundle))) {
    throw new Error(`iOS Release embedded main.jsbundle is not Hermes bytecode: ${bundle}`);
  }
  const [symbols] = iosBuildSidecars(root);
  const dwarf = join(symbols, "Contents", "Resources", "DWARF", "PlogKit");
  if (!existsSync(symbols) || !existsSync(dwarf) || !statSync(dwarf).isFile()) {
    throw new Error(`iOS Release dSYM is missing its PlogKit DWARF binary: ${dwarf}`);
  }
  if (statSync(dwarf).size === 0) {
    throw new Error(`iOS Release dSYM DWARF binary is empty: ${dwarf}`);
  }
  assertIosExpoModulesCoreAbi(artifact);
}

export async function prepareIosDevice({
  artifactRoot,
  cleanup,
  deletionVerificationTimeoutMs = 30000,
  lifecycleTimeoutMs = deviceLifecycleTimeoutMs,
}) {
  try {
    const device = createEphemeralIosDevice();

    cleanup.add(async () => {
      log("ios", `Deleting owned simulator ${device.name} (${device.udid}).`);
      await deleteOwnedIosDevice(device.udid, artifactRoot, deletionVerificationTimeoutMs);
    });
    log("ios", `Created owned simulator ${device.name} (${device.udid}).`);

    // SpringBoard and permission prompts read locale at first process startup.
    // Configure the newly-created, still-shutdown device before its only boot.
    configureIosEnglishLocale(device.udid);
    await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], {
      cleanup,
      timeoutMs: lifecycleTimeoutMs,
    });
    return { platform: "ios", deviceId: device.udid };
  } catch (error) {
    const prepareEvidencePath = artifactRoot ? join(artifactRoot, "ios-prepare.log") : null;
    try {
      if (!prepareEvidencePath) {
        throw new Error("iOS prepare evidence requires artifactRoot.");
      }
      const simulatorState = capture("xcrun", ["simctl", "list", "devices", "-j"], {
        allowFailure: true,
        timeoutMs: iosPrepareEvidenceProbeTimeoutMs,
      });
      writeFileSync(
        prepareEvidencePath,
        boundedEvidence(
          `=== prepare failure ===\n${publicE2eErrorText(
            error,
          )}\n\n=== raw simulator state ===\n${simulatorState ?? "(probe failed or timed out)"}\n`,
          iosPrepareEvidenceMaxBytes,
        ),
      );
    } catch (evidenceError) {
      const aggregate = new AggregateError(
        [error, evidenceError],
        `${error instanceof Error ? error.message : String(error)}\n` +
          `Unable to preserve bounded iOS prepare evidence${
            prepareEvidencePath ? ` at ${prepareEvidencePath}` : ""
          }.`,
        { cause: error },
      );
      if (error?.code) aggregate.code = error.code;
      throw aggregate;
    }
    throw error;
  }
}

export async function assertIosGuestHealthy({
  artifactRoot,
  cleanup,
  device,
  timeoutMs = iosGuestHealthTimeoutMs,
}) {
  const startedAtMs = Date.now();
  const remainingTimeout = () => Math.max(1, timeoutMs - (Date.now() - startedAtMs));
  const diagnosticDirectory = join(artifactRoot, "ios", "guest-health");
  let evidenceAvailable = true;
  try {
    mkdirSync(diagnosticDirectory, { recursive: true });
  } catch (error) {
    evidenceAvailable = false;
    log(
      "ios",
      `Guest-health evidence unavailable: ${
        error instanceof Error
          ? `${error.name}${error.code ? ` (${error.code})` : ""}`
          : "NonErrorFailure"
      }`,
    );
  }
  const preserveEvidence = (name, contents) => {
    if (!evidenceAvailable) return;
    try {
      writeFileSync(join(diagnosticDirectory, name), contents);
    } catch (error) {
      log(
        "ios",
        `Guest-health evidence write failed: ${
          error instanceof Error
            ? `${error.name}${error.code ? ` (${error.code})` : ""}`
            : "NonErrorFailure"
        }`,
      );
    }
  };

  const args = [
    "simctl",
    "spawn",
    device.deviceId,
    "launchctl",
    "print",
    "system/com.apple.SpringBoard",
  ];
  let output;
  const probeStartedAtMs = Date.now();
  try {
    output = await captureBoundedCommand("xcrun", args, {
      cleanup,
      maxBytes: iosGuestHealthMaxBytes,
      timeoutMs: remainingTimeout(),
    });
  } catch (error) {
    preserveEvidence(
      "springboard-service.probe.json",
      `${JSON.stringify(
        {
          durationMs: Date.now() - probeStartedAtMs,
          error: {
            code: error?.code ?? null,
            name: error instanceof Error ? error.name : "NonErrorFailure",
          },
          status: "failed",
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  }
  preserveEvidence("springboard-service.txt", `${output}\n`);
  if (!/\bstate\s*=\s*running\b/i.test(output) || !/\bpid\s*=\s*[1-9]\d*\b/i.test(output)) {
    throw new Error("iOS guest health did not expose a running SpringBoard service with a PID.");
  }
  log("ios", `CoreSimulator guest health ready on ${device.deviceId}.`);
}

const IOS_SYSTEM_UI_FAULT_PATTERN =
  /(?:SpringBoard|backboardd|CoreSimulator|Simulator)[^\n]{0,200}(?:quit unexpectedly|crash(?:ed)?|not responding|unavailable|failed)/i;

export function assertIosLauncherHierarchy(hierarchy) {
  if (IOS_SYSTEM_UI_FAULT_PATTERN.test(hierarchy)) {
    throw new Error(`iOS readiness hierarchy contains a system UI fault:\n${hierarchy}`);
  }
  if (!/"resource-id"\s*:\s*"Home screen icons"/.test(hierarchy)) {
    throw new Error(`iOS readiness did not expose the SpringBoard Home screen launcher hierarchy.`);
  }
}

export async function assertIosDeviceReady({
  artifactRoot,
  cleanup,
  device,
  readinessTimeoutMs = iosReadinessTimeoutMs,
  stage = "readiness",
}) {
  const diagnosticDirectory = join(artifactRoot, "ios", `readiness-${stage}`);
  mkdirSync(diagnosticDirectory, { recursive: true });
  const hierarchyPath = join(diagnosticDirectory, "springboard-hierarchy.json");
  const hierarchyArgs = ["--device", device.deviceId, "hierarchy", "--no-ansi"];
  try {
    await run("maestro", hierarchyArgs, {
      cleanup,
      env: createMaestroEnvironment(),
      outputPath: hierarchyPath,
      stdio: "ignore",
      timeoutMs: readinessTimeoutMs,
    });
  } catch (error) {
    try {
      const metadata = error?.commandMetadata ?? {
        argumentCount: hierarchyArgs.length,
        bytes: existsSync(hierarchyPath) ? statSync(hierarchyPath).size : 0,
        executable: "maestro",
        exitCode: null,
        signal: null,
        timedOut: error?.code === "E2E_COMMAND_TIMEOUT",
      };
      writeFileSync(
        join(diagnosticDirectory, "springboard-hierarchy-probe.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    } catch (diagnosticError) {
      log(
        "ios",
        `Unable to preserve hierarchy probe metadata: ${
          diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
        }`,
      );
    }
    throw error;
  }
  const hierarchy = readFileSync(hierarchyPath, "utf8");
  assertIosLauncherHierarchy(hierarchy);
  log("ios", `SpringBoard launcher hierarchy ready on ${device.deviceId}.`);
}

export async function installAndSeedIos({
  artifact,
  cleanup,
  device,
  fixtures,
  lifecycleTimeoutMs = deviceLifecycleTimeoutMs,
  root,
}) {
  log("ios", "Installing the standalone Release app and seeding photos.");
  await run("xcrun", ["simctl", "install", device.deviceId, artifact], {
    cleanup,
    cwd: root,
    timeoutMs: lifecycleTimeoutMs,
  });
  await run("xcrun", ["simctl", "addmedia", device.deviceId, ...fixtures], {
    cleanup,
    cwd: root,
    timeoutMs: lifecycleTimeoutMs,
  });
  await waitUntil(
    () => captureIosPhotoResources(device).size >= fixtures.length,
    10000,
    `iOS Photos to index ${fixtures.length} seeded resources`,
    500,
  );
}

function captureMediaFiles(directory, relativeDirectory = "") {
  if (!existsSync(directory)) return new Set();
  const resources = new Set();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      for (const nested of captureMediaFiles(path, relativePath)) resources.add(nested);
    } else if (
      entry.isFile() &&
      /\.(?:heic|jpe?g|png)$/i.test(entry.name) &&
      statSync(path).size > 0
    ) {
      resources.add(relativePath);
    }
  }
  return resources;
}

export function captureIosPhotoResources(device) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device.deviceId)) {
    throw new Error(`Invalid iOS Simulator identifier: ${device.deviceId}`);
  }
  return captureMediaFiles(
    join(
      homedir(),
      "Library",
      "Developer",
      "CoreSimulator",
      "Devices",
      device.deviceId,
      "data",
      "Media",
      "DCIM",
    ),
  );
}

export function iosBuildArtifact(root) {
  return resolve(root, appPath);
}

export function iosBuildSidecars(root) {
  return [resolve(root, `${appPath}.dSYM`)];
}
