/**
 * Obspec Bridge — a tiny local HTTP server the Figma plugin talks to.
 *
 * Binds to loopback only. CORS allows the Figma plugin iframe (origin "null"),
 * figma.com and localhost. All responses are JSON; /events is Server-Sent Events.
 * The vault can be chosen or switched at runtime (the plugin's onboarding does
 * this), so the server owns a mutable `vault`.
 */
import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { URL } from 'node:url';
import { IMAGE_EXT, IMAGE_MIME, Vault } from './vault';
import { search } from './search';
import { parseFrontmatter, replaceSection, withFrontmatter } from './markdown';
import { canPickFolder, discoverVaults, looksLikeVault, pickFolder, saveConfig } from './discover';
import { PLUGIN_VERSION } from '../../src/shared/protocol';
import type { BridgeError, HashesResponse, HealthResponse, PatchNoteRequest, SearchResponse, SetVaultRequest, SetVaultResponse, VaultEvent, VaultsResponse, WriteNoteRequest, WriteNoteResponse } from '../../src/shared/protocol';

export const VERSION = PLUGIN_VERSION;

export interface BridgeOptions {
  /** Vault to open at start. Omit to start without one; the plugin's onboarding can pick it. */
  vault?: string;
  port: number;
  host?: string;
  token?: string;
  quiet?: boolean;
  /** Remember vault choices in ~/.obspec/config.json (the CLI does; tests and the preview don't). */
  persist?: boolean;
  /** True when started by the OS service installed by `obspec-bridge setup`; reported in /health. */
  service?: boolean;
}

