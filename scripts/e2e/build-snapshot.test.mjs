import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import { captureBuildInputs, createRunSnapshot } from "./build-snapshot.mjs";

function fixtureRepository(t) {
  const root = createTemporaryTestDirectory(t, "plogkit-e2e-build-snapshot-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "build/\n.env\n.env*.local\n");
  writeFileSync(join(root, "app.ts"), "export const version = 1;\n");
  mkdirSync(join(root, "e2e", "fixtures"), { recursive: true });
  mkdirSync(join(root, "e2e", "flows"), { recursive: true });
  writeFileSync(join(root, "e2e", "fixtures", "portrait.jpg"), "portrait-v1");
  writeFileSync(join(root, "e2e", "fixtures", "landscape.jpg"), "landscape-v1");
  writeFileSync(join(root, "e2e", "flows", "f01-smoke.yaml"), "appId: fixture\n");
  execFileSync("git", ["add", ".gitignore", "app.ts", "e2e"], { cwd: root });

  const artifact = join(root, "build", "app.apk");
  const sidecar = join(root, "build", "index.android.bundle.map");
  const nativeSymbols = join(root, "build", "native-debug-symbols.zip");
  mkdirSync(join(root, "build"));
  writeFileSync(artifact, "release artifact v1");
  writeFileSync(sidecar, "release source map v1");
  writeFileSync(nativeSymbols, "release native symbols v1");
  return { artifact, nativeSymbols, root, sidecar };
}

test("a run snapshot atomically owns the exact build and Maestro inputs under artifactRoot", (t) => {
  const { artifact, nativeSymbols, root, sidecar } = fixtureRepository(t);
  const artifactRoot = createTemporaryTestDirectory(t, "plogkit-e2e-artifacts-");
  const repositorySha256 = captureBuildInputs(root);

  const snapshot = createRunSnapshot({
    artifactRoot,
    builds: [{ artifact, platform: "android", sidecars: [sidecar, nativeSymbols] }],
    repositorySha256,
    root,
  });
  writeFileSync(artifact, "concurrent build replacement");
  writeFileSync(sidecar, "concurrent source map replacement");
  writeFileSync(nativeSymbols, "concurrent native symbols replacement");
  writeFileSync(join(root, "e2e", "fixtures", "portrait.jpg"), "portrait-v2");

  const provenance = JSON.parse(readFileSync(snapshot.provenance, "utf8"));
  assert.equal(readFileSync(snapshot.artifacts.android, "utf8"), "release artifact v1");
  assert.equal(
    readFileSync(
      join(dirname(snapshot.provenance), provenance.builds.android.sidecars[0].path),
      "utf8",
    ),
    "release source map v1",
  );
  assert.equal(
    readFileSync(
      join(dirname(snapshot.provenance), provenance.builds.android.sidecars[1].path),
      "utf8",
    ),
    "release native symbols v1",
  );
  assert.equal(
    readFileSync(join(snapshot.e2eRoot, "fixtures", "portrait.jpg"), "utf8"),
    "portrait-v1",
  );
  assert.equal(snapshot.fixtures[0], join(snapshot.e2eRoot, "fixtures", "portrait.jpg"));
  assert.equal(snapshot.fixtures[1], join(snapshot.e2eRoot, "fixtures", "landscape.jpg"));

  assert.equal(provenance.repositorySha256, repositorySha256);
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.builds.android.artifact.path, `android/build/${basename(artifact)}`);
  assert.match(provenance.builds.android.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    provenance.builds.android.sidecars.map(({ path }) => path),
    [`android/build/${basename(sidecar)}`, `android/build/${basename(nativeSymbols)}`],
  );
  assert.match(provenance.builds.android.sidecars[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.builds.android.sidecars[1].sha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.e2eSha256, /^[a-f0-9]{64}$/);
});

test("a run snapshot rejects repository drift since the build started", (t) => {
  const { artifact, nativeSymbols, root, sidecar } = fixtureRepository(t);
  const artifactRoot = createTemporaryTestDirectory(t, "plogkit-e2e-artifacts-");
  const repositorySha256 = captureBuildInputs(root);
  writeFileSync(join(root, "app.ts"), "export const version = 2;\n");

  assert.throws(
    () =>
      createRunSnapshot({
        artifactRoot,
        builds: [{ artifact, platform: "android", sidecars: [sidecar, nativeSymbols] }],
        repositorySha256,
        root,
      }),
    /Repository inputs changed while the Release E2E run was in progress/,
  );
});

test("a run snapshot requires diagnostic sidecars", (t) => {
  const { artifact, root } = fixtureRepository(t);
  const artifactRoot = createTemporaryTestDirectory(t, "plogkit-e2e-artifacts-");
  const repositorySha256 = captureBuildInputs(root);

  assert.throws(
    () =>
      createRunSnapshot({
        artifactRoot,
        builds: [{ artifact, platform: "android", sidecars: [] }],
        repositorySha256,
        root,
      }),
    /android Release build requires at least one diagnostic sidecar/,
  );
  assert.deepEqual(readdirSync(artifactRoot), []);
});
