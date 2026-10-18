/**
 * Obspec plugin UI. Vanilla TS, one state object, string-rendered views with
 * event delegation. Network lives here; document access lives in code.ts.
 */
import './app.css';
import { BridgeClient, BridgeClientError } from './bridge';
import { icons, nodeIcon } from './icons';
import { esc, highlight, highlightTerms, renderMarkdown } from './markdown';
import { DESIGN_HEADING, joinVaultPath, newNoteContent, pushFrontmatter, relativeTime, safeFileName, snapshotToMarkdown, toSpecMarkdown } from '../shared/notegen';
import {
  cardStatusOf, computeSyncState, DEFAULT_SETTINGS, imageTargets, isImageName, obsidianSearchUrl, obsidianUrl, PLUGIN_VERSION, SUPPORT_EMAIL, COMMUNITY_URL,
  type CardImage, type CardStatus, type DesignSnapshot, type HealthResponse, type LinkedNodeSummary, type Note, type NoteListItem, type PluginToUi, type SearchResult, type SearchView, type SelectionSummary, type Settings, type SyncState, type ThemeMode, type UiToPlugin, type VaultCandidate, type VaultEvent, type VaultInfo,
} from '../shared/protocol';

type Tab = 'search' | 'selection' | 'linked' | 'settings';

interface Toast { id: number; text: string; kind: 'info' | 'error' | 'success' }

interface State {
  settings: Settings; fileKey?: string; fileName: string; editorType: string;
  online: boolean; vault?: VaultInfo; health?: HealthResponse; healthError?: string;
  /** onboarding */ vaults: VaultCandidate[]; vaultsLoading: boolean; switchingTo?: string; picking: boolean; choosingVault: boolean;
  tab: Tab;
  query: string; results: SearchResult[]; total: number; tookMs: number; searching: boolean; active: number; recent: NoteListItem[];
  pickFor?: { nodeId: string; name: string };
  note?: Note; noteLoading: boolean; noteUpdatedAt?: number;
  selection: SelectionSummary; selectionNoteHash?: string | null; // null = missing
  linked: LinkedNodeSummary[]; noteHashes: Map<string, string | undefined>;
  busy: Set<string>; toasts: Toast[];
}

const state: State = {
  settings: { ...DEFAULT_SETTINGS }, fileName: '', editorType: 'figma',
  online: false, tab: 'search', vaults: [], vaultsLoading: false, picking: false, choosingVault: false,
  query: '', results: [], total: 0, tookMs: 0, searching: false, active: 0, recent: [],
  noteLoading: false,
  selection: { count: 0 }, linked: [], noteHashes: new Map(),
  busy: new Set(), toasts: [],
};

const bridge = new BridgeClient(DEFAULT_SETTINGS.bridgeUrl);
const send = (m: UiToPlugin) => parent.postMessage({ pluginMessage: m }, '*');

// ───────────────────────────── DOM scaffold ───────────────────────────────
const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="top" id="top"></header>
  <main class="view">
    <section id="view-search" class="view" hidden>
      <div class="searchbar">
        <div class="field">${icons.search}<input id="q" type="search" placeholder="Search your vault…" autocomplete="off" spellcheck="false" aria-label="Search notes" /><span class="kbd">↑↓ ⏎</span></div>
        <div class="hints" id="hints"></div>
      </div>
      <div id="pickbar"></div>
      <div class="scroll" id="search-results" role="listbox"></div>
    </section>
    <section id="view-note" class="view" hidden></section>
    <section id="view-selection" class="view" hidden></section>
    <section id="view-linked" class="view" hidden></section>
    <section id="view-settings" class="view" hidden></section>
  </main>
  <div class="toasts" id="toasts" aria-live="polite"></div>
  <div class="grip" id="grip" title="Drag to resize" aria-hidden="true"></div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLInputElement>('q');

// ───────────────────────────── Render ─────────────────────────────────────
function render(): void {
  renderTop();
  const showNote = state.tab === 'search' && (state.note || state.noteLoading);
  $('view-search').hidden = state.tab !== 'search' || !!showNote;
  $('view-note').hidden = !showNote;
  $('view-selection').hidden = state.tab !== 'selection';
  $('view-linked').hidden = state.tab !== 'linked';
  $('view-settings').hidden = state.tab !== 'settings';
  if (state.tab === 'search') { showNote ? renderNote() : renderSearch(); }
  if (state.tab === 'selection') renderSelection();
  if (state.tab === 'linked') renderLinked();
  renderToasts();
}

function renderTop(): void {
  const conn = !state.online ? 'off' : state.vault ? 'on' : 'busy';
  const label = !state.online ? 'Bridge offline' : state.vault ? state.vault.name : 'Pick a vault';
  const tabs: Array<[Tab, string, number?]> = [['search', 'Search'], ['selection', 'Selection'], ['linked', 'Linked', state.linked.length]];
  $('top').innerHTML = `
    <div class="brand">${icons.logo}<span class="wordmark">Obspec</span><span class="ver">v${PLUGIN_VERSION.replace(/\.0$/, '')}</span>
      <button class="conn ${conn}" data-act="tab" data-arg="settings" title="${esc(state.online ? state.vault?.path ?? 'No vault chosen yet' : state.healthError ?? 'Start the Obspec Bridge')}"><i class="dot"></i><span>${esc(label)}</span></button>
      <button class="icon-btn" data-act="report-bug" aria-label="Report a bug" title="Report a bug">${icons.bug}</button>
      <button class="icon-btn" data-act="toggle-theme" aria-label="${isDark() ? 'Switch to light theme' : 'Switch to dark theme'}" title="${isDark() ? 'Switch to light theme' : 'Switch to dark theme'}${(state.settings.theme ?? 'auto') === 'auto' ? ' (currently following Figma)' : ''}">${isDark() ? icons.sun : icons.moon}</button>
      <button class="icon-btn" data-act="tab" data-arg="settings" aria-label="Settings" title="Settings">${icons.gear}</button>
    </div>
    <nav class="tabs" role="tablist">${tabs.map(([t, l, n]) => `<button class="tab" role="tab" aria-selected="${state.tab === t}" data-act="tab" data-arg="${t}">${l}${n ? `<span class="badge">${n}</span>` : ''}</button>`).join('')}</nav>`;
}

