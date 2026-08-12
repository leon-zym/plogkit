import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { arch, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { capture, log, run, terminateProcessTree, waitUntil } from "./runtime.mjs";
import { createStandaloneBuildEnvironment, isHermesBytecode } from "./environment.mjs";

const avdNamePrefix = "PlogKit_E2E_";
const appPath = "android/app/build/outputs/apk/release/app-release.apk";
const sourceMapPath =
  "android/app/build/generated/sourcemaps/react/release/index.android.bundle.map";
const nativeDebugSymbolsPath =
  "android/app/build/outputs/native-debug-symbols/release/native-debug-symbols.zip";
const requiredEmulatorVersion = "37.1.11.0";
const requiredEmulatorBuild = "15917651";
const requiredPlatformToolsVersion = "37.0.1-15733141";
const requiredCommandLineToolsRevision = "22.0";
const requiredSystemImageRevision = "2";
const buildTimeoutMs = 45 * 60 * 1000;
const deviceLifecycleTimeoutMs = 3 * 60 * 1000;
const readinessProbeTimeoutMs = 15000;
const lifecycleProbeTimeoutMs = 15000;
const systemUiReadinessTimeoutMs = 120000;
const androidLifecycleEvidenceBudgetBytes = 8 * 1024 * 1024;
const androidEmulatorEvidenceMaxBytes = androidLifecycleEvidenceBudgetBytes / 2;
const androidPrepareEvidenceMaxBytes = 1024 * 1024;
const androidReadinessEvidenceMaxBytes =
  androidLifecycleEvidenceBudgetBytes -
  androidEmulatorEvidenceMaxBytes -
  androidPrepareEvidenceMaxBytes;
const readinessHierarchyPath = "/sdcard/plogkit-e2e-window.xml";
const ANDROID_SYSTEM_UI_FAILURE =
  /System\s+UI\s+(?:(?:isn['’]t|is\s+not)\s+responding|has\s+stopped)|Application\s+Not\s+Responding:\s*System\s+UI|\bam_anr\b[^\n]{0,240}\bcom\.android\.systemui\b|(?:ANR|not\s+responding).{0,100}com\.android\.systemui|com\.android\.systemui.{0,100}(?:ANR|not\s+responding)/i;
const ANDROID_ANR_DIALOG =
  /AppNotRespondingDialog|android:id\/aerr_(?:close|wait)|Application\s+Not\s+Responding/i;

function hasAndroidSystemUiFailureEvidence(message) {
  return ANDROID_SYSTEM_UI_FAILURE.test(message);
}

function hasAndroidAnrDialogEvidence(message) {
  return ANDROID_ANR_DIALOG.test(message);
}

function boundedEvidenceFromHeadAndTail(head, tail, sourceBytes, maxBytes) {
  if (sourceBytes <= maxBytes) return head.subarray(0, sourceBytes);
  const marker = Buffer.from(
    `\n--- diagnostic bytes omitted from ${sourceBytes}-byte output ---\n`,
  );
  const contentBytes = maxBytes - marker.length;
  const headBytes = Math.floor(contentBytes / 2);
  const tailBytes = contentBytes - headBytes;
  return Buffer.concat([
    head.subarray(0, headBytes),
    marker,
    tail.subarray(tail.length - tailBytes),
  ]);
}

function boundedEvidence(value, maxBytes) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return boundedEvidenceFromHeadAndTail(source, source, source.length, maxBytes);
}

function writeFully(fd, value) {
  let offset = 0;
  while (offset < value.length) {
    const written = writeSync(fd, value, offset, value.length - offset);
    if (written === 0) throw new Error("Unable to make progress writing Android evidence.");
    offset += written;
  }
}

function createBoundedEvidenceFile(path, maxBytes) {
  const fd = openSync(path, "w");
  let finalized = false;
  const head = Buffer.allocUnsafe(maxBytes);
  let headBytes = 0;
  let sourceBytes = 0;
  const tail = Buffer.allocUnsafe(maxBytes);
  let tailBytes = 0;
  let tailOffset = 0;
  return {
    append(value) {
      if (finalized) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      sourceBytes += chunk.length;
      if (headBytes < maxBytes) {
        const initialBytes = Math.min(chunk.length, maxBytes - headBytes);
        chunk.copy(head, headBytes, 0, initialBytes);
        writeFully(fd, chunk.subarray(0, initialBytes));
        headBytes += initialBytes;
      }
      if (chunk.length >= maxBytes) {
        chunk.copy(tail, 0, chunk.length - maxBytes);
        tailBytes = maxBytes;
        tailOffset = 0;
      } else {
        const firstBytes = Math.min(chunk.length, maxBytes - tailOffset);
        chunk.copy(tail, tailOffset, 0, firstBytes);
        chunk.copy(tail, 0, firstBytes);
        tailBytes = Math.min(maxBytes, tailBytes + chunk.length);
        tailOffset = (tailOffset + chunk.length) % maxBytes;
      }
    },
    finish() {
      if (finalized) return;
      finalized = true;
      closeSync(fd);
      if (sourceBytes > maxBytes) {
        const orderedTail = Buffer.concat([
          tail.subarray(tailOffset, tailBytes),
          tail.subarray(0, tailOffset),
        ]);
        writeFileSync(
          path,
          boundedEvidenceFromHeadAndTail(
            head.subarray(0, headBytes),
            orderedTail,
            sourceBytes,
            maxBytes,
          ),
        );
      }
    },
  };
}

function captureReadinessProbe(device, args, { deadlineMs } = {}) {
  const timeoutMs = deadlineMs
    ? Math.max(0, Math.min(readinessProbeTimeoutMs, deadlineMs - Date.now()))
    : readinessProbeTimeoutMs;
  if (timeoutMs === 0) return null;
  return capture(device.adbPath, ["-s", device.deviceId, ...args], {
    allowFailure: true,
    timeoutMs,
  });
}

function androidHome() {
  const value = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!value) throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT must point to the Android SDK.");
  return value;
}

function androidAdbPath(home = androidHome()) {
  return join(home, "platform-tools", "adb");
}

function androidAvdManagerPath(home = androidHome()) {
  return join(home, "cmdline-tools", requiredCommandLineToolsRevision, "bin", "avdmanager");
}

function imageArchitecture() {
  return process.env.E2E_ANDROID_ARCH ?? (arch() === "arm64" ? "arm64-v8a" : "x86_64");
}

export function parseAdbPlatformToolsVersion(output) {
  return output?.match(/^\s*Version\s+([0-9][0-9A-Za-z.+-]*)(?:\s|$)/m)?.[1] ?? null;
}

export function validateAndroidEnvironment() {
  const home = androidHome();
  const imageArch = imageArchitecture();
  const emulator = join(home, "emulator", "emulator");
  if (!existsSync(emulator)) throw new Error(`Android Emulator is missing: ${emulator}`);
  const adbPath = androidAdbPath(home);
  if (!existsSync(adbPath))
    throw new Error(`Android SDK Platform-Tools adb is missing: ${adbPath}`);

  const adbVersionOutput = capture(adbPath, ["version"], { timeoutMs: lifecycleProbeTimeoutMs });
  const adbVersion = parseAdbPlatformToolsVersion(adbVersionOutput);
  if (!adbVersion) {
    throw new Error(
      `Unable to determine the Android SDK Platform-Tools package revision from adb version:\n${
        adbVersionOutput || "(empty output)"
      }`,
    );
  }
  if (adbVersion !== requiredPlatformToolsVersion) {
    throw new Error(
      `Android SDK Platform-Tools ${requiredPlatformToolsVersion} is required, but ${adbVersion} is installed.`,
    );
  }
  const avdmanager = androidAvdManagerPath(home);
  if (!existsSync(avdmanager)) {
    throw new Error(`Android SDK Command-line Tools are missing: ${avdmanager}`);
  }
  const commandLineToolsMetadata = join(
    home,
    "cmdline-tools",
    requiredCommandLineToolsRevision,
    "source.properties",
  );
  if (!existsSync(commandLineToolsMetadata)) {
    throw new Error(
      `Android SDK Command-line Tools metadata is missing: ${commandLineToolsMetadata}`,
    );
  }
  const commandLineToolsRevision = readFileSync(commandLineToolsMetadata, "utf8")
    .match(/^Pkg\.Revision\s*=\s*(.+)$/m)?.[1]
    ?.trim();
  if (!commandLineToolsRevision) {
    throw new Error(
      `Unable to determine the Android SDK Command-line Tools version from ${commandLineToolsMetadata}.`,
    );
  }
  if (commandLineToolsRevision !== requiredCommandLineToolsRevision) {
    throw new Error(
      `Android SDK Command-line Tools ${requiredCommandLineToolsRevision} is required, but ${commandLineToolsRevision} is installed.`,
    );
  }
  log(
    "android",
    `Platform-Tools Version ${adbVersion}; Command-line Tools Version ${commandLineToolsRevision}.`,
  );

  const versionOutput = capture(emulator, ["-version"], { timeoutMs: lifecycleProbeTimeoutMs });
  const versionMatch = versionOutput.match(
    /Android emulator version\s+(\S+)\s+\(build_id\s+(\d+)\)/,
  );
  const installedVersion = versionMatch?.[1] ?? "unknown";
  const installedBuild = versionMatch?.[2] ?? "unknown";
  if (installedVersion !== requiredEmulatorVersion || installedBuild !== requiredEmulatorBuild) {
    throw new Error(
      `Android Emulator ${requiredEmulatorVersion} (build ${requiredEmulatorBuild}) is required, ` +
        `but ${installedVersion} (build ${installedBuild}) is installed.`,
    );
  }

  const sourceProperties = join(
    home,
    "system-images",
    "android-36",
    "default",
    imageArch,
    "source.properties",
  );
  if (!existsSync(sourceProperties)) {
    throw new Error(`Required Android system image metadata is missing: ${sourceProperties}`);
  }
  const imageMetadata = readFileSync(sourceProperties, "utf8");
  const installedRevision = imageMetadata.match(/^Pkg\.Revision=(.+)$/m)?.[1]?.trim() ?? "unknown";
  if (installedRevision !== requiredSystemImageRevision) {
    throw new Error(
      `Android 36 default ${imageArch} system image revision ${requiredSystemImageRevision} is ` +
        `required, but revision ${installedRevision} is installed.`,
    );
  }
  log(
    "android",
    `Emulator ${installedVersion} (${installedBuild}); Android 36 default ${imageArch} revision ${installedRevision}.`,
  );
}

function connectedEmulators(adbPath, { allowFailure = false } = {}) {
  const output = capture(adbPath, ["devices"], {
    allowFailure,
    timeoutMs: lifecycleProbeTimeoutMs,
  });
  if (output === null) return [];
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/, 2))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial);
}

