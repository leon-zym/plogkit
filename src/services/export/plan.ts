import type { PlogDocument } from "../../core/document";
import {
  resolveExportPolicy,
  type ExportCapabilities,
  type ExportPolicyError,
  type ResolvedExportPolicy,
} from "../../core/exportPolicy";
import { documentToExportSourceFacts } from "../../render/exportSourceFacts";

export type ExportPlan = ResolvedExportPolicy;

export class ExportPlanningError extends Error {
  readonly code: ExportPolicyError["code"];
  readonly diagnostic: ExportPolicyError;

  constructor(diagnostic: ExportPolicyError) {
    super(
      diagnostic.code === "preset-unavailable"
        ? `export preset ${diagnostic.requestedPresetId} is unavailable`
        : `export policy is unsupported: ${diagnostic.reason}`,
    );
    this.name = "ExportPlanningError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}

/** Adapts document geometry to the authoritative Export Policy resolver. */
export function createExportPlan(
  document: PlogDocument,
  capabilities: ExportCapabilities,
): ExportPlan {
  const resolution = resolveExportPolicy(
    document.exportSettings,
    documentToExportSourceFacts(document),
    capabilities,
  );
  if (resolution.status === "failed") throw new ExportPlanningError(resolution.error);
  return resolution.policy;
}
