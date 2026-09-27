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

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url);
      const route = url.pathname.replace(/^\/wp-json\/?/, "");
      if (route === "") return Response.json({ namespaces: ["oembed/1.0", "wp/v2"] });
      if (req.headers.get("Authorization") !== expected) {
        return Response.json({ code: "rest_not_logged_in", message: "Not logged in." }, { status: 401 });
      }
      switch (route) {
        case "wp/v2/users/me":
          return Response.json({ id: 1, name: "Admin", slug: "admin" });
        case "wp/v2/posts": {
          const after = url.searchParams.get("modified_after");
          return paged(after ? posts.filter((p) => p.modified > after) : posts, url);
        }
        case "wp/v2/categories":
          return paged([{ id: 1, name: "News", slug: "news" }, { id: 2, name: "Tips & Tricks", slug: "tips" }], url);
        case "wp/v2/tags":
          return paged([{ id: 5, name: "bun", slug: "bun" }], url);
        case "wp/v2/media": {
          const ids = (url.searchParams.get("include") ?? "").split(",").map(Number);
          return paged(ids.map((id) => ({ id, source_url: `https://example.test/uploads/${id}.jpg` })), url);
        }
      }
      return Response.json({ code: "rest_no_route" }, { status: 404 });
    },
  });

  return { server, requests, url: `http://localhost:${server.port}`, api: `http://localhost:${server.port}/wp-json/` };
}
