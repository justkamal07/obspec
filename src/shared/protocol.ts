/**
 * Obspec — shared protocol between the Figma sandbox (code.ts), the plugin UI,
 * the Obspec Bridge (local vault server) and the preview harness.
 *
 * Everything that crosses a boundary is defined here so the three runtimes
 * can never drift apart.
 */

export const PLUGIN_VERSION = '1.1.0';
export const SUPPORT_EMAIL = 'kr07.work@gmail.com';
export const COMMUNITY_URL = 'https://www.figma.com/community/plugin/1693223473984407174';

// ───────────────────────────── Vault / bridge ─────────────────────────────

export interface VaultInfo {
  name: string;
  path: string;
  notes: number;
  indexedAt: number;
}

export interface HealthResponse {
  ok: true;
  version: string;
  /** null until a vault has been chosen (first run). */
  vault: VaultInfo | null;
  platform: string;
  /** Whether the bridge can open a native folder dialog on this machine. */
  canPick: boolean;
  /** True when the bridge runs as the background service installed by the one-time setup (starts at login). */
  service?: boolean;
}

/** A vault the bridge knows about: from Obsidian's own registry, the saved config, or the current one. */
export interface VaultCandidate {
  name: string;
  path: string;
  source: 'obsidian' | 'config' | 'current';
  /** Obsidian currently has this vault open. */
  open?: boolean;
  lastOpened?: number;
  exists: boolean;
}

export interface VaultsResponse { current: VaultInfo | null; vaults: VaultCandidate[] }
export interface SetVaultRequest { path: string }
export interface SetVaultResponse { ok: true; vault: VaultInfo }
/** path → current hash, or null when the note no longer exists. */
export interface HashesResponse { hashes: Record<string, string | null> }

export interface SearchMatch {
  /** Snippet text with the matched ranges expressed as [start, end) offsets. */
  text: string;
  ranges: Array<[number, number]>;
  /** Line number in the note (1-based) the snippet starts at. */
  line: number;
}

export interface SearchResult {
  path: string;
  title: string;
  folder: string;
  tags: string[];
  mtime: number;
  score: number;
  /** Where the hit came from — drives the small badge in the result row. */
  matchedIn: Array<'title' | 'path' | 'tag' | 'body'>;
  snippets: SearchMatch[];
  /** Vault-relative path of the note's first embedded image, for a row thumbnail. */
  thumbnail?: string;
}

export interface SearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
  tookMs: number;
}

export interface NoteLink {
  path: string;
  title: string;
}

export interface Note {
  path: string;
  title: string;
  folder: string;
  frontmatter: Record<string, unknown>;
  /** Raw markdown including frontmatter. */
  content: string;
  /** Markdown body without frontmatter. */
  body: string;
  tags: string[];
  outlinks: NoteLink[];
  backlinks: NoteLink[];
  mtime: number;
  /** Content hash — used for optimistic concurrency on write. */
  hash: string;
  words: number;
}

export interface WriteNoteRequest {
  path: string;
  content: string;
  /** If given, the write is rejected with 409 when the current hash differs. */
  ifHash?: string;
  /** Create parent folders when missing. Default true. */
  mkdirs?: boolean;
}

export interface PatchNoteRequest {
  path: string;
  /** Shallow-merged into the existing frontmatter. `null` deletes a key. */
  frontmatter?: Record<string, unknown>;
  /** Replaces the markdown under the given H2 heading, creating it if absent. */
  section?: { heading: string; markdown: string };
  ifHash?: string;
}

export interface WriteNoteResponse {
  ok: true;
  note: Note;
  created: boolean;
}

export type VaultEvent =
  | { type: 'hello'; vault: VaultInfo | null }
  | { type: 'vault-changed'; vault: VaultInfo | null }
  | { type: 'changed'; path: string; mtime: number; hash: string }
  | { type: 'created'; path: string; mtime: number; hash: string }
  | { type: 'deleted'; path: string };

