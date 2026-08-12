import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import {
  assessReliabilityRun,
  buildFailureArtifactFiles,
  buildChildEnvironment,
  evaluateSourceIdentity,
  parseRunnerArguments,
  parseReliabilityOutput,
  publishArtifactAtomically,
  validateReliabilityContract,
} from "./runnerSupport.mjs";

const sha = (character) => character.repeat(64);
const digestEvents = (events) =>
  createHash("sha256")
    .update(events.map((event) => JSON.stringify(event)).join("\n"))
    .digest("hex");
const quickSeeds = [1, 7, 42, 99, 256, 1001, 12345, 12648430];
const quickResult = {
  schemaVersion: 1,
  profile: "quick",
  baseline: {
    seedCount: 8,
    stepsPerSeed: 125,
    totalStateMachineSteps: 1000,
    digest: sha("a"),
    seeds: quickSeeds.map((seed) => ({ seed, digest: sha("b") })),
    eventCount: 1000,
    operationCounts: { create: 1000 },
    faultCounts: {},
    typedFailures: {},
    simulatedRestarts: 0,
    recoveries: 0,
    invariantViolations: 0,
  },
  deterministicReplay: null,
  digestsMatch: null,
};
const eventTemplates = [
  ["create", "created", null, null, 0, 0],
  ["save", "flushed", null, null, 0, 0],
  ["ingest", "completed", null, null, 0, 0],
  ["switch", "opened", null, null, 0, 0],
  ["delete", "deleted", null, null, 0, 0],
  ["restart", "ready", null, null, 1, 0],
  ["read-failure", "recovery-failed:storage-unavailable", "read", null, 0, 0],
  ["probe-failure", "recovery-failed:storage-unavailable", "probe", null, 0, 0],
  ["list-failure", "storage-failed", "list", "converged-after-restart", 1, 1],
  [
    "write-failure",
    "create-failed",
    "publication-marker+write-before",
    "converged-after-restart",
    1,
    1,
  ],
  ["replacement-before", "flush-failed", "replacement-before", "converged-after-restart", 1, 1],
  [
    "replacement-after-remove",
    "flush-failed",
    "replacement-after-remove",
    "converged-after-restart",
    1,
    1,
  ],
  ["replacement-after-copy", "flushed", "replacement-after-copy", "converged-after-restart", 1, 1],
  [
    "publication-failure",
    "create-failed",
    "publication-marker+write-before",
    "converged-after-restart",
    1,
    1,
  ],
  [
    "publication-unknown",
    "create-failed",
    "publication-marker+write-committed-unknown",
    "converged-after-restart",
    1,
    1,
  ],
  [
    "directory-publication",
    "create-failed",
    "directory-publication",
    "converged-after-restart",
    1,
    1,
  ],
  ["deletion-failure", "delete-failed", "deletion-marker+write-before", null, 0, 0],
  [
    "deletion-unknown",
    "delete-unknown",
    "delete-unknown-retry+deletion-marker+write-committed-unknown",
    "converged-after-restart",
    1,
    1,
  ],
  [
    "interrupted-replacement",
    "flush-failed",
    "replacement-interrupted",
    "converged-after-restart",
    1,
    1,
  ],
  ["cleanup-failure", "deleted", "cleanup", "converged-after-restart", 1, 1],
  ["stale-thumbnail", "stale-completion-ignored", "stale-async-completion", null, 0, 0],
  ["noop-save", "revision-unchanged", null, null, 0, 0],
  [
    "switch-failure",
    "open-failed:old-handle-active",
    "probe+switch-failure-preserves-handle",
    null,
    0,
    0,
  ],
  ["dirty-save-new-edit", "newest-edit-persisted", "dirty-save-new-edit", null, 0, 0],
  [
    "switch-validation-new-edit",
    "new-edit-flushed-before-switch",
    "switch-validation-new-edit",
    null,
    0,
    0,
  ],
  [
    "ingest-switch-delete",
    "switch-busy+ingest-drained+deleted",
    "ingest-switch-delete",
    null,
    0,
    0,
  ],
  [
    "autosave",
    "timer-autosaved-before-switch+new-session-preserved",
    "autosave-switch-interleaving",
    null,
    2,
    0,
  ],
];
const typedFailureResults = new Set([
  "recovery-failed:storage-unavailable",
  "storage-failed",
  "create-failed",
  "flush-failed",
  "delete-failed",
  "delete-unknown",
  "open-failed:old-handle-active",
]);
const evidenceEvents = Array.from({ length: 100 }, (_, seed) =>
  Array.from({ length: 250 }, (_, step) => {
    const [operation, result, fault, recovery, simulatedRestartsDelta, recoveriesDelta] =
      eventTemplates[step % eventTemplates.length];
    return {
      seed,
      step,
      operation,
      fault,
      result,
      recovery,
      effects: { simulatedRestartsDelta, recoveriesDelta },
      state: { status: "ready", drafts: [] },
      expected: { activeDraftId: null, drafts: [] },
    };
  }),
).flat();
const summarizeEvents = (events) => {
  const summary = {
    operationCounts: {},
    faultCounts: {},
    typedFailures: {},
    simulatedRestarts: 0,
    recoveries: 0,
  };
  const increment = (counts, key) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const event of events) {
    increment(summary.operationCounts, event.operation);
    if (event.fault !== null) {
      for (const fault of event.fault.split("+")) increment(summary.faultCounts, fault);
    }
    if (typedFailureResults.has(event.result)) increment(summary.typedFailures, event.result);
    summary.simulatedRestarts += event.effects.simulatedRestartsDelta;
    summary.recoveries += event.effects.recoveriesDelta;
  }
  return summary;
};
const evidenceSeeds = Array.from({ length: 100 }, (_, seed) => ({
  seed,
  digest: digestEvents(evidenceEvents.slice(seed * 250, (seed + 1) * 250)),
}));
const evidenceDigest = digestEvents(evidenceEvents);
const evidenceCounts = summarizeEvents(evidenceEvents);
const evidenceSummary = {
  seedCount: 100,
  stepsPerSeed: 250,
  totalStateMachineSteps: 25000,
  digest: evidenceDigest,
  seeds: evidenceSeeds,
  eventCount: 25000,
  ...evidenceCounts,
  invariantViolations: 0,
};
const evidenceResult = {
  schemaVersion: 1,
  profile: "evidence",
  baseline: evidenceSummary,
  deterministicReplay: { ...evidenceSummary },
  digestsMatch: true,
};
const evidencePayload = {
  baseline: { ...evidenceSummary, events: evidenceEvents },
  deterministicReplay: { ...evidenceSummary },
  digestsMatch: true,
};

