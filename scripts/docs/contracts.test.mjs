import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateDocumentation } from "./contracts.mjs";

const contractsScript = fileURLToPath(new URL("./contracts.mjs", import.meta.url));

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function createValidFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "plogkit-doc-contracts-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：示例决定

- 状态：已接受
- 接受日期：2026-07-27

## 背景

需要一个最小有效决定。

## 决策

采用示例决定。

## 影响与代价

维护一份示例。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 示例决定 | 已接受 | — |
`,
    ),
    write(
      root,
      "docs/specs/F01-sample-feature.md",
      `# F01 示例功能

- 状态：已实现

## 概述

提供一个示例行为。

## 需求与场景

#### Scenario: 完成示例

- GIVEN 用户处于有效状态
- WHEN 用户执行示例操作
- THEN 用户看到示例结果
`,
    ),
    write(
      root,
      "docs/specs/README.md",
      `# 功能需求 Specs

## 索引

| 编号 | 功能 | 状态 |
| --- | --- | --- |
| [F01](F01-sample-feature.md) | 示例功能 | 已实现 |
`,
    ),
    write(
      root,
      "docs/README.md",
      `# 文档导航与 ownership map

- [ADR](adr/)
- [Specs](specs/)
- [Product decisions](product/product-decisions.md)
- [Product scope](product/product-scope.md)
- [Naming](product/naming-and-slogan.md)
- [Guides](guides/)
- [English README](../README.md)
- [Chinese README](../README.zh-Hans.md)
- [AGENTS](../AGENTS.md)
- [CONTEXT](../CONTEXT.md)
- [Agent adapters](agents/)
`,
    ),
    write(root, "docs/product/product-decisions.md", "# 产品决策\n"),
    write(root, "docs/product/product-scope.md", "# 产品范围\n"),
    write(root, "docs/product/naming-and-slogan.md", "# 命名与 Slogan\n"),
    write(root, "docs/guides/example.md", "# 示例指南\n"),
    write(root, "docs/agents/example.md", "# Agent adapter\n"),
    write(
      root,
      "README.md",
      `# PlogKit

[简体中文](README.zh-Hans.md)

## Status

Pre-release.

## Features

Sample.

## Product Scope

[Scope](docs/product/product-scope.md).

## Tech Stack

Sample.

## Documentation

[Documentation map](docs/README.md).

## License

GPL-3.0-only.
`,
    ),
    write(
      root,
      "README.zh-Hans.md",
      `# PlogKit

[English](README.md)

## 状态

发布前。

## 已实现功能

示例。

## 产品范围

[范围](docs/product/product-scope.md)。

## 技术栈

示例。

## 文档

[文档地图](docs/README.md)。

## 许可证

GPL-3.0-only。
`,
    ),
    write(root, "AGENTS.md", "# AGENTS\n\n[Documentation map](docs/README.md).\n"),
    write(root, "CONTEXT.md", "# PlogKit\n"),
  ]);

  return root;
}

test("reports an ADR omitted from the index", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/adr/README.md",
    `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
`,
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/README.md: missing index entry for ADR 0001 (0001-sample-decision.md)",
    ),
  );
});

test("reports duplicate ADR document IDs", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  await write(root, "docs/adr/0001-other-decision.md", adr);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr: duplicate document ID 0001 (0001-other-decision.md, 0001-sample-decision.md)",
    ),
  );
});

test("reports ADR status drift between the document and index", async (t) => {
  const root = await createValidFixture(t);
  const index = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/adr/README.md"), "utf8"),
  );
  await write(root, "docs/adr/README.md", index.replace("| 已接受 |", "| 部分修订 |"));

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/README.md: ADR 0001 status mismatch (index: 部分修订, document: 已接受)",
    ),
  );
});

test("reports an ADR successor without the reverse predecessor relation", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    `# ADR 0001：示例决定

- 状态：部分修订
- 接受日期：2026-07-27
- 后继：[ADR 0002](0002-successor.md)

## 背景

需要一个最小有效决定。

## 决策

采用示例决定。

## 影响与代价

维护一份示例。
`,
  );
  await write(
    root,
    "docs/adr/0002-successor.md",
    `# ADR 0002：后继决定

- 状态：已接受
- 接受日期：2026-07-27

## 背景

需要修订示例决定。

## 决策

采用后继决定。

## 影响与代价

维护后继关系。
`,
  );
  await write(
    root,
    "docs/adr/README.md",
    `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 示例决定 | 部分修订 | [0002](0002-successor.md) |
| [0002](0002-successor.md) | 后继决定 | 已接受 | — |
`,
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0001-sample-decision.md: successor ADR 0002 does not declare predecessor ADR 0001",
    ),
  );
});

test("reports a spec omitted from the index", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/specs/README.md",
    `# 功能需求 Specs

