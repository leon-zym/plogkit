import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import { createAcceptancePackage, loadAcceptancePackage } from "./acceptance-package.mjs";
import { captureBuildInputs, createRunSnapshot } from "./build-snapshot.mjs";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const iosContract = Object.freeze({
  architecture: "x86_64",
  configuration: "Release",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  scheme: "PlogKit",
  sdk: "iphonesimulator",
  xcodeBuild: "17F113",
  xcodeVersion: "26.6",
});

function createSnapshotFixture(t) {
  const root = createTemporaryTestDirectory(t, "plogkit-acceptance-package-repository-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "build/\n");
  writeFileSync(join(root, "app.ts"), "export const version = 1;\n");
  mkdirSync(join(root, "e2e", "fixtures"), { recursive: true });
  mkdirSync(join(root, "e2e", "flows"), { recursive: true });
  writeFileSync(join(root, "e2e", "config.yaml"), "flows:\n  - flows/*\n");
  writeFileSync(join(root, "e2e", "fixtures", "portrait.jpg"), "portrait");
  writeFileSync(join(root, "e2e", "fixtures", "landscape.jpg"), "landscape");
  writeFileSync(join(root, "e2e", "flows", "f01-smoke.yaml"), "appId: fixture\n");
  execFileSync("git", ["add", ".gitignore", "app.ts", "e2e"], { cwd: root });

  const app = join(root, "build", "PlogKit.app");
  const symbols = join(root, "build", "PlogKit.app.dSYM");
  mkdirSync(app, { recursive: true });
  mkdirSync(symbols, { recursive: true });
  writeFileSync(join(app, "PlogKit"), "simulator executable");
  chmodSync(join(app, "PlogKit"), 0o755);
  writeFileSync(join(symbols, "symbols"), "symbols");

  const artifactRoot = createTemporaryTestDirectory(t, "plogkit-acceptance-package-artifacts-");
  const repositorySha256 = captureBuildInputs(root);
  const snapshot = createRunSnapshot({
    artifactRoot,
    builds: [{ artifact: app, platform: "ios", sidecars: [symbols] }],
    repositorySha256,
    root,
  });
  return { artifactRoot, repositorySha256, root, snapshot };
}

test("a sealed acceptance package round-trips the exact app, sidecars, flows, and fixtures", (t) => {
  const fixture = createSnapshotFixture(t);
  const packageDirectory = join(
    createTemporaryTestDirectory(t, "plogkit-acceptance-package-output-"),
    "ios-package",
  );
  const created = createAcceptancePackage({
    commitSha,
    contract: iosContract,
    packageDirectory,
    platform: "ios",
    repositorySha256: fixture.repositorySha256,
    snapshot: fixture.snapshot,
  });

  const manifest = JSON.parse(readFileSync(created.manifest, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, "ios");
  assert.equal(manifest.source.commitSha, commitSha);
  assert.equal(manifest.source.repositorySha256, fixture.repositorySha256);
  assert.deepEqual(manifest.contract, iosContract);
  assert.match(manifest.archive.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.archive.bytes > 0);
  assert.match(manifest.payload.sha256, /^[a-f0-9]{64}$/);

  const extractionRoot = createTemporaryTestDirectory(t, "plogkit-acceptance-package-extraction-");
  const loaded = loadAcceptancePackage({
    commitSha,
    contract: iosContract,
    extractionRoot,
    packageDirectory,
    platform: "ios",
    repositorySha256: fixture.repositorySha256,
  });

  assert.equal(readFileSync(join(loaded.artifacts.ios, "PlogKit"), "utf8"), "simulator executable");
  assert.notEqual(statSync(join(loaded.artifacts.ios, "PlogKit")).mode & 0o111, 0);
  assert.equal(readFileSync(loaded.fixtures[0], "utf8"), "portrait");
  assert.equal(readFileSync(loaded.fixtures[1], "utf8"), "landscape");
  assert.equal(
    readFileSync(join(loaded.e2eRoot, "flows", "f01-smoke.yaml"), "utf8"),
    "appId: fixture\n",
  );
  assert.equal(readFileSync(join(loaded.e2eRoot, "config.yaml"), "utf8"), "flows:\n  - flows/*\n");
});

test("a sealed acceptance package rejects archive mutation before extraction", (t) => {
  const fixture = createSnapshotFixture(t);
  const packageDirectory = join(
    createTemporaryTestDirectory(t, "plogkit-acceptance-package-output-"),
    "ios-package",
  );
  const created = createAcceptancePackage({
    commitSha,
    contract: iosContract,
    packageDirectory,
    platform: "ios",
    repositorySha256: fixture.repositorySha256,
    snapshot: fixture.snapshot,
  });
  writeFileSync(created.archive, "mutated archive");

  assert.throws(
    () =>
      loadAcceptancePackage({
        commitSha,
        contract: iosContract,
        extractionRoot: createTemporaryTestDirectory(t, "plogkit-acceptance-package-extraction-"),
        packageDirectory,
        platform: "ios",
        repositorySha256: fixture.repositorySha256,
      }),
    /acceptance package archive hash does not match/i,
  );
});

test("a sealed acceptance package rejects a different commit or execution contract", (t) => {
  const fixture = createSnapshotFixture(t);
  const packageDirectory = join(
    createTemporaryTestDirectory(t, "plogkit-acceptance-package-output-"),
    "ios-package",
  );
  createAcceptancePackage({
    commitSha,
    contract: iosContract,
    packageDirectory,
    platform: "ios",
    repositorySha256: fixture.repositorySha256,
    snapshot: fixture.snapshot,
  });

  const load = (overrides) =>
    loadAcceptancePackage({
      commitSha,
      contract: iosContract,
      extractionRoot: createTemporaryTestDirectory(t, "plogkit-acceptance-package-extraction-"),
      packageDirectory,
      platform: "ios",
      repositorySha256: fixture.repositorySha256,
      ...overrides,
    });
  assert.throws(
    () => load({ commitSha: "fedcba9876543210fedcba9876543210fedcba98" }),
    /commit SHA does not match/i,
  );
  assert.throws(
    () => load({ contract: { ...iosContract, architecture: "arm64" } }),
    /execution contract does not match/i,
  );
});

test("a sealed acceptance package rejects a payload symlink that escapes its root", (t) => {
  const fixture = createSnapshotFixture(t);
  symlinkSync("../../../../outside", join(fixture.snapshot.e2eRoot, "flows", "escape.yaml"));

  assert.throws(
    () =>
      createAcceptancePackage({
        commitSha,
        contract: iosContract,
        packageDirectory: join(
          createTemporaryTestDirectory(t, "plogkit-acceptance-package-output-"),
          "ios-package",
        ),
        platform: "ios",
        repositorySha256: fixture.repositorySha256,
        snapshot: fixture.snapshot,
      }),
    /payload symlink.*outside|payload symlink.*escape/i,
  );
});
