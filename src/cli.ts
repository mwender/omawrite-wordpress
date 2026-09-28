#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { loadConfig, saveConfig, siteDir, imageSettings, CONFIG_PATH } from "./config.ts";
import { storePassword, deletePassword } from "./secrets.ts";
import { WPClient, WPError, discoverApi } from "./wp.ts";
import { syncSite } from "./sync.ts";
import { pushFile, flattenFile, locate, type PushPlan } from "./push.ts";
import { optimizePost } from "./media.ts";
import { ask, askSecret } from "./prompt.ts";

const HELP = `omawp — sync WordPress posts to local Markdown

Usage:
  omawp add [name] [--url URL] [--user USERNAME]   Add a site (prompts for an Application Password)
  omawp sites                                      List configured sites
  omawp remove <name>                              Remove a site and its stored password
  omawp sync [site...] [--full] [--force]          Pull posts to Markdown (all sites if none given)
  omawp push <file...> [--dry-run] [-y] [--force] [--flatten] [--no-optimize]
                                                   Send edited posts back (shows a diff, asks first)
  omawp flatten <file...>                          Convert a post's raw WordPress HTML to Markdown
  omawp optimize <file...>                         Convert a post's local featured image to WebP

Options:
  --full      sync: fetch every post instead of only recently modified ones
  --force     sync: overwrite local edits. push: overwrite changes made on WordPress
  --dry-run   push: show what would change without sending anything
  -y, --yes   push: don't ask for confirmation
  --flatten   push: allow WordPress blocks (galleries etc.) to be replaced by Markdown
  --no-optimize  push: upload images as-is instead of converting to WebP

Images are converted to WebP (lossy quality 75, max 2560px) before upload. Override in
the config with [images] quality = 80 / maxSize = 2048.

Config: ${CONFIG_PATH}
`;

