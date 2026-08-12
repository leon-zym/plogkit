import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import { createCleanupManager, finalizeE2eRun, publicE2eErrorText } from "./runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function createRunFixture(t) {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-artifact-lifecycle-");
  const artifactRoot = join(directory, "run-artifacts");
  mkdirSync(join(artifactRoot, "run-snapshot"), { recursive: true });
  writeFileSync(join(artifactRoot, "run-snapshot", "provenance.json"), "evidence\n");
  return artifactRoot;
}

test("preflight failure does not allocate an empty E2E artifact root", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-e2e-artifact-lifecycle-");
  const result = spawnSync(process.execPath, ["scripts/e2e/run.mjs", "ios"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: directory,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Maestro .* is required but was not found on PATH/);
  assert.equal(existsSync(join(directory, "plogkit-maestro")), false);
});

test("successful E2E finalization removes artifacts after owned resources are clean", async (t) => {
  const artifactRoot = createRunFixture(t);
  const cleanup = createCleanupManager();
  const events = [];
  cleanup.add(() => {
    assert.equal(existsSync(artifactRoot), true);
    events.push("resources-cleaned");
  });

  await finalizeE2eRun({ artifactRoot, cleanup });

  assert.deepEqual(events, ["resources-cleaned"]);
  assert.equal(existsSync(artifactRoot), false);
});

test("a signal observed during cleanup prevents successful artifact deletion", async (t) => {
  const artifactRoot = createRunFixture(t);
  const cleanup = createCleanupManager();
  let signalObserved = false;
  let publicationRan = false;
  cleanup.add(async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    signalObserved = true;
  });

  const removed = await finalizeE2eRun({
    artifactRoot,
    cleanup,
    commitSuccess: () => !signalObserved,
    publishFailureArtifacts: () => {
      publicationRan = true;
    },
  });

  assert.equal(removed, false);
  assert.equal(publicationRan, true);
  assert.equal(existsSync(artifactRoot), true);
});

test("failed E2E finalization cleans owned resources but retains its evidence", async (t) => {
  const artifactRoot = createRunFixture(t);
  const cleanup = createCleanupManager();
  const operationError = new Error("Maestro acceptance failed");
  let cleanupRan = false;
  let publicationRan = false;
  let removalAttempted = false;
  cleanup.add(() => {
    cleanupRan = true;
  });

  await assert.rejects(
    finalizeE2eRun({
      artifactRoot,
      cleanup,
      operationError,
      publishFailureArtifacts: () => {
        assert.equal(cleanupRan, true);
        publicationRan = true;
      },
      removeArtifactRoot: () => {
        removalAttempted = true;
      },
    }),
    (error) => error === operationError,
  );

  assert.equal(cleanupRan, true);
  assert.equal(publicationRan, true);
  assert.equal(removalAttempted, false);
  assert.equal(existsSync(artifactRoot), true);
});

test("cleanup failure retains the primary E2E error and its evidence", async (t) => {
  const artifactRoot = createRunFixture(t);
  const cleanup = createCleanupManager();
  const operationError = Object.assign(new Error("Device became unreachable during deviceInfo"), {
    code: "E2E_COMMAND_TIMEOUT",
    e2eStage: "ios-maestro-suite",
  });
  const cleanupError = new Error("simulator deletion failed");
  let removalAttempted = false;
  cleanup.add(() => {
    throw cleanupError;
  });

  await assert.rejects(
    finalizeE2eRun({
      artifactRoot,
      cleanup,
      operationError,
      removeArtifactRoot: () => {
        removalAttempted = true;
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, operationError);
      assert.deepEqual(error.errors, [operationError, cleanupError]);
      assert.equal(error.code, "E2E_COMMAND_TIMEOUT");
      assert.equal(error.e2eStage, "ios-maestro-suite");
      assert.equal(error.message, operationError.message);
      assert.equal(
        publicE2eErrorText(error),
        "[ios-maestro-suite] Device became unreachable during deviceInfo",
      );
      return true;
    },
  );

  assert.equal(removalAttempted, false);
  assert.equal(existsSync(artifactRoot), true);
});

test("failure publication errors never replace the primary E2E error", async (t) => {
  const artifactRoot = createRunFixture(t);
  const cleanup = createCleanupManager();
  const operationError = Object.assign(new Error("Maestro failed"), {
    code: "E2E_COMMAND_TIMEOUT",
    e2eStage: "ios-maestro-suite",
  });
  const publicationError = new Error("sanitized evidence publication failed");

  await assert.rejects(
    finalizeE2eRun({
      artifactRoot,
      cleanup,
      operationError,
      publishFailureArtifacts: () => {
        throw publicationError;
      },
    }),
    (error) => {
      assert.equal(error.cause, operationError);
      assert.deepEqual(error.errors, [operationError, publicationError]);
      assert.equal(error.message, operationError.message);
      assert.equal(error.code, operationError.code);
      assert.equal(error.e2eStage, operationError.e2eStage);
      return true;
    },
  );
});

test("artifact deletion failure fails the run after cleanup and retains evidence", async (t) => {
  const artifactRoot = createRunFixture(t);
  const cleanup = createCleanupManager();
  const deletionError = new Error("artifact deletion failed");
  let cleanupRan = false;
  cleanup.add(() => {
    cleanupRan = true;
  });

  await assert.rejects(
    finalizeE2eRun({
      artifactRoot,
      cleanup,
      removeArtifactRoot: () => {
        throw deletionError;
      },
    }),
    (error) => error === deletionError,
  );

  assert.equal(cleanupRan, true);
  assert.equal(existsSync(artifactRoot), true);
});
