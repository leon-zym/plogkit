import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTemporaryTestDirectory } from "./temp-directory.mjs";

test("temporary test directories are removed when their test finishes", (t) => {
  const root = createTemporaryTestDirectory(t, "plogkit-test-temp-lifecycle-");
  const childTmp = join(root, "tmp");
  const childTest = join(root, "child.test.mjs");
  mkdirSync(childTmp);
  writeFileSync(
    childTest,
    `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTemporaryTestDirectory } from ${JSON.stringify(
      pathToFileURL(fileURLToPath(new URL("./temp-directory.mjs", import.meta.url))).href,
    )};

test("uses a temporary directory", (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-child-test-");
  writeFileSync(join(directory, "fixture.txt"), "fixture");
});
`,
  );

  const result = spawnSync(process.execPath, ["--test", childTest], {
    encoding: "utf8",
    env: {
      ...process.env,
      TEMP: childTmp,
      TMP: childTmp,
      TMPDIR: `${childTmp}/`,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readdirSync(childTmp), []);
});
