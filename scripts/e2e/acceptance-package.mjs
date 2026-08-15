import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { hashPath } from "./build-snapshot.mjs";

const schemaVersion = 1;
const manifestFilename = "acceptance-package.json";
const archiveFilename = "acceptance-package.tar";
const manifestMaxBytes = 64 * 1024;
const archiveListingMaxBytes = 4 * 1024 * 1024;
const archiveEntryLimit = 20000;

export function captureRepositoryCommit(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to identify the acceptance package commit: ${result.stderr}`);
  }
  const commitSha = result.stdout.trim();
  assertHex(commitSha, 20, "Acceptance package commit SHA");
  return commitSha;
}

function assertHex(value, bytes, label) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${label} must be a lowercase ${bytes * 2}-character hexadecimal digest.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function assertPayloadContained(root) {
  const resolvedRoot = realpathSync(root);
  const prefix = `${resolvedRoot}${sep}`;
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(path);
      } catch (error) {
        throw new Error(
          `Acceptance package payload symlink is unresolved: ${relative(root, path)}`,
          {
            cause: error,
          },
        );
      }
      if (target !== resolvedRoot && !target.startsWith(prefix)) {
        throw new Error(
          `Acceptance package payload symlink escapes its root: ${relative(root, path)}`,
        );
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (!stat.isFile()) {
      throw new Error(
        `Acceptance package payload contains an unsupported entry: ${relative(root, path)}`,
      );
    }
  };
  visit(root);
}

function runTar(args) {
  const result = spawnSync("tar", args, {
    encoding: "utf8",
    maxBuffer: archiveListingMaxBytes,
    timeout: 5 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Unable to process the sealed acceptance package archive: ${[result.stderr, result.stdout]
        .filter(Boolean)
        .join("\n")}`,
    );
  }
  return result.stdout;
}

function validateIdentity({ commitSha, contract, platform, repositorySha256 }) {
  assertHex(commitSha, 20, "Acceptance package commit SHA");
  assertHex(repositorySha256, 32, "Acceptance package repository SHA-256");
  if (platform !== "ios") {
    throw new Error(`Unsupported acceptance package platform: ${platform ?? "missing"}.`);
  }
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("Acceptance package execution contract must be an object.");
  }
}