function renderSearch(): void {
  if (input.value !== state.query) input.value = state.query;
  const view = currentView();
  $('hints').innerHTML = ['tag:', 'path:', '"phrase"', '-exclude'].map((h) => `<button class="hint${state.query.includes(h.replace(/"phrase"/, '"')) ? ' active' : ''}" data-act="hint" data-arg="${esc(h)}" title="Add ${esc(h)} to your query">${esc(h)}</button>`).join('')
    + `<span class="views" role="radiogroup" aria-label="Result layout">${([['cards', icons.grid, 'Cards'], ['list', icons.list, 'List with thumbnails'], ['compact', icons.rows, 'Compact list']] as Array<[SearchView, string, string]>).map(([v, ic, label]) => `<button class="view${view === v ? ' on' : ''}" role="radio" aria-checked="${view === v}" data-act="view" data-arg="${v}" title="${label}">${ic}</button>`).join('')}</span>`;
  $('pickbar').innerHTML = state.pickFor ? `<div class="card" style="margin-top:0"><div class="card-head"><span class="ty">${icons.link}</span><div class="grow"><div class="name">Pick a note to link</div><div class="sub">${esc(state.pickFor.name)}</div></div><button class="icon-btn" data-act="cancel-pick" aria-label="Cancel">${icons.close}</button></div></div>` : '';

  const box = $('search-results');
  const onboarding = !state.online || !state.vault || state.choosingVault;
  (document.querySelector('.searchbar') as HTMLElement).hidden = onboarding;
  if (onboarding) { box.innerHTML = renderOnboarding(); return; }
  if (!state.query.trim()) {
    box.innerHTML = state.recent.length
      ? `<div class="section-label">Recently edited</div><ul class="results ${view}">${state.recent.map((n, i) => resultRow({ path: n.path, title: n.title, folder: n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '', tags: n.tags, mtime: n.mtime, score: 0, matchedIn: [], snippets: [], thumbnail: n.thumbnail }, i, [])).join('')}</ul>`
      : emptyState(icons.empty, 'Your vault is empty', 'Create a note in Obsidian and it shows up here instantly.');
    return;
  }
  if (state.searching && !state.results.length) { box.innerHTML = `<div class="skeleton"><div style="width:60%"></div><div style="width:90%"></div><div style="width:40%"></div><div style="width:75%"></div></div>`; return; }
  if (!state.results.length) { box.innerHTML = emptyState(icons.empty, `Nothing for “${esc(state.query)}”`, 'Try fewer words, or filter with tag: and path:.'); return; }
  const terms = state.query.toLowerCase().match(/"([^"]+)"|(\S+)/g)?.map((t) => t.replace(/"/g, '')) ?? [];
  box.innerHTML = `<div class="section-label">Results<span class="count">${state.total} note${state.total === 1 ? '' : 's'} · ${state.tookMs} ms</span><button class="link-btn" data-act="search-obsidian" title="Run this search in Obsidian so the matches light up in your vault">${icons.external} in Obsidian</button></div>
    <ul class="results ${view}">${state.results.map((r, i) => resultRow(r, i, terms)).join('')}</ul>
    <p class="tip">${icons.select} Drag any result onto the canvas to drop it there as a spec card.</p>`;
  box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function currentView(): SearchView { return state.settings.searchView ?? 'list'; }

function resultRow(r: SearchResult, i: number, terms: string[]): string {
  const linkedCount = state.linked.filter((l) => l.link.path === r.path).length;
  const snip = r.snippets[0];
  const view = currentView();
  const thumb = r.thumbnail && state.online ? bridge.fileUrl(r.thumbnail) : undefined;
  if (view === 'compact') {
    return `<li><button class="result compact" role="option" draggable="true" aria-selected="${i === state.active}" data-act="open" data-arg="${esc(r.path)}" data-i="${i}">
      <span class="r-title">${highlightTerms(r.title, terms)}</span>
      <span class="r-path">${esc(r.folder || '/')}</span>
      ${linkedCount ? `<span class="chip linked">${icons.link} ${linkedCount}</span>` : ''}
      <span class="where">${r.matchedIn.length ? r.matchedIn[0] : relativeTime(r.mtime)}</span>
    </button></li>`;
  }
  if (view === 'cards') {
    return `<li><button class="result rcard" role="option" draggable="true" aria-selected="${i === state.active}" data-act="open" data-arg="${esc(r.path)}" data-i="${i}">
      <div class="rc-media">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async">` : `<div class="rc-text">${snip ? highlight(snip.text, snip.ranges) : esc(r.folder || '/')}</div>`}${linkedCount ? `<span class="chip linked rc-badge">${icons.link} ${linkedCount}</span>` : ''}</div>
      <div class="rc-body">
        <div class="r-title">${highlightTerms(r.title, terms)}</div>
        <div class="rc-sub">${esc(r.folder || '/')} · ${relativeTime(r.mtime)}</div>
        ${thumb && snip ? `<div class="r-snip">${highlight(snip.text, snip.ranges)}</div>` : ''}
        ${r.tags.length ? `<div class="r-foot">${r.tags.slice(0, 3).map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    </button></li>`;
  }
  return `<li><button class="result" role="option" draggable="true" aria-selected="${i === state.active}" data-act="open" data-arg="${esc(r.path)}" data-i="${i}">
    <div class="r-main">
      <div class="r-head"><span class="r-title">${highlightTerms(r.title, terms)}</span><span class="r-path">${esc(r.folder || '/')}</span></div>
      ${snip ? `<div class="r-snip">${snip.ranges.length ? `<span class="ln">L${snip.line}</span>` : ''}${highlight(snip.text, snip.ranges)}</div>` : ''}
      <div class="r-foot">${r.tags.slice(0, 4).map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}${linkedCount ? `<span class="chip linked">${icons.link} ${linkedCount} on canvas</span>` : ''}${r.matchedIn.length ? `<span class="where">${r.matchedIn.join(' · ')}</span>` : `<span class="where">${relativeTime(r.mtime)}</span>`}</div>
    </div>
    ${thumb ? `<img class="r-thumb" src="${esc(thumb)}" alt="" loading="lazy" decoding="async">` : ''}
  </button></li>`;
}

const BRIDGE_CMD = 'npx github:Kamal007OLica/obspec';

