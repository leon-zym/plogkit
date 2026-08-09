import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifierPath = join(dirname(fileURLToPath(import.meta.url)), "verify.mjs");

function writeFixtureFile(root, path, contents) {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function createRepository({ map, specs } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plogkit-spec-verification-"));
  const defaultSpecs = {
    "docs/specs/F01-example.md": `# F01 Example

- 状态：已实现

#### Scenario F01-S01: Implemented behavior

- GIVEN a supported input
- WHEN the user acts
- THEN the result is visible

#### Scenario F01-S02: Planned behavior

- 状态：已确认
- Issue：[Issue #1](https://github.com/leon-zym/plogkit/issues/1)
- GIVEN a future input
- WHEN the user acts
- THEN the future result is visible
`,
  };
  const defaultMap = {
    version: 1,
    scenarios: [
      {
        id: "F01-S01",
        evidence: [
          {
            level: "L2",
            file: "src/example/__tests__/behavior.test.ts",
            test: "shows the visible result",
          },
        ],
      },
    ],
  };

  for (const [path, contents] of Object.entries(specs ?? defaultSpecs)) {
    writeFixtureFile(root, path, contents);
  }
  writeFixtureFile(
    root,
    "docs/specs/verification-map.json",
    `${JSON.stringify(map ?? defaultMap, null, 2)}\n`,
  );
  writeFixtureFile(
    root,
    "src/example/__tests__/behavior.test.ts",
    'test("shows the visible result", () => {});\n',
  );

  return root;
}

function runVerifier(root) {
  return spawnSync(process.execPath, [verifierPath, root], {
    encoding: "utf8",
  });
}

function withRepository(options, assertion) {
  const root = createRepository(options);
  try {
    assertion(runVerifier(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts evidence for every implemented Scenario and ignores planned delivery", () => {
  withRepository({}, (result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified 2 Scenarios and 1 mappings/);
  });
});

test("rejects duplicate Scenario IDs", () => {
  withRepository(
    {
      specs: {
        "docs/specs/F01-example.md": `# F01 Example
- 状态：已实现
#### Scenario F01-S01: First behavior
- GIVEN one
- WHEN one
- THEN one
`,
        "docs/specs/F02-example.md": `# F02 Example
- 状态：已实现
#### Scenario F01-S01: Duplicate behavior
- GIVEN two
- WHEN two
- THEN two
`,
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /duplicate Scenario ID F01-S01/);
    },
  );
});

test("rejects an implemented Scenario without a mapping", () => {
  withRepository({ map: { version: 1, scenarios: [] } }, (result) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /F01-S01 is implemented but has no mapping/);
  });
});

test("rejects evidence that references a missing test file", () => {
  withRepository(
    {
      map: {
        version: 1,
        scenarios: [
          {
            id: "F01-S01",
            evidence: [
              {
                level: "L4",
                file: "e2e/flows/missing.yaml",
              },
            ],
          },
        ],
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /F01-S01 references missing file e2e\/flows\/missing\.yaml/);
    },
  );
});

test("rejects a mapping for a deleted Scenario", () => {
  withRepository(
    {
      map: {
        version: 1,
        scenarios: [
          {
            id: "F01-S01",
            evidence: [
              {
                level: "L2",
                file: "src/example/__tests__/behavior.test.ts",
              },
            ],
          },
          {
            id: "F01-S99",
            exception: {
              reason: "No stable device seam exists yet.",
              issue: "https://github.com/leon-zym/plogkit/issues/99",
            },
          },
        ],
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /mapping F01-S99 has no matching Spec Scenario/);
    },
  );
});

test("rejects an automation exception without a reason and PlogKit Issue", () => {
  withRepository(
    {
      map: {
        version: 1,
        scenarios: [{ id: "F01-S01", exception: {} }],
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /F01-S01 exception requires a reason/);
      assert.match(result.stderr, /F01-S01 exception requires a PlogKit Issue URL/);
    },
  );
});

test("rejects a Scenario heading without a stable ID", () => {
  withRepository(
    {
      specs: {
        "docs/specs/F01-example.md": `# F01 Example
- 状态：已实现
#### Scenario: Missing stable identity
- GIVEN one
- WHEN one
- THEN one
`,
      },
      map: { version: 1, scenarios: [] },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /has an invalid Scenario heading/);
    },
  );
});
