import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import measurementPaths from "./render-measurement-paths.cjs";
import { createRenderVerificationReceipt, runRenderMeasurement } from "./render-measurement.mjs";

const { defaultRenderMeasurementRoot, resolveRenderMeasurementOutputDirectory } = measurementPaths;

test("receipt binds successful render verification to commit, lockfile, and completion time", () => {
  assert.deepEqual(
    createRenderVerificationReceipt({
      commit: "a".repeat(40),
      lockfileBytes: Buffer.from("lockfile"),
      completedAt: "2026-08-04T10:00:00.000Z",
    }),
    {
      schemaVersion: 1,
      verificationCommand: "pnpm test:render",
      commit: "a".repeat(40),
      lockfileSha256: "d6f5483103ee386e1f3453bff6da949b7d95fe942218d3774a449e38bbd9317f",
      completedAt: "2026-08-04T10:00:00.000Z",
    },
  );
});

test("measurement paths use a noindex root while preserving the exact directory override", () => {
  const root = join(tmpdir(), "plogkit-render-path-seam");
  const defaultRoot = join(root, "artifacts", "render-measurements.noindex");
  const exactDirectory = join(root, "exact-output.noindex");

  assert.equal(defaultRenderMeasurementRoot(root), defaultRoot);
  assert.equal(
    resolveRenderMeasurementOutputDirectory({ root, runId: "run-id", environment: {} }),
    join(defaultRoot, "run-id"),
  );
  assert.equal(
    resolveRenderMeasurementOutputDirectory({
      root,
      runId: "run-id",
      environment: { PLOGKIT_RENDER_MEASUREMENT_ROOT: join(root, "child-root.noindex") },
    }),
    join(root, "child-root.noindex", "run-id"),
  );
  assert.equal(
    resolveRenderMeasurementOutputDirectory({
      root,
      runId: "ignored-run-id",
      environment: {
        PLOGKIT_RENDER_MEASUREMENT_DIR: exactDirectory,
        PLOGKIT_RENDER_MEASUREMENT_ROOT: join(root, "ignored-root.noindex"),
      },
    }),
    exactDirectory,
  );
});

test("standard runner verifies render correctness before injecting a temporary receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "plogkit-render-runner-"));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfile", "utf8");
  const calls = [];
  let receiptPath;
  let measurementEnvironment;
  try {
    const status = runRenderMeasurement({
      root,
      environment: { PLOGKIT_RENDER_MEASUREMENT_PROFILE: "smoke" },
      getCommit: () => "a".repeat(40),
      now: () => "2026-08-04T10:00:00.000Z",
      receiptSuffix: "test",
      runCommand: (command, args, options) => {
        calls.push({ command, args });
        if (args[0] === "exec") {
          measurementEnvironment = options.env;
          receiptPath = options.env.PLOGKIT_RENDER_VERIFICATION_RECEIPT;
          assert.equal(existsSync(receiptPath), true);
          assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).commit, "a".repeat(40));
        }
        return 0;
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(calls, [
      { command: "pnpm", args: ["test:render"] },
      {
        command: "pnpm",
        args: ["exec", "jest", "--config", "jest.render.measure.config.js", "--runInBand"],
      },
    ]);
    const expectedArtifactRoot = join(root, "artifacts", "render-measurements.noindex");
    assert.equal(
      receiptPath,
      join(expectedArtifactRoot, ".receipts", "render-verification-test.json"),
    );
    assert.equal(measurementEnvironment.PLOGKIT_RENDER_MEASUREMENT_ROOT, expectedArtifactRoot);
    assert.equal(measurementEnvironment.PLOGKIT_RENDER_MEASUREMENT_DIR, undefined);
    assert.equal(existsSync(receiptPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standard runner preserves an exact measurement directory override", () => {
  const root = mkdtempSync(join(tmpdir(), "plogkit-render-runner-override-"));
  const exactDirectory = join(root, "chosen-output.noindex");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfile", "utf8");
  let measurementEnvironment;
  try {
    const status = runRenderMeasurement({
      root,
      environment: { PLOGKIT_RENDER_MEASUREMENT_DIR: exactDirectory },
      getCommit: () => "a".repeat(40),
      receiptSuffix: "override",
      runCommand: (_command, args, options) => {
        if (args[0] === "exec") measurementEnvironment = options.env;
        return 0;
      },
    });

    assert.equal(status, 0);
    assert.equal(measurementEnvironment.PLOGKIT_RENDER_MEASUREMENT_DIR, exactDirectory);
    assert.equal(
      measurementEnvironment.PLOGKIT_RENDER_MEASUREMENT_ROOT,
      join(root, "artifacts", "render-measurements.noindex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed render verification prevents measurement execution", () => {
  const calls = [];
  const status = runRenderMeasurement({
    runCommand: (command, args) => {
      calls.push({ command, args });
      return 7;
    },
  });

  assert.equal(status, 7);
  assert.deepEqual(calls, [{ command: "pnpm", args: ["test:render"] }]);
});

test("repository identity drift during render verification prevents measurement", () => {
  const root = mkdtempSync(join(tmpdir(), "plogkit-render-runner-drift-"));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfile", "utf8");
  const commits = ["a".repeat(40), "b".repeat(40)];
  const calls = [];
  try {
    const status = runRenderMeasurement({
      root,
      getCommit: () => commits.shift(),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    });

    assert.equal(status, 1);
    assert.deepEqual(calls, [{ command: "pnpm", args: ["test:render"] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