const evidenceContractWithEvents = (events, summaryOverrides = {}) => {
  const seeds = Array.from({ length: 100 }, (_, seed) => ({
    seed,
    digest: digestEvents(events.slice(seed * 250, (seed + 1) * 250)),
  }));
  const summary = {
    ...evidenceSummary,
    ...summaryOverrides,
    digest: digestEvents(events),
    seeds,
  };
  return {
    result: {
      ...evidenceResult,
      baseline: summary,
      deterministicReplay: { ...summary },
    },
    payload: {
      ...evidencePayload,
      baseline: { ...summary, events },
      deterministicReplay: { ...summary },
    },
  };
};

test("structured payload and failure markers are removed from visible output", () => {
  assert.deepEqual(
    parseReliabilityOutput(
      'before\nRELIABILITY_RESULT {"profile":"quick"}\nRELIABILITY_PAYLOAD {"digest":"abc"}\nRELIABILITY_FAILURE {"phase":"replay"}\nafter\n',
    ),
    {
      visibleOutput: "before\nafter\n",
      result: { profile: "quick" },
      payload: { digest: "abc" },
      failure: { phase: "replay" },
      parseErrors: [],
    },
  );
});

test("quick and evidence profiles have exact immutable inputs", () => {
  assert.deepEqual(parseRunnerArguments(["quick"]), {
    profile: "quick",
    seed: undefined,
    steps: 125,
  });
  assert.deepEqual(parseRunnerArguments(["evidence"]), {
    profile: "evidence",
    seed: undefined,
    steps: 250,
  });
  assert.throws(() => parseRunnerArguments(["quick", "2"]), /frozen inputs/);
  assert.throws(() => parseRunnerArguments(["evidence", "2", "10"]), /frozen inputs/);
});

test("replay accepts one decimal seed and an optional positive step count", () => {
  assert.deepEqual(parseRunnerArguments(["replay", "2", "17"]), {
    profile: "replay",
    seed: "2",
    steps: 17,
  });
  assert.throws(() => parseRunnerArguments(["replay", "seed"]), /decimal seed/);
});

