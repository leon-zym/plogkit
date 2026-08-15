import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import {
  assertIosGuestHealthy,
  installAndSeedIos,
  isIosEnglishLocale,
  prepareIosDevice,
  validateIosSimulatorEnvironment,
  validateIosToolchain,
} from "./ios.mjs";
import { createCleanupManager } from "./runtime.mjs";

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

async function withEnvironment(values, operation) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
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

test("iOS locale rejects ambiguous system state", () => {
  assert.equal(isIosEnglishLocale({ languages: '("en-US")', locale: "en_US" }), true);
  assert.equal(isIosEnglishLocale({ languages: "(zh-Hans)", locale: "zh_CN" }), false);
});

test("iOS guest health proves app-service and SpringBoard readiness before Maestro", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-guest-health-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const commandLog = join(directory, "xcrun.log");
  const deviceId = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";
  const observedStages = [];
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
case "$*" in
  "simctl listapps ${deviceId}") printf '%s\n' '{ "com.apple.mobilesafari" = {}; }' ;;
  "simctl spawn ${deviceId} launchctl print system/com.apple.SpringBoard")
    printf '%s\n' 'service = com.apple.SpringBoard' 'pid = 4242' 'state = running' ;;
  *) exit 2 ;;
esac
`,
  );

  await withEnvironment(
    { FAKE_XCRUN_LOG: commandLog, PATH: `${binaries}:${process.env.PATH}` },
    () =>
      assertIosGuestHealthy({
        artifactRoot,
        cleanup: { add() {} },
        device: { deviceId, platform: "ios" },
        observation: {
          run: async (stage, operation) => {
            observedStages.push(stage);
            return operation();
          },
        },
      }),
  );

  assert.equal(
    readFileSync(commandLog, "utf8").trim(),
    `simctl listapps ${deviceId}\nsimctl spawn ${deviceId} launchctl print system/com.apple.SpringBoard`,
  );
  const appServiceProbe = JSON.parse(
    readFileSync(join(artifactRoot, "ios", "guest-health", "app-service.probe.json"), "utf8"),
  );
  assert.equal(appServiceProbe.status, "completed");
  assert.ok(appServiceProbe.bytes > 0);
  assert.match(
    readFileSync(join(artifactRoot, "ios", "guest-health", "springboard-service.json"), "utf8"),
    /"state": "running"/,
  );
  assert.deepEqual(observedStages, [
    "ios-app-service-readiness",
    "ios-springboard-service-readiness",
  ]);
});

test("iOS guest health fails closed when SpringBoard is not running", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-guest-unhealthy-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    "#!/bin/sh\ncase \"$*\" in *\" listapps \"*) printf '%s\\n' '{ \"com.apple.mobilesafari\" = {}; }' ;; *) printf '%s\\n' 'state = waiting' ;; esac\n",
  );

  await withEnvironment({ PATH: `${binaries}:${process.env.PATH}` }, () =>
    assert.rejects(
      assertIosGuestHealthy({
        artifactRoot,
        cleanup: { add() {} },
        device: {
          deviceId: "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD",
          platform: "ios",
        },
      }),
      /running SpringBoard service with a PID/,
    ),
  );
  assert.match(
    readFileSync(join(artifactRoot, "ios", "guest-health", "springboard-service.json"), "utf8"),
    /"state": "waiting"/,
  );
});

test("iOS guest health fails before installation when the app service is unresponsive", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-app-service-unhealthy-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  writeExecutable(join(binaries, "xcrun"), "#!/bin/sh\nsleep 0.15\n");

  await withEnvironment({ PATH: `${binaries}:${process.env.PATH}` }, () =>
    assert.rejects(
      assertIosGuestHealthy({
        artifactRoot,
        cleanup: { add() {} },
        device: {
          deviceId: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
          platform: "ios",
        },
        timeoutMs: 25,
      }),
      (error) =>
        error.code === "E2E_COMMAND_TIMEOUT" && error.e2eStage === "ios-app-service-readiness",
    ),
  );
  const probe = JSON.parse(
    readFileSync(join(artifactRoot, "ios", "guest-health", "app-service.probe.json"), "utf8"),
  );
  assert.equal(probe.status, "failed");
});

test("iOS guest health does not start SpringBoard after its shared deadline is exhausted", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-guest-deadline-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const commandLog = join(directory, "xcrun.log");
  const deviceId = "FAFAFAFA-FAFA-FAFA-FAFA-FAFAFAFAFAFA";
  let elapsedMs = 0;
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
case "$*" in
  "simctl listapps ${deviceId}") printf '%s\n' '{ "com.apple.mobilesafari" = {}; }' ;;
  *) printf '%s\n' 'pid = 4242' 'state = running' ;;
esac
`,
  );

  await withEnvironment(
    { FAKE_XCRUN_LOG: commandLog, PATH: `${binaries}:${process.env.PATH}` },
    () =>
      assert.rejects(
        assertIosGuestHealthy({
          artifactRoot,
          cleanup: { add() {} },
          device: { deviceId, platform: "ios" },
          observation: {
            run: async (_stage, operation) => {
              const result = await operation();
              elapsedMs = 60_001;
              return result;
            },
          },
          monotonicNow: () => elapsedMs,
          timeoutMs: 60_000,
        }),
        (error) =>
          error.code === "E2E_COMMAND_TIMEOUT" && error.e2eStage === "ios-guest-health-readiness",
      ),
  );

  assert.equal(readFileSync(commandLog, "utf8").trim(), `simctl listapps ${deviceId}`);
});

