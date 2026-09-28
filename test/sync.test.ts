import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockWP, makePost, USER, PASSWORD } from "./mock-wp.ts";
import { syncSite } from "../src/sync.ts";
import { discoverApi } from "../src/wp.ts";
import { parse } from "../src/frontmatter.ts";
import type { Config } from "../src/config.ts";
import type { WPPost } from "../src/wp.ts";

let dir: string;
let mock: ReturnType<typeof startMockWP>;
let posts: WPPost[];
let config: Config;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omawp-test-"));
  posts = [
    makePost(1, { categories: [1, 2], tags: [5], featured_media: 42, excerpt: { raw: "Short summary", rendered: "" } }),
    makePost(2, { status: "draft", slug: "" }),
    makePost(3, {
      content: {
        raw: '<!-- wp:columns --><div class="wp-block-columns"><p>Col</p></div><!-- /wp:columns -->',
        rendered: "",
      },
    }),
  ];
  mock = startMockWP(posts);
  config = { contentDir: dir, sites: { test: { url: mock.url, api: mock.api, username: USER } } };
  process.env.OMAWP_APP_PASSWORD_TEST = PASSWORD;
});

afterEach(async () => {
  mock.server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const read = (file: string) => Bun.file(join(dir, "test", file)).text();

test("discovers the REST API root", async () => {
  expect(await discoverApi(mock.url)).toBe(mock.api);
});

test("pulls posts to Markdown with front matter", async () => {
  const r = await syncSite(config, "test");
  expect(r.created.sort()).toEqual(["posts/2026/2026-01-01_post-1.md", "posts/2026/2026-01-01_post-3.md", "posts/drafts/post-2.md"]);

  const { fm, body } = parse(await read("posts/2026/2026-01-01_post-1.md"));
  expect(fm).toMatchObject({
    id: 1,
    title: "Post 1",
    status: "publish",
    categories: ["News", "Tips & Tricks"],
    tags: ["bun"],
    excerpt: "Short summary",
    featured_image: "https://example.test/uploads/42.jpg",
  });
  expect(body).toBe("Hello from post 1.\n");

  // Blocks Markdown can't represent stay as the original WordPress HTML.
  expect(parse(await read("posts/2026/2026-01-01_post-3.md")).body).toContain('<!-- wp:columns --><div class="wp-block-columns">');
  expect(await read(".omawp/raw/1.html")).toContain("<!-- wp:paragraph -->");
});

test("second sync is incremental and leaves unchanged posts alone", async () => {
  await syncSite(config, "test");
  posts[0]!.modified = "2026-02-01T10:00:00";
  posts[0]!.modified_gmt = "2026-02-01T15:00:00";
  posts[0]!.title.raw = "Renamed";

  mock.requests.length = 0;
  const r = await syncSite(config, "test");
  const postReq = mock.requests.find((u) => u.pathname.endsWith("/wp/v2/posts"))!;
  expect(postReq.searchParams.get("modified_after")).toBe("2026-01-01T10:00:00");
  expect(r.updated).toEqual(["posts/2026/2026-01-01_post-1.md"]);
  expect(parse(await read("posts/2026/2026-01-01_post-1.md")).fm.title).toBe("Renamed");
});

test("does not overwrite local edits unless forced", async () => {
  await syncSite(config, "test");
  await Bun.write(join(dir, "test/posts/2026/2026-01-01_post-1.md"), "my local edit");
  posts[0]!.modified_gmt = "2026-03-01T00:00:00";
  posts[0]!.modified = "2026-03-01T00:00:00";

  const r = await syncSite(config, "test");
  expect(r.skipped.map((s) => s.file)).toEqual(["posts/2026/2026-01-01_post-1.md"]);
  expect(await read("posts/2026/2026-01-01_post-1.md")).toBe("my local edit");

  const forced = await syncSite(config, "test", { force: true, full: true });
  expect(forced.updated).toContain("posts/2026/2026-01-01_post-1.md");
  expect(await read("posts/2026/2026-01-01_post-1.md")).not.toBe("my local edit");
});

test("renames the file when the slug changes remotely", async () => {
  await syncSite(config, "test");
  posts[0]!.slug = "new-slug";
  posts[0]!.modified_gmt = "2026-04-01T00:00:00";
  await syncSite(config, "test", { full: true });
  const files = await readdir(join(dir, "test/posts/2026"));
  expect(files).toContain("2026-01-01_new-slug.md");
  expect(files).not.toContain("2026-01-01_post-1.md");
});

test("full sync reports posts deleted on the remote", async () => {
  await syncSite(config, "test");
  posts.splice(1, 1);
  const r = await syncSite(config, "test", { full: true });
  expect(r.missingRemote).toEqual(["posts/drafts/post-2.md"]);
});

test("rejects bad credentials", async () => {
  process.env.OMAWP_APP_PASSWORD_TEST = "wrong";
  expect(syncSite(config, "test")).rejects.toThrow("401");
});

test("migrates files from the old naming layout, keeping local edits", async () => {
  await syncSite(config, "test");
  // Rewind to how layout 2 left things: flat dated names, draft_ prefix.
  const statePath = join(dir, "test/.omawp/state.json");
  const state = await Bun.file(statePath).json();
  state.layout = 2;
  for (const [id, s] of Object.entries<any>(state.posts)) {
    const oldFile = id === "2" ? "posts/draft_post-2.md" : `posts/2026-01-01_post-${id}.md`;
    await rename(join(dir, "test", s.file), join(dir, "test", oldFile));
    s.file = oldFile;
  }
  await rm(join(dir, "test/posts/2026"), { recursive: true });
  await rm(join(dir, "test/posts/drafts"), { recursive: true });
  await Bun.write(statePath, JSON.stringify(state));
  await Bun.write(join(dir, "test/posts/2026-01-01_post-1.md"), "my local edit");

  mock.requests.length = 0;
  const r = await syncSite(config, "test");
  const postReq = mock.requests.find((u) => u.pathname.endsWith("/wp/v2/posts"))!;
  expect(postReq.searchParams.has("modified_after")).toBe(false); // full fetch despite lastModified
  expect(r.renamed).toBe(3);
  expect((await readdir(join(dir, "test/posts"), { recursive: true })).sort()).toEqual([
    "2026",
    "2026/2026-01-01_post-1.md",
    "2026/2026-01-01_post-3.md",
    "drafts",
    "drafts/post-2.md",
  ]);
  expect(await read("posts/2026/2026-01-01_post-1.md")).toBe("my local edit");

  // Next sync is incremental again.
  mock.requests.length = 0;
  await syncSite(config, "test");
  expect(mock.requests.find((u) => u.pathname.endsWith("/wp/v2/posts"))!.searchParams.has("modified_after")).toBe(true);
});

test("renames a draft to its dated name when published", async () => {
  await syncSite(config, "test");
  Object.assign(posts[1]!, { status: "publish", slug: "post-2", date: "2026-05-04T09:00:00", modified_gmt: "2026-05-04T14:00:00" });
  const r = await syncSite(config, "test", { full: true });
  expect(r.updated).toEqual(["posts/2026/2026-05-04_post-2.md"]);
  expect(await readdir(join(dir, "test/posts"))).not.toContain("drafts"); // emptied folder removed
});

test("appends the post ID when a name is already taken", async () => {
  await Bun.write(join(dir, "test/posts/2026/2026-01-01_post-1.md"), "stray file");
  const r = await syncSite(config, "test");
  expect(r.created).toContain("posts/2026/2026-01-01_post-1-1.md");
  expect(await read("posts/2026/2026-01-01_post-1.md")).toBe("stray file");
});