/** First-run flow: 1) start the local bridge, 2) pick the vault. Shown until both are true. */
function renderOnboarding(): string {
  const step1Done = state.online;
  const h = state.health;
  const vaults = state.vaults;
  const step2 = !step1Done ? `<p class="muted">Then choose which Obsidian vault to search.</p>` : `
    ${state.vaultsLoading ? `<div class="skeleton" style="padding:0"><div style="width:70%"></div><div style="width:50%"></div></div>` : ''}
    ${vaults.length ? `<p class="muted">Vaults Obsidian knows about on this computer:</p>
    <ul class="vaults">${vaults.map((v) => `<li><button class="vault${v.exists ? '' : ' gone'}${state.vault?.path === v.path ? ' current' : ''}" data-act="use-vault" data-arg="${esc(v.path)}" ${!v.exists || state.switchingTo ? 'disabled' : ''}>
        <span class="vicon">${icons.note}</span>
        <span class="vmain"><span class="vname">${esc(v.name)}</span><span class="vpath">${esc(v.path)}</span></span>
        ${state.switchingTo === v.path ? '<i class="spin"></i>' : v.open ? '<span class="chip">open in Obsidian</span>' : state.vault?.path === v.path ? `<span class="chip linked">${icons.check} current</span>` : !v.exists ? '<span class="chip neutral">not found</span>' : ''}
      </button></li>`).join('')}</ul>` : `<p class="muted">Obsidian hasn’t registered any vaults on this computer yet.</p>`}
    <div class="vault-alt">
      ${h?.canPick ? `<button class="btn secondary" data-act="browse-vault" ${state.picking || state.switchingTo ? 'disabled' : ''}>${state.picking ? '<i class="spin"></i> Choose the folder in the dialog…' : `${icons.frame} Browse for a folder…`}</button>` : ''}
      <form class="vault-manual" id="vault-manual"><input name="path" placeholder="…or paste a folder path" aria-label="Vault folder path" /><button class="btn primary sm" type="submit" ${state.switchingTo ? 'disabled' : ''}>Use</button></form>
    </div>
    ${state.choosingVault && state.vault ? `<button class="btn ghost sm" data-act="cancel-choose">Keep ${esc(state.vault.name)}</button>` : ''}`;
  return `<div class="onb">
    <div class="onb-hero">${icons.logo}<div><h3>Connect your vault</h3><p>A one-time setup, two steps. Everything stays on this computer.</p></div></div>
    <ol class="steps">
      <li class="step${step1Done ? ' done' : ' active'}"><span class="n">${step1Done ? icons.check : '1'}</span><div class="step-body">
        <b>Set up the bridge (once)</b>
        ${step1Done ? `<p class="muted">Connected · Obspec Bridge v${esc(h?.version ?? '')}${h?.service ? ' · runs in the background and starts when you log in' : ''}</p>` : `
        <p class="muted">A tiny helper on your computer reads your notes for Figma. Open Terminal, paste this once and press return. It installs the helper and starts it in the background, now and every time you log in, so you never do this again:</p>
        <div class="cmd"><code>${esc(BRIDGE_CMD)}</code><button class="btn ghost sm" data-act="copy-cmd" title="Copy">Copy</button></div>
        <p class="muted">Needs Node.js 18+ (nodejs.org). Have the Obspec folder? Double-click <b>Obspec Bridge.command</b> instead. You can close the Terminal window when it says Done.</p>
        <p class="waiting"><i class="spin"></i> Waiting for the bridge… <button class="link-btn" data-act="retry">retry now</button></p>
        ${state.healthError ? `<p class="muted" style="color:var(--danger)">${esc(state.healthError)}</p>` : ''}`}
      </div></li>
      <li class="step${step1Done ? (state.vault && !state.choosingVault ? ' done' : ' active') : ''}"><span class="n">2</span><div class="step-body">
        <b>Pick your vault</b>
        ${step2}
      </div></li>
    </ol>
  </div>`;
}

function emptyState(icon: string, title: string, text: string, action = ''): string {
  return `<div class="empty"><div class="art">${icon}</div><h4>${title}</h4><p>${text}</p>${action}</div>`;
}

function renderNote(): void {
  const v = $('view-note');
  const n = state.note;
  if (!n) { v.innerHTML = `<div class="note-head"><button class="back" data-act="back">${icons.back} Back</button></div><div class="skeleton"><div style="width:50%;height:14px"></div><div style="width:95%"></div><div style="width:85%"></div><div style="width:70%"></div></div>`; return; }
  const linkedHere = state.linked.filter((l) => l.link.path === n.path);
  const known = new Set<string>();
  for (const o of n.outlinks) known.add(o.title.toLowerCase());
  const resolves = (t: string) => known.has(t.toLowerCase()) || n.outlinks.some((o) => o.path.toLowerCase() === (t.endsWith('.md') ? t : t + '.md').toLowerCase());
  const resolveImage = (t: string) => (state.online && isImageName(t) ? bridge.fileUrl(t) : undefined);
  const canLink = state.selection.count === 1;
  v.innerHTML = `
    <div class="note-head"><button class="back" data-act="back">${icons.back} Back</button><span class="crumb">${esc(n.folder || 'Vault root')}</span>
      <button class="icon-btn" data-act="open-obsidian" data-arg="${esc(n.path)}" title="Open in Obsidian" aria-label="Open in Obsidian">${icons.external}</button></div>
    <div class="scroll">
      <h2 class="note-title">${esc(n.title)}</h2>
      <div class="note-meta">${n.tags.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}${n.tags.length ? '<span class="sep">·</span>' : ''}<span>${n.words} words</span><span class="sep">·</span><span title="${new Date(n.mtime).toLocaleString()}">edited ${relativeTime(n.mtime)}</span>${state.noteUpdatedAt ? `<span class="sep">·</span><span style="color:var(--success)">updated live</span>` : ''}
        ${linkedHere.length ? `<span class="sep">·</span><button class="chip linked" data-act="tab" data-arg="linked">${icons.link} ${linkedHere.length} on canvas</button>` : ''}</div>
      <div class="note-body"><div class="md">${renderMarkdown(stripLeadingTitle(n.body, n.title), { resolves, resolveImage }) || '<p style="color:var(--text-3)">Empty note.</p>'}</div></div>
      ${n.outlinks.length || n.backlinks.length ? `<div class="links">
        ${n.outlinks.length ? `<h5>Links to</h5><div class="linkrow">${n.outlinks.map((l) => `<button data-act="open" data-arg="${esc(l.path)}">${esc(l.title)}</button>`).join('')}</div>` : ''}
        ${n.backlinks.length ? `<h5>Linked from</h5><div class="linkrow">${n.backlinks.map((l) => `<button data-act="open" data-arg="${esc(l.path)}">${esc(l.title)}</button>`).join('')}</div>` : ''}
      </div>` : ''}
    </div>
    <div class="actionbar">
      <button class="btn primary" data-act="insert" ${busy('insert') ? 'disabled' : ''}>${busy('insert') ? '<i class="spin"></i>' : icons.card} Insert spec card</button>
      <button class="btn secondary" data-act="link" ${!canLink || busy('link') ? 'disabled' : ''} title="${canLink ? `Link “${esc(state.selection.node!.name)}” to this note` : 'Select exactly one layer in Figma first'}">${icons.link} Link selection</button>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="download-spec" title="Save as .md for Figma Specs — drop the file on the canvas to make a native Spec" aria-label="Save as Figma Spec markdown">${icons.download}</button>
    </div>`;
}

const syncStateFor = computeSyncState;

const SYNC_LABEL: Record<SyncState, string> = { 'in-sync': 'In sync', 'note-changed': 'Note changed', 'design-changed': 'Design changed', 'both-changed': 'Both changed', missing: 'Note missing', unknown: 'Checking…' };