test("iOS guest health never persists a failed app catalog", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-app-service-private-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    "#!/bin/sh\nprintf '%s\\n' '{ \"com.apple.private\" = { DataContainer = \"file:///Users/runner/private\"; }; }'\nexit 7\n",
  );

  let failure;
  await withEnvironment({ PATH: `${binaries}:${process.env.PATH}` }, async () => {
    try {
      await assertIosGuestHealthy({
        artifactRoot,
        cleanup: { add() {} },
        device: { deviceId: "CDCDCDCD-CDCD-CDCD-CDCD-CDCDCDCDCDCD", platform: "ios" },
      });
    } catch (error) {
      failure = error;
    }
  });
  assert.ok(failure instanceof Error);
  assert.equal(failure.e2eStage, "ios-app-service-readiness");
  assert.doesNotMatch(failure.message, /com\.apple\.private|Users\/runner/);
  const probe = readFileSync(
    join(artifactRoot, "ios", "guest-health", "app-service.probe.json"),
    "utf8",
  );
  assert.doesNotMatch(probe, /com\.apple\.private|Users\/runner/);
});

test("iOS guest health rejects an empty app catalog without probing SpringBoard", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-app-service-empty-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const commandLog = join(directory, "xcrun.log");
  const deviceId = "ABABABAB-ABAB-ABAB-ABAB-ABABABABABAB";
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
printf '%s\n' '{}'
`,
  );

  await withEnvironment(
    { FAKE_XCRUN_LOG: commandLog, PATH: `${binaries}:${process.env.PATH}` },
    () =>
      assert.rejects(
        assertIosGuestHealthy({
          artifactRoot,
          cleanup: { add() {} },
          device: { deviceId, platform: "ios" },
        }),
        (error) =>
          error.message === "iOS app-service readiness returned an empty application catalog." &&
          error.e2eStage === "ios-app-service-readiness",
      ),
  );
  assert.equal(readFileSync(commandLog, "utf8").trim(), `simctl listapps ${deviceId}`);
});

test("guest-health evidence failures never change a healthy readiness result", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-guest-evidence-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifact-root-is-a-file");
  mkdirSync(binaries);
  writeFileSync(artifactRoot, "not a directory");
  writeExecutable(
    join(binaries, "xcrun"),
    "#!/bin/sh\ncase \"$*\" in *\" listapps \"*) printf '%s\\n' '{ \"com.apple.mobilesafari\" = {}; }' ;; *\" launchctl \"*) printf '%s\\n' 'pid = 4242' 'state = running' ;; esac\n",
  );

  await withEnvironment({ PATH: `${binaries}:${process.env.PATH}` }, () =>
    assert.doesNotReject(
      assertIosGuestHealthy({
        artifactRoot,
        cleanup: { add() {} },
        device: { deviceId: "EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE", platform: "ios" },
      }),
    ),
  );
});

test("each iOS invocation creates, gates, and deletes only its own simulator", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-ephemeral-");
  const binaries = join(directory, "bin");
  const commandLog = join(directory, "xcrun.log");
  const deletedIds = join(directory, "deleted-ids");
  mkdirSync(binaries);
  writeFileSync(deletedIds, "");
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
case "$*" in
  "simctl create "*)
    count=$(grep -c '^simctl create ' "$FAKE_XCRUN_LOG")
    if [ "$count" -eq 1 ]; then printf '%s\n' '11111111-1111-1111-1111-111111111111'; else printf '%s\n' '22222222-2222-2222-2222-222222222222'; fi ;;
  "simctl list devices -j")
    printf '%s' '{"devices":{"runtime":['
    separator=''
    for udid in 11111111-1111-1111-1111-111111111111 22222222-2222-2222-2222-222222222222; do
      if ! grep -qx "$udid" "$FAKE_DELETED_IDS"; then
        printf '%s{"udid":"%s","state":"Shutdown"}' "$separator" "$udid"
        separator=','
      fi
    done
    printf '%s\n' ']}}' ;;
  *"defaults read NSGlobalDomain AppleLanguages") printf '%s\n' '("en-US")' ;;
  *"defaults read NSGlobalDomain AppleLocale") printf '%s\n' 'en_US' ;;
  "simctl delete "*)
    printf '%s\n' "$3" >> "$FAKE_DELETED_IDS"
    [ "$3" != "$FAKE_DELETE_FAILURE" ] || { printf '%s\n' 'injected delete failure' >&2; exit 1; } ;;
esac
`,
  );

  const devices = [];
  await withEnvironment(
    {
      FAKE_DELETED_IDS: deletedIds,
      FAKE_DELETE_FAILURE: undefined,
      FAKE_XCRUN_LOG: commandLog,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      for (let invocation = 0; invocation < 2; invocation += 1) {
        const cleanup = createCleanupManager();
        const device = await prepareIosDevice({ cleanup });
        devices.push(device);
        if (invocation === 0) await cleanup.run();
        else {
          process.env.FAKE_DELETE_FAILURE = device.deviceId;
          await assert.rejects(cleanup.run(), /injected delete failure/);
        }
      }
    },
  );

  assert.deepEqual(
    devices.map(({ deviceId }) => deviceId),
    ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"],
  );
  const commands = readFileSync(commandLog, "utf8");
  const names = commands
    .split("\n")
    .filter((command) => command.startsWith("simctl create "))
    .map((command) => command.split(" ").slice(2, -2).join(" "));
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  assert.match(names[0], /^PlogKit E2E /);
  assert.doesNotMatch(
    commands,
    /list (?:runtimes|devicetypes|devices available)|simctl erase|simctl launch|openurl/,
  );
  for (const { deviceId } of devices) {
    const owned = commands.split("\n").filter((command) => command.includes(deviceId));
    const bootstatus = `simctl bootstatus ${deviceId} -b`;
    const localeWrites = owned.filter((command) =>
      command.startsWith(`simctl spawn --standalone ${deviceId} defaults write `),
    );
    const localeReads = owned.filter((command) =>
      command.startsWith(`simctl spawn --standalone ${deviceId} defaults read `),
    );
    assert.equal(owned.filter((command) => command === `simctl boot ${deviceId}`).length, 0);
    assert.equal(owned.filter((command) => command === bootstatus).length, 1);
    assert.equal(localeWrites.length, 2);
    assert.equal(localeReads.length, 2);
    assert.ok(owned.indexOf(localeWrites.at(-1)) < owned.indexOf(bootstatus));
    assert.ok(owned.indexOf(localeReads.at(-1)) < owned.indexOf(bootstatus));
    assert.equal(owned.filter((command) => command === `simctl shutdown ${deviceId}`).length, 1);
    assert.equal(owned.at(-1), `simctl delete ${deviceId}`);
  }
});

