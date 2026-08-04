import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONTROL_VARIABLES = [
  "PLOGKIT_RELIABILITY_PROFILE",
  "PLOGKIT_RELIABILITY_SEED",
  "PLOGKIT_RELIABILITY_STEPS",
  "PLOGKIT_RELIABILITY_REPORT",
  "PLOGKIT_RELIABILITY_ARTIFACT",
  "PLOGKIT_RELIABILITY_COMMIT",
  "PLOGKIT_RELIABILITY_FAILURE_REPORT",
  "PLOGKIT_JEST_PATH",
];

export function parseRunnerArguments(rawArguments) {
  const args = rawArguments.filter((argument) => argument !== "--");
  const [profile = "quick", seed, requestedSteps, ...extra] = args;
  if (!new Set(["quick", "evidence", "replay"]).has(profile)) {
    throw new Error(`unknown reliability profile: ${profile}`);
  }
  if (
    profile !== "replay" &&
    (seed !== undefined || requestedSteps !== undefined || extra.length > 0)
  ) {
    throw new Error(`${profile} profile has frozen inputs and accepts no arguments`);
  }
  if (profile === "replay" && (seed === undefined || !/^\d+$/.test(seed) || extra.length > 0)) {
    throw new Error("replay requires a decimal seed and accepts at most one steps argument");
  }
  const steps =
    profile === "quick" ? 125 : profile === "evidence" ? 250 : Number(requestedSteps ?? 250);
  if (!Number.isInteger(steps) || steps <= 0) throw new Error("steps must be a positive integer");
  return { profile, seed: profile === "replay" ? seed : undefined, steps };
}

export function buildChildEnvironment(hostEnvironment, configuration, commit) {
  const environment = { ...hostEnvironment };
  for (const variable of CONTROL_VARIABLES) delete environment[variable];
  environment.PLOGKIT_RELIABILITY_PROFILE = configuration.profile;
  environment.PLOGKIT_RELIABILITY_STEPS = String(configuration.steps);
  environment.PLOGKIT_RELIABILITY_REPORT = "1";
  environment.PLOGKIT_RELIABILITY_COMMIT = commit;
  environment.PLOGKIT_RELIABILITY_FAILURE_REPORT = "1";
  if (configuration.profile === "replay") {
    environment.PLOGKIT_RELIABILITY_SEED = configuration.seed;
  }
  if (configuration.profile === "evidence") {
    environment.PLOGKIT_RELIABILITY_ARTIFACT = "1";
  }
  return environment;
}

export function evaluateSourceIdentity(start, end) {
  const reasons = [];
  if (start.head !== end.head) reasons.push("start/end HEAD differ");
  if (start.status !== "") reasons.push("start worktree is dirty");
  if (end.status !== "") reasons.push("end worktree is dirty");
  return {
    eligibility: reasons.length === 0 ? "baseline" : "diagnostic-only",
    reasons,
  };
}

export function parseReliabilityOutput(stdout) {
  const lines = stdout.split("\n");
  const parseErrors = [];
  const parseMarker = (name) => {
    const prefix = `${name} `;
    const matches = lines.filter((line) => line.startsWith(prefix));
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      parseErrors.push(`duplicate ${name} markers`);
      return null;
    }
    try {
      return JSON.parse(matches[0].slice(prefix.length));
    } catch (error) {
      parseErrors.push(
        `malformed ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
  return {
    visibleOutput: lines
      .filter(
        (line) =>
          !line.startsWith("RELIABILITY_RESULT ") &&
          !line.startsWith("RELIABILITY_PAYLOAD ") &&
          !line.startsWith("RELIABILITY_FAILURE "),
      )
      .join("\n"),
    result: parseMarker("RELIABILITY_RESULT"),
    payload: parseMarker("RELIABILITY_PAYLOAD"),
    failure: parseMarker("RELIABILITY_FAILURE"),
    parseErrors,
  };
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hasExactKeys = (value, keys) =>
  isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const isDraftSnapshot = (value) =>
  hasExactKeys(value, ["draftId", "color", "photoCount", "contentRevision"]) &&
  typeof value.draftId === "string" &&
  value.draftId.length > 0 &&
  typeof value.color === "string" &&
  /^#[a-f0-9]{6}$/i.test(value.color) &&
  Number.isSafeInteger(value.photoCount) &&
  value.photoCount > 0 &&
  Number.isSafeInteger(value.contentRevision) &&
  value.contentRevision > 0;
const hasSortedUniqueDrafts = (drafts) => {
  const ids = drafts.map((draft) => draft?.draftId);
  return (
    new Set(ids).size === ids.length && JSON.stringify(ids) === JSON.stringify([...ids].sort())
  );
};
const eventContract = JSON.parse(
  readFileSync(new URL("./event-contract.json", import.meta.url), "utf8"),
);
const allowedFaults = new Set(
  Object.values(eventContract.operations).flatMap((policy) => policy.faults),
);
const canonicalCountMap = (value) =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : null;

function validateCountMap(value, allowedKeys, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} is missing`);
    return;
  }
  for (const [key, count] of Object.entries(value)) {
    if (!allowedKeys.has(key)) errors.push(`${label} contains unknown key ${key}`);
    if (!Number.isSafeInteger(count) || count <= 0) {
      errors.push(`${label} ${key} must be a positive safe integer`);
    }
  }
}

