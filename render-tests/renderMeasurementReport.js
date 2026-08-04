import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

export function detectEncodedFormat(bytes) {
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngMagic.every((value, index) => bytes[index] === value)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return "unknown";
}

export function validateSuccessfulSample(sample) {
  if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0) {
    throw new Error(`sample ${sample.caseId} elapsedMs must be a non-negative finite number`);
  }
  if (sample.status !== "success" && sample.status !== "failure") {
    throw new Error(`sample ${sample.caseId} status must be success or failure`);
  }
  if (sample.status === "failure") {
    if (
      typeof sample.failure !== "object" ||
      sample.failure === null ||
      Array.isArray(sample.failure)
    ) {
      throw new Error(`failure sample ${sample.caseId} must contain a typed failure`);
    }
    if (typeof sample.failure.code !== "string" || sample.failure.code.trim().length === 0) {
      throw new Error(`failure sample ${sample.caseId} code must be non-empty`);
    }
    if (typeof sample.failure.phase !== "string" || sample.failure.phase.trim().length === 0) {
      throw new Error(`failure sample ${sample.caseId} phase must be non-empty`);
    }
    return;
  }
  if (!Array.isArray(sample.outputs) || sample.outputs.length === 0) {
    throw new Error(`successful sample ${sample.caseId} must contain an output`);
  }
  for (const output of sample.outputs) {
    if (!isPositiveFinite(output.width) || !isPositiveFinite(output.height)) {
      throw new Error(`output ${output.id} dimensions must be positive`);
    }
    if (!Number.isInteger(output.byteLength) || output.byteLength <= 0) {
      throw new Error(`output ${output.id} byteLength must be positive`);
    }
    if (typeof output.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(output.sha256)) {
      throw new Error(`output ${output.id} sha256 must be a lowercase SHA-256 digest`);
    }
    if (output.format !== "jpeg" && output.format !== "png") {
      throw new Error(`output ${output.id} format must be identified as jpeg or png`);
    }
  }
}

function validateSampleIndices(measurementCase, phase, samples, firstIndex, count) {
  const expected = Array.from({ length: count }, (_, index) => firstIndex + index);
  const received = samples
    .map(({ sampleIndex }) => sampleIndex)
    .sort((left, right) => left - right);
  if (
    expected.length !== received.length ||
    received.some((sampleIndex, index) => sampleIndex !== expected[index])
  ) {
    throw new Error(
      `case ${measurementCase.caseId} ${phase} sampleIndex must exactly cover ${expected.join(", ")}; received ${received.join(", ")}`,
    );
  }
}

export function validateMeasurementCompleteness(plan, samples) {
  const plannedCaseIds = new Set(plan.map(({ caseId }) => caseId));
  for (const sample of samples) {
    if (!plannedCaseIds.has(sample.caseId)) {
      throw new Error(`measurement produced unplanned case ${sample.caseId}`);
    }
    if (sample.phase !== "warmup" && sample.phase !== "measured") {
      throw new Error(`sample ${sample.caseId} phase must be warmup or measured`);
    }
    validateSuccessfulSample(sample);
  }
  for (const measurementCase of plan) {
    const caseSamples = samples.filter(({ caseId }) => caseId === measurementCase.caseId);
    const warmups = caseSamples.filter(({ phase }) => phase === "warmup");
    const measured = caseSamples.filter(({ phase }) => phase === "measured");
    if (warmups.length !== measurementCase.warmupRuns) {
      throw new Error(
        `case ${measurementCase.caseId} expected ${measurementCase.warmupRuns} warmup samples but received ${warmups.length}`,
      );
    }
    if (measured.length !== measurementCase.measuredRuns) {
      throw new Error(
        `case ${measurementCase.caseId} expected ${measurementCase.measuredRuns} measured samples but received ${measured.length}`,
      );
    }
    validateSampleIndices(measurementCase, "warmup", warmups, 0, measurementCase.warmupRuns);
    validateSampleIndices(measurementCase, "measured", measured, 1, measurementCase.measuredRuns);
    for (const sample of caseSamples) validateExpectedOutputs(measurementCase, sample);
    const successful = caseSamples.filter(({ status }) => status === "success");
    for (const outputId of measurementCase.expectedOutputIds) {
      const outputs = successful.map((sample) => sample.outputs.find(({ id }) => id === outputId));
      if (
        outputs.length > 1 &&
        new Set(
          outputs.map(
            ({ width, height, format, sha256 }) => `${width}x${height}:${format}:${sha256}`,
          ),
        ).size > 1
      ) {
        throw new Error(
          `case ${measurementCase.caseId} output ${outputId} identity changed between successful samples`,
        );
      }
    }
  }
}

export function validateExpectedOutputs(measurementCase, sample) {
  if (measurementCase.expectedOutputs !== undefined) {
    if (
      JSON.stringify(sample.expectedOutputs) !== JSON.stringify(measurementCase.expectedOutputs)
    ) {
      throw new Error(`sample ${sample.caseId} expected output contract does not match its plan`);
    }
  }
  if (sample.status !== "success") return;
  const expected = [...measurementCase.expectedOutputIds].sort();
  const received = sample.outputs.map(({ id }) => id).sort();
  if (expected.length !== received.length || expected.some((id, index) => id !== received[index])) {
    throw new Error(
      `case ${measurementCase.caseId} expected outputs ${expected.join(", ")} but received ${received.join(", ")}`,
    );
  }
  for (const expectedOutput of measurementCase.expectedOutputs ?? []) {
    const actual = sample.outputs.find(({ id }) => id === expectedOutput.id);
    if (
      actual.width !== expectedOutput.width ||
      actual.height !== expectedOutput.height ||
      actual.format !== expectedOutput.format
    ) {
      throw new Error(
        `case ${measurementCase.caseId} output ${expectedOutput.id} expected ${expectedOutput.width}x${expectedOutput.height} ${expectedOutput.format} but received ${actual.width}x${actual.height} ${actual.format}`,
      );
    }
  }
}

