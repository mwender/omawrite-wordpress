# omawp

Bun + TypeScript CLI that syncs WordPress posts ⇄ local Markdown. Bun is pinned via `mise.toml`;
run commands with `mise exec -- bun …` if Bun isn't on PATH.

- `src/cli.ts` — command parsing (`add`, `sites`, `remove`, `sync`)
- `src/wp.ts` — REST client (Application Password auth, pagination, API discovery)
- `src/sync.ts` — pull logic; per-site state in `<contentDir>/<site>/.omawp/state.json`
- `src/convert.ts` — HTML ⇄ Markdown. Pull keeps any block as raw HTML unless it round-trips exactly;
  push turns Markdown into canonical Gutenberg blocks (classic posts stay classic). Bump `CONVERTER` on output changes.
- `src/blocks.ts` — Gutenberg block delimiter parser (top-level segments)
- `src/push.ts` — push (conflict check, raw-block safety check, diff/confirm) and `flatten`
- `src/media.ts` — local image uploads for push (`UploadSession`: once per file), featured image, body images, `optimize`; planned first, applied after confirm
- `src/optimize.ts` — deterministic WebP optimization (sharp pinned exactly; bumping it changes output)
- `src/frontmatter.ts`, `src/config.ts`, `src/secrets.ts` (libsecret via `secret-tool`), `src/prompt.ts`
- `bin/omawp-omawrite` — Hyprland-bound helper: runs omawp on the post open in the focused Omawrite window
- `test/` — `bun test`; `test/mock-wp.ts` is a fake WP REST server

Rules: never overwrite locally edited files without `--force`; never store passwords in config;
never push without a conflict check and a way to preview.

Bun conventions: use `bun test`, `Bun.file`/`Bun.write`, `Bun.serve`, `Bun.spawn`; no dotenv/express/etc.