export function digestCanonicalEvents(events) {
  return createHash("sha256")
    .update(events.map((event) => JSON.stringify(event)).join("\n"))
    .digest("hex");
}

function validateProfileSummary(summary, expected, label, errors, requireEventCount) {
  if (!isRecord(summary)) {
    errors.push(`${label} summary is missing`);
    return;
  }
  if (summary.seedCount !== expected.seeds.length) {
    errors.push(`${label} must contain exactly ${expected.seeds.length} seeds`);
  }
  if (summary.stepsPerSeed !== expected.steps) {
    errors.push(`${label} must use exactly ${expected.steps} steps per seed`);
  }
  if (summary.totalStateMachineSteps !== expected.total) {
    errors.push(
      `${label} must contain exactly ${expected.total.toLocaleString("en-US")} state-machine steps`,
    );
  }
  if (!isSha256(summary.digest)) errors.push(`${label} digest must be 64 lowercase hex characters`);
  if (summary.invariantViolations !== 0) errors.push(`${label} invariantViolations must be 0`);
  validateCountMap(
    summary.operationCounts,
    new Set(Object.keys(eventContract.operations)),
    `${label} operationCounts`,
    errors,
  );
  validateCountMap(summary.faultCounts, allowedFaults, `${label} faultCounts`, errors);
  validateCountMap(
    summary.typedFailures,
    new Set(eventContract.typedFailureResults),
    `${label} typedFailures`,
    errors,
  );
  if (!Number.isSafeInteger(summary.simulatedRestarts) || summary.simulatedRestarts < 0) {
    errors.push(`${label} simulatedRestarts must be a nonnegative safe integer`);
  }
  if (
    !Number.isSafeInteger(summary.recoveries) ||
    summary.recoveries < 0 ||
    summary.recoveries > summary.simulatedRestarts
  ) {
    errors.push(`${label} recoveries must be a valid nonnegative restart subset`);
  }
  if (
    isRecord(summary.operationCounts) &&
    Object.values(summary.operationCounts).every((count) => Number.isSafeInteger(count)) &&
    Object.values(summary.operationCounts).reduce((total, count) => total + count, 0) !==
      expected.total
  ) {
    errors.push(`${label} operationCounts must sum to ${expected.total}`);
  }
  if (requireEventCount && summary.eventCount !== expected.total) {
    errors.push(`${label} eventCount must be exactly ${expected.total}`);
  }
  if (!Array.isArray(summary.seeds) || summary.seeds.length !== expected.seeds.length) {
    errors.push(`${label} seed summaries are incomplete`);
    return;
  }
  const actualSeeds = summary.seeds.map((item) => (isRecord(item) ? item.seed : null));
  if (JSON.stringify(actualSeeds) !== JSON.stringify(expected.seeds)) {
    errors.push(`${label} seeds do not match the frozen sequence`);
  }
  if (summary.seeds.some((item) => !isRecord(item) || !isSha256(item.digest))) {
    errors.push(`${label} per-seed digests must be 64 lowercase hex characters`);
  }
}