## 索引

| 编号 | 功能 | 状态 |
| --- | --- | --- |
`,
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes("docs/specs/README.md: missing index entry for F01 (F01-sample-feature.md)"),
  );
});

test("reports duplicate spec document IDs", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await write(root, "docs/specs/F01-other-feature.md", spec);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/specs: duplicate document ID F01 (F01-other-feature.md, F01-sample-feature.md)",
    ),
  );
});

test("reports spec status drift between the document and index", async (t) => {
  const root = await createValidFixture(t);
  const index = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/specs/README.md"), "utf8"),
  );
  await write(root, "docs/specs/README.md", index.replace("| 已实现 |", "| 已确认 |"));

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes("docs/specs/README.md: F01 status mismatch (index: 已确认, document: 已实现)"),
  );
});

test("reports a Scenario without every required step", async (t) => {
  const root = await createValidFixture(t);
  const spec = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8"),
  );
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    spec.replace("- WHEN 用户执行示例操作", "- AND 用户执行示例操作"),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes('docs/specs/F01-sample-feature.md: Scenario "完成示例" is missing WHEN'),
  );
});

test("accepts a repository that satisfies the documentation contracts", async (t) => {
  const root = await createValidFixture(t);

  assert.deepEqual(validateDocumentation(root), []);
});

test("reports a Scenario status override without an Issue", async (t) => {
  const root = await createValidFixture(t);
  const spec = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8"),
  );
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    spec.replace("#### Scenario: 完成示例\n", "#### Scenario: 完成示例\n\n- 状态：已确认\n"),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: Scenario "完成示例" overrides 已实现 with 已确认 but has no Issue',
    ),
  );
});

test("reports an implemented Scenario status override", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  const index = await readFile(path.join(root, "docs/specs/README.md"), "utf8");
  await Promise.all([
    write(
      root,
      "docs/specs/F01-sample-feature.md",
      spec
        .replace("- 状态：已实现", "- 状态：已确认")
        .replace("#### Scenario: 完成示例\n", "#### Scenario: 完成示例\n\n- 状态：已实现\n"),
    ),
    write(root, "docs/specs/README.md", index.replace("| 已实现 |", "| 已确认 |")),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: Scenario "完成示例" has a stale implemented status override',
    ),
  );
});

test("reports an ADR without a valid accepted date", async (t) => {
  const root = await createValidFixture(t);
  const adr = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8"),
  );
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    adr.replace("- 接受日期：2026-07-27", "- 接受日期：2026-02-30"),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0001-sample-decision.md: accepted date must use a valid YYYY-MM-DD value",
    ),
  );
});

test("reports a revised ADR without a successor", async (t) => {
  const root = await createValidFixture(t);
  const { readFile } = await import("node:fs/promises");
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  const index = await readFile(path.join(root, "docs/adr/README.md"), "utf8");
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      adr.replace("- 状态：已接受", "- 状态：部分修订"),
    ),
    write(root, "docs/adr/README.md", index.replace("| 已接受 |", "| 部分修订 |")),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0001-sample-decision.md: status 部分修订 requires at least one successor ADR",
    ),
  );
});

test("reports an ADR title that differs from its index entry", async (t) => {
  const root = await createValidFixture(t);
  const index = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/adr/README.md"), "utf8"),
  );
  await write(root, "docs/adr/README.md", index.replace("示例决定 |", "不同标题 |"));

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/adr/README.md: ADR 0001 title mismatch (index: "不同标题", document: "示例决定")',
    ),
  );
});

test("reports an ADR number that differs from its filename", async (t) => {
  const root = await createValidFixture(t);
  const adr = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8"),
  );
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    adr.replace("# ADR 0001：", "# ADR 0002："),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0001-sample-decision.md: filename ADR 0001 does not match header ADR 0002",
    ),
  );
});

test("reports an ADR with an empty required section", async (t) => {
  const root = await createValidFixture(t);
  const adr = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8"),
  );
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    adr.replace("## 影响与代价\n\n维护一份示例。", "## 影响与代价"),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/adr/0001-sample-decision.md: required section "影响与代价" is missing or empty',
    ),
  );
});

test("reports an ADR status outside the allowed decision states", async (t) => {
  const root = await createValidFixture(t);
  const adr = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8"),
  );
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    adr.replace("- 状态：已接受", "- 状态：已实现"),
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes('docs/adr/0001-sample-decision.md: invalid ADR status "已实现"'));
});

test("reports ADR successor drift between the document and index", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    `# ADR 0001：示例决定

