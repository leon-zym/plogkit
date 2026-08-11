import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertIosDeviceReady,
  assertIosLauncherHierarchy,
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

test("iOS bounds its single simulator boot transition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-boot-timeout-"));
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
    printf '%s\n' 'ios-simulator-state-head'
    awk 'BEGIN { for (i = 0; i < 18000; i++) print "ios-state-padding-012345678901234567890123456789012345678901234567890123456789" }'
    printf '%s\n' 'ios-simulator-state-tail' ;;
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
        prepareIosDevice({ artifactRoot, cleanup: { add() {} }, lifecycleTimeoutMs: 25 }),
        (error) => error.code === "E2E_COMMAND_TIMEOUT",
      );
    },
  );
  assert.equal(readFileSync(bootstatusCount, "utf8"), "1");
  const prepareEvidencePath = join(artifactRoot, "ios-prepare.log");
  assert.ok(statSync(prepareEvidencePath).size <= 1024 * 1024);
  const prepareEvidence = readFileSync(prepareEvidencePath, "utf8");
  assert.match(prepareEvidence, /Command timed out/);
  assert.match(prepareEvidence, /diagnostic bytes omitted/);
  assert.match(prepareEvidence, /ios-simulator-state-tail/);
});

test("iOS bounds every install and media command", async (t) => {
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

  const commands = [`simctl install ${deviceId} ${artifact}`, `simctl addmedia ${deviceId}`];
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

test("iOS rejects a host outside the pinned Xcode toolchain", async () => {
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
    printf '%s\n' '{"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","name":"iPhone 17 Pro"}]}' ;;
  *) printf '%s\n' "unexpected command: $*" >&2; exit 2 ;;
esac
`,
  );
}

test("iOS gives the first CoreSimulator runtime probe its lifecycle deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-host-cold-init-"));
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
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-host-process-tree-"));
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

test("iOS preserves a host timeout when writing its evidence also fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-host-evidence-write-"));
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

test("iOS preserves a host parse error when writing its evidence also fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-host-parse-evidence-write-"));
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

test("iOS bounds a hung host lifecycle probe with command and raw evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-host-hang-"));
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
  assert.match(evidence, /xcrun simctl list runtimes -j/);
  assert.match(evidence, /core-simulator-cold-init-started/);
});

test("iOS keeps ordinary simctl host queries on the short probe deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-host-ordinary-probe-"));
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeIosSimulatorHostBinary(binaries);

  await withEnvironment(
    {
      FAKE_DEVICE_TYPE_HANG: "1",
      FAKE_RUNTIME_DELAY_SECONDS: "0",
      FAKE_RUNTIME_HANG: undefined,
      PATH: `${binaries}:${process.env.PATH}`,
    },
    async () => {
      const startedAt = Date.now();
      await assert.rejects(
        async () =>
          validateIosSimulatorEnvironment({
            hostLifecycleTimeoutMs: 5000,
            probeTimeoutMs: 500,
          }),
        (error) => {
          assert.equal(error.code, "ETIMEDOUT");
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 3000);
    },
  );
});
