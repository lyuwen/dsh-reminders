/**
 * Unit tests for the dsh-reminders Host half: pure helpers, the durable store,
 * and the dreaming engine against a fake read-only Session corpus. No DSH
 * profile, plugin install, or browser is required.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  DreamEngine,
  ReminderStore,
  analyzeEvents,
  deriveFreshness,
  dispatchAction,
  groupKey,
  jaccard,
  serveActionRequest,
  serveStateRequest,
  tokenize,
  toLosslessJson,
} from '../index.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** @returns {{header: object, revision: string, eventCount: number}} */
function snapshotFor(id, events, cwd) {
  const first = events[0]
  return {
    header: {
      version: 1,
      id,
      createdAt: first?.time ?? Date.now(),
      cwd,
      isSeeded: false,
    },
    revision: '1',
    eventCount: events.length,
  }
}

/** Build a fake read handle over a fixed event list. */
function handleFor(events) {
  return {
    id: 'fake',
    async read(offset = 0, length) {
      const end = typeof length === 'number' ? offset + length : events.length
      return { eventState: 'detached', events: events.slice(offset, end) }
    },
    async flush() {},
    async close() {},
  }
}

/** A ctx whose optional Session services resolve to provided fakes. */
function fakeCtx({ sessions = [], snapshots = [], events = new Map(), titles = new Map() } = {}) {
  const persistence = {
    async list() {
      return snapshots
    },
    async open(id) {
      const list = events.get(id)
      if (!list) throw new Error(`no such session ${id}`)
      return handleFor(list)
    },
  }
  const query = {
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => {
        const title = titles.get(sessionId)
        return title
          ? { sessionId, status: 'fulfilled', value: { session: { id: sessionId }, title: { title, eventSeq: 1, updatedAt: Date.now(), messageSeqs: [], source: { kind: 'fallback' } } } }
          : { sessionId, status: 'fulfilled', value: { session: { id: sessionId }, title: undefined } }
      })
    },
  }
  const sessionsService = {
    list() {
      return sessions
    },
  }
  return {
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessionQuery') return query
      if (name === 'sessions') return sessionsService
      return undefined
    },
    logger: { warn() {} },
  }
}

/** Build one synthetic user message event (message fields sit directly on data). */
function userMessage(seq, time, text, kind = 'user') {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      id: `m-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: kind === 'user' ? { kind: 'user' } : { kind, form: 'snapshot' },
    },
    surfaceOp: 'append',
  }
}

/** Build one synthetic assistant message event. */
function assistantMessage(seq, time, text) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { id: `m-${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    },
    surfaceOp: 'append',
  }
}

/** Build one synthetic turn start/end pair helper. */
function turnStart(seq, time, turn = 1) {
  return { type: 'turn/start', seq, time, data: { turn } }
}

function turnEnd(seq, time, kind = 'completed', turn = 1) {
  return { type: 'turn/end', seq, time, data: { turn, reason: { kind } } }
}

let workDir
before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dsh-reminders-test-'))
})
after(async () => {
  await rm(workDir, { recursive: true, force: true })
})

test('freshness buckets follow stale/forget settings', () => {
  const settings = { staleHours: 24, forgetHours: 72 }
  const now = 1_000_000_000
  assert.equal(deriveFreshness(now - HOUR, settings, now), 'fresh')
  assert.equal(deriveFreshness(now - 5 * HOUR, settings, now), 'warm')
  assert.equal(deriveFreshness(now - 30 * HOUR, settings, now), 'stale')
  assert.equal(deriveFreshness(now - 100 * HOUR, settings, now), 'cold')
})

test('tokenize and jaccard group similar titles', () => {
  assert.ok(jaccard(tokenize('Build the DSH reminders plugin'), tokenize('Build DSH reminders plugin')) >= 0.5)
  assert.ok(jaccard(tokenize('Build the DSH reminders plugin'), tokenize('Refactor turbofan shader')) < 0.2)
  assert.equal(groupKey('DSH Reminders'), 'dsh-reminders')
  assert.equal(groupKey(''), 'general')
})