- 状态：部分修订
- 接受日期：2026-07-27
- 后继：[ADR 0002](0002-successor.md)

## 背景

需要一个最小有效决定。

## 决策

采用示例决定。

## 影响与代价

维护一份示例。
`,
  );
  await write(
    root,
    "docs/adr/0002-successor.md",
    `# ADR 0002：后继决定

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](0001-sample-decision.md)

## 背景

需要修订示例决定。

## 决策

采用后继决定。

## 影响与代价

维护后继关系。
`,
  );
  await write(
    root,
    "docs/adr/README.md",
    `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 示例决定 | 部分修订 | — |
| [0002](0002-successor.md) | 后继决定 | 已接受 | — |
`,
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/README.md: ADR 0001 successor mismatch (index: none, document: 0002)",
    ),
  );
});

test("reports an ADR predecessor without the reverse successor relation", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/adr/0002-successor.md",
    `# ADR 0002：后继决定

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](0001-sample-decision.md)

## 背景

需要修订示例决定。

## 决策

采用后继决定。

## 影响与代价

维护后继关系。
`,
  );
  const index = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/adr/README.md"), "utf8"),
  );
  await write(
    root,
    "docs/adr/README.md",
    `${index.trimEnd()}\n| [0002](0002-successor.md) | 后继决定 | 已接受 | — |\n`,
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0002-successor.md: predecessor ADR 0001 does not declare successor ADR 0002",
    ),
  );
});

test("reports a spec title that differs from its index entry", async (t) => {
  const root = await createValidFixture(t);
  const index = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/specs/README.md"), "utf8"),
  );
  await write(root, "docs/specs/README.md", index.replace("示例功能 |", "不同功能 |"));

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/specs/README.md: F01 title mismatch (index: "不同功能", document: "示例功能")',
    ),
  );
});

test("reports a spec number that differs from its filename", async (t) => {
  const root = await createValidFixture(t);
  const spec = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8"),
  );
  await write(root, "docs/specs/F01-sample-feature.md", spec.replace("# F01 ", "# F02 "));

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes("docs/specs/F01-sample-feature.md: filename F01 does not match header F02"),
  );
});

test("reports a spec with an empty required section", async (t) => {
  const root = await createValidFixture(t);
  const spec = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8"),
  );
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    spec.replace("## 概述\n\n提供一个示例行为。", "## 概述"),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: required section "概述" is missing or empty',
    ),
  );
});

test("reports a spec status outside the allowed delivery states", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    spec.replace("- 状态：已实现", "- 状态：待实现"),
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes('docs/specs/F01-sample-feature.md: invalid spec status "待实现"'));
});

test("reports a redundant Scenario status that matches its spec", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    spec.replace("#### Scenario: 完成示例\n", "#### Scenario: 完成示例\n\n- 状态：已实现\n"),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: Scenario "完成示例" repeats inherited status 已实现',
    ),
  );
});

test("reports a spec without a Scenario", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    spec.replace("#### Scenario: 完成示例", "#### Example: 完成示例"),
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/specs/F01-sample-feature.md: requires at least one Scenario"));
});

test("reports an ADR index link that does not match its document", async (t) => {
  const root = await createValidFixture(t);
  const index = await readFile(path.join(root, "docs/adr/README.md"), "utf8");
  await write(
    root,
    "docs/adr/README.md",
    index.replace("0001-sample-decision.md", "0001-wrong.md"),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/README.md: ADR 0001 link mismatch (index: 0001-wrong.md, document: 0001-sample-decision.md)",
    ),
  );
});

test("reports a spec index link that does not match its document", async (t) => {
  const root = await createValidFixture(t);
  const index = await readFile(path.join(root, "docs/specs/README.md"), "utf8");
  await write(root, "docs/specs/README.md", index.replace("F01-sample-feature.md", "F01-wrong.md"));

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/specs/README.md: F01 link mismatch (index: F01-wrong.md, document: F01-sample-feature.md)",
    ),
  );
});

test("reports a formal module omitted from the ownership map", async (t) => {
  const root = await createValidFixture(t);
  const map = await readFile(path.join(root, "docs/README.md"), "utf8");
  await write(root, "docs/README.md", map.replace("- [CONTEXT](../CONTEXT.md)\n", ""));

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/README.md: missing formal module link ../CONTEXT.md"));
});

test("accepts README heading changes when canonical navigation remains", async (t) => {
  const root = await createValidFixture(t);
  const english = await readFile(path.join(root, "README.md"), "utf8");
  const chinese = await readFile(path.join(root, "README.zh-Hans.md"), "utf8");
  await Promise.all([
    write(root, "README.md", english.replaceAll("## ", "## Renamed ")),
    write(root, "README.zh-Hans.md", chinese.replaceAll("## ", "## 重命名")),
  ]);

  assert.deepEqual(validateDocumentation(root), []);
});

test("reports a README that does not link the documentation map", async (t) => {
  const root = await createValidFixture(t);
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  await write(
    root,
    "README.md",
    readme.replace("[Documentation map](docs/README.md)", "Documentation map"),
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("README.md: missing navigation link docs/README.md"));
});

test("reports AGENTS navigation that omits the documentation map", async (t) => {
  const root = await createValidFixture(t);
  await write(root, "AGENTS.md", "# AGENTS\n");

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("AGENTS.md: missing navigation link docs/README.md"));
});

test("CLI exits non-zero and prints every contract error", async (t) => {
  const root = await createValidFixture(t);
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  await write(
    root,
    "README.md",
    readme.replace("[Documentation map](docs/README.md)", "Documentation map"),
  );

  const result = spawnSync(process.execPath, [contractsScript], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md: missing navigation link docs\/README\.md/);
});

test("reports a missing required navigation file without throwing", async (t) => {
  const root = await createValidFixture(t);
  await rm(path.join(root, "docs/README.md"));

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/README.md: required file is missing"));
});

test("reports a missing canonical navigation target", async (t) => {
  const root = await createValidFixture(t);
  await rm(path.join(root, "docs/product/product-scope.md"));

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/product/product-scope.md: required file is missing"));
});

test("reports ADR relation links whose destinations do not match their displayed IDs", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：示例决定

- 状态：部分修订
- 接受日期：2026-07-27
- 后继：[ADR 0002](0003-other.md)

## 背景

需要一个最小有效决定。

## 决策

采用示例决定。

## 影响与代价

维护一份示例。
`,
    ),
    write(
      root,
      "docs/adr/0002-successor.md",
      `# ADR 0002：后继决定

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](0001-sample-decision.md)

## 背景

需要修订示例决定。

## 决策

采用后继决定。

## 影响与代价

维护后继关系。
`,
    ),
    write(
      root,
      "docs/adr/0003-other.md",
      `# ADR 0003：其他决定

- 状态：已接受
- 接受日期：2026-07-27

## 背景

需要另一个决定。

## 决策

采用其他决定。

## 影响与代价

维护其他决定。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 示例决定 | 部分修订 | [0002](0003-other.md) |
| [0002](0002-successor.md) | 后继决定 | 已接受 | — |
| [0003](0003-other.md) | 其他决定 | 已接受 | — |
`,
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0001-sample-decision.md: successor ADR 0002 link mismatch (target: 0003-other.md, document: 0002-successor.md)",
    ),
  );
  assert.ok(
    errors.includes(
      "docs/adr/README.md: ADR 0001 successor ADR 0002 link mismatch (target: 0003-other.md, document: 0002-successor.md)",
    ),
  );
});

