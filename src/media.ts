import { join, resolve, dirname, basename, extname, isAbsolute } from "node:path";
import { expandHome } from "./config.ts";
import { hash, type Site } from "./sync.ts";
import { parse, type FrontMatter } from "./frontmatter.ts";
import { optimizeImage, DEFAULT_IMAGE_SETTINGS, type ImageSettings } from "./optimize.ts";
import type { WPMedia, WPPost } from "./wp.ts";

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

export interface FeaturedImagePlan {
  changes: { field: string; from: string; to: string }[];
  // Runs after confirmation: uploads if needed, updates alt text, and returns the
  // featured_media value to send (undefined when it doesn't change).
  apply(): Promise<number | undefined>;
}

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// Same attachment, ignoring size variants WordPress generates (-2048x2048, -scaled).
function sameMedia(a: string, b: string): boolean {
  const norm = (u: string) => u.split("?")[0]!.replace(/-(?:\d+x\d+|scaled)(?=\.\w+$)/, "");
  return norm(a) === norm(b);
}

async function findByUrl(site: Site, url: string): Promise<WPMedia | undefined> {
  const stem = basename(url.split("?")[0]!, extname(url.split("?")[0]!)).replace(/-(?:\d+x\d+|scaled)$/, "");
  return (await site.client.searchMedia(stem)).find((m) => sameMedia(m.source_url, url));
}

// Local paths are tried against the site's posts/ folder first (so img/foo.png works
// from any post, even after a draft moves), then the post's own folder, then as given.
async function findLocal(siteRoot: string, value: string, postPath: string): Promise<string> {
  const expanded = expandHome(value);
  const candidates = isAbsolute(expanded)
    ? [expanded]
    : [join(siteRoot, "posts", expanded), resolve(dirname(postPath), expanded)];
  for (const c of candidates) if (await Bun.file(c).exists()) return c;
  throw new Error(`featured_image: can't find ${value} (looked in ${candidates.join(", ")}).`);
}

export interface ImageOptions {
  optimize?: boolean; // convert to WebP before upload (default true)
  settings?: ImageSettings;
}

interface PreparedWebp {
  bytes: Uint8Array;
  path: string; // where the .webp goes next to the source
  write: boolean; // false if an identical file is already there
  note: string;
}

// Optimize `source` to WebP and pick where to save it: foo.png → foo.webp, unless a
// different foo.webp already exists, in which case foo-<hash>.webp.
async function prepareWebp(sourcePath: string, source: Uint8Array, settings: ImageSettings): Promise<PreparedWebp | { reason: string }> {
  const r = await optimizeImage(source, settings);
  if (!r.optimized) return { reason: r.reason };
  const stem = join(dirname(sourcePath), basename(sourcePath, extname(sourcePath)));
  let path = `${stem}.webp`;
  let write = true;
  const existing = Bun.file(path);
  if (await existing.exists()) {
    if (hash(new Uint8Array(await existing.arrayBuffer())) === hash(r.bytes)) write = false;
    else path = `${stem}-${hash(r.bytes).slice(0, 8)}.webp`;
  }
  const note = `from ${basename(sourcePath)}, ${formatSize(source.length)} → ${formatSize(r.bytes.length)}, ${r.width}×${r.height} ${r.mode}`;
  return { bytes: r.bytes, path, write, note };
}

