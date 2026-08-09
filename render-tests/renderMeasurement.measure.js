import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { totalmem, cpus, platform, release, arch } from "node:os";
import { join, resolve } from "node:path";

import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb";
import { getSkiaExports } from "@shopify/react-native-skia/lib/commonjs/headless";

import { createDocument, importedAssetId } from "../src/core/document";
import { resolveExportPolicy } from "../src/core/exportPolicy";
import { documentToExportSourceFacts } from "../src/render/exportSourceFacts";
import { documentToRenderScene } from "../src/render/scene";
import {
  createHeadlessFontProvider,
  createHeadlessTextLayoutEnvironment,
} from "../src/render/headless";
import { createHeadlessSkiaOffscreenSceneRenderer } from "../src/render/headlessSkiaOffscreenRenderer";
import { SKIA_EXPORT_CAPABILITIES } from "../src/services/export/capabilities";
import {
  captureHostState,
  createHostEligibility,
  hostStateExecutionReadiness,
  mergeSampleHostEligibilityReasons,
} from "./renderMeasurementHost";
import {
  aggregateRunEligibility,
  createHeadlessExecutionContext,
  createHeadlessMeasurementPlan,
  createMeasurementBlocks,
  createMeasurementSchedule,
  detectRepositoryStateDrift,
  measurePublicOperation,
} from "./renderMeasurementProtocol";
import { detectEncodedFormat, writeMeasurementArtifacts } from "./renderMeasurementReport";
import { validateRenderVerificationReceipt } from "./renderMeasurementReceipt";
import { DEFAULT_HOST_RECOVERY_POLICY, recoverHostReadiness } from "./renderMeasurementRecovery";
import measurementPaths from "../scripts/render-measurement-paths.cjs";

const { resolveRenderMeasurementOutputDirectory } = measurementPaths;

const mockThumbnailWrites = new Map();

jest.mock("expo-file-system", () => ({
  File: class File {
    constructor(uri) {
      this.uri = uri;
      this.exists = mockThumbnailWrites.has(uri);
    }

    create() {}

    write(bytes) {
      mockThumbnailWrites.set(this.uri, Uint8Array.from(bytes));
      this.exists = true;
    }
  },
}));

jest.mock("@shopify/react-native-skia", () => {
  const headless = jest.requireActual("@shopify/react-native-skia/lib/commonjs/headless");
  return { ...headless, Skia: headless.getSkiaExports().Skia };
});