test('analyzeEvents derives title, text, tools, errors and state', () => {
  const events = [
    userMessage(0, 1000, 'Build the plugin'),
    { type: 'tool/call', seq: 1, time: 2000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', seq: 2, time: 3000, data: { turn: 1, step: 1, message: { id: 'm', role: 'tool', content: [], source: { kind: 'tool', callId: 'c1' } }, error: { name: 'E', code: 'X', reason: 'boom' } } },
    assistantMessage(3, 4000, 'Working on it'),
    turnEnd(4, 5000, 'completed'),
  ]
  const info = analyzeEvents(events)
  assert.equal(info.firstUserText, 'Build the plugin')
  assert.equal(info.lastUserText, 'Build the plugin')
  assert.equal(info.lastAssistantText, 'Working on it')
  assert.deepEqual(info.tools, ['bash'])
  assert.equal(info.lastError, 'boom')
  assert.equal(info.turnEnds, 1)
  assert.equal(info.state, 'settled')
})

test('analyzeEvents reports blocked and working states', () => {
  assert.equal(analyzeEvents([turnEnd(4, 10, 'error')]).state, 'blocked')
  assert.equal(analyzeEvents([userMessage(0, 10, 'go')]).state, 'working')
})

test('store CRUD, persistence round-trip, and group deletion reassignment', async () => {
  const dir = join(workDir, 'crud')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  await store.ready
  const group = store.createGroup('My Project')
  const item = store.createItem({ title: 'Ship the reminder panel', groupId: group.id, importance: 4 })
  assert.equal(item.source, 'manual')
  assert.equal(item.status, 'todo')
  const updated = store.updateItem(item.id, { status: 'doing', progress: 40, nextStep: 'Wire the routes' })
  assert.equal(updated.progress, 40)
  await store.persist()

  const reloaded = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  await reloaded.ready
  assert.equal(reloaded.state.items.length, 1)
  assert.equal(reloaded.state.items[0].nextStep, 'Wire the routes')
  assert.equal(reloaded.state.groups.length, 2) // default General + My Project

  const result = reloaded.deleteGroup(resultGroupIdFor(reloaded, 'My Project'))
  assert.ok(result.movedTo)
  assert.equal(reloaded.state.items[0].groupId, result.movedTo)

  reloaded.deleteItem(reloaded.state.items[0].id)
  assert.equal(reloaded.state.items.length, 0)
})

/** Test helper: resolve a group id by name. */
function resultGroupIdFor(store, name) {
  return store.state.groups.find((group) => group.name === name).id
}

test('dispatchAction rejects invalid operations without throwing to the route', async () => {
  const dir = join(workDir, 'dispatch')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  const engine = new DreamEngine(store, fakeCtx())
  await store.ready
  await assert.rejects(
    () => dispatchAction(store, engine, 'item.create', { title: '   ' }),
    (error) => error.code === 'invalid',
  )
  const ok = await dispatchAction(store, engine, 'item.create', { title: 'Doc pass' })
  assert.equal(ok.ok, true)
  await assert.rejects(
    () => dispatchAction(store, engine, 'nope', {}),
    (error) => error.code === 'invalid',
  )
})

test('dreaming creates grouped items from recent Sessions and undoes cleanly', async () => {
  const dir = join(workDir, 'dream')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  const now = Date.now()
  const firstSession = [
    userMessage(0, now - 2 * HOUR, 'Build the DSH reminders plugin'),
    assistantMessage(1, now - 2 * HOUR + 1000, 'Implemented the host store'),
    turnEnd(2, now - 2 * HOUR + 2000, 'completed'),
  ]
  const secondSession = [
    userMessage(0, now - HOUR, 'Fix the turbofan shader'),
    turnEnd(1, now - HOUR + 500, 'completed'),
  ]
  const ctx = fakeCtx({
    snapshots: [
      snapshotFor('session-a', firstSession, '/home/me/git/dsh-reminders'),
      snapshotFor('session-b', secondSession, '/home/me/git/turbofan'),
    ],
    events: new Map([['session-a', firstSession], ['session-b', secondSession]]),
    titles: new Map([['session-a', 'Build DSH reminders'], ['session-b', 'Turbofan shader fix']]),
  })
  const engine = new DreamEngine(store, ctx)
  const activity = await engine.run({ trigger: 'test' })
  assert.equal(activity.status, 'done')
  assert.equal(activity.created, 2)
  assert.equal(store.state.items.length, 2)
  const names = store.state.groups.map((group) => group.name).sort()
  assert.deepEqual(names, ['General', 'dsh-reminders', 'turbofan'])
  const byTitle = new Map(store.state.items.map((item) => [item.title, item]))
  assert.ok(byTitle.has('Build DSH reminders'))
  assert.ok(byTitle.has('Turbofan shader fix'))
  assert.equal(byTitle.get('Build DSH reminders').nextStep, 'Build the DSH reminders plugin')
  assert.equal(activity.undoable, true)

  // A second run must merge into existing items instead of duplicating them.
  const grown = [...firstSession, userMessage(3, now - 600_000, 'Add the popup'), assistantMessage(4, now - 590_000, 'Popup wired'), turnEnd(5, now - 580_000, 'completed')]
  const ctx2 = fakeCtx({
    snapshots: [snapshotFor('session-a', grown, '/home/me/git/dsh-reminders')],
    events: new Map([['session-a', grown]]),
    titles: new Map([['session-a', 'Build DSH reminders']]),
  })
  const engine2 = new DreamEngine(store, ctx2)
  const second = await engine2.run({ trigger: 'test' })
  assert.equal(second.created, 0)
  assert.equal(second.updated, 1)
  assert.equal(store.state.items.length, 2)

  const undo = await dispatchAction(store, engine2, 'dream.undo', { activityId: second.id })
  assert.equal(undo.ok, true)
  assert.equal(store.state.items.length, 2)
})

test('dreaming flags forgotten items as attention', async () => {
  const dir = join(workDir, 'attention')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  await store.ready
  const old = store.createItem({ title: 'Old forgotten branch', status: 'doing' })
  old.lastTouched = Date.now() - 5 * DAY
  const engine = new DreamEngine(store, fakeCtx())
  await engine.run({ trigger: 'test' })
  const latest = store.state.activities[0]
  assert.equal(latest.attention, 1)
  assert.ok(latest.changes.some((change) => change.kind === 'attention' && change.itemId === old.id))
  // The forgotten item's status is untouched; freshness carries the signal.
  assert.equal(store.state.items.find((item) => item.id === old.id).status, 'doing')
})

test('session-query refinement recovers the latest user request and exact turn count', async () => {
  const dir = join(workDir, 'refine')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  const now = Date.now()
  // A long running turn: the sampled first 40 + last 80 events contain no user
  // message at all, so only the event index can recover the last request.
  const events = [turnStart(0, now - HOUR)]
  for (let index = 1; index <= 120; index += 1) {
    events.push({ type: 'step/start', seq: index, time: now - HOUR + index * 100, data: { turn: 1, step: index } })
  }
  // The only user message sits in the middle: outside the first-40 and last-80
  // sample windows, so only the event index can recover it.
  events.push(userMessage(121, now - HOUR + 12_100, 'Ship the refined scanner'))
  for (let index = 122; index <= 200; index += 1) {
    const event = { type: 'step/start', seq: index, time: now - HOUR + index * 100, data: { turn: 1, step: index } }
    // A later context-sourced user event must not become the work's next step.
    events.push(index === 190 ? userMessage(index, event.time, 'Time sampled while preparing a step', 'time-context') : event)
  }
  events.push({ type: 'tool/call', seq: 201, time: now - 1000, data: { turn: 1, step: 200, callId: 'c1', name: 'bash', arguments: '{}' } })
  const records = events.map((event) => ({ sessionId: 'session-long', seq: event.seq, type: event.type, time: event.time, surface: 'current' }))
  events.push(turnEnd(202, now - 500, 'completed', 1))
  records.push({ sessionId: 'session-long', seq: 202, type: 'turn/end', time: now - 500, surface: 'current' })

  const persistence = {
    async list() {
      return [snapshotFor('session-long', events, '/home/me/git/long-turn')]
    },
    async open() {
      return handleFor(events)
    },
  }
  const query = {
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { session: { id: sessionId }, title: undefined } }))
    },
    async listEvents() {
      return records
    },
    async readEvent(request) {
      return {
        session: { id: request.sessionId },
        inheritedEventCount: 0,
        target: userMessage(300, now - 2 * 3_600_000, 'Ship the refined scanner'),
        events: [],
        startSeq: 300,
        endSeq: 300,
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessionQuery') return query
      if (name === 'sessions') return { list: () => [] }
      return undefined
    },
    logger: { warn() {} },
  }
  const engine = new DreamEngine(store, ctx)
  const activity = await engine.run({ trigger: 'test' })
  assert.equal(activity.status, 'done')
  assert.equal(activity.created, 1)
  const item = store.state.items[0]
  assert.equal(item.nextStep, 'Ship the refined scanner')
  assert.equal(item.groupId, store.state.groups.find((group) => group.name === 'long-turn').id)
  assert.ok(store.state.activities[0].summary.includes('Scanned 1 session'))
})

