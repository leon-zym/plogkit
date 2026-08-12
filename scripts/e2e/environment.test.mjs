import assert from "node:assert/strict";
import { delimiter, dirname } from "node:path";
import test from "node:test";

import {
  assertHostToolVersions,
  createMaestroEnvironment,
  createStandaloneBuildEnvironment,
  isHermesBytecode,
} from "./environment.mjs";

test("E2E host validation accepts only the repository-pinned toolchain", () => {
  assert.doesNotThrow(() =>
    assertHostToolVersions({
      javaRuntime: "17.0.20+8",
      javaVendor: "Eclipse Adoptium",
      node: "24.19.0",
      pnpm: "11.21.0",
    }),
  );

  assert.throws(
    () =>
      assertHostToolVersions({
        javaRuntime: "17.0.19+10",
        javaVendor: "Azul Systems, Inc.",
        node: "26.7.0",
        pnpm: "11.20.0",
      }),
    /Node 24\.19\.0 is required.*pnpm 11\.21\.0 is required.*Temurin 17\.0\.20\+8 is required/s,
  );
});

test("standalone builds ignore developer bundle overrides", () => {
  const environment = createStandaloneBuildEnvironment({
    BUNDLE_COMMAND: "custom-bundle",
    BUNDLE_CONFIG: "/tmp/custom-config.js",
    ENTRY_FILE: "wrong-entry.js",
    EXPO_NO_DOTENV: "0",
    EXTRA_PACKAGER_ARGS: "--dev true",
    HERMES_ENGINE_TARBALL_PATH: "/tmp/wrong-hermes.tgz",
    JAVA_HOME: "/tmp/wrong-jdk",
    ORG_GRADLE_PROJECT_hermesEnabled: "false",
    PATH: "/usr/bin",
    SKIP_BUNDLING: "1",
    USE_FRAMEWORKS: "dynamic",
  });

  assert.equal(environment.CI, "1");
  assert.equal(environment.EXPO_NO_DOTENV, "1");
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.JAVA_HOME, undefined);
  assert.equal(environment.PATH.startsWith(`${dirname(process.execPath)}${delimiter}`), true);
  assert.equal(environment.PATH.endsWith(`${delimiter}/usr/bin`), true);
});

test("Maestro uses the pinned Java path and the same offline contract locally and in CI", () => {
  const environment = createMaestroEnvironment({
    JAVA_HOME: "/tmp/wrong-jdk",
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "false",
    MAESTRO_CLI_NO_ANALYTICS: "false",
    MAESTRO_DISABLE_UPDATE_CHECK: "false",
    PATH: "/usr/bin",
  });

  assert.equal(environment.JAVA_HOME, undefined);
  assert.equal(environment.PATH.startsWith(`${dirname(process.execPath)}${delimiter}`), true);
  assert.equal(environment.MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED, "true");
  assert.equal(environment.MAESTRO_CLI_NO_ANALYTICS, "true");
  assert.equal(environment.MAESTRO_DISABLE_UPDATE_CHECK, "true");
});

test("standalone artifact validation recognizes only Hermes bytecode", () => {
  assert.equal(
    isHermesBytecode(Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f, 0x00])),
    true,
  );
  assert.equal(isHermesBytecode(Buffer.from("plain JavaScript bundle")), false);
});
