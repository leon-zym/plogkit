import { platform } from "node:os";
import { resolve } from "node:path";

import { capture, log, run } from "./runtime.mjs";

const deviceName = "PlogKit E2E";
const runtimeIdentifier = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const deviceTypeName = "iPhone 17 Pro";
const appPath = "ios/build/Build/Products/Debug-iphonesimulator/PlogKit.app";

export function validateIosHost() {
  if (platform() !== "darwin") {
    throw new Error("iOS E2E requires macOS. Run the Android-only command on this host.");
  }
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

function findDeviceById(deviceId) {
  const result = JSON.parse(capture("xcrun", ["simctl", "list", "devices", "available", "-j"]));
  return Object.values(result.devices)
    .flat()
    .find((device) => device.udid === deviceId);
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

export async function prepareIosDevice({ cleanup, externalDeviceId }) {
  const device = externalDeviceId ? findDeviceById(externalDeviceId) : ensureDedicatedDevice();
  if (!device) throw new Error(`iOS Simulator is unavailable: ${externalDeviceId}`);

  if (device.state === "Booted") {
    capture("xcrun", ["simctl", "shutdown", device.udid], { allowFailure: true });
  }
  capture("xcrun", ["simctl", "erase", device.udid]);
  capture("xcrun", ["simctl", "boot", device.udid]);

  if (!externalDeviceId) {
    cleanup.add(async () => {
      log("ios", "Shutting down the dedicated simulator.");
      capture("xcrun", ["simctl", "shutdown", device.udid], { allowFailure: true });
    });
  }
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
}

export function iosBuildArtifact(root) {
  return resolve(root, appPath);
}
