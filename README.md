# dsh-reminders-plugin

A DSH plugin that keeps a **reminder list of what you are developing** and keeps it
fresh with a **dreaming mode** that reads your recently used AI coding Sessions and
grades the work with an LLM (with a deterministic fallback).

Agentic coding produces many parallel work streams: sessions pile up, some are
finished, some are blocked, some wait for your permission, and some are silently
abandoned. This plugin gives you one grouped picture of that work and learns how you
prioritize it.

## What you get

- **Sidebar entry + main panel.** A checklist icon in the global panel list opens the
  *Reminders* view.
  - Grouped list (one group per project) with search and status filters:
    `todo` / `doing` / **`awaiting`** (“Needs you”) / `blocked` / `done`.
  - Every item tracks: title, **subtitle** (progress summary), notes, next step,
    linked Sessions, **progress** (0–100), **importance** (1–5), pinning, **freshness**
    (fresh/warm/stale/cold), **attention** (0–100 + reason), and a status note
    (e.g. “Waiting for your permission”).
  - Manual maintenance: create, edit, pin, move between groups, rename/delete groups.
  - Editing title/subtitle/progress/importance **locks that field** against automatic
    re-grading; a **Restore auto-grading** button hands it back to the evaluator.
- **Dreaming mode (LLM-evaluated by default).** Every 10 minutes the Host scans
  Sessions touched within the recent window, then:
  - **Title** = the DSH-generated Session title (unless you renamed it).
  - **Subtitle** = a one-sentence LLM summary of what the Session accomplished and
    where it stands.
  - **Progress, importance and attention** are graded by the LLM in the same batched
    request, using your learned preferences and the current state of the list.
  - **Status** is derived from the Session: pending approval or an unanswered question
    becomes **`awaiting`**; errors/aborts become **`blocked`**; work never becomes
    `done` automatically.
  - New Sessions create items; changed Sessions update the existing item (matched by
    linked Session or title similarity) and keep one item per work stream.
  - Identical Sessions are **not re-evaluated**: a persisted fingerprint (event count,
    last activity, last human request, last assistant reply, pending state, title)
    reuses the cached summary/grade, so only real changes cost tokens.
  - When no model route is available (or evaluation is switched to heuristic), a
    deterministic fallback derives subtitles/progress/status and a time + context
    attention score; the pass still completes and says it used the fallback.
- **Learning from you.** The evaluator keeps a persistent learned-preference record:
  free-form notes, global calibration biases for importance/progress/attention,
  per-project adjustments, recent feedback signals and counters. Manual edits teach it
  (for example raising an item's importance nudges future importance up; deleting a
  flagged item lowers attention for that project). The record is visible and editable
  in the plugin Configure page, with Clear signals and Reset.
- **Top-right popup.** While dreaming it shows what it is doing; when done it lists the
  affected items with **Edit** / **Delete** per row, **Undo** for the run, **Open
  list**, and **Dismiss**. A top-edge progress bar is indeterminate while running,
  then counts down (12 s) and the popup fades. The countdown pauses on hover, on
  keyboard focus, and while the page/window loses focus. An automatic pass that
  changed nothing does not notify at all, and the last-seen watermark is persisted, so
  only genuinely new work (or a manual "Dream now") brings the popup back. Notifications
  never stack: runs completed while the page was unfocused are collapsed into one aggregated
  **While you were away** popup, built from a Host-side activity rollup and the
  last-seen watermark. Its line reads as *N dreaming passes since you last checked ·
  X new reminders · Y grading updates · Z need your attention*: `N` is the number of
  automatic passes folded in (one every 10 min by default), `X` counts reminders
  created, `Y` counts grading/status update events (the same item can be re-graded
  many times), and `Z` counts **distinct open items** above the attention threshold.
- **Agent tool.** `reminders` with `list/get/create/update/delete/item_unlock/
  group_create/group_delete/dream_run/dream_status/undo_dream/update_settings/
  learning_status/learning_update/learning_reset/models_list`, so the agent can read
  and maintain the same list.

## Models

Dreaming is LLM-evaluated by default, using **the default model** unless you choose an
explicit provider/model on the Configure page (Plugins → Reminders → `reminders` row →
Configure → Evaluation). The evaluator makes **one batched request per dreaming pass**
only when there are changed Sessions and/or open items to grade, with a per-pass cap
(`Sessions evaluated per pass`, `Open items graded per pass`), a 60 s timeout, and a
strict-JSON response contract. Every failure degrades to heuristics; a pass never
fails because of the model. Switching the mode to **Heuristic** disables model usage
entirely (zero tokens).

