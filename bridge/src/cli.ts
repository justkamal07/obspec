/**
 * Obspec Bridge CLI.
 *
 *   obspec-bridge                      → one-time setup: installs the bridge as a background service that starts at login
 *   obspec-bridge run                  → run in this terminal instead (remembers your last vault, else the one Obsidian has open)
 *   obspec-bridge run --vault ~/Notes  → a specific vault
 *   obspec-bridge status | uninstall
 */
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startBridge, VERSION, type BridgeOptions } from './server';
import { defaultVault, saveConfig } from './discover';
import { installService, uninstallService, serviceInstalled, serviceKind, serviceFile, waitForBridge, SERVICE_LOG } from './service';

type Command = 'setup' | 'run' | 'status' | 'uninstall';
interface Cli extends BridgeOptions { auto: boolean; command: Command; service: boolean }

function parseArgs(argv: string[]): Cli {
  const o: Cli = { vault: process.env.OBSPEC_VAULT || undefined, port: Number(process.env.OBSPEC_PORT ?? 27123), token: process.env.OBSPEC_TOKEN, persist: true, auto: true, command: 'setup', service: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'setup' || a === 'install') o.command = 'setup';
    else if (a === 'run' || a === 'start' || a === '--foreground' || a === '-f') o.command = 'run';
    else if (a === 'status') o.command = 'status';
    else if (a === 'uninstall' || a === 'remove') o.command = 'uninstall';
    else if (a === '--service') { o.command = 'run'; o.service = true; o.quiet = true; }
    else if (a === '--vault' || a === '-v') o.vault = argv[++i];
    else if (a === '--port' || a === '-p') o.port = Number(argv[++i]);
    else if (a === '--token' || a === '-t') o.token = argv[++i];
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--no-remember') o.persist = false;
    else if (a === '--no-auto') o.auto = false;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--version') { console.log(VERSION); process.exit(0); }
    else if (!a.startsWith('-') && !o.vault) o.vault = a;
  }
  if (o.vault) o.vault = o.vault.replace(/^~(?=$|\/)/, os.homedir());
  // A non-default port or a token means a custom, foreground run (the Figma manifest only allows 27123 anyway).
  if (o.command === 'setup' && (o.token || !serviceKind())) o.command = 'run';
  return o;
}

function printHelp(): void {
  console.log(`Obspec Bridge v${VERSION}

usage: obspec-bridge [setup|run|status|uninstall] [--vault <path>] [--port 27123] [--token <secret>]

  setup          (default) One-time setup: installs the bridge as a background service that
                 starts when you log in, then starts it. Run it again any time to upgrade.
  run            Run the bridge in this terminal instead (Ctrl-C stops it).
  status         Is the service installed, and is a bridge answering?
  uninstall      Remove the background service.

  --vault, -v    Path to your Obsidian vault. Without it, Obspec reuses the vault you last
                 picked, else the vault Obsidian currently has open. You can also pick one
                 from the plugin's onboarding screen in Figma.
  --port,  -p    Port to listen on (default 27123 — the port the Figma manifest allows)
  --token, -t    Optional shared secret; the plugin sends it as a Bearer token (foreground only)
  --no-remember  Don't save the vault choice to ~/.obspec/config.json
  --no-auto      Don't guess a vault; wait for the plugin to pick one
  --quiet, -q    Don't log vault events`);
}

const tilde = (p: string) => p.replace(os.homedir(), '~');
const SETUP_CMD = 'npx github:Kamal007OLica/obspec';

async function setup(opts: Cli): Promise<void> {
  const kindName = { launchd: 'launchd (starts when you log in)', systemd: 'systemd --user (starts when you log in)', 'startup-folder': 'your Startup folder (starts when you log in)' };
  console.log(`Obspec Bridge v${VERSION} — one-time setup`);
  if (opts.vault) { await saveConfig({ vault: opts.vault }); console.log(`  ✓ Vault remembered: ${tilde(opts.vault)}`); }
  const already = await waitForBridge(opts.port, 1200);
  const r = await installService(fileURLToPath(import.meta.url), opts.port);
  console.log(`  ✓ Installed to ${tilde(r.bin)}`);
  console.log(`  ✓ Registered with ${kindName[r.kind]}`);
  const h = await waitForBridge(opts.port, 15000);
  if (h) {
    console.log(`  ✓ Running at http://localhost:${opts.port}${h.vault ? ` · vault: ${h.vault.name}` : ' · no vault yet (pick one in Figma)'}${already ? '  (replaced the bridge that was already running)' : ''}`);
    console.log(`\nDone. You can close this window — the bridge keeps running in the background and\ncomes back on its own after a restart. Go back to Figma and pick your vault.\n\nLog: ${tilde(SERVICE_LOG)} · remove later with: ${SETUP_CMD} uninstall`);
  } else {
    console.log(`  ✗ The service was registered but nothing answers on port ${opts.port} yet.\n    Check ${tilde(SERVICE_LOG)}, or run \`${SETUP_CMD} run\` to see the error in this window.`);
    process.exitCode = 1;
  }
}

async function status(opts: Cli): Promise<void> {
  const h = await waitForBridge(opts.port, 1200);
  console.log(`Obspec Bridge v${VERSION}`);
  console.log(`  service   ${serviceInstalled() ? `installed (${tilde(serviceFile())})` : 'not installed — run the setup once: ' + SETUP_CMD}`);
  console.log(`  bridge    ${h ? `answering on http://localhost:${opts.port} (v${h.version}${h.vault ? `, vault: ${h.vault.name}` : ', no vault yet'})` : `nothing on port ${opts.port}`}`);
}

async function runBridge(opts: Cli): Promise<void> {
  if (opts.service) {
    // Started by the OS. If another bridge (say, a foreground `run`) already owns the port, bow out quietly
    // with a clean exit so launchd/systemd don't keep restarting us.
    const other = await waitForBridge(opts.port, 800);
    if (other) { console.log(`[obspec] another bridge (v${other.version}) is already answering on ${opts.port}; this service instance exits.`); process.exit(0); }
    opts.quiet = false;
  }
  if (!opts.vault && opts.auto) opts.vault = await defaultVault();
  await startBridge(opts);
}

const opts = parseArgs(process.argv.slice(2));
(async () => {
  if (opts.command === 'setup') await setup(opts);
  else if (opts.command === 'status') await status(opts);
  else if (opts.command === 'uninstall') { const r = await uninstallService(); console.log(r.removed ? `Removed the Obspec Bridge service (${tilde(r.file)}). ~/.obspec/config.json (your vault choice) was kept.` : 'No Obspec Bridge service was installed.'); }
  else await runBridge(opts);
})().catch((err) => { console.error('[obspec] failed:', err.message); process.exit(1); });