const ROOT = resolve(__dirname, "..");
const FONT_DIR = join(__dirname, "fonts");
const FIXTURE_DEFINITIONS = [
  {
    id: "landscape",
    path: "e2e/fixtures/landscape.jpg",
    format: "jpeg",
    width: 1200,
    height: 800,
  },
  {
    id: "portrait",
    path: "e2e/fixtures/portrait.jpg",
    format: "jpeg",
    width: 900,
    height: 1200,
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function captureCommand(command, args) {
  try {
    return {
      status: "available",
      output: execFileSync(command, args, {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
      }).trim(),
    };
  } catch {
    return {
      status: "unavailable",
      reason: `${command} probe failed`,
    };
  }
}

function captureRepositoryState(plan, schedule) {
  return {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: git(["status", "--porcelain"]).length > 0,
    lockfileSha256: sha256(readFileSync(join(ROOT, "pnpm-lock.yaml"))),
    measurementPlanSha256: sha256(JSON.stringify(plan)),
    measurementScheduleSha256: sha256(JSON.stringify(schedule)),
  };
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function loadFixtures(api) {
  const assets = new Map();
  const inputs = FIXTURE_DEFINITIONS.map((definition) => {
    const bytes = Uint8Array.from(readFileSync(join(ROOT, definition.path)));
    const data = api.Data.fromBytes(bytes);
    const image = api.Image.MakeImageFromEncoded(data);
    data.dispose();
    if (image === null) throw new Error(`could not decode measurement fixture ${definition.path}`);
    try {
      if (image.width() !== definition.width || image.height() !== definition.height) {
        throw new Error(`measurement fixture ${definition.path} dimensions changed`);
      }
    } finally {
      image.dispose();
    }
    const uri = `fixture://${definition.id}`;
    assets.set(uri, bytes);
    return {
      ...definition,
      uri,
      byteLength: statSync(join(ROOT, definition.path)).size,
      sha256: sha256(bytes),
    };
  });
  return { assets, inputs };
}

function createFixtureDocument(imageCount, presetId = "social", format = "jpeg") {
  const exercisesGlobalOriginalBounds = imageCount === 9 && presetId === "original";
  const images = Array.from({ length: imageCount }, (_, index) => {
    const fixture = FIXTURE_DEFINITIONS[index % FIXTURE_DEFINITIONS.length];
    return {
      id: importedAssetId(`measurement-${imageCount}-${index + 1}`),
      width: exercisesGlobalOriginalBounds ? 6000 : fixture.width,
      height: exercisesGlobalOriginalBounds ? 4000 : fixture.height,
    };
  });
  const base = createDocument(images);
  return {
    ...base,
    textElements: [
      {
        id: "measurement-caption",
        content: `PlogKit 基线 ${imageCount} 图`,
        position: { x: 36, y: 36 },
        width: 928,
        fontId: "system-sans",
        fontSize: 48,
        color: "#101010",
        alignment: "center",
        lineHeight: 1.15,
        backgroundColor: "#F6F1E8CC",
      },
    ],
    exportSettings: {
      ...base.exportSettings,
      presetId,
      formatOverride: format,
      metadataPolicy: "strip",
    },
  };
}

function createAssetCatalog(document) {
  const entries = document.sourceImages.map(({ id }) => id);
  return {
    entries,
    resolve: (candidateId, usage) => {
      const index = entries.indexOf(candidateId);
      if (index < 0 || usage === "metadata") return null;
      const fixture = FIXTURE_DEFINITIONS[index % FIXTURE_DEFINITIONS.length];
      return {
        draftId: "draft-render-measurement",
        assetId: candidateId,
        usage,
        uri: `fixture://${fixture.id}`,
      };
    },
  };
}

function inspectOutput(api, id, bytes) {
  const data = api.Data.fromBytes(bytes);
  const image = api.Image.MakeImageFromEncoded(data);
  data.dispose();
  if (image === null) throw new Error(`output ${id} could not be decoded`);
  try {
    return {
      id,
      width: image.width(),
      height: image.height(),
      format: detectEncodedFormat(bytes),
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  } finally {
    image.dispose();
  }
}

function resolveExpectedOutputs(
  measurementCase,
  document,
  calculateDraftThumbnailGeometry,
  thumbnailProfile,
) {
  if (measurementCase.operation === "export") {
    const resolution = resolveExportPolicy(
      document.exportSettings,
      documentToExportSourceFacts(document),
      SKIA_EXPORT_CAPABILITIES,
    );
    if (resolution.status !== "resolved") {
      throw new Error(`export policy failed: ${resolution.error.code}`);
    }
    return [
      {
        id: "export",
        width: resolution.policy.width,
        height: resolution.policy.height,
        format: resolution.policy.format,
      },
    ];
  }
  const scene = documentToRenderScene(document);
  return ["square", "original"].map((id) => {
    const geometry = calculateDraftThumbnailGeometry(
      scene.width,
      scene.height,
      thumbnailProfile,
      id,
    );
    return {
      id,
      width: geometry.width,
      height: geometry.height,
      format: thumbnailProfile.codec,
    };
  });
}

function createCaseManifest(measurementCase, document) {
  const contents = {
    caseId: measurementCase.caseId,
    documentSha256: sha256(JSON.stringify(document)),
    expectedOutputs: measurementCase.expectedOutputs,
  };
  return { ...contents, caseManifestSha256: sha256(JSON.stringify(contents)) };
}

function captureRenderer(renderer) {
  let lastResult = null;
  return {
    renderer: {
      render: async (input) => {
        lastResult = await renderer.render(input);
        return lastResult;
      },
    },
    lastResult: () => lastResult,
  };
}

function renderFailure(lastResult, fallback) {
  if (lastResult?.status === "failure") {
    return {
      code: lastResult.code,
      phase: lastResult.phase,
      message: lastResult.message,
    };
  }
  if (lastResult?.status === "cancelled") {
    return { code: "cancelled", phase: lastResult.phase, message: fallback };
  }
  return { code: "runner-failed", phase: "runner", message: fallback };
}

describe("headless export and thumbnail measurement", () => {
  let api;
  let fontProvider;
  let textLayoutEnvironment;
  let createSkiaExportBackend;
  let createExpoDraftThumbnailAdapter;
  let calculateDraftThumbnailGeometry;
  let DRAFT_THUMBNAIL_PROFILE;

  beforeAll(async () => {
    await LoadSkiaWeb();
    api = getSkiaExports().Skia;
    ({ createSkiaExportBackend } = require("../src/services/export/skiaBackend"));
    ({
      createExpoDraftThumbnailAdapter,
      calculateDraftThumbnailGeometry,
    } = require("../src/services/drafts/expoDraftThumbnailAdapter"));
    ({ DRAFT_THUMBNAIL_PROFILE } = require("../src/services/drafts/draftLibrary"));
    fontProvider = createHeadlessFontProvider([
      {
        family: "Test Latin",
        bytes: Uint8Array.from(readFileSync(join(FONT_DIR, "NotoSans-TestSubset.ttf"))),
      },
      {
        family: "Test CJK",
        bytes: Uint8Array.from(readFileSync(join(FONT_DIR, "NotoSansSC-TestSubset.ttf"))),
      },
    ]);
    textLayoutEnvironment = createHeadlessTextLayoutEnvironment(fontProvider, {
      "system-sans": ["Test Latin", "Test CJK"],
    });
  });

  afterAll(() => {
    fontProvider?.dispose();
  });

  it("records every planned sample and writes independently verifiable artifacts", async () => {
    const profile = process.env.PLOGKIT_RENDER_MEASUREMENT_PROFILE ?? "full";
    const basePlan = createHeadlessMeasurementPlan(profile);
    const startedAt = new Date().toISOString();
    const { assets: encodedAssets, inputs } = loadFixtures(api);
    for (const measurementCase of basePlan) {
      const document = createFixtureDocument(
        measurementCase.imageCount,
        measurementCase.presetId,
        measurementCase.format,
      );
      const derivedOutputs = resolveExpectedOutputs(
        measurementCase,
        document,
        calculateDraftThumbnailGeometry,
        DRAFT_THUMBNAIL_PROFILE,
      );
      if (JSON.stringify(derivedOutputs) !== JSON.stringify(measurementCase.expectedOutputs)) {
        throw new Error(
          `frozen output contract drifted from production policy for ${measurementCase.caseId}`,
        );
      }
    }
    const plan = basePlan;
    const caseInputs = plan.map((measurementCase) => {
      const document = createFixtureDocument(
        measurementCase.imageCount,
        measurementCase.presetId,
        measurementCase.format,
      );
      return createCaseManifest(measurementCase, document);
    });
    const fixtureSetSha256 = sha256(JSON.stringify({ inputs, caseInputs }));
    const packageManifest = require("../package.json");
    const toolchain = {
      node: process.version,
      platform: platform(),
      osRelease: release(),
      architecture: arch(),
      logicalCpuCount: cpus().length,
      hostRamBytes: totalmem(),
      pnpm: captureCommand("pnpm", ["--version"]),
      expo: packageManifest.dependencies.expo,
      reactNativeSkia: packageManifest.dependencies["@shopify/react-native-skia"],
      jest: packageManifest.devDependencies.jest,
    };
    const schedule = createMeasurementSchedule(plan);
    const initialRepositoryState = captureRepositoryState(plan, schedule);
    const runId = `${startedAt.replace(/[:.]/g, "-")}-${initialRepositoryState.commit.slice(0, 12)}-${profile}`;
    const provenance = {
      ...initialRepositoryState,
      toolchain,
      fixtureSetSha256,
    };
    let renderVerificationReceiptRaw = null;
    try {
      const receiptPath = process.env.PLOGKIT_RENDER_VERIFICATION_RECEIPT;
      if (receiptPath !== undefined) {
        renderVerificationReceiptRaw = readFileSync(receiptPath, "utf8");
      }
    } catch {
      renderVerificationReceiptRaw = null;
    }
    const renderVerification = validateRenderVerificationReceipt(
      renderVerificationReceiptRaw,
      initialRepositoryState,
    );
    const initialHostState = captureHostState(ROOT);
    const initialEligibility = createHostEligibility({
      profile,
      dirty: initialRepositoryState.dirty,
      isolationConfirmed: process.env.PLOGKIT_RENDER_HOST_ISOLATION_CONFIRMED === "1",
      renderVerificationReceiptValid: renderVerification.status === "verified",
      processProbe: initialHostState.processProbe,
      healthProbe: initialHostState.healthProbe,
      powerState: initialHostState.powerState,
      deferRecoverableHostChecks: true,
    });
    const caseById = new Map(
      plan.map((measurementCase) => [measurementCase.caseId, measurementCase]),
    );
    const caseManifestById = new Map(caseInputs.map((entry) => [entry.caseId, entry]));
    const samples = [];
    const scheduleBlocks = createMeasurementBlocks(schedule);
    const hostObservationBlocks = [];
    let sharedBoundaryHostState = initialHostState;

    for (const scheduleBlock of scheduleBlocks) {
      const recovery = await recoverHostReadiness({
        initialState: sharedBoundaryHostState,
        captureState: () => captureHostState(ROOT),
        sleep: wait,
      });
      const blockPreflightHostState = recovery.finalState;
      const blockReadiness = hostStateExecutionReadiness(blockPreflightHostState);
      const blockSamples = [];
      for (const scheduleEntry of scheduleBlock.entries) {
        const measurementCase = caseById.get(scheduleEntry.caseId);
        if (measurementCase === undefined) {
          throw new Error(`measurement schedule referenced unknown case ${scheduleEntry.caseId}`);
        }
        const document = createFixtureDocument(
          measurementCase.imageCount,
          measurementCase.presetId,
          measurementCase.format,
        );
        const caseInputSha256 = sha256(JSON.stringify(document));
        const caseManifest = caseManifestById.get(measurementCase.caseId);
        if (caseManifest === undefined) {
          throw new Error(`measurement case omitted its manifest: ${measurementCase.caseId}`);
        }
        const assets = createAssetCatalog(document);
        const rendererCapture = captureRenderer(
          createHeadlessSkiaOffscreenSceneRenderer(encodedAssets, textLayoutEnvironment),
        );
        let memoryBefore;
        let memoryAfter;
        let elapsedMs = 0;
        let result;

        if (!blockReadiness.ready) {
          memoryBefore = process.resourceUsage();
          memoryAfter = process.resourceUsage();
          result = {
            status: "failure",
            failure: {
              code: "host-precondition-failed",
              phase: "host-preflight",
              message: `workload block was not executed: ${blockReadiness.reasons.join(", ")}`,
            },
          };
        } else {
          try {
            if (measurementCase.operation === "export") {
              const backend = createSkiaExportBackend({ renderer: rendererCapture.renderer });
              const resolution = resolveExportPolicy(
                document.exportSettings,
                documentToExportSourceFacts(document),
                backend.capabilities,
              );
              if (resolution.status !== "resolved") {
                throw new Error(`export policy failed: ${resolution.error.code}`);
              }
              let preparedBytes = null;
              const operationInput = {
                document,
                assets,
                policy: resolution.policy,
                operation: {
                  id: `${runId}-${measurementCase.caseId}-${scheduleEntry.phase}-${scheduleEntry.sampleIndex}`,
                  directoryUri: "memory://render-measurement",
                  prepareStaticImage: async ({ bytes, mimeType, extension }) => {
                    preparedBytes = Uint8Array.from(bytes);
                    return {
                      kind: "static-image",
                      operationId: "render-measurement",
                      uri: `memory://render-measurement/output.${extension}`,
                      mimeType,
                      extension,
                    };
                  },
                  cleanup: async () => undefined,
                },
              };

              memoryBefore = process.resourceUsage();
              const measured = await measurePublicOperation(() => backend.prepare(operationInput));
              elapsedMs = measured.elapsedMs;
              memoryAfter = process.resourceUsage();
              if (measured.outcome.status === "threw") {
                result = {
                  status: "failure",
                  failure: renderFailure(
                    rendererCapture.lastResult(),
                    measured.outcome.error instanceof Error
                      ? measured.outcome.error.message
                      : "export measurement failed",
                  ),
                };
              } else if (measured.outcome.value.status !== "prepared" || preparedBytes === null) {
                result = {
                  status: "failure",
                  failure: renderFailure(
                    rendererCapture.lastResult(),
                    JSON.stringify(measured.outcome.value),
                  ),
                };
              } else {
                result = {
                  status: "success",
                  outputs: [inspectOutput(api, "export", preparedBytes)],
                };
              }
            } else {
              mockThumbnailWrites.clear();
              const adapter = createExpoDraftThumbnailAdapter({
                renderer: rendererCapture.renderer,
              });
              const generationInput = {
                draftId: "draft-render-measurement",
                contentRevision: 1,
                document,
                assets,
                profile: DRAFT_THUMBNAIL_PROFILE,
                squareUri: "memory://thumbnail-square.jpg",
                originalUri: "memory://thumbnail-original.jpg",
              };
              memoryBefore = process.resourceUsage();
              const measured = await measurePublicOperation(() =>
                adapter.generate(generationInput),
              );
              elapsedMs = measured.elapsedMs;
              memoryAfter = process.resourceUsage();
              if (measured.outcome.status === "threw") {
                result = {
                  status: "failure",
                  failure: renderFailure(
                    rendererCapture.lastResult(),
                    measured.outcome.error instanceof Error
                      ? measured.outcome.error.message
                      : "thumbnail measurement failed",
                  ),
                };
              } else {
                const square = mockThumbnailWrites.get("memory://thumbnail-square.jpg");
                const original = mockThumbnailWrites.get("memory://thumbnail-original.jpg");
                if (square === undefined || original === undefined) {
                  throw new Error("thumbnail adapter omitted an encoded representation");
                }
                result = {
                  status: "success",
                  outputs: [
                    inspectOutput(api, "square", square),
                    inspectOutput(api, "original", original),
                  ],
                };
              }
            }
          } catch (error) {
            memoryAfter ??= process.resourceUsage();
            result = {
              status: "failure",
              failure: renderFailure(
                rendererCapture.lastResult(),
                error instanceof Error ? error.message : "render measurement failed",
              ),
            };
          }
        }

        memoryBefore ??= process.resourceUsage();
        memoryAfter ??= process.resourceUsage();
        const sample = {
          schemaVersion: 1,
          runId,
          caseId: measurementCase.caseId,
          imageCount: measurementCase.imageCount,
          operation: measurementCase.operation,
          ...(measurementCase.operation === "export"
            ? { presetId: measurementCase.presetId, format: measurementCase.format }
            : { representations: ["square", "original"], format: measurementCase.format }),
          phase: scheduleEntry.phase,
          sampleIndex: scheduleEntry.sampleIndex,
          scheduleRound: scheduleEntry.round,
          elapsedMs,
          ...result,
          expectedOutputs: measurementCase.expectedOutputs,
          provenance: {
            ...provenance,
            caseInputSha256,
            caseManifestSha256: caseManifest.caseManifestSha256,
          },
          environment: { hostObservationBlockId: scheduleBlock.id },
          memory: {
            processPeakRssBytes: memoryAfter.maxRSS * 1024,
            processPeakRssScope: "process-cumulative",
            processPeakRssBeforeBytes: memoryBefore.maxRSS * 1024,
            nativeAllocationBytes: null,
            nativeAllocationUnavailableReason:
              "CanvasKit timing run has no native allocation profiler; profiler runs must be separate.",
          },
        };
        samples.push(sample);
        blockSamples.push(sample);
      }

      const blockPostflightHostState = captureHostState(ROOT);
      const blockEligibilityReasons = mergeSampleHostEligibilityReasons(
        initialEligibility.reasons,
        blockPreflightHostState,
        blockPostflightHostState,
      );
      for (const sample of blockSamples) {
        const eligible = blockEligibilityReasons.length === 0;
        sample.eligibility = {
          eligible,
          eligibleForEngineeringBaseline: eligible,
          eligibleForPhysicalDeviceHeadline: false,
          reasons: blockEligibilityReasons,
        };
      }
      hostObservationBlocks.push({
        id: scheduleBlock.id,
        phase: scheduleBlock.phase,
        round: scheduleBlock.round,
        preflight: blockPreflightHostState,
        postflight: blockPostflightHostState,
        readiness: blockReadiness,
        recovery,
        eligibilityReasons: blockEligibilityReasons,
      });
      sharedBoundaryHostState = blockPostflightHostState;
    }

    const postflightHostState = sharedBoundaryHostState;
    const finalRepositoryState = captureRepositoryState(plan, schedule);
    const repositoryDriftReasons = detectRepositoryStateDrift(
      initialRepositoryState,
      finalRepositoryState,
    );
    for (const sample of samples) {
      const sampleEligibilityReasons = [
        ...new Set([...sample.eligibility.reasons, ...repositoryDriftReasons]),
      ];
      const eligible = sampleEligibilityReasons.length === 0;
      sample.eligibility = {
        eligible,
        eligibleForEngineeringBaseline: eligible,
        eligibleForPhysicalDeviceHeadline: false,
        reasons: sampleEligibilityReasons,
      };
    }

    const outputDirectory = resolveRenderMeasurementOutputDirectory({
      root: ROOT,
      runId,
      environment: process.env,
    });
    const runEligibility = aggregateRunEligibility(initialEligibility, samples);
    writeMeasurementArtifacts(
      outputDirectory,
      {
        environment: {
          schemaVersion: 1,
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          command: "pnpm measure:render",
          profile,
          provenance,
          execution: createHeadlessExecutionContext(),
          staticEligibilityBeforeBlockRecovery: initialEligibility,
          eligibility: runEligibility,
          repositoryState: {
            preflight: initialRepositoryState,
            postflight: finalRepositoryState,
          },
          protocol: {
            warmupRunsPerCase: 1,
            measuredRunsPerCase: profile === "full" ? 3 : 1,
            planSha256: provenance.measurementPlanSha256,
            plan,
            orderStrategy: "all-warmups-then-balanced-round-rotation",
            scheduleSha256: provenance.measurementScheduleSha256,
            schedule,
            comparativeOrder: null,
            timingAndProfilerSeparated: true,
            hostMonitoring: {
              cadence: "shared boundaries around warmup block and each measured round",
              workloadScheduleProbeCount:
                1 +
                scheduleBlocks.length +
                hostObservationBlocks.reduce(
                  (count, { recovery }) => count + recovery.attempts.length - 1,
                  0,
                ),
              blockCount: scheduleBlocks.length,
              recoveryPolicy: DEFAULT_HOST_RECOVERY_POLICY,
              maximumRecoveryWaitMs:
                DEFAULT_HOST_RECOVERY_POLICY.intervalMs * DEFAULT_HOST_RECOVERY_POLICY.maxRetries,
              recoveryFailurePolicy:
                "A block that remains non-nominal after the bounded recovery window, or has a fail-fast power condition, is not executed; every planned entry is retained as a typed failure.",
              rationale:
                "Host commands run outside timing windows at shared block boundaries, avoiding per-sample ps/pmset/sysctl perturbation while preventing transient block interference from disappearing into a run-level postflight.",
            },
            contentCorrectness: {
              oracle: "render golden and pixel-diff suite",
              verification: renderVerification,
              verificationToThermalPreflightMs:
                renderVerification.status === "verified"
                  ? Date.parse(initialHostState.capturedAt) -
                    Date.parse(renderVerification.receipt.completedAt)
                  : null,
              boundary:
                "This runner verifies decode, exact dimensions, encoded format, bytes, and identity; it does not replace golden pixel correctness.",
            },
            timer: {
              clock: "performance.now",
              boundary:
                "Only await backend.prepare or thumbnailAdapter.generate; setup, output decode, SHA-256, memory snapshots, and reporting are excluded.",
            },
          },
          hostObservations: {
            preflight: initialHostState,
            postflight: postflightHostState,
            blocks: hostObservationBlocks,
          },
        },
        fixtures: {
          schemaVersion: 1,
          hashAlgorithm: "sha256",
          fixtureSetSha256,
          inputs,
          caseInputs,
          limitation:
            "Repository fixtures are deterministic small JPEGs; representative checksummed camera originals are a separate physical-device layer.",
        },
        samples,
      },
      plan,
    );
    const failures = samples.filter(({ status }) => status === "failure");
    console.log(`render measurement artifacts: ${outputDirectory}`);
    expect(failures).toEqual([]);
  });
});
