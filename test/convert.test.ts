import { test, expect } from "bun:test";
import { htmlToMarkdown, markdownToHtml, rawBlockNames } from "../src/convert.ts";

const P = (html: string) => `<!-- wp:paragraph -->\n<p>${html}</p>\n<!-- /wp:paragraph -->`;

const gallery = `<!-- wp:gallery {"linkTo":"none"} -->
<figure class="wp-block-gallery has-nested-images columns-default is-cropped"><!-- wp:image {"id":12,"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="https://x.test/a.jpg" alt="" class="wp-image-12"/></figure>
<!-- /wp:image -->

<!-- wp:image {"id":13,"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="https://x.test/b.jpg" alt="" class="wp-image-13"/></figure>
<!-- /wp:image --></figure>
<!-- /wp:gallery -->`;

const post = [
  `<!-- wp:heading -->\n<h2 class="wp-block-heading">Title</h2>\n<!-- /wp:heading -->`,
  P(`Some <strong>bold</strong>, I've got <a href="https://x.test">a link</a> &amp; more.`),
  gallery,
  `<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li>one</li>\n<!-- /wp:list-item -->\n\n<!-- wp:list-item -->\n<li>two</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->`,
  `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">Sub</h3>\n<!-- /wp:heading -->`,
  `<!-- wp:code -->\n<pre class="wp-block-code"><code>if (a &lt; b) {}</code></pre>\n<!-- /wp:code -->`,
].join("\n\n");

test("simple blocks become Markdown; complex blocks stay raw", () => {
  const md = htmlToMarkdown(post);
  expect(md).toStartWith("## Title\n\nSome **bold**, I've got [a link](https://x.test) & more.\n\n<!-- wp:gallery");
  expect(md).toContain("-   one\n-   two");
  expect(md).toContain("### Sub");
  expect(md).toContain("```\nif (a < b) {}\n```");
  expect(rawBlockNames(md)).toEqual(["gallery"]);
});

test("pull then push reproduces the original block content exactly", () => {
  expect(markdownToHtml(htmlToMarkdown(post))).toBe(post);
});

test("edits to Markdown become canonical blocks", () => {
  const md = htmlToMarkdown(post).replace("more.", "more!\n\nA new paragraph.\n\n![Alt](https://x.test/c.jpg)");
  const html = markdownToHtml(md);
  expect(html).toContain(P(`Some <strong>bold</strong>, I've got <a href="https://x.test">a link</a> &amp; more!`));
  expect(html).toContain(P("A new paragraph."));
  expect(html).toContain(`<!-- wp:image -->\n<figure class="wp-block-image"><img src="https://x.test/c.jpg" alt="Alt"/></figure>\n<!-- /wp:image -->`);
  expect(html).toContain(gallery);
});

test("blocks that wouldn't round-trip stay raw", () => {
  const styled = `<!-- wp:paragraph {"fontSize":"large"} -->\n<p class="has-large-font-size">Big</p>\n<!-- /wp:paragraph -->`;
  const linked = P(`See <a href="https://x.test" target="_blank" rel="noreferrer noopener">this</a>.`);
  expect(htmlToMarkdown(styled)).toBe(styled + "\n");
  // Rich links stay as inline HTML so the paragraph itself can still be Markdown.
  expect(htmlToMarkdown(linked)).toBe(`See <a href="https://x.test" target="_blank" rel="noreferrer noopener">this</a>.\n`);
  expect(markdownToHtml(htmlToMarkdown(linked))).toBe(linked);
});

test("flatten converts everything to Markdown", () => {
  const md = htmlToMarkdown(gallery, { flatten: true });
  expect(md).toBe("![](https://x.test/a.jpg)\n\n![](https://x.test/b.jpg)\n");
  expect(rawBlockNames(md)).toEqual([]);
});

test("classic posts round-trip without gaining <p> tags", () => {
  const classic = `First para\nsame para\n\nSecond <em>para</em>\n\n<blockquote>Quoted</blockquote>\n\nSource: <a href="https://x.test">x</a>`;
  const md = htmlToMarkdown(classic);
  expect(md).toBe("First para  \nsame para\n\nSecond _para_\n\n<blockquote>Quoted</blockquote>\n\nSource: [x](https://x.test)\n");
  expect(markdownToHtml(md, { classic: true })).toBe(classic);
});

test("leaves shortcodes unescaped", () => {
  expect(htmlToMarkdown('<p>[gallery ids="1,2"] and *stars*</p>')).toBe('[gallery ids="1,2"] and \\*stars\\*\n');
});

test("block comments inside fenced code aren't treated as blocks", () => {
  const md = "Example:\n\n```\n<!-- wp:paragraph -->\n<p>x</p>\n<!-- /wp:paragraph -->\n```\n";
  expect(rawBlockNames(md)).toEqual([]);
  expect(markdownToHtml(md)).toContain('<pre class="wp-block-code"><code>&lt;!-- wp:paragraph --&gt;');
});