function renderSelection(): void {
  const v = $('view-selection');
  const s = state.selection;
  if (!s.node) { v.innerHTML = emptyState(icons.select, 'Nothing selected', 'Select a frame, component or any layer on the canvas to link it to a note or send it to Obsidian.'); return; }
  const n = s.node;
  const link = n.link;
  const sync = syncStateFor(link, link ? (state.selectionNoteHash !== undefined ? state.selectionNoteHash : state.noteHashes.has(link.path) ? (state.noteHashes.get(link.path) ?? null) : undefined) : undefined, n.designHash);
  const noteTitle = link ? link.path.split('/').pop()!.replace(/\.md$/, '') : '';
  v.innerHTML = `<div class="scroll">
    <div class="card">
      <div class="card-head"><span class="ty">${nodeIcon(n.type)}</span><div class="grow"><div class="name">${esc(n.name)}</div><div class="sub">${pretty(n.type)}${n.width ? ` · ${n.width} × ${n.height}` : ''} · ${esc(n.pageName)}${s.count > 1 ? ` · +${s.count - 1} more selected` : ''}</div></div></div>
      <div class="card-body">
        ${link ? `
          <div class="card-row"><span class="lbl">Note</span><button class="val" style="text-align:left;color:var(--accent);font-weight:600" data-act="open" data-arg="${esc(link.path)}" title="${esc(link.path)}">${esc(noteTitle)}</button><button class="icon-btn" data-act="open-obsidian" data-arg="${esc(link.path)}" title="Open in Obsidian">${icons.external}</button></div>
          <div class="card-row"><span class="lbl">Status</span><span class="val"><span class="pill ${sync}">${SYNC_LABEL[sync]}</span></span><span style="color:var(--text-3);font-size:10px">synced ${relativeTime(link.syncedAt)}</span></div>
          <div class="card-actions">
            ${sync === 'missing' ? '' : `<button class="btn ${sync === 'note-changed' || sync === 'both-changed' ? 'primary' : 'secondary'}" data-act="pull" data-arg="${n.id}" ${busy('pull') ? 'disabled' : ''} title="${link.kind === 'spec-card' ? 'Rebuild this spec card from the note' : 'Mark the note as read and refresh the link'}">${busy('pull') ? '<i class="spin"></i>' : icons.pull} Pull from Obsidian</button>`}
            ${link.kind === 'linked' || sync === 'missing' ? `<button class="btn ${sync === 'design-changed' || sync === 'missing' ? 'primary' : 'secondary'}" data-act="push" data-arg="${n.id}" ${busy('push') ? 'disabled' : ''} title="Write this layer's properties and copy into the note">${busy('push') ? '<i class="spin"></i>' : icons.push} Send to Obsidian</button>` : ''}
            <button class="btn danger" data-act="unlink" data-arg="${n.id}" title="Remove the link (keeps the note)">${icons.unlink}</button>
          </div>`
        : `
          <div class="card-row"><span class="lbl">Note</span><span class="val" style="color:var(--text-3)">Not linked to any note</span></div>
          <div class="card-actions">
            <button class="btn primary" data-act="push" data-arg="${n.id}" ${busy('push') || !state.online || !state.vault ? 'disabled' : ''} title="Create a note in ${esc(state.settings.pushFolder || 'the vault root')}">${busy('push') ? '<i class="spin"></i>' : icons.push} Send to Obsidian</button>
            <button class="btn secondary" data-act="pick" data-arg="${n.id}" ${!state.online || !state.vault ? 'disabled' : ''}>${icons.link} Link to a note…</button>
          </div>`}
      </div>
    </div>
    ${link ? `<p style="margin:10px 14px;color:var(--text-3);line-height:1.5">${link.kind === 'spec-card' ? 'This is a spec card. Pulling rebuilds it from the note; edit the note in Obsidian, not the card.' : 'Linked layer. Pull marks the latest note as seen; Send writes the layer’s properties and copy into the note’s <b>Design</b> section.'}</p>` : `<p style="margin:10px 14px;color:var(--text-3);line-height:1.5">Sending creates <b>${esc(joinVaultPath(state.settings.pushFolder, safeFileName(n.name) + '.md'))}</b> with the layer’s size, fills, copy and a link back to Figma.</p>`}
  </div>`;
}

function renderLinked(): void {
  const v = $('view-linked');
  if (!state.linked.length) { v.innerHTML = emptyState(icons.link, 'No linked layers yet', 'Insert a spec card from Search, or select a layer and link it to a note. Linked layers show up here with their sync status.', `<button class="btn secondary sm" data-act="tab" data-arg="search">${icons.search} Search notes</button>`); return; }
  const pages = new Map<string, LinkedNodeSummary[]>();
  for (const l of state.linked) { const arr = pages.get(l.pageName) ?? []; arr.push(l); pages.set(l.pageName, arr); }
  v.innerHTML = `<div class="scroll">${[...pages.entries()].map(([page, items]) => `<div class="section-label">${icons.page} ${esc(page)}<span class="count">${items.length}</span></div><ul class="linked-list">${items.map((l) => {
    const hash = state.noteHashes.get(l.link.path);
    const sync = syncStateFor(l.link, state.noteHashes.has(l.link.path) ? (hash ?? null) : undefined, l.designHash);
    return `<li class="linked-item" data-act="select-node" data-arg="${l.nodeId}" data-page="${l.pageId}" tabindex="0">
      <span class="ty">${l.link.kind === 'spec-card' ? icons.card : nodeIcon(l.nodeType)}</span>
      <div class="min"><div class="t">${esc(l.nodeName)}</div><div class="s">${icons.note}<span style="overflow:hidden;text-overflow:ellipsis">${esc(l.link.path)}</span></div></div>
      <span class="pill ${sync}" title="synced ${relativeTime(l.link.syncedAt)}">${SYNC_LABEL[sync]}</span>
    </li>`; }).join('')}</ul>`).join('')}
    <p style="margin:4px 14px 14px;color:var(--text-3)">Click a row to select it on the canvas. Pull or send from the Selection tab.</p></div>`;
}