export async function planFeaturedImage(
  site: Site,
  fm: FrontMatter,
  remote: WPPost,
  postPath: string,
  opts: ImageOptions = {},
): Promise<FeaturedImagePlan> {
  const [current] = remote.featured_media ? await site.client.media([remote.featured_media]) : [];
  const from = current?.source_url ?? "(none)";
  const value = fm.featured_image;
  const alt = fm.featured_image_alt;
  const changes: FeaturedImagePlan["changes"] = [];

  let target: WPMedia | undefined = current; // media the post should end up with
  let upload: { path: string; bytes: Uint8Array; keys: string[]; writeLocal: boolean } | undefined;

  if (value === undefined || value === "") {
    // Not mentioned: leave the featured image alone.
  } else if (String(value).toLowerCase() === "none") {
    target = undefined;
    if (current) changes.push({ field: "featured_image", from, to: "(none)" });
  } else if (/^\d+$/.test(String(value))) {
    const id = Number(value);
    if (id !== current?.id) {
      [target] = await site.client.media([id]);
      if (!target) throw new Error(`featured_image: media item ${id} doesn't exist on the site.`);
      changes.push({ field: "featured_image", from, to: target.source_url });
    }
  } else if (/^https?:\/\//i.test(String(value))) {
    const url = String(value);
    if (!current || !sameMedia(url, current.source_url)) {
      target = await findByUrl(site, url);
      if (!target) throw new Error(`featured_image: ${url} isn't in the Media Library. Use a local file path to upload it.`);
      changes.push({ field: "featured_image", from, to: target.source_url });
    }
  } else {
    const sourcePath = await findLocal(site.root, String(value), postPath);
    if (!IMAGE_TYPES[extname(sourcePath).toLowerCase()]) {
      throw new Error(`featured_image: ${basename(sourcePath)} isn't a supported image type (${Object.keys(IMAGE_TYPES).join(" ")}).`);
    }
    const source = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
    const optimize = opts.optimize !== false;
    const settings = opts.settings ?? DEFAULT_IMAGE_SETTINGS;
    // A source uploaded as-is and the same source optimized are different uploads, and
    // so are optimizations with different settings.
    const sourceKey = optimize ? `${hash(source)}@webp-q${settings.quality}-${settings.maxSize}` : hash(source);

    // Uploads are remembered by source (+ settings) and by the uploaded file's hash, so
    // the same image is never optimized or uploaded twice.
    const findCached = async (sha: string) => {
      const cached = site.state.uploads?.[sha];
      return cached ? (await site.client.media([cached.id]))[0] : undefined;
    };
    let existing = await findCached(sourceKey);
    let pending: typeof upload;
    let note = "";
    if (!existing) {
      const webp = optimize ? await prepareWebp(sourcePath, source, settings) : { reason: "--no-optimize" };
      if ("bytes" in webp) {
        existing = await findCached(hash(webp.bytes));
        pending = { path: webp.path, bytes: webp.bytes, keys: [sourceKey, hash(webp.bytes)], writeLocal: webp.write };
        note = webp.note;
      } else {
        pending = { path: sourcePath, bytes: source, keys: [sourceKey, hash(source)], writeLocal: false };
        note = webp.reason === "--no-optimize" ? "not optimized" : webp.reason.startsWith("already") ? webp.reason : `not optimized: ${webp.reason}`;
      }
    }
    if (existing) {
      target = existing;
      if (existing.id !== current?.id) changes.push({ field: "featured_image", from, to: `${existing.source_url} (already uploaded)` });
    } else {
      upload = pending;
      target = { id: 0, source_url: "", alt_text: "" };
      changes.push({ field: "featured_image", from, to: `upload ${basename(pending!.path)} (${formatSize(pending!.bytes.length)}; ${note})` });
    }
  }

  const altChange = alt !== undefined && target && alt !== (target.alt_text ?? "");
  if (altChange) changes.push({ field: "featured_image_alt", from: target!.alt_text ?? "", to: alt! });

  return {
    changes,
    async apply() {
      if (upload) {
        if (upload.writeLocal) await Bun.write(upload.path, upload.bytes); // keep the optimized copy next to the original
        const media = await site.client.uploadMedia({
          bytes: upload.bytes,
          filename: basename(upload.path),
          mime: IMAGE_TYPES[extname(upload.path).toLowerCase()]!,
        });
        const record = { id: media.id, url: media.source_url };
        site.state.uploads = { ...site.state.uploads, ...Object.fromEntries(upload.keys.map((k) => [k, record])) };
        await site.save(); // remember the upload even if the post update fails
        target = media;
      }
      if (altChange) await site.client.updateMedia(target!.id, { alt_text: alt });
      const next = target?.id ?? 0;
      return next === (current?.id ?? 0) ? undefined : next;
    },
  };
}

export interface OptimizeReport {
  file: string; // image that was optimized
  result: string; // what happened
  frontMatter?: { from: string; to: string };
}

// `omawp optimize <post>`: convert the post's local featured image to WebP next to the
// original and point front matter at it. Only the featured_image line is changed.
export async function optimizePost(siteRoot: string, postPath: string, settings: ImageSettings): Promise<OptimizeReport | null> {
  const text = await Bun.file(postPath).text();
  const value = parse(text).fm.featured_image;
  if (value === undefined || /^(none|\d+|https?:\/\/.*)$/i.test(String(value))) return null; // nothing local

  const sourcePath = await findLocal(siteRoot, String(value), postPath);
  const source = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
  const webp = await prepareWebp(sourcePath, source, settings);
  if (!("bytes" in webp)) return { file: String(value), result: `left as is: ${webp.reason}` };

  if (webp.write) await Bun.write(webp.path, webp.bytes);
  const next = join(dirname(String(value)), basename(webp.path));
  const updated = text.replace(/^(featured_image:[ \t]*)(["']?)(.*?)\2[ \t]*$/m, (_m, key, q) => `${key}${q}${next}${q}`);
  await Bun.write(postPath, updated);
  return { file: String(value), result: webp.note, frontMatter: { from: String(value), to: next } };
}
