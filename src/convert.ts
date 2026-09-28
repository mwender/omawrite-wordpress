import TurndownService from "turndown";
// @ts-expect-error — no type definitions published
import { gfm } from "turndown-plugin-gfm";
import { Lexer, Parser, type Token, type Tokens } from "marked";
import { parseBlocks, hasBlocks, maskFences, type Segment } from "./blocks.ts";

// Bump when pull output (body or front matter) changes; sync then rewrites every
// file you haven't edited.
export const CONVERTER = 4;

// ---------------------------------------------------------------------------
// HTML → Markdown (pull)
// ---------------------------------------------------------------------------

const SHORTCODE_RE = /\[\/?[a-zA-Z_][\w-]*(?:\s[^\]]*)?\]/g;

// Classic-editor content is stored without <p> tags; WordPress adds them at render
// time (wpautop). Approximate that so paragraphs aren't collapsed by Turndown.
export function autop(raw: string): string {
  return splitChunks(raw)
    .map((chunk) => (BLOCK_TAG.test(chunk) ? chunk : `<p>${chunk.replace(/\n/g, "<br>\n")}</p>`))
    .join("\n\n");
}

const BLOCK_TAG = /^<\/?(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|figure|hr|iframe|!--)/i;

function splitChunks(html: string): string[] {
  return html.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
}

// Turndown hands us DOM nodes (domino); we only need these bits.
type El = { nodeName: string; attributes: ArrayLike<{ name: string }>; outerHTML: string };

function hasExtraAttrs(node: El, allowed: string[]): boolean {
  return Array.from(node.attributes).some((a) => !allowed.includes(a.name));
}

// `faithful` keeps inline HTML that Markdown would lose; flatten mode drops it.
function createTurndown(faithful: boolean): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  td.use(gfm);
  // Things Markdown can't express stay as inline HTML.
  td.keep(["iframe", "video", "audio", "embed", "object", "sup", "sub", "mark", "u", "kbd", "span"] as any);
  if (faithful) td.addRule("richLinksAndImages", {
    filter: (node) =>
      (node.nodeName === "A" && hasExtraAttrs(node as unknown as El, ["href", "title"])) ||
      (node.nodeName === "IMG" && hasExtraAttrs(node as unknown as El, ["src", "alt", "title"])),
    replacement: (_content, node) => (node as unknown as El).outerHTML,
  });
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

const turndown = createTurndown(true);
const turndownFlat = createTurndown(false);

function toMarkdown(html: string, flatten = false): string {
  return (flatten ? turndownFlat : turndown).turndown(html).trim();
}

// Loose comparison for "does this round-trip?": ignores insignificant whitespace
// (including just inside block-level tags), self-closing slashes, and equivalent
// entity spellings.
function normalize(html: string): string {
  return html
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s*\/>/g, ">")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s*<br>\s*/g, "<br>")
    .replace(/(<(?:p|li|h[1-6]|blockquote|figcaption)(?:\s[^>]*)?>)\s+/g, "$1")
    .replace(/\s+(<\/(?:p|li|h[1-6]|blockquote|figcaption)>)/g, "$1")
    .trim();
}

// Convert one piece of HTML to Markdown only if converting back reproduces it.
function tryMarkdown(html: string, render: (md: string) => string): string | null {
  const md = toMarkdown(html);
  if (!md) return null;
  return normalize(render(md)) === normalize(html) ? md : null;
}

export interface PullOptions {
  flatten?: boolean; // convert everything to Markdown, even if it won't round-trip
}

export function htmlToMarkdown(raw: string, opts: PullOptions = {}): string {
  const parts: string[] = [];
  if (!hasBlocks(raw)) {
    // Classic post: each paragraph-level chunk is Markdown if it round-trips, else HTML.
    for (const chunk of splitChunks(autop(raw))) {
      parts.push(opts.flatten ? toMarkdown(chunk, true) : (tryMarkdown(chunk, renderClassic) ?? chunk));
    }
  } else {
    for (const seg of parseBlocks(raw)) {
      if (opts.flatten) parts.push(toMarkdown(seg.text, true));
      else if (seg.kind === "freeform") parts.push(tryMarkdown(seg.text, renderClassic) ?? seg.text);
      else parts.push(tryMarkdown(seg.text, renderBlocks) ?? seg.text);
    }
  }
  return parts.filter(Boolean).join("\n\n") + "\n";
}

// Names of blocks kept as raw HTML in a pulled file (for the push safety check).
export function rawBlockNames(markdown: string): string[] {
  return parseBlocks(markdown, maskFences(markdown))
    .filter((s) => s.kind === "block")
    .map((s) => s.name!);
}

// ---------------------------------------------------------------------------
// Markdown → HTML (push)
// ---------------------------------------------------------------------------

