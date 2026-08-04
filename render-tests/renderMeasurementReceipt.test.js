import { validateRenderVerificationReceipt } from "./renderMeasurementReceipt";

const EXPECTED = {
  commit: "a".repeat(40),
  lockfileSha256: "b".repeat(64),
};

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    verificationCommand: "pnpm test:render",
    commit: EXPECTED.commit,
    lockfileSha256: EXPECTED.lockfileSha256,
    completedAt: "2026-08-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("render verification receipt", () => {
  it("accepts and fingerprints a structured receipt for the exact repository identity", () => {
    expect(validateRenderVerificationReceipt(JSON.stringify(receipt()), EXPECTED)).toEqual({
      status: "verified",
      receipt: receipt(),
      receiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.each([
    ["missing", null],
    ["invalid JSON", "not-json"],
    ["wrong commit", JSON.stringify(receipt({ commit: "c".repeat(40) }))],
    ["wrong lockfile", JSON.stringify(receipt({ lockfileSha256: "d".repeat(64) }))],
    ["invalid completion time", JSON.stringify(receipt({ completedAt: "yesterday" }))],
  ])("fails closed for a %s receipt", (_label, raw) => {
    expect(validateRenderVerificationReceipt(raw, EXPECTED)).toEqual({
      status: "invalid",
      reason: "render verification receipt is missing or does not match this run",
    });
  });
});
