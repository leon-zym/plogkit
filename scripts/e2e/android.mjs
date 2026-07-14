import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync } from "node:fs";
import { arch } from "node:os";
import { join, resolve } from "node:path";

import { capture, log, run, waitUntil } from "./runtime.mjs";

const avdName = "PlogKit_E2E";
const appPath = "android/app/build/outputs/apk/debug/app-debug.apk";

function androidHome() {
  const value = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!value) throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT must point to the Android SDK.");
  return value;
}

function findTool(home, name) {
  const candidates = [
    join(home, "cmdline-tools", "latest", "bin", name),
    join(home, "tools", "bin", name),
  ];
  const commandLineTools = join(home, "cmdline-tools");
  if (existsSync(commandLineTools)) {
    for (const entry of readdirSync(commandLineTools).sort().reverse()) {
      candidates.push(join(commandLineTools, entry, "bin", name));
    }
  }
  return candidates.find(existsSync) ?? name;
}

function imageArchitecture() {
  return process.env.E2E_ANDROID_ARCH ?? (arch() === "arm64" ? "arm64-v8a" : "x86_64");
}

function connectedEmulators() {
  return capture("adb", ["devices"])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/, 2))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial);
}

function findDedicatedSerial() {
  for (const serial of connectedEmulators()) {
    const output = capture("adb", ["-s", serial, "emu", "avd", "name"], {
      allowFailure: true,
    });
    if (output?.split("\n", 1)[0]?.trim() === avdName) return serial;
  }
  return null;
}

function ensureAvd(home, emulator, imageArch) {
  const systemImage = `system-images;android-36;default;${imageArch}`;
  const imagePath = join(home, "system-images", "android-36", "default", imageArch);
  if (!existsSync(emulator)) throw new Error(`Android Emulator is missing: ${emulator}`);
  if (!existsSync(imagePath)) {
    throw new Error(
      `Required Android system image is missing: ${systemImage}. Install it with sdkmanager first.`,
    );
  }
  const avds = capture(emulator, ["-list-avds"])
    .split("\n")
    .map((value) => value.trim());
  if (avds.includes(avdName)) return;
  const avdmanager = findTool(home, "avdmanager");
  const result = capture(
    avdmanager,
    [
      "create",
      "avd",
      "--force",
      "--name",
      avdName,
      "--package",
      systemImage,
      "--device",
      "pixel_9",
    ],
    { allowFailure: true, input: "no\n" },
  );
  if (result === null) {
    throw new Error(
      `Unable to create ${avdName}. Run avdmanager with package ${systemImage} and device pixel_9.`,
    );
  }
  log("android", `Created dedicated AVD ${avdName}.`);
}

export async function buildAndroid({ cleanup, root, workers }) {
  log("android", "Building the development build without booting an emulator.");
  const args = ["app:assembleDebug", "--no-daemon"];
  if (workers) args.push(`--max-workers=${workers}`);
  args.push(`-PreactNativeArchitectures=${imageArchitecture()}`);
  await run("./gradlew", args, { cleanup, cwd: resolve(root, "android") });
}

async function waitForBoot(serial) {
  await waitUntil(
    () =>
      capture("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
        allowFailure: true,
      }) === "1",
    180000,
    `Android device ${serial} to finish booting`,
    2000,
  );
}

export async function prepareAndroidDevice({ artifactRoot, cleanup, externalDeviceId }) {
  if (externalDeviceId) {
    await run("adb", ["-s", externalDeviceId, "wait-for-device"], { cleanup });
    await waitForBoot(externalDeviceId);
    return { platform: "android", deviceId: externalDeviceId };
  }

  const home = androidHome();
  const emulator = join(home, "emulator", "emulator");
  const imageArch = imageArchitecture();
  ensureAvd(home, emulator, imageArch);

  const running = findDedicatedSerial();
  if (running) {
    capture("adb", ["-s", running, "emu", "kill"], { allowFailure: true });
    await waitUntil(() => !findDedicatedSerial(), 30000, "the previous E2E emulator to stop");
  }

  const emulatorLog = join(artifactRoot, "android-emulator.log");
  const logFd = openSync(emulatorLog, "w");
  const emulatorProcess = spawn(
    emulator,
    [
      "-avd",
      avdName,
      "-wipe-data",
      "-no-snapshot",
      "-no-boot-anim",
      "-no-window",
      "-camera-back",
      "none",
    ],
    { detached: false, stdio: ["ignore", logFd, logFd] },
  );
  emulatorProcess.once("error", (error) => {
    console.error(`[e2e:android] Emulator failed: ${String(error)}`);
  });
  closeSync(logFd);

  let serial = null;
  cleanup.add(async () => {
    log("android", "Stopping the dedicated emulator.");
    const activeSerial = serial ?? findDedicatedSerial();
    if (activeSerial) {
      capture("adb", ["-s", activeSerial, "emu", "kill"], { allowFailure: true });
    } else if (emulatorProcess.exitCode === null) {
      emulatorProcess.kill("SIGTERM");
    }
    if (emulatorProcess.exitCode === null) {
      await Promise.race([
        new Promise((resolvePromise) => emulatorProcess.once("exit", resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 20000)),
      ]);
    }
  });

  serial = await waitUntil(
    () => {
      if (emulatorProcess.exitCode !== null) {
        throw new Error(`Android Emulator exited early. See ${emulatorLog}`);
      }
      return findDedicatedSerial();
    },
    180000,
    `Android AVD ${avdName} to appear`,
    2000,
  );
  await waitForBoot(serial);
  return { platform: "android", deviceId: serial };
}

export async function installAndSeedAndroid({ cleanup, device, fixtures, root }) {
  log("android", "Installing the development build and seeding photos.");
  await run("adb", ["-s", device.deviceId, "install", "-r", resolve(root, appPath)], {
    cleanup,
    cwd: root,
  });
  const fixtureDirectory = "/sdcard/Pictures/PlogKitE2E";
  await run("adb", ["-s", device.deviceId, "shell", "rm", "-rf", fixtureDirectory], {
    cleanup,
  });
  await run("adb", ["-s", device.deviceId, "shell", "mkdir", "-p", fixtureDirectory], {
    cleanup,
  });
  for (const fixture of fixtures) {
    const name = fixture.split("/").at(-1);
    const destination = `${fixtureDirectory}/${name}`;
    await run("adb", ["-s", device.deviceId, "push", fixture, destination], { cleanup });
    await run(
      "adb",
      [
        "-s",
        device.deviceId,
        "shell",
        "am",
        "broadcast",
        "-a",
        "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
        "-d",
        `file://${destination}`,
      ],
      { cleanup },
    );
  }
}

export function androidBuildArtifact(root) {
  return resolve(root, appPath);
}
