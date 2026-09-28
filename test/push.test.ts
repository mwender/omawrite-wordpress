import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockWP, makePost, USER, PASSWORD } from "./mock-wp.ts";
import { syncSite } from "../src/sync.ts";
import { pushFile, flattenFile } from "../src/push.ts";
import { optimizePost } from "../src/media.ts";
import { DEFAULT_IMAGE_SETTINGS } from "../src/optimize.ts";
import { photoPng } from "./images.ts";
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
  await expect(pushFile(config, path(rel), yes)).rejects.toThrow("changed on WordPress");
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
  await expect(pushFile(config, path(rel), yes)).rejects.toThrow("missing from posts/2026/2026-01-01_post-3.md");
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

// ---------------------------------------------------------------------------
// Featured images
// ---------------------------------------------------------------------------

const POST1 = "posts/2026/2026-01-01_post-1.md";
const setFront = (rel: string, lines: string) => edit(rel, (s) => s.replace(/^title: .*$/m, (t) => `${t}\n${lines}`));
let PNG: Buffer;
const exists = (rel: string) => Bun.file(path(rel)).exists();

test("converts a local image to WebP, uploads it as the featured image, and sets alt text", async () => {
  PNG = await photoPng();
  await Bun.write(path("posts/img/hero.png"), PNG);
  await setFront(POST1, "featured_image: img/hero.png\nfeatured_image_alt: My Mac Mini");

  const dry = await pushFile(config, path(POST1), { dryRun: true });
  expect(dry.plan!.changes[0]!.to).toMatch(/^upload hero\.webp \(\d+ KB; from hero\.png, \d+ KB → \d+ KB, 600×400 lossy q75\)$/);
  expect(dry.plan!.changes[1]).toEqual({ field: "featured_image_alt", from: "", to: "My Mac Mini" });
  expect(mock.uploads).toEqual([]);
  expect(await exists("posts/img/hero.webp")).toBe(false); // dry run writes nothing

  await pushFile(config, path(POST1), yes);
  const webp = new Uint8Array(await Bun.file(path("posts/img/hero.webp")).arrayBuffer());
  expect(mock.uploads).toEqual([{ filename: "hero.webp", type: "image/webp", size: webp.length }]);
  expect(webp.length).toBeLessThan(PNG.length);
  expect(mock.updates).toEqual([{ id: 1, fields: { featured_media: 501 } }]);
  expect(mock.media.get(501)!.alt_text).toBe("My Mac Mini");

  // The file now shows what WordPress has, and there's nothing left to push.
  const { fm } = parse(await Bun.file(path(POST1)).text());
  expect(fm.featured_image).toBe("https://example.test/uploads/2026/09/hero.webp");
  expect(fm.featured_image_alt).toBe("My Mac Mini");
  expect((await pushFile(config, path(POST1), yes)).status).toBe("no-changes");
});

test("--no-optimize uploads the original file", async () => {
  await Bun.write(path("posts/img/hero.png"), await photoPng());
  await setFront(POST1, "featured_image: img/hero.png");
  const r = await pushFile(config, path(POST1), { ...yes, optimize: false });
  expect(r.plan!.changes[0]!.to).toMatch(/^upload hero\.png \(\d+ KB; not optimized\)$/);
  expect(mock.uploads[0]).toMatchObject({ filename: "hero.png", type: "image/png" });
});

test("an earlier as-is upload doesn't stop the optimized version being uploaded", async () => {
  await Bun.write(path("posts/img/hero.png"), await photoPng());
  await setFront(POST1, "featured_image: img/hero.png");
  await pushFile(config, path(POST1), { ...yes, optimize: false });

  await edit(POST1, (s) => s.replace(/^featured_image: .*$/m, "featured_image: img/hero.png"));
  const r = await pushFile(config, path(POST1), yes);
  expect(r.plan!.changes[0]!.to).toMatch(/^upload hero\.webp /);
  expect(mock.uploads.map((u) => u.filename)).toEqual(["hero.png", "hero.webp"]);
  expect(mock.updates.at(-1)).toEqual({ id: 1, fields: { featured_media: 502 } });
});

test("never optimizes or uploads the same file twice", async () => {
  await Bun.write(path("posts/img/hero.png"), await photoPng());
  await setFront(POST1, "featured_image: img/hero.png");
  await pushFile(config, path(POST1), yes);

  const rel = "posts/2026/2026-01-01_post-3.md";
  await setFront(rel, "featured_image: ../../posts/img/hero.png"); // relative to the post file works too
  const r = await pushFile(config, path(rel), yes);
  expect(r.plan!.changes).toEqual([
    { field: "featured_image", from: "(none)", to: "https://example.test/uploads/2026/09/hero.webp (already uploaded)" },
  ]);
  expect(mock.uploads.length).toBe(1);
  expect(mock.updates.at(-1)).toEqual({ id: 3, fields: { featured_media: 501 } });
});

