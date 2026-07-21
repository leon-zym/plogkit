import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  androidEmulatorArguments,
  assertAndroidDeviceReady,
  isAndroidServiceAvailable,
  recordAndroidReadinessSnapshot,
} from "./android.mjs";

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test("dedicated Android emulator uses host graphics instead of the slow headless default", () => {
  const args = androidEmulatorArguments();
  assert.deepEqual(args.slice(args.indexOf("-gpu"), args.indexOf("-gpu") + 2), [
    "-gpu",
    "host",
  ]);
});

test("Android readiness rejects an explicitly missing Binder service", () => {
  assert.equal(isAndroidServiceAvailable("Service window: found"), true);
  assert.equal(isAndroidServiceAvailable("Service window: not found"), false);
  assert.equal(isAndroidServiceAvailable(null), false);
});

test("Android readiness rejects an ANR dialog and records actionable diagnostics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-android-readiness-"));
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const adbLog = join(directory, "adb-commands.log");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);

  writeExecutable(
    join(binaries, "adb"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  *"getprop init.svc.bootanim"*) printf '%s\n' 'stopped' ;;
  *"settings get global device_provisioned"*) printf '%s\n' '1' ;;
  *"pm path android"*) printf '%s\n' 'package:/system/framework/framework-res.apk' ;;
  *"service check window"*|*"service check accessibility"*) printf '%s\n' 'Service found' ;;
  *"am start -W"*) printf '%s\n' 'Status: ok' ;;
  *"uiautomator dump /sdcard/plogkit-e2e-window.xml"*) printf '%s\n' 'UI hierarchy dumped' ;;
  *"exec-out cat /sdcard/plogkit-e2e-window.xml"*) printf '%s\n' '<node text="System UI isn'"'"'t responding" resource-id="android:id/aerr_wait" />' ;;
  *"dumpsys window"*) printf '%s\n' 'mCurrentFocus=Application Not Responding: System UI' ;;
  *"logcat -d"*) printf '%s\n' 'ANR in com.android.systemui' ;;
  *"cat /data/anr/traces.txt"*) printf '%s\n' 'legacy anr trace' ;;
  *"pull /data/anr"*)
    mkdir -p "$5"
    printf '%s\n' 'system_server trace' > "$5/anr_001"
    ;;
  *"service list"*) printf '%s\n' 'window: found' ;;
  *"getprop"*) printf '%s\n' '[sys.boot_completed]: [1]' ;;
esac
`,
  );

  const previousPath = process.env.PATH;
  const previousAdbLog = process.env.FAKE_ADB_LOG;
  process.env.PATH = `${binaries}:${previousPath}`;
  process.env.FAKE_ADB_LOG = adbLog;
  try {
    await assert.rejects(
      assertAndroidDeviceReady({
        artifactRoot,
        device: { platform: "android", deviceId: "emulator-test" },
        stage: "post-install",
      }),
      /Android System UI ANR dialog detected/,
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousAdbLog === undefined) delete process.env.FAKE_ADB_LOG;
    else process.env.FAKE_ADB_LOG = previousAdbLog;
  }

  const commands = readFileSync(adbLog, "utf8");
  assert.match(commands, /shell am start -W -a android\.intent\.action\.MAIN/);
  assert.match(commands, /shell dumpsys window/);
  assert.match(commands, /shell uiautomator dump \/sdcard\/plogkit-e2e-window\.xml/);
  assert.match(commands, /exec-out cat \/sdcard\/plogkit-e2e-window\.xml/);

  const diagnosticDirectory = join(artifactRoot, "android", "readiness-post-install");
  assert.match(
    readFileSync(join(diagnosticDirectory, "failure-summary.txt"), "utf8"),
    /category: system-ui/,
  );
  assert.match(readFileSync(join(diagnosticDirectory, "logcat.txt"), "utf8"), /systemui/);
  assert.match(
    readFileSync(join(diagnosticDirectory, "anr", "anr_001"), "utf8"),
    /system_server trace/,
  );
});

test("Android readiness waits for the real launcher instead of accepting FallbackHome", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-android-launcher-"));
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const homeAttempts = join(directory, "home-attempts");
  const hierarchyAttempts = join(directory, "hierarchy-attempts");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  writeFileSync(homeAttempts, "0");
  writeFileSync(hierarchyAttempts, "0");

  writeExecutable(
    join(binaries, "adb"),
    `#!/bin/sh
