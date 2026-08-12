import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";

import {
  assertAndroidDeviceReady,
  installAndSeedAndroid,
  parseAdbPlatformToolsVersion,
  prepareAndroidDevice,
  validateAndroidEnvironment,
} from "./android.mjs";

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

async function withEnvironment(values, operation) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createTestCleanup() {
  const tasks = [];
  return {
    add(task) {
      tasks.push(task);
    },
    async run() {
      for (const task of tasks.reverse()) await task();
    },
  };
}

function expectedBoundedEmulatorEvidence() {
  const maxBytes = 4 * 1024 * 1024;
  const paddingLine =
    "emulator-padding-012345678901234567890123456789012345678901234567890123456789\n";
  const source = Buffer.from(
    `emulator-evidence-head\n${paddingLine.repeat(70000)}emulator-evidence-tail\n`,
  );
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

test("Android reads the SDK package revision without mistaking the adb protocol version", () => {
  assert.equal(
    parseAdbPlatformToolsVersion(
      [
        "Android Debug Bridge version 1.0.41",
        "  Version 37.0.0-14933066 (installed by SDK Manager)",
        "Installed as /usr/local/lib/android/sdk/platform-tools/adb",
      ].join("\n"),
    ),
    "37.0.0-14933066",
  );
  assert.equal(parseAdbPlatformToolsVersion("Android Debug Bridge version 1.0.41"), null);
});

test("each Android device invocation owns one ephemeral AVD and child emulator", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-android-ephemeral-");
  const androidHome = join(directory, "sdk");
  const emulatorDirectory = join(androidHome, "emulator");
  const platformTools = join(androidHome, "platform-tools");
  const commandLineTools = join(androidHome, "cmdline-tools", "22.0", "bin");
  const imageDirectory = join(androidHome, "system-images", "android-36", "default", "x86_64");
  const ambientAvdHome = join(directory, "ambient-avd-home");
  const adbLog = join(directory, "adb.log");
  const avdLog = join(directory, "avd.log");
  const avdNameFile = join(directory, "avd-name");
  const emulatorLog = join(directory, "emulator.log");
  const emulatorStarted = join(directory, "emulator-started");
  mkdirSync(emulatorDirectory, { recursive: true });
  mkdirSync(platformTools, { recursive: true });
  mkdirSync(commandLineTools, { recursive: true });
  mkdirSync(imageDirectory, { recursive: true });
  mkdirSync(ambientAvdHome);
  writeExecutable(
    join(commandLineTools, "avdmanager"),
    `#!/bin/sh
printf '%s|%s|%s\n' "$ANDROID_AVD_HOME" "$*" "${"${EMULATOR_LOCAL_OVERRIDE-unset}"}" >> ${JSON.stringify(avdLog)}
IFS= read -r answer
[ "$answer" = 'no' ] || { printf '%s\n' 'expected avdmanager hardware-profile answer' >&2; exit 1; }
previous=''
for argument in "$@"; do
  if [ "$previous" = '--name' ]; then printf '%s' "$argument" > ${JSON.stringify(avdNameFile)}; fi
  previous="$argument"
done
`,
  );
  writeExecutable(
    join(emulatorDirectory, "emulator"),
    `#!${process.execPath}
const fs = require("node:fs");
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
fs.appendFileSync(
  ${JSON.stringify(emulatorLog)},
  process.env.ANDROID_AVD_HOME + "|" + process.argv.slice(2).join(" ") + "|" +
    (process.env.EMULATOR_LOCAL_OVERRIDE ?? "unset") + "\\n",
);
const padding =
  "emulator-padding-012345678901234567890123456789012345678901234567890123456789\\n";
process.stdout.write("emulator-evidence-head\\n");
let batch = 0;
function writeEvidenceBatch() {
  if (batch === 70) {
    process.stdout.write("emulator-evidence-tail\\n", () =>
      fs.writeFileSync(${JSON.stringify(emulatorStarted)}, ""),
    );
    return;
  }
  process.stdout.write(padding.repeat(1000));
  batch += 1;
  setImmediate(writeEvidenceBatch);
}
writeEvidenceBatch();
setInterval(() => {}, 1000);
`,
  );
  writeExecutable(
    join(platformTools, "adb"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  devices)
    printf '%s\n' 'List of devices attached' 'emulator-5554 device'
    if [ -f "$FAKE_EMULATOR_STARTED" ]; then printf '%s\n' 'emulator-5556 device'; fi
    ;;
  *"-s emulator-5554 emu avd name"*) printf '%s\n' 'Developer_Device' ;;
  *"-s emulator-5556 emu avd name"*) cat "$FAKE_AVD_NAME" ;;
  *"getprop sys.boot_completed"*)
    if [ "$FAKE_BOOT_HANG" = 1 ]; then sleep 0.15; fi
    printf '%s\n' '1'
    ;;
