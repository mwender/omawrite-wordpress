// Application Passwords live in the system keyring (libsecret via `secret-tool`),
// never in the config file. OMAWP_APP_PASSWORD_<SITE> overrides for CI/scripting.

function envKey(site: string): string {
  return "OMAWP_APP_PASSWORD_" + site.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export async function storePassword(site: string, password: string): Promise<void> {
  const proc = Bun.spawn(
    ["secret-tool", "store", "--label", `omawp: ${site}`, "service", "omawp", "site", site],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
  proc.stdin.write(password);
  proc.stdin.end();
  if ((await proc.exited) !== 0) {
    throw new Error(`secret-tool store failed: ${await new Response(proc.stderr).text()}`);
  }
}

export async function getPassword(site: string): Promise<string> {
  const fromEnv = process.env[envKey(site)];
  if (fromEnv) return fromEnv;
  const proc = Bun.spawn(["secret-tool", "lookup", "service", "omawp", "site", site], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) {
    throw new Error(`No Application Password found for "${site}". Run \`omawp add ${site}\` or set ${envKey(site)}.`);
  }
  return out;
}

export async function deletePassword(site: string): Promise<void> {
  await Bun.spawn(["secret-tool", "clear", "service", "omawp", "site", site]).exited;
}
