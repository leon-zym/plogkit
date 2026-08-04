import {
  aggregateRunEligibility,
  createHeadlessExecutionContext,
  createHeadlessMeasurementPlan,
  createMeasurementBlocks,
  createMeasurementSchedule,
  detectRepositoryStateDrift,
  measurePublicOperation,
} from "./renderMeasurementProtocol";

describe("headless render measurement protocol", () => {
  it("freezes the 1/3/9 export and two-target thumbnail matrix", () => {
    const plan = createHeadlessMeasurementPlan("full");

    expect(plan.map(({ caseId }) => caseId)).toEqual([
      "export-1-original-jpeg",
      "export-1-original-png",
      "export-1-social-jpeg",
      "export-1-compact-jpeg",
      "thumbnail-1-pair",
      "export-3-original-jpeg",
      "export-3-original-png",
      "export-3-social-jpeg",
      "export-3-compact-jpeg",
      "thumbnail-3-pair",
      "export-9-original-jpeg",
      "export-9-original-png",
      "export-9-social-jpeg",
      "export-9-compact-jpeg",
      "thumbnail-9-pair",
    ]);
    expect(plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: "export-9-original-png",
          imageCount: 9,
          operation: "export",
          presetId: "original",
          format: "png",
          warmupRuns: 1,
          measuredRuns: 3,
          expectedOutputIds: ["export"],
          expectedOutputs: [{ id: "export", width: 1200, height: 10400, format: "png" }],
        }),
        expect.objectContaining({
          caseId: "thumbnail-9-pair",
          imageCount: 9,
          operation: "thumbnail",
          format: "jpeg",
          warmupRuns: 1,
          measuredRuns: 3,
          expectedOutputIds: ["square", "original"],
          expectedOutputs: [
            { id: "square", width: 360, height: 360, format: "jpeg" },
            { id: "original", width: 83, height: 720, format: "jpeg" },
          ],
        }),
      ]),
    );
  });

  it("labels CanvasKit results as a host-dependent engineering baseline", () => {
    expect(createHeadlessExecutionContext()).toEqual({
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
    });
  });

  it("warms every case before rotating case order across measured rounds", () => {
    const plan = ["a", "b", "c"].map((caseId) => ({
      caseId,
      warmupRuns: 1,
      measuredRuns: 3,
    }));

    expect(
      createMeasurementSchedule(plan).map(({ caseId, phase, sampleIndex }) => ({
        caseId,
        phase,
        sampleIndex,
      })),
    ).toEqual([
      { caseId: "a", phase: "warmup", sampleIndex: 0 },
      { caseId: "b", phase: "warmup", sampleIndex: 0 },
      { caseId: "c", phase: "warmup", sampleIndex: 0 },
      { caseId: "a", phase: "measured", sampleIndex: 1 },
      { caseId: "b", phase: "measured", sampleIndex: 1 },
      { caseId: "c", phase: "measured", sampleIndex: 1 },
      { caseId: "b", phase: "measured", sampleIndex: 2 },
      { caseId: "c", phase: "measured", sampleIndex: 2 },
      { caseId: "a", phase: "measured", sampleIndex: 2 },
      { caseId: "c", phase: "measured", sampleIndex: 3 },
      { caseId: "a", phase: "measured", sampleIndex: 3 },
      { caseId: "b", phase: "measured", sampleIndex: 3 },
    ]);
  });

  it("groups warmup and measured rounds into host-observation blocks", () => {
    const schedule = createMeasurementSchedule(
      ["a", "b"].map((caseId) => ({ caseId, warmupRuns: 1, measuredRuns: 2 })),
    );

    expect(
      createMeasurementBlocks(schedule).map(({ id, entries }) => ({
        id,
        caseIds: entries.map(({ caseId }) => caseId),
      })),
    ).toEqual([
      { id: "warmup-round-0", caseIds: ["a", "b"] },
      { id: "measured-round-0", caseIds: ["a", "b"] },
      { id: "measured-round-1", caseIds: ["b", "a"] },
    ]);
  });

  it("stops the timer before output inspection begins", async () => {
    const events = [];
    const times = [10, 25];
    const measured = await measurePublicOperation(
      async () => {
        events.push("operation");
        return "encoded-output";
      },
      () => {
        events.push("clock");
        return times.shift();
      },
    );
    events.push("inspect");

    expect(events).toEqual(["clock", "operation", "clock", "inspect"]);
    expect(measured).toEqual({
      elapsedMs: 15,
      outcome: { status: "returned", value: "encoded-output" },
    });
  });

  it("aggregates sample eligibility without using elapsed time", () => {
    const preflight = { eligible: true, resultClass: "engineering-baseline", reasons: [] };
    expect(
      aggregateRunEligibility(preflight, [
        {
          status: "success",
          elapsedMs: 999_999,
          eligibility: { eligibleForEngineeringBaseline: true, reasons: [] },
        },
      ]),
    ).toEqual({
      eligible: true,
      resultClass: "engineering-baseline",
      reasons: [],
      environmentEligibility: { eligible: true, reasons: [] },
      functionalOutcome: { successful: true, failureCount: 0, reasons: [] },
    });
    expect(
      aggregateRunEligibility(preflight, [
        {
          status: "success",
          elapsedMs: 1,
          eligibility: {
            eligibleForEngineeringBaseline: false,
            reasons: ["concurrent-host-workload-detected"],
          },
        },
      ]),
    ).toEqual({
      eligible: false,
      resultClass: "diagnostic",
      reasons: ["concurrent-host-workload-detected"],
      environmentEligibility: {
        eligible: false,
        reasons: ["concurrent-host-workload-detected"],
      },
      functionalOutcome: { successful: true, failureCount: 0, reasons: [] },
    });
  });

  it("prevents any warmup or measured failure from becoming a formal baseline", () => {
    const preflight = { eligible: true, resultClass: "engineering-baseline", reasons: [] };

    expect(
      aggregateRunEligibility(preflight, [
        {
          status: "failure",
          phase: "warmup",
          eligibility: { eligibleForEngineeringBaseline: true, reasons: [] },
        },
      ]),
    ).toEqual({
      eligible: false,
      resultClass: "diagnostic",
      reasons: ["render-sample-failure"],
      environmentEligibility: { eligible: true, reasons: [] },
      functionalOutcome: {
        successful: false,
        failureCount: 1,
        reasons: ["render-sample-failure"],
      },
    });
  });

  it("fails closed when repository provenance changes during the run", () => {
    const start = {
      commit: "abc",
      branch: "main",
      dirty: false,
      lockfileSha256: "lock-a",
      measurementPlanSha256: "plan-a",
      measurementScheduleSha256: "schedule-a",
    };

    expect(detectRepositoryStateDrift(start, { ...start })).toEqual([]);
    expect(
      detectRepositoryStateDrift(start, {
        ...start,
        commit: "def",
        lockfileSha256: "lock-b",
      }),
    ).toEqual(["repository-state-changed-during-run"]);
  });
});
