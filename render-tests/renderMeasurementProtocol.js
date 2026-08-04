const FROZEN_CASE_MANIFEST = [
  {
    caseId: "export-1-original-jpeg",
    imageCount: 1,
    operation: "export",
    presetId: "original",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 1200, height: 800, format: "jpeg" }],
  },
  {
    caseId: "export-1-original-png",
    imageCount: 1,
    operation: "export",
    presetId: "original",
    format: "png",
    expectedOutputs: [{ id: "export", width: 1200, height: 800, format: "png" }],
  },
  {
    caseId: "export-1-social-jpeg",
    imageCount: 1,
    operation: "export",
    presetId: "social",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 1200, height: 800, format: "jpeg" }],
  },
  {
    caseId: "export-1-compact-jpeg",
    imageCount: 1,
    operation: "export",
    presetId: "compact",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 1200, height: 800, format: "jpeg" }],
  },
  {
    caseId: "thumbnail-1-pair",
    imageCount: 1,
    operation: "thumbnail",
    format: "jpeg",
    expectedOutputs: [
      { id: "square", width: 360, height: 360, format: "jpeg" },
      { id: "original", width: 720, height: 480, format: "jpeg" },
    ],
  },
  {
    caseId: "export-3-original-jpeg",
    imageCount: 3,
    operation: "export",
    presetId: "original",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 1200, height: 3200, format: "jpeg" }],
  },
  {
    caseId: "export-3-original-png",
    imageCount: 3,
    operation: "export",
    presetId: "original",
    format: "png",
    expectedOutputs: [{ id: "export", width: 1200, height: 3200, format: "png" }],
  },
  {
    caseId: "export-3-social-jpeg",
    imageCount: 3,
    operation: "export",
    presetId: "social",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 768, height: 2048, format: "jpeg" }],
  },
  {
    caseId: "export-3-compact-jpeg",
    imageCount: 3,
    operation: "export",
    presetId: "compact",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 480, height: 1280, format: "jpeg" }],
  },
  {
    caseId: "thumbnail-3-pair",
    imageCount: 3,
    operation: "thumbnail",
    format: "jpeg",
    expectedOutputs: [
      { id: "square", width: 360, height: 360, format: "jpeg" },
      { id: "original", width: 270, height: 720, format: "jpeg" },
    ],
  },
  {
    caseId: "export-9-original-jpeg",
    imageCount: 9,
    operation: "export",
    presetId: "original",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 1200, height: 10400, format: "jpeg" }],
  },
  {
    caseId: "export-9-original-png",
    imageCount: 9,
    operation: "export",
    presetId: "original",
    format: "png",
    expectedOutputs: [{ id: "export", width: 1200, height: 10400, format: "png" }],
  },
  {
    caseId: "export-9-social-jpeg",
    imageCount: 9,
    operation: "export",
    presetId: "social",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 236, height: 2048, format: "jpeg" }],
  },
  {
    caseId: "export-9-compact-jpeg",
    imageCount: 9,
    operation: "export",
    presetId: "compact",
    format: "jpeg",
    expectedOutputs: [{ id: "export", width: 147, height: 1280, format: "jpeg" }],
  },
  {
    caseId: "thumbnail-9-pair",
    imageCount: 9,
    operation: "thumbnail",
    format: "jpeg",
    expectedOutputs: [
      { id: "square", width: 360, height: 360, format: "jpeg" },
      { id: "original", width: 83, height: 720, format: "jpeg" },
    ],
  },
];

export function createHeadlessMeasurementPlan(profile = "full") {
  if (profile !== "full" && profile !== "smoke") {
    throw new Error(`unsupported render measurement profile: ${profile}`);
  }
  const measuredRuns = profile === "full" ? 3 : 1;
  return FROZEN_CASE_MANIFEST.map((measurementCase) => ({
    ...measurementCase,
    expectedOutputIds: measurementCase.expectedOutputs.map(({ id }) => id),
    expectedOutputs: measurementCase.expectedOutputs.map((output) => ({ ...output })),
    warmupRuns: 1,
    measuredRuns,
  }));
}