function median(sorted) {
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function summarizeOutputs(caseId, successes) {
  const byId = new Map();
  for (const sample of successes) {
    for (const output of sample.outputs) {
      const values = byId.get(output.id) ?? [];
      values.push(output);
      byId.set(output.id, values);
    }
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, outputs]) => {
      if (outputs.length !== successes.length) {
        throw new Error(`case ${caseId} did not produce output ${id} for every success`);
      }
      const [{ width, height, format }] = outputs;
      if (
        outputs.some(
          (output) =>
            output.width !== width || output.height !== height || output.format !== format,
        )
      ) {
        throw new Error(`case ${caseId} output ${id} dimensions changed between samples`);
      }
      const byteLengths = outputs.map(({ byteLength }) => byteLength).sort((a, b) => a - b);
      return {
        id,
        width,
        height,
        format,
        byteLength: { median: median(byteLengths), max: byteLengths.at(-1) },
        distinctSha256: new Set(outputs.map(({ sha256 }) => sha256)).size,
      };
    });
}

export function buildMeasurementSummary(samples) {
  if (samples.length === 0) throw new Error("measurement produced no samples");
  for (const sample of samples) validateSuccessfulSample(sample);

  const caseIds = [...new Set(samples.map(({ caseId }) => caseId))].sort();
  const summaries = caseIds.map((caseId) => {
    const caseSamples = samples.filter((sample) => sample.caseId === caseId);
    const measured = caseSamples.filter((sample) => sample.phase === "measured");
    const successes = measured.filter((sample) => sample.status === "success");
    const elapsed = successes.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
    const elapsedMedian = elapsed.length === 0 ? null : median(elapsed);
    return {
      caseId,
      warmupCount: caseSamples.filter((sample) => sample.phase === "warmup").length,
      measuredCount: measured.length,
      successCount: successes.length,
      failureCount: measured.length - successes.length,
      elapsedMs:
        elapsedMedian === null
          ? null
          : {
              median: elapsedMedian,
              medianAbsoluteDeviation: median(
                elapsed.map((value) => Math.abs(value - elapsedMedian)).sort((a, b) => a - b),
              ),
              max: elapsed.at(-1),
            },
      outputs: summarizeOutputs(caseId, successes),
    };
  });
  if (summaries.every(({ measuredCount }) => measuredCount === 0)) {
    throw new Error("measurement produced no measured samples");
  }
  return summaries;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeMeasurementArtifacts(outputDirectory, bundle, plan) {
  if (existsSync(outputDirectory)) {
    throw new Error(`measurement output already exists: ${outputDirectory}`);
  }
  mkdirSync(dirname(outputDirectory), { recursive: true });
  const inProgressDirectory = `${outputDirectory}.in-progress-${process.pid}-${Date.now()}`;
  mkdirSync(inProgressDirectory);
  writeJson(join(inProgressDirectory, "environment.json"), bundle.environment);
  writeJson(join(inProgressDirectory, "fixtures.json"), bundle.fixtures);
  writeFileSync(
    join(inProgressDirectory, "samples.jsonl"),
    `${bundle.samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`,
    "utf8",
  );
  try {
    validateMeasurementCompleteness(plan, bundle.samples);
    const summary = buildMeasurementSummary(bundle.samples);
    const failureCount = bundle.samples.filter(({ status }) => status === "failure").length;
    const claimEligibility = bundle.environment.eligibility ?? null;
    if (failureCount > 0 && claimEligibility?.eligible === true) {
      throw new Error("claim eligibility cannot be true when a render sample failed");
    }
    if (
      claimEligibility?.eligible === true &&
      bundle.samples.some(
        ({ eligibility }) => eligibility?.eligibleForEngineeringBaseline === false,
      )
    ) {
      throw new Error("run claim eligibility contradicts an ineligible sample");
    }
    if (
      claimEligibility?.eligible === true &&
      bundle.samples.some(
        ({ eligibility }) =>
          eligibility?.eligible !== true ||
          !Array.isArray(eligibility.reasons) ||
          eligibility.reasons.length !== 0,
      )
    ) {
      throw new Error(
        "formal run claim requires every sample to be explicitly eligible with no reasons",
      );
    }
    writeJson(join(inProgressDirectory, "validation.json"), { status: "valid" });
    writeJson(join(inProgressDirectory, "summary.json"), {
      schemaVersion: 1,
      sampleFile: "samples.jsonl",
      environmentFile: "environment.json",
      fixturesFile: "fixtures.json",
      runEligibility: claimEligibility,
      validation: { status: "valid" },
      structuralValidation: { status: "valid" },
      functionalOutcome: {
        status: failureCount === 0 ? "passed" : "failed",
        failureCount,
      },
      claimEligibility,
      cases: summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "measurement validation failed";
    writeJson(join(inProgressDirectory, "validation.json"), { status: "invalid", message });
    renameSync(inProgressDirectory, outputDirectory);
    throw error;
  }
  renameSync(inProgressDirectory, outputDirectory);
}
