import { ImageFormat, Skia } from "@shopify/react-native-skia";
import { File } from "expo-file-system";

import type { DraftLibraryPreviewAdapter } from "../drafts/draftLibrary";

export function createSkiaPreviewGenerator(): DraftLibraryPreviewAdapter {
  return {
    isValid: async (uri) => {
      try {
        const data = await Skia.Data.fromURI(uri);
        try {
          const image = Skia.Image.MakeImageFromEncoded(data);
          if (image === null) return false;
          image.dispose();
          return true;
        } finally {
          data.dispose();
        }
      } catch {
        return false;
      }
    },
    generate: async (sourceUri, destinationUri, maxLongEdge) => {
      if (!Number.isInteger(maxLongEdge) || maxLongEdge <= 0) {
        throw new Error("preview max long edge must be a positive integer");
      }
      const data = await Skia.Data.fromURI(sourceUri);
      try {
        const source = Skia.Image.MakeImageFromEncoded(data);
        if (source === null) throw new Error("Skia could not decode image");
        try {
          const scale = Math.min(1, maxLongEdge / Math.max(source.width(), source.height()));
          const width = Math.max(1, Math.round(source.width() * scale));
          const height = Math.max(1, Math.round(source.height() * scale));
          const surface = Skia.Surface.MakeOffscreen(width, height);
          if (surface === null) throw new Error("Skia could not create preview surface");
          try {
            const paint = Skia.Paint();
            try {
              surface
                .getCanvas()
                .drawImageRect(
                  source,
                  Skia.XYWHRect(0, 0, source.width(), source.height()),
                  Skia.XYWHRect(0, 0, width, height),
                  paint,
                );
              surface.flush();
              const preview = surface.makeImageSnapshot();
              try {
                const destination = new File(destinationUri);
                destination.create({ intermediates: true, overwrite: true });
                destination.write(preview.encodeToBytes(ImageFormat.JPEG, 90));
              } finally {
                preview.dispose();
              }
            } finally {
              paint.dispose();
            }
          } finally {
            surface.dispose();
          }
          return { width, height };
        } finally {
          source.dispose();
        }
      } finally {
        data.dispose();
      }
    },
  };
}