function findInvocationSerial(adbPath, avdName, previouslyConnected) {
  for (const serial of connectedEmulators(adbPath, { allowFailure: true })) {
    if (previouslyConnected.has(serial)) continue;
    const output = capture(adbPath, ["-s", serial, "emu", "avd", "name"], {
      allowFailure: true,
      timeoutMs: lifecycleProbeTimeoutMs,
    });
    if (output?.split("\n", 1)[0]?.trim() === avdName) return serial;
  }
  return null;
}

function createAvd(
  home,
  emulator,
  imageArch,
  avdHome,
  avdName,
  { timeoutMs = lifecycleProbeTimeoutMs } = {},
) {
  const systemImage = `system-images;android-36;default;${imageArch}`;
  const imagePath = join(home, "system-images", "android-36", "default", imageArch);
  if (!existsSync(emulator)) throw new Error(`Android Emulator is missing: ${emulator}`);
  if (!existsSync(imagePath)) {
    throw new Error(
      `Required Android system image is missing: ${systemImage}. Install it with sdkmanager first.`,
    );
  }
  const avdmanager = androidAvdManagerPath(home);
  if (!existsSync(avdmanager)) {
    throw new Error(`Android SDK Command-line Tools are missing: ${avdmanager}`);
  }
  capture(
    avdmanager,
    ["create", "avd", "--name", avdName, "--package", systemImage, "--device", "pixel_7_pro"],
    {
      env: { ...createStandaloneBuildEnvironment(), ANDROID_AVD_HOME: avdHome },
      input: "no\n",
      timeoutMs,
    },
  );
  log("android", `Created ephemeral AVD ${avdName} from ${systemImage}.`);
}