function validateEvidenceEvents(events, baseline, replay, result, errors) {
  if (!Array.isArray(events) || events.length !== 25000) return;
  const derived = {
    operationCounts: {},
    faultCounts: {},
    typedFailures: {},
    simulatedRestarts: 0,
    recoveries: 0,
  };
  const increment = (counts, key) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  let structuralErrors = 0;
  const reportEventError = (message) => {
    structuralErrors += 1;
    if (structuralErrors <= 20) errors.push(message);
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedSeed = Math.floor(index / 250);
    const expectedStep = index % 250;
    if (!isRecord(event)) {
      reportEventError(`evidence event ${index} must be an object`);
      continue;
    }
    if (
      !hasExactKeys(event, [
        "seed",
        "step",
        "operation",
        "fault",
        "result",
        "recovery",
        "effects",
        "state",
        "expected",
      ])
    ) {
      reportEventError(`evidence event ${index} shape is invalid`);
    }
    if (event.seed !== expectedSeed || event.step !== expectedStep) {
      reportEventError(
        `evidence event ${index} must be seed ${expectedSeed}, step ${expectedStep}`,
      );
    }
    const operationPolicy = Object.hasOwn(eventContract.operations, event.operation)
      ? eventContract.operations[event.operation]
      : null;
    if (operationPolicy === null) {
      reportEventError(`evidence event ${index} operation is unknown`);
    } else {
      increment(derived.operationCounts, event.operation);
    }
    const expectedFault = operationPolicy?.faults.length
      ? [...operationPolicy.faults].sort().join("+")
      : null;
    if (event.fault !== expectedFault) {
      reportEventError(`evidence event ${index} fault is invalid for ${event.operation}`);
    } else if (event.fault !== null) {
      for (const fault of event.fault.split("+")) increment(derived.faultCounts, fault);
    }
    if (operationPolicy !== null && !operationPolicy.results.includes(event.result)) {
      reportEventError(`evidence event ${index} result is unknown for ${event.operation}`);
    } else if (eventContract.typedFailureResults.includes(event.result)) {
      increment(derived.typedFailures, event.result);
    }
    if (event.recovery !== null && !eventContract.recoveryStatuses.includes(event.recovery)) {
      reportEventError(`evidence event ${index} recovery is unknown`);
    }
    if (
      !hasExactKeys(event.effects, ["simulatedRestartsDelta", "recoveriesDelta"]) ||
      !Number.isSafeInteger(event.effects.simulatedRestartsDelta) ||
      event.effects.simulatedRestartsDelta < 0 ||
      !Number.isSafeInteger(event.effects.recoveriesDelta) ||
      event.effects.recoveriesDelta < 0 ||
      event.effects.recoveriesDelta > event.effects.simulatedRestartsDelta
    ) {
      reportEventError(`evidence event ${index} effects are invalid`);
    } else {
      derived.simulatedRestarts += event.effects.simulatedRestartsDelta;
      derived.recoveries += event.effects.recoveriesDelta;
      const expectedRecovery = event.effects.recoveriesDelta > 0 ? "converged-after-restart" : null;
      if (event.recovery !== expectedRecovery) {
        reportEventError(`evidence event ${index} recovery does not match its effects`);
      }
    }
    if (
      !hasExactKeys(event.state, ["status", "drafts"]) ||
      !eventContract.stateStatuses.includes(event.state.status) ||
      !Array.isArray(event.state.drafts)
    ) {
      reportEventError(`evidence event ${index} public state is invalid`);
    } else {
      event.state.drafts.forEach((draft, draftIndex) => {
        if (!isDraftSnapshot(draft)) {
          reportEventError(`evidence event ${index} public Draft ${draftIndex} is invalid`);
        }
      });
      if (!hasSortedUniqueDrafts(event.state.drafts)) {
        reportEventError(`evidence event ${index} public Drafts are not sorted and unique`);
      }
    }
    if (
      !hasExactKeys(event.expected, ["activeDraftId", "drafts"]) ||
      (event.expected.activeDraftId !== null && typeof event.expected.activeDraftId !== "string") ||
      !Array.isArray(event.expected.drafts)
    ) {
      reportEventError(`evidence event ${index} expected state is invalid`);
    } else {
      event.expected.drafts.forEach((draft, draftIndex) => {
        if (!isDraftSnapshot(draft)) {
          reportEventError(`evidence event ${index} expected Draft ${draftIndex} is invalid`);
        }
      });
      if (!hasSortedUniqueDrafts(event.expected.drafts)) {
        reportEventError(`evidence event ${index} expected Drafts are not sorted and unique`);
      }
      if (
        event.expected.activeDraftId !== null &&
        !event.expected.drafts.some((draft) => draft?.draftId === event.expected.activeDraftId)
      ) {
        reportEventError(`evidence event ${index} active Draft is absent from expected state`);
      }
    }
    if (
      isRecord(event.state) &&
      Array.isArray(event.state.drafts) &&
      isRecord(event.expected) &&
      Array.isArray(event.expected.drafts) &&
      JSON.stringify(event.state.drafts) !== JSON.stringify(event.expected.drafts)
    ) {
      reportEventError(`evidence event ${index} public and expected Draft state diverge`);
    }
  }
  if (structuralErrors > 20) {
    errors.push(`evidence events contain ${structuralErrors} structural errors`);
  }

  const canonicalDigest = digestCanonicalEvents(events);
  if (baseline.digest !== canonicalDigest) {
    errors.push("evidence payload baseline digest does not match the canonical event digest");
  }
  for (let seed = 0; seed < 100; seed += 1) {
    const digest = digestCanonicalEvents(events.slice(seed * 250, (seed + 1) * 250));
    if (baseline.seeds?.[seed]?.digest !== digest) {
      errors.push(`evidence payload seed ${seed} digest does not match its canonical event slice`);
    }
    if (replay.seeds?.[seed]?.digest !== digest) {
      errors.push(`evidence replay seed ${seed} digest does not match the baseline event slice`);
    }
    if (
      result.baseline?.seeds?.[seed]?.digest !== digest ||
      result.deterministicReplay?.seeds?.[seed]?.digest !== digest
    ) {
      errors.push(`evidence result seed ${seed} digest does not match the baseline event slice`);
    }
  }
  const summaries = [
    [baseline, "evidence payload baseline"],
    [replay, "evidence payload replay"],
    [result.baseline, "evidence result baseline"],
    [result.deterministicReplay, "evidence result replay"],
  ];
  for (const [summary, label] of summaries) {
    for (const key of ["operationCounts", "faultCounts", "typedFailures"]) {
      if (
        JSON.stringify(canonicalCountMap(summary?.[key])) !==
        JSON.stringify(canonicalCountMap(derived[key]))
      ) {
        errors.push(`${label} ${key} do not match canonical events`);
      }
    }
    if (summary?.simulatedRestarts !== derived.simulatedRestarts) {
      errors.push(`${label} simulatedRestarts do not match canonical events`);
    }
    if (summary?.recoveries !== derived.recoveries) {
      errors.push(`${label} recoveries do not match canonical events`);
    }
  }
  for (const operation of Object.keys(eventContract.operations)) {
    if ((derived.operationCounts[operation] ?? 0) === 0) {
      errors.push(`evidence canonical events are missing required operation ${operation}`);
    }
  }
  for (const fault of allowedFaults) {
    if ((derived.faultCounts[fault] ?? 0) === 0) {
      errors.push(`evidence canonical events are missing required fault ${fault}`);
    }
  }
  if ((derived.typedFailures["delete-unknown"] ?? 0) === 0) {
    errors.push("evidence canonical events are missing required typed failure delete-unknown");
  }
  if (derived.recoveries === 0) {
    errors.push("evidence canonical events must include a recovery");
  }
}

