<p align="center">
  <a href="https://justkamal07.github.io/obspec/"><img src="media/outro.png" alt="Obspec: the Figma mark carved from violet obsidian, on a polished plinth" width="880"></a>
</p>

<h1 align="center">Obspec</h1>
<p align="center"><b>Obsidian × Figma Specs.</b> Search your vault from inside Figma, drop notes onto the canvas as Specs, and keep both sides in sync. Nothing leaves your machine.</p>
<p align="center">
  <a href="https://justkamal07.github.io/obspec/">Website</a> ·
  <a href="#run-it">Run it</a> ·
  <a href="#local-preview-no-figma-needed">Preview without Figma</a> ·
  <a href="mailto:kr07.work@gmail.com?subject=Obspec%20bug%20report">Report a bug</a>
</p>
<p align="center">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-8f6bff">
  <img alt="Figma plugin" src="https://img.shields.io/badge/Figma-plugin-1e1e1e?logo=figma">
  <img alt="Obsidian" src="https://img.shields.io/badge/Obsidian-vault-7c3aed?logo=obsidian">
</p>

---

## What it looks like

| Search the vault inside Figma | Drop a note on the canvas |
| --- | --- |
| ![Hero: the Obsidian vault and the Figma canvas side by side in one Mac window](media/hero.png) | ![A note card flies from the vault into Figma and lands as a Spec](media/insert.png) |

| Edit in Obsidian, pull in Figma |
| --- |
| ![A line typed in Obsidian travels across the thread into the Spec; the plugin shows Note changed and a Pull button](media/pull.png) |

The site at **https://justkamal07.github.io/obspec/** plays this whole flow as you scroll: six steps, then the stone.

**Obsidian ↔ Figma, both ways.** Search your vault from inside Figma, drop any note onto the canvas as a spec card, link layers to notes, and keep the two in sync — note edits show up in Figma live, and design changes can be sent back into the note.

Nothing leaves your machine: the plugin talks to a tiny local bridge that indexes your vault.

```
Figma plugin (UI + sandbox)  ⇄  Obspec Bridge (localhost:27123)  ⇄  your Obsidian vault (.md files)
```

## Features (deliberately few)

| | What | Where |
| --- | --- | --- |
| **Search** | grep-style search over every note: title, path, tags, body. Snippets with highlights, `tag:` `path:` `"phrase"` `-exclude` filters, keyboard-driven. | Search tab |
| **Preview** | rendered markdown, wikilinks (clickable), backlinks, tags, open in Obsidian. | tap a result |
| **Insert / Link** | *Insert spec card* renders the note as a clean auto-layout frame; *Link selection* attaches a note to any layer. | note view |
| **Two-way sync** | status per linked layer: In sync · Note changed · Design changed — and the status chip sits on the spec card frame itself, updated live. *Pull* rebuilds the card / marks the note read. *Send to Obsidian* writes node, size, fill, label and a Figma deep link into the note's `## Design` section (creating the note if needed). | Selection & Linked tabs, the frame |
| **Figma Specs** | *Save as .md for Figma Specs* exports any note as a Spec-ready markdown file; drop it on the canvas and Figma turns it into a native Spec. Everything Obspec writes uses only the blocks Specs understand. | note view (↓ icon) |
| **In Obsidian** | *in Obsidian* next to the results runs the same search inside Obsidian, so the matching notes light up in your vault. | Search tab |

## Install

