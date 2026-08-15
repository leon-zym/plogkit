import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";

function updateHash(hash, label, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(`${label.length}:${label}:${buffer.length}:`);
  hash.update(buffer);
}

function updateHashFromFile(hash, label, path, bytes) {
  hash.update(`${label.length}:${label}:${bytes}:`);
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
}

export function hashPath(path) {
  if (!existsSync(path)) throw new Error(`Build or E2E input is missing: ${path}`);
  const hash = createHash("sha256");
  const visit = (entryPath, relativePath) => {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      updateHash(hash, `link:${relativePath}`, readlinkSync(entryPath));
      return;
    }
    if (stat.isDirectory()) {
      updateHash(hash, `mode:${relativePath}`, stat.mode & 0o777);
      updateHash(hash, "directory", relativePath);
      for (const entry of readdirSync(entryPath).sort()) {
        visit(join(entryPath, entry), relativePath ? join(relativePath, entry) : entry);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported build or E2E input: ${entryPath}`);
    updateHash(hash, `mode:${relativePath}`, stat.mode & 0o777);
    updateHashFromFile(hash, `file:${relativePath}`, entryPath, stat.size);
  };
  visit(path, "");
  return hash.digest("hex");
}

function repositoryFiles(root) {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to enumerate E2E build inputs: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

function repositoryFingerprint(root) {
  const hash = createHash("sha256");
  for (const path of repositoryFiles(root)) {
    const absolutePath = join(root, path);
    if (!existsSync(absolutePath)) {
      updateHash(hash, "missing", path);
      continue;
    }
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) updateHash(hash, `link:${path}`, readlinkSync(absolutePath));
    else if (stat.isFile()) {
      updateHash(hash, `mode:${path}`, stat.mode & 0o777);
      updateHashFromFile(hash, `file:${path}`, absolutePath, stat.size);
    } else throw new Error(`Unsupported repository build input: ${path}`);
  }
  return hash.digest("hex");
}

export function captureBuildInputs(root) {
  return repositoryFingerprint(root);
}

export function assertBuildInputsUnchanged({ repositorySha256, root }) {
  if (repositoryFingerprint(root) !== repositorySha256) {
    throw new Error("Repository inputs changed while the Release E2E run was in progress.");
  }
}

function copyVerified(source, destination, platform) {
  const expectedHash = hashPath(source);
  cpSync(source, destination, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  if (hashPath(destination) !== expectedHash || hashPath(source) !== expectedHash) {
    throw new Error(`The ${platform} Release build changed while its run snapshot was created.`);
  }
  return expectedHash;
}

function snapshotBuild({ build, stagingDirectory }) {
  const { artifact, platform, sidecars } = build;
  if (!Array.isArray(sidecars) || sidecars.length === 0) {
    throw new Error(`${platform} Release build requires at least one diagnostic sidecar.`);
  }
  const names = [artifact, ...sidecars].map((path) => basename(path));
  if (new Set(names).size !== names.length) {
    throw new Error(`${platform} Release build inputs have colliding snapshot names.`);
  }
  const buildDirectory = join(stagingDirectory, platform, "build");
  mkdirSync(buildDirectory, { recursive: true });
  const artifactPath = join(buildDirectory, basename(artifact));
  const artifactSha256 = copyVerified(artifact, artifactPath, platform);
  const stagedSidecars = sidecars.map((sidecar) => {
    const path = join(buildDirectory, basename(sidecar));
    return { path, sha256: copyVerified(sidecar, path, platform) };
  });
  return {
    artifact: artifactPath,
    provenance: {
      artifact: {
        path: relative(stagingDirectory, artifactPath),
        sha256: artifactSha256,
      },
      sidecars: stagedSidecars.map(({ path, sha256 }) => ({
        path: relative(stagingDirectory, path),
        sha256,
      })),
    },
  };
}

export function createRunSnapshot({ artifactRoot, builds, repositorySha256, root }) {
  if (!Array.isArray(builds) || builds.length === 0) {
    throw new Error("A Release E2E run snapshot requires at least one platform build.");
  }
  const platforms = builds.map(({ platform }) => platform);
  if (new Set(platforms).size !== platforms.length) {
    throw new Error("A Release E2E run snapshot cannot contain duplicate platforms.");
  }

  assertBuildInputsUnchanged({ repositorySha256, root });
  mkdirSync(artifactRoot, { recursive: true });
  const stagingDirectory = mkdtempSync(join(artifactRoot, ".run-snapshot-"));
  const snapshotDirectory = join(artifactRoot, basename(stagingDirectory).slice(1));
  try {
    const artifacts = {};
    const provenanceBuilds = {};
    for (const build of builds) {
      const snapshot = snapshotBuild({ build, stagingDirectory });
      artifacts[build.platform] = snapshot.artifact;
      provenanceBuilds[build.platform] = snapshot.provenance;
    }

    const e2eRoot = join(stagingDirectory, "e2e");
    cpSync(join(root, "e2e"), e2eRoot, {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    const provenance = join(stagingDirectory, "provenance.json");
    writeFileSync(
      provenance,
      `${JSON.stringify(
        {
          builds: provenanceBuilds,
          e2eSha256: hashPath(e2eRoot),
          repositorySha256,
          schemaVersion: 1,
        },
        null,
        2,
      )}\n`,
    );
    assertBuildInputsUnchanged({ repositorySha256, root });
    renameSync(stagingDirectory, snapshotDirectory);

    const rebase = (path) => join(snapshotDirectory, relative(stagingDirectory, path));
    const snapshotE2eRoot = rebase(e2eRoot);
    return {
      artifacts: Object.fromEntries(
        Object.entries(artifacts).map(([platform, path]) => [platform, rebase(path)]),
      ),
      e2eRoot: snapshotE2eRoot,
      fixtures: [
        join(snapshotE2eRoot, "fixtures", "portrait.jpg"),
        join(snapshotE2eRoot, "fixtures", "landscape.jpg"),
      ],
      provenance: rebase(provenance),
    };
  } catch (error) {
    rmSync(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}