test("iOS teardown proves its owned simulator is absent and records each stage", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-teardown-summary-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const commandLog = join(directory, "xcrun.log");
  const deletedMarker = join(directory, "deleted");
  const deviceId = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
  const observedStages = [];
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
case "$*" in
  "simctl create "*) printf '%s\n' '${deviceId}' ;;
  *"defaults read NSGlobalDomain AppleLanguages") printf '%s\n' '("en-US")' ;;
  *"defaults read NSGlobalDomain AppleLocale") printf '%s\n' 'en_US' ;;
  "simctl list devices -j")
    if [ -f "$FAKE_DELETED_MARKER" ]; then
      printf '%s\n' '{"devices":{"runtime":[]}}'
    else
      printf '%s\n' '{"devices":{"runtime":[{"udid":"${deviceId}","state":"Shutdown"}]}}'
    fi ;;
  "simctl delete ${deviceId}") : > "$FAKE_DELETED_MARKER" ;;
esac
`,
  );

  const cleanup = createCleanupManager();
  await withEnvironment(
    {
      FAKE_DELETED_MARKER: deletedMarker,
      FAKE_XCRUN_LOG: commandLog,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      await prepareIosDevice({
        artifactRoot,
        cleanup,
        observation: {
          run: async (stage, operation) => {
            observedStages.push(stage);
            return operation();
          },
        },
      });
      await cleanup.run();
    },
  );

  assert.deepEqual(
    JSON.parse(readFileSync(join(artifactRoot, "ios", "device-cleanup.json"), "utf8")),
    {
      deletion: { status: "succeeded" },
      deviceId,
      shutdown: { status: "succeeded" },
      verification: { status: "succeeded", udidAbsent: true },
    },
  );
  const commands = readFileSync(commandLog, "utf8").trim().split("\n");
  const shutdownIndex = commands.indexOf(`simctl shutdown ${deviceId}`);
  const deleteIndex = commands.indexOf(`simctl delete ${deviceId}`);
  const absentProbeIndex = commands.lastIndexOf("simctl list devices -j");
  assert.ok(shutdownIndex < deleteIndex);
  assert.ok(deleteIndex < absentProbeIndex);
  assert.deepEqual(observedStages, ["ios-device-create", "ios-locale", "ios-boot", "ios-cleanup"]);
});

test("iOS teardown fails closed when delete returns but the owned simulator remains", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-teardown-still-present-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  const deviceId = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
case "$*" in
  "simctl create "*) printf '%s\n' '${deviceId}' ;;
  *"defaults read NSGlobalDomain AppleLanguages") printf '%s\n' '("en-US")' ;;
  *"defaults read NSGlobalDomain AppleLocale") printf '%s\n' 'en_US' ;;
  "simctl list devices -j")
    printf '%s\n' '{"devices":{"runtime":[{"udid":"${deviceId}","state":"Shutdown"}]}}' ;;
esac
`,
  );

  const cleanup = createCleanupManager();
  await withEnvironment({ PATH: `${binaries}:${process.env.PATH}` }, async () => {
    await prepareIosDevice({ artifactRoot, cleanup, deletionVerificationTimeoutMs: 25 });
    await assert.rejects(cleanup.run(), (error) => {
      assert.match(error.message, /to disappear after deletion/);
      return true;
    });
  });

  const summary = JSON.parse(
    readFileSync(join(artifactRoot, "ios", "device-cleanup.json"), "utf8"),
  );
  assert.equal(summary.deletion.status, "succeeded");
  assert.equal(summary.verification.status, "failed");
  assert.equal(summary.verification.udidAbsent, false);
});

