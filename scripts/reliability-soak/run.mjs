import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  assessReliabilityRun,
  buildFailureArtifactFiles,
  buildChildEnvironment,
  evaluateSourceIdentity,
  parseReliabilityOutput,
  parseRunnerArguments,
  publishArtifactAtomically,
} from "./runnerSupport.mjs";

const configuration = parseRunnerArguments(process.argv.slice(2));
const jestExecutable = resolve("node_modules", ".bin", "jest");
const generatedAt = new Date();
const date = generatedAt.toISOString().slice(0, 10);
const stamp = generatedAt.toISOString().slice(11, 23).replaceAll(":", "").replace(".", "");
const artifactRoot = resolve("artifacts", "reliability", date);

const readSourceSnapshot = () => ({
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  status: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trimEnd(),
});
const sourceStart = readSourceSnapshot();
const environment = buildChildEnvironment(process.env, configuration, sourceStart.head);
const result = spawnSync(
  jestExecutable,
  ["--runInBand", "--runTestsByPath", "src/services/drafts/__tests__/reliabilitySoak.test.ts"],
  {
    env: environment,
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  },
);
const sourceEnd = readSourceSnapshot();

const commandVersion = (command, commandArgs) => {
  const version = spawnSync(command, commandArgs, { encoding: "utf8" });
  return version.status === 0 ? version.stdout.trim() : "unavailable";
};
const runtime = {
  node: process.version,
  pnpm: commandVersion("pnpm", ["--version"]),
  jest: commandVersion(jestExecutable, ["--version"]),
};
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const parsed = parseReliabilityOutput(stdout);
process.stdout.write(parsed.visibleOutput);
process.stderr.write(stderr);

const assessment = assessReliabilityRun({
  configuration,
  exitStatus: result.status,
  spawnError: result.error ?? null,
  parsedOutput: parsed,
});
const sourceIdentity = evaluateSourceIdentity(sourceStart, sourceEnd);
const common = {
  schemaVersion: 1,
  generatedAt: generatedAt.toISOString(),
  source: { start: sourceStart, end: sourceEnd, ...sourceIdentity },
  runtime,
  profile: configuration.profile,
};

if (assessment.status === "success" && configuration.profile === "evidence") {
  const payload = parsed.payload;
  const { events, ...baselineSummary } = payload.baseline;
  const summary = {
    ...common,
    replayCommandTemplate: "pnpm test:reliability-soak:replay -- <seed> [steps]",
    baseline: baselineSummary,
    deterministicReplay: payload.deterministicReplay,
    digestsMatch: payload.digestsMatch,
    independentStateMachineSteps: baselineSummary.totalStateMachineSteps,
    replayStateMachineSteps: payload.deterministicReplay.totalStateMachineSteps,
  };
  const directory = publishArtifactAtomically({
    artifactRoot,
    directoryName: `${stamp}-${configuration.profile}-${payload.baseline.digest}`,
    files: {
      "summary.json": `${JSON.stringify(summary, null, 2)}\n`,
      "events.jsonl": `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    },
  });
  process.stdout.write(`Reliability artifacts: ${directory}\n`);
}

if (assessment.status === "failure") {
  const directory = publishArtifactAtomically({
    artifactRoot,
    directoryName: `${stamp}-${configuration.profile}-failed`,
    files: buildFailureArtifactFiles({
      common,
      exitStatus: result.status,
      assessment,
      parsedOutput: parsed,
      stdout,
      stderr,
    }),
  });
  process.stdout.write(`Reliability artifacts: ${directory}\n`);
}

process.exitCode = assessment.status === "success" ? 0 : (result.status ?? 1) || 1;
