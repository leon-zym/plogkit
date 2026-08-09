import ts from "typescript";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, normalize, relative } from "node:path";

const SPEC_DIRECTORY = "docs/specs";
const SCENARIO_HEADING = /^#### Scenario (F\d{2}-S\d{2}): (.+)$/gm;
const SCENARIO_ID = /^F\d{2}-S\d{2}$/;
const ANNOTATED_TEST_TITLE = /^((?:\[F\d{2}-S\d{2}\])+)[ \t]+(.+)$/;
const ANNOTATION_TOKEN = /\[(F\d{2}-S\d{2})\]/g;
const CODE_EVIDENCE_PATHS = [
  {
    directory: "src",
    level: "L2",
    pattern: /^src\/.+\/__tests__\/.+\.(?:test|spec)\.(?:js|jsx|ts|tsx)$/,
  },
  {
    directory: "render-tests",
    level: "L3",
    pattern: /^render-tests\/.+\.(?:test|spec)\.js$/,
  },
];
const FLOW_DIRECTORY = "e2e/flows";

function repositoryPath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function lineNumberAt(contents, index) {
  return contents.slice(0, index).split("\n").length;
}

function readScenarios(root, errors) {
  const specDirectory = join(root, SPEC_DIRECTORY);
  const files = readdirSync(specDirectory)
    .filter((file) => /^F\d{2}-.+\.md$/.test(file))
    .sort();
  const scenarios = [];
  const firstLocationById = new Map();

  for (const file of files) {
    const path = join(specDirectory, file);
    const contents = readFileSync(path, "utf8");
    const featureId = basename(file).match(/^(F\d{2})-/)?.[1];
    const firstScenarioIndex = contents.search(/^#### Scenario/m);
    const header = contents.slice(
      0,
      firstScenarioIndex === -1 ? contents.length : firstScenarioIndex,
    );
    const overallStatus = header.match(/^- 状态：(草拟|已确认|已实现)$/m)?.[1];
    if (!overallStatus) {
      errors.push(`${repositoryPath(root, path)} has no valid overall status`);
    }

    for (const malformed of contents.matchAll(/^#### Scenario.*$/gm)) {
      if (!/^#### Scenario F\d{2}-S\d{2}: .+$/.test(malformed[0])) {
        errors.push(
          `${repositoryPath(root, path)}:${lineNumberAt(contents, malformed.index)} has an invalid Scenario heading`,
        );
      }
    }

    const headings = [...contents.matchAll(SCENARIO_HEADING)];
    for (const [index, heading] of headings.entries()) {
      const id = heading[1];
      const start = heading.index;
      const end = headings[index + 1]?.index ?? contents.length;
      const section = contents.slice(start, end);
      const status = section.match(/^- 状态：(草拟|已确认|已实现)$/m)?.[1] ?? overallStatus;
      const location = `${repositoryPath(root, path)}:${lineNumberAt(contents, start)}`;

      if (!id.startsWith(`${featureId}-`)) {
        errors.push(`${location} uses Scenario ID ${id} outside ${featureId}`);
      }
      if (firstLocationById.has(id)) {
        errors.push(
          `${location} has duplicate Scenario ID ${id}; first declared at ${firstLocationById.get(id)}`,
        );
      } else {
        firstLocationById.set(id, location);
      }

      scenarios.push({ id, location, status });
    }
  }

  return scenarios;
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function readAnnotationIds(title, location, errors) {
  if (!title.includes("[F")) return [];
  const match = title.match(ANNOTATED_TEST_TITLE);
  if (!match) {
    errors.push(
      `${location} has an invalid Scenario annotation in test title ${JSON.stringify(title)}`,
    );
    return [];
  }

  const ids = [...match[1].matchAll(ANNOTATION_TOKEN)].map((token) => token[1]);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`${location} declares duplicate Scenario ID ${id}`);
    seen.add(id);
  }
  return ids;
}

function testCallKind(node) {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    if (expression.text === "it" || expression.text === "test") return "enabled";
    if (expression.text === "xit" || expression.text === "xtest") return "disabled";
    return null;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    if (
      ts.isIdentifier(expression.expression) &&
      (expression.expression.text === "it" || expression.expression.text === "test")
    ) {
      if (expression.name.text === "skip" || expression.name.text === "todo") return "disabled";
      if (expression.name.text === "only") return "enabled";
    }
    return null;
  }

  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "each" &&
    ts.isIdentifier(expression.expression.expression) &&
    (expression.expression.expression.text === "it" ||
      expression.expression.expression.text === "test")
  ) {
    return "enabled";
  }

  return null;
}

