import { join, relative, resolve, sep, dirname } from "node:path";
import { mkdir, unlink, rmdir } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { type Config, expandHome } from "./config.ts";
import { openSite, fetchLookups, renderPost, writePost, postPath, hash, type Site } from "./sync.ts";
import { parse, serialize } from "./frontmatter.ts";
import { htmlToMarkdown, markdownToHtml, rawBlockNames } from "./convert.ts";
import { hasBlocks } from "./blocks.ts";
import type { WPPost, WPTerm } from "./wp.ts";

export interface PushOptions {
  dryRun?: boolean;
  force?: boolean; // push even if the post changed on WordPress since the last sync
  flatten?: boolean; // accept losing raw blocks; keep this post Markdown-only from now on
  confirm?: (plan: PushPlan) => Promise<boolean>;
}

export interface PushPlan {
  site: string;
  file: string;
  id: number;
  changes: { field: string; from: string; to: string }[];
  newTerms: { taxonomy: "categories" | "tags"; name: string }[];
  contentDiff: string | null;
}

export type PushResult = { status: "pushed" | "dry-run" | "declined" | "no-changes"; plan?: PushPlan; file?: string };

// Map a path inside contentDir to its site name and site-relative path.
export function locate(config: Config, path: string): { site: string; rel: string } {
  const root = resolve(expandHome(config.contentDir));
  const rel = relative(root, resolve(path));
  const [site, ...rest] = rel.split(sep);
  if (rel.startsWith("..") || !site || rest.length === 0 || !config.sites[site]) {
    throw new Error(`${path} isn't inside a synced site folder (${root}/<site>/…).`);
  }
  return { site, rel: rest.join(sep) };
}

function countNames(names: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return m;
}

function resolveTerms(names: string[], existing: WPTerm[]): { ids: number[]; missing: string[] } {
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t.id]));
  const ids: number[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const id = byName.get(String(name).toLowerCase());
    if (id) ids.push(id);
    else missing.push(String(name));
  }
  return { ids, missing };
}

