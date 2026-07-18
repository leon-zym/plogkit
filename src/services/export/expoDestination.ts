import { Asset, requestPermissionsAsync } from "expo-media-library";

import type {
  PhotosDestination,
  PhotosDestinationResult,
  PreparedExport,
} from "./types";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class ExpoPhotosDestination implements PhotosDestination {
  async publish(
    prepared: PreparedExport,
    signal?: AbortSignal,
  ): Promise<PhotosDestinationResult> {
    if (isAborted(signal)) return { status: "cancelled", phase: "permission" };

    let granted: boolean;
    try {
      granted = (await requestPermissionsAsync(true, ["photo"])).granted;
    } catch {
      return { status: "failure", code: "permission-denied", phase: "permission" };
    }
    if (!granted) {
      return { status: "failure", code: "permission-denied", phase: "permission" };
    }
    if (isAborted(signal)) return { status: "cancelled", phase: "destination" };

    let asset: Awaited<ReturnType<typeof Asset.create>>;
    try {
      asset = await Asset.create(prepared.uri);
    } catch {
      return { status: "failure", code: "destination-failed", phase: "destination" };
    }
    if (asset.id.length === 0) {
      throw new Error("Photos destination returned an empty system asset identity");
    }
    return { status: "published", assetId: asset.id };
  }
}
