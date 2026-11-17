# dsh-reminders — CONTRACT V2 (LLM evaluation, learning, awaiting status)

Delta contract on top of `CONTRACT.md`. The Host half (`index.js`, Lead-owned) is being
rewritten to these shapes. The Client half (`client.js`, teammate-owned) must follow
this document exactly. Do not edit `index.js`, tests, docs, or install the bundle.

Keep the package version at **0.1.0** and do not create tags.

## Product delta

1. Item **title** stays the DSH-generated Session title (unless the user renamed it).
   New item field **`subtitle`** is an LLM-written summary of the Session's progress
   (or, for manual items, a short hand-written summary).
2. **`progress` and `importance` are LLM-evaluated** (the Host can also run a deterministic
   fallback). Users can still edit them; editing marks that field **manual-locked**, and
   the evaluator will not overwrite it. Items expose `manualFields: string[]`
   (`'title' | 'subtitle' | 'progress' | 'importance'`).
3. **Learning**: the Host persists what it learned from the user (free-form notes,
   calibration biases, per-group adjustments, recent feedback signals). That record is
   visible and editable on the plugin Configure page.
4. **Contextual attention**: items carry `attentionScore` (0–100), `attentionReason` (short
   text), `attentionUpdatedAt`. Attention is no longer just time: it considers learned
   preferences, importance/pins, status, pending user asks, and what else is in progress.
   A badge is shown when `attentionScore >= 60`.
5. **Status gains `awaiting`** (“Needs you”): a Session waiting for the user's answer or
   permission. Full status set: `'todo' | 'doing' | 'awaiting' | 'blocked' | 'done'`.
   Items also get `statusNote` (short text, e.g. “Waiting for permission”).

## GET `state` — additions (existing fields stay)

```jsonc
{
  "settings": {
    "dreamEnabled": true,
    "dreamIntervalMinutes": 10,
    "windowHours": 72,
    "staleHours": 24,
    "forgetHours": 72,
    "maxSessions": 12,
    "evalMode": "model",          // 'model' | 'heuristic'
    "evalProvider": "",           // '' means "follow the default model"
    "evalModel": "",
    "evalMaxSessions": 8,         // 1..30, changed Sessions evaluated per pass
    "evalMaxItems": 20            // 0..40, open items re-graded per pass
  },
  "evaluation": {
    "mode": "model",
    "enabled": true,              // mode==='model' and an LLM route resolved
    "provider": "deepseek-official",
    "model": "deepseek-flash",
    "followsDefault": true,       // no explicit override in settings
    "available": true,            // provider registered in this Host
    "lastModel": "deepseek-official/deepseek-flash",  // model used by the latest activity, or null
    "lastDegraded": false         // latest activity fell back to heuristics
  },
  "learning": {
    "updatedAt": 1763000000000,
    "notes": "Free-form guidance the evaluator must follow.",
    "importanceBias": 0,          // -2..2  (added to LLM importance before clamping)
    "progressBias": 0,            // -20..20 (added to LLM progress before clamping)
    "attentionBias": 0,           // -20..20 (added to LLM attention before clamping)
    "groups": [                   // learned per-project adjustments
      { "name": "dsh-reminders", "samples": 12, "importanceBias": 0.4, "attentionBias": 5 }
    ],
    "signals": [                  // newest first, at most 60
      {
        "at": 1763000000000,
        "kind": "importance",     // importance|progress|status|title|subtitle|pin|delete|keep|dismiss
        "itemId": "r-abc",
        "title": "Build the plugin",
        "group": "dsh-reminders",
        "field": "importance",
        "from": 3,
        "to": 5
      }
    ],
    "stats": { "edits": 4, "deletes": 1, "pins": 2, "attentionKept": 3, "attentionDismissed": 1 }
  },
  "items": [ /* existing fields, plus: */
    {
      "subtitle": "Wired the popup; still needs the settings page.",
      "statusNote": "",
      "attentionScore": 72,
      "attentionReason": "Blocked on a permission prompt for two days.",
      "attentionUpdatedAt": 1763000000000,
      "manualFields": ["importance"],
      "lastAutoImportance": 3,
      "lastAutoProgress": 55
    }
  ],
  "modelCatalog": {               // optional passthrough; prefer the models.list action
    "providers": []
  }
}
```

`activities[]` additions: `evaluated` (Sessions evaluated), `graded` (items graded),
`model` (`"provider/model" | null`), `degraded` (bool), `error` may carry the model
failure while the pass still completed heuristically.

## POST `action` — changed / new actions

| action | payload |
|---|---|
| `settings.update` | `{ dreamEnabled?, dreamIntervalMinutes?, windowHours?, maxSessions?, staleHours?, forgetHours?, evalMode?, evalProvider?, evalModel?, evalMaxSessions?, evalMaxItems? }` |
| `item.create` | adds optional `subtitle` |
| `item.update` | `{ id, patch: { title?, subtitle?, notes?, nextStep?, groupId?, status?, progress?, importance?, pinned? } }` — editing title/subtitle/progress/importance adds a manual lock |
| `item.unlock` | `{ id, fields?: ['title','subtitle','progress','importance'] }` — restore auto-grading for those fields (all when omitted) |
| `learning.update` | `{ notes?, importanceBias?, progressBias?, attentionBias?, groups?: [{ name, importanceBias?, attentionBias? }] }` |
| `learning.reset` | `{}` — clear learned notes/biases/signals/stats |
| `learning.clearSignals` | `{}` — keep notes/biases, drop the recent-signal log |
| `models.list` | `{}` → `{ providers: [{ id, name, models: [{ id, name }] }] }` — for the config page selectors; failures return `ok:false` |

