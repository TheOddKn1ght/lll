import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
] as const)
  test(`${name} contains valid PNG chunks and zlib-compressed pixels`, async () => {
    const png = Buffer.from(
      await Bun.file(
        new URL(`../public/icons/${name}`, import.meta.url),
      ).arrayBuffer(),
    );
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const types: string[] = [];
    const data: Buffer[] = [];
    let offset = 8;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const end = offset + 8 + length;
      expect(end + 4).toBeLessThanOrEqual(png.length);
      const type = png.toString("ascii", offset + 4, offset + 8);
      types.push(type);
      // A bitwise CRC implementation independent of the generator's lookup table.
      let crc = 0xffffffff;
      for (const byte of png.subarray(offset + 4, end)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      expect(png.readUInt32BE(end)).toBe((crc ^ 0xffffffff) >>> 0);
      if (type === "IHDR") {
        expect(length).toBe(13);
        expect(png.readUInt32BE(offset + 8)).toBe(size);
        expect(png.readUInt32BE(offset + 12)).toBe(size);
        expect([...png.subarray(offset + 16, end)]).toEqual([8, 6, 0, 0, 0]);
      }
      if (type === "IDAT") data.push(png.subarray(offset + 8, end));
      offset = end + 4;
    }
    expect(offset).toBe(png.length);
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    // inflateSync checks the zlib wrapper and checksum, which raw DEFLATE lacks.
    const pixels = inflateSync(Buffer.concat(data));
    const stride = size * 4 + 1;
    expect(pixels.length).toBe(stride * size);
    for (let row = 0; row < size; row++) expect(pixels[row * stride]).toBe(0);
    expect(pixels.some((byte) => byte !== 0)).toBe(true);
  });