function renderSettings(): void {
  const s = state.settings;
  $('view-settings').innerHTML = `<div class="scroll"><form class="form" id="settings-form">
    <label>Vault</label>
    <div class="card" style="margin:6px 0 0"><div class="card-head"><span class="ty">${icons.note}</span><div class="grow"><div class="name">${esc(state.vault?.name ?? 'No vault chosen')}</div><div class="sub" title="${esc(state.vault?.path ?? '')}">${state.vault ? `${esc(state.vault.path)} · ${state.vault.notes} notes` : 'Pick one to start searching'}</div></div><button class="btn secondary sm" type="button" data-act="change-vault" ${state.online ? '' : 'disabled'}>Change…</button></div></div>
    <label>Theme</label>
    <div class="seg" role="radiogroup" aria-label="Theme">${(['auto', 'light', 'dark'] as ThemeMode[]).map((t) => `<button type="button" class="seg-btn${(state.settings.theme ?? 'auto') === t ? ' on' : ''}" role="radio" aria-checked="${(state.settings.theme ?? 'auto') === t}" data-act="theme" data-arg="${t}">${t === 'auto' ? 'Follow Figma' : t === 'light' ? 'Light' : 'Dark'}</button>`).join('')}</div>
    <div class="help">Auto matches Figma's theme as it changes. The sun/moon button in the header is a quick override.</div>
    <label for="s-url">Bridge address</label><input id="s-url" name="bridgeUrl" value="${esc(s.bridgeUrl)}" placeholder="http://localhost:27123" />
    <div class="help">Where the Obspec Bridge is listening. The one-time setup (<code>${esc(BRIDGE_CMD)}</code>) installs it on <code>http://localhost:27123</code>, the only address Figma lets this plugin reach, so keep that host and port unless you also edit the manifest.</div>
    <label for="s-token">Token <span style="font-weight:400;color:var(--text-3)">(optional)</span></label><input id="s-token" name="token" value="${esc(s.token)}" placeholder="Only if you started the bridge with --token" />
    <label for="s-folder">Folder for sent designs</label><input id="s-folder" name="pushFolder" value="${esc(s.pushFolder)}" placeholder="Figma" />
    <div class="help">Notes created by “Send to Obsidian” go here, relative to the vault root.</div>
    <label for="s-width">Spec card width</label><input id="s-width" name="cardWidth" type="number" min="240" max="1200" value="${s.cardWidth}" />
    <div id="s-status" class="conn-card ${state.online ? 'ok' : 'err'}">
      <span class="cc-icon">${state.online ? icons.check : icons.wifiOff}</span>
      <div class="cc-text">
        <div class="cc-title">${state.online ? 'Connected' : 'Not connected'}</div>
        <div class="cc-sub">${state.online ? `${esc(state.vault?.name ?? 'No vault yet')}${state.vault ? ` · ${state.vault.notes.toLocaleString()} notes` : ''} · bridge v${esc(state.health?.version ?? '')}${state.health?.service ? ' · starts at login' : ' · running in a Terminal window'}` : esc(state.healthError ?? 'Run the one-time setup to connect')}</div>
      </div>
      ${state.online ? '' : `<button class="btn secondary sm" type="button" data-act="retry">${icons.refresh} Retry</button>`}
    </div>
    <label>Support</label>
    <div class="support">
      <p class="muted" style="margin:0 0 8px">Found a bug or have an idea? Mail <b>${SUPPORT_EMAIL}</b>. The report includes your plugin and bridge versions, never your notes.</p>
      <div class="row" style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn secondary sm" type="button" data-act="report-bug">${icons.bug} Report a bug</button><button class="btn ghost sm" type="button" data-act="copy-support">Copy address</button><button class="btn ghost sm" type="button" data-act="open-community">${icons.external} Obspec on Figma Community</button></div>
    </div>
    <div class="row" style="margin-top:12px"><button class="btn primary" type="submit">Save &amp; reconnect</button><button class="btn ghost" type="button" data-act="tab" data-arg="search">Done</button>
      <span style="margin-left:auto;color:var(--text-3);font-size:10px">${esc(state.fileName)}${state.fileKey ? '' : ' · no file key'}</span></div>
  </form></div>`;
}

function renderToasts(): void {
  $('toasts').innerHTML = state.toasts.map((t) => `<div class="toast ${t.kind}">${esc(t.text)}<button data-act="dismiss" data-arg="${t.id}" aria-label="Dismiss">✕</button></div>`).join('');
}

// ───────────────────────────── Actions ────────────────────────────────────
let toastSeq = 0;
function toast(text: string, kind: Toast['kind'] = 'info', ms = 3200): void {
  const id = ++toastSeq;
  state.toasts.push({ id, text, kind });
  renderToasts();
  window.setTimeout(() => { state.toasts = state.toasts.filter((t) => t.id !== id); renderToasts(); }, ms);
}
const busy = (k: string) => state.busy.has(k);
async function withBusy<T>(k: string, fn: () => Promise<T>): Promise<T | undefined> {
  state.busy.add(k); render();
  try { return await fn(); }
  catch (e) { toast(errMsg(e), 'error'); return undefined; }
  finally { state.busy.delete(k); render(); }
}
function errMsg(e: unknown): string {
  if (e instanceof BridgeClientError) {
    if (e.code === 'NETWORK') return 'Can’t reach the Obspec Bridge — is it running?';
    if (e.code === 'NO_VAULT') { state.vault = undefined; render(); return 'Pick a vault first'; }
    return e.message;
  }
  return (e as Error)?.message || String(e);
}

async function checkHealth(): Promise<void> {
  try {
    const h = await bridge.health();
    state.health = h; state.vault = h.vault ?? undefined; state.online = true; state.healthError = undefined;
    if (h.vault && state.settings.vaultName !== h.vault.name) { state.settings.vaultName = h.vault.name; send({ type: 'save-settings', settings: state.settings }); }
    if (h.vault) { void loadRecent(); void refreshHashes(); } else void loadVaults();
  } catch (e) {
    state.online = false; state.healthError = errMsg(e);
  }
  render();
}

async function loadRecent(): Promise<void> {
  try { state.recent = (await bridge.list(12)).notes; if (!state.query) render(); } catch { /* offline */ }
}

async function loadVaults(): Promise<void> {
  state.vaultsLoading = true; render();
  try { state.vaults = (await bridge.vaults()).vaults; } catch (e) { toast(errMsg(e), 'error'); }
  state.vaultsLoading = false; render();
}

async function useVault(path: string): Promise<void> {
  state.switchingTo = path; render();
  try {
    const r = await bridge.setVault(path);
    await connectedToVault(r.vault);
  } catch (e) { toast(errMsg(e), 'error'); }
  state.switchingTo = undefined; render();
}

async function browseVault(): Promise<void> {
  state.picking = true; render();
  try {
    const r = await bridge.pickVault();
    if (r) await connectedToVault(r.vault);
  } catch (e) { toast(errMsg(e), 'error'); }
  state.picking = false; render();
}

async function connectedToVault(v: VaultInfo): Promise<void> {
  state.vault = v; state.choosingVault = false; state.settings.vaultName = v.name;
  send({ type: 'save-settings', settings: state.settings });
  toast(`Connected to ${v.name} · ${v.notes} notes`, 'success');
  state.recent = []; state.results = []; state.query = ''; input.value = '';
  await Promise.all([loadRecent(), refreshHashes(), loadVaults()]);
  render(); input.focus();
}