test("child environment removes every inherited reliability control", () => {
  const environment = buildChildEnvironment(
    {
      PATH: "/bin",
      PLOGKIT_RELIABILITY_PROFILE: "replay",
      PLOGKIT_RELIABILITY_SEED: "2",
      PLOGKIT_RELIABILITY_STEPS: "1",
      PLOGKIT_RELIABILITY_REPORT: "0",
      PLOGKIT_RELIABILITY_ARTIFACT: "1",
      PLOGKIT_RELIABILITY_COMMIT: "wrong",
      PLOGKIT_RELIABILITY_FAILURE_REPORT: "0",
      PLOGKIT_JEST_PATH: "/usr/bin/false",
    },
    { profile: "quick", seed: undefined, steps: 125 },
    "abc123",
  );

  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.PLOGKIT_RELIABILITY_PROFILE, "quick");
  assert.equal(environment.PLOGKIT_RELIABILITY_STEPS, "125");
  assert.equal(environment.PLOGKIT_RELIABILITY_REPORT, "1");
  assert.equal(environment.PLOGKIT_RELIABILITY_COMMIT, "abc123");
  assert.equal(environment.PLOGKIT_RELIABILITY_FAILURE_REPORT, "1");
  assert.equal(environment.PLOGKIT_RELIABILITY_SEED, undefined);
  assert.equal(environment.PLOGKIT_RELIABILITY_ARTIFACT, undefined);
  assert.equal(environment.PLOGKIT_JEST_PATH, undefined);
});

test("baseline eligibility requires identical clean source snapshots", () => {
  const clean = { head: "abc123", status: "" };
  assert.deepEqual(evaluateSourceIdentity(clean, clean), {
    eligibility: "baseline",
    reasons: [],
  });
  assert.deepEqual(evaluateSourceIdentity(clean, { head: "def456", status: " M file.ts" }), {
    eligibility: "diagnostic-only",
    reasons: ["start/end HEAD differ", "end worktree is dirty"],
  });
});

test("quick result contract requires the exact frozen profile", () => {
  assert.deepEqual(
    validateReliabilityContract(
      { profile: "quick", seed: undefined, steps: 125 },
      quickResult,
      null,
    ),
    { valid: true, errors: [] },
  );
  assert.match(
    validateReliabilityContract(
      { profile: "quick", seed: undefined, steps: 125 },
      {
        ...quickResult,
        baseline: { ...quickResult.baseline, totalStateMachineSteps: 125 },
      },
      null,
    ).errors.join("\n"),
    /1,000 state-machine steps/,
  );
});

test("evidence contract validates both full profiles independently", () => {
  assert.deepEqual(
    validateReliabilityContract(
      { profile: "evidence", seed: undefined, steps: 250 },
      evidenceResult,
      evidencePayload,
    ),
    { valid: true, errors: [] },
  );
  assert.match(
    validateReliabilityContract(
      { profile: "evidence", seed: undefined, steps: 250 },
      { ...evidenceResult, digestsMatch: false },
      evidencePayload,
    ).errors.join("\n"),
    /digestsMatch must be true/,
  );
  const invalidEvents = {
    ...evidencePayload,
    baseline: { ...evidencePayload.baseline, events: Array.from({ length: 25000 }, () => ({})) },
  };
  assert.match(
    validateReliabilityContract(
      { profile: "evidence", seed: undefined, steps: 250 },
      evidenceResult,
      invalidEvents,
    ).errors.join("\n"),
    /event 0|canonical event digest/,
  );
});

test("evidence contract rejects an unknown operation even when every digest is synchronized", () => {
  const events = evidenceEvents.slice();
  events[0] = { ...events[0], operation: "reviewer-invented-operation" };
  const forged = evidenceContractWithEvents(events);

  const validation = validateReliabilityContract(
    { profile: "evidence", seed: undefined, steps: 250 },
    forged.result,
    forged.payload,
  );

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /event 0 operation is unknown/);
});