function controlledGradleUserHome(root) {
  const gradleHome = resolve(root, ".e2e-cache/gradle");
  mkdirSync(gradleHome, { recursive: true });
  const configuredPaths = ["gradle.properties", "init.gradle", "init.gradle.kts"]
    .map((name) => join(gradleHome, name))
    .filter(existsSync);
  const initDirectory = join(gradleHome, "init.d");
  if (existsSync(initDirectory) && readdirSync(initDirectory).length > 0) {
    configuredPaths.push(initDirectory);
  }
  if (configuredPaths.length > 0) {
    throw new Error(
      `Runner-owned Gradle home contains build configuration: ${configuredPaths.join(", ")}`,
    );
  }
  return gradleHome;
}

export async function buildAndroid({ cleanup, javaHome, root, workers }) {
  if (!javaHome || javaHome === "unknown") {
    throw new Error("Android Release build requires the validated Temurin java.home.");
  }
  log("android", "Building the standalone Release APK without booting an emulator.");
  const args = ["app:assembleRelease", "--no-daemon"];
  if (workers) args.push(`--max-workers=${workers}`);
  args.push(`-Dorg.gradle.java.home=${javaHome}`);
  args.push(`-PreactNativeArchitectures=${imageArchitecture()}`);
  await run("./gradlew", args, {
    cleanup,
    cwd: resolve(root, "android"),
    env: {
      ...createStandaloneBuildEnvironment(),
      GRADLE_USER_HOME: controlledGradleUserHome(root),
    },
    timeoutMs: buildTimeoutMs,
  });
  assertAndroidStandaloneArtifact(root);
}

