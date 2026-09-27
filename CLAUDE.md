# omawp

Bun + TypeScript CLI that syncs WordPress posts ⇄ local Markdown. Bun is pinned via `mise.toml`;
run commands with `mise exec -- bun …` if Bun isn't on PATH.

- `src/cli.ts` — command parsing (`add`, `sites`, `remove`, `sync`)
- `src/wp.ts` — REST client (Application Password auth, pagination, API discovery)
- `src/sync.ts` — pull logic; per-site state in `<contentDir>/<site>/.omawp/state.json`
- `src/convert.ts` — HTML/Gutenberg → Markdown (Turndown), complex-block detection
- `src/frontmatter.ts`, `src/config.ts`, `src/secrets.ts` (libsecret via `secret-tool`), `src/prompt.ts`
- `test/` — `bun test`; `test/mock-wp.ts` is a fake WP REST server

Rules: never overwrite locally edited files without `--force`; never store passwords in config.

Bun conventions: use `bun test`, `Bun.file`/`Bun.write`, `Bun.serve`, `Bun.spawn`; no dotenv/express/etc.
