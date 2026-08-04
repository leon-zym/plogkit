import { hostStateExecutionReadiness } from "./renderMeasurementHost";

export const DEFAULT_HOST_RECOVERY_POLICY = Object.freeze({
  intervalMs: 2000,
  maxRetries: 3,
});

export async function recoverHostReadiness({
  initialState,
  captureState,
  sleep,
  evaluate = hostStateExecutionReadiness,
  policy = DEFAULT_HOST_RECOVERY_POLICY,
}) {
  const attempts = [];
  let state = initialState;
  let totalWaitMs = 0;
  for (let retry = 0; retry <= policy.maxRetries; retry += 1) {
    const readiness = evaluate(state);
    attempts.push({ retry, state, readiness });
    if (readiness.ready) {
      return { status: "ready", totalWaitMs, attempts, finalState: state };
    }
    if (readiness.failFastReasons.length > 0) {
      return {
        status: "failed",
        failureMode: "fail-fast",
        totalWaitMs,
        attempts,
        finalState: state,
      };
    }
    if (retry === policy.maxRetries) {
      return {
        status: "failed",
        failureMode: "retry-limit",
        totalWaitMs,
        attempts,
        finalState: state,
      };
    }
    await sleep(policy.intervalMs);
    totalWaitMs += policy.intervalMs;
    state = captureState();
  }
  throw new Error("unreachable host recovery state");
}
