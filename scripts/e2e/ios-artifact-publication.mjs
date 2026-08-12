import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { publicE2eErrorText } from "./runtime.mjs";

const MAXIMUM_FILES = 256;
const MAXIMUM_SCAN_ENTRIES = 1024;
const MAXIMUM_SCAN_DEPTH = 24;
const MAXIMUM_READ_BYTES = 48 * 1024 * 1024;
const MAXIMUM_TEXT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_IMAGE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RETAINED_PNG_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const TEXT_EXTENSIONS = new Set([
  ".crash",
  ".diag",
  ".html",
  ".ips",
  ".json",
  ".log",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const TOP_LEVEL_IOS_EVIDENCE = new Set(["ios-host-lifecycle.log", "ios-prepare.log"]);

function pathIsInside(parent, child) {
  const offset = relative(parent, child);
  return offset !== "" && offset !== ".." && !offset.startsWith(`..${sep}`);
}

function assertSeparateRoots(sourceRoot, publicationRoot) {
  if (
    sourceRoot === publicationRoot ||
    pathIsInside(sourceRoot, publicationRoot) ||
    pathIsInside(publicationRoot, sourceRoot)
  ) {
    throw new Error("Private and published E2E artifact roots must not overlap.");
  }
}

export function assertSeparateIosArtifactRoots({ publicationRoot, sourceRoot }) {
  const configuredPrivateRoot = resolve(sourceRoot);
  const configuredPublicRoot = resolve(publicationRoot);
  mkdirSync(configuredPublicRoot, { recursive: true });
  const privateRoot = realpathSync(configuredPrivateRoot);
  const publicRoot = realpathSync(configuredPublicRoot);
  assertSeparateRoots(privateRoot, publicRoot);
  return { privateRoot, publicRoot };
}

function listRegularFiles(root, summary) {
  if (!existsSync(root)) return [];
  const files = [];
  let scannedEntries = 0;
  const visit = (directory, relativeDirectory = "", depth = 0) => {
    const handle = opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        scannedEntries += 1;
        if (scannedEntries > MAXIMUM_SCAN_ENTRIES) {
          summary.complete = false;
          summary.omitted.overLimit += 1;
          return;
        }
        const source = join(directory, entry.name);
        const target = join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          if (depth >= MAXIMUM_SCAN_DEPTH) {
            summary.complete = false;
            summary.omitted.overLimit += 1;
          } else {
            visit(source, target, depth + 1);
          }
        } else if (entry.isFile() && !lstatSync(source).isSymbolicLink()) {
          files.push({ source, target });
        }
        if (scannedEntries > MAXIMUM_SCAN_ENTRIES) return;
      }
    } finally {
      handle.closeSync();
    }
  };
  visit(root);
  return files.sort((left, right) => left.target.localeCompare(right.target));
}

function sanitizeJsonValue(value) {
  if (typeof value === "string") return publicE2eErrorText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        publicE2eErrorText(name),
        sanitizeJsonValue(child),
      ]),
    );
  }
  return value;
}

function crc32(body) {
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sanitizePng(body) {
  if (
    body.length < PNG_SIGNATURE.length + 12 ||
    !body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return null;
  }
  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let sawImageData = false;
  const retainedChunks = [PNG_SIGNATURE];
  while (offset + 12 <= body.length && chunks < 1024) {
    const dataLength = body.readUInt32BE(offset);
    const type = body.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + dataLength;
    if (end > body.length) return null;
    const chunkBody = body.subarray(offset + 4, offset + 8 + dataLength);
    if (crc32(chunkBody) !== body.readUInt32BE(offset + 8 + dataLength)) return null;
    if (chunks === 0) {
      if (type !== "IHDR" || dataLength !== 13) return null;
      const width = body.readUInt32BE(offset + 8);
      const height = body.readUInt32BE(offset + 12);
      if (width === 0 || height === 0) return null;
    }
    if (/^[A-Z]/.test(type) && !RETAINED_PNG_CHUNKS.has(type)) return null;
    if (type === "IDAT") sawImageData = true;
    if (RETAINED_PNG_CHUNKS.has(type)) {
      retainedChunks.push(body.subarray(offset, end));
    }
    chunks += 1;
    offset = end;
    if (type === "IEND") {
      if (dataLength !== 0 || offset !== body.length || !sawImageData) return null;
      return Buffer.concat(retainedChunks);
    }
  }
  return null;
}

function decodePublicText(body, extension) {
  if (body.includes(0)) return null;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (extension === ".json") {
      try {
        return `${JSON.stringify(sanitizeJsonValue(JSON.parse(source)), null, 2)}\n`;
      } catch {
        // Truncated third-party JSON remains useful as bounded sanitized text.
      }
    }
    return publicE2eErrorText(source);
  } catch {
    return null;
  }
}

function createSummary() {
  return {
    complete: true,
    filesPublished: 0,
    omitted: { overLimit: 0, readFailure: 0, unsupported: 0 },
    truncatedFiles: 0,
  };
}

