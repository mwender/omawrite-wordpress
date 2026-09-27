import YAML from "yaml";

export interface FrontMatter {
  id?: number;
  title: string;
  slug?: string;
  status?: string;
  date?: string;
  modified_gmt?: string;
  link?: string;
  categories?: string[];
  tags?: string[];
  excerpt?: string;
  featured_image?: string;
  sticky?: boolean;
  complex_blocks?: string[];
  [key: string]: unknown;
}

export function serialize(fm: FrontMatter, body: string): string {
  // Drop empty values so the header stays readable.
  const clean = Object.fromEntries(
    Object.entries(fm).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)),
  );
  return `---\n${YAML.stringify(clean, { lineWidth: 0 })}---\n\n${body}`;
}

export function parse(text: string): { fm: FrontMatter; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: { title: "" }, body: text };
  return { fm: (YAML.parse(m[1]!) ?? {}) as FrontMatter, body: text.slice(m[0].length).replace(/^\r?\n/, "") };
}
