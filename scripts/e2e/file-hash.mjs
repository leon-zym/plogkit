import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

export function updateHashWithFileContents(hash, path) {
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

export function sha256File(path) {
  const hash = createHash("sha256");
  updateHashWithFileContents(hash, path);
  return hash.digest("hex");
}
