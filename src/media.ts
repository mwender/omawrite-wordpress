import { join, resolve, dirname, basename, extname, isAbsolute } from "node:path";
import { expandHome } from "./config.ts";
import { hash, type Site } from "./sync.ts";
import { parse, type FrontMatter } from "./frontmatter.ts";
import { maskFences } from "./blocks.ts";
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

export type Change = { field: string; from: string; to: string };

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
async function findLocal(siteRoot: string, value: string, postPath: string, label: string): Promise<string> {
  const expanded = expandHome(value);
  const candidates = isAbsolute(expanded)
    ? [expanded]
    : [join(siteRoot, "posts", expanded), resolve(dirname(postPath), expanded)];
  for (const c of candidates) if (await Bun.file(c).exists()) return c;
  throw new Error(`${label}: can't find ${value} (looked in ${candidates.join(", ")}).`);
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

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export interface LocalImage {
  existing?: WPMedia; // already uploaded earlier
  filename: string; // name it's (or will be) uploaded under
  describe: string; // for the push plan
  get(): Promise<WPMedia>; // uploads on first call (after confirmation)
}

// One per push: each local file is optimized and uploaded at most once, however many
// times the post refers to it (featured image and body alike).
export class UploadSession {
  private images = new Map<string, Promise<LocalImage>>();

  constructor(
    private site: Site,
    private postPath: string,
    private opts: ImageOptions = {},
  ) {}

  // Keyed by the resolved file, so differently spelled references share one upload.
  async image(value: string, label: string): Promise<LocalImage> {
    const sourcePath = await findLocal(this.site.root, value, this.postPath, label);
    if (!this.images.has(sourcePath)) this.images.set(sourcePath, this.plan(sourcePath, label));
    return this.images.get(sourcePath)!;
  }

  private async plan(sourcePath: string, label: string): Promise<LocalImage> {
    const { site } = this;
    if (!IMAGE_TYPES[extname(sourcePath).toLowerCase()]) {
      throw new Error(`${label}: ${basename(sourcePath)} isn't a supported image type (${Object.keys(IMAGE_TYPES).join(" ")}).`);
    }
    const source = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
    const optimize = this.opts.optimize !== false;
    const settings = this.opts.settings ?? DEFAULT_IMAGE_SETTINGS;
    // A source uploaded as-is and the same source optimized are different uploads, and
    // so are optimizations with different settings.
    const sourceKey = optimize ? `${hash(source)}@webp-q${settings.quality}-${settings.maxSize}` : hash(source);

    // Uploads are remembered by source (+ settings) and by the uploaded file's hash.
    const findCached = async (sha: string) => {
      const cached = site.state.uploads?.[sha];
      return cached ? (await site.client.media([cached.id]))[0] : undefined;
    };
    const existing = await findCached(sourceKey);
    if (existing) return this.done(existing);

    const webp = optimize ? await prepareWebp(sourcePath, source, settings) : { reason: "--no-optimize" };
    let pending: { path: string; bytes: Uint8Array; keys: string[]; writeLocal: boolean };
    let note: string;
    if ("bytes" in webp) {
      const again = await findCached(hash(webp.bytes));
      if (again) return this.done(again);
      pending = { path: webp.path, bytes: webp.bytes, keys: [sourceKey, hash(webp.bytes)], writeLocal: webp.write };
      note = webp.note;
    } else {
      pending = { path: sourcePath, bytes: source, keys: [sourceKey, hash(source)], writeLocal: false };
      note = webp.reason === "--no-optimize" ? "not optimized" : webp.reason.startsWith("already") ? webp.reason : `not optimized: ${webp.reason}`;
    }

    let uploaded: Promise<WPMedia> | undefined;
    return {
      filename: basename(pending.path),
      describe: `upload ${basename(pending.path)} (${formatSize(pending.bytes.length)}; ${note})`,
      get: () =>
        (uploaded ??= (async () => {
          if (pending.writeLocal) await Bun.write(pending.path, pending.bytes); // keep the optimized copy next to the original
          const media = await site.client.uploadMedia({
            bytes: pending.bytes,
            filename: basename(pending.path),
            mime: IMAGE_TYPES[extname(pending.path).toLowerCase()]!,
          });
          const record = { id: media.id, url: media.source_url };
          site.state.uploads = { ...site.state.uploads, ...Object.fromEntries(pending.keys.map((k) => [k, record])) };
          await site.save(); // remember the upload even if the post update fails
          return media;
        })()),
    };
  }

  private done(media: WPMedia): LocalImage {
    return { existing: media, filename: basename(media.source_url), describe: `${media.source_url} (already uploaded)`, get: async () => media };
  }
}

// ---------------------------------------------------------------------------
// Featured image
// ---------------------------------------------------------------------------

export interface FeaturedImagePlan {
  changes: Change[];
  // Runs after confirmation: uploads if needed, updates alt text, and returns the
  // featured_media value to send (undefined when it doesn't change).
  apply(): Promise<number | undefined>;
}

export async function planFeaturedImage(site: Site, fm: FrontMatter, remote: WPPost, session: UploadSession): Promise<FeaturedImagePlan> {
  const [current] = remote.featured_media ? await site.client.media([remote.featured_media]) : [];
  const from = current?.source_url ?? "(none)";
  const value = fm.featured_image;
  const alt = fm.featured_image_alt;
  const changes: Change[] = [];

  let target: WPMedia | undefined = current; // media the post should end up with
  let local: LocalImage | undefined;

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
    local = await session.image(String(value), "featured_image");
    if (local.existing) {
      target = local.existing;
      if (local.existing.id !== current?.id) changes.push({ field: "featured_image", from, to: local.describe });
    } else {
      target = { id: 0, source_url: "", alt_text: "" };
      changes.push({ field: "featured_image", from, to: local.describe });
    }
  }

  const altChange = alt !== undefined && target && alt !== (target.alt_text ?? "");
  if (altChange) changes.push({ field: "featured_image_alt", from: target!.alt_text ?? "", to: alt! });

  return {
    changes,
    async apply() {
      if (local && !local.existing) target = await local.get();
      if (altChange) await site.client.updateMedia(target!.id, { alt_text: alt });
      const next = target?.id ?? 0;
      return next === (current?.id ?? 0) ? undefined : next;
    },
  };
}