test("evidence contract rejects unknown result and recovery enums with synchronized digests", () => {
  const events = evidenceEvents.slice();
  events[0] = {
    ...events[0],
    result: "reviewer-invented-result",
    recovery: "reviewer-invented-recovery",
  };
  const forged = evidenceContractWithEvents(events);

  const validation = validateReliabilityContract(
    { profile: "evidence", seed: undefined, steps: 250 },
    forged.result,
    forged.payload,
  );

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /event 0 result is unknown/);
  assert.match(validation.errors.join("\n"), /event 0 recovery is unknown/);
});

test("evidence contract rejects the reviewer 25k synchronized fictional event payload", () => {
  const events = evidenceEvents.slice();
  events[0] = {
    ...events[0],
    operation: "reviewer-invented-operation",
    result: "reviewer-invented-result",
    recovery: "reviewer-invented-recovery",
    state: { status: "ready", drafts: [null] },
    expected: { activeDraftId: "invented", drafts: [null] },
  };
  const forged = evidenceContractWithEvents(events);

  const validation = validateReliabilityContract(
    { profile: "evidence", seed: undefined, steps: 250 },
    forged.result,
    forged.payload,
  );

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /event 0 operation is unknown/);
  assert.match(validation.errors.join("\n"), /event 0 recovery is unknown/);
  assert.match(validation.errors.join("\n"), /event 0 public Draft 0 is invalid/);
  assert.match(validation.errors.join("\n"), /event 0 expected Draft 0 is invalid/);
});

test("evidence contract independently rejects synchronized but forged summary counts", () => {
  const forged = evidenceContractWithEvents(evidenceEvents, {
    operationCounts: { create: 24_999 },
  });

  const validation = validateReliabilityContract(
    { profile: "evidence", seed: undefined, steps: 250 },
    forged.result,
    forged.payload,
  );

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /operationCounts do not match canonical events/);
});

test("summary count maps reject unknown, zero, negative, and fractional entries", () => {
  const variants = [
    [{ ...evidenceCounts.operationCounts, invented: 1 }, /unknown key invented/],
    [{ ...evidenceCounts.operationCounts, create: 0 }, /create must be a positive safe integer/],
    [{ ...evidenceCounts.operationCounts, create: -1 }, /create must be a positive safe integer/],
    [{ ...evidenceCounts.operationCounts, create: 1.5 }, /create must be a positive safe integer/],
  ];

  for (const [operationCounts, expectedError] of variants) {
    const forged = evidenceContractWithEvents(evidenceEvents, { operationCounts });
    const validation = validateReliabilityContract(
      { profile: "evidence", seed: undefined, steps: 250 },
      forged.result,
      forged.payload,
    );
    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), expectedError);
  }
});

test("evidence event faults and effects use canonical exact forms", () => {
  const events = evidenceEvents.slice();
  events[0] = {
    ...events[0],
    fault: "read+read+unknown",
    effects: { simulatedRestartsDelta: 1.5, recoveriesDelta: 2 },
  };
  const forged = evidenceContractWithEvents(events);

  const validation = validateReliabilityContract(
    { profile: "evidence", seed: undefined, steps: 250 },
    forged.result,
    forged.payload,
  );

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /event 0 fault is invalid/);
  assert.match(validation.errors.join("\n"), /event 0 effects are invalid/);
});

test("evidence contract rejects honest counters that omit required coverage", () => {
  const events = Array.from({ length: 100 }, (_, seed) =>
    Array.from({ length: 250 }, (_, step) => ({
      seed,
      step,
      operation: "create",
      fault: null,
      result: "created",
      recovery: null,
      effects: { simulatedRestartsDelta: 0, recoveriesDelta: 0 },
      state: { status: "ready", drafts: [] },
      expected: { activeDraftId: null, drafts: [] },
    })),
  ).flat();
  const forged = evidenceContractWithEvents(events, {
    operationCounts: { create: 25_000 },
    faultCounts: {},
    typedFailures: {},
    simulatedRestarts: 0,
    recoveries: 0,
  });

  const validation = validateReliabilityContract(
    { profile: "evidence", seed: undefined, steps: 250 },
    forged.result,
    forged.payload,
  );

  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /missing required operation save/);
  assert.match(validation.errors.join("\n"), /missing required fault read/);
  assert.match(validation.errors.join("\n"), /missing required typed failure delete-unknown/);
  assert.match(validation.errors.join("\n"), /must include a recovery/);
});