test('dropped activities roll up into one aggregate instead of stacking', async () => {
  const dir = join(workDir, 'rollup')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  await store.ready
  const now = Date.now()
  store.state.activityRollup = null
  // Activities are newest-first; the tail (oldest) is what gets rolled up.
  store.state.activities = Array.from({ length: 15 }, (_, index) => ({
    id: `a-${index}`,
    status: 'done',
    startedAt: now - index * 1000,
    endedAt: now - index * 1000 + 500,
    scanned: 2,
    created: index === 0 ? 1 : 0,
    updated: index > 0 ? 1 : 0,
    attention: 0,
    changes: [{ itemId: 'r-1', title: 'T', kind: 'updated', detail: `d${index}` }],
  }))
  store.pruneActivities()
  assert.equal(store.state.activities.length, 12)
  const rollup = store.state.activityRollup
  assert.equal(rollup.runs, 3)
  assert.equal(rollup.changes.length, 1) // one row per item, not per run
  assert.equal(rollup.changes[0].detail, 'd12')
  const snapshot = store.snapshot()
  assert.equal(snapshot.dream.rollup.runs, 3)
  assert.ok(snapshot.dream.rollup.endedAt > 0)
  // The aggregated record has no undo snapshot and no stacked activity list.
  assert.equal(snapshot.activities.length, 12)
})

