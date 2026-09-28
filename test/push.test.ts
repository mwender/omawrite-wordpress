import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockWP, makePost, USER, PASSWORD } from "./mock-wp.ts";
import { syncSite } from "../src/sync.ts";
import { pushFile, flattenFile } from "../src/push.ts";
import { parse } from "../src/frontmatter.ts";
import type { Config } from "../src/config.ts";
import type { WPPost } from "../src/wp.ts";

let dir: string;
let mock: ReturnType<typeof startMockWP>;
let posts: WPPost[];
let config: Config;

const columns = '<!-- wp:columns --><div class="wp-block-columns"><p>Col</p></div><!-- /wp:columns -->';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omawp-push-"));
  posts = [
    makePost(1, { categories: [2], tags: [5] }),
    makePost(2, { status: "draft", slug: "" }),
    makePost(3, { content: { raw: `<!-- wp:paragraph -->\n<p>Intro.</p>\n<!-- /wp:paragraph -->\n\n${columns}`, rendered: "" } }),
  ];
  mock = startMockWP(posts);
  config = { contentDir: dir, sites: { test: { url: mock.url, api: mock.api, username: USER } } };
  process.env.OMAWP_APP_PASSWORD_TEST = PASSWORD;
  await syncSite(config, "test");
});

afterEach(async () => {
  mock.server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const path = (rel: string) => join(dir, "test", rel);
const edit = async (rel: string, fn: (s: string) => string) => Bun.write(path(rel), fn(await Bun.file(path(rel)).text()));
const yes = { confirm: async () => true };

test("nothing to push for an unedited file", async () => {
  expect((await pushFile(config, path("posts/2026/2026-01-01_post-1.md"), yes)).status).toBe("no-changes");
  expect(mock.updates).toEqual([]);
});

test("dry run shows changes and sends nothing", async () => {
  await edit("posts/2026/2026-01-01_post-1.md", (s) => s.replace("title: Post 1", "title: Better Title").replace("Hello from post 1.", "Hello, edited."));
  const r = await pushFile(config, path("posts/2026/2026-01-01_post-1.md"), { dryRun: true });
  expect(r.status).toBe("dry-run");
  expect(r.plan!.changes).toEqual([{ field: "title", from: "Post 1", to: "Better Title" }]);
  expect(r.plan!.contentDiff).toContain("+<p>Hello, edited.</p>");
  expect(mock.updates).toEqual([]);
});

test("pushes only changed fields and refreshes the local file", async () => {
  const rel = "posts/2026/2026-01-01_post-1.md";
  await edit(rel, (s) => s.replace("Hello from post 1.", "Hello, **edited**."));
  const r = await pushFile(config, path(rel), yes);
  expect(r.status).toBe("pushed");
  expect(mock.updates).toEqual([
    { id: 1, fields: { content: "<!-- wp:paragraph -->\n<p>Hello, <strong>edited</strong>.</p>\n<!-- /wp:paragraph -->" } },
  ]);
  const { fm, body } = parse(await Bun.file(path(rel)).text());
  expect(fm.modified_gmt).toBe("2026-09-01T15:00:00");
  expect(body).toBe("Hello, **edited**.\n");
  // State is in sync again: no conflict, nothing more to push, sync leaves it alone.
  expect((await pushFile(config, path(rel), yes)).status).toBe("no-changes");
  expect((await syncSite(config, "test")).skipped).toEqual([]);
});

test("declining the confirmation sends nothing", async () => {
  await edit("posts/2026/2026-01-01_post-1.md", (s) => s.replace("Hello", "Howdy"));
  const r = await pushFile(config, path("posts/2026/2026-01-01_post-1.md"), { confirm: async () => false });
  expect(r.status).toBe("declined");
  expect(mock.updates).toEqual([]);
});

test("refuses to overwrite changes made on WordPress unless forced", async () => {
  const rel = "posts/2026/2026-01-01_post-1.md";
  await edit(rel, (s) => s.replace("Hello", "Howdy"));
  posts[0]!.modified_gmt = "2026-08-01T00:00:00";
  expect(pushFile(config, path(rel), yes)).rejects.toThrow("changed on WordPress");
  expect(mock.updates).toEqual([]);
  expect((await pushFile(config, path(rel), { ...yes, force: true })).status).toBe("pushed");
});

test("raw blocks pass through untouched", async () => {
  const rel = "posts/2026/2026-01-01_post-3.md";
  expect(await Bun.file(path(rel)).text()).toContain(columns);
  await edit(rel, (s) => s.replace("Intro.", "New intro."));
  await pushFile(config, path(rel), yes);
  expect(mock.updates[0]!.fields.content).toBe(`<!-- wp:paragraph -->\n<p>New intro.</p>\n<!-- /wp:paragraph -->\n\n${columns}`);
});

test("refuses to drop a raw block unless --flatten, which then sticks", async () => {
  const rel = "posts/2026/2026-01-01_post-3.md";
  await edit(rel, (s) => s.replace(columns, "Col"));
  expect(pushFile(config, path(rel), yes)).rejects.toThrow("missing from posts/2026/2026-01-01_post-3.md");
  expect(mock.updates).toEqual([]);

  expect((await pushFile(config, path(rel), { ...yes, flatten: true })).status).toBe("pushed");
  const { fm, body } = parse(await Bun.file(path(rel)).text());
  expect(fm.flatten).toBe(true);
  expect(body).toBe("Intro.\n\nCol\n");
});

test("matches existing terms by decoded name and creates new ones", async () => {
  const rel = "posts/2026/2026-01-01_post-1.md";
  const before = parse(await Bun.file(path(rel)).text()).fm;
  expect(before.categories).toEqual(["Tips & Tricks"]);
  await edit(rel, (s) => s.replace("  - bun", "  - bun\n  - brand-new"));
  const r = await pushFile(config, path(rel), yes);
  expect(r.plan!.newTerms).toEqual([{ taxonomy: "tags", name: "brand-new" }]);
  expect(mock.updates[0]!.fields).toEqual({ tags: [5, 101] });
});

test("publishing a draft moves it into its year folder", async () => {
  await edit("posts/drafts/post-2.md", (s) => s.replace("status: draft", "status: publish"));
  const r = await pushFile(config, path("posts/drafts/post-2.md"), yes);
  expect(mock.updates[0]!.fields).toEqual({ status: "publish" });
  expect(r.file).toBe("posts/2026/2026-01-01_post-2.md");
  expect(await readdir(join(dir, "test/posts"))).not.toContain("drafts");
});

test("flatten command converts raw blocks to Markdown", async () => {
  const rel = "posts/2026/2026-01-01_post-3.md";
  expect(await flattenFile(config, path(rel))).toBe(1);
  const { fm, body } = parse(await Bun.file(path(rel)).text());
  expect(fm.flatten).toBe(true);
  expect(body).toBe("Intro.\n\nCol\n");
});
