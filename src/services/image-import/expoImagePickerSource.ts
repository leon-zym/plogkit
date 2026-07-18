import * as ImagePicker from "expo-image-picker";

import type {
  ImportCandidate,
  ImportCandidateKind,
} from "../drafts/draftLibrary";

export const IMAGE_PICKER_OPTIONS = {
  mediaTypes: ["images", "livePhotos"],
  allowsMultipleSelection: true,
  allowsEditing: false,
  selectionLimit: 9,
  orderedSelection: true,
  exif: true,
  quality: 1,
  shouldDownloadFromNetwork: true,
  preferredAssetRepresentationMode:
    ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
} satisfies ImagePicker.ImagePickerOptions;

function pickedKind(type: ImagePicker.ImagePickerAsset["type"]): ImportCandidateKind {
  if (type === "livePhoto") return "livePhoto";
  if (type === "image" || type === null || type === undefined) return "image";
  return "unsupported";
}

function toPickedImage(asset: ImagePicker.ImagePickerAsset): ImportCandidate {
  const exif: unknown = asset.exif;
  return {
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    fileName: asset.fileName,
    kind: pickedKind(asset.type),
    exif,
    pairedVideoUri: asset.pairedVideoAsset?.uri,
  };
}

export interface ImageSelectionSource {
  readonly select: () => Promise<readonly ImportCandidate[]>;
}

export function createExpoImagePickerSource(): ImageSelectionSource {
  return {
    select: async () => {
      const result = await ImagePicker.launchImageLibraryAsync(IMAGE_PICKER_OPTIONS);
      return result.canceled ? [] : result.assets.map(toPickedImage);
    },
  };
}
