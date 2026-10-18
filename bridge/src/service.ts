/**
 * One-time setup: install the bridge as a background service that starts when you log in,
 * so nobody has to keep a Terminal window open.
 *
 *   macOS    → ~/Library/LaunchAgents/com.obspec.bridge.plist (launchd, KeepAlive on failure)
 *   Linux    → ~/.config/systemd/user/obspec-bridge.service   (systemd --user)
 *   Windows  → Startup folder .vbs that runs node hidden
 *
 * The bundled CLI is copied to ~/.obspec/bridge/ first, so the service keeps working after
 * the npx cache is cleared or the clone is moved.
 */
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOME = os.homedir();
export const SERVICE_DIR = path.join(HOME, '.obspec');
export const SERVICE_BIN = path.join(SERVICE_DIR, 'bridge', 'obspec-bridge.mjs');
export const SERVICE_LOG = path.join(SERVICE_DIR, 'bridge.log');
export const LAUNCHD_LABEL = 'com.obspec.bridge';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const UNIT = path.join(HOME, '.config', 'systemd', 'user', 'obspec-bridge.service');
const STARTUP = path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Obspec Bridge.vbs');

export type ServiceKind = 'launchd' | 'systemd' | 'startup-folder';

export function serviceKind(): ServiceKind | null {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  if (process.platform === 'win32') return 'startup-folder';
  return null;
}

/** Where the service definition lives on this platform. */
export function serviceFile(): string {
  return process.platform === 'darwin' ? PLIST : process.platform === 'win32' ? STARTUP : UNIT;
}

export function serviceInstalled(): boolean { return existsSync(serviceFile()) && existsSync(SERVICE_BIN); }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** launchd agent: start at login, restart if it crashes, log to ~/.obspec/bridge.log. */
export function renderPlist(node: string, bin: string, port: number, log = SERVICE_LOG): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(bin)}</string>
    <string>run</string>
    <string>--service</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
`;
}

export function renderUnit(node: string, bin: string, port: number): string {
  return `[Unit]
Description=Obspec Bridge (Obsidian ↔ Figma)
After=default.target

[Service]
ExecStart=${node} ${bin} run --service --port ${port}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export function renderVbs(node: string, bin: string, port: number): string {
  const q = (s: string) => `""${s.replace(/"/g, '""')}""`;
  return `' Obspec Bridge — starts the local Obsidian ↔ Figma bridge hidden at login.\r\nCreateObject("WScript.Shell").Run "${q(node)} ${q(bin)} run --service --port ${port}", 0, False\r\n`;
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })));
}

async function health(port: number): Promise<{ version: string; vault: { name: string } | null } | null> {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); if (!r.ok) return null; return (await r.json()) as { version: string; vault: { name: string } | null }; } catch { return null; }
}

/** Polls /health until the service answers (or the deadline passes). */
export async function waitForBridge(port: number, ms = 12000): Promise<{ version: string; vault: { name: string } | null } | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const h = await health(port); if (h) return h; await new Promise((r) => setTimeout(r, 400)); }
  return null;
}

export interface InstallResult { kind: ServiceKind; file: string; bin: string; node: string }

/**
 * Copies the running CLI bundle to ~/.obspec/bridge and registers it with the OS. Idempotent: running it
 * again upgrades the copy and restarts the service.
 */
export async function installService(selfPath: string, port: number): Promise<InstallResult> {
  const kind = serviceKind();
  if (!kind) throw new Error(`Background service is not supported on ${process.platform}. Run \`obspec-bridge run\` instead.`);
  const node = process.execPath;
  await fs.mkdir(path.dirname(SERVICE_BIN), { recursive: true });
  await fs.copyFile(selfPath, SERVICE_BIN);
  const file = serviceFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (kind === 'launchd') {
    await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
    await fs.writeFile(file, renderPlist(node, SERVICE_BIN, port), 'utf8');
    const boot = await run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, file]);
    if (!boot.ok) { const legacy = await run('launchctl', ['load', '-w', file]); if (!legacy.ok) throw new Error(`launchctl could not load the agent: ${boot.out || legacy.out}`); }
  } else if (kind === 'systemd') {
    await fs.writeFile(file, renderUnit(node, SERVICE_BIN, port), 'utf8');
    await run('systemctl', ['--user', 'daemon-reload']);
    const en = await run('systemctl', ['--user', 'enable', '--now', 'obspec-bridge.service']);
    if (!en.ok) throw new Error(`systemctl could not enable the service: ${en.out}`);
    await run('systemctl', ['--user', 'restart', 'obspec-bridge.service']);
  } else {
    await fs.writeFile(file, renderVbs(node, SERVICE_BIN, port), 'utf8');
    await run('wscript', [file]);
  }
  return { kind, file, bin: SERVICE_BIN, node };
}

export async function uninstallService(): Promise<{ removed: boolean; file: string }> {
  const kind = serviceKind();
  const file = serviceFile();
  if (!kind) return { removed: false, file };
  if (kind === 'launchd') await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
  else if (kind === 'systemd') await run('systemctl', ['--user', 'disable', '--now', 'obspec-bridge.service']);
  const removed = existsSync(file);
  await fs.rm(file, { force: true });
  await fs.rm(path.dirname(SERVICE_BIN), { recursive: true, force: true });
  return { removed, file };
}