esac
`,
  );

  const invocations = [];
  await withEnvironment(
    {
      ANDROID_AVD_HOME: ambientAvdHome,
      ANDROID_HOME: androidHome,
      EMULATOR_LOCAL_OVERRIDE: "must-not-leak",
      E2E_ANDROID_ARCH: "x86_64",
      FAKE_ADB_LOG: adbLog,
      FAKE_AVD_LOG: avdLog,
      FAKE_AVD_NAME: avdNameFile,
      FAKE_BOOT_HANG: "0",
      FAKE_EMULATOR_LOG: emulatorLog,
      FAKE_EMULATOR_STARTED: emulatorStarted,
      PATH: process.env.PATH,
    },
    async () => {
      for (let invocation = 0; invocation < 2; invocation += 1) {
        rmSync(emulatorStarted, { force: true });
        const artifactRoot = join(directory, `artifacts-${invocation}`);
        mkdirSync(artifactRoot);
        const cleanup = createTestCleanup();
        let device;
        let avdHome;
        let avdName;
        let avdExisted;
        let emulatorEvidence;
        let emulatorEvidenceBytes;
        let prepareCommands;
        try {
          device = await prepareAndroidDevice({ artifactRoot, cleanup });
          [avdHome] = readFileSync(avdLog, "utf8").trim().split("\n").at(-1).split("|");
          avdName = readFileSync(avdNameFile, "utf8");
          avdExisted = existsSync(avdHome);
          prepareCommands = readFileSync(adbLog, "utf8");
        } finally {
          await cleanup.run();
        }
        const emulatorEvidencePath = join(artifactRoot, "android-emulator.log");
        emulatorEvidence = readFileSync(emulatorEvidencePath);
        emulatorEvidenceBytes = statSync(emulatorEvidencePath).size;
        assert.equal(device.deviceId, "emulator-5556");
        assert.equal(device.adbPath, join(platformTools, "adb"));
        assert.equal(avdExisted, true);
        assert.notEqual(avdHome, ambientAvdHome);
        assert.doesNotMatch(prepareCommands, /am start -W|uiautomator|settings put global/);
        assert.equal(existsSync(avdHome), false);
        invocations.push({ avdHome, avdName, emulatorEvidence, emulatorEvidenceBytes });
      }

      rmSync(emulatorStarted, { force: true });
      process.env.FAKE_BOOT_HANG = "1";
      const cleanup = createTestCleanup();
      const timeoutArtifactRoot = join(directory, "artifacts-boot-timeout");
      mkdirSync(timeoutArtifactRoot);
      const startedAt = Date.now();
      try {
        await assert.rejects(
          prepareAndroidDevice({
            artifactRoot: timeoutArtifactRoot,
            bootTimeoutMs: 25,
            cleanup,
          }),
          /finish booting/,
        );
        assert.ok(Date.now() - startedAt < 5000);
      } finally {
        await cleanup.run();
      }
      const prepareEvidencePath = join(timeoutArtifactRoot, "android-prepare.log");
      assert.ok(statSync(prepareEvidencePath).size <= 1024 * 1024);
      assert.match(readFileSync(prepareEvidencePath, "utf8"), /finish booting/);
    },
  );

  assert.notEqual(invocations[0].avdHome, invocations[1].avdHome);
  assert.notEqual(invocations[0].avdName, invocations[1].avdName);
  const exactEvidence = expectedBoundedEmulatorEvidence();
  for (const invocation of invocations) {
    assert.ok(invocation.emulatorEvidenceBytes <= 4 * 1024 * 1024);
    assert.equal(invocation.emulatorEvidenceBytes, exactEvidence.length);
    assert.deepEqual(invocation.emulatorEvidence, exactEvidence);
  }
  assert.doesNotMatch(readFileSync(adbLog, "utf8"), /emu kill/);
  const emulatorContract = readFileSync(emulatorLog, "utf8");
  assert.match(emulatorContract, /-no-snapshot/);
  assert.match(emulatorContract, /-gpu swiftshader/);
  assert.match(emulatorContract, /-cores 2/);
  assert.match(emulatorContract, /-memory 4096/);
  assert.doesNotMatch(emulatorContract, /-wipe-data/);
  assert.match(emulatorContract, /\|unset$/m);
  const avdContract = readFileSync(avdLog, "utf8");
  assert.match(avdContract, /--device pixel_7_pro/);
  assert.match(avdContract, /--package system-images;android-36;default;x86_64/);
  assert.doesNotMatch(avdContract, /--force/);
  assert.match(avdContract, /\|unset$/m);
});

test("Android rejects an emulator outside the declared device toolchain", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-android-toolchain-");
  const emulatorDirectory = join(directory, "emulator");
  const platformToolsDirectory = join(directory, "platform-tools");
  const commandLineToolsDirectory = join(directory, "cmdline-tools", "22.0");
  const imageDirectory = join(directory, "system-images", "android-36", "default", "x86_64");
  mkdirSync(emulatorDirectory, { recursive: true });
  mkdirSync(platformToolsDirectory, { recursive: true });
  mkdirSync(join(commandLineToolsDirectory, "bin"), { recursive: true });
  mkdirSync(imageDirectory, { recursive: true });
  writeExecutable(
    join(emulatorDirectory, "emulator"),
    "#!/bin/sh\nprintf '%s\\n' 'Android emulator version 37.2.0.0 (build_id 16000000) (CL:N/A)'\n",
  );
  writeExecutable(
    join(platformToolsDirectory, "adb"),
    "#!/bin/sh\nprintf '%s\\n' 'Android Debug Bridge version 1.0.41' 'Version 36.0.2-13206524'\n",
  );
  writeExecutable(join(commandLineToolsDirectory, "bin", "avdmanager"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(commandLineToolsDirectory, "source.properties"), "Pkg.Revision=19.0\n");
  writeFileSync(
    join(imageDirectory, "source.properties"),
    "Pkg.Revision=2\nAndroidVersion.ApiLevel=36\nSystemImage.Abi=x86_64\nSystemImage.TagId=default\n",
  );

  await withEnvironment(
    {
      ANDROID_HOME: directory,
      ANDROID_SDK_ROOT: undefined,
      E2E_ANDROID_ARCH: "x86_64",
      PATH: process.env.PATH,
    },
    () => {
      assert.throws(
        () => validateAndroidEnvironment(),
        /Android SDK Platform-Tools 37\.0\.1-15733141 is required, but 36\.0\.2-13206524 is installed/,
      );
      writeExecutable(
        join(platformToolsDirectory, "adb"),
        "#!/bin/sh\nprintf '%s\\n' 'Android Debug Bridge version 1.0.41' 'Version 37.0.1-15733141'\n",
      );
      assert.throws(
        () => validateAndroidEnvironment(),
        /Android SDK Command-line Tools 22\.0 is required, but 19\.0 is installed/,
      );
      writeFileSync(join(commandLineToolsDirectory, "source.properties"), "Pkg.Revision=22.0\n");
      assert.throws(
        () => validateAndroidEnvironment(),
        /Android Emulator 37\.1\.11\.0 \(build 15917651\) is required, but 37\.2\.0\.0 \(build 16000000\) is installed/,
      );
    },
  );
});

test("a fresh Android device installs and seeds without replacement cleanup", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-android-fresh-install-");
  const adbPath = join(directory, "adb");
  const commandLog = join(directory, "adb.log");
  writeExecutable(
    adbPath,
    `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(commandLog)}
