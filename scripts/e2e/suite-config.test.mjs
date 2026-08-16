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

test("every targeted flow enters the canonical launch readiness path", () => {
  const flows = readdirSync(join(root, "e2e/flows"))
    .filter((name) => name.endsWith(".yaml"))
    .sort();

  for (const file of flows) {
    const source = readFileSync(join(root, "e2e/flows", file), "utf8");
    const commands = source.split(/^---\s*$/m)[1]?.trimStart() ?? "";
    assert.match(
      commands,
      /^- runFlow: \.\.\/subflows\/(?:import-two-photos|launch-app)\.yaml\n/,
      `${file} must enter the shared launch readiness path before business commands`,
    );
  }

  const importFlow = readFileSync(join(root, "e2e/subflows/import-two-photos.yaml"), "utf8");
  const importCommands = importFlow.split(/^---\s*$/m)[1]?.trimStart() ?? "";
  assert.match(importCommands, /^- runFlow: launch-app\.yaml\n/);
  const launchFlow = readFileSync(join(root, "e2e/subflows/launch-app.yaml"), "utf8");
  assert.match(launchFlow, /visible:\n {6}id: home-screen\n {4}timeout: 60000/);
});

test("direct lifecycle relaunches declare an empty permission override", () => {
  const flows = readdirSync(join(root, "e2e/flows"))
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  let relaunchCount = 0;

  for (const file of flows) {
    const lines = readFileSync(join(root, "e2e/flows", file), "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^-\s+launchApp\s*:\s*$/.test(lines[index])) continue;
      relaunchCount += 1;
      const block = [];
      for (const line of lines.slice(index + 1)) {
        if (/^-\s+/.test(line)) break;
        block.push(line);
      }
      assert.ok(
        block.some((line) => /^\s+permissions\s*:\s*\{\s*\}\s*$/.test(line)),
        `${file} direct lifecycle relaunch must declare permissions: {}`,
      );
    }
  }

  assert.ok(relaunchCount > 0, "the suite must exercise at least one direct lifecycle relaunch");
});

test("the export flow asserts the system photo delta after each successful export", () => {
  const source = readFileSync(join(root, "e2e/flows/f04-export.yaml"), "utf8");
  const successOffsets = [...source.matchAll(/^- assertVisible: Saved to Photos$/gm)].map(
    (match) => match.index,
  );
  const assertionCalls = [
    ...source.matchAll(
      /^- runScript:\n {4}file: \.\.\/scripts\/assert-export-photo\.js\n {4}env:\n {6}EXPORT_INDEX: "(\d+)"$/gm,
    ),
  ];

  assert.deepEqual(
    assertionCalls.map((match) => match[1]),
    ["1", "2"],
    "the export flow must assert exactly two ordered photo boundaries",
  );
  assert.equal(successOffsets.length, 2, "the export flow must expose two success boundaries");
  assert.ok(successOffsets[0] < assertionCalls[0].index);
  assert.ok(assertionCalls[0].index < successOffsets[1]);
  assert.ok(successOffsets[1] < assertionCalls[1].index);
});

test("text edit flows require the editor panel to close before their next assertion", () => {
  const commitSubflow = readFileSync(
    join(root, "e2e/subflows/scroll-and-apply-text-edits.yaml"),
    "utf8",
  );
  const addTextFlow = readFileSync(join(root, "e2e/flows/f01-add-text.yaml"), "utf8");
  const exportFlow = readFileSync(join(root, "e2e/flows/f04-export.yaml"), "utf8");

  assert.match(
    commitSubflow,
    /- tapOn:\n    id: commit-text\n- assertNotVisible:\n    id: commit-text/,
    "the shared text commit must prove that the editor panel closed",
  );
  assert.match(
    addTextFlow,
    /- runFlow: \.\.\/subflows\/scroll-and-apply-text-edits\.yaml\n- assertVisible:\n    id: canvas-text-hit-0-\.\*/,
  );
  assert.match(
    exportFlow,
    /- runFlow: \.\.\/subflows\/scroll-and-apply-text-edits\.yaml\n- tapOn:\n    id: editor-open-export/,
  );
  assert.doesNotMatch(addTextFlow, /- assertVisible: 周末的海边日记/);
  assert.doesNotMatch(exportFlow, /- assertVisible: "导出后更新 ✨"/);
});

test("the iOS picker waits for two interactive photos before selecting them", () => {
  const source = readFileSync(join(root, "e2e/subflows/select-two-photos-ios.yaml"), "utf8");
  const gridWait = source.indexOf("visible:\n      id: PXGGridLayout-Info");
  const firstTap = source.indexOf("id: PXGGridLayout-Info\n    index: 0");

  assert.ok(gridWait >= 0, "the picker must wait for the second fixture cell");
  assert.ok(gridWait < firstTap, "the loaded grid must precede photo selection");
  assert.match(
    source,
    /visible:\n {6}id: PXGGridLayout-Info\n {6}index: 1\n {6}enabled: true\n {4}timeout: 90000/,
  );
  assert.match(source, /- assertVisible: \^Done\$\n- tapOn: \^Done\$$/m);
  assert.doesNotMatch(source, /extendedWaitUntil:\n\s+visible: Done/);
  assert.doesNotMatch(source, /\bsleep\b|point:\s|\d+%,\s*\d+%/);
});
