# dsh-auto-workspace

[English](README.md) | [简体中文](README.zh-CN.md)

Codex-style **project-less chats** for the DeepSeek Harness.

Click "new session" without picking a project and you just start typing. The
plugin gives that chat its own private working directory, so the agent's file
tools and shell commands run there — and when you come back to the chat later it
keeps working in the same place. Nothing is added to the sidebar's project list.

## What it changes

DSH resolves a session's working directory in exactly one place:

```js
// @deepseek-ai/dsh-api-session-controller
const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
```

`this.defaultCwd` is the Host process's own `process.cwd()`. The GUI always
sends a `workspaceId`, so that fallback is normally dead — but there was no way
to *not* pick a project, and any other caller creating a chat without one would
silently inherit the directory DSH was launched from.

This plugin takes over that one fallback and nothing else.

| | |
|---|---|
| **Directory** | `~/Documents/DSH/<YYYY-MM-DD>/chat-NN/` (`%USERPROFILE%\Documents\DSH` on Windows) |
| **Grouping** | Sessions stay out of the project list; DSH groups them under its native "Ungrouped" bucket |
| **Resume** | The directory lives in the session's own `cwd` header, so reopening a chat reuses it; files persist |
| **Inheritance** | An explicit project wins. "New session" in a project stays in that project; in a project-less chat it stays project-less |
| **Entry** | Hovering the blank-chat hero's project chip swaps its folder glyph for a circular clear badge — click it to leave the project. The picker menu also offers `Work without a project`. With no project selected the chip reads `Choose workspace` and no badge appears |
| **New-chat screen** | A project-less chat keeps DSH's own "not started yet" Hero — fish, headline, chip row, agent-preset control — because a client-only sentinel Workspace gives the composer its title |
| **Cleanup** | Nothing is deleted. A directory is only reclaimed when its session creation failed before anything could be written |

## Install

The package is a DSH **bundle**: `package.json` declares `dsh.bundle.patch`, so
installing it appends the bundle to the profile's `dsh.profile.bundles` and
activates its row.

```bash
dsh plugin --profile <profile> add github:Castor6/dsh-auto-workspace
```

`<profile>` is the profile whose GUI should get the plugin — the Desktop app's is
`desktop`. `https://github.com/Castor6/dsh-auto-workspace` works as a spec too.

Or from the GUI's Plugins page, or with the `plugin_manager` tool
(`install_bundle`). Both halves ship in one package: the Host half is the entry
module, the browser half is `exports["./client"]` plus the `dsh.client`
declaration. Reload the page afterwards so the client bundle enters the boot
graph.

### Installing a local checkout

What you want while developing it. A local spec must be an **absolute** path — a
relative one is rejected, because it would resolve against the profile rather
than your shell:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-auto-workspace
```

That records a `link:` dependency, so the plugin keeps loading from the checkout:
the browser half is re-read on every page load, and Host-half edits take effect
on the next launch.

## Configuration

Set on the plugin's loader row in the profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: auto-workspace
  config:
    root: '/Volumes/Work/DSH'   # default: <home>/Documents/DSH
    directoryPrefix: 'chat'     # default: chat  →  chat-01, chat-02, ...
    enabled: true               # default: true
```

`<root>/.dsh-auto-workspace.json` maps session ids to directories. It is a
cache: delete it and the plugin rebuilds it from each session's persisted
header. Deleting the whole root removes every project-less chat's files.

## How it works

**Host half** (`lib/index.js`, Node builtins only — a `link:`-installed plugin
loads through its real path, where no `node_modules` exists):

- Wraps `ctx.sessionController.create`. Requests naming a `workspaceId` or an
  explicit `cwd` pass through untouched; a request naming neither gets a
  directory from the allocator. `mkdir` without `recursive` is the atomic
  reservation, so concurrent creates cannot collide.
- `SessionHeader.cwd` is immutable once written, so a directory is named once
  and never renamed — that is why the day folder plus `chat-NN` is fixed at
  creation.
- The persisted header is the authority for resume: `resumeObserved` reads
  `header.cwd` and rejects a session that has none, so injecting a directory at
  creation is what makes project-less chats durable.

**Browser half** (`lib/client.js`, hand-written lazy-CJS bundle — no build step;
`react`, `react-dom` and `@deepseek-ai/dsh-client-ui-primitives` are
shell-provided seed modules):

