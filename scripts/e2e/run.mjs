import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAndroidDeviceReady,
  androidBuildArtifact,
  androidBuildSidecars,
  buildAndroid,
  captureAndroidPhotoResources,
  installAndSeedAndroid,
  prepareAndroidDevice,
  validateAndroidEnvironment,
} from "./android.mjs";
import {
  assertIosDeviceReady,
  buildIos,
  captureIosPhotoResources,
  installAndSeedIos,
  iosBuildArtifact,
  iosBuildSidecars,
  prepareIosDevice,
  validateIosHost,
  validateIosSimulatorEnvironment,
  validateIosToolchain,
} from "./ios.mjs";
import { createStandaloneBuildEnvironment, validateHostEnvironment } from "./environment.mjs";
import { captureBuildInputs, createRunSnapshot } from "./build-snapshot.mjs";
import {
  createArtifactRoot,
  createCleanupManager,
  acquireE2ePlatformLock,
  finalizeCleanup,
  installSignalHandlers,
  log,
  run,
  runMaestroSuite,
  validateMaestroVersion,
  waitUntil,
  withFailureDiagnostics,
} from "./runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceFixtures = [
  resolve(root, "e2e/fixtures/portrait.jpg"),
  resolve(root, "e2e/fixtures/landscape.jpg"),
];
const buildWorkers = "2";

function parseArguments(argv) {
  const target = argv[0] ?? "all";
  let flow = process.env.E2E_FLOW || null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--flow") {
      flow = argv[index + 1];
      if (!flow || flow.startsWith("--")) {
        throw new Error("--flow requires a flow basename such as f06-session-persistence.");
      }
      index += 1;
    } else if (argument.startsWith("--flow=")) {
      flow = argument.slice("--flow=".length);
      if (!flow) {
        throw new Error("--flow requires a flow basename such as f06-session-persistence.");
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!["all", "ios", "android"].includes(target)) {
    throw new Error(`Unsupported platform: ${target}`);
  }
  if (flow === "all" || flow === "") flow = null;
  if (flow && !/^[a-z0-9-]+(?:\.yaml)?$/.test(flow)) {
    throw new Error("--flow must be a flow basename such as f06-session-persistence.");
  }
  return {
    flow: flow ? flow.replace(/\.yaml$/, "") : null,
    platforms: target === "all" ? ["ios", "android"] : [target],
    target,
  };
}

function validateBeforePlatformLock({ flow, platforms }) {
  for (const fixture of sourceFixtures) {
    if (!existsSync(fixture)) throw new Error(`Missing E2E fixture: ${fixture}`);
  }
  if (flow && !existsSync(resolve(root, `e2e/flows/${flow}.yaml`))) {
    throw new Error(`Unknown E2E flow: ${flow}`);
  }
  const hostEnvironment = validateHostEnvironment();
  if (platforms.includes("ios")) {
    validateIosHost();
    validateIosToolchain();
  }
  if (platforms.includes("android")) validateAndroidEnvironment();
  return hostEnvironment;
}

async function validateLockedPlatformEnvironment(platforms, { artifactRoot, cleanup }) {
  if (platforms.includes("ios")) {
    await validateIosSimulatorEnvironment({ artifactRoot, cleanup });
  }
}

function buildPaths(platform) {
  return platform === "ios"
    ? { artifact: iosBuildArtifact(root), sidecars: iosBuildSidecars(root) }
    : { artifact: androidBuildArtifact(root), sidecars: androidBuildSidecars(root) };
}

async function prebuild(platforms, cleanup) {
  const platform = platforms.length === 2 ? "all" : platforms[0];
  log("setup", `Generating clean native projects for ${platform}.`);
  await run("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", platform], {
    cleanup,
    cwd: root,
    env: createStandaloneBuildEnvironment(),
    timeoutMs: 15 * 60 * 1000,
  });
}

async function build(platforms, cleanup, hostEnvironment) {
  await prebuild(platforms, cleanup);
  for (const platform of platforms) {
    if (platform === "ios") await buildIos({ cleanup, root, workers: buildWorkers });
    else {
      await buildAndroid({
        cleanup,
        javaHome: hostEnvironment.javaHome,
        root,
        workers: buildWorkers,
      });
    }
  }
}

