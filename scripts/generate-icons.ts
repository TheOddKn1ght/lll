/** Dependency-free rasterization of the app's own geometric icon. */
import { deflateSync } from "node:zlib";

const table = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function chunk(type: string, data: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const value of payload) crc = table[(crc ^ value) & 255]! ^ (crc >>> 8);
  const result = Buffer.alloc(payload.length + 8);
  result.writeUInt32BE(data.length);
  payload.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function roundRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
) {
  const dx = Math.max(left + radius - x, 0, x - (right - radius));
  const dy = Math.max(top + radius - y, 0, y - (bottom - radius));
  return (
    x >= left &&
    x <= right &&
    y >= top &&
    y <= bottom &&
    dx * dx + dy * dy <= radius * radius
  );
}
function rotate(x: number, y: number, cx: number, cy: number, angle: number) {
  const radians = (-angle * Math.PI) / 180,
    dx = x - cx,
    dy = y - cy;
  return [
    cx + dx * Math.cos(radians) - dy * Math.sin(radians),
    cy + dx * Math.sin(radians) + dy * Math.cos(radians),
  ] as const;
}
function segment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
) {
  const dx = bx - ax,
    dy = by - ay,
    t = Math.max(
      0,
      Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)),
    );
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= width * width;
}
async function raster(size: number, name: string, maskable = false) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          let px = ((x + (sx + 0.5) / 2) * 192) / size,
            py = ((y + (sy + 0.5) / 2) * 192) / size;
          if (!maskable && !roundRect(px, py, 0, 0, 192, 192, 46)) continue;
          if (maskable) {
            px = (px - 96) / 0.8 + 96;
            py = (py - 96) / 0.8 + 96;
          }
          let color = [109, 92, 231];
          const [rx, ry] = rotate(px, py, 98, 97, 10);
          if (
            roundRect(rx, ry, 52, 38, 144, 156, 18) &&
            !roundRect(rx, ry, 62, 48, 134, 146, 8)
          )
            color = [175, 165, 242];
          const [fx, fy] = rotate(px, py, 83, 95, -9);
          if (roundRect(fx, fy, 37, 36, 129, 154, 18))
            color = roundRect(fx, fy, 47, 46, 119, 144, 8)
              ? [109, 92, 231]
              : [255, 255, 255];
          if (
            segment(px, py, 65, 93, 78, 107, 5) ||
            segment(px, py, 78, 107, 104, 75, 5)
          )
            color = [255, 255, 255];
          for (let i = 0; i < 3; i++) sum[i]! += color[i]!;
          sum[3]! += 255;
        }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let i = 0; i < 4; i++) raw[offset + i] = Math.round(sum[i]! / 4);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    // PNG requires a zlib header and Adler-32 trailer around DEFLATE data.
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
  await Bun.write(new URL(`../public/icons/${name}`, import.meta.url), png);
}
await raster(192, "icon-192.png");
await raster(512, "icon-512.png");
await raster(512, "maskable-512.png", true);
await raster(180, "apple-touch-icon.png");
console.log("Generated app icons.");
