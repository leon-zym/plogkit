import { DEFAULT_HOST_RECOVERY_POLICY, recoverHostReadiness } from "./renderMeasurementRecovery";

function readiness({ retryable = [], failFast = [] } = {}) {
  const reasons = [...retryable, ...failFast];
  return {
    ready: reasons.length === 0,
    reasons,
    retryableReasons: retryable,
    failFastReasons: failFast,
  };
}

describe("render measurement host recovery", () => {
  it("uses a frozen bounded retry policy", () => {
    expect(DEFAULT_HOST_RECOVERY_POLICY).toEqual({ intervalMs: 2000, maxRetries: 3 });
  });

  it("recovers a transient thermal or process workload outside the timing window", async () => {
    const initialState = { id: "busy" };
    const states = [{ id: "thermal" }, { id: "clean" }];
    const readinessById = {
      busy: readiness({ retryable: ["concurrent-host-workload-detected"] }),
      thermal: readiness({ retryable: ["host-thermal-warning"] }),
      clean: readiness(),
    };
    const sleeps = [];

    const result = await recoverHostReadiness({
      initialState,
      captureState: () => states.shift(),
      evaluate: (state) => readinessById[state.id],
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    });

    expect(sleeps).toEqual([2000, 2000]);
    expect(result).toMatchObject({
      status: "ready",
      totalWaitMs: 4000,
      finalState: { id: "clean" },
    });
    expect(result.attempts.map(({ state }) => state.id)).toEqual(["busy", "thermal", "clean"]);
  });

  it("fails fast for manual power conditions without sleeping", async () => {
    const sleep = jest.fn();
    const result = await recoverHostReadiness({
      initialState: { id: "battery" },
      captureState: jest.fn(),
      evaluate: () => readiness({ failFast: ["host-on-battery-power"] }),
      sleep,
    });

    expect(result).toMatchObject({ status: "failed", failureMode: "fail-fast", totalWaitMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after three retries and records the complete bounded wait", async () => {
    const sleep = jest.fn(async () => undefined);
    const result = await recoverHostReadiness({
      initialState: { id: 0 },
      captureState: jest.fn(() => ({ id: 1 })),
      evaluate: () => readiness({ retryable: ["host-memory-pressure-warning"] }),
      sleep,
    });

    expect(result).toMatchObject({
      status: "failed",
      failureMode: "retry-limit",
      totalWaitMs: 6000,
    });
    expect(result.attempts).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