test("reports malformed formal-document filenames", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await Promise.all([write(root, "docs/adr/0039.md", adr), write(root, "docs/specs/F09.md", spec)]);

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/adr/0039.md: filename must match NNNN-slug.md"));
  assert.ok(errors.includes("docs/specs/F09.md: filename must match FNN-slug.md"));
});

test("reports a predecessor relation kind that contradicts its status", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：示例决定

- 状态：已取代
- 接受日期：2026-07-27
- 后继：[ADR 0002](0002-successor.md)

## 背景

需要一个最小有效决定。

## 决策

采用示例决定。

## 影响与代价

维护一份示例。
`,
    ),
    write(
      root,
      "docs/adr/0002-successor.md",
      `# ADR 0002：后继决定

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](0001-sample-decision.md)

## 背景

需要取代示例决定。

## 决策

采用后继决定。

## 影响与代价

维护后继关系。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 示例决定 | 已取代 | [0002](0002-successor.md) |
| [0002](0002-successor.md) | 后继决定 | 已接受 | — |
`,
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0002-successor.md: predecessor ADR 0001 uses 修订 but status 已取代 requires 取代",
    ),
  );
});

test("reports an accepted ADR that declares a successor", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：示例决定

- 状态：已接受
- 接受日期：2026-07-27
- 后继：[ADR 0002](0002-successor.md)

## 背景

需要一个最小有效决定。

## 决策

采用示例决定。

## 影响与代价

维护一份示例。
`,
    ),
    write(
      root,
      "docs/adr/0002-successor.md",
      `# ADR 0002：后继决定

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](0001-sample-decision.md)

## 背景

需要修订示例决定。

## 决策

采用后继决定。

## 影响与代价

维护后继关系。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 示例决定 | 已接受 | [0002](0002-successor.md) |
| [0002](0002-successor.md) | 后继决定 | 已接受 | — |
`,
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0001-sample-decision.md: status 已接受 must not declare successor ADRs",
    ),
  );
});