function assertAndroidStandaloneArtifact(root) {
  const artifact = androidBuildArtifact(root);
  if (!existsSync(artifact) || !statSync(artifact).isFile() || statSync(artifact).size === 0) {
    throw new Error(`Android Release APK is missing or empty: ${artifact}`);
  }
  const bundle = spawnSync("unzip", ["-p", artifact, "assets/index.android.bundle"], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
  if (bundle.error || bundle.status !== 0 || !isHermesBytecode(bundle.stdout)) {
    throw new Error(`Android Release APK does not contain a Hermes assets/index.android.bundle.`);
  }
  const [sourceMap, nativeDebugSymbols] = androidBuildSidecars(root);
  if (!existsSync(sourceMap) || !statSync(sourceMap).isFile() || statSync(sourceMap).size === 0) {
    throw new Error(`Android Release source map is missing or empty: ${sourceMap}`);
  }
  if (
    !existsSync(nativeDebugSymbols) ||
    !statSync(nativeDebugSymbols).isFile() ||
    statSync(nativeDebugSymbols).size === 0
  ) {
    throw new Error(
      `Android Release native debug symbols are missing or empty: ${nativeDebugSymbols}`,
    );
  }
}

async function waitForBoot(device, timeoutMs) {
  await waitUntil(
    (deadlineMs) =>
      captureReadinessProbe(device, ["shell", "getprop", "sys.boot_completed"], {
        deadlineMs,
      }) === "1",
    timeoutMs,
    `Android device ${device.deviceId} to finish booting`,
    2000,
  );
}

function isAndroidEnglishLocaleConfig(output) {
  return output !== null && /(?:^|-)en-rUS(?:-|$)/m.test(output);
}

function parseAndroidComponent(output) {
  if (!output) return null;
  const match = output.match(
    /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/(\.?[A-Za-z][A-Za-z0-9_.$]*)/,
  );
  if (!match) return null;
  const packageName = match[1];
  const className = match[2].startsWith(".") ? `${packageName}${match[2]}` : match[2];
  return { className, packageName };
}

function sameAndroidComponent(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.packageName === right.packageName &&
    left.className === right.className
  );
}

function isExpectedLauncherStart(output, launcher) {
  if (!output || !launcher || !/^Status:\s*ok\s*$/im.test(output)) return false;
  const activityLine = output.split(/\r?\n/).find((line) => /^\s*Activity:\s*/i.test(line));
  return sameAndroidComponent(parseAndroidComponent(activityLine), launcher);
}

