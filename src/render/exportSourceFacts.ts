import type { PlogDocument } from "../core/document";
import type { ExportSourceFacts } from "../core/exportPolicy";
import { documentToRenderScene, getNaturalSceneSize } from "./scene";

export function documentToExportSourceFacts(document: PlogDocument): ExportSourceFacts {
  const scene = documentToRenderScene(document);
  const naturalSize = getNaturalSceneSize(scene);
  return {
    naturalWidth: naturalSize.width,
    naturalHeight: naturalSize.height,
  };
}
