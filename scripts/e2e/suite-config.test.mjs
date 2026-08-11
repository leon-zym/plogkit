import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readFlowOrder(config) {
  const lines = config.split("\n");
  const headings = lines.flatMap((line, index) => (line === "  flowsOrder:" ? [index] : []));
  assert.equal(headings.length, 1, "the workspace must declare exactly one flowsOrder list");

  const ordered = [];
  for (const line of lines.slice(headings[0] + 1)) {
    if (line.startsWith("    - ")) {
      const name = line.slice("    - ".length).trim();
      assert.notEqual(name, "", "flowsOrder entries must not be empty");
      ordered.push(name);
      continue;
    }
    if (line.startsWith("    #") || line.trim() === "") continue;
    if (!line.startsWith("    ")) break;
    assert.fail(`unsupported flowsOrder entry: ${line}`);
  }
  return ordered;
}

test("the Maestro workspace orders every top-level flow by its exact name and exports last", () => {
  const config = readFileSync(join(root, "e2e/config.yaml"), "utf8");
  const ordered = readFlowOrder(config);
  const flows = readdirSync(join(root, "e2e/flows"))
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const source = readFileSync(join(root, "e2e/flows", file), "utf8");
      const names = [...source.matchAll(/^name: (.+)$/gm)].map((match) => match[1].trim());
      assert.equal(names.length, 1, `${file} must declare exactly one top-level flow name`);
      assert.notEqual(names[0], "", `${file} must not declare an empty flow name`);
      return { file, name: names[0] };
    });
  const discoveredNames = flows.map(({ name }) => name);
  const exportFlow = flows.find(({ file }) => file === "f04-export.yaml");

  assert.match(config, /^  continueOnFailure: false$/m);
  assert.equal(
    new Set(discoveredNames).size,
    discoveredNames.length,
    "top-level Maestro flow names must be unique",
  );
  assert.deepEqual(
    [...ordered].sort(),
    [...discoveredNames].sort(),
    "flowsOrder must cover every top-level flow by its exact name",
  );
  assert.equal(new Set(ordered).size, ordered.length, "flowsOrder must not contain duplicates");
  assert.ok(exportFlow, "the export acceptance flow must exist");
  assert.equal(
    ordered.at(-1),
    exportFlow.name,
    "the system-photo-mutating export flow must run last",
  );
});
