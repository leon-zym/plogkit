import { existsSync, rmSync } from "node:fs";
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
  assertIosGuestHealthy,
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
import { assessPhotoResourceDelta, startExportAssertionBridge } from "./export-assertion.mjs";
import {
  assertSeparateIosArtifactRoots,
  publishIosFailureArtifacts,
} from "./ios-artifact-publication.mjs";
import { createIosRunObservationRecorder } from "./ios-observation.mjs";
import {
  aggregateWithPrimary,
  createArtifactRoot,
  createCleanupManager,
  acquireE2ePlatformLock,
  finalizeCleanup,
  finalizeE2eRun,
  installSignalHandlers,
  log,
  publicE2eErrorText,
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

function recorderErrorIdentity(error) {
  return error instanceof Error
    ? `${error.name}${error.code ? ` (${error.code})` : ""}`
    : "NonErrorFailure";
}

function createIosObservation(options, cleanup) {
  if (!options.platforms.includes("ios") || !process.env.E2E_PUBLIC_ARTIFACTS_DIR) return null;
  try {
    return createIosRunObservationRecorder({
      artifactRoot: options.artifactRoot,
      cleanup,
      directory: resolve(process.env.E2E_PUBLIC_ARTIFACTS_DIR),
    });
  } catch (error) {
    log("ios", `Run observation unavailable: ${recorderErrorIdentity(error)}.`);
    return null;
  }
}

function observeIos(observation, stage, operation) {
  return observation ? observation.run(stage, operation) : operation();
}

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

export async function validateAfterAcquiringPlatformLocks(
  platforms,
  options,
  {
    acquirePlatformLock = acquireE2ePlatformLock,
    validateLockedEnvironment = validateLockedPlatformEnvironment,
  } = {},
) {
  for (const platform of [...platforms].sort()) {
    acquirePlatformLock(platform, options.cleanup);
  }
  await validateLockedEnvironment(platforms, options);
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

async function build(platforms, cleanup, hostEnvironment, observation) {
  await prebuild(platforms, cleanup);
  for (const platform of platforms) {
    if (platform === "ios") await buildIos({ cleanup, observation, root, workers: buildWorkers });
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

async function prepareDevice(platform, { artifactRoot, cleanup, observation }) {
  return platform === "ios"
    ? prepareIosDevice({ artifactRoot, cleanup, observation })
    : prepareAndroidDevice({ artifactRoot, cleanup });
}

async function installAndSeed({ artifact, cleanup, device, fixtures, observation }) {
  const options = { artifact, cleanup, device, fixtures, observation, root };
  if (device.platform === "ios") await installAndSeedIos(options);
  else await installAndSeedAndroid(options);
}

function capturePhotoResources(device) {
  return device.platform === "ios"
    ? captureIosPhotoResources(device)
    : captureAndroidPhotoResources(device);
}

async function closeVerificationBridge(close, operationError = null) {
  try {
    await close();
  } catch (closeError) {
    if (operationError) {
      throw aggregateWithPrimary(operationError, [closeError]);
    }
    throw closeError;
  }
  if (operationError) throw operationError;
}

async function runSuiteWithExportAssertion(options) {
  const { device, flow, observation } = options;
  const assertsExport = flow === null || flow === "f04-export";
  const expectedNewResources = assertsExport ? 2 : 0;
  const before = assertsExport ? capturePhotoResources(device) : null;
  const bridge = assertsExport
    ? await startExportAssertionBridge({
        beforePhotoResources: before,
        capturePhotoResources,
        device,
      })
    : null;

  let suiteError = null;
  try {
    await observeIos(observation, "ios-maestro-suite", () =>
      runMaestroSuite({
        ...options,
        flowEnvironment: {
          ...options.flowEnvironment,
          ...bridge?.environment,
        },
      }),
    );
  } catch (error) {
    suiteError = error;
  }
  if (bridge) {
    await closeVerificationBridge(bridge.close, suiteError);
  } else {
    if (suiteError) throw suiteError;
  }
  if (!assertsExport) return;

  const after = await waitUntil(
    () => {
      const resources = capturePhotoResources(device);
      return assessPhotoResourceDelta(before, resources, expectedNewResources);
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

async function runAcceptance(platforms, { artifactRoot, cleanup, flow, observation, snapshot }) {
  for (const platform of platforms) {
    const platformCleanup = createCleanupManager();
    let platformFinalized = false;
    cleanup.add(async () => {
      if (!platformFinalized) await platformCleanup.run();
    });
    let platformError = null;
    const startedAtMs = Date.now();
    try {
      log("setup", `Preparing the ${platform} test device.`);
      const platformObservation = platform === "ios" ? observation : null;
      const device = await prepareDevice(platform, {
        artifactRoot,
        cleanup: platformCleanup,
        observation: platformObservation,
      });
      await withFailureDiagnostics({
        diagnosticDirectory: join(artifactRoot, platform, "acceptance-failure"),
        device,
        sinceMs: startedAtMs,
        operation: async () => {
          if (platform === "ios") {
            await assertIosGuestHealthy({
              artifactRoot,
              cleanup: platformCleanup,
              device,
              observation: platformObservation,
            });
          }
          await installAndSeed({
            artifact: snapshot.artifacts[device.platform],
            cleanup: platformCleanup,
            device,
            fixtures: snapshot.fixtures,
            observation: platformObservation,
          });
          if (platform === "android")
            await assertAndroidDeviceReady({
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
            observation: platformObservation,
            root,
          });
        },
      });
    } catch (error) {
      platformError = error;
    }
    try {
      await finalizeCleanup(platformCleanup, platformError);
    } finally {
      platformFinalized = true;
    }
    log("result", `${platform} E2E suite passed.`);
  }
  log("result", `All ${platforms.join(" + ")} E2E suites passed.`);
}

async function runCompleteE2e(options, cleanup, artifactRoot, hostEnvironment, observation) {
  const repositorySha256 = captureBuildInputs(root);
  await build(options.platforms, cleanup, hostEnvironment, observation);
  const snapshot = await observeIos(observation, "ios-input-snapshot", () =>
    createRunSnapshot({
      artifactRoot,
      builds: options.platforms.map((platform) => ({ platform, ...buildPaths(platform) })),
      repositorySha256,
      root,
    }),
  );
  log(
    "setup",
    process.env.CI
      ? "Captured immutable Release run inputs."
      : `Captured immutable Release run inputs: ${snapshot.provenance}`,
  );
  await runAcceptance(options.platforms, {
    artifactRoot,
    cleanup,
    flow: options.flow,
    observation,
    snapshot,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const cleanup = createCleanupManager();
  let artifactRoot = null;
  let observation = null;
  let publicationPromise = null;
  let publicationCompleted = false;
  const publishFailureArtifacts = async () => {
    if (
      artifactRoot === null ||
      !options.platforms.includes("ios") ||
      !process.env.E2E_PUBLIC_ARTIFACTS_DIR
    ) {
      return;
    }
    publicationPromise ??= Promise.resolve().then(() => {
      const destination = publishIosFailureArtifacts({
        publicationRoot: process.env.E2E_PUBLIC_ARTIFACTS_DIR,
        sourceRoot: artifactRoot,
      });
      publicationCompleted = true;
      return destination;
    });
    return publicationPromise;
  };
  const signalState = installSignalHandlers(cleanup, {
    publishFailureArtifacts,
    recordInterruption: () => observation?.finish("interrupted"),
  });
  let operationError = null;
  try {
    validateMaestroVersion();
    const hostEnvironment = validateBeforePlatformLock(options);
    artifactRoot = createArtifactRoot();
    try {
      if (options.platforms.includes("ios") && process.env.E2E_PUBLIC_ARTIFACTS_DIR) {
        assertSeparateIosArtifactRoots({
          publicationRoot: process.env.E2E_PUBLIC_ARTIFACTS_DIR,
          sourceRoot: artifactRoot,
        });
      }
    } catch (error) {
      rmSync(artifactRoot, { force: true, recursive: true });
      artifactRoot = null;
      throw error;
    }
    observation = createIosObservation({ ...options, artifactRoot }, cleanup);
    await observeIos(observation, "ios-simulator-environment", () =>
      validateAfterAcquiringPlatformLocks(options.platforms, { artifactRoot, cleanup }),
    );
    log(
      "setup",
      process.env.CI
        ? `Running ${options.target} Release E2E.`
        : `Running ${options.target} Release E2E; artifacts: ${artifactRoot}`,
    );
    await runCompleteE2e(options, cleanup, artifactRoot, hostEnvironment, observation);
  } catch (error) {
    operationError = error;
  }
  try {
    if (artifactRoot === null) await finalizeCleanup(cleanup, operationError);
    else {
      const artifactsRemoved = await finalizeE2eRun({
        artifactRoot,
        cleanup,
        commitSuccess: signalState.commitSuccess,
        operationError,
        publishFailureArtifacts,
      });
      if (artifactsRemoved) {
        log(
          "cleanup",
          process.env.CI
            ? "Removed temporary artifacts after successful E2E."
            : `Removed temporary artifacts after successful E2E: ${artifactRoot}`,
        );
      }
      await observation?.finish("passed");
    }
  } catch (error) {
    await observation?.finish("failed", error);
    console.error(`[e2e:error] ${publicE2eErrorText(error)}`);
    if (error instanceof AggregateError) {
      for (const secondaryError of error.errors.slice(1)) {
        console.error(`[e2e:secondary] ${publicE2eErrorText(secondaryError)}`);
      }
    }
    if (artifactRoot !== null && existsSync(artifactRoot)) {
      console.error(
        process.env.CI
          ? options.platforms.includes("ios") && process.env.E2E_PUBLIC_ARTIFACTS_DIR
            ? publicationCompleted
              ? "[e2e:error] Sanitized failure artifacts prepared for workflow upload."
              : "[e2e:error] Sanitized failure artifacts were not published."
            : "[e2e:error] Failure artifacts retained for workflow upload."
          : `[e2e:error] Artifacts retained at ${artifactRoot}`,
      );
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
