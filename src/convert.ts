import TurndownService from "turndown";
// @ts-expect-error — no type definitions published
import { gfm } from "turndown-plugin-gfm";

// Blocks that survive an HTML → Markdown → HTML round trip without losing meaning.
// Anything else gets flagged in front matter so push (step 2) can be careful with it.
const SIMPLE_BLOCKS = new Set([
  "paragraph", "heading", "list", "list-item", "quote", "image", "code",
  "preformatted", "separator", "table", "freeform", "more", "spacer",
]);

const BLOCK_RE = /<!--\s+wp:(?:([a-z0-9-]+)\/)?([a-z0-9-]+)/g;
const SHORTCODE_RE = /\[\/?[a-zA-Z_][\w-]*(?:\s[^\]]*)?\]/g;

export function blockNames(raw: string): string[] {
  const names = new Set<string>();
  for (const m of raw.matchAll(BLOCK_RE)) names.add(m[1] ? `${m[1]}/${m[2]}` : m[2]!);
  return [...names];
}

export function complexBlocks(raw: string): string[] {
  return blockNames(raw).filter((n) => !SIMPLE_BLOCKS.has(n));
}

// Classic-editor content is stored without <p> tags; WordPress adds them at render
// time (wpautop). Approximate that so paragraphs aren't collapsed by Turndown.
export function autop(raw: string): string {
  const blockTag = /^<\/?(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|figure|hr|iframe|!--)/i;
  return raw
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => (blockTag.test(chunk) ? chunk : `<p>${chunk.replace(/\n/g, "<br>\n")}</p>`))
    .join("\n\n");
}

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  td.use(gfm);
  // Embeds have no Markdown equivalent; keep them as raw HTML.
  td.keep(["iframe", "video", "audio", "embed", "object"] as any);
  // Don't backslash-escape WordPress shortcodes like [gallery ids="1,2"].
  const escape = td.escape.bind(td);
  td.escape = (text: string) => {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(SHORTCODE_RE)) {
      out += escape(text.slice(last, m.index)) + m[0];
      last = m.index! + m[0].length;
    }
    return out + escape(text.slice(last));
  };
  return td;
}

const turndown = createTurndown();

export function htmlToMarkdown(raw: string): string {
  const isBlocks = raw.includes("<!-- wp:");
  const html = isBlocks ? raw : autop(raw);
  return turndown.turndown(html).trim() + "\n";
}
