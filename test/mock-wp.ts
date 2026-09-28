// A tiny fake WordPress REST API for tests.
import type { WPPost } from "../src/wp.ts";

export const USER = "admin";
export const PASSWORD = "abcd efgh ijkl mnop";

export function makePost(id: number, overrides: Partial<WPPost> = {}): WPPost {
  return {
    id,
    date: "2026-01-01T10:00:00",
    date_gmt: "2026-01-01T15:00:00",
    modified: "2026-01-02T10:00:00",
    modified_gmt: "2026-01-02T15:00:00",
    slug: `post-${id}`,
    status: "publish",
    link: `https://example.test/post-${id}/`,
    title: { raw: `Post ${id}`, rendered: `Post ${id}` },
    content: { raw: `<!-- wp:paragraph -->\n<p>Hello from post ${id}.</p>\n<!-- /wp:paragraph -->`, rendered: "" },
    excerpt: { raw: "", rendered: "" },
    featured_media: 0,
    categories: [1],
    tags: [],
    ...overrides,
  };
}

export function startMockWP(posts: WPPost[]) {
  const expected = "Basic " + Buffer.from(`${USER}:${PASSWORD.replace(/\s+/g, "")}`).toString("base64");
  const requests: URL[] = [];

  const paged = (items: unknown[], url: URL) => {
    const perPage = Number(url.searchParams.get("per_page") ?? 10);
    const page = Number(url.searchParams.get("page") ?? 1);
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    return Response.json(items.slice((page - 1) * perPage, page * perPage), {
      headers: { "X-WP-Total": String(items.length), "X-WP-TotalPages": String(totalPages) },
    });
  };

  const categories = [{ id: 1, name: "News", slug: "news" }, { id: 2, name: "Tips &amp; Tricks", slug: "tips" }];
  const tags = [{ id: 5, name: "bun", slug: "bun" }];
  const updates: { id: number; fields: Record<string, any> }[] = [];
  const media = new Map<number, { id: number; source_url: string; alt_text: string }>([
    [42, { id: 42, source_url: "https://example.test/uploads/42.jpg", alt_text: "" }],
    [43, { id: 43, source_url: "https://example.test/uploads/2026/09/hero.webp", alt_text: "A hero" }],
  ]);
  const uploads: { filename: string; type: string; size: number }[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url);
      const route = url.pathname.replace(/^\/wp-json\/?/, "");
      if (route === "") return Response.json({ namespaces: ["oembed/1.0", "wp/v2"] });
      if (req.headers.get("Authorization") !== expected) {
        return Response.json({ code: "rest_not_logged_in", message: "Not logged in." }, { status: 401 });
      }
      const single = route.match(/^wp\/v2\/posts\/(\d+)$/);
      if (single) {
        const post = posts.find((p) => p.id === Number(single[1]));
        if (!post) return Response.json({ code: "rest_post_invalid_id" }, { status: 404 });
        if (req.method === "POST") {
          const fields = (await req.json()) as Record<string, any>;
          updates.push({ id: post.id, fields });
          for (const [k, v] of Object.entries(fields)) {
            if (k === "title" || k === "content" || k === "excerpt") (post as any)[k] = { raw: v, rendered: "" };
            else (post as any)[k] = v;
          }
          // Like WordPress, give a post a slug from its title when it's published.
          if (post.status === "publish" && !post.slug) post.slug = post.title.raw!.toLowerCase().replace(/\W+/g, "-");
          post.modified = "2026-09-01T10:00:00";
          post.modified_gmt = "2026-09-01T15:00:00";
        }
        return Response.json(post);
      }
      if (req.method === "POST" && route === "wp/v2/media") {
        const filename = req.headers.get("Content-Disposition")!.match(/filename="([^"]+)"/)![1]!;
        const size = (await req.arrayBuffer()).byteLength;
        uploads.push({ filename, type: req.headers.get("Content-Type")!, size });
        const item = { id: 500 + uploads.length, source_url: `https://example.test/uploads/2026/09/${filename}`, alt_text: "" };
        media.set(item.id, item);
        return Response.json(item, { status: 201 });
      }
      const mediaItem = route.match(/^wp\/v2\/media\/(\d+)$/);
      if (mediaItem && req.method === "POST") {
        const item = media.get(Number(mediaItem[1]));
        if (!item) return Response.json({ code: "rest_post_invalid_id" }, { status: 404 });
        Object.assign(item, await req.json());
        return Response.json(item);
      }
      if (req.method === "POST" && (route === "wp/v2/categories" || route === "wp/v2/tags")) {
        const list = route.endsWith("categories") ? categories : tags;
        const { name } = (await req.json()) as { name: string };
        const term = { id: 100 + list.length, name, slug: name.toLowerCase() };
        list.push(term);
        return Response.json(term, { status: 201 });
      }
      switch (route) {
        case "wp/v2/users/me":
          return Response.json({ id: 1, name: "Admin", slug: "admin" });
        case "wp/v2/posts": {
          const after = url.searchParams.get("modified_after");
          return paged(after ? posts.filter((p) => p.modified > after) : posts, url);
        }
        case "wp/v2/categories":
          return paged(categories, url);
        case "wp/v2/tags":
          return paged(tags, url);
        case "wp/v2/media": {
          const search = url.searchParams.get("search");
          if (search) return paged([...media.values()].filter((m) => m.source_url.includes(search)), url);
          const ids = (url.searchParams.get("include") ?? "").split(",").map(Number);
          return paged(ids.flatMap((id) => media.get(id) ?? []), url);
        }
      }
      return Response.json({ code: "rest_no_route" }, { status: 404 });
    },
  });

  return { server, requests, updates, media, uploads, url: `http://localhost:${server.port}`, api: `http://localhost:${server.port}/wp-json/` };
}
