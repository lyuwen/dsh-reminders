# dsh-reminders — build contract

Single shared source of truth for the build. Host = `index.js` (Lead-owned).
Client = `client.js` (client-ui teammate-owned). Do not edit files outside your scope.

## Product

A DSH plugin that keeps a **reminder list of what the user is developing**:

- Left sidebar entry (panellist icon) opens a full main-column **Reminders** panel.
  The panel is maintained manually (create/edit/delete/group/pin/status/progress/
  importance) and by a **Dreaming mode**.
- Dreaming mode periodically scans recently accessed Sessions, derives work
  summaries deterministically (titles, last user/assistant text, tools, errors,
  turn state, project directories), and adds/updates reminder items, grouped by
  project. It shows a **top-right popup notification** describing what it is doing
  and its proposed result; the user may Edit or Delete each affected item, Undo the
  run, or Dismiss. Not intervening accepts the result.
- Every item carries **freshness** (computed), **importance** (1–5, manual),
  **progress** (0–100), **status**, linked Sessions, and a next step.

Package name: `dsh-reminders-plugin`. Host row id: `reminders`.
Client module id: `dsh-reminders-plugin`. Locale namespace: `reminders`.

## Files (Lead writes unless marked)

```
package.json          Lead
cordis.patch.yml      Lead
index.js              Lead  (Host plugin + HTTP routes + agent tool + dream engine)
client.js             CLIENT-UI  (browser module; the only file you write)
locale/en.json        Lead
locale/zh.json        Lead
icon.svg              Lead
README.md             Lead
```

## Client module shape (copy the installed decoration pattern)

`client.js` is plain JS, evaluated in the browser by `window.__ModuleLoader__.load`:

```js
window.__ModuleLoader__.load({
  id: 'dsh-reminders-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // module scope: API helper, tiny external store, components
    return {
      inject: ['slots', 'locale', 'layout', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('reminders', { en: DICT_EN, zh: DICT_ZH }));
        const t = ctx.locale.bind('reminders');
        // one <style> tag via ctx.effect with removal cleanup
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'reminders', locale: 'reminders' }, RemindersPage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'reminders', order: 20, locale: 'reminders', label: () => t('panel') }, RemindersIcon));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'reminders-dream', order: 100, locale: 'reminders' }, DreamToast));
      },
    };
  },
});
```

Rules:
- Only `require('react')` (and optionally `require('react/jsx-runtime')`). **Never**
  import any `@deepseek-ai/*` package; no JSX build step; use `h(...)`.
- No DOM writes except the one `<style>` tag installed in `apply` via `ctx.effect`.
  Everything else renders through slots. Do not touch `document.body`.
- Colors only through `--dsw-alias-*` / `--dsw-*` theme tokens (list below).
  No literal color values anywhere (the panellist icon uses `currentColor`).
- Sentence-case UI text. All visible strings go through the locale dictionaries
  (`t('key')`); provide `en` and `zh` complete dictionaries (zh may mirror en key set
  with Chinese values). Namespace keys are flat dotted strings, e.g. `t('panel')`,
  `t('editor.save')`.
- The panellist icon component receives `{ size, active }` and must return the SVG
  as the row's direct icon child (`width/height = size`, `aria-hidden`, no wrapper).
- Keep components crash-free: guard every nullable field, never throw during render.

## Host API (already implemented by Lead)

Base URL for fetch: `new URL('api/dsh-reminders/', document.baseURI)`.
Use `fetch(url, { credentials: 'same-origin', headers... })`. Endpoint paths are
`api/dsh-reminders/state` (GET) and `api/dsh-reminders/action` (POST JSON).

### GET `state` → 200 JSON

```jsonc
{
  "ok": true,
  "revision": 7,
  "now": 1763000000000,
  "settings": {
    "dreamEnabled": true,
    "dreamIntervalMinutes": 10,
    "windowHours": 72,
    "staleHours": 24,
    "forgetHours": 72
  },
  "groups": [
    { "id": "g-abc", "name": "dsh-reminders", "createdAt": 1763000000000 }
  ],
  "items": [
    {
      "id": "r-abc",
      "title": "Build the DSH reminders plugin",
      "notes": "",
      "nextStep": "Wire the dreaming popup actions",
      "groupId": "g-abc",
      "status": "doing",              // 'todo' | 'doing' | 'blocked' | 'done'
      "progress": 55,
      "importance": 3,               // 1..5
      "pinned": false,
      "source": "dream",             // 'manual' | 'dream'
      "autoManaged": true,
      "sessionIds": ["session-..."],
      "sessions": [{ "id": "session-...", "title": "...", "lastTouched": 1763000000000 }],
      "createdAt": 1763000000000,
      "updatedAt": 1763000000000,
      "lastTouched": 1763000000000,
      "freshness": "fresh"           // 'fresh' | 'warm' | 'stale' | 'cold' (host-computed)
    }
  ],
  "activities": [ /* newest first, at most 5 */ ],
  "dream": {
    "enabled": true,
    "intervalMinutes": 10,
    "running": false,
    "nextRunAt": 1763000600000,
    "lastRunAt": 1763000000000,
    "activity": { /* latest activity or null, same shape as activities[0] */ },
    "rollup": {                    // null, or the older runs folded into one aggregate
      "startedAt": 1762990000000,
      "endedAt": 1762995000000,
      "runs": 4,
      "created": 3,
      "updated": 6,
      "attention": 1,
      "changes": [ /* same change shape; one row per item, latest wins */ ]
    }
  }
}
```