test('state and action route handlers answer the browser contract', async () => {
  const dir = join(workDir, 'routes')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  const engine = new DreamEngine(store, fakeCtx())
  await store.ready

  const state = await serveStateRequest(store, new Request('http://local/api/dsh-reminders/state', { method: 'GET' }))
  assert.equal(state.status, 200)
  assert.equal(state.headers.get('cache-control'), 'no-store')
  const payload = await state.json()
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.items))
  assert.ok(Array.isArray(payload.groups))
  assert.equal(payload.dream.enabled, true)

  const head = await serveStateRequest(store, new Request('http://local/api/dsh-reminders/state', { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')

  const created = await serveActionRequest(store, engine, new Request('http://local/api/dsh-reminders/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'item.create', payload: { title: 'Route-created reminder', importance: 2 } }),
  }))
  assert.equal(created.status, 200)
  const createdBody = await created.json()
  assert.equal(createdBody.ok, true)
  assert.equal(createdBody.value.title, 'Route-created reminder')
  assert.equal(store.state.items.length, 1)

  const badJson = await serveActionRequest(store, engine, new Request('http://local/api/dsh-reminders/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  }))
  const badJsonBody = await badJson.json()
  assert.equal(badJsonBody.ok, false)
  assert.equal(badJsonBody.error.code, 'invalid')

  const unknown = await serveActionRequest(store, engine, new Request('http://local/api/dsh-reminders/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'not.an.action' }),
  }))
  const unknownBody = await unknown.json()
  assert.equal(unknownBody.ok, false)
  assert.equal(unknownBody.error.code, 'invalid')
})

test('tool values are lossless JSON even when views carry undefined fields', () => {
  assert.deepEqual(toLosslessJson({ ok: true, title: 'x', endedAt: undefined }), { ok: true, title: 'x' })
  assert.equal(toLosslessJson(undefined), null)
  assert.deepEqual(toLosslessJson({ list: [1, { a: undefined, b: null }] }), { list: [1, { b: null }] })
  assert.equal(toLosslessJson('plain'), 'plain')
})

test('settings.update covers scan depth and freshness thresholds and persists', async () => {
  const dir = join(workDir, 'settings')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  const engine = new DreamEngine(store, fakeCtx())
  await store.ready
  const result = await dispatchAction(store, engine, 'settings.update', {
    maxSessions: 20,
    windowHours: 168,
    staleHours: 48,
    forgetHours: 12,
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.maxSessions, 20)
  assert.equal(result.value.windowHours, 168)
  assert.equal(result.value.staleHours, 48)
  // A stale threshold past the forget threshold is reconciled, never inverted.
  assert.equal(result.value.forgetHours, 48)
  const snapshot = store.snapshot()
  assert.equal(snapshot.settings.maxSessions, 20)
  assert.ok(typeof snapshot.stateDir === 'string' && snapshot.stateDir.length > 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const reopened = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  await reopened.ready
  assert.equal(reopened.state.settings.maxSessions, 20)
  assert.equal(reopened.state.settings.staleHours, 48)
})

test('corrupt state file starts fresh instead of crashing', async () => {
  const dir = join(workDir, 'corrupt')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  await store.ready
  await store.persist()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, 'state.json'), '{ not json', 'utf8')
  const reopened = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12 })
  await reopened.ready
  assert.equal(reopened.state.items.length, 0)
  assert.ok(reopened.state.groups.length >= 1)
})
