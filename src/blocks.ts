// Splits serialized Gutenberg content into top-level blocks and the freeform
// (classic) HTML between them. Same delimiter grammar as WordPress's block parser.

export interface Segment {
  kind: "block" | "freeform";
  name?: string; // "paragraph", "acme/slider" (core/ prefix dropped)
  attrs?: Record<string, unknown>;
  text: string; // exact source, including block comments
}

const DELIM_RE = /<!--\s+(\/)?wp:((?:[a-z][a-z0-9_-]*\/)?[a-z][a-z0-9_-]*)\s+(?:(\{[\s\S]*?\})\s+)?(\/)?-->/g;

function normalizeName(name: string): string {
  return name.startsWith("core/") ? name.slice(5) : name;
}

// `mask` is a same-length copy of `src` used for finding delimiters, so callers can
// blank out regions (like fenced code in Markdown) that must not be parsed.
export function parseBlocks(src: string, mask: string = src): Segment[] {
  const out: Segment[] = [];
  let depth = 0;
  let start = 0; // start of the current top-level block
  let cursor = 0; // end of the last emitted segment
  let open: { name: string; attrs?: Record<string, unknown> } | null = null;

  const freeform = (end: number) => {
    const text = src.slice(cursor, end);
    if (text.trim()) out.push({ kind: "freeform", text: text.trim() });
  };

  for (const m of mask.matchAll(DELIM_RE)) {
    const [whole, closer, rawName, rawAttrs, selfClosing] = m;
    const idx = m.index!;
    const end = idx + whole.length;
    if (closer) {
      if (depth === 0) continue; // stray closer; leave it in freeform text
      depth--;
      if (depth === 0) {
        out.push({ kind: "block", ...open!, text: src.slice(start, end) });
        cursor = end;
      }
      continue;
    }
    if (depth === 0) {
      freeform(idx);
      let attrs: Record<string, unknown> | undefined;
      try {
        attrs = rawAttrs ? JSON.parse(src.slice(idx, end).match(/\{[\s\S]*\}/)![0]) : undefined;
      } catch {}
      if (selfClosing) {
        out.push({ kind: "block", name: normalizeName(rawName!), attrs, text: src.slice(idx, end) });
        cursor = end;
        continue;
      }
      open = { name: normalizeName(rawName!), attrs };
      start = idx;
    }
    if (!selfClosing) depth++;
  }
  // Unclosed block: keep the rest as-is rather than dropping it.
  if (depth > 0) {
    out.push({ kind: "block", ...open!, text: src.slice(start) });
  } else {
    freeform(src.length);
  }
  return out;
}

export function hasBlocks(src: string): boolean {
  return /<!--\s+wp:/.test(src);
}

// Blank out fenced code blocks so block comments shown *as code* aren't parsed.
export function maskFences(md: string): string {
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (s) => s.replace(/[^\n]/g, " "));
}