- Occupies `conversation.hero.workspace` at `priority: -1` to shadow the shipped
  picker for that `single` seat (the default priority is 0). The project list,
  selection check and folder-error dialog are preserved.
- Adds the clear badge. The shell renders the project chip and gives it no slot,
  so the badge replaces the chip's folder glyph on hover: a document-level
  pointer watch finds the chip structurally — it is the sibling immediately
  before this plugin's own slot anchor, which the framework renders as
  `div[data-slot="conversation.hero.workspace"]` with `display: contents` —
  hides the glyph, and overlays a badge centred on its measured rect, drawn
  smaller than the glyph box because a filled circle reads heavier than the line
  art it replaces. Nothing keys off a label, so it survives a language switch.
  The picker's footer gains a `Work without a project` row beside `Add folder`.
  Neither affordance exists while no project is selected; a chip that cannot be
  located at all leaves an inline badge instead.
- Folder adoption calls `ctx.uiWorkspace.pickDirectory()` — exactly what the
  shipped `…directoryFlow` occupant resolves to. It cannot be delegated to that
  hole: a slot occupant may only render child slots it declared itself, and a
  child slot name may be declared once, so a shadowing occupant can never
  render a hole the shipped registration declared.
- **Keeps the Hero alive with a sentinel Workspace.** Shipped DSH offers a
  usable composer only to a Session that belongs to a Workspace:
  `ConversationMainPanel` disables it while `chipTitle === undefined`, and
  `chipTitle` is only ever a Workspace title. Putting the session under a real
  Workspace is exactly the sidebar project this plugin must not create, and it
  would also move the chat out of Ungrouped. So the browser projection appends
  one **sentinel Workspace** — client-only, never registered on the Host,
  carrying no Sessions — and the Hero's own picker callback selects it, which is
  what gives `chipTitle` a value. It is projected *only* while the main Session
  is project-less, so navigating to a project drops it and the panel clears the
  stale selection by itself.
  That sentinel necessarily reaches the sidebar's group list, which renders a
  row for every Workspace including empty ones; that single row is hidden by a
  mutation-observed `display: none`.
- **Falls back to the composer override.** If the sentinel cannot be installed
  (an unwritable store) the plugin notices and instead reports a project-less
  session as content-bearing (`blank: false, awaitingFirstTurn: false`) through
  its per-session shell snapshot, which renders the ordinary active composer.
  The chat stays usable; only the Hero is lost. Only that snapshot is touched —
  the session *list* keeps the real blankness, so sidebar visibility, the native
  blank-session reuse and this plugin's own reuse keep shipped behaviour.
- Wraps `ctx.uiWorkspace.startSession` so a project-less current session stays
  project-less instead of falling back to the most recently active project.
- Bridges the "Ungrouped" group header's new-session button. Shipped DSH renders
  that button but its handler is `if (group.workspaceId !== void 0)`, and that
  bucket has no workspace id, so it is inert. There is no slot inside a group
  header, and replacing `sidebar.workspaces` would mean reimplementing the whole
  browser; instead a capture-phase listener matches the button by the
  accessible name the same locale service produces. A renamed label or a
  restructured header stops matching and native behaviour returns.

## Limitations

- The Host wrap and the client patches reach into package internals
  (`sessionController.create`, `uiWorkspace.startSession`, `sessions.binding`'s
  snapshot store) rather than a published extension point. All of them are
  defensive: if the shape changes the plugin logs a warning and stays inert
  instead of breaking the app.
- The hero picker occupant shadows shipped UI. A DSH release that redesigns the
  picker needs this plugin re-checked.
- `chat-NN` numbering is per day and best-effort: removing a day folder makes the
  numbers reusable, so numbering is not monotonic over time.
- Project-less sessions appear under DSH's native "Ungrouped" group. They are
  never registered as projects.
- The sentinel Workspace is hidden from the sidebar by matching its label text
  and its container's stable `groupSection` class-name suffix. Should a DSH
  redesign break either, one empty project row titled `Choose workspace` becomes
  visible — cosmetic only. Flipping `HERO_FOR_PROJECT_LESS` to `false` at the top
  of `lib/client.js` removes the sentinel entirely and returns to the composer
  override; the client bundle is re-read on every page load, so a refresh
  applies it.