Retention / no stacking: the Host keeps the latest 12 activities and folds older
ones into `dream.rollup` (one row per item). The Client remembers the last timestamp
the user actually saw (`localStorage` key `dshr:lastSeenAt`) and reconstructs the set
of unseen results on every load/refocus: one unseen run shows as itself, two or more
show as a single aggregated "while you were away" popup with `changes` merged by
item id, and `dream.activity` is shown live while a pass is running. Dismissing or
letting the popup auto-dismiss advances the watermark.

Activity:

```jsonc
{
  "id": "a-abc",
  "status": "running",            // 'running' | 'done' | 'error'
  "startedAt": 1763000000000,
  "endedAt": 1763000004000,        // absent while running
  "scanned": 8,
  "created": 2,
  "updated": 3,
  "attention": 1,
  "summary": "Scanned 8 sessions · 2 new · 3 updated · 1 needs attention",
  "error": "optional message when status is error",
  "undoable": true,                // true only for the latest run that changed state
  "changes": [
    { "itemId": "r-abc", "title": "...", "kind": "created" | "updated" | "attention" | "grouped", "detail": "short one-line reason" }
  ]
}
```

### POST `action` — body `{ "action": string, "payload": object }` → 200 JSON

Always HTTP 200; check `body.ok`. Success: `{ "ok": true, "value": <any> }`.
Failure: `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
After any mutating action, re-fetch state (or optimistically merge and refetch).

Actions (payload fields are exact; `item.update.patch` may contain any of the item
fields except `id`/`createdAt`/`source`/`sessionIds`):

| action | payload |
|---|---|
| `item.create` | `{ title, notes?, nextStep?, groupId?, status?, progress?, importance?, pinned? }` |
| `item.update` | `{ id, patch: { title?, notes?, nextStep?, groupId?, status?, progress?, importance?, pinned? } }` |
| `item.delete` | `{ id }` |
| `group.create` | `{ name }` → `{ ok:true, value:{ id, name } }` |
| `group.rename` | `{ id, name }` |
| `group.delete` | `{ id }` (items move to the default "General" group) |
| `dream.run` | `{}` → `{ ok:true, value:{ started:true } }` (async; poll state) |
| `dream.undo` | `{ activityId }` |
| `settings.update` | `{ dreamEnabled?, dreamIntervalMinutes?, windowHours? }` |

`value` for `item.create`/`item.update` is the updated item view (same shape as GET
items). Errors use codes like `invalid`, `not_found`, `busy`.

## UI requirements (client.js)

### 1. `RemindersPage` (main slot)

Host-style management page (Plugin Manager / Schedule page look). Layout:
- Page header: title `t('panel')` ("Reminders"), subtitle line with dreaming status
  (`Dreaming on · every 10 min · last run 3m ago` / `off`), right-side actions:
  `New reminder`, `Dream now` (disabled/spinner while running), dreaming on/off
  toggle (`role="switch"`, `aria-checked`), interval `<select>` or number input
  (1/5/10/15/30/60 min) posting `settings.update`.
- Toolbar: search input, status filter chips (`All`, `todo`, `doing`, `blocked`,
  `done`), and a compact freshness legend is optional.
- Body: grouped list. Each group is a section with group name, item count, and a
  rename/delete affordance (small "..." menu is fine; or two icon buttons). Within a
  group order: pinned first, then importance desc, then `lastTouched` desc.
- Each row: status dot/glyph, title, next-step line (tertiary, clamped), meta line
  (`freshness chip` · `progress%` · `importance` as ★), linked session chips.
  Clicking a row selects it and opens the editor pane; clicking a session chip calls
  `ctx.uiWorkspace.openSession(sessionId)` (stopPropagation).
- Editor pane (right column, ~380px, border-left, scrolls): fields title (input),
  status (segmented buttons), progress (`input[type=range]` 0–100 + % label),
  importance (1–5 stars, buttons), group (`select` from groups + "New group…"
  inline create), next step (textarea), notes (textarea), linked Sessions list
  (chips + open), footer: `Save`, `Delete`, `Cancel`. Validation: title required,
  trimmed, ≤200 chars; show an inline error. Save posts `item.update`; new item posts
  `item.create`; Delete confirms inline (two-step) then posts `item.delete`.
- Empty state when there are no items: short explanation + `New reminder` button.
- Unavailable state if the host fetch fails: small inline notice "Reminders host
  unavailable" with a Retry button; never crash.

State handling: one module-level polling store (poll GET state every 2500 ms; also
refetch immediately after actions). Share it between `RemindersPage` and
`DreamToast` with a subscribe/snapshot pair and `React.useSyncExternalStore`
(fallback: `useState` + `useEffect`). Avoid re-notifying subscribers when the JSON
payload is unchanged (compare a serialized revision or string). Stop the interval
when the last subscriber unmounts.

Edit-from-popup bridge: module-level `requestEdit(itemId)` that sets the selected
item + a monotonically increasing token; `RemindersPage` subscribes and, when the
token changes, selects the item, calls `ctx.layout.selectPanel('reminders')` (already
selected in practice) and puts the editor in edit mode.

### 2. `DreamToast` (shell.overlay)

Fixed top-right popup (`position: fixed`, top/right ~16px, width 340–380px, max
height ~60vh, `pointer-events: auto`, z-index below menus but above content, panel
elevation, themed background/border/radius). Only rendered when
`state.dream.activity` exists and its `id` is not in `localStorage` under
`dshr:dismissed:<id>`.
- A slim **auto-dismiss progress bar** along the popup's top edge: indeterminate
  while a run is in progress, otherwise a countdown (`12 s`) whose width shrinks;
  when it reaches zero the popup fades out and the watermark advances.
- The countdown pauses while the popup is hovered, while it contains keyboard
  focus, and while the page/window itself is not focused (`blur` /
  `visibilitychange`); it resumes where it left off.
- Running: spinner/pulse dot + `Dreaming…` + `Scanned N sessions` progress line
  (use `activity.scanned` while running when available; a simple indeterminate line
  is fine).
- Done: title `Dreaming finished` (or `Dreaming found nothing`), summary line,
  up to 5 change rows (`kind` badge + title + detail) each with `Edit` and `Delete`
  ghost buttons, then footer: `Undo` (only if `activity.undoable`), `Open list`,
  `Dismiss`.
- Error: title `Dreaming failed`, error text, `Dismiss` + `Retry` (posts
  `dream.run`).
- Dismiss (× or footer) and auto-fade both hide immediately and advance
  `dshr:lastSeenAt` to the shown run's `endedAt`; while a run is in progress the
  popup is dismissible too (the pass is suppressed until a new run starts, and its
  finished result still surfaces). Nothing stacks while the page is unfocused
  because every unseen run is collapsed by `unseenFeed`.
- Aggregated view: title `While you were away`, body shows `runs` plus summed
  created/updated/attention, same change rows; no Undo (only the latest run is
  undoable server-side).
- "Edit" → `requestEdit(itemId)` + open panel; "Delete" → `item.delete` then
  refetch; "Undo" → `dream.undo` then refetch; "Open list" → `ctx.layout.selectPanel('reminders')`.
- New activity ids appear on poll without a manual dismiss of older ones.

### 3. `RemindersIcon` (sidebar.panellist)

Inline SVG ~16–20px using `currentColor`, a checklist/bell with a small sparkle
(dreaming) motif; `props.size` square; direct child, no wrapper div around the svg.
Accessible label comes from the sidebar (do not add aria-label).

## Theme tokens available (use these only)

Colors: `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`,
`--dsw-alias-label-tertiary`, `--dsw-alias-label-caption`,
`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
`--dsw-alias-bg-layer-3`, `--dsw-alias-bg-module-platform`,
`--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-border-l3`,
`--dsw-alias-border-l4`, `--dsw-alias-interactive-bg-hover`,
`--dsw-alias-interactive-bg-active`, `--dsw-alias-interactive-bg-hover-danger`,
`--dsw-alias-state-business-primary`, `--dsw-alias-state-success-primary`,
`--dsw-alias-state-warn-primary`, `--dsw-alias-state-error-primary`,
`--dsw-alias-brand-primary`, `--dsw-alias-link`,
`--dsw-alias-button-primary-fill`, `--dsw-alias-button-primary-hover`,
`--dsw-alias-scrollbar-bg-l2`, `--dsw-alias-scrollbar-hover-l2`.
Elevation/radius/focus: `--dsw-elevation-panel`, `--dsw-elevation-stroke`,
`--dsw-radius-sm|md|lg|xl`, `--dsw-focus-ring-color`, `--dsw-focus-ring-width`.
Typography: `--dsw-font-family`; use px sizes 12/13/14/20 consistent with host pages.

Copied host reference snippets (read them yourself for exact CSS patterns):
`dsh-client-ui-schedule/lib/client.js` (search `t-XoWW_page`),
`dsh-client-ui-plugin-manager/lib/client.js`. Style with one global `<style>` block
placed by `apply` via `ctx.effect`; class prefix `dshr-`. Keep all selectors under
`.dshr-` classes. Include `:focus-visible` outlines and `@media (hover:hover)`
hover rules, matching host behavior.

## Verification you must do before reporting

1. `node --check client.js` exits 0.
2. No `@deepseek-ai/` require, no literal color (`#`, `rgb(`, named colors) outside
   the SVG icon (icon may use `currentColor` only).
3. Every `t('...')` key exists in both dictionaries; both dictionaries have equal
   key sets.
4. Re-read your file end-to-end for null guards and React hook rules (hooks only at
   top level of components, same order).
Report: file size/lines, component list, keys added, and any place you deviated
from this contract. Do not install the bundle or run `plugin_manager`.
