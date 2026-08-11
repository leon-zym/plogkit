import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resetIosPhotoPermissions } from "./ios.mjs";

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test("iOS F04 starts with both photo permission scopes undecided", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-photo-permissions-"));
  const binaries = join(directory, "bin");
  const commandLog = join(directory, "xcrun-commands.log");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_XCRUN_LOG"
`,
  );

  const previousPath = process.env.PATH;
  const previousLog = process.env.FAKE_XCRUN_LOG;
  process.env.PATH = `${binaries}:${previousPath}`;
  process.env.FAKE_XCRUN_LOG = commandLog;
  try {
    await resetIosPhotoPermissions({
      cleanup: { add() {} },
      device: { platform: "ios", deviceId: "00000000-0000-0000-0000-000000000001" },
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FAKE_XCRUN_LOG;
    else process.env.FAKE_XCRUN_LOG = previousLog;
  }

  assert.deepEqual(readFileSync(commandLog, "utf8").trim().split("\n"), [
    "simctl privacy 00000000-0000-0000-0000-000000000001 reset photos-add com.leonzym.plogkit",
    "simctl privacy 00000000-0000-0000-0000-000000000001 reset photos com.leonzym.plogkit",
  ]);
});