// marked escapes quotes in text; WordPress content usually has them literally.
function tidy(html: string): string {
  return html
    .split(/(<[^>]+>)/)
    .map((part) => (part.startsWith("<") ? part : part.replace(/&#39;/g, "'").replace(/&quot;/g, '"')))
    .join("");
}

const inline = (tokens: Token[] = []) => tidy(Parser.parseInline(tokens));
const escapeCode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function block(name: string, html: string, attrs?: Record<string, unknown>): string {
  const a = attrs && Object.keys(attrs).length ? ` ${JSON.stringify(attrs)}` : "";
  return `<!-- wp:${name}${a} -->\n${html}\n<!-- /wp:${name} -->`;
}

// A paragraph that's only an image (optionally linked) becomes an image block.
function imageBlock(tokens: Token[]): string | null {
  if (tokens.length !== 1) return null;
  const t = tokens[0]!;
  const img = (i: Tokens.Image) => `<img src="${i.href}" alt="${i.text.replace(/"/g, "&quot;")}"/>`;
  if (t.type === "image") return block("image", `<figure class="wp-block-image">${img(t as Tokens.Image)}</figure>`);
  if (t.type === "link") {
    const link = t as Tokens.Link;
    if (link.tokens?.length === 1 && link.tokens[0]!.type === "image") {
      return block("image", `<figure class="wp-block-image"><a href="${link.href}">${img(link.tokens[0] as Tokens.Image)}</a></figure>`);
    }
  }
  return null;
}

function listBlock(list: Tokens.List): string {
  const tag = list.ordered ? "ol" : "ul";
  const items = list.items.map((item) => {
    let html = "";
    for (const t of item.tokens) {
      if (t.type === "list") html += listBlock(t as Tokens.List);
      else if (t.type === "text" || t.type === "paragraph") html += inline((t as Tokens.Text).tokens ?? [t]);
      else if (t.type !== "space") html += tidy(Parser.parse([t]));
    }
    return block("list-item", `<li>${html}</li>`);
  });
  const attrs = list.ordered ? { ordered: true, ...(list.start !== 1 && list.start !== "" ? { start: list.start } : {}) } : undefined;
  const start = attrs?.start ? ` start="${attrs.start}"` : "";
  return block("list", `<${tag}${start} class="wp-block-list">${items.join("\n\n")}</${tag}>`, attrs);
}

function tokenToBlock(t: Token): string {
  switch (t.type) {
    case "space":
    case "def":
      return "";
    case "paragraph":
      return imageBlock(t.tokens ?? []) ?? block("paragraph", `<p>${inline(t.tokens)}</p>`);
    case "heading": {
      const h = t as Tokens.Heading;
      return block("heading", `<h${h.depth} class="wp-block-heading">${inline(h.tokens)}</h${h.depth}>`, h.depth === 2 ? undefined : { level: h.depth });
    }
    case "list":
      return listBlock(t as Tokens.List);
    case "blockquote":
      return block("quote", `<blockquote class="wp-block-quote">${tokensToBlocks((t as Tokens.Blockquote).tokens)}</blockquote>`);
    case "code":
      return block("code", `<pre class="wp-block-code"><code>${escapeCode((t as Tokens.Code).text)}</code></pre>`);
    case "hr":
      return block("separator", `<hr class="wp-block-separator has-alpha-channel-opacity"/>`);
    case "table":
      return block("table", `<figure class="wp-block-table">${tidy(Parser.parse([t])).trim()}</figure>`);
    case "html":
      return t.raw.trim(); // becomes a classic/freeform block, as in the original
    default:
      return tidy(Parser.parse([t])).trim();
  }
}

function tokensToBlocks(tokens: Token[]): string {
  return tokens.map(tokenToBlock).filter(Boolean).join("\n\n");
}

function renderBlocks(md: string): string {
  return tokensToBlocks(Lexer.lex(md));
}

function renderClassic(md: string): string {
  return tidy(Parser.parse(Lexer.lex(md))).trim();
}

// Inverse of autop: classic posts store paragraphs as blank-line-separated text,
// so push them back that way instead of adding <p> tags everywhere.
function unwrapP(html: string): string {
  const m = html.match(/^<p>([\s\S]*)<\/p>$/);
  return m && !/<\/?p[\s>]/.test(m[1]!) ? m[1]!.replace(/<br>\n?/g, "\n") : html;
}

function renderClassicStored(md: string): string {
  return Lexer.lex(md)
    .map((t) => {
      if (t.type === "space" || t.type === "def") return "";
      if (t.type === "paragraph") return unwrapP(`<p>${inline(t.tokens)}</p>`);
      if (t.type === "html") return unwrapP(t.raw.trim());
      return tidy(Parser.parse([t])).trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

// Raw block HTML in the Markdown passes through untouched; the rest is converted.
export function markdownToHtml(markdown: string, opts: { classic?: boolean } = {}): string {
  const render = opts.classic ? renderClassicStored : renderBlocks;
  return parseBlocks(markdown, maskFences(markdown))
    .map((seg: Segment) => (seg.kind === "block" ? seg.text : render(seg.text)))
    .filter(Boolean)
    .join("\n\n");
}
