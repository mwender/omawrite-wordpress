import sharp, { type Sharp } from "sharp";

// Image optimization for uploads. Deterministic: the output depends only on the input
// bytes, these settings, and the pinned sharp/libvips/libwebp versions.

export interface ImageSettings {
  quality: number; // WebP lossy quality
  maxSize: number; // longest side, px (WordPress scales anything above 2560 anyway)
}

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = { quality: 75, maxSize: 2560 };

// Images with fewer distinct colors than this are treated as graphics/screenshots and
// also tried lossless, which keeps text and flat areas crisp.
const GRAPHIC_MAX_COLORS = 1024;
// Lossless wins if it's at most this much bigger than lossy.
const LOSSLESS_SLACK = 1.25;

export type OptimizeResult =
  | { optimized: true; bytes: Uint8Array; width: number; height: number; mode: string }
  | { optimized: false; reason: string };

async function countColors(image: Sharp, limit: number): Promise<number> {
  const { data, info } = await image.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = new Uint32Array(new Uint8Array(data).buffer, 0, info.width * info.height); // copy: sharp's buffer may be unaligned
  const seen = new Set<number>();
  for (let i = 0; i < px.length; i++) {
    seen.add(px[i]!);
    if (seen.size > limit) break;
  }
  return seen.size;
}

export async function optimizeImage(input: Uint8Array, settings: ImageSettings = DEFAULT_IMAGE_SETTINGS): Promise<OptimizeResult> {
  const meta = await sharp(input).metadata();
  if (meta.format === "webp" || meta.format === "heif") return { optimized: false, reason: `already ${meta.format === "heif" ? "AVIF" : "WebP"}` };
  if (meta.format === "gif" && (meta.pages ?? 1) > 1) return { optimized: false, reason: "animated GIF" };

  // Upright (EXIF orientation), capped in size, metadata stripped (sharp's default,
  // which also drops GPS location), converted to sRGB.
  let image = sharp(input)
    .rotate()
    .resize({ width: settings.maxSize, height: settings.maxSize, fit: "inside", withoutEnlargement: true });
  if (meta.hasAlpha && (await sharp(input).stats()).isOpaque) image = image.removeAlpha();

  const lossy = await image.clone().webp({ quality: settings.quality, effort: 6 }).toBuffer({ resolveWithObject: true });
  let best = { data: lossy.data, info: lossy.info, mode: `lossy q${settings.quality}` };

  if ((await countColors(image, GRAPHIC_MAX_COLORS)) <= GRAPHIC_MAX_COLORS) {
    const lossless = await image.clone().webp({ lossless: true, effort: 6 }).toBuffer({ resolveWithObject: true });
    if (lossless.data.length <= lossy.data.length * LOSSLESS_SLACK) best = { ...lossless, mode: "lossless" };
  }

  if (best.data.length >= input.length) return { optimized: false, reason: "WebP wasn't smaller" };
  return { optimized: true, bytes: new Uint8Array(best.data), width: best.info.width, height: best.info.height, mode: best.mode };
}