export interface BridgeError {
  ok: false;
  error: string;
  code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN' | 'NO_VAULT' | 'CANCELLED' | 'INTERNAL';
}

// ───────────────────────────── Figma link model ───────────────────────────

/** Stored on a node as pluginData under LINK_KEY. */
export interface NoteLinkRecord {
  v: 1;
  path: string;
  /** Hash of the note content the node was last synced to. */
  noteHash: string;
  noteMtime: number;
  /** Hash of the design snapshot the note was last pushed with. */
  designHash?: string;
  /** How the link was created. */
  kind: 'spec-card' | 'linked';
  linkedAt: number;
  syncedAt: number;
}

export const LINK_KEY = 'obspec:link';
export const FILE_KEY = 'obspec:fileKey';
export const PLUGIN_NAMESPACE = 'obspec';

export type SyncState = 'in-sync' | 'note-changed' | 'design-changed' | 'both-changed' | 'missing' | 'unknown';
/** The three states a spec card can show on its own frame. */
export type CardStatus = 'in-sync' | 'note-changed' | 'missing';

export function cardStatusOf(state: SyncState): CardStatus | undefined {
  if (state === 'in-sync' || state === 'design-changed') return 'in-sync';
  if (state === 'note-changed' || state === 'both-changed') return 'note-changed';
  if (state === 'missing') return 'missing';
  return undefined;
}

export interface LinkedNodeSummary {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  pageId: string;
  pageName: string;
  link: NoteLinkRecord;
  /** Current design fingerprint, so the UI can detect design-side drift. */
  designHash: string;
}

export interface NoteListItem { path: string; title: string; mtime: number; tags: string[]; hash: string; thumbnail?: string }

export interface SelectionSummary {
  count: number;
  /** First selected node (the one actions apply to). */
  node?: {
    id: string;
    name: string;
    type: string;
    width?: number;
    height?: number;
    pageName: string;
    link?: NoteLinkRecord;
    /** Hash of the current design snapshot, for sync-state computation. */
    designHash: string;
  };
}

/** Plain-text spec extracted from a design node and pushed into a note. */
export interface DesignSnapshot {
  nodeId: string;
  name: string;
  type: string;
  page: string;
  width: number;
  height: number;
  /** Markdown table rows of key properties. */
  properties: Array<[string, string]>;
  /** Text layers content, in document order (max ~40). */
  texts: string[];
  /** Child layer names (depth 1). */
  children: string[];
  /** Component / instance info when relevant. */
  component?: { name: string; key?: string; variantProps?: Record<string, string> };
  url?: string;
  capturedAt: number;
  hash: string;
}

/** An image embedded in a note, decoded by the UI and placed on the canvas by the sandbox. */
export interface CardImage {
  /** The embed target as written in the note (file name or path). */
  target: string;
  /** PNG bytes, already scaled under Figma's 4096 px limit. */
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Image embeds a note body refers to: `![[name.png|300]]` and `![alt](relative/path.png)`. */
export function imageTargets(body: string, max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => { t = t.trim(); if (t && !seen.has(t.toLowerCase()) && out.length < max) { seen.add(t.toLowerCase()); out.push(t); } };
  for (const m of body.matchAll(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) if (isImageName(m[1])) add(m[1]);
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) if (!/^(https?:|data:)/i.test(m[1]) && isImageName(m[1])) add(m[1]);
  return out;
}

export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name.trim());
}

// ───────────────────────────── Settings ───────────────────────────────────

export interface Settings {
  bridgeUrl: string;
  token: string;
  /** Vault folder where pushed design notes are created. */
  pushFolder: string;
  /** Vault name used for obsidian:// deep links (auto-filled from /health). */
  vaultName: string;
  cardWidth: number;
  /** Remembered plugin window size (set by dragging the corner grip). */
  windowWidth?: number;
  windowHeight?: number;
  /** How search results are laid out. */
  searchView?: SearchView;
  /** 'auto' follows Figma's theme; 'light' / 'dark' override it. */
  theme?: ThemeMode;
}

