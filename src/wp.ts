// Minimal WordPress REST API client (Application Password auth).

export interface WPPost {
  id: number;
  date: string;
  date_gmt: string | null;
  modified: string;
  modified_gmt: string;
  slug: string;
  status: string;
  link: string;
  sticky?: boolean;
  title: { raw?: string; rendered: string };
  content: { raw?: string; rendered: string };
  excerpt: { raw?: string; rendered: string };
  featured_media: number;
  categories?: number[];
  tags?: number[];
}

export interface WPTerm {
  id: number;
  name: string;
  slug: string;
}

export interface WPMedia {
  id: number;
  source_url: string;
}

// Term names come back HTML-encoded ("Tips &amp; Tricks").
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const decodeTerm = (t: WPTerm): WPTerm => ({ ...t, name: decodeEntities(t.name) });

export const POST_STATUSES = ["publish", "future", "draft", "pending", "private"];

export class WPError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class WPClient {
  private auth: string;

  constructor(public api: string, username: string, password: string) {
    this.auth = "Basic " + Buffer.from(`${username}:${password.replace(/\s+/g, "")}`).toString("base64");
  }

  // Build an endpoint URL that works for both /wp-json/ and ?rest_route= style roots.
  url(route: string, params: Record<string, string | number> = {}): string {
    const u = new URL(this.api);
    if (u.searchParams.has("rest_route")) {
      u.searchParams.set("rest_route", "/" + route.replace(/^\//, ""));
    } else {
      u.pathname = u.pathname.replace(/\/?$/, "/") + route.replace(/^\//, "");
    }
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T>(
    route: string,
    params: Record<string, string | number> = {},
    body?: unknown,
  ): Promise<{ data: T; res: Response }> {
    const res = await fetch(this.url(route, params), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: this.auth,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { message?: string; code?: string };
        if (body.message) msg += ` — ${body.message}`;
      } catch {}
      throw new WPError(res.status, msg);
    }
    return { data: (await res.json()) as T, res };
  }

  async paginate<T>(route: string, params: Record<string, string | number> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const { data, res } = await this.request<T[]>(route, { per_page: 100, ...params, page });
      out.push(...data);
      const totalPages = Number(res.headers.get("X-WP-TotalPages") ?? 1);
      if (page >= totalPages || data.length === 0) break;
    }
    return out;
  }

  me() {
    return this.request<{ id: number; name: string; slug: string }>("wp/v2/users/me", { context: "edit" }).then((r) => r.data);
  }

  posts(params: Record<string, string | number> = {}) {
    return this.paginate<WPPost>("wp/v2/posts", { context: "edit", status: POST_STATUSES.join(","), ...params });
  }

  post(id: number) {
    return this.request<WPPost>(`wp/v2/posts/${id}`, { context: "edit" }).then((r) => r.data);
  }

  updatePost(id: number, fields: Record<string, unknown>) {
    return this.request<WPPost>(`wp/v2/posts/${id}`, { context: "edit" }, fields).then((r) => r.data);
  }

  createTerm(taxonomy: "categories" | "tags", name: string) {
    return this.request<WPTerm>(`wp/v2/${taxonomy}`, {}, { name }).then((r) => r.data);
  }

  async categories() {
    return (await this.paginate<WPTerm>("wp/v2/categories", { _fields: "id,name,slug" })).map(decodeTerm);
  }

  async tags() {
    return (await this.paginate<WPTerm>("wp/v2/tags", { _fields: "id,name,slug" })).map(decodeTerm);
  }

  async media(ids: number[]): Promise<WPMedia[]> {
    const out: WPMedia[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      out.push(...(await this.paginate<WPMedia>("wp/v2/media", { include: chunk.join(","), _fields: "id,source_url" })));
    }
    return out;
  }
}

// Find the REST API root for a site URL: /wp-json/ first, then ?rest_route= (no pretty permalinks).
export async function discoverApi(siteUrl: string): Promise<string> {
  const base = siteUrl.replace(/\/+$/, "");
  for (const candidate of [`${base}/wp-json/`, `${base}/?rest_route=/`]) {
    try {
      const res = await fetch(candidate, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const body = (await res.json()) as { namespaces?: string[] };
      if (body.namespaces?.includes("wp/v2")) return candidate;
    } catch {}
  }
  throw new Error(`Couldn't find a WordPress REST API at ${siteUrl}`);
}
