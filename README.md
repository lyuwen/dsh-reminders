# dsh-reminders-plugin

A DSH plugin that keeps a **reminder list of what you are developing** and keeps it
fresh automatically with a **dreaming mode**.

Agentic coding produces many parallel work streams: sessions pile up, some are
finished, some are blocked mid-turn, and some are silently abandoned. This plugin
gives you one grouped picture of that work, and a quiet background pass that reads
your recently accessed Sessions and folds what it finds into the list.

## What you get

- **Sidebar entry + main panel.** A checklist icon in the global panel list opens
  the *Reminders* view.
  - Grouped list (one group per project / work stream; nested groups can be created
    manually) with search and status filters.
  - Every item tracks: title, notes, next step, linked Sessions, **status**
    (`todo` / `doing` / `blocked` / `done`), **progress** (0–100), **importance**
    (1–5), pinning, and **freshness** (fresh / warm / stale / cold, computed from the
    last touch).
  - Manual maintenance: create, edit, delete, pin, move between groups, rename or
    delete groups.
- **Dreaming mode.** Every 10 minutes (configurable) the Host half scans Sessions
  touched within the recent window, derives a summary per Session (title, last user
  request, last assistant reply, tool use, turn state, errors, project directory),
  and then:
  - attaches the Session to an existing reminder when one is already linked, or
    when a same-project reminder title is similar enough;
  - creates a new reminder (grouped by project directory) when the work is new;
  - moves `todo` items to `doing` and blocked Sessions' items to `blocked`, raises
    a conservative progress estimate, and fills in the next step;
  - flags items that have gone quiet past the "forget" threshold as *needing
    attention* in the popup (their status is never silently changed).
  Dreaming never marks work `done` on its own.
- **Top-right popup.** While dreaming it shows what it is doing; when done it lists
  the affected items with **Edit** / **Delete** per row, plus **Undo** for the run
  (restores the list to its pre-run state), **Open list**, and **Dismiss**. Not
  intervening simply accepts the result. Dismissal is remembered per activity.
  A slim progress bar runs along the popup's top edge: while dreaming it is
  indeterminate, and once a run finishes it counts down (12 s) and the popup fades
  away. The countdown pauses while the popup is hovered, while it holds keyboard
  focus, and while the browser window or tab itself loses focus, so it never
  expires unseen. Notifications never stack: if several dreaming passes finish
  while the window is unfocused, returning to it shows a single aggregated
  **While you were away** popup (number of passes plus summed new/updated/attention
  counts and the affected items), built from the last-seen watermark the browser
  stores. The Host keeps the latest twelve activities and folds older ones into a
  rollup record for that aggregate.
- **Agent tool.** A `reminders` tool with `list`, `get`, `create`, `update`,
  `delete`, `group_create`, `group_delete`, `dream_run`, `dream_status`,
  `undo_dream`, and `update_settings` actions, so you can ask the agent to maintain
  the same list the UI shows (same Host operations, no duplicate logic).

The dreaming engine does not call a language model: it is deterministic and cheap,
reusing the Session titles that DSH already generated. That keeps it safe to run on
a timer and makes its output predictable.

## Data

- Plugin state lives in a single JSON file:
  `${DSH_HOME:-~/.dsh}/reminders/state.json` (override with `config.dataDir`).
  Writes are atomic and serialized; an unreadable file is moved aside and the list
  starts fresh instead of failing the plugin.
- Session data is only **read**: `ctx.sessionQuery` / `ctx.sessionPersistence` /
  `ctx.sessions`. The plugin never appends Session events.
- The browser half talks to the Host only through authenticated
  `GET /api/dsh-reminders/state` and `POST /api/dsh-reminders/action` routes.

## Install

From the profile that should own it:

```text
plugin_manager install_bundle target=/home/lfu/git-projects/dsh-reminders
```

or install with the CLI/bundle flow you normally use for local bundles. The package
declares its bundle patch (`cordis.patch.yml`) and its Client module
(`package.json` → `dsh.client`), so the sidebar entry, panel, and popup activate with
the Host row. A DSH restart is not needed for a first install; a replaced client
bundle needs a page refresh.

Remove it with `plugin_manager remove_bundle target=dsh-reminders-plugin`. The state
file is left in place.

## Configuration

`cordis.patch.yml` row `reminders` accepts:

| Field | Default | Meaning |
|---|---|---|
| `dreamEnabled` | `true` | Run dreaming automatically. |
| `dreamIntervalMinutes` | `10` | Minutes between automatic runs (1–1440). |
| `windowHours` | `72` | Only Sessions touched within this many hours are scanned. |
| `maxSessions` | `12` | Sessions deep-read per run (candidates are ranked by recency). |
| `staleHours` | `24` | Freshness → `stale` after this many hours. |
| `forgetHours` | `72` | Freshness → `cold`, and the attention threshold. |
| `dataDir` | `$DSH_HOME/reminders` | State directory. |

`dreamEnabled`, `dreamIntervalMinutes`, and `windowHours` can also be changed at
runtime from the panel header; runtime values are persisted in the state file and
win over the row config on later boots.

The Host half deliberately has **no runtime dependencies** (Node builtins only), so
the bundle exports no `Config` schema: the row's `config` keys above are read as raw
config and validated by the plugin itself, not by Cordis. The UI does not depend on
that schema — the bundle contributes its own row config page.

### Where the settings live

- **Reminders panel header** (quick controls): dreaming on/off and the scan interval.
- **Plugins → Reminders → Configure** (full set): dreaming on/off, scan interval,
  recent window, Sessions per pass, stale-after and forgotten-after thresholds.
  The config page writes the same runtime settings through the authenticated plugin
  API and shows the plugin state directory. Changes save immediately and win over
  the `cordis.patch.yml` defaults on later boots.
- **`cordis.patch.yml`**: bootstrap defaults only; useful for a fresh profile or for
  keys with no UI control (`dataDir`).

## Layout

```text
index.js        Host plugin: store, dream engine, session scanner, /api routes, tool
client.js       Browser module: RemindersPage, DreamToast, RemindersIcon
cordis.patch.yml  Bundle patch (one Host row)
locale/         Plugin-manager metadata (en, zh)
icon.svg        Plugin inventory icon
test/           Host unit tests (node --test "test/*.test.mjs")
```

## Development

```bash
node --check index.js
node --check client.js
node --test "test/*.test.mjs"
```

The tests exercise the store, pure derivation helpers, and the dreaming engine
against a fake read-only Session corpus; they need no DSH profile or browser.

## Limits / design notes

- Session content is sampled (first 40 + last 80 events per Session plus a batched
  title fold) rather than fully replayed, so a Session's full turn count is not
  exact; progress is a conservative heuristic, editable by hand.
- Subagent Sessions are excluded from scanning (their parent represents the work).
- Grouping is directory-basename based plus title-token similarity within a group;
  it is intentionally conservative, and the popup makes it easy to delete or edit a
  wrong merge.
- Automatic dreaming never overrides a `done` item's status.
