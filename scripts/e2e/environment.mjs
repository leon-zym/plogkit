import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

export const requiredHostToolVersions = Object.freeze({
  javaRuntime: readFileSync(join(root, ".java-version"), "utf8").trim(),
  javaVendor: "Eclipse Adoptium",
  node: readFileSync(join(root, ".node-version"), "utf8").trim(),
  pnpm: packageJson.packageManager.replace(/^pnpm@/, ""),
});

export function assertHostToolVersions(actual) {
  const required = requiredHostToolVersions;
  const failures = [];
  if (actual.node !== required.node) {
    failures.push(`Node ${required.node} is required, but ${actual.node} is running.`);
  }
  if (actual.pnpm !== required.pnpm) {
    failures.push(`pnpm ${required.pnpm} is required, but ${actual.pnpm} is installed.`);
  }
  if (actual.javaRuntime !== required.javaRuntime || actual.javaVendor !== required.javaVendor) {
    failures.push(
      `Temurin ${required.javaRuntime} is required, but ${actual.javaVendor} ` +
        `${actual.javaRuntime} is installed.`,
    );
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

const STANDALONE_BUILD_ENVIRONMENT_ALLOWLIST = [
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "DEVELOPER_DIR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
];

export function createStandaloneBuildEnvironment(environment = process.env) {
  const result = {};
  for (const name of STANDALONE_BUILD_ENVIRONMENT_ALLOWLIST) {
    if (environment[name] !== undefined) result[name] = environment[name];
  }
  result.PATH = [dirname(process.execPath), environment.PATH].filter(Boolean).join(delimiter);
  result.CI = "1";
  result.EXPO_NO_DOTENV = "1";
  result.NODE_ENV = "production";
  return result;
}

export function createMaestroEnvironment(environment = process.env) {
  return {
    ...createStandaloneBuildEnvironment(environment),
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
    MAESTRO_CLI_NO_ANALYTICS: "true",
    MAESTRO_DISABLE_UPDATE_CHECK: "true",
  };
}

const HERMES_BYTECODE_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

export function isHermesBytecode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return (
    buffer.length >= HERMES_BYTECODE_MAGIC.length &&
    buffer.subarray(0, HERMES_BYTECODE_MAGIC.length).equals(HERMES_BYTECODE_MAGIC)
  );
}

function captureVersion(command, args, env) {
  const result = spawnSync(command, args, { encoding: "utf8", env, timeout: 15000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect ${command}: ${[result.stderr, result.stdout].filter(Boolean).join("\n")}`,
    );
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

export function validateHostEnvironment() {
  const childEnvironment = createStandaloneBuildEnvironment();
  const java = captureVersion("java", ["-XshowSettings:properties", "-version"], childEnvironment);
  const actual = {
    javaHome: java.match(/^\s*java\.home\s*=\s*(.+)$/m)?.[1]?.trim() ?? "unknown",
    javaRuntime: java.match(/^\s*java\.runtime\.version\s*=\s*(.+)$/m)?.[1]?.trim() ?? "unknown",
    javaVendor: java.match(/^\s*java\.vendor\s*=\s*(.+)$/m)?.[1]?.trim() ?? "unknown",
    node: process.versions.node,
    pnpm: captureVersion("pnpm", ["--version"], childEnvironment).split(/\s+/)[0],
  };
  assertHostToolVersions(actual);
  console.log(
    `[e2e:setup] Host toolchain: Node ${actual.node}; pnpm ${actual.pnpm}; ` +
      `${actual.javaVendor} ${actual.javaRuntime}.`,
  );
  return actual;
}