test("optimize command writes the WebP and points front matter at it", async () => {
  await Bun.write(path("posts/img/hero.png"), await photoPng());
  await setFront(POST1, "featured_image: img/hero.png");
  const before = await Bun.file(path(POST1)).text();

  const [r] = await optimizePost(join(dir, "test"), path(POST1), DEFAULT_IMAGE_SETTINGS);
  expect(r).toMatchObject({ image: "img/hero.png", where: "featured_image", to: "img/hero.webp" });
  expect(await exists("posts/img/hero.webp")).toBe(true);
  expect(await exists("posts/img/hero.png")).toBe(true); // original kept
  // Only the featured_image line changed.
  expect(await Bun.file(path(POST1)).text()).toBe(before.replace("featured_image: img/hero.png", "featured_image: img/hero.webp"));

  // Running it again finds nothing more to do; pushing uploads the WebP as-is.
  expect((await optimizePost(join(dir, "test"), path(POST1), DEFAULT_IMAGE_SETTINGS))[0]!.result).toBe("left as is: already WebP");
  const push = await pushFile(config, path(POST1), yes);
  expect(push.plan!.changes[0]!.to).toMatch(/^upload hero\.webp \(\d+ KB; already WebP\)$/);
  expect(mock.uploads[0]).toMatchObject({ filename: "hero.webp", type: "image/webp" });
});

test("a different existing WebP with the same name isn't overwritten", async () => {
  await Bun.write(path("posts/img/hero.png"), await photoPng());
  await Bun.write(path("posts/img/hero.webp"), "someone else's file");
  await setFront(POST1, "featured_image: img/hero.png");
  const [r] = await optimizePost(join(dir, "test"), path(POST1), DEFAULT_IMAGE_SETTINGS);
  expect(r!.to).toMatch(/^img\/hero-[0-9a-f]{8}\.webp$/);
  expect(await Bun.file(path("posts/img/hero.webp")).text()).toBe("someone else's file");
});

test("uses existing media by URL (any size variant) or ID, and removes with none", async () => {
  await setFront(POST1, "featured_image: https://example.test/uploads/2026/09/hero-1024x768.webp");
  await pushFile(config, path(POST1), yes);
  expect(mock.updates.at(-1)).toEqual({ id: 1, fields: { featured_media: 43 } });
  expect(parse(await Bun.file(path(POST1)).text()).fm.featured_image_alt).toBe("A hero");

  await edit(POST1, (s) => s.replace(/^featured_image: .*$/m, "featured_image: 42"));
  await pushFile(config, path(POST1), yes);
  expect(mock.updates.at(-1)).toEqual({ id: 1, fields: { featured_media: 42 } });

  await edit(POST1, (s) => s.replace(/^featured_image: .*$/m, "featured_image: none"));
  await pushFile(config, path(POST1), yes);
  expect(mock.updates.at(-1)).toEqual({ id: 1, fields: { featured_media: 0 } });
  expect(parse(await Bun.file(path(POST1)).text()).fm.featured_image).toBeUndefined();
  expect(mock.uploads).toEqual([]);
});

test("changing only the alt text updates the media item, not the post", async () => {
  await setFront(POST1, "featured_image: 43");
  await pushFile(config, path(POST1), yes);
  const sent = mock.updates.length;

  await edit(POST1, (s) => s.replace("featured_image_alt: A hero", "featured_image_alt: A better description"));
  const r = await pushFile(config, path(POST1), yes);
  expect(r.plan!.changes).toEqual([{ field: "featured_image_alt", from: "A hero", to: "A better description" }]);
  expect(mock.updates.length).toBe(sent);
  expect(mock.media.get(43)!.alt_text).toBe("A better description");
});

test("explains featured image problems before sending anything", async () => {
  await setFront(POST1, "featured_image: img/missing.png");
  await expect(pushFile(config, path(POST1), yes)).rejects.toThrow("can't find img/missing.png");

  await Bun.write(path("posts/img/notes.txt"), "hi");
  await edit(POST1, (s) => s.replace("img/missing.png", "img/notes.txt"));
  await expect(pushFile(config, path(POST1), yes)).rejects.toThrow("isn't a supported image type");

  await edit(POST1, (s) => s.replace("img/notes.txt", "https://elsewhere.test/pic.jpg"));
  await expect(pushFile(config, path(POST1), yes)).rejects.toThrow("isn't in the Media Library");
  expect(mock.uploads).toEqual([]);
  expect(mock.updates).toEqual([]);
});

