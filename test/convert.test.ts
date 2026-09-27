import { test, expect } from "bun:test";
import { htmlToMarkdown, complexBlocks } from "../src/convert.ts";

test("converts block content", () => {
  const raw = `<!-- wp:heading -->
<h2 class="wp-block-heading">Title</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Some <strong>bold</strong> and <a href="https://x.test">a link</a>.</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul><li>one</li><li>two</li></ul>
<!-- /wp:list -->`;
  expect(htmlToMarkdown(raw)).toBe("## Title\n\nSome **bold** and [a link](https://x.test).\n\n-   one\n-   two\n");
});

test("adds paragraphs to classic-editor content", () => {
  expect(htmlToMarkdown("First para\nsame para\n\nSecond para")).toBe("First para  \nsame para\n\nSecond para\n");
});

test("leaves shortcodes unescaped", () => {
  expect(htmlToMarkdown('<p>[gallery ids="1,2"] and *stars*</p>')).toBe('[gallery ids="1,2"] and \\*stars\\*\n');
});

test("keeps embeds as HTML", () => {
  expect(htmlToMarkdown('<p>Watch:</p><iframe src="https://y.test/e"></iframe>')).toContain('<iframe src="https://y.test/e"></iframe>');
});

test("flags complex blocks", () => {
  expect(complexBlocks("<!-- wp:paragraph --><!-- wp:columns --><!-- wp:acme/slider {\"a\":1} -->")).toEqual([
    "columns",
    "acme/slider",
  ]);
});
