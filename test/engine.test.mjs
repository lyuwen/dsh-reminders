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
function fakeCtx({ sessions = [], snapshots = [], events = new Map(), titles = new Map(), llm, defaultModel } = {}) {
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
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return defaultModel
      return undefined
    },
    logger: { warn() {} },
  }
}

/** Fake LLM service recording each streamed request and returning fixed JSON. */
function fakeLlm(reply, captured = []) {
  return {
    listProviders() {
      return [{ id: 'fake-provider', name: 'Fake Provider' }]
    },
    async listModels() {
      return [{ id: 'fake-model', name: 'Fake Model' }]
    },
    async prepareCall(config) {
      return {
        config: { ...config },
        stream(options) {
          captured.push(options)
          return (async function* stream() {
            yield { type: 'text-delta', index: 0, text: reply }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
}

const fakeDefaultModel = { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }

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

test('model evaluation grades a session, caches the summary, and labels the activity', async () => {
  const dir = join(workDir, 'llm-eval')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12, evalMode: 'model', evalProvider: '', evalModel: '', evalMaxSessions: 8, evalMaxItems: 0 })
  const now = Date.now()
  const events = [
    userMessage(0, now - HOUR, 'Build the reminders evaluation'),
    assistantMessage(1, now - HOUR + 1000, 'Prepared the evaluator and the cache.'),
    turnEnd(2, now - HOUR + 2000, 'completed'),
  ]
  const captured = []
  const reply = JSON.stringify({
    sessions: {
      'session-a': {
        subtitle: 'Built the evaluator and the fingerprint cache.',
        progress: 64,
        importance: 5,
        status: 'doing',
        attention: 71,
        attentionReason: 'Needs a decision on the storage format.',
      },
    },
    items: {},
  })
  const ctx = fakeCtx({
    snapshots: [snapshotFor('session-a', events, '/home/me/git/dsh-reminders')],
    events: new Map([['session-a', events]]),
    titles: new Map([['session-a', 'Build DSH reminders evaluation']]),
    llm: fakeLlm(reply, captured),
    defaultModel: fakeDefaultModel,
  })
  const engine = new DreamEngine(store, ctx)
  const activity = await engine.run({ trigger: 'test' })
  assert.equal(activity.status, 'done')
  assert.equal(activity.trigger, 'test')
  assert.equal(activity.model, 'fake-provider/fake-model')
  assert.equal(activity.degraded, false)
  assert.equal(activity.evaluated, 1)
  assert.equal(captured.length, 1)
  const item = store.state.items[0]
  assert.equal(item.title, 'Build DSH reminders evaluation')
  assert.equal(item.subtitle, 'Built the evaluator and the fingerprint cache.')
  assert.equal(item.progress, 64)
  assert.equal(item.importance, 5)
  assert.equal(item.attentionScore, 71)
  assert.match(item.attentionReason, /storage format/)
  assert.equal(store.state.sessionSummaries['session-a'].fingerprint.length, 40)

  // Unchanged Session: the summary comes from the cache, so no session is sent again.
  await dispatchAction(store, engine, 'settings.update', { evalMaxItems: 0 })
  const second = await engine.run({ trigger: 'test' })
  assert.equal(second.evaluated, 0)
  assert.equal(captured.length, 1)
  assert.equal(store.state.items[0].subtitle, 'Built the evaluator and the fingerprint cache.')
  assert.equal(store.state.items[0].importance, 5)
})

test('model failure falls back to heuristics without failing the pass', async () => {
  const dir = join(workDir, 'llm-fail')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12, evalMode: 'model', evalProvider: '', evalModel: '', evalMaxSessions: 8, evalMaxItems: 0 })
  const now = Date.now()
  const events = [userMessage(0, now - HOUR, 'Fix the flaky test'), assistantMessage(1, now - HOUR + 500, 'Found the race.'), turnEnd(2, now - HOUR + 800, 'completed')]
  const brokenLlm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake' }],
    async listModels() {
      return []
    },
    async prepareCall(config) {
      return {
        config: { ...config },
        stream() {
          return (async function* stream() {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }
          })()
        },
      }
    },
  }
  const ctx = fakeCtx({
    snapshots: [snapshotFor('session-a', events, '/home/me/git/flaky')],
    events: new Map([['session-a', events]]),
    titles: new Map([['session-a', 'Fix the flaky test']]),
    llm: brokenLlm,
    defaultModel: fakeDefaultModel,
  })
  const engine = new DreamEngine(store, ctx)
  const activity = await engine.run({ trigger: 'test' })
  assert.equal(activity.status, 'done')
  assert.equal(activity.degraded, true)
  assert.equal(activity.model, null)
  assert.match(activity.error, /boom/)
  const item = store.state.items[0]
  assert.ok(item.subtitle.length > 0)
  assert.equal(item.title, 'Fix the flaky test')
})

