export interface BasicExifMetadata {
  readonly dateTimeOriginal?: string;
  readonly make?: string;
  readonly model?: string;
}

const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] as const;
const ALLOWED_KEYS = new Set<keyof BasicExifMetadata>(["dateTimeOriginal", "make", "model"]);

interface AsciiIfdEntry {
  readonly tag: number;
  readonly value: Uint8Array;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function assertJpeg(bytes: Uint8Array): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("EXIF metadata can only be injected into a JPEG file");
  }
}

function isExifSegment(bytes: Uint8Array, offset: number): boolean {
  const payloadOffset = offset + 4;
  return EXIF_SIGNATURE.every((value, index) => bytes[payloadOffset + index] === value);
}

/** Removes pre-existing EXIF APP1 segments so GPS can never survive reinjection. */
export function stripExifApp1(jpeg: Uint8Array): Uint8Array {
  assertJpeg(jpeg);
  const parts: Uint8Array[] = [jpeg.slice(0, 2)];
  let offset = 2;

  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff || offset + 1 >= jpeg.length) {
      throw new Error("JPEG contains a malformed marker sequence");
    }
    const marker = jpeg[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) {
      parts.push(jpeg.slice(offset));
      return concatBytes(parts);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(jpeg.slice(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 3 >= jpeg.length) {
      throw new Error("JPEG segment length is truncated");
    }
    const segmentLength = (jpeg[offset + 2]! << 8) | jpeg[offset + 3]!;
    if (segmentLength < 2) {
      throw new Error("JPEG segment length is invalid");
    }
    const segmentEnd = offset + 2 + segmentLength;
    if (segmentEnd > jpeg.length) {
      throw new Error("JPEG segment payload is truncated");
    }
    if (marker !== 0xe1 || !isExifSegment(jpeg, offset)) {
      parts.push(jpeg.slice(offset, segmentEnd));
    }
    offset = segmentEnd;
  }

  return concatBytes(parts);
}

function ascii(value: string, field: keyof BasicExifMetadata): Uint8Array {
  if (value.length === 0 || value.length > 127) {
    throw new Error(`EXIF ${field} must contain 1 to 127 ASCII characters`);
  }
  const output = new Uint8Array(value.length + 1);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      throw new Error(`EXIF ${field} must contain printable ASCII only`);
    }
    output[index] = code;
  }
  return output;
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeAsciiEntry(
  tiff: Uint8Array,
  entryOffset: number,
  entry: AsciiIfdEntry,
  externalOffset: number,
): number {
  writeUint16(tiff, entryOffset, entry.tag);
  writeUint16(tiff, entryOffset + 2, 2);
  writeUint32(tiff, entryOffset + 4, entry.value.length);
  if (entry.value.length <= 4) {
    tiff.set(entry.value, entryOffset + 8);
    return externalOffset;
  }
  writeUint32(tiff, entryOffset + 8, externalOffset);
  tiff.set(entry.value, externalOffset);
  return externalOffset + entry.value.length;
}

function makeTiff(metadata: BasicExifMetadata): Uint8Array | null {
  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_KEYS.has(key as keyof BasicExifMetadata)) {
      throw new Error(`EXIF field ${key} is not in the basic metadata whitelist`);
    }
  }

  if (
    metadata.dateTimeOriginal !== undefined &&
    !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(metadata.dateTimeOriginal)
  ) {
    throw new Error("EXIF dateTimeOriginal must use YYYY:MM:DD HH:mm:ss");
  }

  const ifd0Entries: AsciiIfdEntry[] = [];
  if (metadata.make !== undefined) {
    ifd0Entries.push({ tag: 0x010f, value: ascii(metadata.make, "make") });
  }
  if (metadata.model !== undefined) {
    ifd0Entries.push({ tag: 0x0110, value: ascii(metadata.model, "model") });
  }
  const dateValue =
    metadata.dateTimeOriginal === undefined
      ? null
      : ascii(metadata.dateTimeOriginal, "dateTimeOriginal");
  if (ifd0Entries.length === 0 && dateValue === null) {
    return null;
  }

  const ifd0Count = ifd0Entries.length + (dateValue === null ? 0 : 1);
  const ifd0TableEnd = 8 + 2 + ifd0Count * 12 + 4;
  const externalIfd0Size = ifd0Entries.reduce(
    (total, entry) => total + (entry.value.length > 4 ? entry.value.length : 0),
    0,
  );
  const exifIfdOffset = ifd0TableEnd + externalIfd0Size;
  const exifIfdSize = dateValue === null ? 0 : 2 + 12 + 4 + dateValue.length;
  const tiff = new Uint8Array(exifIfdOffset + exifIfdSize);

  tiff[0] = 0x49;
  tiff[1] = 0x49;
  writeUint16(tiff, 2, 42);
  writeUint32(tiff, 4, 8);
  writeUint16(tiff, 8, ifd0Count);

  let externalOffset = ifd0TableEnd;
  ifd0Entries.forEach((entry, index) => {
    externalOffset = writeAsciiEntry(tiff, 10 + index * 12, entry, externalOffset);
  });
  if (dateValue !== null) {
    const pointerOffset = 10 + ifd0Entries.length * 12;
    writeUint16(tiff, pointerOffset, 0x8769);
    writeUint16(tiff, pointerOffset + 2, 4);
    writeUint32(tiff, pointerOffset + 4, 1);
    writeUint32(tiff, pointerOffset + 8, exifIfdOffset);

    writeUint16(tiff, exifIfdOffset, 1);
    writeAsciiEntry(tiff, exifIfdOffset + 2, { tag: 0x9003, value: dateValue }, exifIfdOffset + 18);
    writeUint32(tiff, exifIfdOffset + 14, 0);
  }
  writeUint32(tiff, 10 + ifd0Count * 12, 0);
  return tiff;
}

/** Injects only capture time and device make/model; it never creates a GPS IFD. */
export function injectBasicExif(jpeg: Uint8Array, metadata: BasicExifMetadata): Uint8Array {
  const stripped = stripExifApp1(jpeg);
  const tiff = makeTiff(metadata);
  if (tiff === null) {
    return stripped;
  }

  const payload = concatBytes([new Uint8Array(EXIF_SIGNATURE), tiff]);
  const segmentLength = payload.length + 2;
  if (segmentLength > 0xffff) {
    throw new Error("EXIF APP1 payload exceeds the JPEG segment limit");
  }
  const app1 = new Uint8Array(payload.length + 4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (segmentLength >>> 8) & 0xff;
  app1[3] = segmentLength & 0xff;
  app1.set(payload, 4);
  return concatBytes([stripped.slice(0, 2), app1, stripped.slice(2)]);
}
