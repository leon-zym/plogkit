import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync } from "node:fs";
import { arch } from "node:os";
import { join, resolve } from "node:path";

import { capture, collectFailureDiagnostics, log, run, waitUntil } from "./runtime.mjs";

const avdName = "PlogKit_E2E";
const appPath = "android/app/build/outputs/apk/debug/app-debug.apk";
const readinessProbeTimeoutMs = 15000;
const readinessHierarchyPath = "/sdcard/plogkit-e2e-window.xml";

function captureReadinessProbe(serial, args) {
  return capture("adb", ["-s", serial, ...args], {
    allowFailure: true,
    timeoutMs: readinessProbeTimeoutMs,
  });
}

export function recordAndroidReadinessSnapshot({ artifactRoot, deviceId: serial, stage }) {
  try {
    let content = `=== ${stage} state snapshot ===\n`;
    for (const [label, args] of [
      ["boot completed", ["shell", "getprop", "sys.boot_completed"]],
      ["boot animation", ["shell", "getprop", "init.svc.bootanim"]],
      ["device provisioned", ["shell", "settings", "get", "global", "device_provisioned"]],
      ["package manager", ["shell", "pm", "path", "android"]],
      ["service check window", ["shell", "service", "check", "window"]],
      ["service check accessibility", ["shell", "service", "check", "accessibility"]],
      ["dumpsys window", ["shell", "dumpsys", "window"]],
      ["dumpsys activity", ["shell", "dumpsys", "activity"]],
      ["service list", ["shell", "service", "list"]],
      ["getprop", ["shell", "getprop"]],
    ]) {
      const output = captureReadinessProbe(serial, args);
      content += `--- ${label} ---\n${output ?? "(failed)"}\n\n`;
    }
    const hierarchyDump = captureReadinessProbe(serial, [
      "shell",
      "uiautomator",
      "dump",
      readinessHierarchyPath,
    ]);
    const hierarchy = hierarchyDump
      ? captureReadinessProbe(serial, ["exec-out", "cat", readinessHierarchyPath])
      : null;
    content +=
      `--- UI hierarchy dump ---\n${hierarchyDump ?? "(failed)"}\n\n` +
      `--- UI hierarchy ---\n${hierarchy ?? "(failed)"}\n\n`;
    appendFileSync(join(artifactRoot, `android-readiness-${serial}.log`), content);
  } catch {
    // Readiness diagnostics are best-effort and must preserve the original failure.
  }
}

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
      "pixel_7_pro",
    ],
    { allowFailure: true, input: "no\n" },
  );
  if (result === null) {
    throw new Error(
      `Unable to create ${avdName}. Run avdmanager with package ${systemImage} and device pixel_7_pro.`,
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
    () => captureReadinessProbe(serial, ["shell", "getprop", "sys.boot_completed"]) === "1",
    180000,
    `Android device ${serial} to finish booting`,
    2000,
  );
}