async function prepareDevice(platform, { artifactRoot, cleanup }) {
  return platform === "ios"
    ? prepareIosDevice({ artifactRoot, cleanup })
    : prepareAndroidDevice({ artifactRoot, cleanup });
}

async function assertDeviceReady(options) {
  return options.device.platform === "ios"
    ? assertIosDeviceReady(options)
    : assertAndroidDeviceReady(options);
}

async function installAndSeed({ artifact, cleanup, device, fixtures }) {
  const options = { artifact, cleanup, device, fixtures, root };
  if (device.platform === "ios") await installAndSeedIos(options);
  else await installAndSeedAndroid(options);
}

function capturePhotoResources(device) {
  return device.platform === "ios"
    ? captureIosPhotoResources(device)
    : captureAndroidPhotoResources(device);
}

async function runSuiteWithExportAssertion(options) {
  const { device, flow } = options;
  const assertsExport = flow === null || flow === "f04-export";
  const expectedNewResources = assertsExport ? 2 : 0;
  const before = assertsExport ? capturePhotoResources(device) : null;

  await runMaestroSuite(options);

  if (before === null) return;
  const after = await waitUntil(
    () => {
      const resources = capturePhotoResources(device);
      const added = [...resources].filter((resource) => !before.has(resource));
      return added.length >= expectedNewResources ? resources : null;
    },
    10000,
    `${device.platform} system photo library to contain ${expectedNewResources} newly exported resources`,
    500,
  );
  log(
    device.platform,
    `System photo resources gained ${expectedNewResources} new identities (${before.size} before, ${after.size} after).`,
  );
}

async function runAcceptance(platforms, { artifactRoot, cleanup, flow, snapshot }) {
  for (const platform of platforms) {
    const platformCleanup = createCleanupManager();
    cleanup.add(() => platformCleanup.run());
    let platformError = null;
    const startedAtMs = Date.now();
    try {
      log("setup", `Preparing the ${platform} test device.`);
      const device = await prepareDevice(platform, { artifactRoot, cleanup: platformCleanup });
      await withFailureDiagnostics({
        diagnosticDirectory: join(artifactRoot, platform, "acceptance-failure"),
        device,
        sinceMs: startedAtMs,
        operation: async () => {
          await installAndSeed({
            artifact: snapshot.artifacts[device.platform],
            cleanup: platformCleanup,
            device,
            fixtures: snapshot.fixtures,
          });
          await assertDeviceReady({
            artifactRoot,
            cleanup: platformCleanup,
            device,
            stage: "post-install",
          });
          await runSuiteWithExportAssertion({
            artifactRoot,
            cleanup: platformCleanup,
            device,
            e2eRoot: snapshot.e2eRoot,
            flow,
            root,
          });
        },
      });
    } catch (error) {
      platformError = error;
    }
    await finalizeCleanup(platformCleanup, platformError);
    log("result", `${platform} E2E suite passed.`);
  }
  log("result", `All ${platforms.join(" + ")} E2E suites passed.`);
}

async function runCompleteE2e(options, cleanup, artifactRoot, hostEnvironment) {
  const repositorySha256 = captureBuildInputs(root);
  await build(options.platforms, cleanup, hostEnvironment);
  const snapshot = createRunSnapshot({
    artifactRoot,
    builds: options.platforms.map((platform) => ({ platform, ...buildPaths(platform) })),
    repositorySha256,
    root,
  });
  log("setup", `Captured immutable Release run inputs: ${snapshot.provenance}`);
  await runAcceptance(options.platforms, {
    artifactRoot,
    cleanup,
    flow: options.flow,
    snapshot,
  });
}

const options = parseArguments(process.argv.slice(2));
const cleanup = createCleanupManager();
const artifactRoot = createArtifactRoot();
installSignalHandlers(cleanup);

let operationError = null;
try {
  validateMaestroVersion();
  const hostEnvironment = validateBeforePlatformLock(options);
  for (const platform of [...options.platforms].sort()) {
    acquireE2ePlatformLock(platform, cleanup);
  }
  await validateLockedPlatformEnvironment(options.platforms, { artifactRoot, cleanup });
  log("setup", `Running ${options.target} Release E2E; artifacts: ${artifactRoot}`);
  await runCompleteE2e(options, cleanup, artifactRoot, hostEnvironment);
} catch (error) {
  operationError = error;
}
try {
  await finalizeCleanup(cleanup, operationError);
} catch (error) {
  console.error(`[e2e:error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