case "$*" in
  *"content query"*) printf '%s\n' '_id=1 _display_name=one.jpg' '_id=2 _display_name=two.jpg' ;;
esac
`,
  );

  await installAndSeedAndroid({
    artifact: join(directory, "app-release.apk"),
    cleanup: { add() {} },
    device: { platform: "android", adbPath, deviceId: "emulator-test" },
    fixtures: [join(directory, "one.jpg"), join(directory, "two.jpg")],
    root: directory,
  });

  const commands = readFileSync(commandLog, "utf8");
  assert.match(commands, /^-s emulator-test install .*app-release\.apk$/m);
  assert.match(commands, /shell mkdir -p \/sdcard\/Pictures\/PlogKitE2E/);
  assert.doesNotMatch(commands, /install -r|shell rm -rf/);
});

test("Android bounds every install and fixture command", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-android-mutation-timeout-");
  const adbPath = join(directory, "adb");
  const artifact = join(directory, "app-release.apk");
  const fixture = join(directory, "fixture.jpg");
  const deviceId = "emulator-test";
  writeExecutable(
    adbPath,
    `#!/bin/sh
if [ "$*" = "$FAKE_HANG_COMMAND" ]; then sleep 0.15; fi
case "$*" in
  *"content query"*) printf '%s\n' '_id=1 _display_name=fixture.jpg' ;;