const SYSTEM_UI_ANR_PATTERN =
  /(System UI isn['’]t responding|Application Not Responding:\s*System UI|AppNotRespondingDialog|android:id\/aerr_(?:close|wait))/i;

export function isAndroidServiceAvailable(output) {
  return output !== null && /^Service(?:\s+\S+:)?\s+found$/im.test(output);
}

export function androidEmulatorArguments() {
  return [
    "-avd",
    avdName,
    "-wipe-data",
    "-no-snapshot",
    "-no-boot-anim",
    "-no-window",
    "-gpu",
    "host",
    "-no-audio",
    "-camera-back",
    "none",
    "-camera-front",
    "none",
  ];
}

async function waitForSystemUi(serial, artifactRoot, stage) {
  // Boot animation must be done — either "stopped", or the property was
  // never set (common with -no-boot-anim). Only "running" means still in
  // progress.
  await waitUntil(
    () => {
      const value = captureReadinessProbe(serial, ["shell", "getprop", "init.svc.bootanim"]);
      return value !== null && value !== "running";
    },
    30000,
    `Android device ${serial} boot animation to finish`,
    2000,
  );

  // Device must be provisioned (setup wizard completed).
  await waitUntil(
    () =>
      captureReadinessProbe(serial, [
        "shell",
        "settings",
        "get",
        "global",
        "device_provisioned",
      ]) === "1",
    30000,
    `Android device ${serial} to be provisioned`,
    2000,
  );

  // Package manager must be able to resolve at least the android system package.
  await waitUntil(
    () => {
      const output = captureReadinessProbe(serial, ["shell", "pm", "path", "android"]);
      return output !== null && output.length > 0;
    },
    30000,
    `Android device ${serial} package manager to respond`,
    2000,
  );

  // Window and accessibility services must be registered before the
  // functional launcher and hierarchy probes below can be meaningful.
  await waitUntil(
    () => {
      const wm = captureReadinessProbe(serial, ["shell", "service", "check", "window"]);
      const acc = captureReadinessProbe(serial, ["shell", "service", "check", "accessibility"]);
      return isAndroidServiceAvailable(wm) && isAndroidServiceAvailable(acc);
    },
    120000,
    `Android device ${serial} system services to become ready`,
    2000,
  );

  // Exercise the same launcher and accessibility surfaces Maestro depends on.
  // A registered Binder service alone does not prove that either surface can
  // respond, and an ANR dialog must fail readiness rather than be dismissed.
  const home = await waitUntil(
    () => {
      const output = captureReadinessProbe(serial, [
        "shell",
        "am",
        "start",
        "-W",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.HOME",
      ]);
      return output && /^Status:\s*ok$/im.test(output) && !/\bFallbackHome\b/.test(output)
        ? output
        : false;
    },
    120000,
    `Android device ${serial} launcher to replace FallbackHome`,
    2000,
  );
  let hierarchyDump = null;
  let hierarchy = null;
  let hierarchyError = null;
  try {
    hierarchy = await waitUntil(
      () => {
        hierarchyDump = captureReadinessProbe(serial, [
          "shell",
          "uiautomator",
          "dump",
          readinessHierarchyPath,
        ]);
        return hierarchyDump
          ? captureReadinessProbe(serial, ["exec-out", "cat", readinessHierarchyPath])
          : false;
      },
      120000,
      `Android device ${serial} UI hierarchy to respond`,
      2000,
    );
  } catch (error) {
    hierarchyError = error;
  }
  const windowState = captureReadinessProbe(serial, ["shell", "dumpsys", "window"]);

  const diag = join(artifactRoot, `android-readiness-${serial}.log`);
  appendFileSync(
    diag,
    `=== ${stage} ===\n--- launcher probe ---\n${home ?? "(failed)"}\n\n` +
      `--- dumpsys window ---\n${windowState ?? "(failed)"}\n\n` +
      `--- UI hierarchy dump ---\n${hierarchyDump ?? "(failed)"}\n\n` +
      `--- UI hierarchy ---\n${hierarchy ?? "(failed)"}\n\n`,
  );

  const functionalEvidence = `${windowState ?? ""}\n${hierarchy ?? ""}`;
  if (SYSTEM_UI_ANR_PATTERN.test(functionalEvidence)) {
    throw new Error(`Android System UI ANR dialog detected on ${serial}.`);
  }
  if (!hierarchy) {
    throw new Error(`Android UI hierarchy did not respond on ${serial}.`, {
      cause: hierarchyError,
    });
  }

  // Save a snapshot of system state for diagnostics.
  try {
    let content = "";
    for (const [label, cmd] of [
      ["dumpsys window", ["shell", "dumpsys", "window"]],
      ["dumpsys activity", ["shell", "dumpsys", "activity"]],
      ["service list", ["shell", "service", "list"]],
      ["getprop", ["shell", "getprop"]],
    ]) {
      const out = captureReadinessProbe(serial, cmd);
      content += `--- ${label} ---\n${out ?? "(failed)"}\n\n`;
    }
    appendFileSync(diag, content);
  } catch {
    // Diagnostic collection is best-effort; never block readiness on it.
  }

  log("android", `System UI ready on ${serial}.`);
}

export async function assertAndroidDeviceReady({ artifactRoot, device, stage = "readiness" }) {
  try {
    await waitForSystemUi(device.deviceId, artifactRoot, stage);
  } catch (error) {
    recordAndroidReadinessSnapshot({ artifactRoot, deviceId: device.deviceId, stage });
    const message = error instanceof Error ? error.message : String(error);
    await collectFailureDiagnostics({
      diagnosticDirectory: join(artifactRoot, "android", `readiness-${stage}`),
      device,
      error: message,
      kind: "system-ui",
    });
    throw error;
  }
}

export async function prepareAndroidDevice({ artifactRoot, cleanup, externalDeviceId }) {
  if (externalDeviceId) {
    await run("adb", ["-s", externalDeviceId, "wait-for-device"], { cleanup });
    await waitForBoot(externalDeviceId);
    const device = { platform: "android", deviceId: externalDeviceId };
    await assertAndroidDeviceReady({ artifactRoot, device, stage: "boot" });
    return device;
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
    androidEmulatorArguments(),
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
  const device = { platform: "android", deviceId: serial };
  await assertAndroidDeviceReady({ artifactRoot, device, stage: "boot" });
  return device;
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
  const fixtureNames = fixtures.map((fixture) => fixture.split("/").at(-1));
  await waitUntil(
    () => {
      const output = queryAndroidPhotos(device);
      return fixtureNames.every((name) => output.includes(`_display_name=${name}`));
    },
    10000,
    `Android MediaStore to index ${fixtureNames.join(" and ")}`,
    500,
  );
}

function queryAndroidPhotos(device) {
  return capture("adb", [
    "-s",
    device.deviceId,
    "shell",
    "content",
    "query",
    "--uri",
    "content://media/external/images/media",
    "--projection",
    "_id:_display_name:mime_type",
  ]);
}

export function captureAndroidPhotoResources(device) {
  return new Set(
    [...queryAndroidPhotos(device).matchAll(/(?:^|\s)_id=(\d+)/gm)].map((match) => match[1]),
  );
}

export function androidBuildArtifact(root) {
  return resolve(root, appPath);
}