test("rejects self-referential ADR relations", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：示例决定

- 状态：部分修订
- 接受日期：2026-07-27
- 后继：[ADR 0001](0001-sample-decision.md)
- 修订：[ADR 0001](0001-sample-decision.md)

## 背景

需要一个最小有效决定。

## 决策

采用示例决定。

## 影响与代价

维护一份示例。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 示例决定 | 部分修订 | [0001](0001-sample-decision.md) |
`,
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes("docs/adr/0001-sample-decision.md: successor ADR must not reference itself"),
  );
  assert.ok(
    errors.includes("docs/adr/0001-sample-decision.md: predecessor ADR must not reference itself"),
  );
});

test("accepts ADR successors across metadata fields, equivalent paths, and index orders", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：示例决定

- 状态：部分修订
- 接受日期：2026-07-27
- 后继：[ADR 0002](./0002-first-successor.md#decision)
- 后继：[ADR 0003](0003-second-successor.md#decision)

## 背景

需要一个最小有效决定。

## 决策

采用示例决定。

## 影响与代价

维护一份示例。
`,
    ),
    write(
      root,
      "docs/adr/0002-first-successor.md",
      `# ADR 0002：第一项后继

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](./0001-sample-decision.md#decision)

## 背景

需要修订示例决定。

## 决策

采用第一项后继。

## 影响与代价

维护后继关系。
`,
    ),
    write(
      root,
      "docs/adr/0003-second-successor.md",
      `# ADR 0003：第二项后继

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](0001-sample-decision.md#decision)

## 背景

需要再次修订示例决定。

## 决策

采用第二项后继。

## 影响与代价

维护后继关系。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](./0001-sample-decision.md#metadata) | 示例决定 | 部分修订 | [0003](./0003-second-successor.md#decision)、[0002](0002-first-successor.md#decision) |
| [0002](./0002-first-successor.md#metadata) | 第一项后继 | 已接受 | — |
| [0003](0003-second-successor.md#metadata) | 第二项后继 | 已接受 | — |
`,
    ),
  ]);

  assert.deepEqual(validateDocumentation(root), []);
});

test("reports an empty optional ADR section", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  await write(root, "docs/adr/0001-sample-decision.md", `${adr}\n## 替代方案\n`);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes('docs/adr/0001-sample-decision.md: optional section "替代方案" is empty'),
  );
});

test("requires Scenarios to appear inside the requirements section", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    `# F01 示例功能

- 状态：已实现

## 概述

提供一个示例行为。

## 需求与场景

场景待补充。

## 附录

#### Scenario: 附录示例

- GIVEN 用户处于有效状态
- WHEN 用户执行示例操作
- THEN 用户看到示例结果
`,
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/specs/F01-sample-feature.md: requires at least one Scenario"));
});

test("ignores fenced Scenario examples in the requirements section", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    `# F01 示例功能

- 状态：已实现

## 概述

提供一个示例行为。

## 需求与场景

\`\`\`markdown
#### Scenario: 围栏示例

- GIVEN 用户处于有效状态
- WHEN 用户执行示例操作
- THEN 用户看到示例结果
\`\`\`
`,
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/specs/F01-sample-feature.md: requires at least one Scenario"));
});

test("ignores fenced ADR metadata examples", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    adr.replace(
      "- 状态：已接受\n- 接受日期：2026-07-27",
      `\`\`\`markdown
- 状态：已接受
- 接受日期：2026-07-27
\`\`\``,
    ),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes('docs/adr/0001-sample-decision.md: invalid ADR status "missing"'),
  );
  assert.ok(
    errors.includes(
      "docs/adr/0001-sample-decision.md: accepted date must use a valid YYYY-MM-DD value",
    ),
  );
});

test("ignores ADR metadata and index rows inside HTML comments", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  const index = await readFile(path.join(root, "docs/adr/README.md"), "utf8");
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      adr.replace(
        "- 状态：已接受\n- 接受日期：2026-07-27",
        "<!--\n- 状态：已接受\n- 接受日期：2026-07-27\n-->",
      ),
    ),
    write(
      root,
      "docs/adr/README.md",
      index.replace(
        "| [0001](0001-sample-decision.md) | 示例决定 | 已接受 | — |",
        "<!--\n| [0001](0001-sample-decision.md) | 示例决定 | 已接受 | — |\n-->",
      ),
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/README.md: missing index entry for ADR 0001 (0001-sample-decision.md)",
    ),
  );
  assert.ok(
    errors.includes('docs/adr/0001-sample-decision.md: invalid ADR status "missing"'),
  );
  assert.ok(
    errors.includes(
      "docs/adr/0001-sample-decision.md: accepted date must use a valid YYYY-MM-DD value",
    ),
  );
});