esac
`,
  );

  const commands = [
    `-s ${deviceId} install ${artifact}`,
    `-s ${deviceId} shell mkdir -p /sdcard/Pictures/PlogKitE2E`,
    `-s ${deviceId} push ${fixture} /sdcard/Pictures/PlogKitE2E/fixture.jpg`,
    `-s ${deviceId} shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/PlogKitE2E/fixture.jpg`,
  ];
  for (const command of commands) {
    await t.test(command, async () => {
      await withEnvironment({ FAKE_HANG_COMMAND: command }, async () => {
        await assert.rejects(
          installAndSeedAndroid({
            artifact,
            cleanup: { add() {} },
            device: { platform: "android", adbPath, deviceId },
            fixtures: [fixture],
            lifecycleTimeoutMs: 25,
            root: directory,
          }),
          (error) => error.code === "E2E_COMMAND_TIMEOUT",
        );
      });
    });
  }
});

function createReadinessFixture(t, mode) {
  const directory = createTemporaryTestDirectory(t, "plogkit-android-readiness-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const adbLog = join(directory, "adb.log");
  const homeAttempts = join(directory, "home-attempts");
  const hierarchyAttempts = join(directory, "hierarchy-attempts");
  const resolveAttempts = join(directory, "resolve-attempts");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  for (const counter of [homeAttempts, hierarchyAttempts, resolveAttempts])
    writeFileSync(counter, "0");
  writeExecutable(
    join(binaries, "adb"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  *"am get-config"*) printf '%s\n' 'config: mcc310-mnc260-en-rUS-ldltr-v36' ;;
  *"cmd package resolve-activity"*)
    attempts=$(($(cat "$FAKE_RESOLVE_ATTEMPTS") + 1)); printf '%s' "$attempts" > "$FAKE_RESOLVE_ATTEMPTS"
    if [ "$FAKE_MODE" = delayed ] && [ "$attempts" -eq 1 ]; then
      printf '%s\n' 'com.android.settings/.FallbackHome'
    else
      printf '%s\n' 'com.android.launcher3/.QuickstepLauncher'
    fi
    ;;
  *"am start -W"*)
    attempts=$(($(cat "$FAKE_HOME_ATTEMPTS") + 1)); printf '%s' "$attempts" > "$FAKE_HOME_ATTEMPTS"
    if [ "$FAKE_MODE" = home-failure ]; then
      printf '%s\n' 'Status: error'
    else
      printf '%s\n' 'Status: ok' 'Activity: com.android.launcher3/.QuickstepLauncher'
    fi
    ;;
  *"uiautomator dump"*)
    attempts=$(($(cat "$FAKE_HIERARCHY_ATTEMPTS") + 1)); printf '%s' "$attempts" > "$FAKE_HIERARCHY_ATTEMPTS"
    if [ "$FAKE_MODE" != delayed ] || [ "$attempts" -gt 1 ]; then printf '%s\n' 'UI hierarchy dumped'; fi
    ;;
  *"/data/anr/anr_001"*) printf '%s\n' 'system_server trace' ;;
  *"exec-out cat /sdcard/plogkit-e2e-window.xml"*)
    if [ "$FAKE_MODE" = dialog-anr ]; then
      printf '%s\n' '<node text="System UI isn'"'"'t responding" resource-id="android:id/aerr_wait" />'
    else
      printf '%s\n' '<hierarchy><node package="com.android.launcher3" /></hierarchy>'
    fi
    ;;
  *"dumpsys activity activities"*) printf '%s\n' 'ResumedActivity: ActivityRecord{42 u0 com.android.launcher3/.QuickstepLauncher t7}' ;;
  *"dumpsys window"*)
    if [ "$FAKE_MODE" = probe-hang ]; then sleep 0.15; fi
    if [ "$FAKE_MODE" = dialog-anr ]; then
      printf '%s\n' 'mCurrentFocus=Application Not Responding: System UI'
    else
      printf '%s\n' 'mCurrentFocus=com.android.launcher3/.QuickstepLauncher'
      if [ "$FAKE_MODE" = oversized ]; then
        awk 'BEGIN { for (i = 0; i < 70000; i++) print "readiness-padding-012345678901234567890123456789012345678901234567890123456789" }'
        printf '%s\n' 'readiness-tail'
      fi
    fi
    ;;
  *"logcat -b events -d"*)
    if [ "$FAKE_MODE" = event-anr ]; then
      printf '%s\n' 'I am_anr: [0,123,com.android.systemui,952559429,failed to complete startup]'
    fi
    ;;
  *"logcat -b main -b system -b crash"*) printf '%s\n' 'ANR in com.android.systemui' ;;
  *"for report in /data/tombstones/"*) exit 0 ;;
  *"for report in /data/anr/"*) printf '%s\n' '${Math.floor(Date.now() / 1000)}|20|/data/anr/anr_001' ;;
  *"service list"*) printf '%s\n' 'window: found' ;;
  *"getprop"*) printf '%s\n' '[sys.boot_completed]: [1]' ;;
esac
`,
  );
  return { adbLog, artifactRoot, binaries, hierarchyAttempts, homeAttempts, mode, resolveAttempts };
}