function readManifest(packageDirectory) {
  const path = join(packageDirectory, manifestFilename);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Acceptance package manifest is missing: ${path}`);
  }
  if (statSync(path).size > manifestMaxBytes) {
    throw new Error(`Acceptance package manifest exceeds ${manifestMaxBytes} bytes.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SyntaxError(`Acceptance package manifest is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (manifest?.schemaVersion !== schemaVersion) {
    throw new Error(
      `Unsupported acceptance package schema version: ${manifest?.schemaVersion ?? "missing"}.`,
    );
  }
  validateIdentity({
    commitSha: manifest?.source?.commitSha,
    contract: manifest?.contract,
    platform: manifest?.platform,
    repositorySha256: manifest?.source?.repositorySha256,
  });
  if (
    manifest?.archive?.file !== archiveFilename ||
    !Number.isSafeInteger(manifest?.archive?.bytes) ||
    manifest.archive.bytes <= 0
  ) {
    throw new Error("Acceptance package archive metadata is invalid.");
  }
  assertHex(manifest.archive.sha256, 32, "Acceptance package archive SHA-256");
  if (
    typeof manifest?.payload?.directory !== "string" ||
    basename(manifest.payload.directory) !== manifest.payload.directory ||
    manifest.payload.directory.length === 0
  ) {
    throw new Error("Acceptance package payload directory is invalid.");
  }
  assertHex(manifest.payload.sha256, 32, "Acceptance package payload SHA-256");
  return manifest;
}

function assertExpectedIdentity(manifest, expected) {
  if (manifest.platform !== expected.platform) {
    throw new Error("Acceptance package platform does not match this acceptance run.");
  }
  if (manifest.source.commitSha !== expected.commitSha) {
    throw new Error("Acceptance package commit SHA does not match this checkout.");
  }
  if (manifest.source.repositorySha256 !== expected.repositorySha256) {
    throw new Error("Acceptance package repository fingerprint does not match this checkout.");
  }
  if (canonicalJson(manifest.contract) !== canonicalJson(expected.contract)) {
    throw new Error("Acceptance package execution contract does not match this test host.");
  }
}

function assertArchiveEntries(archive, payloadDirectory) {
  const entries = runTar(["-tf", archive]).split("\n").filter(Boolean);
  if (entries.length === 0 || entries.length > archiveEntryLimit) {
    throw new Error("Acceptance package archive has an invalid number of entries.");
  }
  for (const entry of entries) {
    if (entry.includes("\0") || isAbsolute(entry)) {
      throw new Error("Acceptance package archive contains an unsafe entry path.");
    }
    const segments = entry.split("/").filter(Boolean);
    if (segments[0] !== payloadDirectory || segments.some((segment) => segment === "..")) {
      throw new Error("Acceptance package archive escapes its declared payload directory.");
    }
  }
}

function resolveWithin(root, path, label) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    throw new Error(`${label} path is invalid.`);
  }
  const destination = resolve(root, path);
  const prefix = `${resolve(root)}${sep}`;
  if (!destination.startsWith(prefix)) throw new Error(`${label} path escapes the payload.`);
  return destination;
}

function snapshotFromPayload(payloadDirectory, manifest) {
  const provenancePath = join(payloadDirectory, "provenance.json");
  if (!existsSync(provenancePath) || !statSync(provenancePath).isFile()) {
    throw new Error("Acceptance package payload is missing provenance.json.");
  }
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  if (provenance.schemaVersion !== 1) {
    throw new Error(
      `Unsupported acceptance payload provenance version: ${provenance.schemaVersion ?? "missing"}.`,
    );
  }
  if (provenance.repositorySha256 !== manifest.source.repositorySha256) {
    throw new Error("Acceptance package payload provenance does not match its manifest.");
  }
  const build = provenance?.builds?.[manifest.platform];
  if (!build?.artifact?.path || !Array.isArray(build?.sidecars) || build.sidecars.length === 0) {
    throw new Error("Acceptance package payload does not contain the declared platform build.");
  }
  const artifact = resolveWithin(payloadDirectory, build.artifact.path, "Build artifact");
  const e2eRoot = resolveWithin(payloadDirectory, "e2e", "E2E root");
  const fixtures = [
    join(e2eRoot, "fixtures", "portrait.jpg"),
    join(e2eRoot, "fixtures", "landscape.jpg"),
  ];
  if (
    !existsSync(artifact) ||
    !existsSync(e2eRoot) ||
    !existsSync(join(e2eRoot, "config.yaml")) ||
    fixtures.some((fixture) => !existsSync(fixture))
  ) {
    throw new Error("Acceptance package payload is missing its app or E2E inputs.");
  }
  for (const sidecar of build.sidecars) {
    const sidecarPath = resolveWithin(payloadDirectory, sidecar?.path, "Build sidecar");
    if (!existsSync(sidecarPath)) {
      throw new Error("Acceptance package payload is missing a diagnostic sidecar.");
    }
  }
  return {
    artifacts: { [manifest.platform]: artifact },
    e2eRoot,
    fixtures,
    provenance: provenancePath,
  };
}

export function createAcceptancePackage({
  commitSha,
  contract,
  packageDirectory,
  platform,
  repositorySha256,
  snapshot,
}) {
  validateIdentity({ commitSha, contract, platform, repositorySha256 });
  if (existsSync(packageDirectory)) {
    throw new Error(`Acceptance package destination already exists: ${packageDirectory}`);
  }
  const payloadDirectory = dirname(snapshot?.provenance ?? "");
  if (
    !payloadDirectory ||
    !existsSync(payloadDirectory) ||
    !lstatSync(payloadDirectory).isDirectory()
  ) {
    throw new Error("Acceptance package requires a completed run snapshot.");
  }
  const payloadName = basename(payloadDirectory);
  assertPayloadContained(payloadDirectory);
  const payloadSha256 = hashPath(payloadDirectory);
  mkdirSync(dirname(packageDirectory), { recursive: true });
  const stagingDirectory = mkdtempSync(join(dirname(packageDirectory), ".acceptance-package-"));
  try {
    const archive = join(stagingDirectory, archiveFilename);
    runTar(["-cf", archive, "-C", dirname(payloadDirectory), payloadName]);
    const archiveBytes = statSync(archive).size;
    const manifest = join(stagingDirectory, manifestFilename);
    writeFileSync(
      manifest,
      `${JSON.stringify(
        {
          archive: {
            bytes: archiveBytes,
            file: archiveFilename,
            sha256: sha256File(archive),
          },
          contract,
          payload: { directory: payloadName, sha256: payloadSha256 },
          platform,
          schemaVersion,
          source: { commitSha, repositorySha256 },
        },
        null,
        2,
      )}\n`,
    );
    renameSync(stagingDirectory, packageDirectory);
    return {
      archive: join(packageDirectory, archiveFilename),
      manifest: join(packageDirectory, manifestFilename),
    };
  } catch (error) {
    rmSync(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

export function loadAcceptancePackage({
  commitSha,
  contract,
  extractionRoot,
  packageDirectory,
  platform,
  repositorySha256,
}) {
  validateIdentity({ commitSha, contract, platform, repositorySha256 });
  const manifest = readManifest(packageDirectory);
  assertExpectedIdentity(manifest, { commitSha, contract, platform, repositorySha256 });
  const archive = join(packageDirectory, archiveFilename);
  if (!existsSync(archive) || !statSync(archive).isFile()) {
    throw new Error(`Acceptance package archive is missing: ${archive}`);
  }
  if (
    statSync(archive).size !== manifest.archive.bytes ||
    sha256File(archive) !== manifest.archive.sha256
  ) {
    throw new Error("Acceptance package archive hash does not match its manifest.");
  }
  assertArchiveEntries(archive, manifest.payload.directory);
  mkdirSync(extractionRoot, { recursive: true });
  const stagingDirectory = mkdtempSync(join(extractionRoot, ".acceptance-payload-"));
  try {
    runTar(["-xf", archive, "-C", stagingDirectory]);
    const payloadDirectory = join(stagingDirectory, manifest.payload.directory);
    assertPayloadContained(payloadDirectory);
    if (hashPath(payloadDirectory) !== manifest.payload.sha256) {
      throw new Error("Acceptance package payload hash does not match its manifest.");
    }
    return snapshotFromPayload(payloadDirectory, manifest);
  } catch (error) {
    rmSync(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}
