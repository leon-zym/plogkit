import { injectBasicExif, stripExifApp1, type BasicExifMetadata } from "../exif";

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function exifTags(jpeg: Uint8Array): readonly number[] {
  expect([...jpeg.slice(2, 6)]).toEqual([0xff, 0xe1, jpeg[4], jpeg[5]]);
  const tiff = 12;
  const ifd0 = tiff + readUint32(jpeg, tiff + 4);
  const tags: number[] = [];
  const count = readUint16(jpeg, ifd0);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd0 + 2 + index * 12;
    const tag = readUint16(jpeg, entry);
    tags.push(tag);
    if (tag === 0x8769) {
      const exifIfd = tiff + readUint32(jpeg, entry + 8);
      const exifCount = readUint16(jpeg, exifIfd);
      for (let exifIndex = 0; exifIndex < exifCount; exifIndex += 1) {
        tags.push(readUint16(jpeg, exifIfd + 2 + exifIndex * 12));
      }
    }
  }
  return tags;
}

function minimalJpeg(extraSegments: Uint8Array = new Uint8Array()): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...extraSegments,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x12,
    0x34,
    0xff,
    0xda,
    0x00,
    0x02,
    0xff,
    0xd9,
  ]);
}

function gpsExifSegment(): Uint8Array {
  const payload = new Uint8Array([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const length = payload.length + 2;
  return new Uint8Array([0xff, 0xe1, length >>> 8, length & 0xff, ...payload]);
}

describe("JPEG retain-basic EXIF", () => {
  it("writes only capture time and device information without a GPS IFD", () => {
    const result = injectBasicExif(minimalJpeg(), {
      dateTimeOriginal: "2026:07:11 10:20:30",
      make: "Apple",
      model: "iPhone",
    });
    const tags = exifTags(result);

    expect(tags).toEqual([0x010f, 0x0110, 0x8769, 0x9003]);
    expect(tags).not.toContain(0x8825);
  });

  it("strips an existing EXIF segment containing GPS before reinjection", () => {
    const source = minimalJpeg(gpsExifSegment());
    const stripped = stripExifApp1(source);
    const result = injectBasicExif(source, { make: "Apple" });

    expect([...stripped.slice(2, 4)]).toEqual([0xff, 0xe0]);
    expect(exifTags(result)).toEqual([0x010f]);
    expect(exifTags(result)).not.toContain(0x8825);
  });

  it("rejects non-whitelisted, non-ASCII, and malformed capture-time metadata", () => {
    const unknown = { make: "Apple", gpsLatitude: "31.2" } as BasicExifMetadata;

    expect(() => injectBasicExif(minimalJpeg(), unknown)).toThrow(
      "not in the basic metadata whitelist",
    );
    expect(() => injectBasicExif(minimalJpeg(), { model: "手机" })).toThrow("printable ASCII");
    expect(() => injectBasicExif(minimalJpeg(), { dateTimeOriginal: "2026-07-11" })).toThrow(
      "YYYY:MM:DD",
    );
  });
});
