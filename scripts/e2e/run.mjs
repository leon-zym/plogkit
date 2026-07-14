import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  androidBuildArtifact,
  buildAndroid,
  installAndSeedAndroid,
  prepareAndroidDevice,
} from "./android.mjs";
import {
  buildIos,
  installAndSeedIos,
  iosBuildArtifact,
  prepareIosDevice,
  validateIosHost,
} from "./ios.mjs";
import {
  assertMetroPortAvailable,
  createArtifactRoot,
  createCleanupManager,
  installSignalHandlers,
  log,
  run,
  runMaestroSuite,
  startMetro,
  warmUpApp,
} from "./runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = [
  resolve(root, "e2e/fixtures/portrait.jpg"),
  resolve(root, "e2e/fixtures/landscape.jpg"),
];

function parseArguments(argv) {
  const target = argv[0] ?? "all";
  let phase = "all";
  let deviceId = null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--phase") {
      phase = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--phase=")) {
      phase = argument.slice("--phase=".length);
    } else if (argument === "--device") {
      deviceId = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--device=")) {
      deviceId = argument.slice("--device=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!["all", "ios", "android"].includes(target)) {
    throw new Error(`Unsupported platform: ${target}`);
  }
  if (!["all", "build", "test"].includes(phase)) {
    throw new Error(`Unsupported phase: ${phase}`);
  }
  if (target === "all" && deviceId) {
    throw new Error("--device requires a single platform target.");
  }
  return {
    deviceId,
    phase,
    platforms: target === "all" ? ["ios", "android"] : [target],
    target,
  };
}

function buildWorkers() {
  const value = process.env.E2E_BUILD_WORKERS;
  if (!value) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error("E2E_BUILD_WORKERS must be a positive integer.");
  }
  return value;
}

function validate({ phase, platforms }) {
  if (platforms.includes("ios")) validateIosHost();
  for (const fixture of fixtures) {
    if (!existsSync(fixture)) throw new Error(`Missing E2E fixture: ${fixture}`);
  }
  if (phase === "test") {
    for (const platform of platforms) {
      const artifact = platform === "ios" ? iosBuildArtifact(root) : androidBuildArtifact(root);
      if (!existsSync(artifact)) {
        throw new Error(
          `Missing ${platform} build artifact: ${artifact}. Run the build phase first.`,
        );
      }
    }
  }
}

async function prebuild(platforms, cleanup) {
  const platform = platforms.length === 2 ? "all" : platforms[0];
  log("setup", `Generating clean native projects for ${platform}.`);
  await run("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", platform], {
    cleanup,
    cwd: root,
  });
}

async function build(platforms, cleanup) {
  await prebuild(platforms, cleanup);
  const workers = buildWorkers();
  for (const platform of platforms) {
    if (platform === "ios") await buildIos({ cleanup, root, workers });
    else await buildAndroid({ cleanup, root, workers });
  }
}

async function prepareDevice(platform, { artifactRoot, cleanup, deviceId }) {
  return platform === "ios"
    ? prepareIosDevice({ cleanup, externalDeviceId: deviceId })
    : prepareAndroidDevice({ artifactRoot, cleanup, externalDeviceId: deviceId });
}

async function installAndSeed(device, cleanup) {
  const options = { cleanup, device, fixtures, root };
  if (device.platform === "ios") await installAndSeedIos(options);
  else await installAndSeedAndroid(options);
}

async function test(platforms, { artifactRoot, cleanup, deviceId }) {
  await assertMetroPortAvailable();
  log("setup", `Preparing ${platforms.join(" + ")} test devices.`);
  const devices = await Promise.all(
    platforms.map((platform) => prepareDevice(platform, { artifactRoot, cleanup, deviceId })),
  );
  await Promise.all(devices.map((device) => installAndSeed(device, cleanup)));
  await startMetro({ artifactRoot, cleanup, root });

  for (const device of devices) {
    await warmUpApp({ artifactRoot, cleanup, device, root });
  }

  const results = await Promise.allSettled(
    devices.map((device) => runMaestroSuite({ artifactRoot, cleanup, device, root })),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${failures.length}/${devices.length} platform E2E suites failed.`,
    );
  }
  log("result", `All ${platforms.join(" + ")} E2E suites passed.`);
}

const options = parseArguments(process.argv.slice(2));
const cleanup = createCleanupManager();
const artifactRoot = createArtifactRoot();
installSignalHandlers(cleanup);

try {
  validate(options);
  log("setup", `Running ${options.target} E2E ${options.phase} phase; artifacts: ${artifactRoot}`);
  if (options.phase === "all" || options.phase === "build") {
    await build(options.platforms, cleanup);
  }
  if (options.phase === "all" || options.phase === "test") {
    await test(options.platforms, {
      artifactRoot,
      cleanup,
      deviceId: options.deviceId,
    });
  }
} catch (error) {
  console.error(`[e2e:error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup.run();
}
