import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import { capture, log, run, waitUntil } from "./runtime.mjs";

const deviceName = "PlogKit E2E";
const runtimeIdentifier = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const deviceTypeName = "iPhone 17 Pro";
const appPath = "ios/build/Build/Products/Debug-iphonesimulator/PlogKit.app";

export function validateIosHost() {
  if (platform() !== "darwin") {
    throw new Error("iOS E2E requires macOS. Run the Android-only command on this host.");
  }
}

export function validateIosEnvironment() {
  // Record Xcode version and path.
  const xcodePath = capture("xcode-select", ["-p"], { allowFailure: true });
  const xcodeVersion = capture("xcodebuild", ["-version"], { allowFailure: true });
  log("ios", `Xcode: ${xcodePath ?? "unknown"}`);
  if (xcodeVersion) {
    for (const line of xcodeVersion.split("\n")) log("ios", `  ${line}`);
  }

  // Record Maestro version.
  const maestroVersion = capture("maestro", ["--version"], { allowFailure: true });
  if (maestroVersion) log("ios", `Maestro: ${maestroVersion}`);
  else log("ios", "Maestro: not found — install it before running iOS E2E.");

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

  // Warn on Xcode beta: React Native build compatibility is not fully verified
  // with prerelease toolchains (see issue #11 and #23 investigations).
  if (xcodeVersion && /\bbeta\b/i.test(xcodeVersion)) {
    log(
      "ios",
      "WARNING: Xcode beta toolchain detected. React Native build compatibility " +
        "with beta Xcode is not fully verified. If you encounter unexpected build " +
        "failures or XCTest instability, retry with a stable Xcode release " +
        "(see docs/guides/dev-environment.md).",
    );
  }

  log("ios", "iOS environment validation passed.");
}

function requiredRuntime() {
  const runtimes = JSON.parse(capture("xcrun", ["simctl", "list", "runtimes", "-j"]));
  return runtimes.runtimes.find(
    (runtime) => runtime.isAvailable && runtime.identifier === runtimeIdentifier,
  );
}

function requiredDeviceType() {
  const result = JSON.parse(capture("xcrun", ["simctl", "list", "devicetypes", "-j"]));
  return result.devicetypes.find((device) => device.name === deviceTypeName);
}

function findDevice(deviceTypeIdentifier) {
  const result = JSON.parse(capture("xcrun", ["simctl", "list", "devices", "available", "-j"]));
  return result.devices[runtimeIdentifier]?.find(
    (device) => device.name === deviceName && device.deviceTypeIdentifier === deviceTypeIdentifier,
  );
}

function ensureDedicatedDevice() {
  const runtime = requiredRuntime();
  const deviceType = requiredDeviceType();
  if (!runtime || !deviceType) {
    throw new Error("iOS 26.5 and the iPhone 17 Pro device type are required for iOS E2E.");
  }
  const existing = findDevice(deviceType.identifier);
  if (existing) return existing;
  const udid = capture("xcrun", [
    "simctl",
    "create",
    deviceName,
    deviceType.identifier,
    runtime.identifier,
  ]);
  log("ios", `Created dedicated simulator ${udid}.`);
  return { name: deviceName, state: "Shutdown", udid };
}

export async function buildIos({ cleanup, root, workers }) {
  log("ios", "Building the development build without booting a simulator.");
  const args = [
    "-workspace",
    "ios/PlogKit.xcworkspace",
    "-scheme",
    "PlogKit",
    "-configuration",
    "Debug",
    "-sdk",
    "iphonesimulator",
    "-destination",
    "generic/platform=iOS Simulator",
    "-derivedDataPath",
    "ios/build",
  ];
  if (workers) args.push("-jobs", workers);
  args.push("-quiet", "CODE_SIGNING_ALLOWED=NO", "build");
  await run("xcodebuild", args, { cleanup, cwd: root });
}

export async function prepareIosDevice({ cleanup }) {
  const device = ensureDedicatedDevice();

  if (device.state === "Booted") {
    capture("xcrun", ["simctl", "shutdown", device.udid], { allowFailure: true });
  }
  capture("xcrun", ["simctl", "erase", device.udid]);
  capture("xcrun", ["simctl", "boot", device.udid]);

  cleanup.add(async () => {
    log("ios", "Shutting down the dedicated simulator.");
    capture("xcrun", ["simctl", "shutdown", device.udid], { allowFailure: true });
  });
  await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], { cleanup });
  return { platform: "ios", deviceId: device.udid };
}

export async function installAndSeedIos({ cleanup, device, fixtures, root }) {
  const binary = resolve(root, appPath);
  log("ios", "Installing the development build and seeding photos.");
  await run("xcrun", ["simctl", "install", device.deviceId, binary], { cleanup, cwd: root });
  await run("xcrun", ["simctl", "addmedia", device.deviceId, ...fixtures], {
    cleanup,
    cwd: root,
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
