import {
  buildMeasurementSummary,
  detectEncodedFormat,
  validateMeasurementCompleteness,
  validateExpectedOutputs,
  validateSuccessfulSample,
  writeMeasurementArtifacts,
} from "./renderMeasurementReport";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function successSample(overrides = {}) {
  return {
    caseId: "export-1-original",
    phase: "measured",
    sampleIndex: 1,
    status: "success",
    elapsedMs: 12,
    outputs: [
      {
        id: "export",
        width: 1200,
        height: 800,
        byteLength: 4096,
        sha256: "a".repeat(64),
        format: "png",
      },
    ],
    ...overrides,
  };
}

describe("render measurement report", () => {
  it("recomputes measured success timing while retaining warm-up and failure counts", () => {
    const samples = [
      successSample({ phase: "warmup", sampleIndex: 0, elapsedMs: 99 }),
      successSample({ sampleIndex: 1, elapsedMs: 30 }),
      successSample({ sampleIndex: 2, elapsedMs: 10 }),
      successSample({ sampleIndex: 3, elapsedMs: 20 }),
      {
        caseId: "export-1-original",
        phase: "measured",
        sampleIndex: 4,
        status: "failure",
        elapsedMs: 8,
        failure: { code: "encode-failed", phase: "encode", message: "fixture failure" },
      },
    ];

    expect(buildMeasurementSummary(samples)).toEqual([
      {
        caseId: "export-1-original",
        warmupCount: 1,
        measuredCount: 4,
        successCount: 3,
        failureCount: 1,
        elapsedMs: { median: 20, medianAbsoluteDeviation: 10, max: 30 },
        outputs: [
          {
            id: "export",
            width: 1200,
            height: 800,
            format: "png",
            byteLength: { median: 4096, max: 4096 },
            distinctSha256: 1,
          },
        ],
      },
    ]);
  });

  it("rejects an empty measured run instead of producing a hollow green", () => {
    expect(() => buildMeasurementSummary([])).toThrow("measurement produced no samples");
    expect(() =>
      buildMeasurementSummary([successSample({ phase: "warmup", sampleIndex: 0 })]),
    ).toThrow("measurement produced no measured samples");
  });

  it("requires every successful output to have dimensions, bytes, and a SHA-256 identity", () => {
    expect(() =>
      validateSuccessfulSample(
        successSample({ outputs: [{ id: "export", width: 1200, height: 800, byteLength: 0 }] }),
      ),
    ).toThrow("output export byteLength must be positive");
    expect(() => validateSuccessfulSample(successSample({ elapsedMs: -1 }))).toThrow(
      "sample export-1-original elapsedMs must be a non-negative finite number",
    );
  });

  it("identifies encoded format from magic bytes", () => {
    expect(
      detectEncodedFormat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png");
    expect(detectEncodedFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(detectEncodedFormat(Uint8Array.from([0x00, 0x01]))).toBe("unknown");
  });

  it("accepts only success or a typed failure record", () => {
    expect(() => validateSuccessfulSample(successSample({ status: "cancelled" }))).toThrow(
      "sample export-1-original status must be success or failure",
    );
    expect(() =>
      validateSuccessfulSample({
        caseId: "export-1-original",
        phase: "measured",
        sampleIndex: 1,
        status: "failure",
        elapsedMs: 8,
      }),
    ).toThrow("failure sample export-1-original must contain a typed failure");
    expect(() =>
      validateSuccessfulSample({
        caseId: "export-1-original",
        phase: "measured",
        sampleIndex: 1,
        status: "failure",
        elapsedMs: 8,
        failure: { code: "", phase: "encode" },
      }),
    ).toThrow("failure sample export-1-original code must be non-empty");
    expect(() =>
      validateSuccessfulSample({
        caseId: "export-1-original",
        phase: "measured",
        sampleIndex: 1,
        status: "failure",
        elapsedMs: 8,
        failure: { code: "encode-failed", phase: "" },
      }),
    ).toThrow("failure sample export-1-original phase must be non-empty");
  });

  it("requires complete sample counts and stable output identity for every case", () => {
    const plan = [
      {
        caseId: "export-1-original",
        warmupRuns: 1,
        measuredRuns: 2,
        expectedOutputIds: ["export"],
      },
    ];
    const complete = [
      successSample({ phase: "warmup", sampleIndex: 0 }),
      successSample({ sampleIndex: 1 }),
      successSample({ sampleIndex: 2 }),
    ];

    expect(() => validateMeasurementCompleteness(plan, complete.slice(0, 2))).toThrow(
      "case export-1-original expected 2 measured samples but received 1",
    );
    expect(() =>
      validateMeasurementCompleteness(plan, [
        ...complete.slice(0, 2),
        successSample({
          sampleIndex: 2,
          outputs: [complete[2].outputs[0]].map((output) => ({
            ...output,
            sha256: "d".repeat(64),
          })),
        }),
      ]),
    ).toThrow("case export-1-original output export identity changed between successful samples");
    expect(validateMeasurementCompleteness(plan, complete)).toBeUndefined();
  });

  it("requires exact sample index coverage and rejects unknown phases", () => {
    const plan = [
      {
        caseId: "export-1-original",
        warmupRuns: 1,
        measuredRuns: 3,
        expectedOutputIds: ["export"],
      },
    ];
    const duplicateMeasuredIndex = [
      successSample({ phase: "warmup", sampleIndex: 0 }),
      successSample({ sampleIndex: 1 }),
      successSample({ sampleIndex: 1 }),
      successSample({ sampleIndex: 3 }),
    ];

    expect(() => validateMeasurementCompleteness(plan, duplicateMeasuredIndex)).toThrow(
      "case export-1-original measured sampleIndex must exactly cover 1, 2, 3; received 1, 1, 3",
    );
    expect(() =>
      validateMeasurementCompleteness(plan, [
        ...duplicateMeasuredIndex.slice(0, 3),
        successSample({ phase: "diagnostic", sampleIndex: 2 }),
      ]),
    ).toThrow("sample export-1-original phase must be warmup or measured");
  });

  it("reports zero timing dispersion for a single measured success", () => {
    expect(buildMeasurementSummary([successSample({ elapsedMs: 7 })])[0].elapsedMs).toEqual({
      median: 7,
      medianAbsoluteDeviation: 0,
      max: 7,
    });
  });

  it("rejects a successful case that omitted an expected output", () => {
    expect(() =>
      validateExpectedOutputs(
        { caseId: "thumbnail-1-pair", expectedOutputIds: ["square", "original"] },
        successSample({
          caseId: "thumbnail-1-pair",
          outputs: [
            {
              id: "square",
              width: 360,
              height: 360,
              byteLength: 1024,
              sha256: "b".repeat(64),
              format: "jpeg",
            },
          ],
        }),
      ),
    ).toThrow("case thumbnail-1-pair expected outputs original, square but received square");
  });

  it("requires the exact expected dimensions and magic-byte format", () => {
    const measurementCase = {
      caseId: "export-1-original-png",
      expectedOutputIds: ["export"],
      expectedOutputs: [{ id: "export", width: 1200, height: 800, format: "png" }],
    };
    const expectedOutputs = measurementCase.expectedOutputs;

    expect(() =>
      validateExpectedOutputs(
        measurementCase,
        successSample({
          caseId: measurementCase.caseId,
          expectedOutputs,
          outputs: [
            {
              ...successSample().outputs[0],
              width: 1,
              height: 1,
              format: "png",
            },
          ],
        }),
      ),
    ).toThrow(
      "case export-1-original-png output export expected 1200x800 png but received 1x1 png",
    );
    expect(() =>
      validateExpectedOutputs(
        measurementCase,
        successSample({
          caseId: measurementCase.caseId,
          expectedOutputs,
          outputs: [{ ...successSample().outputs[0], format: "jpeg" }],
        }),
      ),
    ).toThrow(
      "case export-1-original-png output export expected 1200x800 png but received 1200x800 jpeg",
    );
  });

  it("requires failure samples to retain the case output contract", () => {
    const plan = [
      {
        caseId: "export-1-original-png",
        warmupRuns: 0,
        measuredRuns: 1,
        expectedOutputIds: ["export"],
        expectedOutputs: [{ id: "export", width: 1200, height: 800, format: "png" }],
      },
    ];

    expect(() =>
      validateMeasurementCompleteness(plan, [
        {
          caseId: "export-1-original-png",
          phase: "measured",
          sampleIndex: 1,
          status: "failure",
          elapsedMs: 8,
          failure: { code: "encode-failed", phase: "encode" },
        },
      ]),
    ).toThrow("sample export-1-original-png expected output contract does not match its plan");
  });

  it("writes environment, fixtures, raw JSONL, and a recomputable summary", () => {
    const parent = mkdtempSync(join(tmpdir(), "plogkit-render-measurement-"));
    const outputDirectory = join(parent, "run");
    try {
      const samples = [successSample()];
      writeMeasurementArtifacts(
        outputDirectory,
        {
          environment: { schemaVersion: 1, commit: "abc" },
          fixtures: { schemaVersion: 1, fixtureSetSha256: "c".repeat(64), inputs: [] },
          samples,
        },
        [
          {
            caseId: "export-1-original",
            warmupRuns: 0,
            measuredRuns: 1,
            expectedOutputIds: ["export"],
          },
        ],
      );

      expect(JSON.parse(readFileSync(join(outputDirectory, "environment.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        commit: "abc",
      });
      expect(readFileSync(join(outputDirectory, "samples.jsonl"), "utf8").trim()).toBe(
        JSON.stringify(samples[0]),
      );
      expect(JSON.parse(readFileSync(join(outputDirectory, "summary.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        sampleFile: "samples.jsonl",
        environmentFile: "environment.json",
        fixturesFile: "fixtures.json",
        runEligibility: null,
        validation: { status: "valid" },
        structuralValidation: { status: "valid" },
        functionalOutcome: { status: "passed", failureCount: 0 },
        claimEligibility: null,
        cases: buildMeasurementSummary(samples),
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("keeps structural validity separate from a failed functional outcome", () => {
    const parent = mkdtempSync(join(tmpdir(), "plogkit-failed-render-outcome-"));
    const outputDirectory = join(parent, "run");
    try {
      const claimEligibility = {
        eligible: false,
        resultClass: "diagnostic",
        reasons: ["render-sample-failure"],
      };
      writeMeasurementArtifacts(
        outputDirectory,
        {
          environment: { schemaVersion: 1, eligibility: claimEligibility },
          fixtures: { schemaVersion: 1, inputs: [] },
          samples: [
            {
              caseId: "export-1-original",
              phase: "measured",
              sampleIndex: 1,
              status: "failure",
              elapsedMs: 8,
              failure: { code: "encode-failed", phase: "encode" },
            },
          ],
        },
        [
          {
            caseId: "export-1-original",
            warmupRuns: 0,
            measuredRuns: 1,
            expectedOutputIds: ["export"],
          },
        ],
      );

      expect(JSON.parse(readFileSync(join(outputDirectory, "summary.json"), "utf8"))).toMatchObject(
        {
          structuralValidation: { status: "valid" },
          functionalOutcome: { status: "failed", failureCount: 1 },
          claimEligibility,
        },
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an eligible claim when any functional sample failed", () => {
    const parent = mkdtempSync(join(tmpdir(), "plogkit-false-eligible-claim-"));
    const outputDirectory = join(parent, "run");
    try {
      expect(() =>
        writeMeasurementArtifacts(
          outputDirectory,
          {
            environment: {
              schemaVersion: 1,
              eligibility: { eligible: true, resultClass: "engineering-baseline", reasons: [] },
            },
            fixtures: { schemaVersion: 1, inputs: [] },
            samples: [
              {
                caseId: "export-1-original",
                phase: "measured",
                sampleIndex: 1,
                status: "failure",
                elapsedMs: 8,
                failure: { code: "encode-failed", phase: "encode" },
              },
            ],
          },
          [
            {
              caseId: "export-1-original",
              warmupRuns: 0,
              measuredRuns: 1,
              expectedOutputIds: ["export"],
            },
          ],
        ),
      ).toThrow("claim eligibility cannot be true when a render sample failed");
      expect(existsSync(join(outputDirectory, "summary.json"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an eligible run claim when any sample is environment-ineligible", () => {
    const parent = mkdtempSync(join(tmpdir(), "plogkit-inconsistent-run-claim-"));
    const outputDirectory = join(parent, "run");
    try {
      expect(() =>
        writeMeasurementArtifacts(
          outputDirectory,
          {
            environment: {
              schemaVersion: 1,
              eligibility: { eligible: true, resultClass: "engineering-baseline", reasons: [] },
            },
            fixtures: { schemaVersion: 1, inputs: [] },
            samples: [
              successSample({
                eligibility: {
                  eligibleForEngineeringBaseline: false,
                  reasons: ["concurrent-host-workload-detected"],
                },
              }),
            ],
          },
          [
            {
              caseId: "export-1-original",
              warmupRuns: 0,
              measuredRuns: 1,
              expectedOutputIds: ["export"],
            },
          ],
        ),
      ).toThrow("run claim eligibility contradicts an ineligible sample");
      expect(existsSync(join(outputDirectory, "summary.json"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", undefined],
    ["missing the eligible flag", { reasons: [] }],
    ["explicitly false", { eligible: false, reasons: [] }],
    ["missing reasons", { eligible: true }],
    ["carrying reasons", { eligible: true, reasons: ["concurrent-host-workload-detected"] }],
  ])("rejects a formal run claim when sample eligibility is %s", (_label, eligibility) => {
    const parent = mkdtempSync(join(tmpdir(), "plogkit-formal-sample-eligibility-"));
    const outputDirectory = join(parent, "run");
    try {
      expect(() =>
        writeMeasurementArtifacts(
          outputDirectory,
          {
            environment: {
              schemaVersion: 1,
              eligibility: { eligible: true, resultClass: "engineering-baseline", reasons: [] },
            },
            fixtures: { schemaVersion: 1, inputs: [] },
            samples: [successSample({ eligibility })],
          },
          [
            {
              caseId: "export-1-original",
              warmupRuns: 0,
              measuredRuns: 1,
              expectedOutputIds: ["export"],
            },
          ],
        ),
      ).toThrow("formal run claim requires every sample to be explicitly eligible with no reasons");
      expect(existsSync(join(outputDirectory, "summary.json"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("atomically retains invalid raw samples without publishing a completed summary", () => {
    const parent = mkdtempSync(join(tmpdir(), "plogkit-invalid-render-measurement-"));
    const outputDirectory = join(parent, "run");
    try {
      expect(() =>
        writeMeasurementArtifacts(
          outputDirectory,
          {
            environment: { schemaVersion: 1 },
            fixtures: { schemaVersion: 1, inputs: [] },
            samples: [successSample()],
          },
          [
            {
              caseId: "export-1-original",
              warmupRuns: 1,
              measuredRuns: 1,
              expectedOutputIds: ["export"],
            },
          ],
        ),
      ).toThrow("expected 1 warmup samples but received 0");
      expect(existsSync(join(outputDirectory, "samples.jsonl"))).toBe(true);
      expect(existsSync(join(outputDirectory, "summary.json"))).toBe(false);
      expect(JSON.parse(readFileSync(join(outputDirectory, "validation.json"), "utf8"))).toEqual({
        status: "invalid",
        message: "case export-1-original expected 1 warmup samples but received 0",
      });
      expect(readdirSync(parent).some((name) => name.includes(".in-progress-"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
