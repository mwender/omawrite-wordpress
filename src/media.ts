import { join, resolve, dirname, basename, extname, isAbsolute } from "node:path";
import { expandHome } from "./config.ts";
import { hash, type Site } from "./sync.ts";
import type { FrontMatter } from "./frontmatter.ts";
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
async function findLocal(site: Site, value: string, postPath: string): Promise<string> {
  const expanded = expandHome(value);
  const candidates = isAbsolute(expanded)
    ? [expanded]
    : [join(site.root, "posts", expanded), resolve(dirname(postPath), expanded)];
  for (const c of candidates) if (await Bun.file(c).exists()) return c;
  throw new Error(`featured_image: can't find ${value} (looked in ${candidates.join(", ")}).`);
}

export async function planFeaturedImage(site: Site, fm: FrontMatter, remote: WPPost, postPath: string): Promise<FeaturedImagePlan> {
  const [current] = remote.featured_media ? await site.client.media([remote.featured_media]) : [];
  const from = current?.source_url ?? "(none)";
  const value = fm.featured_image;
  const alt = fm.featured_image_alt;
  const changes: FeaturedImagePlan["changes"] = [];

  let target: WPMedia | undefined = current; // media the post should end up with
  let upload: { path: string; bytes: Uint8Array; sha: string } | undefined;

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
    const path = await findLocal(site, String(value), postPath);
    const mime = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mime) throw new Error(`featured_image: ${basename(path)} isn't a supported image type (${Object.keys(IMAGE_TYPES).join(" ")}).`);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const sha = hash(bytes);
    const cached = site.state.uploads?.[sha];
    const [existing] = cached ? await site.client.media([cached.id]) : [];
    if (existing) {
      target = existing;
      if (existing.id !== current?.id) changes.push({ field: "featured_image", from, to: `${existing.source_url} (already uploaded)` });
    } else {
      upload = { path, bytes, sha };
      target = { id: 0, source_url: "", alt_text: "" };
      changes.push({ field: "featured_image", from, to: `upload ${basename(path)} (${formatSize(bytes.length)})` });
    }
  }

  const altChange = alt !== undefined && target && alt !== (target.alt_text ?? "");
  if (altChange) changes.push({ field: "featured_image_alt", from: target!.alt_text ?? "", to: alt! });

  return {
    changes,
    async apply() {
      if (upload) {
        const media = await site.client.uploadMedia({
          bytes: upload.bytes,
          filename: basename(upload.path),
          mime: IMAGE_TYPES[extname(upload.path).toLowerCase()]!,
        });
        site.state.uploads = { ...site.state.uploads, [upload.sha]: { id: media.id, url: media.source_url } };
        await site.save(); // remember the upload even if the post update fails
        target = media;
      }
      if (altChange) await site.client.updateMedia(target!.id, { alt_text: alt });
      const next = target?.id ?? 0;
      return next === (current?.id ?? 0) ? undefined : next;
    },
  };
}