// ---------------------------------------------------------------------------
// Images in the post body
// ---------------------------------------------------------------------------

export interface ImageRef {
  kind: "markdown" | "html";
  path: string;
  alt: string;
  pathStart: number; // span of the path inside the text
  pathEnd: number;
  lineStart: number; // span of the whole line, for standalone images
  lineEnd: number;
  standalone: boolean; // a Markdown image alone in its paragraph
}

const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMG_RE = /<img\b[^>]*?\bsrc=(["'])([^"']+)\1[^>]*>/gi;

// Local if it isn't a URL (http:, data:, //cdn…) or an anchor.
const isLocal = (path: string) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(path);

// Local image references in Markdown/HTML, ignoring fenced code.
export function findImageRefs(text: string): ImageRef[] {
  const masked = maskFences(text);
  const refs: ImageRef[] = [];
  const lineOf = (i: number) => {
    const lineStart = masked.lastIndexOf("\n", i - 1) + 1;
    const nl = masked.indexOf("\n", i);
    return { lineStart, lineEnd: nl === -1 ? masked.length : nl };
  };
  const blankAround = (lineStart: number, lineEnd: number) => {
    const before = masked.slice(0, Math.max(0, lineStart - 1)).split("\n").at(-1) ?? "";
    const after = masked.slice(lineEnd + 1).split("\n")[0] ?? "";
    return (lineStart === 0 || !before.trim()) && (lineEnd >= masked.length || !after.trim());
  };

  for (const m of masked.matchAll(MD_IMAGE_RE)) {
    const path = m[2]!;
    if (!isLocal(path)) continue;
    const pathStart = m.index! + m[0].indexOf(path, m[0].indexOf("]("));
    const { lineStart, lineEnd } = lineOf(m.index!);
    const standalone = masked.slice(lineStart, lineEnd).trim() === m[0] && blankAround(lineStart, lineEnd);
    refs.push({ kind: "markdown", path, alt: m[1]!, pathStart, pathEnd: pathStart + path.length, lineStart, lineEnd, standalone });
  }
  for (const m of masked.matchAll(HTML_IMG_RE)) {
    const path = m[2]!;
    if (!isLocal(path)) continue;
    const pathStart = m.index! + m[0].indexOf(path);
    const { lineStart, lineEnd } = lineOf(m.index!);
    const alt = m[0].match(/\balt=(["'])(.*?)\1/i)?.[2] ?? "";
    refs.push({ kind: "html", path, alt, pathStart, pathEnd: pathStart + path.length, lineStart, lineEnd, standalone: false });
  }
  return refs.sort((a, b) => a.pathStart - b.pathStart);
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/--/g, "&#45;&#45;");

// A standalone image becomes an image block tied to its media item, so WordPress serves
// resized versions (srcset). Same markup the block editor saves.
function imageBlock(id: number | string, url: string, alt: string): string {
  return (
    `<!-- wp:image {"id":${typeof id === "number" ? id : JSON.stringify(id)},"sizeSlug":"full","linkDestination":"none"} -->\n` +
    `<figure class="wp-block-image size-full"><img src="${url}" alt="${escapeAttr(alt)}" class="wp-image-${id}"/></figure>\n` +
    `<!-- /wp:image -->`
  );
}

export interface BodyImagesPlan {
  changes: Change[];
  hasImages: boolean;
  preview(): string; // body with placeholders for images not uploaded yet
  apply(): Promise<string>; // uploads, then the body with real URLs and IDs
}

export async function planBodyImages(body: string, session: UploadSession, opts: { classic: boolean }): Promise<BodyImagesPlan> {
  const refs = findImageRefs(body);
  const images = new Map<string, LocalImage>();
  const changes: Change[] = [];
  for (const ref of refs) {
    if (images.has(ref.path)) continue;
    const image = await session.image(ref.path, "image");
    images.set(ref.path, image);
    changes.push({ field: "image", from: ref.path, to: image.describe });
  }

  const rewrite = (media: (path: string) => { id: number | string; url: string }) => {
    let out = body;
    for (const ref of [...refs].reverse()) {
      const { id, url } = media(ref.path);
      if (ref.standalone && !opts.classic) out = out.slice(0, ref.lineStart) + imageBlock(id, url, ref.alt) + out.slice(ref.lineEnd);
      else out = out.slice(0, ref.pathStart) + url + out.slice(ref.pathEnd);
    }
    return out;
  };

  return {
    changes,
    hasImages: refs.length > 0,
    preview: () =>
      rewrite((path) => {
        const image = images.get(path)!;
        return image.existing ? { id: image.existing.id, url: image.existing.source_url } : { id: "NEW", url: `(upload) ${image.filename}` };
      }),
    async apply() {
      const uploaded = new Map<string, WPMedia>();
      for (const [path, image] of images) uploaded.set(path, await image.get());
      return rewrite((path) => ({ id: uploaded.get(path)!.id, url: uploaded.get(path)!.source_url }));
    },
  };
}

// ---------------------------------------------------------------------------
// `omawp optimize`
// ---------------------------------------------------------------------------

export interface OptimizeReport {
  image: string; // reference as written in the post
  where: "featured_image" | "body";
  result: string; // what happened
  to?: string; // new reference, if it was rewritten
}

// Convert the post's local images (featured and in the body) to WebP next to the
// originals and point the post at them. Only those references change in the file.
export async function optimizePost(siteRoot: string, postPath: string, settings: ImageSettings): Promise<OptimizeReport[]> {
  let text = await Bun.file(postPath).text();
  const { fm, body } = parse(text);
  const reports: OptimizeReport[] = [];
  const done = new Map<string, { to?: string; result: string }>(); // per source file

  const convert = async (value: string, label: string) => {
    const sourcePath = await findLocal(siteRoot, value, postPath, label);
    const key = sourcePath + "\0" + value;
    if (!done.has(key)) {
      if (!IMAGE_TYPES[extname(sourcePath).toLowerCase()]) {
        done.set(key, { result: "left as is: not a supported image type" });
      } else {
        const webp = await prepareWebp(sourcePath, new Uint8Array(await Bun.file(sourcePath).arrayBuffer()), settings);
        if (!("bytes" in webp)) done.set(key, { result: `left as is: ${webp.reason}` });
        else {
          if (webp.write) await Bun.write(webp.path, webp.bytes);
          done.set(key, { to: join(dirname(value), basename(webp.path)), result: webp.note });
        }
      }
    }
    return done.get(key)!;
  };

  // Body first (by offset, from the end) so front matter edits don't shift positions.
  const bodyStart = text.length - body.length;
  const refs = findImageRefs(body);
  const bodyResults = [];
  for (const ref of refs) bodyResults.push({ ref, r: await convert(ref.path, "image") });
  for (const { ref, r } of [...bodyResults].reverse()) {
    if (r.to) text = text.slice(0, bodyStart + ref.pathStart) + r.to + text.slice(bodyStart + ref.pathEnd);
  }
  const seen = new Set<string>();
  for (const { ref, r } of bodyResults) {
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    reports.push({ image: ref.path, where: "body", result: r.result, to: r.to });
  }

  const value = fm.featured_image;
  if (value !== undefined && !/^(none|\d+|https?:\/\/.*)$/i.test(String(value)) && String(value) !== "") {
    const r = await convert(String(value), "featured_image");
    if (r.to) text = text.replace(/^(featured_image:[ \t]*)(["']?)(.*?)\2[ \t]*$/m, (_m, k, q) => `${k}${q}${r.to}${q}`);
    reports.unshift({ image: String(value), where: "featured_image", result: r.result, to: r.to });
  }

  if (reports.some((r) => r.to)) await Bun.write(postPath, text);
  return reports;
}