/** Opens a prefilled mail to support with harmless diagnostics (versions, platform — never note content). */
function reportBug(): void {
  const diag = [
    `Obspec plugin v${PLUGIN_VERSION}`,
    `Bridge ${state.online ? `v${state.health?.version ?? '?'} on ${state.health?.platform ?? '?'}` : 'offline'}`,
    `Vault ${state.vault ? `${state.vault.notes} notes` : 'none'}`,
    `Figma editor: ${state.editorType} · file: ${state.fileName || '(unnamed)'}`,
    `Theme ${state.settings.theme ?? 'auto'} · view ${state.settings.searchView ?? 'list'} · window ${window.innerWidth}×${window.innerHeight}`,
  ].join('\n');
  const body = `Hi Kamal,\n\nWhat happened:\n\n\nWhat I expected:\n\n\n— diagnostics —\n${diag}\n`;
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Obspec bug report (v${PLUGIN_VERSION})`)}&body=${encodeURIComponent(body)}`;
  send({ type: 'open-url', url });
  toast(`Opening your mail app — or write to ${SUPPORT_EMAIL}`, 'info', 5000);
}

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  toast(text.includes('@') ? 'Address copied' : 'Copied — paste it in Terminal');
}

let searchAbort: AbortController | undefined;
let searchTimer: number | undefined;
function scheduleSearch(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(), 80);
}
async function runSearch(): Promise<void> {
  searchAbort?.abort();
  const q = state.query.trim();
  if (!q) { state.results = []; state.total = 0; state.searching = false; render(); return; }
  const ctl = new AbortController(); searchAbort = ctl;
  state.searching = true; render();
  try {
    const r = await bridge.search(q, 30, ctl.signal);
    if (ctl.signal.aborted) return;
    state.results = r.results; state.total = r.total; state.tookMs = r.tookMs; state.active = 0;
  } catch (e) {
    if ((e as BridgeClientError).code === 'ABORTED') return;
    toast(errMsg(e), 'error');
  } finally { if (!ctl.signal.aborted) { state.searching = false; render(); } }
}

async function openNote(path: string): Promise<void> {
  state.tab = 'search'; state.noteLoading = true; state.note = undefined; state.noteUpdatedAt = undefined; render();
  try {
    state.note = await bridge.note(path);
    $('view-note').querySelector('.scroll')?.scrollTo(0, 0);
  } catch (e) { toast(errMsg(e), 'error'); }
  state.noteLoading = false; render();
}

function closeNote(): void { state.note = undefined; state.noteLoading = false; render(); input.focus(); }

async function pickNote(path: string): Promise<void> {
  const target = state.pickFor!;
  await withBusy('link', async () => {
    const note = await bridge.note(path);
    send({ type: 'select-node', nodeId: target.nodeId });
    send({ type: 'link-selection', note });
  });
  state.pickFor = undefined; state.tab = 'selection'; render();
}

async function pull(nodeId: string): Promise<void> {
  const link = state.selection.node?.id === nodeId ? state.selection.node.link : state.linked.find((l) => l.nodeId === nodeId)?.link;
  if (!link) return toast('Layer is not linked', 'error');
  await withBusy('pull', async () => {
    const note = await bridge.note(link.path);
    const images = link.kind === 'spec-card' ? await collectImages(note) : [];
    send({ type: 'pull', nodeId, note, vaultName: state.settings.vaultName, images });
  });
}

let pendingPush: string | undefined;
function push(nodeId: string): void {
  if (!state.online) return toast('Connect the bridge first', 'error');
  pendingPush = nodeId; state.busy.add('push'); render();
  send({ type: 'snapshot', nodeId });
}

async function completePush(snap: DesignSnapshot): Promise<void> {
  const nodeId = pendingPush; pendingPush = undefined;
  if (!nodeId) return;
  try {
    const existing = state.selection.node?.id === nodeId ? state.selection.node.link : state.linked.find((l) => l.nodeId === nodeId)?.link;
    const fm = pushFrontmatter(snap, state.fileName);
    const section = { heading: DESIGN_HEADING, markdown: snapshotToMarkdown(snap) };
    let path = existing?.path ?? joinVaultPath(state.settings.pushFolder, `${safeFileName(snap.name)}.md`);
    let res;
    let exists = true;
    try { await bridge.note(path); } catch (e) { if ((e as BridgeClientError).code === 'NOT_FOUND') exists = false; else throw e; }
    if (exists) res = await bridge.patch({ path, frontmatter: fm, section });
    else res = await bridge.write({ path, content: newNoteContent(snap, state.fileName) });
    path = res.note.path;
    send({ type: 'mark-pushed', nodeId, path, note: res.note, designHash: snap.hash });
    toast(res.created ? `Created ${path}` : `Updated ${path}`, 'success');
  } catch (e) { toast(errMsg(e), 'error'); }
  state.busy.delete('push'); render();
}

/** Keep the chip on each spec-card frame truthful. Only sends when the state actually changes. */
const sentCardStatus = new Map<string, CardStatus>();
function syncCardChips(): void {
  for (const l of state.linked) {
    if (l.link.kind !== 'spec-card') continue;
    const hash = state.noteHashes.has(l.link.path) ? (state.noteHashes.get(l.link.path) ?? null) : undefined;
    const status = cardStatusOf(computeSyncState(l.link, hash, undefined));
    if (!status || sentCardStatus.get(l.nodeId) === status) continue;
    sentCardStatus.set(l.nodeId, status);
    send({ type: 'card-status', nodeId: l.nodeId, status });
  }
}