test("reports sections containing only HTML comments as empty", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `${adr.replace("需要一个最小有效决定。", "<!-- TODO -->")}
## 替代方案

<!-- TODO -->
`,
    ),
    write(
      root,
      "docs/specs/F01-sample-feature.md",
      spec.replace("提供一个示例行为。", "<!-- TODO -->"),
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/adr/0001-sample-decision.md: required section "背景" is missing or empty',
    ),
  );
  assert.ok(
    errors.includes('docs/adr/0001-sample-decision.md: optional section "替代方案" is empty'),
  );
  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: required section "概述" is missing or empty',
    ),
  );
});

test("accepts a section containing only a fenced code block as nonempty", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    `${adr}
## 建议结构

\`\`\`text
visible example
\`\`\`
`,
  );

  assert.deepEqual(validateDocumentation(root), []);
});

test("reports duplicate overall spec statuses", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    spec.replace("- 状态：已实现", "- 状态：已实现\n- 状态：草拟"),
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/specs/F01-sample-feature.md: duplicate overall status fields"));
});

test("reports duplicate ADR status fields", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    adr.replace("- 状态：已接受", "- 状态：已接受\n- 状态：已取代"),
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/adr/0001-sample-decision.md: duplicate ADR status fields"));
});

test("reports whitespace-only ADR and spec titles", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  const adrIndex = await readFile(path.join(root, "docs/adr/README.md"), "utf8");
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  const specIndex = await readFile(path.join(root, "docs/specs/README.md"), "utf8");
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      adr.replace("# ADR 0001：示例决定", "# ADR 0001：   "),
    ),
    write(root, "docs/adr/README.md", adrIndex.replace("| 示例决定 |", "|   |")),
    write(
      root,
      "docs/specs/F01-sample-feature.md",
      spec.replace("# F01 示例功能", "# F01    "),
    ),
    write(root, "docs/specs/README.md", specIndex.replace("| 示例功能 |", "|   |")),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/adr/0001-sample-decision.md: ADR title must not be empty"));
  assert.ok(errors.includes("docs/specs/F01-sample-feature.md: spec title must not be empty"));
});

test("reports duplicate ADR accepted-date fields", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  await write(
    root,
    "docs/adr/0001-sample-decision.md",
    adr.replace(
      "- 接受日期：2026-07-27",
      "- 接受日期：2026-07-27\n- 接受日期：2026-07-28",
    ),
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes("docs/adr/0001-sample-decision.md: duplicate accepted date fields"));
});

test("reports duplicate Scenario status fields", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    spec.replace(
      "- GIVEN 用户处于有效状态",
      "- 状态：草拟\n- 状态：已确认\n- Issue：#10\n- GIVEN 用户处于有效状态",
    ),
  );

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: Scenario "完成示例" has duplicate status fields',
    ),
  );
});

test("accepts separate revision and replacement predecessor fields", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：第一项决定

- 状态：部分修订
- 接受日期：2026-07-27
- 后继：[ADR 0003](0003-successor.md)

## 背景

需要第一项决定。

## 决策

采用第一项决定。

## 影响与代价

维护第一项决定。
`,
    ),
    write(
      root,
      "docs/adr/0002-second-decision.md",
      `# ADR 0002：第二项决定

- 状态：已取代
- 接受日期：2026-07-27
- 后继：[ADR 0003](0003-successor.md)

## 背景

需要第二项决定。

## 决策

采用第二项决定。

## 影响与代价

维护第二项决定。
`,
    ),
    write(
      root,
      "docs/adr/0003-successor.md",
      `# ADR 0003：后继决定

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](0001-sample-decision.md)
- 取代：[ADR 0002](0002-second-decision.md)

## 背景

需要统一后继决定。

## 决策

采用后继决定。

## 影响与代价

维护两种前驱关系。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 第一项决定 | 部分修订 | [0003](0003-successor.md) |
| [0002](0002-second-decision.md) | 第二项决定 | 已取代 | [0003](0003-successor.md) |
| [0003](0003-successor.md) | 后继决定 | 已接受 | — |
`,
    ),
  ]);

  assert.deepEqual(validateDocumentation(root), []);
});

test("ends a Scenario before a sibling level-four heading", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    `# F01 示例功能

- 状态：已实现

## 概述

提供一个示例行为。

## 需求与场景

#### Scenario: 未完成示例

- GIVEN 用户处于有效状态

#### Notes

