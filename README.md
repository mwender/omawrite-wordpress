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
omawp find 2026-09-25_my-post.md      # print a synced post's full path by file name
omawp remove blog
```

## Using omawp from Omawrite

Omawrite has no plugin system, so omawp hooks in from the outside: a keyboard shortcut runs
`bin/omawp-omawrite`, which reads the focused Omawrite window's title (`<file>.md - Omawrite`),
finds that post among your synced sites (`omawp find`), and runs omawp on it in a floating
terminal, where you see the diff and confirm as usual.

```sh
bun run link    # also links bin/omawp-omawrite into ~/.local/bin
```

Add the bindings to `~/.config/hypr/bindings.lua` (Omarchy, Hyprland Lua config):

```lua
o.bind("SUPER + ALT + P", "omawp: push post", os.getenv("HOME") .. "/.local/bin/omawp-omawrite push")
o.bind("SUPER + ALT + O", "omawp: optimize featured image", os.getenv("HOME") .. "/.local/bin/omawp-omawrite optimize")
o.bind("SUPER + SHIFT + ALT + P", "omawp: sync site", os.getenv("HOME") .. "/.local/bin/omawp-omawrite sync")
```

Then `hyprctl reload && hyprctl configerrors`. Check keys are free first with
`omarchy menu keybindings --print`.

| Shortcut | Does |
|---|---|
| `Super+Alt+P` | `omawp push` the open post (diff, then confirm) |
| `Super+Alt+O` | `omawp optimize` its local featured image to WebP |
| `Super+Shift+Alt+P` | `omawp sync` the post's site |

- If the post has unsaved changes (title starts with `* `), push and optimize ask you to save
  first; sync still runs.
- If the focused window isn't Omawrite, or the file isn't a synced post, you get a notification
  instead.
- After push or sync rewrites the file, Omawrite notices the change on disk and offers to reload.
- The terminal uses Omarchy's `org.omarchy.terminal` app id, so it floats and centers.
- For testing: `OMAWP_ACTIVE_WINDOW='{"class":"omawrite","title":"x.md - Omawrite"}' OMAWP_DRY=1 omawp-omawrite push`
  prints the command instead of running it.

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
featured_image_alt: A short description
flatten: true              # only if you've chosen Markdown-only for this post (see below)
---
```

## Featured images

`featured_image` accepts:

| Value | Push does |
|---|---|
| `img/hero.png` | Uploads the file to the Media Library and sets it. Paths are tried relative to the site's `posts/` folder, then to the post file; `~/…` and absolute paths work too. |
| a Media Library URL (any size variant) | Sets that existing image |
| a media ID, e.g. `5428` | Sets that existing image |
| `none` | Removes the featured image |
| (line absent) | Leaves it alone |

Local images are converted to WebP before upload (lossy quality 75, longest side capped at
2560px, rotated upright, metadata including GPS stripped; flat graphics/screenshots may stay
lossless). The WebP is saved next to the original. Images that are already WebP/AVIF, animated
GIFs, and images WebP can't shrink are uploaded as-is. `omawp optimize <post>` does the
conversion ahead of time and points `featured_image` at the `.webp`; `push --no-optimize`
skips it. Output is deterministic (sharp is pinned). Override defaults in the config:

```toml
[images]
quality = 80
maxSize = 2048
```

`featured_image_alt` sets the image's alt text. Uploads happen only after you confirm,
and a file is never uploaded twice (omawp remembers uploads by content). After the push
the line shows the image's WordPress URL. Supported: jpg, png, gif, webp, avif.

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
- Sends only what **you** changed since the last sync/push — each front matter field and the
  body separately. Fields you didn't touch are never sent, so `--force` doesn't undo edits made
  in WP-Admin or things WordPress changes itself (a draft's date moves on every save).
- Shows changed fields and a content diff, then asks before sending (`-y` skips, `--dry-run` only shows).
- Unknown categories/tags are created.
- Rewrites the local file from what WordPress saved, moving it if needed (e.g. a draft you published).

## Roadmap

1. ~~`add` / `sync` (pull)~~
2. ~~`push` with conflict detection~~
3. `status`, `diff`, `new`
4. OpenTUI browser
5. ~~Featured images from local files~~; inline images (`![](img/x.png)` uploaded on push)