// ---------------------------------------------------------------------------
// Only what you changed is sent
// ---------------------------------------------------------------------------

// Simulate someone saving the post in WP-Admin after our last sync.
const savedInWordPress = (post: WPPost, changes: Partial<WPPost> = {}) =>
  Object.assign(post, { modified: "2026-08-01T10:00:00", modified_gmt: "2026-08-01T14:00:00", ...changes });

test("a draft date WordPress moved on save isn't pushed back", async () => {
  const rel = "posts/drafts/post-2.md";
  savedInWordPress(posts[1]!, { date: "2026-08-01T10:00:00" }); // floating draft date moved
  await edit(rel, (s) => s.replace("title: Post 2", "title: Better draft title"));

  await expect(pushFile(config, path(rel), yes)).rejects.toThrow("changed on WordPress");
  const r = await pushFile(config, path(rel), { ...yes, force: true });
  expect(r.plan!.changes).toEqual([{ field: "title", from: "Post 2", to: "Better draft title" }]);
  expect(mock.updates).toEqual([{ id: 2, fields: { title: "Better draft title" } }]);
});

test("--force keeps WordPress edits to fields you didn't change", async () => {
  savedInWordPress(posts[0]!, {
    content: { raw: "<!-- wp:paragraph -->\n<p>Edited in WP-Admin.</p>\n<!-- /wp:paragraph -->", rendered: "" },
    featured_media: 43,
    tags: [],
  });
  await edit(POST1, (s) => s.replace("title: Post 1", "title: New title"));
  await pushFile(config, path(POST1), { ...yes, force: true });
  expect(mock.updates).toEqual([{ id: 1, fields: { title: "New title" } }]);

  // The refreshed file shows everything WordPress has now.
  const { fm, body } = parse(await Bun.file(path(POST1)).text());
  expect(body).toBe("Edited in WP-Admin.\n");
  expect(fm.featured_image).toBe("https://example.test/uploads/2026/09/hero.webp");
  expect(fm.tags).toBeUndefined();
});

test("body edits are still sent in full", async () => {
  savedInWordPress(posts[0]!, { date: "2026-08-01T10:00:00" });
  await edit(POST1, (s) => s.replace("Hello from post 1.", "Hello, edited."));
  await pushFile(config, path(POST1), { ...yes, force: true });
  expect(Object.keys(mock.updates[0]!.fields)).toEqual(["content"]);
});

test("sync backfills snapshots for files synced before they existed", async () => {
  const statePath = join(dir, "test/.omawp/state.json");
  const state = await Bun.file(statePath).json();
  for (const s of Object.values<any>(state.posts)) delete s.base;
  await Bun.write(statePath, JSON.stringify(state));

  await syncSite(config, "test");
  const after = await Bun.file(statePath).json();
  expect(after.posts["1"].base.fields.title).toBe("Post 1");

  savedInWordPress(posts[0]!, { date: "2026-08-01T10:00:00" });
  await edit(POST1, (s) => s.replace("title: Post 1", "title: Retitled"));
  await pushFile(config, path(POST1), { ...yes, force: true });
  expect(mock.updates).toEqual([{ id: 1, fields: { title: "Retitled" } }]);
});

// ---------------------------------------------------------------------------
// Images in the body
// ---------------------------------------------------------------------------

const addToBody = (rel: string, md: string) => edit(rel, (s) => s.replace("Hello from post 1.", `Hello from post 1.\n\n${md}`));