- WHEN 这只是说明文字
- THEN 这不属于验收场景
`,
  );

  const errors = validateDocumentation(root);

  assert.ok(errors.includes('docs/specs/F01-sample-feature.md: Scenario "未完成示例" is missing WHEN'));
  assert.ok(errors.includes('docs/specs/F01-sample-feature.md: Scenario "未完成示例" is missing THEN'));
});

test("preserves revision history when a predecessor is later replaced", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：原始决定

- 状态：已取代
- 接受日期：2026-07-27
- 后继：[ADR 0002](0002-revision.md)、[ADR 0003](0003-replacement.md)

## 背景

需要原始决定。

## 决策

采用原始决定。

## 影响与代价

维护原始决定。
`,
    ),
    write(
      root,
      "docs/adr/0002-revision.md",
      `# ADR 0002：部分修订

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0001](0001-sample-decision.md)

## 背景

需要修订原始决定。

## 决策

采用部分修订。

## 影响与代价

保留历史修订关系。
`,
    ),
    write(
      root,
      "docs/adr/0003-replacement.md",
      `# ADR 0003：完整取代

- 状态：已接受
- 接受日期：2026-07-27
- 取代：[ADR 0001](0001-sample-decision.md)

## 背景

需要取代原始决定。

## 决策

采用完整取代。

## 影响与代价

保留取代关系。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 原始决定 | 已取代 | [0002](0002-revision.md)、[0003](0003-replacement.md) |
| [0002](0002-revision.md) | 部分修订 | 已接受 | — |
| [0003](0003-replacement.md) | 完整取代 | 已接受 | — |
`,
    ),
  ]);

  assert.deepEqual(validateDocumentation(root), []);
});

test("ignores fenced ADR and spec index examples", async (t) => {
  const root = await createValidFixture(t);
  const adrIndex = await readFile(path.join(root, "docs/adr/README.md"), "utf8");
  const specIndex = await readFile(path.join(root, "docs/specs/README.md"), "utf8");
  const adrRow = "| [0001](0001-sample-decision.md) | 示例决定 | 已接受 | — |";
  const specRow = "| [F01](F01-sample-feature.md) | 示例功能 | 已实现 |";
  await Promise.all([
    write(root, "docs/adr/README.md", adrIndex.replace(adrRow, `\`\`\`md\n${adrRow}\n\`\`\``)),
    write(
      root,
      "docs/specs/README.md",
      specIndex.replace(specRow, `\`\`\`md\n${specRow}\n\`\`\``),
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/README.md: missing index entry for ADR 0001 (0001-sample-decision.md)",
    ),
  );
  assert.ok(
    errors.includes("docs/specs/README.md: missing index entry for F01 (F01-sample-feature.md)"),
  );
});

test("rejects stale Scenario Issue metadata", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/specs/F01-sample-feature.md",
      `# F01 示例功能

- 状态：已确认

## 概述

提供一个示例行为。

## 需求与场景

#### Scenario: 继承状态

- Issue：[Issue #10](https://github.com/example/project/issues/10)
- GIVEN 用户处于有效状态
- WHEN 用户执行示例操作
- THEN 用户看到示例结果

#### Scenario: 已实现例外

- 状态：已实现
- Issue：[Issue #11](https://github.com/example/project/issues/11)
- GIVEN 用户处于有效状态
- WHEN 用户执行另一项操作
- THEN 用户看到另一项结果
`,
    ),
    write(
      root,
      "docs/specs/README.md",
      `# 功能需求 Specs

## 索引

| 编号 | 功能 | 状态 |
| --- | --- | --- |
| [F01](F01-sample-feature.md) | 示例功能 | 已确认 |
`,
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: Scenario "继承状态" has Issue metadata without an unimplemented status override',
    ),
  );
  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: Scenario "已实现例外" has Issue metadata without an unimplemented status override',
    ),
  );
});

test("rejects forbidden implementation-history sections in specs", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    `${spec}
## 实施跟踪

跟踪实现。

## 已解决问题

记录问题。

## 后续观察

记录观察。

## 开放问题

记录开放问题。
`,
  );

  const errors = validateDocumentation(root);

  for (const section of ["实施跟踪", "已解决问题", "后续观察", "开放问题"]) {
    assert.ok(
      errors.includes(`docs/specs/F01-sample-feature.md: forbidden section "${section}"`),
    );
  }
});

test("accepts valid unordered-list markers and indentation for Scenario steps", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    `# F01 示例功能

- 状态：已实现

## 概述

提供一个示例行为。

## 需求与场景

#### Scenario: 完成示例

* GIVEN 用户处于有效状态
+ WHEN 用户执行示例操作
  - THEN 用户看到示例结果
`,
  );

  assert.deepEqual(validateDocumentation(root), []);
});

