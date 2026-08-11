import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import { capture, log, run, waitUntil } from "./runtime.mjs";
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
const appIdentifier = "com.leonzym.plogkit";
const appPath = "ios/build/Build/Products/Release-iphonesimulator/PlogKit.app";
const buildTimeoutMs = 45 * 60 * 1000;
const deviceLifecycleTimeoutMs = 3 * 60 * 1000;

export function validateIosHost() {
  if (platform() !== "darwin") {
    throw new Error("iOS E2E requires macOS. Run the Android-only command on this host.");
  }
}

export function validateIosEnvironment() {
  // Record Xcode version and path.
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

  // Verify required runtime is available.
  const runtime = requiredRuntime();
  if (!runtime) {
    throw new Error(
      `iOS Simulator runtime ${runtimeIdentifier} is not available. ` +
        "Install it via Xcode → Settings → Platforms, then retry.",
    );
  }
  log("ios", `Simulator runtime: ${runtime.name} (${runtime.version})`);

  // Verify required device type exists.
  const deviceType = requiredDeviceType();
  if (!deviceType) {
    throw new Error(
      `Device type "${deviceTypeName}" is not available. ` +
        "Install the iOS Simulator platform via Xcode → Settings → Platforms.",
    );
  }

  log("ios", "iOS environment validation passed.");
}

function requiredRuntime() {
  const runtimes = JSON.parse(
    capture("xcrun", ["simctl", "list", "runtimes", "-j"], { timeoutMs: 15000 }),
  );
  return runtimes.runtimes.find(
    (runtime) => runtime.isAvailable && runtime.identifier === runtimeIdentifier,
  );
}

function requiredDeviceType() {
  const result = JSON.parse(
    capture("xcrun", ["simctl", "list", "devicetypes", "-j"], { timeoutMs: 15000 }),
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

async function deleteOwnedIosDevice(deviceId) {
  let shutdownError = null;
  let deleteError = null;
  try {
    await shutdownIosDevice(deviceId);
  } catch (error) {
    shutdownError = error;
  }
  try {
    capture("xcrun", ["simctl", "delete", deviceId], { timeoutMs: 30000 });
  } catch (error) {
    deleteError = error;
  }
  if (!deleteError) return;
  if (shutdownError && deleteError) {
    throw new AggregateError(
      [shutdownError, deleteError],
      `Unable to shut down or delete owned iOS Simulator ${deviceId}.`,
    );
  }
  throw deleteError;
}

export function isIosEnglishLocale({ languages, locale }) {
  return (
    /(?:^|[\s("'])en-US(?:$|[\s)"'])/.test(languages ?? "") && /^en_US(?:$|@)/.test(locale ?? "")
  );
}

async function configureIosEnglishLocale({ cleanup, deviceId, lifecycleTimeoutMs }) {
  for (const args of [
    ["defaults", "write", "NSGlobalDomain", "AppleLanguages", "-array", "en-US"],
    ["defaults", "write", "NSGlobalDomain", "AppleLocale", "-string", "en_US"],
  ]) {
    capture("xcrun", ["simctl", "spawn", deviceId, ...args], { timeoutMs: 15000 });
  }

  // SpringBoard and permission prompts read locale at process startup. A
  // shutdown/boot boundary makes the preference effective for system UI too.
  await shutdownIosDevice(deviceId);
  capture("xcrun", ["simctl", "boot", deviceId], { timeoutMs: 30000 });
  await run("xcrun", ["simctl", "bootstatus", deviceId, "-b"], {
    cleanup,
    timeoutMs: lifecycleTimeoutMs,
  });

  const languages = capture(
    "xcrun",
    ["simctl", "spawn", deviceId, "defaults", "read", "NSGlobalDomain", "AppleLanguages"],
    { timeoutMs: 15000 },
  );
  const locale = capture(
    "xcrun",
    ["simctl", "spawn", deviceId, "defaults", "read", "NSGlobalDomain", "AppleLocale"],
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

export async function prepareIosDevice({ cleanup, lifecycleTimeoutMs = deviceLifecycleTimeoutMs }) {
  const device = createEphemeralIosDevice();

  cleanup.add(async () => {
    log("ios", `Deleting owned simulator ${device.name} (${device.udid}).`);
    await deleteOwnedIosDevice(device.udid);
  });
  log("ios", `Created owned simulator ${device.name} (${device.udid}).`);

  capture("xcrun", ["simctl", "boot", device.udid], { timeoutMs: 30000 });
  await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], {
    cleanup,
    timeoutMs: lifecycleTimeoutMs,
  });
  await configureIosEnglishLocale({
    cleanup,
    deviceId: device.udid,
    lifecycleTimeoutMs,
  });
  return { platform: "ios", deviceId: device.udid };
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

export async function assertIosDeviceReady({ artifactRoot, cleanup, device, stage = "readiness" }) {
  const diagnosticDirectory = join(artifactRoot, "ios", `readiness-${stage}`);
  mkdirSync(diagnosticDirectory, { recursive: true });
  const hierarchyPath = join(diagnosticDirectory, "springboard-hierarchy.json");
  await run("maestro", ["--device", device.deviceId, "hierarchy", "--no-ansi"], {
    cleanup,
    env: createMaestroEnvironment(),
    outputPath: hierarchyPath,
    stdio: "ignore",
    timeoutMs: 120000,
  });
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
  await resetIosPhotoPermissions({ cleanup, device, lifecycleTimeoutMs });
}

export async function resetIosPhotoPermissions({
  cleanup,
  device,
  lifecycleTimeoutMs = deviceLifecycleTimeoutMs,
}) {
  for (const service of ["photos-add", "photos"]) {
    await run("xcrun", ["simctl", "privacy", device.deviceId, "reset", service, appIdentifier], {
      cleanup,
      timeoutMs: lifecycleTimeoutMs,
    });
  }
  log("ios", "Reset Photos add-only and full-access decisions for first-permission coverage.");
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
