import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertIosDeviceReady,
  assertIosLauncherHierarchy,
  installAndSeedIos,
  isIosEnglishLocale,
  prepareIosDevice,
  validateIosEnvironment,
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

test("iOS locale and launcher gates reject ambiguous system state", () => {
  assert.equal(isIosEnglishLocale({ languages: '("en-US")', locale: "en_US" }), true);
  assert.equal(isIosEnglishLocale({ languages: "(zh-Hans)", locale: "zh_CN" }), false);
  assert.doesNotThrow(() => assertIosLauncherHierarchy('{"resource-id":"Home screen icons"}'));
  assert.throws(() => assertIosLauncherHierarchy('{"resource-id":"Settings"}'), /Home screen/);
  assert.throws(
    () =>
      assertIosLauncherHierarchy(
        '{"resource-id":"Home screen icons","text":"SpringBoard quit unexpectedly"}',
      ),
    /system UI fault/,
  );
});

test("iOS readiness preserves the failing hierarchy command output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-readiness-"));
  const binaries = join(directory, "bin");
  const artifacts = join(directory, "artifacts");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "maestro"),
    "#!/bin/sh\nprintf '%s\\n' 'SpringBoard quit unexpectedly' >&2\nexit 1\n",
  );

  await withEnvironment({ PATH: `${binaries}:${process.env.PATH}` }, async () => {
    await assert.rejects(
      assertIosDeviceReady({
        artifactRoot: artifacts,
        cleanup: { add() {} },
        device: { platform: "ios", deviceId: "simulator-test" },
        stage: "post-install",
      }),
      /Command failed/,
    );
  });

  const diagnostics = join(artifacts, "ios", "readiness-post-install");
  assert.match(
    readFileSync(join(diagnostics, "springboard-hierarchy.json"), "utf8"),
    /SpringBoard/,
  );
});

test("each iOS invocation creates, gates, and deletes only its own simulator", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-ephemeral-"));
  const binaries = join(directory, "bin");
  const commandLog = join(directory, "xcrun.log");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
case "$*" in
  "simctl create "*)
    count=$(grep -c '^simctl create ' "$FAKE_XCRUN_LOG")
    if [ "$count" -eq 1 ]; then printf '%s\n' '11111111-1111-1111-1111-111111111111'; else printf '%s\n' '22222222-2222-2222-2222-222222222222'; fi ;;
  "simctl list devices -j")
    if [ "$FAKE_STATE_FAILURE" = 1 ]; then exit 1; fi
    count=$(grep -c '^simctl list devices -j$' "$FAKE_XCRUN_LOG")
    if [ $((count % 2)) -eq 1 ]; then state='Shutting Down'; else state='Shutdown'; fi
    printf '{"devices":{"runtime":[{"udid":"11111111-1111-1111-1111-111111111111","state":"%s"},{"udid":"22222222-2222-2222-2222-222222222222","state":"%s"}]}}\n' "$state" "$state" ;;
  *"defaults read NSGlobalDomain AppleLanguages") printf '%s\n' '("en-US")' ;;
  *"defaults read NSGlobalDomain AppleLocale") printf '%s\n' 'en_US' ;;
  "simctl delete "*) [ "$3" != "$FAKE_DELETE_FAILURE" ] || { printf '%s\n' 'injected delete failure' >&2; exit 1; } ;;