The Session **title text** is produced by DSH's own title provider
(`session-title-llm`), which follows each Session's captured provider/model route,
unless that row sets an explicit `provider`/`model` pair. That is independent of this
plugin.

## Data

- Plugin state lives in a single JSON file:
  `${DSH_HOME:-~/.dsh}/reminders/state.json` (override with `config.dataDir`). It holds
  items, groups, activity history/rollup, cached Session summaries, and the learned
  preference record. Writes are atomic and serialized; an unreadable file is moved
  aside and the list starts fresh instead of failing the plugin.
- Session data is only **read** (`ctx.sessionQuery`, `ctx.sessionPersistence`,
  `ctx.sessions`). The plugin never appends Session events.
- The browser half uses authenticated `GET /api/dsh-reminders/state` and
  `POST /api/dsh-reminders/action` routes.

## Install

```text
plugin_manager install_bundle target=/home/lfu/git-projects/dsh-reminders
```

The package declares its bundle patch (`cordis.patch.yml`) and its Client module
(`package.json` → `dsh.client`). Remove with
`plugin_manager remove_bundle target=dsh-reminders-plugin`; the state file is left in
place. Changes to the installed client need a page refresh to load the new bundle.

## Configuration

`cordis.patch.yml` row `reminders` accepts:

| Field | Default | Meaning |
|---|---|---|
| `dreamEnabled` | `true` | Run dreaming automatically. |
| `dreamIntervalMinutes` | `10` | Minutes between automatic runs (1–1440). |
| `windowHours` | `72` | Only Sessions touched within this many hours are scanned. |
| `maxSessions` | `12` | Sessions deep-read per run (ranked by recency). |
| `staleHours` | `24` | Freshness → `stale` after this many hours. |
| `forgetHours` | `72` | Freshness → `cold` (time-only signal; attention is context-aware). |
| `evalMode` | `model` | `model` (LLM evaluation) or `heuristic` (no tokens). |
| `evalProvider`, `evalModel` | follow default | Explicit evaluation route; leave both empty to follow the default model. |
| `evalMaxSessions` | `8` | Changed Sessions evaluated per pass (1–30). |
| `evalMaxItems` | `20` | Open items re-graded per pass (0–40; `0` disables item grading). |
| `dataDir` | `$DSH_HOME/reminders` | State directory. |

### Where the settings live

- **Configure page** (Plugins → Reminders → `reminders` row → Configure): all of the
  above except `dataDir`, plus the **Evaluation** model selector and the
  **Learned preferences** editor (notes, biases, per-project adjustments, recent
  signals, Clear/Reset).
- **Reminders panel header** (quick controls): dreaming on/off and the scan interval.
- **`cordis.patch.yml`**: bootstrap defaults only (`dataDir` has no UI control).

Runtime values are persisted in the state file and win over the patch defaults on later
boots.

## Layout

```text
index.js        Host plugin: store, dreaming engine, Scanner, /api routes, agent tool
evaluate.js     LLM evaluator (prompt, strict-JSON parsing) + deterministic fallbacks
client.js       Browser module: panel, editor, popup, plugin Configure page
cordis.patch.yml  Bundle patch (one Host row)
locale/         Plugin-manager metadata (en, zh)
icon.svg        Plugin inventory icon
test/           Host unit tests (node --test "test/*.test.mjs")
```

## Development

```bash
npm run check    # node --check index.js evaluate.js client.js
npm test         # node --test "test/*.test.mjs"
```

The tests exercise the store, LLM-graded dreaming against a fake LLM service, cache
reuse, awaiting detection, learning calibration, route handlers, and the client's
long-absence aggregation. No DSH profile or browser is required.

## Limits / design notes

- Session content is sampled (first 40 + last 80 events plus a batched title fold and
  the lightweight event index), so turn counts are exact but assistant text can be a
  sample; progress is an estimate, editable by hand.
- Subagent Sessions are excluded from scanning (their parent represents the work).
- Grouping is directory-basename based plus title-token similarity; the popup makes it
  easy to delete or edit a wrong merge.
- Automatic dreaming never marks work `done` and never overwrites a manual-locked field.
- Evaluator quality depends on the selected model; the heuristic fallback is coarser
  but always available.