function readCodeBindings(root, errors) {
  const bindings = [];

  for (const source of CODE_EVIDENCE_PATHS) {
    const directory = join(root, source.directory);
    for (const path of walkFiles(directory)) {
      const file = repositoryPath(root, path);
      if (!source.pattern.test(file)) continue;

      const contents = readFileSync(path, "utf8");
      const syntax = file.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : file.endsWith(".jsx")
          ? ts.ScriptKind.JSX
          : file.endsWith(".js")
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
      const parsed = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, syntax);

      function visit(node) {
        if (ts.isCallExpression(node)) {
          const kind = testCallKind(node);
          const titleNode = node.arguments[0];
          if (
            kind &&
            titleNode &&
            (ts.isStringLiteral(titleNode) || ts.isNoSubstitutionTemplateLiteral(titleNode))
          ) {
            const line = parsed.getLineAndCharacterOfPosition(titleNode.getStart()).line + 1;
            const location = `${file}:${line}`;
            const ids = readAnnotationIds(titleNode.text, location, errors);
            if (kind === "disabled" && ids.length > 0) {
              errors.push(`${location} declares Scenario evidence on a disabled test`);
            } else {
              for (const id of ids) {
                bindings.push({ id, level: source.level, location });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(parsed);
    }
  }

  return bindings;
}

function unquoteYamlValue(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readFlowBindings(root, errors) {
  const bindings = [];
  const directory = join(root, FLOW_DIRECTORY);
  if (!existsSync(directory)) return bindings;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const path = join(directory, entry.name);
    const file = repositoryPath(root, path);
    const lines = readFileSync(path, "utf8").split("\n");
    const headerEnd = lines.findIndex((line) => line.trim() === "---");
    const header = lines.slice(0, headerEnd === -1 ? lines.length : headerEnd);
    const seen = new Set();
    let readingTags = false;

    for (const [index, line] of header.entries()) {
      if (line === "tags:") {
        readingTags = true;
        continue;
      }
      if (!readingTags) continue;

      const tag = line.match(/^  -\s+(.+?)\s*$/)?.[1];
      if (!tag) {
        if (line.trim().length > 0 && !line.trim().startsWith("#")) readingTags = false;
        continue;
      }

      const value = unquoteYamlValue(tag);
      if (!/^F\d/.test(value)) continue;
      const location = `${file}:${index + 1}`;
      if (!SCENARIO_ID.test(value)) {
        errors.push(`${location} has an invalid Scenario tag ${JSON.stringify(value)}`);
        continue;
      }
      if (seen.has(value)) errors.push(`${location} declares duplicate Scenario ID ${value}`);
      seen.add(value);
      bindings.push({ id: value, level: "L4", location });
    }
  }

  return bindings;
}

function verify(root) {
  const errors = [];
  let scenarios = [];
  let bindings = [];

  try {
    scenarios = readScenarios(root, errors);
    bindings = [...readCodeBindings(root, errors), ...readFlowBindings(root, errors)];
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const bindingsById = new Map();
  for (const binding of bindings) {
    if (!scenarioById.has(binding.id)) {
      errors.push(`${binding.location} references unknown Scenario ${binding.id}`);
      continue;
    }
    const scenarioBindings = bindingsById.get(binding.id) ?? [];
    scenarioBindings.push(binding);
    bindingsById.set(binding.id, scenarioBindings);
  }

  const implemented = scenarios.filter((scenario) => scenario.status === "已实现");
  for (const scenario of implemented) {
    if (!bindingsById.has(scenario.id)) {
      errors.push(`${scenario.id} is implemented but has no test binding (${scenario.location})`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`[scenario-verification] ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const boundByLevel = Object.fromEntries(
    ["L2", "L3", "L4"].map((level) => [
      level,
      new Set(bindings.filter((binding) => binding.level === level).map((binding) => binding.id))
        .size,
    ]),
  );
  process.stdout.write(
    `[scenario-verification] verified ${scenarios.length} Scenarios; ` +
      `${implemented.length} implemented with ${bindings.length} bindings ` +
      `(L2 ${boundByLevel.L2}, L3 ${boundByLevel.L3}, L4 ${boundByLevel.L4})\n`,
  );
}

const repositoryRoot = normalize(process.argv[2] ?? process.cwd());
verify(repositoryRoot);
