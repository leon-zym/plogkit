import {
  captureHostHealthProbe,
  captureHostProcessProbe,
  captureHostState,
  createHostEligibility,
  hostStateExecutionReadiness,
  mergeSampleHostEligibilityReasons,
} from "./renderMeasurementHost";

const SELF_PID = 500;

function ps(...lines) {
  return lines.join("\n");
}

function nominalHealth() {
  return captureHostHealthProbe({
    runThermal: () =>
      ps(
        "Note: No thermal warning level has been recorded",
        "Note: No performance warning level has been recorded",
        "Note: No CPU power status has been recorded",
      ),
    runMemoryPressure: () => "1",
  });
}

function nominalPower() {
  return { status: "available", source: "ac", lowPowerMode: false };
}

describe("render measurement host process probe", () => {
  it("captures a deterministic host snapshot through sanitized probes", () => {
    expect(
      captureHostState("/repo", {
        now: () => "2026-08-04T00:00:00.000Z",
        getLoadAverage: () => [1, 2, 3],
        getFreeMemory: () => 4,
        statFilesystem: () => ({ bavail: 5, bsize: 6 }),
        runPowerSource: () => "Now drawing from 'AC Power'\n",
        runPowerSettings: () => "Currently in use:\n lowpowermode 0\n",
        captureProcessProbe: () => ({ status: "available", detectedInterference: {} }),
        captureHealthProbe: () => nominalHealth(),
      }),
    ).toEqual({
      capturedAt: "2026-08-04T00:00:00.000Z",
      loadAverage: { oneMinute: 1, fiveMinutes: 2, fifteenMinutes: 3 },
      freeMemoryBytes: 4,
      availableStorageBytes: 30,
      powerState: nominalPower(),
      processProbe: { status: "available", detectedInterference: {} },
      healthProbe: nominalHealth(),
    });
  });

  it("ignores the measurement process and its ancestors", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 400 12.0 node /repo/node_modules/jest/bin/jest.js --runInBand",
          "400 300 3.0 pnpm measure:render --token ancestor-secret",
          "300 1 0.0 zsh -lc pnpm measure:render",
          "900 1 0.0 /usr/sbin/syslogd",
        ),
    });

    expect(probe).toEqual({
      status: "available",
      detectedInterference: {
        simulators: [],
        builds: [],
        testsOrBenchmarks: [],
        indexing: [],
      },
    });
  });

  it("classifies external workload while serializing only safe process identity", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 400 0.1 node measurement.js",
          "400 1 0.0 zsh",
          "601 1 18.5 /Users/alice/private/Xcode.app/xcodebuild -token build-secret",
          "602 1 7.5 node /Users/alice/repo/node_modules/jest/bin/jest.js --api-key test-secret",
          "603 1 2.5 /Applications/Simulator.app/Contents/MacOS/Simulator --device secret-device",
          "604 1 1.2 /System/Library/Frameworks/CoreServices.framework/mdworker -s private-path",
        ),
    });

    expect(probe).toEqual({
      status: "available",
      detectedInterference: {
        simulators: [{ category: "simulator", pid: 603, cpuPercent: 2.5, executable: "Simulator" }],
        builds: [{ category: "build", pid: 601, cpuPercent: 18.5, executable: "xcodebuild" }],
        testsOrBenchmarks: [
          { category: "test-or-benchmark", pid: 602, cpuPercent: 7.5, executable: "node" },
        ],
        indexing: [{ category: "indexing", pid: 604, cpuPercent: 1.2, executable: "mdworker" }],
      },
    });
    const serialized = JSON.stringify(probe);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("private-path");
  });

  it("classifies every repository verification command as external workload", () => {
    const commands = [
      "pnpm check",
      "pnpm run test:render",
      "pnpm exec jest --runInBand",
      "node --test scripts/e2e/example.test.mjs",
      "jest --runInBand",
      "node /repo/node_modules/typescript/bin/tsc --noEmit",
      "eslint .",
      "expo lint",
      "prettier --check .",
    ];
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          ...commands.map((command, index) => `${601 + index} 1 1.0 ${command}`),
        ),
    });

    expect(probe.detectedInterference.testsOrBenchmarks.map(({ pid }) => pid)).toEqual(
      commands.map((_command, index) => 601 + index),
    );
  });

  it("distinguishes real verification CLIs from editor servers and arbitrary argv text", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "641 1 0.0 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --ms-enable-electron-run-as-node /Users/alice/.vscode/extensions/dbaeumer.vscode-eslint-3.0.34/server/out/eslintServer.js --node-ipc --clientProcessId=100",
          "642 1 0.0 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --ms-enable-electron-run-as-node /Users/alice/.vscode/extensions/dbaeumer.vscode-eslint-3.0.34/server/out/eslintServer.js --node-ipc --clientProcessId=200",
          "643 1 2.0 /opt/homebrew/bin/eslint .",
          "644 1 2.0 node /repo/node_modules/eslint/bin/eslint.js .",
          "645 1 2.0 node /repo/node_modules/jest/bin/jest.js --runInBand",
          "646 1 2.0 /opt/homebrew/bin/maestro test e2e/flow.yaml",
          "647 1 2.0 node --test scripts/example.test.mjs",
          "648 1 0.0 node worker.js --label eslint",
          "649 1 0.0 node worker.js --fixture /tmp/prettier",
          "650 1 2.0 node /opt/homebrew/bin/pnpm test -- --runInBand",
          "651 1 2.0 node /usr/local/lib/node_modules/npm/bin/npm-cli.js test",
          "652 1 2.0 node /opt/homebrew/lib/node_modules/yarn/bin/yarn.js test",
        ),
    });

    expect(probe.detectedInterference.testsOrBenchmarks).toEqual([
      { category: "test-or-benchmark", pid: 643, cpuPercent: 2, executable: "eslint" },
      { category: "test-or-benchmark", pid: 644, cpuPercent: 2, executable: "node" },
      { category: "test-or-benchmark", pid: 645, cpuPercent: 2, executable: "node" },
      { category: "test-or-benchmark", pid: 646, cpuPercent: 2, executable: "maestro" },
      { category: "test-or-benchmark", pid: 647, cpuPercent: 2, executable: "node" },
      { category: "test-or-benchmark", pid: 650, cpuPercent: 2, executable: "node" },
      { category: "test-or-benchmark", pid: 651, cpuPercent: 2, executable: "node" },
      { category: "test-or-benchmark", pid: 652, cpuPercent: 2, executable: "node" },
    ]);
  });

  it("lexically normalizes real Node bin entrypoints without inspecting fixture paths", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "661 1 2.0 node ./node_modules/.bin/../eslint/bin/eslint.js .",
          "662 1 2.0 node ./node_modules/.bin/../jest/bin/jest.js --runInBand",
          "663 1 2.0 node ./node_modules/.bin/../expo/bin/cli lint",
          "664 1 2.0 node ./node_modules/.bin/../expo/bin/cli start",
          "665 1 2.0 node /opt/homebrew/bin/pnpm exec expo lint",
          "666 1 0.0 node worker.js --fixture ./node_modules/.bin/../eslint/bin/eslint.js",
          "667 1 0.0 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --ms-enable-electron-run-as-node /Users/alice/.vscode/extensions/dbaeumer.vscode-eslint-3.0.34/server/out/eslintServer.js --node-ipc",
          "668 1 0.0 node worker.js --fixture ./node_modules/.bin/../expo/bin/cli start",
        ),
    });

    expect(probe.detectedInterference.testsOrBenchmarks.map(({ pid }) => pid)).toEqual([
      661, 662, 663, 665,
    ]);
    expect(probe.detectedInterference.builds).toEqual([
      { category: "build", pid: 664, cpuPercent: 2, executable: "node" },
    ]);
  });

  it("classifies Expo build actions across real launchers without scanning arbitrary argv text", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "671 1 2.0 expo prebuild",
          "672 1 2.0 npx expo export:web",
          "673 1 2.0 node ./node_modules/.bin/../expo/bin/cli export:embed",
          "674 1 2.0 node /opt/homebrew/bin/pnpm exec expo export",
          "675 1 2.0 pnpm exec expo prebuild",
          "676 1 2.0 expo run:ios",
          "677 1 2.0 expo build:ios",
          "678 1 0.0 node worker.js --fixture ./node_modules/.bin/../expo/bin/cli export:web",
          "679 1 0.0 node worker.js --label expo prebuild",
          "680 1 0.0 expo doctor",
          "681 1 0.0 pnpm exec expo lint",
          "682 1 2.0 yarn dlx expo prebuild",
          "683 1 2.0 pnpm dlx expo export:web",
          "684 1 2.0 bun x expo start",
          "685 1 0.0 yarn dlx expo lint",
          "686 1 2.0 npm exec -- expo export:embed",
          "687 1 2.0 npx --yes expo prebuild",
          "688 1 0.0 npx --yes worker --label expo prebuild",
        ),
    });

    expect(probe.detectedInterference.builds.map(({ pid }) => pid)).toEqual([
      671, 672, 673, 674, 675, 676, 677, 682, 683, 684, 686, 687,
    ]);
    expect(probe.detectedInterference.testsOrBenchmarks.map(({ pid }) => pid)).toEqual([681, 685]);
  });

  it("classifies supported package-manager tool runners only by their command position", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "691 1 2.0 npm exec jest -- --runInBand",
          "692 1 2.0 node /usr/local/lib/node_modules/npm/bin/npm-cli.js exec jest -- --runInBand",
          "693 1 2.0 yarn exec vitest run",
          "694 1 2.0 bun x eslint .",
          "695 1 2.0 yarn dlx prettier --check .",
          "696 1 2.0 pnpm dlx vitest run",
          "697 1 0.0 npm exec worker --label jest",
          "698 1 0.0 bun x worker --fixture eslint",
          "699 1 0.0 pnpm dlx worker --fixture vitest",
          "700 1 2.0 npm exec -- jest -- --runInBand",
          "701 1 2.0 node /usr/local/lib/node_modules/npm/bin/npm-cli.js exec -- vitest run",
          "702 1 2.0 npx -y jest --runInBand",
          "703 1 2.0 npx --yes -- vitest run",
          "704 1 0.0 npx --yes worker --fixture jest",
        ),
    });

    expect(probe.detectedInterference.testsOrBenchmarks.map(({ pid }) => pid)).toEqual([
      691, 692, 693, 694, 695, 696, 700, 701, 702, 703,
    ]);
  });

  it("classifies the Metro 0.84.4 CLI actions only from a real launcher", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "711 1 2.0 metro start",
          "712 1 2.0 node ./node_modules/.bin/../metro/src/cli.js start",
          "713 1 2.0 pnpm exec metro start",
          "714 1 2.0 node /opt/homebrew/bin/pnpm exec metro start",
          "715 1 2.0 npx metro start",
          "716 1 0.0 node worker.js --fixture /tmp/metro",
          "717 1 0.0 node worker.js --label metro start",
          "718 1 0.0 node worker.js --fixture ./node_modules/.bin/../metro/src/cli.js start",
          "719 1 0.0 metro doctor",
          "720 1 2.0 metro serve",
          "721 1 2.0 node ./node_modules/.bin/../metro/src/cli.js build index.js",
          "722 1 2.0 npx metro get-dependencies index.js",
          "723 1 2.0 yarn dlx metro serve",
          "724 1 2.0 npx --yes metro build index.js",
          "725 1 0.0 npx --yes worker --label metro serve",
        ),
    });

    expect(probe.detectedInterference.builds.map(({ pid }) => pid)).toEqual([
      711, 712, 713, 714, 715, 720, 721, 722, 723, 724,
    ]);
  });

  it("classifies native and package builds only from executable and action positions", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "731 1 2.0 /usr/bin/xcodebuild -scheme App",
          "732 1 2.0 /usr/bin/clang -c main.c",
          "733 1 2.0 /usr/bin/swiftc main.swift",
          "734 1 2.0 /opt/homebrew/bin/kotlinc main.kt",
          "735 1 2.0 /usr/bin/xcrun xcodebuild -scheme App",
          "736 1 2.0 /usr/bin/xcrun --sdk iphoneos clang -c main.c",
          "737 1 2.0 /usr/bin/env DEVELOPER_DIR=/Applications/Xcode.app swiftc main.swift",
          "738 1 2.0 npm run build",
          "739 1 2.0 yarn build",
          "740 1 2.0 bun run build",
          "741 1 2.0 pnpm build",
          "742 1 2.0 pnpm start",
          "743 1 2.0 pnpm prebuild",
          "744 1 2.0 node /opt/homebrew/bin/pnpm build",
          "745 1 2.0 node /usr/local/lib/node_modules/npm/bin/npm-cli.js run build",
          "746 1 0.0 node worker.js --fixture /tmp/xcodebuild",
          "747 1 0.0 node worker.js --label clang",
          "748 1 0.0 node worker.js --fixture swiftc",
          "749 1 0.0 node worker.js --label kotlinc",
          "750 1 0.0 xcrun --find clang",
          "751 1 0.0 node worker.js --label npm run build",
          "752 1 0.0 node worker.js --fixture pnpm start",
          "753 1 0.0 npm exec worker --label build",
        ),
    });

    expect(probe.detectedInterference.builds.map(({ pid }) => pid)).toEqual([
      731, 732, 733, 734, 735, 736, 737, 738, 739, 740, 741, 742, 743, 744, 745,
    ]);
  });

  it("classifies build, start, and prebuild scripts uniformly across package managers", () => {
    const directCommands = ["npm", "yarn", "bun", "pnpm"].flatMap((manager) =>
      ["build", "start", "prebuild"].flatMap((action) => [
        `${manager} ${action}`,
        `${manager} run ${action}`,
      ]),
    );
    const nodeCommands = [
      "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      "/opt/homebrew/lib/node_modules/yarn/bin/yarn.js",
      "/opt/homebrew/bin/pnpm",
    ].flatMap((entrypoint) =>
      ["build", "start", "prebuild"].flatMap((action) => [
        `node ${entrypoint} ${action}`,
        `node ${entrypoint} run ${action}`,
      ]),
    );
    const commands = [...directCommands, ...nodeCommands];
    const firstPid = 900;
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          ...commands.map((command, index) => `${firstPid + index} 1 2.0 ${command}`),
          "990 1 0.0 node worker.js --fixture npm start",
          "991 1 0.0 node worker.js --label pnpm prebuild",
          "992 1 0.0 npm exec worker --label start",
          "993 1 0.0 yarn dlx worker --fixture prebuild",
        ),
    });

    expect(probe.detectedInterference.builds.map(({ pid }) => pid)).toEqual(
      commands.map((_command, index) => firstPid + index),
    );
  });

  it("classifies simulator and indexing processes only by executable identity", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "761 1 2.0 /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator",
          "762 1 2.0 /usr/libexec/launchd_sim",
          "763 1 2.0 /opt/homebrew/bin/qemu-system-aarch64 -machine virt",
          "764 1 2.0 /Users/alice/Library/Android/sdk/emulator/emulator -avd Pixel",
          "765 1 0.0 node worker.js --fixture /tmp/Simulator.app",
          "766 1 0.0 node worker.js --label launchd_sim",
          "767 1 0.0 node worker.js --fixture qemu-system-aarch64",
          "768 1 0.0 node worker.js --label emulator",
          "769 1 1.2 /System/Library/Frameworks/CoreServices.framework/mdworker -s private-path",
          "770 1 1.1 /System/Library/Frameworks/CoreServices.framework/mds",
          "771 1 0.0 node worker.js --fixture /tmp/mdworker",
          "772 1 0.0 node worker.js --label mds",
          "773 1 0.0 /System/Library/Frameworks/CoreServices.framework/mdworker -s idle",
          "774 1 1.3 /System/Library/Frameworks/CoreServices.framework/mds_stores",
          "775 1 1.4 /System/Library/Frameworks/CoreServices.framework/mdworker_shared -s mdworker-bundle",
          "776 1 0.0 node worker.js --fixture /tmp/mds_stores",
          "777 1 0.0 node worker.js --label mdworker_shared",
        ),
    });

    expect(probe.detectedInterference.simulators.map(({ pid }) => pid)).toEqual([
      761, 762, 763, 764,
    ]);
    expect(probe.detectedInterference.indexing.map(({ pid }) => pid)).toEqual([769, 770, 774, 775]);
  });

  it("classifies cross-package-manager, native, Metro, Expo, and E2E workloads", () => {
    const testCommands = [
      "npm install",
      "npm ci",
      "npm test",
      "npm run test:render",
      "npm run e2e",
      "yarn install",
      "yarn test",
      "bun install",
      "bun test",
      "vitest run",
      "pnpm run e2e:ios",
    ];
    const buildCommands = [
      "npm run build",
      "yarn build",
      "bun run build",
      "./gradlew assembleDebug",
      "gradlew test",
      "pnpm run build",
      "pnpm start",
      "pnpm run prebuild",
      "metro start",
      "expo start",
      "npx expo start",
      "expo build:ios",
      "expo export",
    ];
    const commands = [...testCommands, ...buildCommands];
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          ...commands.map((command, index) => `${701 + index} 1 1.0 ${command}`),
        ),
    });

    expect(probe.detectedInterference.testsOrBenchmarks.map(({ pid }) => pid)).toEqual(
      testCommands.map((_command, index) => 701 + index),
    );
    expect(probe.detectedInterference.builds.map(({ pid }) => pid)).toEqual(
      buildCommands.map((_command, index) => 701 + testCommands.length + index),
    );
  });

  it("classifies an absolute Gradle wrapper argv by executable basename", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "801 1 4.5 /Users/alice/project/android/gradlew assembleDebug",
        ),
    });

    expect(probe.detectedInterference.builds).toEqual([
      { category: "build", pid: 801, cpuPercent: 4.5, executable: "gradlew" },
    ]);
  });

  it("classifies a shell-script Gradle wrapper path without matching arbitrary argv text", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "811 1 4.5 /bin/sh -e /Users/alice/project/android/gradlew assembleRelease",
          '812 1 3.5 /bin/bash -eu -o pipefail "/Users/alice/Project Name/android/gradlew" assembleRelease',
          "813 1 1.0 node worker.js --label gradlew",
          "814 1 2.5 /bin/zsh -f -- /Users/alice/project/android/gradlew assembleRelease",
          '815 1 1.0 /bin/sh -c "node worker.js --fixture /tmp/gradlew"',
        ),
    });

    expect(probe.detectedInterference.builds).toEqual([
      { category: "build", pid: 811, cpuPercent: 4.5, executable: "sh" },
      { category: "build", pid: 812, cpuPercent: 3.5, executable: "bash" },
      { category: "build", pid: 814, cpuPercent: 2.5, executable: "zsh" },
    ]);
  });

  it("accepts Gradle only at the Java main-class position", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () =>
        ps(
          "500 1 0.1 node measurement.js",
          "821 1 4.0 /usr/bin/java org.gradle.wrapper.GradleWrapperMain assembleRelease",
          "822 1 3.0 /usr/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.7",
          "823 1 1.0 node worker.js --fixture /tmp/gradlew",
          "824 1 1.0 node worker.js --label gradle",
          "825 1 4.0 /usr/bin/java -cp /tmp/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain assembleRelease",
          "826 1 3.0 /usr/bin/java -Xmx2g --class-path /tmp/gradle-daemon.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.7",
          "827 1 1.0 /usr/bin/java worker --fixture org.gradle.wrapper.GradleWrapperMain",
          "828 1 1.0 /usr/bin/java -cp /tmp/worker.jar worker --label org.gradle.launcher.daemon.bootstrap.GradleDaemon",
          "829 1 1.0 /usr/bin/java -jar org.gradle.wrapper.GradleWrapperMain",
        ),
    });

    expect(probe.detectedInterference.builds).toEqual([
      { category: "build", pid: 821, cpuPercent: 4, executable: "java" },
      { category: "build", pid: 822, cpuPercent: 3, executable: "java" },
      { category: "build", pid: 825, cpuPercent: 4, executable: "java" },
      { category: "build", pid: 826, cpuPercent: 3, executable: "java" },
    ]);
  });

  it("reports an available probe with no external interference", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () => ps("500 1 0.1 node measurement.js", "700 1 0.0 /usr/sbin/syslogd"),
    });

    expect(
      createHostEligibility({
        profile: "full",
        dirty: false,
        isolationConfirmed: true,
        renderVerificationReceiptValid: true,
        processProbe: probe,
        healthProbe: nominalHealth(),
        powerState: nominalPower(),
      }),
    ).toEqual({
      eligible: true,
      resultClass: "engineering-baseline",
      reasons: [],
      isolationConfirmed: true,
      renderVerificationReceiptValid: true,
    });
  });

  it("makes a failed ps probe unavailable and ineligible", () => {
    const probe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () => {
        throw new Error("ps failed with --token probe-secret");
      },
    });

    expect(probe).toEqual({ status: "unavailable", reason: "ps process probe failed" });
    expect(
      createHostEligibility({
        profile: "full",
        dirty: false,
        isolationConfirmed: true,
        renderVerificationReceiptValid: true,
        processProbe: probe,
        healthProbe: nominalHealth(),
        powerState: nominalPower(),
      }),
    ).toEqual({
      eligible: false,
      resultClass: "diagnostic",
      reasons: ["host-process-probe-unavailable"],
      isolationConfirmed: true,
      renderVerificationReceiptValid: true,
    });
    expect(JSON.stringify(probe)).not.toContain("probe-secret");
  });

  it.each([
    ["empty output", ""],
    ["one malformed row", ps("500 1 0.1 node measurement.js", "malformed private-secret")],
    ["no measurement process row", "700 1 0.0 /usr/sbin/syslogd"],
  ])("fails closed when ps returns %s", (_label, output) => {
    const probe = captureHostProcessProbe({ selfPid: SELF_PID, runPs: () => output });

    expect(probe).toEqual({ status: "unavailable", reason: "ps process probe failed" });
    expect(JSON.stringify(probe)).not.toContain("private-secret");
  });

  it("merges before and after process evidence without consulting elapsed time", () => {
    const unavailable = { status: "unavailable", reason: "ps process probe failed" };
    const clean = captureHostProcessProbe({ selfPid: SELF_PID, runPs: () => "500 1 0.1 node" });

    expect(
      mergeSampleHostEligibilityReasons(
        ["worktree-is-dirty"],
        {
          elapsedMs: 1,
          processProbe: clean,
          healthProbe: nominalHealth(),
          powerState: nominalPower(),
        },
        {
          elapsedMs: 999_999,
          processProbe: unavailable,
          healthProbe: nominalHealth(),
          powerState: nominalPower(),
        },
      ),
    ).toEqual(["worktree-is-dirty", "host-process-probe-unavailable"]);
  });

  it("parses explicit nominal thermal and memory-pressure state", () => {
    expect(nominalHealth()).toEqual({
      thermal: {
        status: "nominal",
        raw: ps(
          "Note: No thermal warning level has been recorded",
          "Note: No performance warning level has been recorded",
          "Note: No CPU power status has been recorded",
        ),
      },
      memoryPressure: { status: "nominal", level: 1, raw: "1" },
    });
  });

  it("requires the complete nominal thermal state and rejects unknown extra lines", () => {
    const incomplete = captureHostHealthProbe({
      runThermal: () =>
        ps(
          "Note: No thermal warning level has been recorded",
          "Note: No performance warning level has been recorded",
        ),
      runMemoryPressure: () => "1",
    });
    const extra = captureHostHealthProbe({
      runThermal: () =>
        ps(
          "Note: No thermal warning level has been recorded",
          "Note: No performance warning level has been recorded",
          "Note: No CPU power status has been recorded",
          "Unrecognized_State = 0",
        ),
      runMemoryPressure: () => "1",
    });
    const numeric = captureHostHealthProbe({
      runThermal: () =>
        ps(
          "Thermal_Level = 0",
          "CPU_Scheduler_Limit = 100",
          "CPU_Available_CPUs = 8",
          "CPU_Speed_Limit = 100",
        ),
      runMemoryPressure: () => "1",
      logicalCpuCount: 8,
    });
    const throttledCpuCount = captureHostHealthProbe({
      runThermal: () =>
        ps(
          "Thermal_Level = 0",
          "CPU_Scheduler_Limit = 100",
          "CPU_Available_CPUs = 1",
          "CPU_Speed_Limit = 100",
        ),
      runMemoryPressure: () => "1",
      logicalCpuCount: 8,
    });
    const unknownCpuCount = captureHostHealthProbe({
      runThermal: () =>
        ps(
          "Thermal_Level = 0",
          "CPU_Scheduler_Limit = 100",
          "CPU_Available_CPUs = 8",
          "CPU_Speed_Limit = 100",
        ),
      runMemoryPressure: () => "1",
      logicalCpuCount: null,
    });

    expect(incomplete.thermal.status).toBe("unknown");
    expect(extra.thermal.status).toBe("unknown");
    expect(numeric.thermal.status).toBe("nominal");
    expect(throttledCpuCount.thermal.status).toBe("unknown");
    expect(unknownCpuCount.thermal.status).toBe("unknown");
  });

  it("makes explicit thermal or memory-pressure warnings ineligible", () => {
    const healthProbe = captureHostHealthProbe({
      runThermal: () => "Thermal_Level = 2",
      runMemoryPressure: () => "4",
    });

    expect(healthProbe).toEqual({
      thermal: { status: "warning", raw: "Thermal_Level = 2" },
      memoryPressure: { status: "warning", level: 4, raw: "4" },
    });
    expect(
      createHostEligibility({
        profile: "full",
        dirty: false,
        isolationConfirmed: true,
        renderVerificationReceiptValid: true,
        processProbe: captureHostProcessProbe({
          selfPid: SELF_PID,
          runPs: () => "500 1 0.1 node measurement.js",
        }),
        healthProbe,
        powerState: nominalPower(),
      }).reasons,
    ).toEqual(["host-thermal-warning", "host-memory-pressure-warning"]);
  });

  it("does not enter the next workload block until health and power are nominal", () => {
    expect(
      hostStateExecutionReadiness({
        healthProbe: {
          thermal: { status: "warning" },
          memoryPressure: { status: "nominal" },
        },
        powerState: { status: "available", source: "battery", lowPowerMode: false },
        processProbe: { status: "available", detectedInterference: {} },
      }),
    ).toEqual({
      ready: false,
      reasons: ["host-thermal-warning", "host-on-battery-power"],
      retryableReasons: ["host-thermal-warning"],
      failFastReasons: ["host-on-battery-power"],
    });
  });

  it("treats known workload and unavailable process probes as retryable readiness failures", () => {
    expect(
      hostStateExecutionReadiness({
        healthProbe: nominalHealth(),
        powerState: nominalPower(),
        processProbe: { status: "unavailable", reason: "ps process probe failed" },
      }),
    ).toEqual({
      ready: false,
      reasons: ["host-process-probe-unavailable"],
      retryableReasons: ["host-process-probe-unavailable"],
      failFastReasons: [],
    });
  });

  it("defers retryable host findings to block recovery without weakening static gates", () => {
    expect(
      createHostEligibility({
        profile: "full",
        dirty: false,
        isolationConfirmed: true,
        renderVerificationReceiptValid: true,
        processProbe: { status: "unavailable", reason: "ps process probe failed" },
        healthProbe: {
          thermal: { status: "warning" },
          memoryPressure: { status: "nominal" },
        },
        powerState: nominalPower(),
        deferRecoverableHostChecks: true,
      }),
    ).toEqual({
      eligible: true,
      resultClass: "engineering-baseline",
      reasons: [],
      isolationConfirmed: true,
      renderVerificationReceiptValid: true,
    });
  });

  it("rejects battery power, low-power mode, and unconfirmed golden correctness", () => {
    const processProbe = captureHostProcessProbe({
      selfPid: SELF_PID,
      runPs: () => "500 1 0.1 node measurement.js",
    });
    expect(
      createHostEligibility({
        profile: "full",
        dirty: false,
        isolationConfirmed: true,
        renderVerificationReceiptValid: false,
        processProbe,
        healthProbe: nominalHealth(),
        powerState: { status: "available", source: "battery", lowPowerMode: true },
      }).reasons,
    ).toEqual([
      "render-verification-receipt-invalid",
      "host-on-battery-power",
      "host-low-power-mode-enabled",
    ]);
  });

  it("does not let a no-thermal-warning note mask a performance warning", () => {
    const healthProbe = captureHostHealthProbe({
      runThermal: () =>
        ps(
          "Note: No thermal warning level has been recorded",
          "Performance warning level: CPU_Speed_Limit = 70",
        ),
      runMemoryPressure: () => "1",
    });

    expect(healthProbe.thermal).toEqual({
      status: "warning",
      raw: ps(
        "Note: No thermal warning level has been recorded",
        "Performance warning level: CPU_Speed_Limit = 70",
      ),
    });
  });

  it("keeps unknown health probes from claiming a formal baseline", () => {
    const healthProbe = captureHostHealthProbe({
      runThermal: () => "thermal state has no recognized contract",
      runMemoryPressure: () => {
        throw new Error("sysctl unavailable with --token pressure-secret");
      },
    });

    expect(healthProbe).toEqual({
      thermal: { status: "unknown", raw: "thermal state has no recognized contract" },
      memoryPressure: { status: "unknown", reason: "memory-pressure probe failed" },
    });
    const eligibility = createHostEligibility({
      profile: "full",
      dirty: false,
      isolationConfirmed: true,
      renderVerificationReceiptValid: true,
      processProbe: captureHostProcessProbe({
        selfPid: SELF_PID,
        runPs: () => "500 1 0.1 node measurement.js",
      }),
      healthProbe,
      powerState: nominalPower(),
    });
    expect(eligibility).toEqual({
      eligible: false,
      resultClass: "diagnostic",
      reasons: ["host-thermal-probe-unknown", "host-memory-pressure-probe-unknown"],
      isolationConfirmed: true,
      renderVerificationReceiptValid: true,
    });
    expect(JSON.stringify(healthProbe)).not.toContain("pressure-secret");
  });
});
