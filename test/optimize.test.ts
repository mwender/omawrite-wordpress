import { test, expect } from "bun:test";
import sharp from "sharp";
import { optimizeImage, DEFAULT_IMAGE_SETTINGS } from "../src/optimize.ts";
import { photoPng, graphicPng, transparentPng } from "./images.ts";

const ok = (r: Awaited<ReturnType<typeof optimizeImage>>) => {
  if (!r.optimized) throw new Error(`not optimized: ${r.reason}`);
  return r;
};
const meta = (b: Uint8Array) => sharp(b).metadata();

test("photos become lossy WebP at quality 75, byte-for-byte deterministic", async () => {
  const png = await photoPng();
  const a = ok(await optimizeImage(png));
  const b = ok(await optimizeImage(png));
  expect(a.mode).toBe("lossy q75");
  expect(a.bytes.length).toBeLessThan(png.length / 2);
  expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  expect((await meta(a.bytes)).format).toBe("webp");
});

test("graphics with few colors are kept lossless when that's competitive", async () => {
  const r = ok(await optimizeImage(await graphicPng()));
  expect(r.mode).toBe("lossless");
});

test("respects the quality setting", async () => {
  const png = await photoPng();
  const low = ok(await optimizeImage(png, { ...DEFAULT_IMAGE_SETTINGS, quality: 50 }));
  const high = ok(await optimizeImage(png, { ...DEFAULT_IMAGE_SETTINGS, quality: 90 }));
  expect(low.bytes.length).toBeLessThan(high.bytes.length);
  expect(high.mode).toBe("lossy q90");
});

test("caps the longest side without upscaling", async () => {
  const big = ok(await optimizeImage(await photoPng(3000, 1500)));
  expect([big.width, big.height]).toEqual([2560, 1280]);
  const small = ok(await optimizeImage(await photoPng(300, 200)));
  expect([small.width, small.height]).toEqual([300, 200]);
});

test("drops an alpha channel only when nothing is transparent", async () => {
  expect((await meta(ok(await optimizeImage(await photoPng(600, 400, true))).bytes)).hasAlpha).toBe(false);
  expect((await meta(ok(await optimizeImage(await transparentPng())).bytes)).hasAlpha).toBe(true);
});

test("rotates by EXIF orientation and strips metadata (including GPS)", async () => {
  const jpeg = await sharp(await photoPng(300, 200))
    .jpeg({ quality: 95 })
    .withExif({ IFD0: { Make: "Phone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 57/1 0/1" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  expect((await meta(jpeg)).exif).toBeDefined();
  const r = ok(await optimizeImage(jpeg));
  expect([r.width, r.height]).toEqual([200, 300]);
  const out = await meta(r.bytes);
  expect(out.exif).toBeUndefined();
  expect(out.orientation).toBeUndefined();
});

test("leaves WebP and images it can't shrink alone", async () => {
  const webp = await sharp(await photoPng()).webp().toBuffer();
  expect(await optimizeImage(webp)).toEqual({ optimized: false, reason: "already WebP" });
  // Already crushed: re-encoding at q75 would be bigger, so keep the original.
  const crushed = await sharp(await photoPng()).jpeg({ quality: 20 }).toBuffer();
  expect(await optimizeImage(crushed)).toEqual({ optimized: false, reason: "WebP wasn't smaller" });
});
