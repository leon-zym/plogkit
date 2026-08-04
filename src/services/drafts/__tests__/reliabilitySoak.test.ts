import {
  RELIABILITY_OPERATION_REGISTRY,
  runReliabilityProfile,
  runReliabilityTrace,
  verifyInterruptedSaveRecovery,
} from "../__test_support__/reliabilitySoakHarness";

jest.setTimeout(process.env.PLOGKIT_RELIABILITY_PROFILE === "evidence" ? 600_000 : 60_000);

describe("Draft reliability soak", () => {
  it("requires an explicit reliability policy for every operation", () => {
    expect(Object.keys(RELIABILITY_OPERATION_REGISTRY).sort()).toEqual(
      [
        "autosave",
        "cleanup-failure",
        "create",
        "delete",
        "deletion-failure",
        "deletion-unknown",
        "directory-publication",
        "dirty-save-new-edit",
        "ingest",
        "ingest-switch-delete",
        "interrupted-replacement",
        "list-failure",
        "noop-save",
        "probe-failure",
        "publication-failure",
        "publication-unknown",
        "read-failure",
        "replacement-after-copy",
        "replacement-after-remove",
        "replacement-before",
        "restart",
        "save",
        "stale-thumbnail",
        "switch",
        "switch-failure",
        "switch-validation-new-edit",
        "write-failure",
      ].sort(),
    );
    for (const policy of Object.values(RELIABILITY_OPERATION_REGISTRY)) {
      expect(policy).toHaveProperty("requiredFaults");
      expect(Array.isArray(policy.requiredFaults)).toBe(true);
    }
  });

  it("preserves the committed new Draft after an after-copy interruption and restart", async () => {
    await expect(verifyInterruptedSaveRecovery()).resolves.toMatchObject({
      recovered: "new",
      status: "opened",
    });
  });

  it("surfaces unknown publication before restart and preserves the committed Draft after recovery", async () => {
    const trace = await runReliabilityTrace({ seed: 1, steps: 17 });
    const event = trace.events.find(({ operation }) => operation === "publication-unknown");

    expect(event).toMatchObject({
      operation: "publication-unknown",
      result: "create-failed",
      recovery: "converged-after-restart",
    });
  });

  it("replays the same seed with an identical operation, fault, and event digest", async () => {
    const first = await runReliabilityTrace({ seed: 0x69a11ce, steps: 40 });
    const replay = await runReliabilityTrace({ seed: 0x69a11ce, steps: 40 });

    expect(replay.digest).toBe(first.digest);
    expect(replay.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(replay.events).toEqual(first.events);
  });

  it("preserves the last real typed result when a post-operation invariant fails", async () => {
    const run = () =>
      runReliabilityTrace({
        seed: 1,
        steps: 9,
        additionalInvariant: ({ step }) => {
          if (step === 8) throw new Error("injected independent invariant");
        },
      });

    const first = await run().catch((error: unknown) => String(error));
    const replay = await run().catch((error: unknown) => String(error));

    expect(first).toContain('"typedResult": {\n    "status": "recovery-failed",');
    expect(first).toContain('"reason": "storage-unavailable"');
    expect(first).toBe(replay);
  });

  it("runs the fixed reliability profile with every required operation and failpoint", async () => {
    const profileName = process.env.PLOGKIT_RELIABILITY_PROFILE ?? "quick";
    const evidence = profileName === "evidence";
    const replaySeed = profileName === "replay" ? process.env.PLOGKIT_RELIABILITY_SEED : undefined;
    const smokeSeeds = [1, 7, 42, 99, 256, 1001, 12345, 12648430] as const;
    const seeds =
      replaySeed !== undefined
        ? [Number(replaySeed)]
        : evidence
          ? Array.from({ length: 100 }, (_, index) => index)
          : smokeSeeds;
    const stepsPerSeed = Number(
      process.env.PLOGKIT_RELIABILITY_STEPS ??
        (evidence || replaySeed !== undefined ? "250" : "125"),
    );
    if (replaySeed === undefined && stepsPerSeed !== (evidence ? 250 : 125)) {
      throw new Error(
        `${evidence ? "evidence" : "quick"} profile requires exactly ${evidence ? 250 : 125} steps per seed`,
      );
    }
    const emitFailure = (phase: string, error: unknown): void => {
      if (process.env.PLOGKIT_RELIABILITY_FAILURE_REPORT === "1") {
        process.stdout.write(
          `RELIABILITY_FAILURE ${JSON.stringify({
            schemaVersion: 1,
            phase,
            message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      }
    };
    const runReportedProfile = async (phase: string) => {
      try {
        return await runReliabilityProfile({ seeds, stepsPerSeed });
      } catch (error: unknown) {
        emitFailure(phase, error);
        throw error;
      }
    };
    const profile = await runReportedProfile("baseline");
    const replay = evidence ? await runReportedProfile("deterministic-replay") : null;

    expect(profile.totalStateMachineSteps).toBe(seeds.length * stepsPerSeed);
    if (replaySeed === undefined) {
      if (evidence) {
        expect(profile.seedCount).toBe(100);
        expect(profile.stepsPerSeed).toBe(250);
        expect(profile.totalStateMachineSteps).toBe(25_000);
        expect(profile.seeds.map(({ seed }) => seed)).toEqual(
          Array.from({ length: 100 }, (_, index) => index),
        );
      } else {
        expect(profile.seedCount).toBe(8);
        expect(profile.stepsPerSeed).toBe(125);
        expect(profile.totalStateMachineSteps).toBe(1_000);
        expect(profile.seeds.map(({ seed }) => seed)).toEqual(smokeSeeds);
      }
    }
    if (replay !== null && replay.digest !== profile.digest) {
      const mismatchIndex = profile.events.findIndex(
        (event, index) => JSON.stringify(event) !== JSON.stringify(replay.events[index]),
      );
      const mismatch = profile.events[mismatchIndex] ?? replay.events[mismatchIndex];
      const error = new Error(
        `evidence replay digest mismatch at seed ${mismatch?.seed ?? "unknown"}, ` +
          `step ${mismatch?.step ?? "unknown"}; ` +
          `replay with pnpm test:reliability-soak:replay -- ${mismatch?.seed ?? 0} ${stepsPerSeed}`,
      );
      emitFailure("digest-comparison", error);
      throw error;
    }
    if (replaySeed === undefined) {
      for (const operation of [
        "create",
        "save",
        "ingest",
        "switch",
        "delete",
        "restart",
        "noop-save",
        "autosave",
      ]) {
        expect(profile.operationCounts[operation]).toBeGreaterThan(0);
      }
      for (const failpoint of [
        "read",
        "probe",
        "list",
        "write-before",
        "write-committed-unknown",
        "replacement-before",
        "replacement-after-remove",
        "replacement-after-copy",
        "replacement-interrupted",
        "directory-publication",
        "cleanup",
        "publication-marker",
        "deletion-marker",
        "delete-unknown-retry",
        "dirty-save-new-edit",
        "switch-validation-new-edit",
        "ingest-switch-delete",
        "autosave-switch-interleaving",
        "switch-failure-preserves-handle",
        "stale-async-completion",
      ]) {
        expect(profile.faultCounts[failpoint]).toBeGreaterThan(0);
      }
      expect(profile.typedFailures["delete-unknown"]).toBeGreaterThan(0);
    }
    if (replaySeed === undefined) expect(profile.recoveries).toBeGreaterThan(0);
    expect(profile.invariantViolations).toBe(0);

    const resultSummary = (value: typeof profile) => ({
      seedCount: value.seedCount,
      stepsPerSeed: value.stepsPerSeed,
      totalStateMachineSteps: value.totalStateMachineSteps,
      digest: value.digest,
      seeds: value.seeds,
      eventCount: value.events.length,
      operationCounts: value.operationCounts,
      faultCounts: value.faultCounts,
      typedFailures: value.typedFailures,
      simulatedRestarts: value.simulatedRestarts,
      recoveries: value.recoveries,
      invariantViolations: value.invariantViolations,
    });
    if (process.env.PLOGKIT_RELIABILITY_REPORT === "1") {
      process.stdout.write(
        `RELIABILITY_RESULT ${JSON.stringify({
          schemaVersion: 1,
          profile: profileName,
          baseline: resultSummary(profile),
          deterministicReplay: replay === null ? null : resultSummary(replay),
          digestsMatch: replay === null ? null : replay.digest === profile.digest,
        })}\n`,
      );
    }

    if (process.env.PLOGKIT_RELIABILITY_ARTIFACT === "1") {
      const { events: _replayEvents, ...replaySummary } = replay ?? profile;
      process.stdout.write(
        `RELIABILITY_PAYLOAD ${JSON.stringify({
          baseline: profile,
          deterministicReplay: replaySummary,
          digestsMatch: replaySummary.digest === profile.digest,
        })}\n`,
      );
    }
    if (process.env.PLOGKIT_RELIABILITY_REPORT === "1") {
      const { events: _events, ...summary } = profile;
      console.log(`RELIABILITY_SUMMARY ${JSON.stringify(summary)}`);
    }
  });
});