test("iOS bounds its single simulator boot transition", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-boot-timeout-");
  const artifactRoot = join(directory, "artifacts");
  const binaries = join(directory, "bin");
  const bootstatusCount = join(directory, "bootstatus-count");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
case "$*" in
  "simctl create "*) printf '%s\n' '33333333-3333-3333-3333-333333333333' ;;
  "simctl bootstatus "*)
    count=$(($(cat "$FAKE_BOOTSTATUS_COUNT") + 1)); printf '%s' "$count" > "$FAKE_BOOTSTATUS_COUNT"
    if [ "$count" -eq "$FAKE_HANG_BOOTSTATUS" ]; then sleep 0.15; fi ;;
  "simctl list devices -j")
    printf '%s\n' '{"devices":{"iOS 26.5":[{"udid":"33333333-3333-3333-3333-333333333333","state":"Booted","isAvailable":true,"dataPath":"\\/Users\\/runner\\/private-data","logPath":"\\/Users\\/runner\\/private-log"}]}}' ;;
  *"defaults read NSGlobalDomain AppleLanguages") printf '%s\n' '("en-US")' ;;
  *"defaults read NSGlobalDomain AppleLocale") printf '%s\n' 'en_US' ;;
esac
`,
  );

  writeFileSync(bootstatusCount, "0");
  await withEnvironment(
    {
      FAKE_BOOTSTATUS_COUNT: bootstatusCount,
      FAKE_HANG_BOOTSTATUS: "1",
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      await assert.rejects(
        prepareIosDevice({
          artifactRoot,
          cleanup: { add() {} },
          lifecycleTimeoutMs: 25,
        }),
        (error) => error.code === "E2E_COMMAND_TIMEOUT",
      );
    },
  );
  assert.equal(readFileSync(bootstatusCount, "utf8"), "1");
  const prepareEvidencePath = join(artifactRoot, "ios-prepare.log");
  assert.ok(statSync(prepareEvidencePath).size <= 1024 * 1024);
  const prepareEvidence = readFileSync(prepareEvidencePath, "utf8");
  assert.match(prepareEvidence, /Command timed out/);
  assert.match(prepareEvidence, /simulator state summary/);
  assert.match(prepareEvidence, /"state": "Booted"/);
  assert.doesNotMatch(prepareEvidence, /Users|dataPath|logPath|private-data|private-log/);
});

test("iOS bounds every install and media command", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-mutation-timeout-");
  const binaries = join(directory, "bin");
  const deviceId = "44444444-4444-4444-4444-444444444444";
  const artifact = join(directory, "PlogKit.app");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
if [ "$*" = "$FAKE_HANG_COMMAND" ]; then sleep 2; fi
`,
  );

  const commands = [
    [`simctl install ${deviceId} ${artifact}`, "ios-app-install"],
    [`simctl addmedia ${deviceId}`, "ios-fixture-addmedia"],
  ];
  await withEnvironment({ PATH: `${binaries}:${process.env.PATH}` }, async () => {
    for (const [command, stage] of commands) {
      await withEnvironment({ FAKE_HANG_COMMAND: command }, async () => {
        const observedStages = [];
        let failure;
        try {
          await installAndSeedIos({
            artifact,
            cleanup: { add() {} },
            device: { platform: "ios", deviceId },
            fixtures: [],
            lifecycleTimeoutMs: 500,
            observation: {
              run: async (observedStage, operation) => {
                observedStages.push(observedStage);
                return operation();
              },
            },
            root: directory,
          });
        } catch (error) {
          failure = error;
        }
        assert.ok(failure instanceof Error, `${command} must time out`);
        assert.equal(failure.code, "E2E_COMMAND_TIMEOUT");
        assert.equal(failure.e2eStage, stage);
        assert.equal(observedStages.at(-1), stage);
      });
    }
  });
});