test("parses Scenario metadata with valid unordered-list markers", async (t) => {
  const root = await createValidFixture(t);
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  const index = await readFile(path.join(root, "docs/specs/README.md"), "utf8");
  await Promise.all([
    write(
      root,
      "docs/specs/F01-sample-feature.md",
      spec
        .replace("- 状态：已实现", "- 状态：已确认")
        .replace(
          "#### Scenario: 完成示例\n",
          "#### Scenario: 完成示例\n\n* 状态：已实现\n+ Issue：#50\n",
        ),
    ),
    write(root, "docs/specs/README.md", index.replace("| 已实现 |", "| 已确认 |")),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: Scenario "完成示例" has a stale implemented status override',
    ),
  );
  assert.ok(
    errors.includes(
      'docs/specs/F01-sample-feature.md: Scenario "完成示例" has Issue metadata without an unimplemented status override',
    ),
  );
});

test("accepts metadata values with Markdown hard-break whitespace", async (t) => {
  const root = await createValidFixture(t);
  const adr = await readFile(path.join(root, "docs/adr/0001-sample-decision.md"), "utf8");
  const spec = await readFile(path.join(root, "docs/specs/F01-sample-feature.md"), "utf8");
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      adr
        .replace("- 状态：已接受", "- 状态：已接受  ")
        .replace("- 接受日期：2026-07-27", "- 接受日期：2026-07-27  "),
    ),
    write(
      root,
      "docs/specs/F01-sample-feature.md",
      spec.replace("- 状态：已实现", "- 状态：已实现  "),
    ),
  ]);

  assert.deepEqual(validateDocumentation(root), []);
});

test("accepts equivalent spec index destinations", async (t) => {
  const root = await createValidFixture(t);
  const index = await readFile(path.join(root, "docs/specs/README.md"), "utf8");
  await write(
    root,
    "docs/specs/README.md",
    index.replace("(F01-sample-feature.md)", "(./F01-sample-feature.md#scenario)"),
  );

  assert.deepEqual(validateDocumentation(root), []);
});

test("accepts bare and ordered Scenario steps", async (t) => {
  const root = await createValidFixture(t);
  await write(
    root,
    "docs/specs/F01-sample-feature.md",
    `# F01 示例功能

- 状态：已实现

## 概述

提供一个示例行为。

## 需求与场景

#### Scenario: 完成示例

GIVEN 用户处于有效状态
1. WHEN 用户执行示例操作
2) THEN 用户看到示例结果
`,
  );

  assert.deepEqual(validateDocumentation(root), []);
});

test("reports a revision accepted after its predecessor was replaced", async (t) => {
  const root = await createValidFixture(t);
  await Promise.all([
    write(
      root,
      "docs/adr/0001-sample-decision.md",
      `# ADR 0001：原始决定

- 状态：已取代
- 接受日期：2026-07-27
- 后继：[ADR 0002](0002-replacement.md)、[ADR 0003](0003-late-revision.md)

## 背景

需要原始决定。

## 决策

采用原始决定。

## 影响与代价

维护原始决定。
`,
    ),
    write(
      root,
      "docs/adr/0002-replacement.md",
      `# ADR 0002：完整取代

- 状态：已接受
- 接受日期：2026-07-27
- 取代：[ADR 0001](0001-sample-decision.md)

## 背景

需要取代原始决定。

## 决策

采用完整取代。

## 影响与代价

保留取代关系。
`,
    ),
    write(
      root,
      "docs/adr/0003-late-revision.md",
      `# ADR 0003：过期修订

- 状态：已接受
- 接受日期：2026-07-28
- 修订：[ADR 0001](0001-sample-decision.md)

## 背景

尝试修订已取代决定。

## 决策

采用过期修订。

## 影响与代价

产生无效演进关系。
`,
    ),
    write(
      root,
      "docs/adr/README.md",
      `# 架构决策记录（ADR）

## 索引

| 编号 | 标题 | 状态 | 后继 ADR |
| --- | --- | --- | --- |
| [0001](0001-sample-decision.md) | 原始决定 | 已取代 | [0002](0002-replacement.md)、[0003](0003-late-revision.md) |
| [0002](0002-replacement.md) | 完整取代 | 已接受 | — |
| [0003](0003-late-revision.md) | 过期修订 | 已接受 | — |
`,
    ),
  ]);

  const errors = validateDocumentation(root);

  assert.ok(
    errors.includes(
      "docs/adr/0003-late-revision.md: predecessor ADR 0001 uses 修订 after replacement by ADR 0002",
    ),
  );
});
