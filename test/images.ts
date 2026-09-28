// Deterministic test images generated with sharp.
import sharp from "sharp";

function noise(width: number, height: number, channels: 3 | 4, seed = 1): Buffer {
  const buf = Buffer.alloc(width * height * channels);
  let x = seed;
  for (let i = 0; i < buf.length; i++) {
    if (channels === 4 && i % 4 === 3) { buf[i] = 255; continue; }
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const pos = Math.floor(i / channels);
    buf[i] = ((pos % width) * 255) / width * 0.6 + (x % 100); // gradient + grain, like a photo
  }
  return buf;
}

// Photo-like: many colors. `alpha` adds an (opaque) alpha channel, like screenshots saved as RGBA.
export function photoPng(width = 600, height = 400, alpha = false): Promise<Buffer> {
  const channels = alpha ? 4 : 3;
  return sharp(noise(width, height, channels), { raw: { width, height, channels } }).png().toBuffer();
}

// Graphic-like: a few flat colors in a pattern that PNG doesn't compress perfectly.
export function graphicPng(width = 600, height = 400): Promise<Buffer> {
  const colors = [[250, 250, 250], [30, 30, 30], [32, 119, 178], [220, 60, 60]];
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = colors[(Math.floor(x / 7) * 3 + Math.floor(y / 5) * 5 + ((x * y) % 3)) % colors.length]!;
      buf.set(c, (y * width + x) * 3);
    }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
}

export function transparentPng(): Promise<Buffer> {
  return sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } })
    .composite([{ input: noise(100, 100, 4), raw: { width: 100, height: 100, channels: 4 }, left: 10, top: 10 }])
    .png()
    .toBuffer();
}