test("iOS rejects a host outside the pinned Xcode toolchain", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-toolchain-");
  writeExecutable(
    join(directory, "xcode-select"),
    "#!/bin/sh\nprintf '%s\\n' '/Applications/Xcode-beta.app/Contents/Developer'\n",
  );
  writeExecutable(
    join(directory, "xcodebuild"),
    "#!/bin/sh\nprintf '%s\\n' 'Xcode 27.0' 'Build version 27A5218g'\n",
  );
  writeExecutable(join(directory, "pod"), "#!/bin/sh\nprintf '%s\\n' '1.17.0'\n");
  await assert.rejects(async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    try {
      validateIosToolchain();
    } finally {
      process.env.PATH = previousPath;
    }
  }, /Xcode 26\.6 \(17F113\) is required, but Xcode 27\.0 \(27A5218g\) is selected/);
});

function writeIosSimulatorHostBinary(binaries) {
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
case "$*" in
  "simctl list runtimes -j")
    printf '%s\n' 'core-simulator-cold-init-started' >&2
    if [ "$FAKE_RUNTIME_PROCESS_TREE" = 1 ]; then
      (
        trap '' TERM
        sleep 1.5
        printf '%s\n' 'descendant survived' > "$FAKE_RUNTIME_LEAK_MARKER"
      ) &
      wait
    fi
    if [ "$FAKE_RUNTIME_INVALID_JSON" = 1 ]; then printf '%s\n' 'not-json'; exit 0; fi
    if [ "$FAKE_RUNTIME_HANG" = 1 ]; then while :; do :; done; fi
    sleep "$FAKE_RUNTIME_DELAY_SECONDS"
    printf '%s\n' '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","isAvailable":true,"name":"iOS 26.5","version":"26.5"}]}' ;;
  "simctl list devicetypes -j")
    if [ "$FAKE_DEVICE_TYPE_HANG" = 1 ]; then while :; do :; done; fi
    if [ -n "$FAKE_DEVICE_TYPE_DELAY_SECONDS" ]; then sleep "$FAKE_DEVICE_TYPE_DELAY_SECONDS"; fi
    printf '%s\n' '{"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","name":"iPhone 17 Pro"}]}' ;;
  *) printf '%s\n' "unexpected command: $*" >&2; exit 2 ;;