async function withReadinessFixture(t, mode, operation) {
  const fixture = createReadinessFixture(t, mode);
  return withEnvironment(
    {
      FAKE_ADB_LOG: fixture.adbLog,
      FAKE_HIERARCHY_ATTEMPTS: fixture.hierarchyAttempts,
      FAKE_HOME_ATTEMPTS: fixture.homeAttempts,
      FAKE_MODE: mode,
      FAKE_RESOLVE_ATTEMPTS: fixture.resolveAttempts,
      PATH: `${fixture.binaries}:${process.env.PATH}`,
    },
    () => operation(fixture),
  );
}

test("Android semantic readiness exercises only the installed UI contract", async (t) => {
  await withReadinessFixture(t, "delayed", async (fixture) => {
    await assertAndroidDeviceReady({
      artifactRoot: fixture.artifactRoot,
      device: {
        platform: "android",
        adbPath: join(fixture.binaries, "adb"),
        deviceId: "emulator-test",
      },
      stage: "post-install",
    });

    assert.equal(readFileSync(fixture.resolveAttempts, "utf8"), "2");
    assert.equal(readFileSync(fixture.homeAttempts, "utf8"), "1");
    assert.equal(readFileSync(fixture.hierarchyAttempts, "utf8"), "2");
    const commands = readFileSync(fixture.adbLog, "utf8").split("\n");
    const home = commands.findIndex((command) => command.includes("shell am start -W"));
    const locale = commands.findIndex((command) => command.includes("shell am get-config"));
    const hierarchy = commands.findIndex((command) => command.includes("shell uiautomator dump"));
    const animations = commands.findIndex((command) =>
      command.includes("shell settings put global window_animation_scale 0"),
    );
    assert.ok(locale < home);
    assert.ok(hierarchy > home);
    assert.ok(animations > hierarchy);
    assert.doesNotMatch(
      commands.join("\n"),
      /wait-for-broadcast-idle|init\.svc\.bootanim|device_provisioned|pm path android|service check/,
    );
  });
});

