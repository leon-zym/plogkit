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

export function parseImageMetadataSidecar(input: unknown): ImageMetadataSidecar | null {
  if (!isRecord(input)) return null;
  const metadata: ImageMetadataSidecar = {
    capturedAt: readString(input, "capturedAt"),
    deviceMake: readString(input, "deviceMake"),
    deviceModel: readString(input, "deviceModel"),
    lensMake: readString(input, "lensMake"),
    lensModel: readString(input, "lensModel"),
    software: readString(input, "software"),
  };
  return Object.values(metadata).some((value) => value !== undefined) ? metadata : null;
}

export function toExifDateTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