function isLauncherForeground({ activityState, hierarchy, launcher, windowState }) {
  if (!launcher || !activityState || !hierarchy || !windowState) return false;
  const resumedLine = activityState
    .split(/\r?\n/)
    .find((line) => /^\s*(?:mResumedActivity|ResumedActivity)\s*[:=]/.test(line));
  const focusedLine = windowState.split(/\r?\n/).find((line) => /\bmCurrentFocus\b/.test(line));
  const hierarchyOwnsWindow =
    hierarchy.includes(`package="${launcher.packageName}"`) ||
    hierarchy.includes(`package='${launcher.packageName}'`);
  return (
    sameAndroidComponent(parseAndroidComponent(resumedLine), launcher) &&
    sameAndroidComponent(parseAndroidComponent(focusedLine), launcher) &&
    hierarchyOwnsWindow
  );
}

function androidEmulatorArguments(avdName) {
  return [
    "-avd",
    avdName,
    "-no-snapshot",
    "-no-boot-anim",
    "-no-window",
    "-gpu",
    "swiftshader",
    "-cores",
    "2",
    "-memory",
    "4096",
    "-no-audio",
    "-camera-back",
    "none",
    "-camera-front",
    "none",
  ];
}

function hasProcessExited(process) {
  return process.exitCode !== null || process.signalCode !== null;
}

async function waitForSystemUi(
  device,
  artifactRoot,
  stage,
  readinessTimeoutMs = systemUiReadinessTimeoutMs,
) {
  const serial = device.deviceId;
  let locale = null;
  let resolvedHome = null;
  const launcher = await waitUntil(
    (deadlineMs) => {
      locale = captureReadinessProbe(device, ["shell", "am", "get-config"], { deadlineMs });
      if (!isAndroidEnglishLocaleConfig(locale)) return false;
      resolvedHome = captureReadinessProbe(
        device,
        [
          "shell",
          "cmd",
          "package",
          "resolve-activity",
          "--brief",
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.HOME",
        ],
        { deadlineMs },
      );
      const component = parseAndroidComponent(resolvedHome);
      return component && !/(?:^|\.)FallbackHome$/.test(component.className) ? component : false;
    },
    readinessTimeoutMs,
    `Android device ${serial} to expose an en-US real HOME activity`,
    2000,
  );

  // HOME is sent exactly once. Subsequent readiness polling is observational.
  const home = captureReadinessProbe(device, [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.HOME",
  ]);
  if (!isExpectedLauncherStart(home, launcher)) {
    throw new Error(
      `Android device ${serial} did not start resolved HOME ` +
        `${launcher.packageName}/${launcher.className} on the single readiness attempt:\n` +
        `${home ?? "(command failed)"}`,
    );
  }
  let hierarchyDump = null;
  let hierarchy = null;
  let activityState = null;
  let windowState = null;
  let eventLog = null;
  let hierarchyError = null;
  try {
    await waitUntil(
      (deadlineMs) => {
        hierarchyDump = captureReadinessProbe(
          device,
          ["shell", "uiautomator", "dump", readinessHierarchyPath],
          { deadlineMs },
        );
        hierarchy = hierarchyDump
          ? captureReadinessProbe(device, ["exec-out", "cat", readinessHierarchyPath], {
              deadlineMs,
            })
          : null;
        activityState = captureReadinessProbe(
          device,
          ["shell", "dumpsys", "activity", "activities"],
          { deadlineMs },
        );
        windowState = captureReadinessProbe(device, ["shell", "dumpsys", "window"], {
          deadlineMs,
        });
        eventLog = captureReadinessProbe(device, ["logcat", "-b", "events", "-d"], {
          deadlineMs,
        });
        const evidence = `${windowState ?? ""}\n${hierarchy ?? ""}\n${eventLog ?? ""}`;
        return (
          hasAndroidSystemUiFailureEvidence(evidence) ||
          hasAndroidAnrDialogEvidence(evidence) ||
          isLauncherForeground({ activityState, hierarchy, launcher, windowState })
        );
      },
      readinessTimeoutMs,
      `Android device ${serial} resolved HOME to own the foreground UI`,
      2000,
    );
  } catch (error) {
    hierarchyError = error;
  }

  const diag = join(artifactRoot, `android-readiness-${serial}.log`);
  writeFileSync(
    diag,
    boundedEvidence(
      `=== ${stage} ===\n--- locale ---\n${locale ?? "(failed)"}\n\n` +
        `--- resolved HOME ---\n${resolvedHome ?? "(failed)"}\n\n` +
        `--- launcher probe ---\n${home ?? "(failed)"}\n\n` +
        `--- dumpsys activity activities ---\n${activityState ?? "(failed)"}\n\n` +
        `--- dumpsys window ---\n${windowState ?? "(failed)"}\n\n` +
        `--- event log ---\n${eventLog ?? "(failed)"}\n\n` +
        `--- UI hierarchy dump ---\n${hierarchyDump ?? "(failed)"}\n\n` +
        `--- UI hierarchy ---\n${hierarchy ?? "(failed)"}\n\n`,
      androidReadinessEvidenceMaxBytes,
    ),
  );

  if (eventLog === null) {
    throw new Error(`Android event log did not respond on ${serial}.`);
  }
  const functionalEvidence = `${windowState ?? ""}\n${hierarchy ?? ""}\n${eventLog}`;
  if (
    hasAndroidSystemUiFailureEvidence(functionalEvidence) ||
    hasAndroidAnrDialogEvidence(functionalEvidence)
  ) {
    throw new Error(`Android blocking ANR detected on ${serial}.`);
  }
  if (!hierarchy) {
    throw new Error(`Android UI hierarchy did not respond on ${serial}.`, {
      cause: hierarchyError,
    });
  }
  if (!isLauncherForeground({ activityState, hierarchy, launcher, windowState })) {
    throw new Error(`Android resolved HOME is not the foreground UI on ${serial}.`, {
      cause: hierarchyError,
    });
  }

  for (const setting of [
    "window_animation_scale",
    "transition_animation_scale",
    "animator_duration_scale",
  ]) {
    capture(device.adbPath, ["-s", serial, "shell", "settings", "put", "global", setting, "0"], {
      timeoutMs: readinessProbeTimeoutMs,
    });
  }

  log("android", `System UI ready on ${serial}.`);
}

