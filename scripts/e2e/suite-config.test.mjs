import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the Maestro workspace owns one complete fail-fast flow order", () => {
  const config = readFileSync(join(root, "e2e/config.yaml"), "utf8");
  const ordered = [...config.matchAll(/^    - ([a-z0-9-]+)$/gm)].map((match) => match[1]);
  const discovered = readdirSync(join(root, "e2e/flows"))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.replace(/\.yaml$/, ""));

  assert.match(config, /^  continueOnFailure: false$/m);
  assert.deepEqual([...ordered].sort(), [...discovered].sort());
  assert.equal(new Set(ordered).size, discovered.length);
  assert.equal(ordered.at(-1), "f04-export");
});
