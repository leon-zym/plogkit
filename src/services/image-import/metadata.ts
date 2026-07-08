export interface ImageMetadataSidecar {
  readonly capturedAt?: string;
  readonly deviceMake?: string;
  readonly deviceModel?: string;
  readonly lensMake?: string;
  readonly lensModel?: string;
  readonly software?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function extractImageMetadata(exif: unknown): ImageMetadataSidecar | null {
  if (!isRecord(exif)) return null;

  const metadata: ImageMetadataSidecar = {
    capturedAt: readString(exif, "DateTimeOriginal") ?? readString(exif, "DateTime"),
    deviceMake: readString(exif, "Make"),
    deviceModel: readString(exif, "Model"),
    lensMake: readString(exif, "LensMake"),
    lensModel: readString(exif, "LensModel"),
    software: readString(exif, "Software"),
  };
  return Object.values(metadata).some((value) => value !== undefined) ? metadata : null;
}