export function validateReliabilityContract(configuration, result, payload) {
  const errors = [];
  if (!isRecord(result)) return { valid: false, errors: ["reliability result marker is missing"] };
  if (result.schemaVersion !== 1) errors.push("reliability result schemaVersion must be 1");
  if (result.profile !== configuration.profile)
    errors.push("result profile does not match the runner");

  const expected =
    configuration.profile === "quick"
      ? { seeds: [1, 7, 42, 99, 256, 1001, 12345, 12648430], steps: 125, total: 1000 }
      : configuration.profile === "evidence"
        ? { seeds: Array.from({ length: 100 }, (_, index) => index), steps: 250, total: 25000 }
        : {
            seeds: [Number(configuration.seed)],
            steps: configuration.steps,
            total: configuration.steps,
          };
  validateProfileSummary(
    result.baseline,
    expected,
    `${configuration.profile} baseline`,
    errors,
    true,
  );

  if (configuration.profile === "evidence") {
    validateProfileSummary(
      result.deterministicReplay,
      expected,
      "evidence deterministic replay",
      errors,
      true,
    );
    if (result.digestsMatch !== true) errors.push("evidence digestsMatch must be true");
    if (
      isRecord(result.baseline) &&
      isRecord(result.deterministicReplay) &&
      result.baseline.digest !== result.deterministicReplay.digest
    ) {
      errors.push("evidence baseline and replay digests must match");
    }
    if (!isRecord(payload)) {
      errors.push("evidence payload is missing");
    } else {
      const baseline = payload.baseline;
      const replay = payload.deterministicReplay;
      validateProfileSummary(baseline, expected, "evidence payload baseline", errors, false);
      validateProfileSummary(replay, expected, "evidence payload replay", errors, false);
      if (!isRecord(baseline) || !Array.isArray(baseline.events)) {
        errors.push("evidence payload baseline events are missing");
      } else if (baseline.events.length !== 25000) {
        errors.push("evidence payload must contain exactly 25000 baseline events");
      } else if (isRecord(replay)) {
        validateEvidenceEvents(baseline.events, baseline, replay, result, errors);
      }
      if (payload.digestsMatch !== true) errors.push("evidence payload digestsMatch must be true");
      if (
        isRecord(baseline) &&
        isRecord(replay) &&
        (baseline.digest !== replay.digest ||
          baseline.digest !== result.baseline?.digest ||
          replay.digest !== result.deterministicReplay?.digest)
      ) {
        errors.push("evidence payload digests do not match the validated result");
      }
    }
  } else {
    if (result.deterministicReplay !== null) {
      errors.push(`${configuration.profile} deterministicReplay must be null`);
    }
    if (result.digestsMatch !== null)
      errors.push(`${configuration.profile} digestsMatch must be null`);
    if (payload !== null) errors.push(`${configuration.profile} must not emit an evidence payload`);
  }

  return { valid: errors.length === 0, errors };
}

