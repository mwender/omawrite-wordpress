import { join, dirname } from "node:path";
import { mkdir, rename, rmdir } from "node:fs/promises";
import { type Config, siteDir } from "./config.ts";
import { getPassword } from "./secrets.ts";
import { WPClient, type WPPost } from "./wp.ts";
import { htmlToMarkdown, complexBlocks } from "./convert.ts";
import { serialize, type FrontMatter } from "./frontmatter.ts";

interface PostState {
  file: string; // relative to the site dir
  modified_gmt: string;
  hash: string; // hash of the file as last written by omawp, to detect local edits
}

interface SiteState {
  layout?: number; // file naming scheme version (see LAYOUT)
  lastModified?: string; // newest post `modified` (site-local time) seen
  posts: Record<string, PostState>;
}

export interface SyncOptions {
  full?: boolean; // ignore lastModified and fetch everything
  force?: boolean; // overwrite local edits
  log?: (line: string) => void;
}

export interface SyncResult {
  created: string[];
  updated: string[];
  renamed: number;
  unchanged: number;
  skipped: { file: string; reason: string }[];
  missingRemote: string[];
}

export function hash(text: string): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex");
}

async function readState(path: string): Promise<SiteState> {
  const f = Bun.file(path);
  return (await f.exists()) ? ((await f.json()) as SiteState) : { posts: {} };
}

// WordPress `modified` is site-local and `modified_after` is compared against it in
// site time, so step back a day to cover any timezone skew. Re-fetching is harmless.
function incrementalSince(lastModified: string): string {
  const d = new Date(lastModified + "Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 19);
}

// Bump when postPath changes; a sync that sees an older layout fetches everything
// so every existing file gets renamed.
const LAYOUT = 3;

const UNPUBLISHED = new Set(["draft", "pending", "auto-draft"]);

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

// Path under posts/. Dated posts: YYYY/YYYY-MM-DD_slug.md. Drafts: drafts/title.md,
// because WordPress moves a draft's date on every save (until one is set) and drafts
// often have no slug yet.
export function postPath(post: WPPost): string {
  if (UNPUBLISHED.has(post.status)) {
    return join("drafts", `${slugify(post.title.raw ?? post.title.rendered) || post.slug || post.id}.md`);
  }
  return join(post.date.slice(0, 4), `${post.date.slice(0, 10)}_${post.slug || post.id}.md`);
}

export async function syncSite(config: Config, name: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const site = config.sites[name];
  if (!site) throw new Error(`Unknown site "${name}". Run \`omawp sites\` to list configured sites.`);

  const root = siteDir(config, name);
  const metaDir = join(root, ".omawp");
  const statePath = join(metaDir, "state.json");
  await mkdir(join(root, "posts"), { recursive: true });
  await mkdir(join(metaDir, "raw"), { recursive: true });

  const state = await readState(statePath);
  const client = new WPClient(site.api, site.username, await getPassword(name));

  const relayout = Object.keys(state.posts).length > 0 && state.layout !== LAYOUT;
  const incremental = !opts.full && !relayout && state.lastModified;
  log(
    incremental
      ? `Fetching posts modified since ${incrementalSince(state.lastModified!)}…`
      : relayout
        ? "File naming changed — fetching all posts to rename existing files…"
        : "Fetching all posts…",
  );

  const [posts, categories, tags] = await Promise.all([
    client.posts(incremental ? { modified_after: incrementalSince(state.lastModified!) } : {}),
    client.categories(),
    client.tags(),
  ]);
  const catNames = new Map(categories.map((t) => [t.id, t.name]));
  const tagNames = new Map(tags.map((t) => [t.id, t.name]));
  const mediaIds = [...new Set(posts.map((p) => p.featured_media).filter((id) => id > 0))];
  const media = new Map((await client.media(mediaIds)).map((m) => [m.id, m.source_url]));

  const result: SyncResult = { created: [], updated: [], renamed: 0, unchanged: 0, skipped: [], missingRemote: [] };
  const claimed = new Map(Object.entries(state.posts).map(([id, s]) => [s.file, id]));

  for (const post of posts) {
    const id = String(post.id);
    const prev = state.posts[id];

    // Pick a file name; append the post ID if another post (or a stray file) owns it.
    let file = join("posts", postPath(post));
    const owner = claimed.get(file);
    if ((owner && owner !== id) || (!owner && (await Bun.file(join(root, file)).exists()))) {
      file = file.replace(/\.md$/, `-${post.id}.md`);
    }

    // Name changed (new layout, slug, title, or publish date): move the existing file,
    // local edits and all, before deciding whether its contents need updating.
    if (prev && prev.file !== file && (await Bun.file(join(root, prev.file)).exists())) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await rename(join(root, prev.file), join(root, file));
      // Tidy up a year/drafts folder this emptied (fails harmlessly if not empty).
      if (dirname(prev.file) !== "posts") await rmdir(join(root, dirname(prev.file))).catch(() => {});
      claimed.delete(prev.file);
      claimed.set(file, id);
      prev.file = file;
      result.renamed++;
    }

    if (prev && prev.modified_gmt === post.modified_gmt && !opts.force && (await Bun.file(join(root, prev.file)).exists())) {
      result.unchanged++;
      continue;
    }

    // Never clobber edits made locally since the last pull.
    if (prev && !opts.force) {
      const existing = Bun.file(join(root, prev.file));
      if ((await existing.exists()) && hash(await existing.text()) !== prev.hash) {
        result.skipped.push({ file: prev.file, reason: "local changes (use --force to overwrite)" });
        continue;
      }
    }

    const raw = post.content.raw ?? post.content.rendered;
    const fm: FrontMatter = {
      id: post.id,
      title: post.title.raw ?? post.title.rendered,
      slug: post.slug,
      status: post.status,
      date: post.date,
      modified_gmt: post.modified_gmt,
      link: post.link,
      categories: (post.categories ?? []).map((c) => catNames.get(c) ?? String(c)),
      tags: (post.tags ?? []).map((t) => tagNames.get(t) ?? String(t)),
      excerpt: (post.excerpt.raw ?? "").trim(),
      featured_image: media.get(post.featured_media),
      sticky: post.sticky || undefined,
      complex_blocks: complexBlocks(raw),
    };
    const text = serialize(fm, htmlToMarkdown(raw));

    await Bun.write(join(root, file), text);
    await Bun.write(join(metaDir, "raw", `${post.id}.html`), raw);

    if (prev) claimed.delete(prev.file);
    claimed.set(file, id);
    state.posts[id] = { file, modified_gmt: post.modified_gmt, hash: hash(text) };
    (prev ? result.updated : result.created).push(file);
    log(`${prev ? "updated" : "created"}  ${file}`);
  }

  for (const post of posts) {
    if (!state.lastModified || post.modified > state.lastModified) state.lastModified = post.modified;
  }

  // Only a full fetch can tell us what's gone (trashed/deleted) on the remote.
  if (!incremental) {
    const remoteIds = new Set(posts.map((p) => String(p.id)));
    for (const [id, s] of Object.entries(state.posts)) {
      if (!remoteIds.has(id)) result.missingRemote.push(s.file);
    }
  }

  state.layout = LAYOUT;
  await Bun.write(statePath, JSON.stringify(state, null, 2) + "\n");
  return result;
}