esac
`,
  );

  const devices = [];
  await withEnvironment(
    {
      FAKE_DELETE_FAILURE: undefined,
      FAKE_STATE_FAILURE: undefined,
      FAKE_XCRUN_LOG: commandLog,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      for (let invocation = 0; invocation < 2; invocation += 1) {
        const cleanup = createCleanupManager();
        const device = await prepareIosDevice({ cleanup });
        devices.push(device);
        if (invocation === 0) {
          process.env.FAKE_STATE_FAILURE = "1";
          await cleanup.run();
          delete process.env.FAKE_STATE_FAILURE;
        } else {
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
    assert.equal(owned.filter((command) => command === `simctl boot ${deviceId}`).length, 2);
    assert.equal(owned.filter((command) => command === `simctl shutdown ${deviceId}`).length, 2);
    assert.equal(owned.at(-1), `simctl delete ${deviceId}`);
  }
});

test("iOS bounds both simulator bootstatus stages", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-boot-timeout-"));
  const binaries = join(directory, "bin");
  const bootstatusCount = join(directory, "bootstatus-count");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
case "$*" in
  "simctl create "*) printf '%s\n' '33333333-3333-3333-3333-333333333333' ;;
  "simctl bootstatus "*)
    count=$(($(cat "$FAKE_BOOTSTATUS_COUNT") + 1)); printf '%s' "$count" > "$FAKE_BOOTSTATUS_COUNT"
    if [ "$count" -eq "$FAKE_HANG_BOOTSTATUS" ]; then sleep 0.15; fi ;;
  "simctl list devices -j")
    printf '%s\n' '{"devices":{"runtime":[{"udid":"33333333-3333-3333-3333-333333333333","state":"Shutdown"}]}}' ;;
  *"defaults read NSGlobalDomain AppleLanguages") printf '%s\n' '("en-US")' ;;
  *"defaults read NSGlobalDomain AppleLocale") printf '%s\n' 'en_US' ;;
esac
`,
  );

  await withEnvironment(
    {
      FAKE_BOOTSTATUS_COUNT: bootstatusCount,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      for (const stage of [1, 2]) {
        await t.test(`bootstatus stage ${stage}`, async () => {
          writeFileSync(bootstatusCount, "0");
          await withEnvironment({ FAKE_HANG_BOOTSTATUS: String(stage) }, async () => {
            await assert.rejects(
              prepareIosDevice({ cleanup: { add() {} }, lifecycleTimeoutMs: 25 }),
              (error) => error.code === "E2E_COMMAND_TIMEOUT",
            );
          });
        });
      }
    },
  );
});

test("iOS bounds every install, media, and Photos permission command", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-mutation-timeout-"));
  const binaries = join(directory, "bin");
  const deviceId = "44444444-4444-4444-4444-444444444444";
  const artifact = join(directory, "PlogKit.app");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
if [ "$*" = "$FAKE_HANG_COMMAND" ]; then sleep 0.15; fi
`,
  );

  const commands = [
    `simctl install ${deviceId} ${artifact}`,
    `simctl addmedia ${deviceId}`,
    `simctl privacy ${deviceId} reset photos-add com.leonzym.plogkit`,
    `simctl privacy ${deviceId} reset photos com.leonzym.plogkit`,
  ];
  await withEnvironment({ PATH: `${binaries}:${process.env.PATH}` }, async () => {
    for (const command of commands) {
      await t.test(command, async () => {
        await withEnvironment({ FAKE_HANG_COMMAND: command }, async () => {
          await assert.rejects(
            installAndSeedIos({
              artifact,
              cleanup: { add() {} },
              device: { platform: "ios", deviceId },
              fixtures: [],
              lifecycleTimeoutMs: 25,
              root: directory,
            }),
            (error) => error.code === "E2E_COMMAND_TIMEOUT",
          );
        });
      });
    }
  });
});

test("iOS rejects a host outside the pinned Xcode toolchain", () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-toolchain-"));
  writeExecutable(
    join(directory, "xcode-select"),
    "#!/bin/sh\nprintf '%s\\n' '/Applications/Xcode-beta.app/Contents/Developer'\n",
  );
  writeExecutable(
    join(directory, "xcodebuild"),
    "#!/bin/sh\nprintf '%s\\n' 'Xcode 27.0' 'Build version 27A5218g'\n",
  );
  writeExecutable(join(directory, "pod"), "#!/bin/sh\nprintf '%s\\n' '1.17.0'\n");
  assert.throws(() => {
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    try {
      validateIosEnvironment();
    } finally {
      process.env.PATH = previousPath;
    }
  }, /Xcode 26\.6 \(17F113\) is required, but Xcode 27\.0 \(27A5218g\) is selected/);
});