test('pending approval marks the item awaiting and needs your attention', async () => {
  const dir = join(workDir, 'awaiting')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12, evalMode: 'heuristic', evalProvider: '', evalModel: '', evalMaxSessions: 8, evalMaxItems: 0 })
  const now = Date.now()
  const events = [
    userMessage(0, now - HOUR, 'Deploy the service'),
    assistantMessage(1, now - HOUR + 500, 'I need permission to run the deploy.'),
    { type: 'approval/asked', seq: 2, time: now - HOUR + 900, data: { callId: 'c1', title: 'Run deploy' } },
  ]
  const ctx = fakeCtx({
    snapshots: [snapshotFor('session-deploy', events, '/home/me/git/deploy')],
    events: new Map([['session-deploy', events]]),
    titles: new Map([['session-deploy', 'Deploy the service']]),
  })
  const engine = new DreamEngine(store, ctx)
  const activity = await engine.run({ trigger: 'test' })
  assert.equal(activity.status, 'done')
  const item = store.state.items[0]
  assert.equal(item.status, 'awaiting')
  assert.match(item.statusNote, /permission/)
  assert.ok(item.attentionScore >= 60)
  assert.ok(activity.changes.some((change) => change.kind === 'attention'))
})

test('learning calibrates importance, exposes notes, and respects manual locks', async () => {
  const dir = join(workDir, 'learning')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12, evalMode: 'heuristic', evalProvider: '', evalModel: '', evalMaxSessions: 8, evalMaxItems: 0 })
  const engine = new DreamEngine(store, fakeCtx())
  await store.ready
  const item = store.createItem({ title: 'Ship the reminder panel', progress: 20, importance: 3 })
  item.lastAutoImportance = 3
  item.lastAutoProgress = 20
  // A user raising importance teaches the global and per-group calibration.
  store.updateItem(item.id, { importance: 5, progress: 60 })
  assert.ok(store.state.learning.importanceBias > 0)
  assert.ok(store.state.learning.progressBias > 0)
  assert.ok(store.state.learning.signals.some((signal) => signal.kind === 'importance' && signal.from === 3 && signal.to === 5))
  assert.deepEqual(store.state.items[0].manualFields.slice().sort(), ['importance', 'progress', 'title'])
  // Notes and biases round-trip through the same action the UI uses.
  const updated = await dispatchAction(store, engine, 'learning.update', { notes: 'User ranks infra work highest.', attentionBias: 6, importanceBias: 1.2 })
  assert.equal(updated.ok, true)
  assert.equal(store.state.learning.notes, 'User ranks infra work highest.')
  assert.equal(store.state.learning.attentionBias, 6)
  assert.equal(store.snapshot().learning.notes, 'User ranks infra work highest.')
  // Unlocking restores automatic grading.
  await dispatchAction(store, engine, 'item.unlock', { id: item.id })
  assert.deepEqual(store.state.items[0].manualFields, [])
  await dispatchAction(store, engine, 'learning.clearSignals', {})
  assert.equal(store.state.learning.signals.length, 0)
  await dispatchAction(store, engine, 'learning.reset', {})
  assert.equal(store.state.learning.notes, '')
  assert.equal(store.state.learning.importanceBias, 0)
})