**From Figma Community:** [https://www.figma.com/community/plugin/1693223473984407174](https://www.figma.com/community/plugin/1693223473984407174) → *Open in Figma*. Then do the one-time setup below and pick your vault in the plugin's first-run screen. A step-by-step guide with screenshots: **https://justkamal07.github.io/obspec/guide/**.

## Run it

**1. One-time setup** (installs a tiny local helper that reads your vault for Figma, and makes it start whenever you log in). Open Terminal, paste this once, press return:

```bash
npx github:justkamal07/obspec          # needs Node.js 18+; builds on first run
```
It prints *Done* when the bridge is running in the background. Close the window; you never run this again (running it again upgrades the service). With the folder on your Mac, double-click **`Obspec Bridge.command`** instead. From a clone, `npm install && npm run build && node bridge/dist/cli.js setup`.

- macOS: a launchd agent at `~/Library/LaunchAgents/com.obspec.bridge.plist` · Linux: a `systemd --user` unit · Windows: a script in the Startup folder. The bundle lives in `~/.obspec/bridge/`, the log in `~/.obspec/bridge.log`.
- `npx github:justkamal07/obspec status` shows whether the service is installed and answering; `… uninstall` removes it.
- Prefer a Terminal window you can watch? `npx github:justkamal07/obspec run` runs the bridge in the foreground instead (`--vault <path>` forces a vault). The service notices another bridge on the port and steps aside.

**2. Open Obspec in Figma.** The first run shows a two-step onboarding: it waits for the bridge, then lists the vaults Obsidian knows about on your computer. Click one, or *Browse for a folder…* (native dialog), or paste a path. Change it any time under ⚙ Settings → Vault.

**Developing the plugin itself?** Figma desktop → Plugins → Development → *Import plugin from manifest…* → `manifest.json`.

The plugin talks to `http://localhost:27123`, the only address Figma allows (see `networkAccess` in `manifest.json`). Add `--token <secret>` to a foreground `run` and paste it in Settings if you want auth on top of the loopback bind.

## Local preview (no Figma needed)

```bash
npm run preview      # → http://127.0.0.1:5177
```

Runs the **real plugin UI** and the **real bridge** on port 27124 (against a scratch copy of `examples/vault`, so it never collides with your real bridge on 27123) with a mock Figma document. The right rail has five one-click use-case emulations that drive the UI exactly like a user would:

1. Search the vault → open a note → insert a spec card
2. Select a layer → link it to a note
3. Edit the note in Obsidian → status flips to *Note changed* → Pull
4. Select a component → Send to Obsidian → note created with frontmatter + Design table
5. Change the design → *Design changed* → re-send updates the note

`npm run emulate` runs the same five scenarios in headless Chrome and writes screenshots + `report.json` to `preview/shots/`.

## Develop

```bash
npm run watch        # rebuild plugin, bridge and harness on change
npm test             # bridge, search, markdown and note-generation tests
npm run typecheck
```

### Layout

```
manifest.json          Figma plugin manifest (dynamic-page, networkAccess → localhost only)
src/plugin/            sandbox: code.ts (messages, links), speccard.ts, snapshot.ts
src/ui/                plugin UI: ui.ts (state + views), bridge.ts (HTTP/SSE), markdown.ts, app.css
src/shared/            protocol.ts (every cross-boundary type), notegen.ts (markdown written to the vault)
bridge/src/            vault.ts (indexer + fs.watch), search.ts, markdown.ts (frontmatter/wikilinks), server.ts, cli.ts, service.ts (login service)
preview/               serve.mjs, index.html, harness.ts (mock Figma sandbox + scenarios)
examples/vault/        sample Obsidian vault used by the preview and tests
tests/                 node:test suites (run via scripts/test.mjs)
```

### Bridge API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | current vault (or `null` on first run), platform, whether a folder dialog is available, `service: true` when running as the login service |
| GET | `/vaults` | vaults from Obsidian's registry + saved config, most recently opened first |
| POST | `/vault` | `{ path }` — switch to (and index) a vault; remembered in `~/.obspec/config.json` |
| POST | `/vault/pick` | opens the OS folder dialog, then switches to the chosen folder |
| DELETE | `/vault` | forget the current vault |
| GET | `/hashes?path=a&path=b` | current hashes for many notes in one call (sync status) |
| GET | `/search?q=&limit=` | ranked results with snippets and highlight ranges |
| GET | `/note?path=` | full note incl. frontmatter, outlinks, backlinks, content hash |
| GET | `/notes?limit=` | recent notes (path, title, mtime, tags, hash) |
| PUT | `/note` | `{ path, content, ifHash? }` — create/overwrite, 409 on stale hash |
| PATCH | `/note` | `{ path, frontmatter?, section?, ifHash? }` — merge frontmatter, replace an H2 section |
| GET | `/events` | Server-Sent Events: `created` / `changed` / `deleted` |

Links are stored on nodes as plugin data (`obspec:link`) with the note's content hash and the layer's design fingerprint, which is how sync state is computed without any server-side state.

## Figma Specs

Figma Specs are markdown-based, and Figma makes a native Spec out of any `.md` file dropped on the canvas. There is no Plugin API for creating Specs directly, so Obspec meets Specs halfway:

- **Note → Spec:** open a note, press the ↓ icon in the action bar. You get `<Title>.md` with the note's body, a source line (path, tags, `obsidian://` link) and no dangling wikilinks or embeds. Drop it on the canvas.
- **Spec card:** the auto-layout frame Obspec inserts is a readable mirror that stays linked and shows its sync status on the frame. Use it when you want the note to live *inside* your design, next to the frames it describes.
- **What we write:** the `## Design` section and generated notes use only headings, lists, quotes, code and dividers — the block set Specs documents — so the same file reads cleanly in Obsidian and in Figma.

## Shipping it (Figma Community)

Everything the listing needs is in the repo:

- **Plugin files:** `manifest.json`, `dist/code.js`, `dist/ui.html` (run `npm run build`). The manifest declares `documentAccess: dynamic-page` and a `networkAccess` limited to `http://localhost:27123` with a reasoning string, which is what Figma's review looks for.
- **Icon and cover:** `node scripts/listing-assets.mjs` renders `publishing/icon.png` (128×128) and `publishing/cover.png` (1920×960) from `publishing/listing.html`.
- **Checks before you publish:** `npm run typecheck && npm test && npm run emulate` — types, 34 unit/integration tests, and the seven end-to-end scenarios in headless Chrome.
- **Fonts:** the UI embeds OffBit Bold (the site's display face) for the wordmark and headings. The file in `site/assets/fonts` is the *trial* cut from Power Type — license it before publishing, or swap `--display` in `src/ui/app.css` to the system stack.

### Does it work offline, and on a new computer?

**Offline: yes.** The plugin bundle is self-contained (no CDN, no fonts fetched, no analytics). Its only network traffic is to the bridge on `localhost`, and the bridge touches nothing but the vault folder. Figma itself needs to be open, which is the only online part — and Figma desktop works offline for already-open files.

**New computer: yes, with one prerequisite — Node.js 18 or newer** (20+ on Linux for native file watching; older Node falls back to polling). The first-run flow in the plugin walks the user through it:

1. One-time setup: `npx github:justkamal07/obspec` (needs internet once to fetch it) or double-click `Obspec Bridge.command`. It installs the bridge as a login service, so from then on it is simply always there.
2. Pick a vault from the list the bridge reads out of Obsidian's own registry, browse for a folder, or paste a path. The choice is saved to `~/.obspec/config.json`, so the next start needs no arguments.

Windows and Linux are supported by the bridge (paths, folder dialog via PowerShell / zenity), but have only been exercised on macOS so far.

## Notes & limits

- `figma.fileKey` is only exposed to private/org plugins; without it the note's `figma_url` is omitted (everything else works).
- Spec cards are a readable mirror, not a markdown renderer: headings, lists, quotes, code and tables are kept; images become `[image: …]`.
- Large vaults: a 6,000-note vault indexes in well under a second; search is ~10 ms and note open is instant thanks to basename and backlink indexes (an earlier version scanned the whole vault per note).
- The bridge binds to `127.0.0.1` and only allows the Figma plugin origin (`null`), `*.figma.com` and localhost via CORS.

## Website

`site/` is a single static page (OffBit display type, Three.js for the obsidian gem) and deploys to GitHub Pages from `main` through `.github/workflows/pages.yml`. Open `site/index.html` in a browser to work on it; there is no build step.

## Contributing

Issues and pull requests are welcome. For a bug, the fastest route is an issue with the Figma version, OS, and the bridge's console output; or email kr07.work@gmail.com.

## License

[MIT](LICENSE) © 2026 Kamalraaj Senthilkumar. Not affiliated with Figma or Obsidian.
