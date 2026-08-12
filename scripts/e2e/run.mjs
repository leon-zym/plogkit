import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
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
  finalizeE2eRun,
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

function countNewPhotoResources(before, after) {
  return [...after].filter((resource) => !before.has(resource)).length;
}

export function assessPhotoResourceDelta(before, after, expected) {
  const observed = countNewPhotoResources(before, after);
  if (observed > expected) {
    throw new Error(
      `Expected exactly ${expected} new system photo resources, but observed ${observed}.`,
    );
  }
  return observed === expected ? after : null;
}

export function createPerExportPhotoResourceAssessment(before) {
  let expectedExport = 1;
  return (exportIndex, after) => {
    if (exportIndex !== expectedExport) {
      throw new Error(
        `Expected photo assertion for export ${expectedExport}, but received export ${exportIndex}.`,
      );
    }
    const result = assessPhotoResourceDelta(before, after, exportIndex);
    if (result !== null) expectedExport += 1;
    return result;
  };
}

export async function startExportPhotoAssertionServer(
  device,
  before,
  { captureResources = capturePhotoResources, timeoutMs = 10000 } = {},
) {
  const assess = createPerExportPhotoResourceAssessment(before);
  const token = randomUUID();
  const server = createServer(async (request, response) => {
    const match = request.url?.match(new RegExp(`^/${token}/(\\d+)$`));
    if (request.method !== "POST" || !match) {
      response.writeHead(404).end("Not found.");
      return;
    }
    const exportIndex = Number.parseInt(match[1], 10);
    try {
      const after = await waitUntil(
        () => assess(exportIndex, captureResources(device)),
        timeoutMs,
        `${device.platform} export ${exportIndex} to add exactly 1 system photo resource`,
        500,
      );
      log(
        device.platform,
        `Export ${exportIndex} added exactly 1 new system photo identity ` +
          `(${before.size} before, ${after.size} after).`,
      );
      response.writeHead(204).end();
    } catch (error) {
      response
        .writeHead(409, { "Content-Type": "text/plain; charset=utf-8" })
        .end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const reject = (error) => rejectPromise(error);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine the export photo assertion server address.");
  }
  return {
    close: () =>
      new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
    url: `http://127.0.0.1:${address.port}/${token}`,
  };
}

async function runSuiteWithExportAssertion(options) {
  const { device, flow } = options;
  const assertsExport = flow === null || flow === "f04-export";
  const expectedNewResources = assertsExport ? 2 : 0;
  const before = assertsExport ? capturePhotoResources(device) : null;

  if (before === null) {
    await runMaestroSuite(options);
    return;
  }

  const assertionServer = await startExportPhotoAssertionServer(device, before);
  try {
    await runMaestroSuite({
      ...options,
      flowEnvironment: {
        ...options.flowEnvironment,
        PLOGKIT_EXPORT_ASSERTION_URL: assertionServer.url,
      },
    });
  } finally {
    await assertionServer.close();
  }
  const after = await waitUntil(
    () => {
      const resources = capturePhotoResources(device);
      return assessPhotoResourceDelta(before, resources, expectedNewResources);
    },
    10000,
    `${device.platform} system photo library to contain ${expectedNewResources} newly exported resources`,
    500,
  );
  const observedNewResources = countNewPhotoResources(before, after);
  log(
    device.platform,
    `System photo resources gained ${observedNewResources} new identities (${before.size} before, ${after.size} after).`,
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const cleanup = createCleanupManager();
  const signalState = installSignalHandlers(cleanup);

  let artifactRoot = null;
  let operationError = null;
  try {
    validateMaestroVersion();
    const hostEnvironment = validateBeforePlatformLock(options);
    artifactRoot = createArtifactRoot();
    await validateAfterAcquiringPlatformLocks(options.platforms, { artifactRoot, cleanup });
    log("setup", `Running ${options.target} Release E2E; artifacts: ${artifactRoot}`);
    await runCompleteE2e(options, cleanup, artifactRoot, hostEnvironment);
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
      });
      if (artifactsRemoved) {
        log("cleanup", `Removed temporary artifacts after successful E2E: ${artifactRoot}`);
      }
    }
  } catch (error) {
    console.error(`[e2e:error] ${error instanceof Error ? error.message : String(error)}`);
    if (artifactRoot !== null && existsSync(artifactRoot)) {
      console.error(`[e2e:error] Artifacts retained at ${artifactRoot}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