case "$*" in
  *"getprop init.svc.bootanim"*) printf '%s\n' 'stopped' ;;
  *"settings get global device_provisioned"*) printf '%s\n' '1' ;;
  *"pm path android"*) printf '%s\n' 'package:/system/framework/framework-res.apk' ;;
  *"service check window"*|*"service check accessibility"*) printf '%s\n' 'Service found' ;;
  *"am start -W"*)
    attempts=$(($(cat "$FAKE_HOME_ATTEMPTS") + 1))
    printf '%s' "$attempts" > "$FAKE_HOME_ATTEMPTS"
    if [ "$attempts" -eq 1 ]; then
      printf '%s\n' 'Status: ok' 'Activity: com.android.settings/.FallbackHome'
    else
      printf '%s\n' 'Status: ok' 'Activity: com.android.launcher3/.QuickstepLauncher'
    fi
    ;;
  *"uiautomator dump /sdcard/plogkit-e2e-window.xml"*)
    attempts=$(($(cat "$FAKE_HIERARCHY_ATTEMPTS") + 1))
    printf '%s' "$attempts" > "$FAKE_HIERARCHY_ATTEMPTS"
    if [ "$attempts" -gt 1 ]; then printf '%s\n' 'UI hierarchy dumped'; fi
    ;;
  *"exec-out cat /sdcard/plogkit-e2e-window.xml"*) printf '%s\n' '<hierarchy><node package="com.android.launcher3" /></hierarchy>' ;;
  *"dumpsys window"*) printf '%s\n' 'mCurrentFocus=com.android.launcher3/.QuickstepLauncher' ;;
esac
`,
  );

  const previousPath = process.env.PATH;
  const previousHomeAttempts = process.env.FAKE_HOME_ATTEMPTS;
  const previousHierarchyAttempts = process.env.FAKE_HIERARCHY_ATTEMPTS;
  process.env.PATH = `${binaries}:${previousPath}`;
  process.env.FAKE_HOME_ATTEMPTS = homeAttempts;
  process.env.FAKE_HIERARCHY_ATTEMPTS = hierarchyAttempts;
  try {
    await assertAndroidDeviceReady({
      artifactRoot,
      device: { platform: "android", deviceId: "emulator-test" },
      stage: "boot",
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousHomeAttempts === undefined) delete process.env.FAKE_HOME_ATTEMPTS;
    else process.env.FAKE_HOME_ATTEMPTS = previousHomeAttempts;
    if (previousHierarchyAttempts === undefined) delete process.env.FAKE_HIERARCHY_ATTEMPTS;
    else process.env.FAKE_HIERARCHY_ATTEMPTS = previousHierarchyAttempts;
  }

  assert.equal(readFileSync(homeAttempts, "utf8"), "2");
  assert.equal(readFileSync(hierarchyAttempts, "utf8"), "2");
});

test("Android readiness snapshots preserve key adb state before functional probes complete", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-android-early-readiness-"));
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);

  writeExecutable(
    join(binaries, "adb"),
    `#!/bin/sh
case "$*" in
  *"getprop sys.boot_completed"*) printf '%s\n' '1' ;;
  *"getprop init.svc.bootanim"*) printf '%s\n' 'stopped' ;;
  *"settings get global device_provisioned"*) printf '%s\n' '0' ;;
  *"pm path android"*) printf '%s\n' 'package:/system/framework/framework-res.apk' ;;
  *"service check window"*) printf '%s\n' 'Service window: found' ;;
  *"service check accessibility"*) printf '%s\n' 'Service accessibility: found' ;;
  *"dumpsys window"*) printf '%s\n' 'mCurrentFocus=com.android.settings/.FallbackHome' ;;
  *"dumpsys activity"*) printf '%s\n' 'mResumedActivity=com.android.settings/.FallbackHome' ;;
  *"service list"*) printf '%s\n' 'window: found' 'accessibility: found' ;;
  *"getprop"*) printf '%s\n' '[sys.boot_completed]: [1]' ;;
esac
`,
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    recordAndroidReadinessSnapshot({
      artifactRoot,
      deviceId: "emulator-test",
      stage: "boot",
    });
  } finally {
    process.env.PATH = previousPath;
  }

  const snapshot = readFileSync(
    join(artifactRoot, "android-readiness-emulator-test.log"),
    "utf8",
  );
  assert.match(snapshot, /device provisioned[\s\S]*0/);
  assert.match(snapshot, /dumpsys window[\s\S]*FallbackHome/);
  assert.match(snapshot, /service check accessibility[\s\S]*found/);
  assert.match(snapshot, /getprop[\s\S]*sys\.boot_completed/);
});
