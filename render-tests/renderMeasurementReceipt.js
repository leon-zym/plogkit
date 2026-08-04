import { createHash } from "node:crypto";

const INVALID_RECEIPT_REASON = "render verification receipt is missing or does not match this run";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateRenderVerificationReceipt(raw, expected) {
  if (typeof raw !== "string") {
    return { status: "invalid", reason: INVALID_RECEIPT_REASON };
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.verificationCommand !== "pnpm test:render" ||
      parsed.commit !== expected.commit ||
      parsed.lockfileSha256 !== expected.lockfileSha256 ||
      typeof parsed.completedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.completedAt))
    ) {
      return { status: "invalid", reason: INVALID_RECEIPT_REASON };
    }
    const receipt = {
      schemaVersion: 1,
      verificationCommand: parsed.verificationCommand,
      commit: parsed.commit,
      lockfileSha256: parsed.lockfileSha256,
      completedAt: parsed.completedAt,
    };
    return {
      status: "verified",
      receipt,
      receiptSha256: sha256(JSON.stringify(receipt)),
    };
  } catch {
    return { status: "invalid", reason: INVALID_RECEIPT_REASON };
  }
}
