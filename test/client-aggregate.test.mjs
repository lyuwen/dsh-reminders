/**
 * Unit tests for the Client's long-absence aggregation helper. The helper lives
 * inside the browser module (a single `__ModuleLoader__` factory), so this test
 * extracts the pure function source and evaluates it with its tiny utilities.
 * This verifies the "no stacking notifications" contract without a browser.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Extract one top-level `function name(...) { ... }` declaration source. */
function extract(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `client.js is missing function ${name}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const factory = new Function(
  `${extract('str')}\n${extract('isObject')}\n${extract('num')}\n${extract('unseenFeed')}\nreturn unseenFeed;`
)
const unseenFeed = factory()

/** One settled activity fixture. */
function activity(id, endedAt, extra = {}) {
  return {
    id,
    status: 'done',
    startedAt: endedAt - 500,
    endedAt,
    scanned: 2,
    created: 1,
    updated: 1,
    attention: 0,
    changes: [{ itemId: `r-${id}`, title: `Title ${id}`, kind: 'created', detail: id }],
    undoable: true,
    ...extra,
  }
}

test('unseenFeed shows a single unseen run as itself', () => {
  const run = activity('a1', 2000)
  const feed = unseenFeed({ dream: { activity: null, rollup: null }, activities: [run] }, 0)
  assert.equal(feed.running, null)
  assert.equal(feed.activity, run)
})

test('unseenFeed ignores everything already seen', () => {
  const feed = unseenFeed({ dream: { activity: null, rollup: null }, activities: [activity('a1', 2000)] }, 5000)
  assert.equal(feed.activity, null)
})

test('unseenFeed returns the live running pass and can be suppressed', () => {
  const running = { id: 'run-1', status: 'running', startedAt: 3000, scanned: 1 }
  const data = { dream: { activity: running, rollup: null }, activities: [] }
  assert.equal(unseenFeed(data, 0).running, running)
  const suppressed = unseenFeed(data, 0, 'run-1')
  assert.equal(suppressed.running, null)
})

test('unseenFeed aggregates many unseen runs into one non-stackable feed', () => {
  const runs = [activity('a3', 6000), activity('a2', 5000), activity('a1', 4000)]
  const feed = unseenFeed({ dream: { activity: runs[0], rollup: null }, activities: runs }, 1000)
  const aggregate = feed.activity
  assert.equal(feed.running, null)
  assert.equal(aggregate.aggregated, true)
  assert.equal(aggregate.runs, 3)
  assert.equal(aggregate.created, 3)
  assert.equal(aggregate.updated, 3)
  assert.equal(aggregate.undoable, false)
  assert.equal(aggregate.seenThrough, 6000)
  assert.equal(aggregate.changes.length, 3)
})

test('unseenFeed merges the rollup and dedupes changes by item', () => {
  const rollup = {
    startedAt: 1000, endedAt: 3000, runs: 4, created: 1, updated: 3, attention: 1,
    changes: [{ itemId: 'shared', title: 'Shared older', kind: 'updated', detail: 'old' }],
  }
  const latest = activity('a9', 9000, {
    created: 0,
    updated: 1,
    attention: 0,
    changes: [{ itemId: 'shared', title: 'Shared newer', kind: 'updated', detail: 'new' }],
  })
  const feed = unseenFeed({ dream: { activity: latest, rollup }, activities: [latest] }, 500)
  const aggregate = feed.activity
  assert.equal(aggregate.aggregated, true)
  assert.equal(aggregate.runs, 5)
  assert.equal(aggregate.created, 1)
  assert.equal(aggregate.updated, 4)
  assert.equal(aggregate.attention, 1)
  assert.equal(aggregate.changes.length, 1)
  assert.equal(aggregate.changes[0].title, 'Shared newer')
})

test('unseenFeed skips undone activities', () => {
  const feed = unseenFeed({ dream: { activity: null, rollup: null }, activities: [activity('a1', 2000, { undone: true })] }, 0)
  assert.equal(feed.activity, null)
})

test('unseenFeed counts distinct attention items, not one per dreaming pass', () => {
  const runs = [
    activity('a1', 2000, { created: 0, updated: 0, attention: 1, changes: [{ itemId: 'forgotten', title: 'F', kind: 'attention', detail: 'No activity for 3 days' }] }),
    activity('a2', 3000, { created: 0, updated: 0, attention: 1, changes: [{ itemId: 'forgotten', title: 'F', kind: 'attention', detail: 'No activity for 3 days' }] }),
    activity('a3', 4000, { created: 0, updated: 0, attention: 2, changes: [
      { itemId: 'forgotten', title: 'F', kind: 'attention', detail: 'No activity for 3 days' },
      { itemId: 'other', title: 'O', kind: 'attention', detail: 'No activity for 4 days' },
    ] }),
  ]
  const feed = unseenFeed({ dream: { activity: runs[0], rollup: null }, activities: runs }, 0)
  assert.equal(feed.activity.runs, 3)
  assert.equal(feed.activity.attention, 2)
  assert.equal(feed.activity.created, 0)
  assert.equal(feed.activity.updated, 0)
})