function rotate(values, offset) {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function createMeasurementSchedule(plan) {
  const schedule = [];
  const maxWarmupRuns = Math.max(0, ...plan.map(({ warmupRuns }) => warmupRuns));
  for (let round = 0; round < maxWarmupRuns; round += 1) {
    for (const measurementCase of plan.filter(({ warmupRuns }) => warmupRuns > round)) {
      schedule.push({
        caseId: measurementCase.caseId,
        phase: "warmup",
        sampleIndex: round,
        round,
      });
    }
  }

  const maxMeasuredRuns = Math.max(0, ...plan.map(({ measuredRuns }) => measuredRuns));
  for (let round = 0; round < maxMeasuredRuns; round += 1) {
    const cases = plan.filter(({ measuredRuns }) => measuredRuns > round);
    const offset = Math.floor((round * cases.length) / maxMeasuredRuns);
    for (const measurementCase of rotate(cases, offset)) {
      schedule.push({
        caseId: measurementCase.caseId,
        phase: "measured",
        sampleIndex: round + 1,
        round,
      });
    }
  }
  return schedule;
}

export function createMeasurementBlocks(schedule) {
  const blocks = [];
  for (const entry of schedule) {
    const id = `${entry.phase}-round-${entry.round}`;
    const current = blocks.at(-1);
    if (current?.id === id) current.entries.push(entry);
    else blocks.push({ id, phase: entry.phase, round: entry.round, entries: [entry] });
  }
  return blocks;
}

export async function measurePublicOperation(operation, now = () => performance.now()) {
  const startedAt = now();
  try {
    const value = await operation();
    return {
      elapsedMs: now() - startedAt,
      outcome: { status: "returned", value },
    };
  } catch (error) {
    return {
      elapsedMs: now() - startedAt,
      outcome: { status: "threw", error },
    };
  }
}

export function detectRepositoryStateDrift(start, end) {
  return JSON.stringify(start) === JSON.stringify(end)
    ? []
    : ["repository-state-changed-during-run"];
}

export function aggregateRunEligibility(preflight, samples) {
  const environmentReasons = [
    ...new Set([
      ...preflight.reasons,
      ...samples.flatMap(({ eligibility }) => eligibility.reasons),
    ]),
  ];
  const environmentEligible =
    preflight.eligible &&
    samples.every(({ eligibility }) => eligibility.eligibleForEngineeringBaseline) &&
    environmentReasons.length === 0;
  const failureCount = samples.filter(({ status }) => status !== "success").length;
  const functionalReasons = failureCount === 0 ? [] : ["render-sample-failure"];
  const reasons = [...environmentReasons, ...functionalReasons];
  const eligible = environmentEligible && failureCount === 0;
  return {
    ...preflight,
    eligible,
    resultClass: eligible ? "engineering-baseline" : "diagnostic",
    reasons,
    environmentEligibility: { eligible: environmentEligible, reasons: environmentReasons },
    functionalOutcome: {
      successful: failureCount === 0,
      failureCount,
      reasons: functionalReasons,
    },
  };
}

export function createHeadlessExecutionContext() {
  return {
    runtime: "headless-canvaskit",
    resultClass: "eligibility-gated",
    headlineEligible: false,
    processState: "warm-in-process",
    measurementMode: "timing",
    profilerAttached: false,
    metro: "not-applicable",
    debugger: "not-applicable",
    build: {
      kind: "source-headless",
      releaseLike: false,
      embeddedJsBundle: "not-applicable",
    },
    device: {
      model: null,
      os: null,
      ramBytes: null,
      availableStorageBytes: null,
      batteryPercent: null,
      lowPowerMode: null,
      thermalState: "unavailable",
    },
    hostIsolation: "captured-in-run-eligibility-and-host-state",
    boundary:
      "Mac/CanvasKit timings are host-dependent engineering data and must not be reported as physical-device headline results.",
  };
}