export async function assertAndroidDeviceReady({
  artifactRoot,
  device,
  readinessTimeoutMs = systemUiReadinessTimeoutMs,
  stage = "readiness",
}) {
  await waitForSystemUi(device, artifactRoot, stage, readinessTimeoutMs);
}

async function prepareOwnedAndroidDevice({
  artifactRoot,
  bootTimeoutMs = deviceLifecycleTimeoutMs,
  cleanup,
}) {
  const home = androidHome();
  const adbPath = androidAdbPath(home);
  const emulator = join(home, "emulator", "emulator");
  const imageArch = imageArchitecture();
  const avdHome = mkdtempSync(join(tmpdir(), "plogkit-e2e-android-avd-"));
  const avdName = `${avdNamePrefix}${basename(avdHome).replace(/[^A-Za-z0-9_]/g, "_")}`;
  const avdEnvironment = {
    ...createStandaloneBuildEnvironment(),
    ANDROID_AVD_HOME: avdHome,
  };
  cleanup.add(() => rmSync(avdHome, { force: true, recursive: true }));
  createAvd(home, emulator, imageArch, avdHome, avdName);
  const previouslyConnected = new Set(connectedEmulators(adbPath, { allowFailure: true }));

  const emulatorLog = join(artifactRoot, "android-emulator.log");
  const emulatorEvidence = createBoundedEvidenceFile(emulatorLog, androidEmulatorEvidenceMaxBytes);
  const emulatorProcess = spawn(emulator, androidEmulatorArguments(avdName), {
    detached: process.platform !== "win32",
    env: avdEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let emulatorSpawnError = null;
  let emulatorEvidenceError = null;
  const appendEmulatorEvidence = (value) => {
    try {
      emulatorEvidence.append(value);
    } catch (error) {
      emulatorEvidenceError ??= error;
    }
  };
  const finishEmulatorEvidence = () => {
    try {
      emulatorEvidence.finish();
    } catch (error) {
      emulatorEvidenceError ??= error;
    }
  };
  emulatorProcess.stdout.on("data", appendEmulatorEvidence);
  emulatorProcess.stderr.on("data", appendEmulatorEvidence);
  emulatorProcess.once("error", (error) => {
    emulatorSpawnError = error;
    console.error(`[e2e:android] Emulator failed: ${String(error)}`);
  });
  emulatorProcess.once("close", finishEmulatorEvidence);

  let serial = null;
  cleanup.add(async () => {
    log("android", `Stopping owned emulator ${avdName}.`);
    await terminateProcessTree(emulatorProcess, {
      gracefulTimeoutMs: 20000,
      killTimeoutMs: 5000,
    });
    finishEmulatorEvidence();
    if (emulatorEvidenceError) {
      throw new Error(`Unable to preserve bounded Android Emulator evidence at ${emulatorLog}.`, {
        cause: emulatorEvidenceError,
      });
    }
  });

  serial = await waitUntil(
    () => {
      if (emulatorEvidenceError) {
        throw new Error(`Unable to preserve bounded Android Emulator evidence at ${emulatorLog}.`, {
          cause: emulatorEvidenceError,
        });
      }
      if (emulatorSpawnError || hasProcessExited(emulatorProcess)) {
        const reason = emulatorSpawnError
          ? String(emulatorSpawnError)
          : `exit ${emulatorProcess.exitCode ?? emulatorProcess.signalCode}`;
        throw new Error(`Android Emulator exited early (${reason}). See ${emulatorLog}`);
      }
      return findInvocationSerial(adbPath, avdName, previouslyConnected);
    },
    180000,
    `ephemeral Android AVD ${avdName} to appear`,
    2000,
  );
  const device = { platform: "android", adbPath, deviceId: serial };
  await waitForBoot(device, bootTimeoutMs);
  return device;
}

export async function prepareAndroidDevice(options) {
  const prepareEvidencePath = join(options.artifactRoot, "android-prepare.log");
  try {
    return await prepareOwnedAndroidDevice(options);
  } catch (error) {
    try {
      writeFileSync(
        prepareEvidencePath,
        boundedEvidence(
          error instanceof Error ? (error.stack ?? error.message) : String(error),
          androidPrepareEvidenceMaxBytes,
        ),
      );
    } catch (evidenceError) {
      const aggregate = new AggregateError(
        [error, evidenceError],
        `${error instanceof Error ? error.message : String(error)}\n` +
          `Unable to preserve bounded Android prepare evidence at ${prepareEvidencePath}.`,
        { cause: error },
      );
      if (error?.code) aggregate.code = error.code;
      throw aggregate;
    }
    throw error;
  }
}

export async function installAndSeedAndroid({
  artifact,
  cleanup,
  device,
  fixtures,
  lifecycleTimeoutMs = deviceLifecycleTimeoutMs,
  root,
}) {
  log("android", "Installing the standalone Release APK and seeding photos.");
  await run(device.adbPath, ["-s", device.deviceId, "install", artifact], {
    cleanup,
    cwd: root,
    timeoutMs: lifecycleTimeoutMs,
  });
  const fixtureDirectory = "/sdcard/Pictures/PlogKitE2E";
  await run(device.adbPath, ["-s", device.deviceId, "shell", "mkdir", "-p", fixtureDirectory], {
    cleanup,
    timeoutMs: lifecycleTimeoutMs,
  });
  for (const fixture of fixtures) {
    const name = fixture.split("/").at(-1);
    const destination = `${fixtureDirectory}/${name}`;
    await run(device.adbPath, ["-s", device.deviceId, "push", fixture, destination], {
      cleanup,
      timeoutMs: lifecycleTimeoutMs,
    });
    await run(
      device.adbPath,
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
      { cleanup, timeoutMs: lifecycleTimeoutMs },
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
  return capture(
    device.adbPath,
    [
      "-s",
      device.deviceId,
      "shell",
      "content",
      "query",
      "--uri",
      "content://media/external/images/media",
      "--projection",
      "_id:_display_name:mime_type",
    ],
    { timeoutMs: lifecycleProbeTimeoutMs },
  );
}

export function captureAndroidPhotoResources(device) {
  return new Set(
    [...queryAndroidPhotos(device).matchAll(/(?:^|\s)_id=(\d+)/gm)].map((match) => match[1]),
  );
}

export function androidBuildArtifact(root) {
  return resolve(root, appPath);
}

export function androidBuildSidecars(root) {
  return [resolve(root, sourceMapPath), resolve(root, nativeDebugSymbolsPath)];
}