test("Android semantic readiness shares one deadline across serial adb probes", async (t) => {
  await withReadinessFixture(t, "probe-hang", async (fixture) => {
    const startedAt = Date.now();
    await assert.rejects(
      assertAndroidDeviceReady({
        artifactRoot: fixture.artifactRoot,
        device: {
          platform: "android",
          adbPath: join(fixture.binaries, "adb"),
          deviceId: "emulator-test",
        },
        readinessTimeoutMs: 25,
        stage: "post-install",
      }),
    );
    assert.ok(Date.now() - startedAt < 500);
  });
});

test("Android semantic readiness never retries a failed HOME launch", async (t) => {
  await withReadinessFixture(t, "home-failure", async (fixture) => {
    await assert.rejects(
      assertAndroidDeviceReady({
        artifactRoot: fixture.artifactRoot,
        device: {
          platform: "android",
          adbPath: join(fixture.binaries, "adb"),
          deviceId: "emulator-test",
        },
        stage: "post-install",
      }),
      /single readiness attempt/,
    );
    assert.equal(readFileSync(fixture.homeAttempts, "utf8"), "1");
  });
});

test("Android semantic readiness rejects a startup ANR after its dialog disappears", async (t) => {
  await withReadinessFixture(t, "event-anr", async (fixture) => {
    await assert.rejects(
      assertAndroidDeviceReady({
        artifactRoot: fixture.artifactRoot,
        device: {
          platform: "android",
          adbPath: join(fixture.binaries, "adb"),
          deviceId: "emulator-test",
        },
        stage: "post-install",
      }),
      /Android blocking ANR detected/,
    );
  });
});

test("Android semantic readiness records its failing launcher probe", async (t) => {
  await withReadinessFixture(t, "dialog-anr", async (fixture) => {
    await assert.rejects(
      assertAndroidDeviceReady({
        artifactRoot: fixture.artifactRoot,
        device: {
          platform: "android",
          adbPath: join(fixture.binaries, "adb"),
          deviceId: "emulator-test",
        },
        stage: "post-install",
      }),
      /Android blocking ANR detected/,
    );
    const readinessProbe = readFileSync(
      join(fixture.artifactRoot, "android-readiness-emulator-test.log"),
      "utf8",
    );
    assert.match(readinessProbe, /Application Not Responding: System UI/);
    assert.match(readinessProbe, /android:id\/aerr_wait/);
  });
});

test("Android semantic readiness preserves bounded raw evidence", async (t) => {
  await withReadinessFixture(t, "oversized", async (fixture) => {
    await assertAndroidDeviceReady({
      artifactRoot: fixture.artifactRoot,
      device: {
        platform: "android",
        adbPath: join(fixture.binaries, "adb"),
        deviceId: "emulator-test",
      },
      stage: "post-install",
    });

    const readinessPath = join(fixture.artifactRoot, "android-readiness-emulator-test.log");
    assert.ok(statSync(readinessPath).size <= 3 * 1024 * 1024);
    const evidence = readFileSync(readinessPath, "utf8");
    assert.match(evidence, /mCurrentFocus=com\.android\.launcher3/);
    assert.match(evidence, /diagnostic bytes omitted/);
    assert.match(evidence, /readiness-tail/);
  });
});