const sameSet = (a: number[] = [], b: number[] = []) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export async function pushFile(config: Config, path: string, opts: PushOptions = {}): Promise<PushResult> {
  const { site: siteName, rel } = locate(config, path);
  const site = await openSite(config, siteName);
  const text = await Bun.file(join(site.root, rel)).text();
  const { fm, body } = parse(text);

  const entry = Object.entries(site.state.posts).find(([, s]) => s.file === rel);
  const id = entry ? Number(entry[0]) : fm.id;
  if (!id) throw new Error(`${rel} has no post id. Creating new posts isn't supported yet.`);
  const state = site.state.posts[String(id)];
  if (!state) throw new Error(`Post ${id} hasn't been synced yet. Run \`omawp sync ${siteName}\` first.`);
  if (hash(text) === state.hash) return { status: "no-changes" };

  const remote = await site.client.post(id);
  if (remote.modified_gmt !== state.modified_gmt && !opts.force) {
    throw new Error(
      `Post ${id} was changed on WordPress (${remote.modified_gmt} GMT) since your last sync. ` +
        `Pushing would overwrite that. Use --force to push anyway.`,
    );
  }

  // Blocks pull kept as raw HTML (galleries etc.) must still be in the file, or the
  // push would silently replace them with plain Markdown.
  const savedRaw = await Bun.file(join(site.root, ".omawp", "raw", `${id}.html`)).text();
  const flatten = opts.flatten || fm.flatten === true;
  if (!flatten) {
    const have = countNames(rawBlockNames(body));
    const missing: string[] = [];
    for (const [name, n] of countNames(rawBlockNames(htmlToMarkdown(savedRaw)))) {
      const lost = n - (have.get(name) ?? 0);
      if (lost > 0) missing.push(lost > 1 ? `${name} ×${lost}` : name);
    }
    if (missing.length) {
      throw new Error(
        `These WordPress blocks are missing from ${rel} (removed, or converted to Markdown): ${missing.join(", ")}. ` +
          `Pushing would lose their layout. Use --flatten to push anyway and keep this post Markdown-only.`,
      );
    }
  }

  const content = markdownToHtml(body, { classic: !hasBlocks(savedRaw) });
  const [categories, tags] = await Promise.all([site.client.categories(), site.client.tags()]);
  const cats = resolveTerms(fm.categories ?? [], categories);
  const tgs = resolveTerms(fm.tags ?? [], tags);

  const payload: Record<string, unknown> = {};
  const changes: PushPlan["changes"] = [];
  const field = (name: string, from: unknown, to: unknown, value: unknown = to) => {
    if (String(from ?? "") === String(to ?? "")) return;
    payload[name] = value;
    changes.push({ field: name, from: String(from ?? ""), to: String(to ?? "") });
  };
  field("title", remote.title.raw, fm.title ?? "");
  if (fm.slug) field("slug", remote.slug, fm.slug);
  if (fm.status) field("status", remote.status, fm.status);
  if (fm.date) field("date", remote.date, fm.date);
  field("excerpt", (remote.excerpt.raw ?? "").trim(), fm.excerpt ?? "");
  field("sticky", !!remote.sticky, !!fm.sticky, !!fm.sticky);

  const names = (ids: number[] = [], terms: WPTerm[]) => ids.map((i) => terms.find((t) => t.id === i)?.name ?? i).join(", ");
  const newTerms = [
    ...cats.missing.map((name) => ({ taxonomy: "categories" as const, name })),
    ...tgs.missing.map((name) => ({ taxonomy: "tags" as const, name })),
  ];
  if (!sameSet(remote.categories, cats.ids) || cats.missing.length) {
    changes.push({ field: "categories", from: names(remote.categories, categories), to: (fm.categories ?? []).join(", ") });
    payload.categories = cats.ids;
  }
  if (!sameSet(remote.tags, tgs.ids) || tgs.missing.length) {
    changes.push({ field: "tags", from: names(remote.tags, tags), to: (fm.tags ?? []).join(", ") });
    payload.tags = tgs.ids;
  }

  const remoteContent = remote.content.raw ?? "";
  let contentDiff: string | null = null;
  if (content.trim() !== remoteContent.trim()) {
    payload.content = content;
    contentDiff = createTwoFilesPatch("wordpress", "local", remoteContent.trim() + "\n", content.trim() + "\n", "", "", { context: 2 })
      .split("\n")
      .slice(2) // drop the ===/--- header noise; keep hunks
      .join("\n");
  }

  const plan: PushPlan = { site: siteName, file: rel, id, changes, newTerms, contentDiff };
  if (!changes.length && !contentDiff) return { status: "no-changes", plan };
  if (opts.dryRun) return { status: "dry-run", plan };
  if (opts.confirm && !(await opts.confirm(plan))) return { status: "declined", plan };

  for (const t of newTerms) {
    const term = await site.client.createTerm(t.taxonomy, t.name);
    (payload[t.taxonomy] as number[]).push(term.id);
  }

  const updated = await site.client.updatePost(id, payload);
  const file = await refreshLocal(site, updated, rel, flatten);
  await site.save();
  return { status: "pushed", plan, file };
}

// Rewrite the local file from what WordPress now has, moving it if the new status or
// date changes where it belongs (e.g. a draft that was just published).
async function refreshLocal(site: Site, post: WPPost, rel: string, flatten: boolean): Promise<string> {
  const lookups = await fetchLookups(site.client, [post]);
  let file = rel;
  const target = join("posts", postPath(post));
  if (target !== rel && !(await Bun.file(join(site.root, target)).exists())) {
    await mkdir(dirname(join(site.root, target)), { recursive: true });
    await unlink(join(site.root, rel));
    await rmdir(join(site.root, dirname(rel))).catch(() => {});
    file = target;
  }
  await writePost(site, post, file, renderPost(post, lookups, flatten));
  return file;
}

// Convert a file's raw WordPress HTML sections to Markdown and mark it `flatten: true`.
export async function flattenFile(config: Config, path: string): Promise<number> {
  locate(config, path); // only operate on synced files
  const text = await Bun.file(path).text();
  const { fm, body } = parse(text);
  const raw = rawBlockNames(body).length;
  const html = markdownToHtml(body, { classic: !hasBlocks(body) });
  await Bun.write(path, serialize({ ...fm, flatten: true }, htmlToMarkdown(html, { flatten: true })));
  return raw;
}
