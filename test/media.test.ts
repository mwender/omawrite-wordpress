import { test, expect } from "bun:test";
import { findImageRefs } from "../src/media.ts";

test("finds local Markdown and HTML images, skipping URLs and code", () => {
  const body = [
    "Intro with an inline ![icon](img/icon.png) image.",
    "",
    '![A screenshot](img/shot.png "Title")',
    "",
    '<p>HTML <img class="x" src="../img/raw.jpg" alt="Raw one"></p>',
    "",
    "![remote](https://example.com/a.png) ![data](data:image/png;base64,AAAA) ![cdn](//cdn.test/b.png)",
    "",
    "```",
    "![not an image](img/in-code.png)",
    "```",
    "",
    "![last](img/last.webp)",
  ].join("\n");
  const refs = findImageRefs(body);
  expect(refs.map((r) => [r.kind, r.path, r.alt, r.standalone])).toEqual([
    ["markdown", "img/icon.png", "icon", false],
    ["markdown", "img/shot.png", "A screenshot", true],
    ["html", "../img/raw.jpg", "Raw one", false],
    ["markdown", "img/last.webp", "last", true],
  ]);
  for (const r of refs) expect(body.slice(r.pathStart, r.pathEnd)).toBe(r.path);
});

test("an image next to text in the same paragraph isn't standalone", () => {
  const [ref] = findImageRefs("Caption line\n![shot](img/shot.png)\n");
  expect(ref!.standalone).toBe(false);
});
