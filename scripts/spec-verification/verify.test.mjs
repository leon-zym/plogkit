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

function createRepository({ files, specs } = {}) {
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
  const defaultFiles = {
    "src/example/__tests__/behavior.test.ts":
      'test("[F01-S01] shows the visible result", () => {});\n',
  };

  for (const [path, contents] of Object.entries(specs ?? defaultSpecs)) {
    writeFixtureFile(root, path, contents);
  }
  for (const [path, contents] of Object.entries(files ?? defaultFiles)) {
    writeFixtureFile(root, path, contents);
  }

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

test("accepts native test evidence for every implemented Scenario and ignores planned delivery", () => {
  withRepository({}, (result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /verified 2 Scenarios; 1 implemented with 1 bindings \(L2 1, L3 0, L4 0\)/,
    );
  });
});

test("accepts multiple Scenario IDs on an it.each declaration", () => {
  withRepository(
    {
      specs: {
        "docs/specs/F01-example.md": `# F01 Example
- 状态：已实现
#### Scenario F01-S01: First behavior
- GIVEN one
- WHEN one
- THEN one
#### Scenario F01-S02: Second behavior
- GIVEN two
- WHEN two
- THEN two
`,
      },
      files: {
        "src/example/__tests__/behavior.test.ts":
          'it.each([1, 2])("[F01-S01][F01-S02] preserves behavior for %s", () => {});\n',
      },
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /2 implemented with 2 bindings \(L2 2, L3 0, L4 0\)/);
    },
  );
});

test("accepts Scenario tags on a top-level Maestro flow", () => {
  withRepository(
    {
      files: {
        "e2e/flows/behavior.yaml": `appId: com.example
name: Visible behavior
tags:
  - F01-S01
---
- launchApp
`,
      },
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 implemented with 1 bindings \(L2 0, L3 0, L4 1\)/);
    },
  );
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

test("rejects an implemented Scenario without a test binding", () => {
  withRepository(
    {
      files: {
        "src/example/__tests__/behavior.test.ts": 'test("shows the visible result", () => {});\n',
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /F01-S01 is implemented but has no test binding/);
    },
  );
});

test("rejects a test binding for a deleted Scenario", () => {
  withRepository(
    {
      files: {
        "src/example/__tests__/behavior.test.ts":
          'test("[F01-S99] shows a deleted result", () => {});\n',
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /references unknown Scenario F01-S99/);
    },
  );
});

test("rejects Scenario evidence declared on a disabled test", () => {
  withRepository(
    {
      files: {
        "src/example/__tests__/behavior.test.ts":
          'it.skip("[F01-S01] shows the visible result", () => {});\n',
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /declares Scenario evidence on a disabled test/);
      assert.match(result.stderr, /F01-S01 is implemented but has no test binding/);
    },
  );
});

test("rejects malformed Scenario annotations in native test titles", () => {
  withRepository(
    {
      files: {
        "src/example/__tests__/behavior.test.ts":
          'test("[F1-S01] shows the visible result", () => {});\n',
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /has an invalid Scenario annotation/);
    },
  );
});

test("rejects Scenario annotations outside the test-title prefix", () => {
  withRepository(
    {
      files: {
        "src/example/__tests__/behavior.test.ts":
          'test("shows the [F01-S01] visible result", () => {});\n',
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /has an invalid Scenario annotation/);
    },
  );
});

test("rejects malformed Scenario tags in Maestro flows", () => {
  withRepository(
    {
      files: {
        "e2e/flows/behavior.yaml": `appId: com.example
name: Visible behavior
tags:
  - F1-S01
---
- launchApp
`,
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /has an invalid Scenario tag "F1-S01"/);
    },
  );
});

test("does not treat a describe title as Scenario evidence", () => {
  withRepository(
    {
      files: {
        "src/example/__tests__/behavior.test.ts":
          'describe("[F01-S01] behavior", () => { it("shows the result", () => {}); });\n',
      },
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /F01-S01 is implemented but has no test binding/);
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
      files: {},
    },
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /has an invalid Scenario heading/);
    },
  );
});
