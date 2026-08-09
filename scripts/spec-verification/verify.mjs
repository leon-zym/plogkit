import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative } from "node:path";

const SPEC_DIRECTORY = "docs/specs";
const MAP_PATH = "docs/specs/verification-map.json";
const SCENARIO_HEADING = /^#### Scenario (F\d{2}-S\d{2}): (.+)$/gm;
const ISSUE_URL = /^https:\/\/github\.com\/leon-zym\/plogkit\/issues\/\d+$/;
const EVIDENCE_PATHS = {
  L2: /^src\/.+\/__tests__\/.+\.(?:test|spec)\.(?:js|jsx|ts|tsx)$/,
  L3: /^render-tests\/.+\.(?:test|spec)\.js$/,
  L4: /^e2e\/flows\/[^/]+\.ya?ml$/,
};

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
      errors.push(`${relative(root, path)} has no valid overall status`);
    }

    for (const malformed of contents.matchAll(/^#### Scenario.*$/gm)) {
      if (!/^#### Scenario F\d{2}-S\d{2}: .+$/.test(malformed[0])) {
        errors.push(
          `${relative(root, path)}:${lineNumberAt(contents, malformed.index)} has an invalid Scenario heading`,
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
      const location = `${relative(root, path)}:${lineNumberAt(contents, start)}`;

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

function isSafeRepositoryPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    normalize(path) === path &&
    !path.split("/").includes("..")
  );
}

function validateEvidence(root, entry, evidence, errors) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    errors.push(`${entry.id} has invalid evidence metadata`);
    return;
  }

  const pathPattern = EVIDENCE_PATHS[evidence.level];
  if (!pathPattern) {
    errors.push(`${entry.id} has invalid evidence level ${String(evidence.level)}`);
  }
  if (!isSafeRepositoryPath(evidence.file)) {
    errors.push(`${entry.id} has invalid evidence path ${String(evidence.file)}`);
    return;
  }
  if (pathPattern && !pathPattern.test(evidence.file)) {
    errors.push(
      `${entry.id} evidence ${evidence.file} does not match ${evidence.level} test paths`,
    );
  }
  const absolutePath = join(root, evidence.file);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    errors.push(`${entry.id} references missing file ${evidence.file}`);
  }
  if (
    evidence.test !== undefined &&
    (typeof evidence.test !== "string" || evidence.test.trim().length === 0)
  ) {
    errors.push(`${entry.id} has an invalid optional test name`);
  }
}

function validateException(entry, errors) {
  const exception = entry.exception;
  if (!exception || typeof exception !== "object" || Array.isArray(exception)) {
    errors.push(`${entry.id} has invalid exception metadata`);
    return;
  }
  if (typeof exception.reason !== "string" || exception.reason.trim().length === 0) {
    errors.push(`${entry.id} exception requires a reason`);
  }
  if (typeof exception.issue !== "string" || !ISSUE_URL.test(exception.issue)) {
    errors.push(`${entry.id} exception requires a PlogKit Issue URL`);
  }
  if (
    exception.manual !== undefined &&
    (typeof exception.manual !== "string" || exception.manual.trim().length === 0)
  ) {
    errors.push(`${entry.id} has an invalid optional manual verification note`);
  }
}

function readAndValidateMap(root, errors) {
  const path = join(root, MAP_PATH);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${MAP_PATH} cannot be read as JSON: ${error.message}`);
    return [];
  }

  if (manifest?.version !== 1 || !Array.isArray(manifest.scenarios)) {
    errors.push(`${MAP_PATH} must contain version 1 and a scenarios array`);
    return [];
  }

  const entries = [];
  const seenIds = new Set();
  for (const candidate of manifest.scenarios) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      errors.push(`${MAP_PATH} contains an invalid mapping entry`);
      continue;
    }
    const entry = candidate;
    if (typeof entry.id !== "string" || !/^F\d{2}-S\d{2}$/.test(entry.id)) {
      errors.push(`${MAP_PATH} contains an invalid Scenario ID ${String(entry.id)}`);
      continue;
    }
    if (seenIds.has(entry.id)) {
      errors.push(`${MAP_PATH} contains duplicate mapping ${entry.id}`);
      continue;
    }
    seenIds.add(entry.id);
    entries.push(entry);

    const hasEvidence = entry.evidence !== undefined;
    const hasException = entry.exception !== undefined;
    if (hasEvidence === hasException) {
      errors.push(`${entry.id} must declare exactly one of evidence or exception`);
      continue;
    }
    if (hasEvidence) {
      if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
        errors.push(`${entry.id} evidence must be a non-empty array`);
      } else {
        for (const evidence of entry.evidence) {
          validateEvidence(root, entry, evidence, errors);
        }
      }
    } else {
      validateException(entry, errors);
    }
  }

  return entries;
}

function verify(root) {
  const errors = [];
  let scenarios = [];
  let entries = [];

  try {
    scenarios = readScenarios(root, errors);
    entries = readAndValidateMap(root, errors);
  } catch (error) {
    errors.push(error.message);
  }

  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  const mappingIds = new Set(entries.map((entry) => entry.id));

  for (const scenario of scenarios) {
    if (scenario.status === "已实现" && !mappingIds.has(scenario.id)) {
      errors.push(`${scenario.id} is implemented but has no mapping (${scenario.location})`);
    }
  }
  for (const entry of entries) {
    if (!scenarioIds.has(entry.id)) {
      errors.push(`mapping ${entry.id} has no matching Spec Scenario`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`[scenario-verification] ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `[scenario-verification] verified ${scenarios.length} Scenarios and ${entries.length} mappings\n`,
  );
}

const repositoryRoot = normalize(process.argv[2] ?? process.cwd());
verify(repositoryRoot);