function downloadSpec(note: Note): void {
  const md = toSpecMarkdown(note, state.settings.vaultName);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `${safeFileName(note.title)}.md`;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Saved ${a.download} — drop it on the canvas to make a Figma Spec`, 'success', 5000);
}

/** Decode the images a note embeds so the sandbox can place them in the card. Failures just skip the image. */
async function collectImages(note: Note): Promise<CardImage[]> {
  const targets = imageTargets(note.body);
  const out: CardImage[] = [];
  await Promise.all(targets.map(async (target) => {
    try { const img = await bridge.imageBytes(target); if (img) out.push({ target, ...img }); }
    catch { /* unreadable or unsupported image — the card shows a caption instead */ }
  }));
  return out;
}

async function refreshHashes(): Promise<void> {
  if (!state.online) return;
  const paths = state.linked.map((l) => l.link.path);
  if (state.selection.node?.link) paths.push(state.selection.node.link.path);
  if (!paths.length) { state.noteHashes = new Map(); return; }
  try {
    state.noteHashes = await bridge.hashes(paths);
    const sel = state.selection.node?.link;
    state.selectionNoteHash = sel ? (state.noteHashes.get(sel.path) ?? null) : undefined;
    syncCardChips();
  } catch { /* keep stale */ }
  render();
}

function saveSettings(form: HTMLFormElement): void {
  const fd = new FormData(form);
  state.settings = {
    ...state.settings,
    bridgeUrl: String(fd.get('bridgeUrl') || DEFAULT_SETTINGS.bridgeUrl).trim().replace(/\/+$/, ''),
    token: String(fd.get('token') || '').trim(),
    pushFolder: String(fd.get('pushFolder') ?? '').trim().replace(/^\/+|\/+$/g, ''),
    cardWidth: Math.min(1200, Math.max(240, Number(fd.get('cardWidth')) || DEFAULT_SETTINGS.cardWidth)),
  };
  send({ type: 'save-settings', settings: state.settings });
  bridge.configure(state.settings.bridgeUrl, state.settings.token);
  toast('Settings saved');
  void checkHealth().then(() => renderSettings());
}

// ───────────────────────────── Events ─────────────────────────────────────
app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const arg = el.dataset.arg ?? '';
  switch (el.dataset.act) {
    case 'tab': state.tab = arg as Tab; if (arg !== 'search') state.pickFor = state.pickFor; if (arg === 'settings') renderSettings(); render(); if (arg === 'search' && !state.note) input.focus(); break;
    case 'open': state.active = Number(el.dataset.i ?? state.active); if (state.pickFor) void pickNote(arg); else void openNote(arg); break;
    case 'back': closeNote(); break;
    case 'hint': { const h = arg === '"phrase"' ? '"' : arg; state.query = (state.query ? state.query.replace(/\s*$/, ' ') : '') + h; input.value = state.query; input.focus(); scheduleSearch(); render(); break; }
    case 'retry': void checkHealth(); break;
    case 'copy-cmd': void copyText(BRIDGE_CMD); break;
    case 'view': state.settings = { ...state.settings, searchView: arg as SearchView }; send({ type: 'save-settings', settings: state.settings }); renderSearch(); break;
    case 'theme': setTheme(arg as ThemeMode); renderSettings(); break;
    case 'report-bug': reportBug(); break;
    case 'copy-support': void copyText(SUPPORT_EMAIL); break;
    case 'open-community': send({ type: 'open-url', url: COMMUNITY_URL }); break;
    case 'toggle-theme': setTheme(isDark() ? 'light' : 'dark'); break;
    case 'use-vault': void useVault(arg); break;
    case 'browse-vault': void browseVault(); break;
    case 'change-vault': state.choosingVault = true; state.tab = 'search'; state.note = undefined; void loadVaults(); render(); break;
    case 'cancel-choose': state.choosingVault = false; render(); input.focus(); break;
    case 'open-obsidian': send({ type: 'open-url', url: obsidianUrl(state.settings.vaultName, arg) }); break;
    case 'search-obsidian': send({ type: 'open-url', url: obsidianSearchUrl(state.settings.vaultName, state.query.trim()) }); break;
    case 'download-spec': if (state.note) downloadSpec(state.note); break;
    case 'insert': if (state.note) void withBusy('insert', async () => { const note = state.note!; const images = await collectImages(note); send({ type: 'insert-spec-card', note, vaultName: state.settings.vaultName, width: state.settings.cardWidth, images }); }); break;
    case 'link': if (state.note) void withBusy('link', async () => { send({ type: 'link-selection', note: state.note! }); }); break;
    case 'pick': state.pickFor = { nodeId: arg, name: state.selection.node?.name ?? 'layer' }; state.tab = 'search'; state.note = undefined; render(); input.focus(); break;
    case 'cancel-pick': state.pickFor = undefined; render(); break;
    case 'pull': void pull(arg); break;
    case 'push': push(arg); break;
    case 'unlink': send({ type: 'unlink', nodeId: arg }); break;
    case 'select-node': send({ type: 'select-node', nodeId: arg, pageId: el.dataset.page }); state.tab = 'selection'; render(); break;
    case 'dismiss': state.toasts = state.toasts.filter((t) => t.id !== Number(arg)); renderToasts(); break;
  }
});
app.addEventListener('click', (e) => {
  const w = (e.target as HTMLElement).closest<HTMLElement>('[data-wiki]');
  if (!w || !state.note) return;
  const target = w.dataset.wiki!;
  const hit = state.note.outlinks.find((o) => o.title.toLowerCase() === target.toLowerCase() || o.path.toLowerCase() === (target.endsWith('.md') ? target : target + '.md').toLowerCase());
  if (hit && !w.classList.contains('broken')) void openNote(hit.path);
  else { state.note = undefined; state.query = target; input.value = target; state.tab = 'search'; scheduleSearch(); render(); }
});
app.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
  if (!a) return;
  e.preventDefault();
  if (a.getAttribute('href') !== '#') send({ type: 'open-url', url: a.href });
});
app.addEventListener('submit', (e) => {
  const f = e.target as HTMLFormElement;
  if (f.id === 'settings-form') { e.preventDefault(); saveSettings(f); }
  if (f.id === 'vault-manual') { e.preventDefault(); const p = String(new FormData(f).get('path') ?? '').trim(); if (p) void useVault(p); }
});
app.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('.linked-item') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); (e.target as HTMLElement).click(); }
});

input.addEventListener('input', () => { state.query = input.value; state.active = 0; scheduleSearch(); });
input.addEventListener('keydown', (e) => {
  const list = state.query.trim() ? state.results : state.recent;
  if (e.key === 'ArrowDown') { e.preventDefault(); state.active = Math.min(list.length - 1, state.active + 1); renderSearch(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.active = Math.max(0, state.active - 1); renderSearch(); }
  else if (e.key === 'Enter') { const item = list[state.active]; if (item) { state.pickFor ? void pickNote(item.path) : void openNote(item.path); } }
  else if (e.key === 'Escape') { if (state.query) { state.query = ''; input.value = ''; void runSearch(); } else if (state.pickFor) { state.pickFor = undefined; render(); } }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.note) { closeNote(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); state.tab = 'search'; state.note = undefined; render(); input.focus(); input.select(); }
});

// ───────────────────────────── Drag a result onto the canvas ─────────────
// HTML5 drag inside the plugin; when released over Figma, the UI posts `pluginDrop` and the
// sandbox gets a `drop` event with canvas coordinates (see code.ts). The note and its images are
// fetched while the drag is in flight so the card appears the moment it lands.
let drag: { path: string; title: string; data: Promise<{ note: Note; images: CardImage[] }> } | null = null;
const ghost = document.createElement('div'); ghost.className = 'drag-ghost'; document.body.appendChild(ghost);
app.addEventListener('dragstart', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.result[data-arg]');
  if (!el || !e.dataTransfer) return;
  const path = el.dataset.arg!;
  const title = el.querySelector('.r-title')?.textContent?.trim() ?? titleOf(path);
  drag = { path, title, data: bridge.note(path).then(async (note) => ({ note, images: await collectImages(note) })) };
  drag.data.catch(() => {});
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', title);
  ghost.innerHTML = `${icons.card}<span>${esc(title)}</span>`;
  e.dataTransfer.setDragImage(ghost, 16, 16);
  el.classList.add('dragging');
});
app.addEventListener('dragend', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.result');
  el?.classList.remove('dragging');
  if (!drag) return;
  const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
  // Figma's own check (`e.view.length === 0` means "released inside the plugin window") plus a coordinate check.
  if ((e.view && (e.view as Window).length === 0) && !outside) { drag = null; return; }
  parent.postMessage({ pluginDrop: { clientX: e.clientX, clientY: e.clientY, items: [{ type: 'text/plain', data: drag.title }], dropMetadata: { path: drag.path } } }, '*');
});
function titleOf(path: string): string { return path.split('/').pop()!.replace(/\.md$/, ''); }
async function completeDrop(m: { path: string; x: number; y: number; parentId?: string }): Promise<void> {
  const pending = drag && drag.path === m.path ? drag.data : bridge.note(m.path).then(async (note) => ({ note, images: await collectImages(note) }));
  drag = null;
  await withBusy('insert', async () => {
    const { note, images } = await pending;
    send({ type: 'insert-spec-card', note, vaultName: state.settings.vaultName, width: state.settings.cardWidth, images, at: { x: m.x, y: m.y }, parentId: m.parentId });
  });
}

// ───────────────────────────── Theme ─────────────────────────────────────
// Figma sets `figma-dark` / `figma-light` on <html> (and flips it live). 'auto' follows that;
// an override re-applies our class whenever Figma changes its mind.
const htmlEl = document.documentElement;
let figmaTheme: 'figma-dark' | 'figma-light' = htmlEl.classList.contains('figma-dark') ? 'figma-dark' : 'figma-light';
let appliedTheme: string | null = null;
function isDark(): boolean { return htmlEl.classList.contains('figma-dark'); }
function applyTheme(): void {
  const mode = state.settings.theme ?? 'auto';
  const want = mode === 'auto' ? figmaTheme : mode === 'dark' ? 'figma-dark' : 'figma-light';
  if (htmlEl.classList.contains(want) && !htmlEl.classList.contains(want === 'figma-dark' ? 'figma-light' : 'figma-dark')) { appliedTheme = want; return; }
  appliedTheme = want;
  htmlEl.classList.remove('figma-dark', 'figma-light');
  htmlEl.classList.add(want);
}
function setTheme(mode: ThemeMode): void {
  state.settings = { ...state.settings, theme: mode };
  send({ type: 'save-settings', settings: state.settings });
  applyTheme(); render();
}
new MutationObserver(() => {
  const now = htmlEl.classList.contains('figma-dark') ? 'figma-dark' : htmlEl.classList.contains('figma-light') ? 'figma-light' : null;
  if (!now || now === appliedTheme) return;   // our own change, or no theme class at all
  figmaTheme = now;                            // Figma (or the host) switched theme
  applyTheme(); renderTop();
}).observe(htmlEl, { attributes: true, attributeFilter: ['class'] });

// ───────────────────────────── Window resize grip ────────────────────────
{
  const grip = $('grip');
  let start: { x: number; y: number; w: number; h: number } | null = null;
  let raf = 0;
  const current = () => ({ w: window.innerWidth, h: window.innerHeight });
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    start = { x: e.screenX, y: e.screenY, ...current() };
    document.body.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!start) return;
    const w = start.w + (e.screenX - start.x), h = start.h + (e.screenY - start.y);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => send({ type: 'resize', width: w, height: h }));
  });
  const end = (e: PointerEvent) => {
    if (!start) return;
    const w = start.w + (e.screenX - start.x), h = start.h + (e.screenY - start.y);
    start = null; document.body.classList.remove('resizing');
    send({ type: 'resize', width: w, height: h, persist: true });
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

// ───────────────────────────── Sandbox messages ──────────────────────────
window.addEventListener('message', (e) => {
  const m = e.data?.pluginMessage as PluginToUi | undefined;
  if (!m) return;
  switch (m.type) {
    case 'init':
      state.settings = { ...DEFAULT_SETTINGS, ...m.settings }; state.fileKey = m.fileKey; state.fileName = m.fileName; state.editorType = m.editorType;
      bridge.configure(state.settings.bridgeUrl, state.settings.token);
      applyTheme();
      void checkHealth();
      if (m.command === 'link' || m.command === 'push') state.tab = 'selection';
      render(); input.focus();
      break;
    case 'settings': state.settings = { ...DEFAULT_SETTINGS, ...m.settings }; break;
    case 'selection':
      state.selection = m.selection; state.selectionNoteHash = undefined;
      if (m.selection.node?.link && state.online) void refreshHashes();
      render();
      break;
    case 'linked': state.linked = m.nodes; void refreshHashes(); render(); break;
    case 'snapshot': void completePush(m.snapshot); break;
    case 'drop': void completeDrop(m); break;
    case 'linked-ok': toast('Linked', 'success'); if (state.note && !state.pickFor) { state.tab = 'selection'; state.note = undefined; render(); } break;
    case 'pulled': toast('Pulled latest note', 'success'); sentCardStatus.set(m.nodeId, 'in-sync'); break;
    case 'spec-card-inserted': sentCardStatus.set(m.nodeId, 'in-sync'); toast('Spec card inserted', 'success'); break;
    case 'error': toast(m.message, 'error'); state.busy.clear(); pendingPush = undefined; render(); break;
  }
});

bridge.onStatus((online) => { if (online !== state.online) { state.online = online; if (online) void checkHealth(); else render(); } });
bridge.onEvent((ev: VaultEvent) => {
  if (ev.type === 'hello' || ev.type === 'vault-changed') { if (!state.online || (ev.vault?.path ?? null) !== (state.vault?.path ?? null) || ev.vault?.notes !== state.vault?.notes) void checkHealth(); return; }
  if (ev.type === 'deleted') state.noteHashes.set(ev.path, undefined);
  else state.noteHashes.set(ev.path, ev.hash);
  if (state.selection.node?.link?.path === ev.path) state.selectionNoteHash = ev.type === 'deleted' ? null : ev.hash;
  syncCardChips();
  if (state.note?.path === ev.path) {
    if (ev.type === 'deleted') { toast('This note was deleted in Obsidian', 'error'); closeNote(); }
    else void bridge.note(ev.path).then((n) => { state.note = n; state.noteUpdatedAt = Date.now(); render(); }).catch(() => {});
  }
  if (state.query.trim()) scheduleSearch(); else void loadRecent();
  render();
});

/** Obsidian notes often start with an H1 equal to the filename; the header already shows it. */
function stripLeadingTitle(body: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*\n?/.exec(body);
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return m && slug(m[1]) === slug(title) ? body.slice(m[0].length) : body;
}
function pretty(t: string): string { return t.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()); }

render();
send({ type: 'ui-ready' });