test("replay contract binds the result to the requested seed and steps", () => {
  const replayResult = {
    schemaVersion: 1,
    profile: "replay",
    baseline: {
      seedCount: 1,
      stepsPerSeed: 17,
      totalStateMachineSteps: 17,
      digest: sha("e"),
      seeds: [{ seed: 2, digest: sha("f") }],
      eventCount: 17,
      operationCounts: { create: 17 },
      faultCounts: {},
      typedFailures: {},
      simulatedRestarts: 0,
      recoveries: 0,
      invariantViolations: 0,
    },
    deterministicReplay: null,
    digestsMatch: null,
  };
  assert.deepEqual(
    validateReliabilityContract({ profile: "replay", seed: "2", steps: 17 }, replayResult, null),
    { valid: true, errors: [] },
  );
  assert.match(
    validateReliabilityContract(
      { profile: "replay", seed: "3", steps: 17 },
      replayResult,
      null,
    ).errors.join("\n"),
    /frozen sequence/,
  );
});

test("evidence orchestration rejects missing and malformed payloads", () => {
  const configuration = { profile: "evidence", seed: undefined, steps: 250 };
  const missing = assessReliabilityRun({
    configuration,
    exitStatus: 0,
    spawnError: null,
    parsedOutput: {
      visibleOutput: "",
      result: evidenceResult,
      payload: null,
      failure: null,
      parseErrors: [],
    },
  });
  assert.equal(missing.status, "failure");
  assert.match(missing.errors.join("\n"), /evidence payload is missing/);

  const malformedOutput = parseReliabilityOutput(
    `RELIABILITY_RESULT ${JSON.stringify(evidenceResult)}\nRELIABILITY_PAYLOAD {bad json}\n`,
  );
  const malformed = assessReliabilityRun({
    configuration,
    exitStatus: 0,
    spawnError: null,
    parsedOutput: malformedOutput,
  });
  assert.equal(malformed.status, "failure");
  assert.match(malformed.errors.join("\n"), /malformed RELIABILITY_PAYLOAD/);
});

test("orchestration fails closed when tests do not run or output is untrusted", (t) => {
  const configuration = { profile: "quick", seed: undefined, steps: 125 };
  const missing = assessReliabilityRun({
    configuration,
    exitStatus: 0,
    spawnError: null,
    parsedOutput: parseReliabilityOutput("Jest exited without running the suite\n"),
  });
  assert.equal(missing.status, "failure");
  assert.match(missing.errors.join("\n"), /result marker is missing/);

  const malformedOutput = parseReliabilityOutput("RELIABILITY_RESULT {bad json}\n");
  const malformed = assessReliabilityRun({
    configuration,
    exitStatus: 0,
    spawnError: null,
    parsedOutput: malformedOutput,
  });
  assert.equal(malformed.status, "failure");
  assert.match(malformed.errors.join("\n"), /malformed RELIABILITY_RESULT/);

  const mismatch = assessReliabilityRun({
    configuration,
    exitStatus: 0,
    spawnError: null,
    parsedOutput: {
      visibleOutput: "",
      result: { ...quickResult, baseline: { ...quickResult.baseline, seedCount: 1 } },
      payload: null,
      failure: null,
      parseErrors: [],
    },
  });
  assert.equal(mismatch.status, "failure");
  assert.match(mismatch.errors.join("\n"), /8 seeds/);

  const root = createTemporaryTestDirectory(t, "plogkit-reliability-failure-");
  const directory = publishArtifactAtomically({
    artifactRoot: root,
    directoryName: "failed",
    files: buildFailureArtifactFiles({
      common: { schemaVersion: 1, profile: "quick" },
      exitStatus: 0,
      assessment: mismatch,
      parsedOutput: {
        visibleOutput: "",
        result: null,
        payload: null,
        failure: null,
        parseErrors: [],
      },
      stdout: "untrusted output",
      stderr: "",
    }),
    processId: 43,
  });
  const saved = JSON.parse(readFileSync(join(directory, "failure.json"), "utf8"));
  assert.match(saved.failure.runnerErrors.join("\n"), /8 seeds/);
  assert.equal(saved.stdout, "untrusted output");
});

