const { join } = require("node:path");

const RENDER_MEASUREMENT_DIRECTORY_NAME = "render-measurements.noindex";

function defaultRenderMeasurementRoot(root) {
  return join(root, "artifacts", RENDER_MEASUREMENT_DIRECTORY_NAME);
}

function resolveRenderMeasurementOutputDirectory({ root, runId, environment = process.env }) {
  if (environment.PLOGKIT_RENDER_MEASUREMENT_DIR !== undefined) {
    return environment.PLOGKIT_RENDER_MEASUREMENT_DIR;
  }
  const artifactRoot =
    environment.PLOGKIT_RENDER_MEASUREMENT_ROOT ?? defaultRenderMeasurementRoot(root);
  return join(artifactRoot, runId);
}

module.exports = {
  defaultRenderMeasurementRoot,
  resolveRenderMeasurementOutputDirectory,
};
