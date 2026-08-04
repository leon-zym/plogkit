import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import measurementPaths from "./render-measurement-paths.cjs";

const { defaultRenderMeasurementRoot } = measurementPaths;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function defaultRunCommand(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  return result.status ?? 1;
}

function defaultCommit(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("could not resolve render measurement commit");
  return result.stdout.trim();
}

export function createRenderVerificationReceipt({ commit, lockfileBytes, completedAt }) {
  return {
    schemaVersion: 1,
    verificationCommand: "pnpm test:render",
    commit,
    lockfileSha256: sha256(lockfileBytes),
    completedAt,
  };
}

export function runRenderMeasurement({
  root = ROOT,
  environment = process.env,
  runCommand = defaultRunCommand,
  getCommit = defaultCommit,
  now = () => new Date().toISOString(),
  receiptSuffix = `${process.pid}-${Date.now()}`,
} = {}) {
  const commitBeforeVerification = getCommit(root);
  const lockfileBeforeVerification = readFileSync(join(root, "pnpm-lock.yaml"));
  const verificationStatus = runCommand("pnpm", ["test:render"], { cwd: root, env: environment });
  if (verificationStatus !== 0) return verificationStatus;

  const commitAfterVerification = getCommit(root);
  const lockfileAfterVerification = readFileSync(join(root, "pnpm-lock.yaml"));
  if (
    commitBeforeVerification !== commitAfterVerification ||
    sha256(lockfileBeforeVerification) !== sha256(lockfileAfterVerification)
  ) {
    return 1;
  }

  const receipt = createRenderVerificationReceipt({
    commit: commitAfterVerification,
    lockfileBytes: lockfileAfterVerification,
    completedAt: now(),
  });
  const artifactRoot = defaultRenderMeasurementRoot(root);
  const receiptDirectory = join(artifactRoot, ".receipts");
  const receiptPath = join(receiptDirectory, `render-verification-${receiptSuffix}.json`);
  mkdirSync(receiptDirectory, { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  try {
    return runCommand(
      "pnpm",
      ["exec", "jest", "--config", "jest.render.measure.config.js", "--runInBand"],
      {
        cwd: root,
        env: {
          ...environment,
          PLOGKIT_RENDER_MEASUREMENT_ROOT: artifactRoot,
          PLOGKIT_RENDER_VERIFICATION_RECEIPT: receiptPath,
        },
      },
    );
  } finally {
    rmSync(receiptPath, { force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runRenderMeasurement();
}