export interface Bridge { server: http.Server; url: string; readonly vault: Vault | null; useVault(dir: string): Promise<Vault>; close(): Promise<void> }

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.quiet ? () => {} : (...a: unknown[]) => console.log('[obspec]', ...a);
  const sseClients = new Set<http.ServerResponse>();
  const broadcast = (ev: VaultEvent) => { const payload = `event: vault\ndata: ${JSON.stringify(ev)}\n\n`; for (const res of sseClients) res.write(payload); };

  let vault: Vault | null = null;

  async function useVault(dir: string): Promise<Vault> {
    const abs = path.resolve(dir);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isDirectory()) throw Object.assign(new Error(`Not a folder: ${abs}`), { code: 'BAD_REQUEST' });
    const t0 = Date.now();
    const next = new Vault(abs);
    await next.index();
    next.startWatching();
    next.on('event', (ev: VaultEvent) => { broadcast(ev); if ('path' in ev) log(ev.type, ev.path); });
    vault?.stop();
    vault = next;
    if (opts.persist) await saveConfig({ vault: abs }).catch((e) => log('could not save config:', (e as Error).message));
    log(`vault   ${abs} (${next.size} notes, indexed in ${Date.now() - t0} ms)${looksLikeVault(abs) ? '' : '  — no .obsidian folder here, indexing anyway'}`);
    broadcast({ type: 'vault-changed', vault: next.info() });
    return next;
  }

  if (opts.vault) await useVault(opts.vault);

  const requireVault = (): Vault => {
    if (!vault) throw Object.assign(new Error('No vault selected yet — pick one in the plugin'), { code: 'NO_VAULT' });
    return vault;
  };

  const handler: http.RequestListener = async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin && isAllowedOrigin(origin) ? origin : 'null');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (opts.token) {
      const auth = req.headers.authorization ?? '';
      const q = url.searchParams.get('token') ?? '';
      if (auth !== `Bearer ${opts.token}` && q !== opts.token) return fail(res, 'FORBIDDEN', 'Invalid token');
    }

    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /health': {
          const body: HealthResponse = { ok: true, version: VERSION, vault: vault?.info() ?? null, platform: process.platform, canPick: canPickFolder(), service: !!opts.service };
          return json(res, body);
        }
        case 'GET /vaults': {
          const body: VaultsResponse = { current: vault?.info() ?? null, vaults: await discoverVaults(vault?.root) };
          return json(res, body);
        }
        case 'POST /vault': {
          const body = (await readJson(req)) as SetVaultRequest;
          if (!body?.path || typeof body.path !== 'string') return fail(res, 'BAD_REQUEST', 'path is required');
          const v = await useVault(body.path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
          return json(res, { ok: true, vault: v.info() } satisfies SetVaultResponse);
        }
        case 'POST /vault/pick': {
          if (!canPickFolder()) return fail(res, 'BAD_REQUEST', 'No folder dialog available on this machine — paste the path instead');
          const picked = await pickFolder();
          if (!picked) return fail(res, 'CANCELLED', 'No folder chosen');
          const v = await useVault(picked);
          return json(res, { ok: true, vault: v.info() } satisfies SetVaultResponse);
        }
        case 'DELETE /vault': {
          vault?.stop(); vault = null;
          if (opts.persist) await saveConfig({}).catch(() => {});
          broadcast({ type: 'vault-changed', vault: null });
          return json(res, { ok: true });
        }
        case 'GET /search': {
          const v = requireVault();
          const q = url.searchParams.get('q') ?? '';
          const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
          const t = performance.now();
          const { results, total } = search(v.all(), q, limit);
          for (const r of results) { const thumb = v.thumbnailFor(r.path); if (thumb) r.thumbnail = thumb; }
          const body: SearchResponse = { query: q, total, results, tookMs: Math.round((performance.now() - t) * 10) / 10 };
          return json(res, body);
        }
        case 'GET /note': {
          const v = requireVault();
          const p = url.searchParams.get('path') ?? '';
          const n = v.get(p);
          if (!n) return fail(res, 'NOT_FOUND', `No note at ${p}`);
          return json(res, v.toNote(n));
        }
        case 'GET /hashes': {
          const v = requireVault();
          const hashes: HashesResponse['hashes'] = {};
          for (const p of url.searchParams.getAll('path')) hashes[p] = v.hashOf(p);
          return json(res, { hashes } satisfies HashesResponse);
        }
        case 'GET /file': {
          // Images embedded in notes (![[name.png]]). Only image types are served, never other vault files.
          const v = requireVault();
          const hit = v.resolveFile(url.searchParams.get('path') ?? '');
          if (!hit) return fail(res, 'NOT_FOUND', 'No such attachment');
          const ext = path.extname(hit.rel).toLowerCase();
          if (!IMAGE_EXT.has(ext)) return fail(res, 'FORBIDDEN', 'Only images can be fetched');
          const st = await fs.stat(hit.abs).catch(() => null);
          if (!st?.isFile()) return fail(res, 'NOT_FOUND', 'No such attachment');
          const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
          if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
          res.writeHead(200, { 'Content-Type': IMAGE_MIME[ext], 'Content-Length': st.size, ETag: etag, 'Cache-Control': 'private, max-age=60', 'X-Vault-Path': encodeURI(hit.rel) });
          createReadStream(hit.abs).pipe(res);
          return;
        }
        case 'GET /notes': {
          const v = requireVault();
          return json(res, { notes: v.listRecent(clampInt(url.searchParams.get('limit'), 1, 5000, 200)) });
        }
        case 'PUT /note': {
          const v = requireVault();
          const body = (await readJson(req)) as WriteNoteRequest;
          if (!body?.path || typeof body.content !== 'string') return fail(res, 'BAD_REQUEST', 'path and content are required');
          if (!body.path.endsWith('.md')) return fail(res, 'BAD_REQUEST', 'path must end with .md');
          const { note, created } = await v.write(body.path, body.content, { ifHash: body.ifHash, mkdirs: body.mkdirs });
          return json(res, { ok: true, note, created } satisfies WriteNoteResponse, created ? 201 : 200);
        }
        case 'PATCH /note': {
          const v = requireVault();
          const body = (await readJson(req)) as PatchNoteRequest;
          if (!body?.path) return fail(res, 'BAD_REQUEST', 'path is required');
          const existing = v.get(body.path);
          if (!existing) return fail(res, 'NOT_FOUND', `No note at ${body.path}`);
          let content = existing.content;
          if (body.frontmatter) {
            const { frontmatter } = parseFrontmatter(content);
            const merged: Record<string, unknown> = { ...frontmatter };
            for (const [k, val] of Object.entries(body.frontmatter)) { if (val === null) delete merged[k]; else merged[k] = val; }
            content = withFrontmatter(content, merged);
          }
          if (body.section) {
            const { frontmatter, body: md } = parseFrontmatter(content);
            content = withFrontmatter('', frontmatter) + replaceSection(md, body.section.heading, body.section.markdown);
          }
          const { note } = await v.write(body.path, content, { ifHash: body.ifHash });
          return json(res, { ok: true, note, created: false } satisfies WriteNoteResponse);
        }
        case 'GET /events': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write(`event: vault\ndata: ${JSON.stringify({ type: 'hello', vault: vault?.info() ?? null } satisfies VaultEvent)}\n\n`);
          sseClients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
          req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
          return;
        }
        default:
          return fail(res, 'NOT_FOUND', `No route ${req.method} ${url.pathname}`);
      }
    } catch (err) {
      const e = err as Error & { code?: BridgeError['code'] };
      const code = e.code && CODES.includes(e.code) ? e.code : 'INTERNAL';
      if (code === 'INTERNAL') console.error('[obspec] error', err);
      return fail(res, code, e.message);
    }
  };

  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  // "localhost" may resolve to ::1 first; serve that loopback too when running on the default host.
  const extra: http.Server[] = [];
  if (!opts.host) {
    const v6 = http.createServer(handler);
    await new Promise<void>((resolve) => {
      v6.once('error', () => resolve());
      v6.listen(port, '::1', () => { extra.push(v6); resolve(); });
    });
  }
  const url = `http://${host}:${port}`;
  log(`Obspec Bridge v${VERSION}`);
  if (!vault) log('vault   none yet — open the Obspec plugin in Figma and pick one');
  log(`listen  ${url}${extra.length ? ' and [::1]' : ''}${opts.token ? '  (token required)' : ''}`);
  return {
    server, url,
    get vault() { return vault; },
    useVault,
    close: () => new Promise<void>((r) => { for (const c of sseClients) c.end(); vault?.stop(); for (const e of extra) e.close(); server.close(() => r()); }),
  };
}

const CODES: BridgeError['code'][] = ['NOT_FOUND', 'CONFLICT', 'BAD_REQUEST', 'FORBIDDEN', 'NO_VAULT', 'CANCELLED', 'INTERNAL'];
const STATUS: Record<BridgeError['code'], number> = { NOT_FOUND: 404, CONFLICT: 409, BAD_REQUEST: 400, FORBIDDEN: 403, NO_VAULT: 412, CANCELLED: 499, INTERNAL: 500 };

function isAllowedOrigin(origin: string): boolean {
  return origin === 'null' || /^https:\/\/([a-z0-9-]+\.)?figma\.com$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function fail(res: http.ServerResponse, code: BridgeError['code'], error: string): void {
  json(res, { ok: false, error, code } satisfies BridgeError, STATUS[code]);
}

function clampInt(v: string | null, min: number, max: number, dflt: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 5_000_000) throw Object.assign(new Error('Body too large'), { code: 'BAD_REQUEST' });
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Invalid JSON body'), { code: 'BAD_REQUEST' }); }
}