function slugify(s: string): string {
  return s.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeUrl(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const u = new URL(withScheme);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

async function cmdAdd(args: string[], flags: { url?: string; user?: string }) {
  const config = await loadConfig();
  const url = normalizeUrl(flags.url || (await ask("Site URL")));
  if (!url) throw new Error("A site URL is required.");
  const name = slugify(args[0] || (await ask("Short name", slugify(new URL(url).host))));
  if (config.sites[name]) throw new Error(`A site named "${name}" already exists. Remove it first.`);
  if (url.startsWith("http://")) console.warn("⚠ Application Passwords require HTTPS on most sites.");

  process.stdout.write("Finding REST API… ");
  const api = await discoverApi(url);
  console.log(api);

  const username = flags.user || (await ask("WordPress username"));
  console.log(`Create an Application Password at ${url}/wp-admin/profile.php (Application Passwords section).`);
  const password = await askSecret("Application Password");
  if (!password) throw new Error("An Application Password is required.");

  process.stdout.write("Checking credentials… ");
  const me = await new WPClient(api, username, password).me().catch((e) => {
    if (e instanceof WPError && e.status === 401) throw new Error("Authentication failed — check the username and Application Password.");
    throw e;
  });
  console.log(`ok (${me.name})`);

  await storePassword(name, password);
  config.sites[name] = { url, api, username };
  await saveConfig(config);
  console.log(`Added "${name}". Posts will sync to ${siteDir(config, name)}\nRun: omawp sync ${name}`);
}

async function cmdSites() {
  const config = await loadConfig();
  const names = Object.keys(config.sites);
  if (names.length === 0) return console.log("No sites yet. Run: omawp add");
  for (const name of names) {
    const s = config.sites[name]!;
    console.log(`${name.padEnd(20)} ${s.url.padEnd(40)} ${s.username}`);
  }
}

async function cmdRemove(args: string[]) {
  const name = args[0];
  if (!name) throw new Error("Usage: omawp remove <name>");
  const config = await loadConfig();
  if (!config.sites[name]) throw new Error(`Unknown site "${name}".`);
  delete config.sites[name];
  await saveConfig(config);
  await deletePassword(name);
  console.log(`Removed "${name}". Local files in ${siteDir(config, name)} were left in place.`);
}

async function cmdSync(args: string[], flags: { full?: boolean; force?: boolean }) {
  const config = await loadConfig();
  const names = args.length ? args : Object.keys(config.sites);
  if (names.length === 0) return console.log("No sites yet. Run: omawp add");

  let failed = false;
  for (const name of names) {
    console.log(`\n▸ ${name}`);
    try {
      const r = await syncSite(config, name, { ...flags, log: (l) => console.log(`  ${l}`) });
      const renamed = r.renamed ? `, ${r.renamed} renamed` : "";
      console.log(`  ${r.created.length} new, ${r.updated.length} updated${renamed}, ${r.unchanged} unchanged → ${siteDir(config, name)}`);
      for (const s of r.skipped) console.log(`  ⚠ skipped ${s.file}: ${s.reason}`);
      for (const f of r.missingRemote) console.log(`  ⚠ ${f} no longer exists on the site (left in place)`);
    } catch (e) {
      failed = true;
      console.error(`  ✗ ${(e as Error).message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

const color = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = color(31), green = color(32), cyan = color(36), dim = color(2);

function printPlan(plan: PushPlan) {
  console.log(`\n▸ ${plan.site}: ${plan.file} (post ${plan.id})`);
  for (const c of plan.changes) console.log(`  ${c.field}: ${red(c.from || "(empty)")} → ${green(c.to || "(empty)")}`);
  for (const t of plan.newTerms) console.log(`  ${dim(`will create ${t.taxonomy === "tags" ? "tag" : "category"} "${t.name}"`)}`);
  if (plan.contentDiff) {
    console.log("  content:");
    for (const line of plan.contentDiff.trimEnd().split("\n")) {
      const out = `    ${line}`;
      console.log(line.startsWith("+") ? green(out) : line.startsWith("-") ? red(out) : line.startsWith("@@") ? cyan(out) : dim(out));
    }
  }
}

async function cmdPush(
  files: string[],
  flags: { "dry-run"?: boolean; yes?: boolean; force?: boolean; flatten?: boolean; "no-optimize"?: boolean },
) {
  if (files.length === 0) throw new Error("Usage: omawp push <file...>");
  const config = await loadConfig();
  if (!flags.yes && !flags["dry-run"] && !process.stdin.isTTY) {
    throw new Error("Refusing to push without confirmation when not interactive. Use --yes or --dry-run.");
  }
  let failed = false;
  for (const file of files) {
    try {
      const r = await pushFile(config, file, {
        dryRun: flags["dry-run"],
        force: flags.force,
        flatten: flags.flatten,
        optimize: !flags["no-optimize"],
        confirm: async (plan) => {
          printPlan(plan);
          return flags.yes || /^y(es)?$/i.test(await ask("\n  Push these changes?", "y/N"));
        },
      });
      if (r.status === "dry-run") {
        printPlan(r.plan!);
        console.log(dim("\n  (dry run — nothing sent)"));
      } else if (r.status === "no-changes") console.log(`${file}: no changes to push`);
      else if (r.status === "declined") console.log("  Not pushed.");
      else console.log(`  ✓ Pushed. Local file refreshed from WordPress: ${r.file}`);
    } catch (e) {
      failed = true;
      console.error(`✗ ${file}: ${(e as Error).message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function cmdFlatten(files: string[]) {
  if (files.length === 0) throw new Error("Usage: omawp flatten <file...>");
  const config = await loadConfig();
  for (const file of files) {
    const n = await flattenFile(config, file);
    console.log(`${file}: converted ${n} WordPress block${n === 1 ? "" : "s"} to Markdown (flatten: true)`);
  }
}

async function cmdOptimize(files: string[]) {
  if (files.length === 0) throw new Error("Usage: omawp optimize <file...>");
  const config = await loadConfig();
  for (const file of files) {
    const r = await optimizePost(siteDir(config, locate(config, file).site), file, imageSettings(config));
    if (!r) console.log(`${file}: no local featured image to optimize`);
    else if (!r.frontMatter) console.log(`${file}: ${r.file} ${r.result}`);
    else console.log(`${file}: ${r.frontMatter.to} (${r.result})\n  featured_image: ${r.frontMatter.from} → ${r.frontMatter.to}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      url: { type: "string" },
      user: { type: "string" },
      full: { type: "boolean" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      flatten: { type: "boolean" },
      "no-optimize": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;

  switch (command) {
    case "add":
      return cmdAdd(args, values);
    case "sites":
    case "list":
      return cmdSites();
    case "remove":
    case "rm":
      return cmdRemove(args);
    case "sync":
    case "pull":
      // Accept `omawp sync posts` as a synonym for syncing all sites.
      return cmdSync(args[0] === "posts" ? args.slice(1) : args, values);
    case "push":
      return cmdPush(args, values);
    case "flatten":
      return cmdFlatten(args);
    case "optimize":
      return cmdOptimize(args);
    default:
      console.log(HELP);
      if (command && !values.help) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