Everything else (`item.delete`, `group.create/rename/delete`, `dream.run`, `dream.undo`,
`dream.status`) keeps its shape.

## UI requirements (client.js)

### Statuses / rows / editor

- Add `awaiting` to the client `STATUSES` list, filters, labels (`status.awaiting`), dot
  colour (`--dsw-alias-state-warn-primary`), and the editor's status buttons. Filter chip
  label: `Needs you`. Sentence case everywhere.
- Row: line 1 = status dot + title (+ pin + attention badge). Line 2 = **subtitle**
  (2-line clamp, tertiary); fall back to `nextStep`, then nothing. Meta line keeps
  freshness, progress %, importance stars, session chips; when `attentionScore >= 60`
  add a compact badge (`data-level` high/medium) whose `title`/tooltip is
  `attentionReason`; label `attention.high` / `attention.medium` (e.g. “Attention 72”).
  Show `statusNote` in the row meta when non-empty (e.g. “Waiting for permission”).
- Editor: add **Subtitle** textarea after Title (`editor.subtitle`,
  `editor.subtitlePlaceholder`). Show a read-only “Auto-evaluated” block with attention
  score/reason and, when `manualFields.length > 0`, a line listing the locked fields and
  a **Restore auto-grading** button posting `item.unlock` (`editor.locked`,
  `editor.unlock`, `editor.unlockSuccess`). Keep existing fields/validation/save/delete.

### Configure page (`plugins.row.config`, existing `RemindersConfig`)

Keep existing dreaming controls and the state-directory footer. Add two sections below
the existing rows (same `.dshr-config*` styling family; add classes as needed):

1. **Evaluation** (`config.evaluationTitle`, `config.evaluationHint`):
   - Mode: segmented control Model / Heuristic (`config.modeModel`, `config.modeHeuristic`)
     posting `settings.update { evalMode }`.
   - Provider select + Model select populated from `models.list` (on mount, retry button
     on failure). Choices include a “Follow default” option
     (`config.followDefault`, value `''`) posting `evalProvider`/`evalModel` together
     (clearing both). Disable the selects in heuristic mode; show resolved route line
     (`config.resolvedRoute` `{provider}/{model}` or `config.noModel`).
   - `Sessions evaluated per pass` (`config.evalMaxSessions`) and
     `Open items graded per pass` (`config.evalMaxItems`) selects/steppers.
   - A line showing the last activity's model or that the last pass was heuristic
     (`config.lastEvaluated`).
2. **Learned preferences** (`config.learningTitle`, `config.learningHint`):
   - Notes textarea (`config.learningNotes`, placeholder) and a Save button posting
     `learning.update { notes }` (also save on blur is fine; show `config.saved`).
   - Three labelled sliders/number inputs for `importanceBias` (-2..2 step 0.1),
     `progressBias` (-20..20), `attentionBias` (-20..20), saved with the same action.
   - Learned groups table/list (top ≤ 6 by `samples`): name, samples, editable
     `importanceBias`/`attentionBias` number inputs, posted via
     `learning.update { groups: [{ name, importanceBias, attentionBias }] }`.
   - Recent signals list (kind, title, `from → to`, relative time), max 8, read-only.
   - Buttons: `Clear signals` (`learning.clearSignals`) and `Reset learned preferences`
     (`learning.reset`, two-step confirm). Show errors inline; never crash.

### Locale

Add every new key to **both** `DICT_EN` and `DICT_ZH` (identical key sets, namespaced
flat dotted keys). Existing keys must keep working. All new visible text localized.

### Constraints (unchanged)

- Plain JS, `require('react')` only, single `window.__ModuleLoader__.load` factory.
- No `@deepseek-ai/*` imports. Styles only through `--dsw-*` tokens, one `<style>` in `apply`.
- Defensive rendering (host may be unavailable), hooks only at top level.
- Keep the existing popup behavior (top-edge countdown bar, hover/focus/page-blur pause,
  fade-away, running dismissal, unseen aggregation) intact. Popup change rows may show
  `change.detail`, which the Host now fills with subtitle/attention reasons.

## Verification you must do

1. `node --check client.js`.
2. No `@deepseek-ai/`, no literal colours, no `document.body`.
3. Extract `DICT_EN` / `DICT_ZH` (see `test/client-aggregate.test.mjs` technique) and
   prove identical flat key sets; every `t('...')` literal key exists.
4. Re-read for hook order and null guards.
5. Report: line count, new components/sections, new locale keys, actions used, and any
   deviation from this contract. Only `client.js` may change.
