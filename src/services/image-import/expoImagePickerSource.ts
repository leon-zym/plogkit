import * as ImagePicker from "expo-image-picker";

import type { ImageSelectionSource, PickedImage, PickedImageKind } from "./importImages";

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

function pickedKind(type: ImagePicker.ImagePickerAsset["type"]): PickedImageKind {
  if (type === "livePhoto") return "livePhoto";
  if (type === "image" || type === null || type === undefined) return "image";
  return "unsupported";
}

function toPickedImage(asset: ImagePicker.ImagePickerAsset): PickedImage {
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

export function createExpoImagePickerSource(): ImageSelectionSource {
  return {
    select: async () => {
      const result = await ImagePicker.launchImageLibraryAsync(IMAGE_PICKER_OPTIONS);
      return result.canceled ? [] : result.assets.map(toPickedImage);
    },
  };
}