export function assessReliabilityRun({ configuration, exitStatus, spawnError, parsedOutput }) {
  const errors = [...parsedOutput.parseErrors];
  if (spawnError !== null && spawnError !== undefined) {
    errors.push(
      `Jest failed to start: ${spawnError instanceof Error ? spawnError.message : spawnError}`,
    );
  }
  if (exitStatus !== 0) errors.push(`Jest exited with status ${exitStatus ?? "unknown"}`);
  if (parsedOutput.result === null) errors.push("reliability result marker is missing");
  if (parsedOutput.failure !== null) errors.push("Jest emitted a reliability failure marker");
  if (parsedOutput.result !== null) {
    errors.push(
      ...validateReliabilityContract(configuration, parsedOutput.result, parsedOutput.payload)
        .errors,
    );
  }
  return {
    status: errors.length === 0 ? "success" : "failure",
    errors,
  };
}

export function buildFailureArtifactFiles({
  common,
  exitStatus,
  assessment,
  parsedOutput,
  stdout,
  stderr,
}) {
  return {
    "failure.json": `${JSON.stringify(
      {
        ...common,
        exitStatus,
        failure: {
          schemaVersion: 1,
          runnerErrors: assessment.errors,
          reportedFailure: parsedOutput.failure,
        },
        stdout,
        stderr,
      },
      null,
      2,
    )}\n`,
  };
}

export function publishArtifactAtomically({
  artifactRoot,
  directoryName,
  files,
  processId = process.pid,
}) {
  const directory = join(artifactRoot, directoryName);
  const temporary = `${directory}.tmp-${processId}`;
  mkdirSync(temporary, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(temporary, name), content);
  }
  mkdirSync(artifactRoot, { recursive: true });
  renameSync(temporary, directory);
  return directory;
}