test('models.list returns providers and models for the configure page', async () => {
  const dir = join(workDir, 'models')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12, evalMode: 'model', evalProvider: '', evalModel: '', evalMaxSessions: 8, evalMaxItems: 0 })
  const engine = new DreamEngine(store, fakeCtx({ llm: fakeLlm('{}'), defaultModel: fakeDefaultModel }))
  const result = await dispatchAction(store, engine, 'models.list', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.providers.length, 1)
  assert.equal(result.value.providers[0].id, 'fake-provider')
  assert.deepEqual(result.value.providers[0].models, [{ id: 'fake-model', name: 'Fake Model' }])
  const view = store.snapshot().evaluation
  assert.equal(view.mode, 'model')
  assert.equal(view.available, true)
  assert.equal(view.provider, 'fake-provider')
})

test('partial settings and learning updates preserve untouched fields', async () => {
  const dir = join(workDir, 'partial-updates')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12, evalMode: 'model', evalProvider: '', evalModel: '', evalMaxSessions: 8, evalMaxItems: 20 })
  const engine = new DreamEngine(store, fakeCtx())
  await store.ready
  await dispatchAction(store, engine, 'settings.update', { evalMode: 'model', evalProvider: 'deepseek-official', evalModel: 'deepseek-flash' })
  // Tool-style payloads carry explicit undefined keys; they must not clear fields.
  await dispatchAction(store, engine, 'settings.update', { dreamIntervalMinutes: 15, evalMode: undefined, evalProvider: undefined, evalModel: undefined, evalMaxItems: undefined })
  assert.equal(store.state.settings.evalProvider, 'deepseek-official')
  assert.equal(store.state.settings.evalModel, 'deepseek-flash')
  assert.equal(store.state.settings.evalMode, 'model')
  assert.equal(store.state.settings.dreamIntervalMinutes, 15)
  await dispatchAction(store, engine, 'learning.update', { notes: 'Prefer reliability.', importanceBias: 1.1, attentionBias: 5 })
  await dispatchAction(store, engine, 'learning.update', { notes: 'Prefer reliability.', importanceBias: undefined, progressBias: undefined, attentionBias: undefined })
  assert.equal(store.state.learning.importanceBias, 1.1)
  assert.equal(store.state.learning.attentionBias, 5)
  await dispatchAction(store, engine, 'learning.update', { progressBias: 7 })
  assert.equal(store.state.learning.progressBias, 7)
  assert.equal(store.state.learning.notes, 'Prefer reliability.')
  assert.equal(store.state.learning.importanceBias, 1.1)
})

test('heuristic mode never poisons the model summary cache', async () => {
  const dir = join(workDir, 'cache-mode')
  const store = new ReminderStore(dir, { dreamEnabled: true, dreamIntervalMinutes: 10, windowHours: 72, staleHours: 24, forgetHours: 72, maxSessions: 12, evalMode: 'heuristic', evalProvider: '', evalModel: '', evalMaxSessions: 8, evalMaxItems: 0 })
  const now = Date.now()
  const events = [userMessage(0, now - HOUR, 'Tune the evaluator'), assistantMessage(1, now - HOUR + 500, 'Evaluation wired.'), turnEnd(2, now - HOUR + 900, 'completed')]
  const reply = JSON.stringify({ sessions: { 'session-a': { subtitle: 'Model summary.', progress: 50, importance: 4, status: 'doing' } }, items: {} })
  const captured = []
  const ctx = fakeCtx({
    snapshots: [snapshotFor('session-a', events, '/home/me/git/coach')],
    events: new Map([['session-a', events]]),
    titles: new Map([['session-a', 'Tune the evaluator']]),
    llm: fakeLlm(reply, captured),
    defaultModel: fakeDefaultModel,
  })
  const engine = new DreamEngine(store, ctx)
  const heuristic = await engine.run({ trigger: 'test' })
  assert.equal(heuristic.model, null)
  assert.equal(captured.length, 0)
  assert.equal(Object.keys(store.state.sessionSummaries).length, 0)
  // Switch to model evaluation: the Session is evaluated and cached.
  await dispatchAction(store, engine, 'settings.update', { evalMode: 'model' })
  const model = await engine.run({ trigger: 'test' })
  assert.equal(model.model, 'fake-provider/fake-model')
  assert.equal(captured.length, 1)
  assert.equal(store.state.sessionSummaries['session-a'].model, 'fake-provider/fake-model')
  assert.equal(store.state.items[0].subtitle, 'Model summary.')
})
