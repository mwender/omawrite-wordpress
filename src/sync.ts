import { join, dirname } from "node:path";
import { mkdir, rename, rmdir } from "node:fs/promises";
import { type Config, siteDir } from "./config.ts";
import { getPassword } from "./secrets.ts";
import { WPClient, type WPPost, type WPTerm, type WPMedia } from "./wp.ts";
import { htmlToMarkdown, CONVERTER } from "./convert.ts";
import { serialize, parse, type FrontMatter } from "./frontmatter.ts";

export interface PostState {
  file: string; // relative to the site dir
  modified_gmt: string;
  hash: string; // hash of the file as last written by omawp, to detect local edits
  base?: Snapshot; // what the file said when last written, so push sends only your changes
}

// Front matter fields push can send, plus a hash of the body.
export interface Snapshot {
  fields: Record<string, unknown>;
  body: string;
}

export const PUSH_FIELDS = [
  "title", "slug", "status", "date", "excerpt", "sticky",
  "categories", "tags", "featured_image", "featured_image_alt",
] as const;

export function snapshot(text: string): Snapshot {
  const { fm, body } = parse(text);
  return { fields: Object.fromEntries(PUSH_FIELDS.map((k) => [k, fm[k] ?? null])), body: hash(body) };
}

export interface SiteState {
  layout?: number; // file naming scheme version (see LAYOUT)
  converter?: number; // HTML → Markdown converter version (see CONVERTER)
  lastModified?: string; // newest post `modified` (site-local time) seen
  posts: Record<string, PostState>;
  uploads?: Record<string, { id: number; url: string }>; // sha1 of a local file → media item
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

export function hash(text: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex");
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

export interface Site {
  name: string;
  root: string;
  state: SiteState;
  client: WPClient;
  save(): Promise<void>;
}

export async function openSite(config: Config, name: string): Promise<Site> {
  const site = config.sites[name];
  if (!site) throw new Error(`Unknown site "${name}". Run \`omawp sites\` to list configured sites.`);
  const root = siteDir(config, name);
  const statePath = join(root, ".omawp", "state.json");
  await mkdir(join(root, "posts"), { recursive: true });
  await mkdir(join(root, ".omawp", "raw"), { recursive: true });
  const f = Bun.file(statePath);
  const state: SiteState = (await f.exists()) ? await f.json() : { posts: {} };
  return {
    name,
    root,
    state,
    client: new WPClient(site.api, site.username, await getPassword(name)),
    save: () => Bun.write(statePath, JSON.stringify(state, null, 2) + "\n").then(() => {}),
  };
}

export interface Lookups {
  categories: Map<number, string>;
  tags: Map<number, string>;
  media: Map<number, WPMedia>;
}

export async function fetchLookups(client: WPClient, posts: WPPost[], terms?: { categories: WPTerm[]; tags: WPTerm[] }): Promise<Lookups> {
  const { categories, tags } = terms ?? { categories: await client.categories(), tags: await client.tags() };
  const mediaIds = [...new Set(posts.map((p) => p.featured_media).filter((id) => id > 0))];
  return {
    categories: new Map(categories.map((t) => [t.id, t.name])),
    tags: new Map(tags.map((t) => [t.id, t.name])),
    media: new Map((await client.media(mediaIds)).map((m) => [m.id, m])),
  };
}

export function renderPost(post: WPPost, lookups: Lookups, flatten = false): string {
  const raw = post.content.raw ?? post.content.rendered;
  const fm: FrontMatter = {
    id: post.id,
    title: post.title.raw ?? post.title.rendered,
    slug: post.slug,
    status: post.status,
    date: post.date,
    modified_gmt: post.modified_gmt,
    link: post.link,
    categories: (post.categories ?? []).map((c) => lookups.categories.get(c) ?? String(c)),
    tags: (post.tags ?? []).map((t) => lookups.tags.get(t) ?? String(t)),
    excerpt: (post.excerpt.raw ?? "").trim(),
    featured_image: lookups.media.get(post.featured_media)?.source_url,
    featured_image_alt: lookups.media.get(post.featured_media)?.alt_text || undefined,
    sticky: post.sticky || undefined,
    flatten: flatten || undefined,
  };
  return serialize(fm, htmlToMarkdown(raw, { flatten }));
}

// Posts marked `flatten: true` stay fully Markdown on later pulls.
export async function isFlattened(path: string): Promise<boolean> {
  const f = Bun.file(path);
  return (await f.exists()) && parse(await f.text()).fm.flatten === true;
}

// Write a pulled post and record it in state. Callers decide whether overwriting is OK.
export async function writePost(site: Site, post: WPPost, file: string, text: string): Promise<void> {
  await Bun.write(join(site.root, file), text);
  await Bun.write(join(site.root, ".omawp", "raw", `${post.id}.html`), post.content.raw ?? post.content.rendered);
  site.state.posts[String(post.id)] = { file, modified_gmt: post.modified_gmt, hash: hash(text), base: snapshot(text) };
}

export async function syncSite(config: Config, name: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const site = await openSite(config, name);
  const { root, state, client } = site;

  // Files synced before snapshots existed: an unedited file is exactly what was last
  // written, so its snapshot can be taken from the file itself.
  for (const entry of Object.values(state.posts)) {
    if (entry.base) continue;
    const f = Bun.file(join(root, entry.file));
    if (!(await f.exists())) continue;
    const text = await f.text();
    if (hash(text) === entry.hash) entry.base = snapshot(text);
  }

  const tracked = Object.keys(state.posts).length > 0;
  const relayout = tracked && state.layout !== LAYOUT;
  const reconvert = tracked && state.converter !== CONVERTER;
  const incremental = !opts.full && !relayout && !reconvert && state.lastModified;
  log(
    incremental
      ? `Fetching posts modified since ${incrementalSince(state.lastModified!)}…`
      : relayout || reconvert
        ? "omawp was updated — fetching all posts to refresh existing files…"
        : "Fetching all posts…",
  );

  const [posts, categories, tags] = await Promise.all([
    client.posts(incremental ? { modified_after: incrementalSince(state.lastModified!) } : {}),
    client.categories(),
    client.tags(),
  ]);
  const lookups = await fetchLookups(client, posts, { categories, tags });

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

    const existing = Bun.file(join(root, file));
    const exists = prev ? await existing.exists() : false;
    const current = exists ? await existing.text() : null;

    if (prev && current !== null && prev.modified_gmt === post.modified_gmt && !opts.force && !reconvert) {
      result.unchanged++;
      continue;
    }

    // Never clobber edits made locally since the last pull.
    if (prev && current !== null && !opts.force && hash(current) !== prev.hash) {
      if (prev.modified_gmt !== post.modified_gmt) {
        result.skipped.push({ file: prev.file, reason: "local changes (use --force to overwrite)" });
      } else {
        result.unchanged++; // only our converter changed; leave your edits alone quietly
      }
      continue;
    }

    const text = renderPost(post, lookups, await isFlattened(join(root, file)));
    if (current === text) {
      await Bun.write(join(root, ".omawp", "raw", `${post.id}.html`), post.content.raw ?? post.content.rendered);
      state.posts[id] = { ...prev!, modified_gmt: post.modified_gmt, base: snapshot(text) };
      result.unchanged++;
      continue;
    }

    await writePost(site, post, file, text);
    if (prev) claimed.delete(prev.file);
    claimed.set(file, id);
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
  state.converter = CONVERTER;
  await site.save();
  return result;
}