function writePublishedFile(stagingRoot, relativePath, body, summary, state) {
  if (
    summary.filesPublished >= MAXIMUM_FILES ||
    state.totalBytes + body.length > MAXIMUM_TOTAL_BYTES
  ) {
    summary.complete = false;
    summary.omitted.overLimit += 1;
    return;
  }
  const target = join(stagingRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  state.totalBytes += body.length;
  summary.filesPublished += 1;
}

function readTextEvidence(source, size, summary) {
  if (size <= MAXIMUM_TEXT_BYTES) return readFileSync(source);
  const marker = Buffer.from("\n... published evidence bytes omitted ...\n");
  const headBytes = Math.floor((MAXIMUM_TEXT_BYTES - marker.length) / 2);
  const tailBytes = MAXIMUM_TEXT_BYTES - marker.length - headBytes;
  const head = Buffer.alloc(headBytes);
  const tail = Buffer.alloc(tailBytes);
  const descriptor = openSync(source, "r");
  try {
    readSync(descriptor, head, 0, head.length, 0);
    readSync(descriptor, tail, 0, tail.length, Math.max(0, size - tail.length));
  } finally {
    closeSync(descriptor);
  }
  summary.complete = false;
  summary.truncatedFiles += 1;
  return Buffer.concat([head, marker, tail]);
}

function publishCandidate(candidate, stagingRoot, summary, state) {
  let size;
  try {
    size = statSync(candidate.source).size;
  } catch {
    summary.complete = false;
    summary.omitted.readFailure += 1;
    return;
  }

  const extension = extname(candidate.target).toLowerCase();
  if (extension !== ".png" && !TEXT_EXTENSIONS.has(extension)) {
    summary.complete = false;
    summary.omitted.unsupported += 1;
    return;
  }
  if (extension === ".png" && size > MAXIMUM_IMAGE_BYTES) {
    summary.complete = false;
    summary.omitted.overLimit += 1;
    return;
  }
  const readBytes = extension === ".png" ? size : Math.min(size, MAXIMUM_TEXT_BYTES);
  if (state.readBytes + readBytes > MAXIMUM_READ_BYTES) {
    summary.complete = false;
    summary.omitted.overLimit += 1;
    return;
  }
  state.readBytes += readBytes;

  let body;
  try {
    body =
      extension === ".png"
        ? readFileSync(candidate.source)
        : readTextEvidence(candidate.source, size, summary);
  } catch {
    summary.complete = false;
    summary.omitted.readFailure += 1;
    return;
  }

  if (extension === ".png") {
    const sanitizedPng = sanitizePng(body);
    if (sanitizedPng === null) {
      summary.complete = false;
      summary.omitted.unsupported += 1;
      return;
    }
    writePublishedFile(stagingRoot, candidate.target, sanitizedPng, summary, state);
    return;
  }
  const publicText = decodePublicText(body, extension);
  if (publicText === null) {
    summary.complete = false;
    summary.omitted.unsupported += 1;
    return;
  }
  writePublishedFile(stagingRoot, candidate.target, Buffer.from(publicText), summary, state);
}

export function publishIosFailureArtifacts({ publicationRoot, sourceRoot }) {
  const configuredPublicRoot = resolve(publicationRoot);
  const { privateRoot, publicRoot } = assertSeparateIosArtifactRoots({
    publicationRoot,
    sourceRoot,
  });

  const destination = join(publicRoot, basename(privateRoot));
  const configuredDestination = join(configuredPublicRoot, basename(privateRoot));
  if (existsSync(destination))
    throw new Error("The sanitized iOS artifact destination already exists.");
  const stagingRoot = join(publicRoot, `.ios-publication-${randomUUID()}`);
  mkdirSync(stagingRoot);

  const summary = createSummary();
  const state = { readBytes: 0, totalBytes: 0 };
  try {
    const candidates = listRegularFiles(join(privateRoot, "ios"), summary).map(
      ({ source, target }) => ({
        source,
        target: join("ios", target),
      }),
    );
    for (const name of TOP_LEVEL_IOS_EVIDENCE) {
      const source = join(privateRoot, name);
      if (existsSync(source)) {
        const sourceState = lstatSync(source);
        if (sourceState.isFile() && !sourceState.isSymbolicLink()) {
          candidates.push({ source, target: name });
        }
      }
    }
    for (const candidate of candidates) {
      if (
        summary.filesPublished >= MAXIMUM_FILES ||
        state.totalBytes >= MAXIMUM_TOTAL_BYTES ||
        state.readBytes >= MAXIMUM_READ_BYTES
      ) {
        summary.complete = false;
        summary.omitted.overLimit += 1;
        break;
      }
      publishCandidate(candidate, stagingRoot, summary, state);
    }
    writeFileSync(join(stagingRoot, "publication-summary.json"), `${JSON.stringify(summary)}\n`);
    renameSync(stagingRoot, destination);
    return configuredDestination;
  } catch (error) {
    rmSync(stagingRoot, { force: true, recursive: true });
    throw error;
  }
}