export type ThemeMode = 'auto' | 'light' | 'dark';

export type SearchView = 'cards' | 'list' | 'compact';

export const DEFAULT_SETTINGS: Settings = {
  bridgeUrl: 'http://localhost:27123',
  token: '',
  pushFolder: 'Figma',
  vaultName: '',
  cardWidth: 400,
};

// ───────────────────────────── UI ⇄ sandbox messages ──────────────────────

export type UiToPlugin =
  | { type: 'ui-ready' }
  | { type: 'get-settings' }
  | { type: 'save-settings'; settings: Settings }
  | { type: 'get-selection' }
  | { type: 'get-linked' }
  | { type: 'insert-spec-card'; note: Note; vaultName: string; width: number; images?: CardImage[]; /** canvas position from a drag-and-drop, else viewport centre */ at?: { x: number; y: number }; /** frame/section under the cursor to drop into */ parentId?: string }
  | { type: 'link-selection'; note: Note }
  | { type: 'unlink'; nodeId: string }
  | { type: 'pull'; nodeId: string; note: Note; vaultName: string; images?: CardImage[] }
  | { type: 'card-status'; nodeId: string; status: CardStatus }
  | { type: 'snapshot'; nodeId: string }
  | { type: 'mark-pushed'; nodeId: string; path: string; note: Note; designHash: string }
  | { type: 'select-node'; nodeId: string; pageId?: string }
  | { type: 'open-url'; url: string }
  | { type: 'notify'; message: string; error?: boolean }
  | { type: 'resize'; width: number; height: number; persist?: boolean }
  | { type: 'close' };

export type PluginToUi =
  | { type: 'init'; settings: Settings; fileKey?: string; fileName: string; editorType: string; command?: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'selection'; selection: SelectionSummary }
  | { type: 'linked'; nodes: LinkedNodeSummary[] }
  | { type: 'snapshot'; snapshot: DesignSnapshot }
  | { type: 'spec-card-inserted'; nodeId: string }
  /** A result dragged from the UI was dropped on the canvas; the UI answers with insert-spec-card. */
  | { type: 'drop'; path: string; x: number; y: number; parentId?: string }
  | { type: 'linked-ok'; nodeId: string }
  | { type: 'pulled'; nodeId: string }
  | { type: 'error'; message: string };

// ───────────────────────────── Helpers shared by all runtimes ─────────────

/** FNV-1a 32-bit hash, hex. Deterministic, dependency-free, fast enough for notes. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** `noteHash`: current hash from the bridge; `null` = note no longer exists; `undefined` = not fetched yet. */
export function computeSyncState(link: NoteLinkRecord | undefined, noteHash: string | null | undefined, designHash: string | undefined): SyncState {
  if (!link) return 'unknown';
  if (noteHash === undefined) return 'unknown';
  if (noteHash === null) return 'missing';
  const noteChanged = noteHash !== link.noteHash;
  const designChanged = !!link.designHash && !!designHash && designHash !== link.designHash;
  if (noteChanged && designChanged) return 'both-changed';
  if (noteChanged) return 'note-changed';
  if (designChanged) return 'design-changed';
  return 'in-sync';
}

export function obsidianSearchUrl(vaultName: string, query: string): string {
  return `obsidian://search?vault=${encodeURIComponent(vaultName)}&query=${encodeURIComponent(query)}`;
}

export function obsidianUrl(vaultName: string, path: string): string {
  const file = path.replace(/\.md$/i, '');
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

export function figmaNodeUrl(fileKey: string | undefined, nodeId: string): string | undefined {
  if (!fileKey) return undefined;
  return `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(nodeId.replace(':', '-'))}`;
}

export function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export function folderFromPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
