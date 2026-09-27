import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, chmod } from "node:fs/promises";
import { parse, stringify } from "smol-toml";

export interface SiteConfig {
  url: string; // site home URL, e.g. https://example.com
  api: string; // REST root, e.g. https://example.com/wp-json/
  username: string;
}

export interface Config {
  contentDir: string;
  sites: Record<string, SiteConfig>;
}

const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
export const CONFIG_PATH = process.env.OMAWP_CONFIG || join(xdgConfig, "omawp", "config.toml");
const DEFAULT_CONTENT_DIR = "~/Documents/WordPress";

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) return { contentDir: DEFAULT_CONTENT_DIR, sites: {} };
  const data = parse(await file.text()) as Partial<Config>;
  return {
    contentDir: data.contentDir ?? DEFAULT_CONTENT_DIR,
    sites: (data.sites ?? {}) as Record<string, SiteConfig>,
  };
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await Bun.write(CONFIG_PATH, stringify(config) + "\n");
  await chmod(CONFIG_PATH, 0o600);
}

export function siteDir(config: Config, name: string): string {
  return join(expandHome(config.contentDir), name);
}