test("uploads a standalone body image as an image block with its media ID", async () => {
  await Bun.write(path("posts/img/shot.png"), await photoPng());
  await addToBody(POST1, "![A screenshot](img/shot.png)");

  const dry = await pushFile(config, path(POST1), { dryRun: true });
  expect(dry.plan!.changes).toEqual([{ field: "image", from: "img/shot.png", to: expect.stringMatching(/^upload shot\.webp \(/) }]);
  expect(dry.plan!.contentDiff).toContain('+<!-- wp:image {"id":"NEW"');
  expect(mock.uploads).toEqual([]);

  await pushFile(config, path(POST1), yes);
  expect(mock.uploads).toEqual([{ filename: "shot.webp", type: "image/webp", size: expect.any(Number) }]);
  const url = "https://example.test/uploads/2026/09/shot.webp";
  expect(mock.updates[0]!.fields.content).toBe(
    "<!-- wp:paragraph -->\n<p>Hello from post 1.</p>\n<!-- /wp:paragraph -->\n\n" +
      '<!-- wp:image {"id":501,"sizeSlug":"full","linkDestination":"none"} -->\n' +
      `<figure class="wp-block-image size-full"><img src="${url}" alt="A screenshot" class="wp-image-501"/></figure>\n` +
      "<!-- /wp:image -->",
  );
  // Refreshed from WordPress: the image block (with its ID) stays as HTML, nothing left to push.
  expect(await Bun.file(path(POST1)).text()).toContain(`<img src="${url}"`);
  expect((await pushFile(config, path(POST1), yes)).status).toBe("no-changes");
});

test("inline and HTML images get their URL replaced in place", async () => {
  await Bun.write(path("posts/img/icon.png"), await photoPng(200, 200));
  await addToBody(POST1, 'See ![icon](img/icon.png) here.\n\n<p><img src="img/icon.png" alt="again"></p>');
  await pushFile(config, path(POST1), yes);
  const url = "https://example.test/uploads/2026/09/icon.webp";
  expect(mock.uploads.length).toBe(1); // same file referenced twice
  expect(mock.updates[0]!.fields.content).toContain(`<p>See <img src="${url}" alt="icon"> here.</p>`);
  expect(mock.updates[0]!.fields.content).toContain(`<p><img src="${url}" alt="again"></p>`);
});

test("the same file as featured and body image is uploaded once", async () => {
  await Bun.write(path("posts/img/hero.png"), await photoPng());
  await setFront(POST1, "featured_image: img/hero.png");
  await addToBody(POST1, "![Hero](../../posts/img/hero.png)");
  const r = await pushFile(config, path(POST1), yes);
  expect(r.plan!.changes.map((c) => c.field)).toEqual(["featured_image", "image"]);
  expect(mock.uploads.length).toBe(1);
  expect(mock.updates[0]!.fields.featured_media).toBe(501);
  expect(mock.updates[0]!.fields.content).toContain('"id":501');
});

test("a missing body image stops the push before anything is sent", async () => {
  await addToBody(POST1, "![Nope](img/missing.png)\n\n![Remote is fine](https://elsewhere.test/pic.jpg)");
  await expect(pushFile(config, path(POST1), yes)).rejects.toThrow("image: can't find img/missing.png");
  expect(mock.uploads).toEqual([]);
  expect(mock.updates).toEqual([]);
});

test("classic posts get the URL, not block markup", async () => {
  posts.push(makePost(4, { content: { raw: "A classic post.\n\nSecond paragraph.", rendered: "" } }));
  await syncSite(config, "test");
  const rel = "posts/2026/2026-01-01_post-4.md";
  await Bun.write(path("posts/img/shot.png"), await photoPng());
  await edit(rel, (s) => s.replace("Second paragraph.", "Second paragraph.\n\n![Shot](img/shot.png)"));
  await pushFile(config, path(rel), yes);
  expect(mock.updates[0]!.fields.content).toBe(
    'A classic post.\n\nSecond paragraph.\n\n<img src="https://example.test/uploads/2026/09/shot.webp" alt="Shot">',
  );
});

test("optimize converts featured and body images and rewrites only their references", async () => {
  await Bun.write(path("posts/img/hero.png"), await photoPng());
  await Bun.write(path("posts/img/shot.png"), await photoPng(400, 300));
  await setFront(POST1, "featured_image: img/hero.png");
  await addToBody(POST1, "![Shot](img/shot.png)\n\nAgain: ![Shot](img/shot.png)\n\n```\n![code](img/shot.png)\n```\n\n![Remote](https://x.test/a.png)");
  const before = await Bun.file(path(POST1)).text();

  const reports = await optimizePost(join(dir, "test"), path(POST1), DEFAULT_IMAGE_SETTINGS);
  expect(reports.map((r) => [r.where, r.image, r.to])).toEqual([
    ["featured_image", "img/hero.png", "img/hero.webp"],
    ["body", "img/shot.png", "img/shot.webp"],
  ]);
  const expected = before
    .replace("featured_image: img/hero.png", "featured_image: img/hero.webp")
    .replace("![Shot](img/shot.png)\n\nAgain: ![Shot](img/shot.png)", "![Shot](img/shot.webp)\n\nAgain: ![Shot](img/shot.webp)");
  expect(await Bun.file(path(POST1)).text()).toBe(expected); // code block and remote untouched
  expect(await exists("posts/img/shot.webp")).toBe(true);
});
