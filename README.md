# omawrite-wordpress (`omawp`)

Sync WordPress posts to local Markdown files so you can browse and edit them in
[Omawrite](https://github.com/omacom-io/omawrite) (or any editor), then push them back.

Talks to sites over the WordPress REST API with
[Application Passwords](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) —
nothing to install on the sites.

## Install

```sh
mise install        # installs the pinned Bun
bun install
bun run link        # symlinks bin/omawp into ~/.local/bin
```

## Usage

```sh
omawp add                      # prompts for URL, username, Application Password
omawp add blog --url example.com --user me
omawp sites                    # list sites
omawp sync                     # pull every site (alias: omawp sync posts)
omawp sync blog --full         # refetch everything, report posts deleted remotely
omawp sync blog --force        # overwrite local edits
omawp push posts/2026/2026-09-25_my-post.md --dry-run   # show the diff, send nothing
omawp push posts/drafts/my-draft.md                     # show the diff, ask, then send
omawp flatten posts/2026/2026-09-25_my-post.md          # turn a post's raw HTML into Markdown
omawp remove blog
```

## Where things live

| What | Where |
|---|---|
| Config | `~/.config/omawp/config.toml` (`contentDir`, `[sites.<name>]` url/api/username) |
| Passwords | System keyring via `secret-tool` (`service=omawp site=<name>`), or `OMAWP_APP_PASSWORD_<NAME>` |
| Posts | `~/Documents/WordPress/<site>/posts/YYYY/YYYY-MM-DD_<slug>.md`; drafts and pending posts in `posts/drafts/<title>.md` |
| Sync state | `~/Documents/WordPress/<site>/.omawp/state.json`, original HTML in `.omawp/raw/<id>.html` |

## Front matter

```yaml
---
id: 123
title: Hello world
slug: hello-world
status: publish            # publish | future | draft | pending | private
date: 2026-01-01T10:00:00  # site-local time
modified_gmt: 2026-01-02T15:00:00
link: https://example.com/hello-world/
categories: [News]
tags: [bun, wordpress]
excerpt: Short summary
featured_image: https://example.com/wp-content/uploads/hero.jpg
flatten: true              # only if you've chosen Markdown-only for this post (see below)
---
```

## WordPress blocks and raw HTML

A block becomes Markdown only if converting it back reproduces the original exactly.
Everything else — galleries, embeds, styled paragraphs, images with media-library IDs —
stays in the file as the original WordPress block HTML (`<!-- wp:gallery … -->…`) and is
pushed back untouched. Edit around it freely.

`push` refuses if a block that was kept as HTML is missing from the file, since that would
replace it with plain Markdown (e.g. a gallery becoming separate images). To accept that,
use `omawp push --flatten`, or run `omawp flatten <file>` first to convert the HTML to
Markdown up front. Either marks the post `flatten: true`, and it stays Markdown-only on later pulls.

Classic-editor posts are pushed back in classic format (no block markup is added).

## Sync behavior

- Incremental by default: only posts modified since the last sync (with a one-day overlap for timezone skew).
- Files you've edited locally are never overwritten without `--force`.
- If a post's slug, date, or status changes on the site, the local file is renamed (local edits move with it).
  Drafts are named by title because WordPress changes a draft's date on every save; once published they
  move to their year folder. If a name is taken, the post ID is appended.
- If the naming scheme changes between versions, the next sync fetches everything and renames existing files.
- Posts deleted or trashed on the site are reported on `--full` syncs, never deleted locally.

## Push behavior

- Checks the post hasn't changed on WordPress since your last sync (`--force` overrides).
- Shows changed fields and a content diff, then asks before sending (`-y` skips, `--dry-run` only shows).
- Sends only changed fields. Unknown categories/tags are created.
- Rewrites the local file from what WordPress saved, moving it if needed (e.g. a draft you published).

## Roadmap

1. ~~`add` / `sync` (pull)~~
2. ~~`push` with conflict detection~~
3. `status`, `diff`, `new`
4. OpenTUI browser
5. Media uploads / featured images from local files
