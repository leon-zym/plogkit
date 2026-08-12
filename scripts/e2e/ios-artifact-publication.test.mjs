import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import { publishIosFailureArtifacts } from "./ios-artifact-publication.mjs";

const PNG_SIGNATURE_FOR_TEST = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function filesBelow(directory, relativeDirectory = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    return entry.isDirectory()
      ? filesBelow(join(directory, entry.name), relativePath)
      : [relativePath];
  });
}

test("iOS failure publication exposes only bounded sanitized evidence", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-publication-");
  const sourceRoot = join(directory, "private", "run-id");
  const flowRoot = join(sourceRoot, "ios", "flows", "failed-flow");
  const publicationRoot = join(directory, "public");
  mkdirSync(flowRoot, { recursive: true });
  mkdirSync(join(sourceRoot, "run-snapshot", "ios", "build"), { recursive: true });

  const privatePath = "/Users/runner/Library/Developer/CoreSimulator/private.log";
  const escapedPrivatePath = String.raw`\/Users\/runner\/Library\/private.json`;
  const privateEndpoint = "http://127.0.0.1:4312/private-token";
  writeFileSync(
    join(flowRoot, "commands.json"),
    `${JSON.stringify({
      environment: { PLOGKIT_EXPORT_ASSERTION_URL: privateEndpoint },
      path: escapedPrivatePath,
      semanticSelector: "Done",
      [privatePath]: "private key",
    })}\n`,
  );
  writeFileSync(
    join(flowRoot, "device-simulator.log"),
    `${privatePath}\nendpoint=${privateEndpoint}\ndriver=<127.0.0.1> localhost:53168\n` +
      "original error: Command failed (1): /usr/bin/xcrun simctl boot PRIVATE-UDID\n" +
      "PXGGridLayout-Info\n",
  );
  writeFileSync(
    join(flowRoot, "screen.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAQdEVYdHByaXZhdGUgbWV0YWRhdGFCmI1eAAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  writeFileSync(
    join(flowRoot, "forged.png"),
    Buffer.concat([PNG_SIGNATURE_FOR_TEST, Buffer.from("not a PNG")]),
  );
  writeFileSync(
    join(flowRoot, "large.log"),
    `HEAD ${privatePath}\n${"x".repeat(3 * 1024 * 1024)}\nTAIL ${privateEndpoint}`,
  );
  writeFileSync(join(flowRoot, "binary.diag"), Buffer.from([0x00, 0xff, 0x00, 0xfe]));
  const outsideSecret = join(directory, "outside-secret.txt");
  writeFileSync(outsideSecret, "API_KEY=private\n");
  symlinkSync(outsideSecret, join(sourceRoot, "ios-host-lifecycle.log"));
  writeFileSync(
    join(sourceRoot, "run-snapshot", "ios", "build", "private-binary"),
    Buffer.from(privatePath),
  );

  const destination = publishIosFailureArtifacts({ publicationRoot, sourceRoot });

  assert.equal(destination, join(publicationRoot, "run-id"));
  assert.equal(existsSync(join(destination, "run-snapshot")), false);
  assert.equal(existsSync(join(destination, "ios-host-lifecycle.log")), false);
  assert.equal(existsSync(join(destination, "ios", "flows", "failed-flow", "binary.diag")), false);
  assert.equal(existsSync(join(destination, "ios", "flows", "failed-flow", "forged.png")), false);
  const publishedPng = readFileSync(join(destination, "ios", "flows", "failed-flow", "screen.png"));
  assert.notDeepEqual(publishedPng, readFileSync(join(flowRoot, "screen.png")));
  assert.doesNotMatch(publishedPng.toString("latin1"), /tEXt|private metadata/);
  const largeLog = readFileSync(join(destination, "ios", "flows", "failed-flow", "large.log"));
  assert.ok(largeLog.length <= 2 * 1024 * 1024);
  assert.match(largeLog.toString("utf8"), /^HEAD <PRIVATE_PATH>/);
  assert.match(largeLog.toString("utf8"), /published evidence bytes omitted/);
  assert.match(largeLog.toString("utf8"), /TAIL <LOOPBACK_ENDPOINT>$/);

  const publishedText = filesBelow(destination)
    .filter((path) => !path.endsWith(".png"))
    .map((path) => readFileSync(join(destination, path), "utf8"))
    .join("\n");
  assert.match(publishedText, /Done|PXGGridLayout-Info/);
  assert.match(publishedText, /<PRIVATE_PATH>|<LOOPBACK_ENDPOINT>/);
  assert.doesNotMatch(
    publishedText,
    /Users|127\.0\.0\.1|localhost|private-token|PRIVATE-UDID|PLOGKIT_EXPORT_ASSERTION_URL.*http/,
  );
  const summary = JSON.parse(readFileSync(join(destination, "publication-summary.json"), "utf8"));
  assert.equal(summary.complete, false);
  assert.equal(summary.omitted.unsupported, 2);
  assert.equal(summary.truncatedFiles, 1);

  assert.match(readFileSync(join(flowRoot, "device-simulator.log"), "utf8"), /Users\/runner/);
});

test("iOS failure publication rejects a symlinked public root inside private evidence", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-publication-root-");
  const sourceRoot = join(directory, "private", "run-id");
  const nestedPublicRoot = join(sourceRoot, "nested-public");
  const publicAlias = join(directory, "public-alias");
  mkdirSync(join(sourceRoot, "ios"), { recursive: true });
  mkdirSync(nestedPublicRoot);
  symlinkSync(nestedPublicRoot, publicAlias);

  assert.throws(
    () => publishIosFailureArtifacts({ publicationRoot: publicAlias, sourceRoot }),
    /must not overlap/,
  );
});

test("iOS failure publication stops at its scan and file budgets", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-publication-budget-");
  const sourceRoot = join(directory, "private", "run-id");
  const flowRoot = join(sourceRoot, "ios", "flows", "many-files");
  const publicationRoot = join(directory, "public");
  mkdirSync(flowRoot, { recursive: true });
  for (let index = 0; index < 1030; index += 1) {
    writeFileSync(join(flowRoot, `${String(index).padStart(4, "0")}.log`), "bounded\n");
  }

  const destination = publishIosFailureArtifacts({ publicationRoot, sourceRoot });
  const summary = JSON.parse(readFileSync(join(destination, "publication-summary.json"), "utf8"));
  const publishedLogs = filesBelow(destination).filter((path) => path.endsWith(".log"));

  assert.equal(summary.complete, false);
  assert.equal(summary.omitted.overLimit, 2);
  assert.equal(summary.filesPublished, 256);
  assert.equal(publishedLogs.length, summary.filesPublished);
});
