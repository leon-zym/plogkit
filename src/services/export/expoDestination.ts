import { Directory, File, Paths } from "expo-file-system";
import { Asset, requestPermissionsAsync } from "expo-media-library";

import type { ExportPlan } from "./plan";
import type { ExportArtifact, ExportDestination } from "./types";

function outputFilename(plan: ExportPlan, filename?: string): string {
  const base = filename ?? `plogkit-${Date.now()}`;
  if (base.length === 0 || base.includes("/") || base.includes("\\")) {
    throw new Error("export filename must be a non-empty file name without path separators");
  }
  return base.endsWith(`.${plan.extension}`) ? base : `${base}.${plan.extension}`;
}

export class ExpoExportDestination implements ExportDestination {
  async writeAndSave(
    bytes: Uint8Array,
    plan: ExportPlan,
    filename?: string,
  ): Promise<ExportArtifact> {
    const directory = new Directory(Paths.document, "exports");
    directory.create({ intermediates: true, idempotent: true });
    const file = new File(directory, outputFilename(plan, filename));
    file.create({ overwrite: false });
    file.write(bytes);

    const permission = await requestPermissionsAsync(true, ["photo"]);
    if (!permission.granted) {
      throw new Error("photo library write permission was not granted");
    }
    const asset = await Asset.create(file.uri);
    return { fileUri: file.uri, assetId: asset.id };
  }
}