test("artifact publication atomically exposes only the completed directory", (t) => {
  const root = createTemporaryTestDirectory(t, "plogkit-reliability-helper-");
  const directory = publishArtifactAtomically({
    artifactRoot: root,
    directoryName: "result",
    files: { "summary.json": '{"ok":true}\n' },
    processId: 42,
  });

  assert.equal(directory, join(root, "result"));
  assert.equal(existsSync(join(root, "result.tmp-42")), false);
  assert.deepEqual(readdirSync(root), ["result"]);
  assert.equal(readFileSync(join(directory, "summary.json"), "utf8"), '{"ok":true}\n');
});

test("run.mjs process fails closed and publishes only failure artifacts for untrusted Jest", (t) => {
  const runnerDirectory = fileURLToPath(new URL(".", import.meta.url));
  const forgedCounterContract = evidenceContractWithEvents(evidenceEvents, {
    operationCounts: {
      ...evidenceCounts.operationCounts,
      create: evidenceCounts.operationCounts.create - 1,
    },
  });
  const scenarios = [
    { name: "missing", profile: "quick", script: "exit 0" },
    {
      name: "malformed",
      profile: "quick",
      script: "printf '%s\\n' 'RELIABILITY_RESULT {bad json}'; exit 0",
    },
    {
      name: "mismatch",
      profile: "quick",
      script: "printf '%s\\n' 'RELIABILITY_RESULT {}'; exit 0",
    },
    {
      name: "missing-payload",
      profile: "evidence",
      script: `printf '%s\\n' 'RELIABILITY_RESULT ${JSON.stringify(evidenceResult)}'; exit 0`,
    },
    {
      name: "malformed-payload",
      profile: "evidence",
      script:
        `printf '%s\\n' 'RELIABILITY_RESULT ${JSON.stringify(evidenceResult)}'; ` +
        "printf '%s\\n' 'RELIABILITY_PAYLOAD {bad json}'; exit 0",
    },
    {
      name: "forged-counters",
      profile: "evidence",
      output:
        `RELIABILITY_RESULT ${JSON.stringify(forgedCounterContract.result)}\n` +
        `RELIABILITY_PAYLOAD ${JSON.stringify(forgedCounterContract.payload)}\n`,
    },
    {
      name: "nonzero",
      profile: "quick",
      script:
        'printf \'%s\\n\' \'RELIABILITY_FAILURE {"schemaVersion":1,"message":"failed"}\'; exit 7',
    },
    { name: "spawn", profile: "quick", script: null },
  ];

  for (const scenario of scenarios) {
    const root = createTemporaryTestDirectory(t, `plogkit-runner-${scenario.name}-`);
    const target = join(root, "scripts", "reliability-soak");
    mkdirSync(target, { recursive: true });
    copyFileSync(join(runnerDirectory, "run.mjs"), join(target, "run.mjs"));
    copyFileSync(join(runnerDirectory, "runnerSupport.mjs"), join(target, "runnerSupport.mjs"));
    copyFileSync(join(runnerDirectory, "event-contract.json"), join(target, "event-contract.json"));
    writeFileSync(join(root, ".gitignore"), "/artifacts/\n");
    if (scenario.script !== null) {
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      const fakeJest = join(bin, "jest");
      if (scenario.output !== undefined) {
        writeFileSync(join(root, "fake-output.txt"), scenario.output);
      }
      writeFileSync(
        fakeJest,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '29.fake'; exit 0; fi\n` +
          `if [ -f fake-output.txt ]; then command cat fake-output.txt; exit 0; fi\n` +
          `${scenario.script ?? "exit 0"}\n`,
      );
      chmodSync(fakeJest, 0o755);
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Reliability Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "reliability@example.invalid"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });

    const result = spawnSync(process.execPath, [join(target, "run.mjs"), scenario.profile], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: root,
        TMP: root,
        TMPDIR: root,
      },
    });
    assert.notEqual(result.status, 0, `${scenario.name} unexpectedly succeeded`);
    const artifactFiles = readdirSync(join(root, "artifacts"), { recursive: true }).map(String);
    assert.equal(
      artifactFiles.filter((path) => path.endsWith("failure.json")).length,
      1,
      scenario.name,
    );
    assert.equal(
      artifactFiles.some((path) => path.endsWith("summary.json")),
      false,
      scenario.name,
    );
    assert.equal(
      artifactFiles.some((path) => path.endsWith("events.jsonl")),
      false,
      scenario.name,
    );
    assert.equal(
      artifactFiles.some((path) => path.includes(".tmp-")),
      false,
      scenario.name,
    );
  }
});