esac
`,
  );
}

test("iOS gives the first CoreSimulator runtime probe its lifecycle deadline", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-host-cold-init-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  writeIosSimulatorHostBinary(binaries);

  await withEnvironment(
    {
      FAKE_RUNTIME_DELAY_SECONDS: "1",
      FAKE_RUNTIME_HANG: undefined,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      await assert.doesNotReject(() =>
        Promise.resolve(
          validateIosSimulatorEnvironment({
            artifactRoot,
            hostLifecycleTimeoutMs: 5000,
            probeTimeoutMs: 500,
          }),
        ),
      );
    },
  );
});

test(
  "iOS host runtime discovery kills a TERM-resistant child retaining output pipes",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = createTemporaryTestDirectory(t, "plogkit-ios-host-process-tree-");
    const binaries = join(directory, "bin");
    const artifactRoot = join(directory, "artifacts");
    const leakMarker = join(directory, "descendant-survived");
    mkdirSync(binaries);
    mkdirSync(artifactRoot);
    writeIosSimulatorHostBinary(binaries);

    await withEnvironment(
      {
        FAKE_RUNTIME_DELAY_SECONDS: "0",
        FAKE_RUNTIME_HANG: undefined,
        FAKE_RUNTIME_LEAK_MARKER: leakMarker,
        FAKE_RUNTIME_PROCESS_TREE: "1",
        PATH: `${binaries}:${process.env.PATH}`,
      },
      async () => {
        await assert.rejects(
          async () =>
            validateIosSimulatorEnvironment({
              artifactRoot,
              hostLifecycleTimeoutMs: 600,
              probeTimeoutMs: 500,
            }),
          (error) => error.code === "E2E_COMMAND_TIMEOUT",
        );
      },
    );

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1700));
    assert.equal(existsSync(leakMarker), false);
  },
);

test("iOS preserves a host timeout when writing its evidence also fails", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-host-evidence-write-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  mkdirSync(join(artifactRoot, "ios-host-lifecycle.log"));
  writeIosSimulatorHostBinary(binaries);

  await withEnvironment(
    {
      FAKE_RUNTIME_DELAY_SECONDS: "0",
      FAKE_RUNTIME_HANG: "1",
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      await assert.rejects(
        async () =>
          validateIosSimulatorEnvironment({
            artifactRoot,
            hostLifecycleTimeoutMs: 600,
            probeTimeoutMs: 500,
          }),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, error.errors[0]);
          assert.equal(error.cause.code, "E2E_COMMAND_TIMEOUT");
          assert.match(error.cause.message, /xcrun simctl list runtimes -j/);
          assert.equal(error.errors[1].code, "EISDIR");
          return true;
        },
      );
    },
  );
});

test("iOS preserves a host parse error when writing its evidence also fails", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-host-parse-evidence-write-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  mkdirSync(join(artifactRoot, "ios-host-lifecycle.log"));
  writeIosSimulatorHostBinary(binaries);

  await withEnvironment(
    {
      FAKE_RUNTIME_DELAY_SECONDS: "0",
      FAKE_RUNTIME_HANG: undefined,
      FAKE_RUNTIME_INVALID_JSON: "1",
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      await assert.rejects(
        validateIosSimulatorEnvironment({
          artifactRoot,
          hostLifecycleTimeoutMs: 1000,
          probeTimeoutMs: 500,
        }),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, error.errors[0]);
          assert.ok(error.cause instanceof SyntaxError);
          assert.equal(error.cause.code, "E2E_COMMAND_OUTPUT_INVALID");
          assert.match(error.cause.message, /xcrun simctl list runtimes -j/);
          assert.match(error.cause.message, /not-json/);
          assert.equal(error.errors[1].code, "EISDIR");
          return true;
        },
      );
    },
  );
});

test("iOS bounds a hung host lifecycle probe without publishing its arguments", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-host-hang-");
  const binaries = join(directory, "bin");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(binaries);
  mkdirSync(artifactRoot);
  writeIosSimulatorHostBinary(binaries);

  await withEnvironment(
    {
      FAKE_RUNTIME_DELAY_SECONDS: "0",
      FAKE_RUNTIME_HANG: "1",
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      await assert.rejects(
        async () =>
          validateIosSimulatorEnvironment({
            artifactRoot,
            hostLifecycleTimeoutMs: 1500,
            probeTimeoutMs: 500,
          }),
        (error) => {
          assert.equal(error.code, "E2E_COMMAND_TIMEOUT");
          assert.match(error.message, /xcrun simctl list runtimes -j/);
          assert.match(error.message, /core-simulator-cold-init-started/);
          return true;
        },
      );
    },
  );

  const evidencePath = join(artifactRoot, "ios-host-lifecycle.log");
  assert.equal(existsSync(evidencePath), true);
  assert.ok(statSync(evidencePath).size <= 1024 * 1024);
  const evidence = readFileSync(evidencePath, "utf8");
  assert.match(evidence, /probe: runtime-discovery/);
  assert.match(evidence, /xcrun <arguments redacted>/);
  assert.doesNotMatch(evidence, /simctl list runtimes -j/);
  assert.match(evidence, /core-simulator-cold-init-started/);
});

test("iOS keeps ordinary simctl host queries on the short probe deadline", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-host-ordinary-probe-");
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeIosSimulatorHostBinary(binaries);

  await withEnvironment(
    {
      FAKE_DEVICE_TYPE_DELAY_SECONDS: "0.2",
      FAKE_DEVICE_TYPE_HANG: undefined,
      FAKE_RUNTIME_DELAY_SECONDS: "0",
      FAKE_RUNTIME_HANG: undefined,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      await assert.rejects(
        async () =>
          validateIosSimulatorEnvironment({
            hostLifecycleTimeoutMs: 5000,
            probeTimeoutMs: 50,
          }),
        (error) => {
          assert.equal(error.code, "ETIMEDOUT");
          return true;
        },
      );
    },
  );
});
