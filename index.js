/**
 * dsh-reminders Host plugin.
 *
 * Owns the durable reminder list, the "dreaming" engine that combs recently
 * accessed Sessions, the authenticated `/api/dsh-reminders/*` HTTP routes used
 * by the browser half, and the `reminders` agent tool. Everything the model or
 * the UI sees is derived from this store; Session data is only read, never
 * written.
 *
 * Verified seams (DSH 0.2.2-rc.1 profile `web`):
 * - `ctx.tools.register(definition)` + `inject: ['tools']` for the agent tool.
 * - `ctx.connection.fetch.register({path, methods, requestBody, fetch})` mounts
 *   exact Fetch routes on the authenticated `/api` channel.
 * - `ctx.sessionQuery.listSessions/readTitleSnapshots` and
 *   `ctx.sessionPersistence.list/open` read the Session corpus read-only.
 * - `ctx.sessions.list()` exposes live Sessions for fresher event reads.
 *
 * @module dsh-reminders-plugin
 */
import { stat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { DreamEvaluator, heuristicAttention, heuristicStatus, heuristicSubtitle } from './evaluate.js'

export const name = 'reminders'
export const inject = ['tools']

/** Authenticated route paths (Connection requires the `/api` prefix). */
const ROUTE_STATE = '/api/dsh-reminders/state'
const ROUTE_ACTION = '/api/dsh-reminders/action'

/** Browser/main-panel identity shared with the Client half. */
const PANEL_ID = 'reminders'
const TOOL_NAME = 'reminders'

const STATE_VERSION = 1
const DEFAULT_GROUP_NAME = 'General'
const ACTIVITY_KEEP = 12
/** Changes retained per activity rollup (the long-absence aggregate). */
const ROLLUP_CHANGES_KEEP = 60
const SESSION_META_KEEP = 400
const SESSION_SUMMARY_KEEP = 400
const LEARNING_SIGNALS_KEEP = 60
const MAX_TITLE = 200
const MAX_TEXT = 4000
const MAX_NEXT_STEP = 400
const MAX_SUBTITLE = 300
const MAX_STATUS_NOTE = 200
const STATUSES = ['todo', 'doing', 'awaiting', 'blocked', 'done']
/** Fields a user edit locks against automatic re-grading. */
const MANUAL_FIELDS = ['title', 'subtitle', 'progress', 'importance']
/** Attention score at/above which an item is surfaced to the user. */
const ATTENTION_THRESHOLD = 60
/** How long an attention flag is remembered so one item is not re-reported each pass. */
const ATTENTION_REFLAG_MS = 6 * 3_600_000
const EVAL_DEFAULTS = {
  evalMode: 'model',
  evalProvider: '',
  evalModel: '',
  evalMaxSessions: 8,
  evalMaxItems: 20,
}

/** A user-visible operation failure with a stable code. */
class ReminderError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'ReminderError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** @returns {number} current epoch milliseconds */
function nowMs() {
  return Date.now()
}

/**
 * Clamp a finite number.
 * @param {number} value @param {number} lo @param {number} hi
 */
function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Read a numeric option with clamping, falling back when invalid.
 * @param {unknown} value @param {number} fallback @param {number} lo @param {number} hi
 */
function numberOr(value, fallback, lo, hi) {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return clamp(Math.round(n), lo, hi)
}

/** @param {unknown} value @param {boolean} fallback */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize a single line of text.
 * @param {unknown} value @param {number} max
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max)
}

/**
 * First line of some possibly multi-line text.
 * @param {unknown} value @param {number} max
 */
function cleanLine(value, max) {
  const text = cleanText(value, max)
  const line = text.split('\n').find((part) => part.trim().length > 0) ?? ''
  return line.trim().slice(0, max)
}

/** @param {string} prefix */
function newId(prefix) {
  return `${prefix}-${randomBytes(5).toString('hex')}`
}

/**
 * Normalize a group name into a comparison key.
 * @param {string} name
 */
function groupKey(name) {
  const key = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return key || 'general'
}

/** Stop words ignored by title similarity. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'then', 'than',
  'are', 'was', 'were', 'you', 'your', 'our', 'its', 'not', 'but', 'all', 'can',
  'will', 'would', 'should', 'could', 'use', 'using', 'make', 'made', 'please',
  'need', 'needs', 'want', 'wants', 'let', 'get', 'got', 'add', 'adds', 'fix',
  'fixes', 'run', 'runs', 'via', 'per', '关于', '以及', '一个',
])

/** @param {unknown} text */
function tokenize(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  return new Set(words)
}

/**
 * Jaccard similarity of two token sets.
 * @param {Set<string>} a @param {Set<string>} b
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * Freshness bucket from the last touch timestamp.
 * @param {number} lastTouched @param {{staleHours:number,forgetHours:number}} settings @param {number} now
 * @returns {'fresh'|'warm'|'stale'|'cold'}
 */
function deriveFreshness(lastTouched, settings, now) {
  const age = now - (Number.isFinite(lastTouched) ? lastTouched : now)
  const hours = age / 3_600_000
  if (hours <= 2) return 'fresh'
  if (hours <= (settings.staleHours ?? 24)) return 'warm'
  if (hours <= (settings.forgetHours ?? 72)) return 'stale'
  return 'cold'
}

/**
 * Project directory name used as the default group name.
 * @param {string|undefined} cwd
 */
function groupNameForCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return DEFAULT_GROUP_NAME
  const name = basename(cwd.replace(/[\\/]+$/, ''))
  return name.trim().length > 0 ? name.trim() : DEFAULT_GROUP_NAME
}

/**
 * Stable fingerprint for the parts of a Session that change its evaluation.
 * @param {unknown} value
 */
function fingerprintOf(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex')
}

/**
 * Empty learned-preference record.
 */
function emptyLearning() {
  return {
    updatedAt: 0,
    notes: '',
    importanceBias: 0,
    progressBias: 0,
    attentionBias: 0,
    groups: [],
    signals: [],
    stats: { edits: 0, deletes: 0, pins: 0, attentionKept: 0, attentionDismissed: 0 },
  }
}

/**
 * Join the text blocks of a stored message.
 * @param {{content?: Array<{type?:string,text?:string}>}|undefined} message
 * @param {number} max
 */
function messageText(message, max) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return cleanText(parts.join('\n'), max)
}

/**
 * Sources that appear as user-role events but are harness context, not the
 * person's own request; they never describe work.
 */
const HUMAN_USER_KINDS = new Set(['user', 'user-rpc'])

/**
 * Text of a stored `user/message` event. Unlike `assistant/message` and
 * `tool/result`, that event stores the message fields directly on `data`, and
 * only a human/agent prompt describes work (context snapshots are ignored).
 * @param {{data?: Record<string, any>}|undefined} event
 * @param {number} max
 */
function userMessageText(event, max) {
  const data = event?.data
  if (!data || typeof data !== 'object') return ''
  const kind = typeof data.source?.kind === 'string' ? data.source.kind : ''
  if (kind && !HUMAN_USER_KINDS.has(kind)) return ''
  return messageText(data, max)
}

/**
 * Merge two event arrays by seq, ascending.
 * @param {Array<object>} first @param {Array<object>} last
 */
function mergeEvents(first, last) {
  if (last.length === 0) return first
  const bySeq = new Map()
  for (const event of first) bySeq.set(event.seq, event)
  for (const event of last) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Derive the Session's current work state from its last durable event.
 * @param {object|undefined} lastEvent
 * @returns {'settled'|'working'|'blocked'|'unknown'}
 */
function deriveSessionState(lastEvent) {
  if (!lastEvent) return 'unknown'
  if (lastEvent.type === 'turn/end') {
    const kind = lastEvent.data?.reason?.kind
    if (kind === 'error' || kind === 'aborted' || kind === 'blocked' || kind === 'interrupted') return 'blocked'
    return 'settled'
  }
  if (
    lastEvent.type === 'turn/start' || lastEvent.type === 'step/start' ||
    lastEvent.type === 'user/message' || lastEvent.type === 'assistant/message' ||
    lastEvent.type === 'tool/call' || lastEvent.type === 'tool/result'
  ) {
    return 'working'
  }
  return 'working'
}

/**
 * Extract the research surface of one Session from its event sample, including
 * whether the Session is currently waiting on the user.
 * @param {Array<object>} events
 */
function analyzeEvents(events) {
  let firstUserText = ''
  let lastUserText = ''
  let lastAssistantText = ''
  let title = ''
  let lastError = ''
  let turnEnds = 0
  let lastTime = 0
  let lastEvent
  let lastApprovalAsked = 0
  let lastApprovalDecided = 0
  const pendingCalls = new Map()
  const tools = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    lastEvent = event
    if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time
    switch (event.type) {
      case 'user/message': {
        const text = userMessageText(event, 2000)
        if (text) {
          if (!firstUserText) firstUserText = text
          lastUserText = text
        }
        break
      }
      case 'assistant/message': {
        const text = messageText(event.data?.message, 4000)
        if (text) lastAssistantText = text
        break
      }
      case 'tool/call': {
        const toolName = typeof event.data?.name === 'string' ? event.data.name : ''
        const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
        if (callId && toolName) pendingCalls.set(callId, toolName)
        if (toolName && !tools.includes(toolName) && tools.length < 8) tools.push(toolName)
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId
        if (typeof callId === 'string') pendingCalls.delete(callId)
        if (event.data?.error) {
          const reason = event.data.error.reason || event.data.error.code || event.data.error.name
          if (reason) lastError = cleanLine(reason, 160)
        }
        break
      }
      case 'approval/asked': {
        lastApprovalAsked = Math.max(lastApprovalAsked, typeof event.seq === 'number' ? event.seq : 0)
        break
      }
      case 'approval/decided': {
        lastApprovalDecided = Math.max(lastApprovalDecided, typeof event.seq === 'number' ? event.seq : 0)
        break
      }
      case 'turn/end': {
        turnEnds += 1
        break
      }
      case 'session/title': {
        if (typeof event.data?.title === 'string') title = cleanLine(event.data.title, MAX_TITLE)
        break
      }
      default:
        break
    }
  }
  const pendingQuestions = [...pendingCalls.values()].filter((name) => name === 'ask_user_question' || name === 'ask_user')
  const pendingApproval = lastApprovalAsked > lastApprovalDecided
  const pendingIssue = pendingApproval ? 'permission' : pendingQuestions.length > 0 ? 'question' : ''
  return {
    firstUserText, lastUserText, lastAssistantText, title, lastError, turnEnds, lastTime, lastEvent,
    tools,
    pendingApproval,
    pendingQuestion: pendingQuestions.length > 0,
    pendingIssue,
    lastApprovalAsked,
    lastApprovalDecided,
    state: pendingIssue ? 'awaiting' : deriveSessionState(lastEvent),
  }
}

/**
 * Pick a reminder title for a scanned Session.
 * @param {{title:string,firstUserText:string,lastUserText:string,cwd?:string}} summary
 */
function titleForSession(summary) {
  if (summary.title) return cleanLine(summary.title, MAX_TITLE)
  if (summary.firstUserText) return cleanLine(summary.firstUserText, 120)
  if (summary.lastUserText) return cleanLine(summary.lastUserText, 120)
  if (summary.cwd) return cleanLine(groupNameForCwd(summary.cwd), MAX_TITLE)
  return 'Untitled work'
}

/**
 * Heuristic progress suggested for a tracked Session (never decreases an item).
 * @param {{turnEnds:number,lastUserText:string,lastAssistantText:string,state:string}} summary
 */
function suggestedProgress(summary) {
  let progress = 20 + Math.min(40, summary.turnEnds * 6)
  if (summary.lastAssistantText) progress += 8
  if (summary.lastUserText) progress += 4
  if (summary.state === 'blocked') progress = Math.min(progress, 45)
  return clamp(Math.round(progress), 10, 85)
}

/**
 * Learned adjustment for one group/field.
 * @param {object} learning @param {string} groupName @param {'importance'|'attention'} field
 */
function learnedGroupBias(learning, groupName, field) {
  const key = groupKey(groupName)
  const group = (learning?.groups ?? []).find((entry) => groupKey(entry.name) === key)
  if (!group) return 0
  return Number(field === 'attention' ? group.attentionBias : group.importanceBias) || 0
}

/**
 * Deterministic attention for one item, including learned and group biases.
 * @param {object} item @param {object} learning @param {string} groupName @param {number} now
 */
function attentionForItem(item, learning, groupName, now) {
  return heuristicAttention({
    item,
    now,
    learning,
    groupAttentionBias: learnedGroupBias(learning, groupName, 'attention'),
  })
}

/**
 * Deterministic subtitle for an item without a fresh session evaluation.
 * @param {object} item
 */
function fallbackSubtitle(item) {
  return cleanLine(item.nextStep, 200) || cleanLine(item.notes, 200) || ''
}

/**
 * Coerce a persisted learned-preference record.
 * @param {unknown} raw
 */
function normalizeLearning(raw) {
  const base = emptyLearning()
  if (!raw || typeof raw !== 'object') return base
  const value = /** @type {Record<string, any>} */ (raw)
  const groups = Array.isArray(value.groups)
    ? value.groups.filter((group) => group && typeof group === 'object' && typeof group.name === 'string')
      .slice(0, 40)
      .map((group) => ({
        name: cleanLine(group.name, 60),
        samples: numberOr(group.samples, 0, 0, 100_000),
        importanceBias: clamp(Number(group.importanceBias) || 0, -2, 2),
        attentionBias: clamp(Number(group.attentionBias) || 0, -20, 20),
      }))
      .filter((group) => group.name.length > 0)
    : []
  const signals = Array.isArray(value.signals)
    ? value.signals.filter((signal) => signal && typeof signal === 'object').slice(0, LEARNING_SIGNALS_KEEP).map((signal) => ({
        at: numberOr(signal.at, 0, 0, Number.MAX_SAFE_INTEGER),
        kind: cleanLine(signal.kind, 30),
        itemId: typeof signal.itemId === 'string' ? signal.itemId : '',
        title: cleanLine(signal.title, MAX_TITLE),
        field: cleanLine(signal.field, 30),
        from: typeof signal.from === 'number' || typeof signal.from === 'string' ? signal.from : null,
        to: typeof signal.to === 'number' || typeof signal.to === 'string' ? signal.to : null,
      }))
    : []
  const stats = value.stats && typeof value.stats === 'object' ? value.stats : {}
  return {
    updatedAt: numberOr(value.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    notes: cleanText(value.notes, MAX_TEXT),
    importanceBias: clamp(Number(value.importanceBias) || 0, -2, 2),
    progressBias: numberOr(value.progressBias, 0, -20, 20),
    attentionBias: numberOr(value.attentionBias, 0, -20, 20),
    groups,
    signals,
    stats: {
      edits: numberOr(stats.edits, 0, 0, 1_000_000),
      deletes: numberOr(stats.deletes, 0, 0, 1_000_000),
      pins: numberOr(stats.pins, 0, 0, 1_000_000),
      attentionKept: numberOr(stats.attentionKept, 0, 0, 1_000_000),
      attentionDismissed: numberOr(stats.attentionDismissed, 0, 0, 1_000_000),
    },
  }
}

/**
 * Coerce one cached Session evaluation.
 * @param {unknown} raw
 */
function normalizeSessionSummary(raw) {
  if (!raw || typeof raw !== 'object') return null
  const value = /** @type {Record<string, any>} */ (raw)
  if (typeof value.id !== 'string' || typeof value.fingerprint !== 'string') return null
  return {
    id: value.id,
    fingerprint: value.fingerprint,
    title: cleanLine(value.title, MAX_TITLE),
    subtitle: cleanLine(value.subtitle, MAX_SUBTITLE),
    progress: numberOr(value.progress, 0, 0, 100),
    importance: numberOr(value.importance, 3, 1, 5),
    status: STATUSES.includes(value.status) ? value.status : 'doing',
    attention: numberOr(value.attention, 0, 0, 100),
    attentionReason: cleanLine(value.attentionReason, MAX_STATUS_NOTE),
    groupName: cleanLine(value.groupName, 60),
    generatedAt: numberOr(value.generatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    model: typeof value.model === 'string' ? cleanLine(value.model, 120) : null,
  }
}

// ---------------------------------------------------------------------------
// Durable store
// ---------------------------------------------------------------------------

/** @returns {object} a fresh empty persisted state */
function emptyState(defaults) {
  return {
    version: STATE_VERSION,
    revision: 0,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    settings: {
      dreamEnabled: defaults.dreamEnabled,
      dreamIntervalMinutes: defaults.dreamIntervalMinutes,
      windowHours: defaults.windowHours,
      staleHours: defaults.staleHours,
      forgetHours: defaults.forgetHours,
      maxSessions: defaults.maxSessions,
      evalMode: defaults.evalMode,
      evalProvider: defaults.evalProvider,
      evalModel: defaults.evalModel,
      evalMaxSessions: defaults.evalMaxSessions,
      evalMaxItems: defaults.evalMaxItems,
    },
    groups: [],
    items: [],
    sessionMeta: {},
    sessionSummaries: {},
    learning: emptyLearning(),
    activities: [],
    activityRollup: null,
    lastDreamAt: 0,
  }
}

/**
 * Coerce a persisted item into the current shape, dropping junk.
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const value = /** @type {Record<string, any>} */ (raw)
  if (typeof value.id !== 'string' || typeof value.title !== 'string') return null
  const status = STATUSES.includes(value.status) ? value.status : 'todo'
  return {
    id: value.id,
    title: cleanLine(value.title, MAX_TITLE) || 'Untitled work',
    notes: cleanText(value.notes, MAX_TEXT),
    nextStep: cleanLine(value.nextStep, MAX_NEXT_STEP),
    groupId: typeof value.groupId === 'string' ? value.groupId : '',
    status,
    progress: numberOr(value.progress, status === 'done' ? 100 : 0, 0, 100),
    importance: numberOr(value.importance, 3, 1, 5),
    pinned: boolOr(value.pinned, false),
    source: value.source === 'dream' ? 'dream' : 'manual',
    autoManaged: boolOr(value.autoManaged, value.source === 'dream'),
    sessionIds: Array.isArray(value.sessionIds)
      ? [...new Set(value.sessionIds.filter((id) => typeof id === 'string'))].slice(0, 40)
      : [],
    createdAt: numberOr(value.createdAt, nowMs(), 0, Number.MAX_SAFE_INTEGER),
    updatedAt: numberOr(value.updatedAt, nowMs(), 0, Number.MAX_SAFE_INTEGER),
    lastTouched: numberOr(value.lastTouched, value.updatedAt ?? nowMs(), 0, Number.MAX_SAFE_INTEGER),
    lastDreamBatchId: typeof value.lastDreamBatchId === 'string' ? value.lastDreamBatchId : undefined,
    subtitle: cleanLine(value.subtitle, MAX_SUBTITLE),
    statusNote: cleanLine(value.statusNote, MAX_STATUS_NOTE),
    attentionScore: numberOr(value.attentionScore, 0, 0, 100),
    attentionReason: cleanLine(value.attentionReason, MAX_STATUS_NOTE),
    attentionUpdatedAt: numberOr(value.attentionUpdatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    lastAttentionFlagAt: numberOr(value.lastAttentionFlagAt, 0, 0, Number.MAX_SAFE_INTEGER),
    manualFields: Array.isArray(value.manualFields)
      ? [...new Set(value.manualFields.filter((field) => MANUAL_FIELDS.includes(field)))]
      : [],
    lastAutoImportance: numberOr(value.lastAutoImportance, 3, 1, 5),
    lastAutoProgress: numberOr(value.lastAutoProgress, value.progress ?? 0, 0, 100),
  }
}

/**
 * Coerce a persisted group into the current shape.
 * @param {unknown} raw
 */
function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null
  const value = /** @type {Record<string, any>} */ (raw)
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return null
  const groupName = cleanLine(value.name, 60)
  if (!groupName) return null
  return {
    id: value.id,
    name: groupName,
    createdAt: numberOr(value.createdAt, nowMs(), 0, Number.MAX_SAFE_INTEGER),
  }
}

/**
 * Coerce one list of activity changes.
 * @param {unknown} raw @param {number} cap
 */
function normalizeChanges(raw, cap) {
  if (!Array.isArray(raw)) return []
  return raw.filter((change) => change && typeof change === 'object').slice(0, cap).map((change) => ({
    itemId: typeof change.itemId === 'string' ? change.itemId : '',
    title: cleanLine(change.title, MAX_TITLE),
    kind: ['created', 'updated', 'attention', 'grouped'].includes(change.kind) ? change.kind : 'updated',
    detail: cleanLine(change.detail, 240),
  }))
}

/**
 * Coerce the rolling aggregate of dream runs that left the recent activity window.
 * @param {unknown} raw
 */
function normalizeRollup(raw) {
  if (!raw || typeof raw !== 'object') return null
  const value = /** @type {Record<string, any>} */ (raw)
  const changes = normalizeChanges(value.changes, ROLLUP_CHANGES_KEEP)
  const runs = numberOr(value.runs, 0, 0, 100_000)
  if (runs <= 0 && changes.length === 0) return null
  return {
    startedAt: numberOr(value.startedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    endedAt: numberOr(value.endedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    runs,
    created: numberOr(value.created, 0, 0, 100_000),
    updated: numberOr(value.updated, 0, 0, 100_000),
    attention: numberOr(value.attention, 0, 0, 100_000),
    changes,
  }
}

/**
 * Coerce a persisted activity, dropping undo snapshots that no longer parse.
 * @param {unknown} raw
 */
function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object') return null
  const value = /** @type {Record<string, any>} */ (raw)
  if (typeof value.id !== 'string') return null
  return {
    id: value.id,
    status: value.status === 'done' ? 'done' : value.status === 'error' ? 'error' : 'running',
    trigger: typeof value.trigger === 'string' ? cleanLine(value.trigger, 20) : 'auto',
    startedAt: numberOr(value.startedAt, nowMs(), 0, Number.MAX_SAFE_INTEGER),
    endedAt: typeof value.endedAt === 'number' ? value.endedAt : undefined,
    scanned: numberOr(value.scanned, 0, 0, 10_000),
    created: numberOr(value.created, 0, 0, 10_000),
    updated: numberOr(value.updated, 0, 0, 10_000),
    attention: numberOr(value.attention, 0, 0, 10_000),
    summary: cleanLine(value.summary, 400),
    error: typeof value.error === 'string' ? cleanLine(value.error, 400) : undefined,
    undoable: boolOr(value.undoable, false),
    undone: boolOr(value.undone, false),
    evaluated: numberOr(value.evaluated, 0, 0, 10_000),
    graded: numberOr(value.graded, 0, 0, 10_000),
    model: typeof value.model === 'string' ? cleanLine(value.model, 120) : null,
    degraded: boolOr(value.degraded, false),
    changes: normalizeChanges(value.changes, 100),
    undo: value.undo && typeof value.undo === 'object' && Array.isArray(value.undo.items) && Array.isArray(value.undo.groups)
      ? { items: value.undo.items, groups: value.undo.groups }
      : undefined,
  }
}

/**
 * Read and normalize a persisted state document.
 * @param {unknown} raw @param {object} defaults
 */
function normalizeState(raw, defaults) {
  const base = emptyState(defaults)
  if (!raw || typeof raw !== 'object') return base
  const value = /** @type {Record<string, any>} */ (raw)
  const items = Array.isArray(value.items) ? value.items.map(normalizeItem).filter(Boolean) : []
  const groups = Array.isArray(value.groups) ? value.groups.map(normalizeGroup).filter(Boolean) : []
  const knownGroups = new Set(groups.map((group) => group.id))
  const fallbackGroup = ensureDefaultGroup(groups)
  for (const item of items) {
    if (!item.groupId || !knownGroups.has(item.groupId)) item.groupId = fallbackGroup.id
  }
  const settings = value.settings && typeof value.settings === 'object' ? value.settings : {}
  const sessionSummaries = {}
  if (value.sessionSummaries && typeof value.sessionSummaries === 'object') {
    for (const entry of Object.values(value.sessionSummaries)) {
      const summary = normalizeSessionSummary(entry)
      if (summary) sessionSummaries[summary.id] = summary
    }
  }
  const sessionMeta = {}
  if (value.sessionMeta && typeof value.sessionMeta === 'object') {
    for (const [id, meta] of Object.entries(value.sessionMeta)) {
      if (!meta || typeof meta !== 'object') continue
      const entry = /** @type {Record<string, any>} */ (meta)
      sessionMeta[id] = {
        id,
        title: cleanLine(entry.title, MAX_TITLE) || id,
        cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
        lastTouched: numberOr(entry.lastTouched, 0, 0, Number.MAX_SAFE_INTEGER),
      }
    }
  }
  return {
    version: STATE_VERSION,
    revision: numberOr(value.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    createdAt: numberOr(value.createdAt, base.createdAt, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: numberOr(value.updatedAt, base.updatedAt, 0, Number.MAX_SAFE_INTEGER),
    settings: {
      dreamEnabled: boolOr(settings.dreamEnabled, defaults.dreamEnabled),
      dreamIntervalMinutes: numberOr(settings.dreamIntervalMinutes, defaults.dreamIntervalMinutes, 1, 1440),
      windowHours: numberOr(settings.windowHours, defaults.windowHours, 1, 720),
      staleHours: numberOr(settings.staleHours, defaults.staleHours, 1, 720),
      forgetHours: numberOr(settings.forgetHours, defaults.forgetHours, 1, 2160),
      maxSessions: numberOr(settings.maxSessions, defaults.maxSessions, 1, 50),
      evalMode: settings.evalMode === 'heuristic' ? 'heuristic' : defaults.evalMode,
      evalProvider: cleanLine(settings.evalProvider, 120),
      evalModel: cleanLine(settings.evalModel, 120),
      evalMaxSessions: numberOr(settings.evalMaxSessions, defaults.evalMaxSessions, 1, 30),
      evalMaxItems: numberOr(settings.evalMaxItems, defaults.evalMaxItems, 0, 40),
    },
    groups,
    items,
    sessionMeta,
    sessionSummaries,
    learning: normalizeLearning(value.learning),
    activities: Array.isArray(value.activities) ? value.activities.map(normalizeActivity).filter(Boolean).slice(0, ACTIVITY_KEEP) : [],
    activityRollup: normalizeRollup(value.activityRollup),
    lastDreamAt: numberOr(value.lastDreamAt, 0, 0, Number.MAX_SAFE_INTEGER),
  }
}

/**
 * Ensure the default group exists and return it.
 * @param {Array<{id:string,name:string}>} groups
 */
function ensureDefaultGroup(groups) {
  const existing = groups.find((group) => groupKey(group.name) === groupKey(DEFAULT_GROUP_NAME))
  if (existing) return existing
  const group = { id: newId('g'), name: DEFAULT_GROUP_NAME, createdAt: nowMs() }
  groups.push(group)
  return group
}

/** Durable reminder store: synchronous reads, serialized atomic writes. */
class ReminderStore {
  /**
   * @param {string} dir @param {object} defaults
   */
  constructor(dir, defaults) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.defaults = defaults
    this.state = emptyState(defaults)
    this.ready = this.#load()
    this.writeChain = Promise.resolve()
    this.engineRunning = false
    this.evaluator = null
  }

  async #load() {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.state = normalizeState(parsed, this.defaults)
      // A read-only config default may change between boots; persisted runtime
      // settings win, but an absent settings block was already defaulted.
      ensureDefaultGroup(this.state.groups)
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.loadWarning = `reminders state was unreadable (${error.code ?? 'error'}); starting fresh`
        try {
          await rename(this.file, `${this.file}.corrupt-${nowMs()}`)
        } catch {
          // best effort: keep the unreadable file untouched
        }
      }
      this.state = emptyState(this.defaults)
      ensureDefaultGroup(this.state.groups)
    }
    return this.state
  }

  /** Bump the revision counter without persisting. */
  touch() {
    this.state.revision += 1
    this.state.updatedAt = nowMs()
  }

  /** Persist the current state atomically, serialized behind earlier writes. */
  persist() {
    const snapshot = JSON.stringify(this.state, null, 2)
    const file = this.file
    this.writeChain = this.writeChain.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true })
        const temp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
        await writeFile(temp, snapshot, { mode: 0o600 })
        await rename(temp, file)
      } catch (error) {
        this.loadWarning = `reminders state could not be saved (${error.code ?? 'error'})`
      }
    })
    return this.writeChain
  }

  /** @param {string} name */
  findGroupByName(name) {
    const key = groupKey(name)
    return this.state.groups.find((group) => groupKey(group.name) === key)
  }

  /** @param {string} id */
  findGroup(id) {
    return this.state.groups.find((group) => group.id === id)
  }

  /** @param {string} id */
  findItem(id) {
    return this.state.items.find((item) => item.id === id)
  }

  /**
   * Resolve or create a group by display name.
   * @param {string} name
   * @returns {{group:object, created:boolean}}
   */
  groupForName(name) {
    const cleanName = cleanLine(name, 60) || DEFAULT_GROUP_NAME
    const existing = this.findGroupByName(cleanName)
    if (existing) return { group: existing, created: false }
    const group = { id: newId('g'), name: cleanName, createdAt: nowMs() }
    this.state.groups.push(group)
    return { group, created: true }
  }

  /**
   * Project one item for the Client, with freshness and linked Session metadata.
   * @param {object} item @param {number} now
   */
  itemView(item, now = nowMs()) {
    return {
      ...item,
      freshness: deriveFreshness(item.lastTouched, this.state.settings, now),
      sessions: item.sessionIds.map((id) => {
        const meta = this.state.sessionMeta[id]
        return meta
          ? { id, title: meta.title, lastTouched: meta.lastTouched }
          : { id, title: id, lastTouched: item.lastTouched }
      }),
    }
  }

  /** @param {object} activity */
  activityView(activity) {
    const { undo: _undo, ...rest } = activity
    return rest
  }

  /**
   * Public aggregate of dream runs outside the recent activity window, used by
   * the Client to show one "while you were away" summary instead of stacked
   * notifications after the page was unfocused for a long time.
   */
  rollupView() {
    const rollup = this.state.activityRollup
    if (!rollup) return null
    return {
      startedAt: rollup.startedAt,
      endedAt: rollup.endedAt,
      runs: rollup.runs,
      created: rollup.created,
      updated: rollup.updated,
      attention: rollup.attention,
      changes: rollup.changes.slice(0, ROLLUP_CHANGES_KEEP),
    }
  }

  /**
   * Fold one dropped activity into the rolling aggregate, merging changes by
   * item so a long absence yields one row per item, not one per run.
   * @param {object} activity
   */
  mergeActivityIntoRollup(activity) {
    if (!activity || activity.status === 'running') return
    const current = this.state.activityRollup ?? {
      startedAt: activity.startedAt ?? 0,
      endedAt: activity.endedAt ?? activity.startedAt ?? 0,
      runs: 0,
      created: 0,
      updated: 0,
      attention: 0,
      changes: [],
    }
    current.startedAt = Math.min(current.startedAt || activity.startedAt || 0, activity.startedAt ?? 0)
    current.endedAt = Math.max(current.endedAt, activity.endedAt ?? activity.startedAt ?? 0)
    current.runs += 1
    current.created += activity.created ?? 0
    current.updated += activity.updated ?? 0
    current.attention += activity.attention ?? 0
    if (Array.isArray(activity.changes)) {
      for (const change of activity.changes) {
        const byItem = change.itemId ? current.changes.find((entry) => entry.itemId === change.itemId) : undefined
        if (byItem) {
          byItem.title = change.title
          byItem.kind = change.kind
          byItem.detail = change.detail
        } else {
          current.changes.push({ itemId: change.itemId, title: change.title, kind: change.kind, detail: change.detail })
        }
      }
    }
    if (current.changes.length > ROLLUP_CHANGES_KEEP) {
      current.changes = current.changes.slice(current.changes.length - ROLLUP_CHANGES_KEEP)
    }
    this.state.activityRollup = current
  }

  /** Keep the recent activity window bounded, rolling the dropped tail up. */
  pruneActivities() {
    while (this.state.activities.length > ACTIVITY_KEEP) {
      const dropped = this.state.activities.pop()
      this.mergeActivityIntoRollup(dropped)
    }
  }

  /** Client-facing learned-preference snapshot. */
  learningView() {
    const learning = this.state.learning
    return {
      updatedAt: learning.updatedAt,
      notes: learning.notes,
      importanceBias: learning.importanceBias,
      progressBias: learning.progressBias,
      attentionBias: learning.attentionBias,
      groups: learning.groups.map((group) => ({ ...group })),
      signals: learning.signals.slice(0, 30).map((signal) => ({ ...signal })),
      stats: { ...learning.stats },
    }
  }

  /** @param {{kind:string,itemId?:string,title?:string,field?:string,from?:unknown,to?:unknown,group?:string}} signal */
  recordLearningSignal(signal) {
    const learning = this.state.learning
    const entry = {
      at: nowMs(),
      kind: cleanLine(signal.kind, 30) || 'edit',
      itemId: typeof signal.itemId === 'string' ? signal.itemId : '',
      title: cleanLine(signal.title, MAX_TITLE),
      field: cleanLine(signal.field, 30),
      from: typeof signal.from === 'number' || typeof signal.from === 'string' ? signal.from : null,
      to: typeof signal.to === 'number' || typeof signal.to === 'string' ? signal.to : null,
    }
    learning.signals.unshift(entry)
    if (learning.signals.length > LEARNING_SIGNALS_KEEP) learning.signals = learning.signals.slice(0, LEARNING_SIGNALS_KEEP)
    learning.updatedAt = entry.at
    return entry
  }

  /** @param {string} name */
  learningGroup(name) {
    const key = groupKey(name)
    let group = this.state.learning.groups.find((entry) => groupKey(entry.name) === key)
    if (!group) {
      group = { name: cleanLine(name, 60) || DEFAULT_GROUP_NAME, samples: 0, importanceBias: 0, attentionBias: 0 }
      this.state.learning.groups.push(group)
    }
    return group
  }

  /** @param {object} item */
  groupNameOf(item) {
    return this.findGroup(item?.groupId)?.name || DEFAULT_GROUP_NAME
  }

  /**
   * Fold one manual edit into the learned-preference record.
   * @param {object} before @param {object} after
   */
  learnFromEdit(before, after) {
    const learning = this.state.learning
    const group = this.learningGroup(this.groupNameOf(after))
    learning.stats.edits += 1
    const add = (kind, field, from, to) => {
      if (from === to) return
      this.recordLearningSignal({ kind, itemId: after.id, title: after.title, field, from, to, group: group.name })
    }
    if (before.importance !== after.importance) {
      const baseline = typeof before.lastAutoImportance === 'number' ? before.lastAutoImportance : 3
      const delta = after.importance - baseline
      learning.importanceBias = clamp(Math.round((learning.importanceBias * 0.85 + delta * 0.15) * 10) / 10, -2, 2)
      group.importanceBias = clamp(Math.round((group.importanceBias * 0.85 + delta * 0.15) * 10) / 10, -2, 2)
      group.samples += 1
      add('importance', 'importance', before.importance, after.importance)
      if ((before.attentionScore ?? 0) >= ATTENTION_THRESHOLD) learning.stats.attentionKept += 1
    }
    if (before.progress !== after.progress) {
      const baseline = typeof before.lastAutoProgress === 'number' ? before.lastAutoProgress : before.progress
      const delta = after.progress - baseline
      learning.progressBias = clamp(Math.round(learning.progressBias * 0.85 + delta * 0.15), -20, 20)
      add('progress', 'progress', before.progress, after.progress)
    }
    if (before.status !== after.status) add('status', 'status', before.status, after.status)
    if (before.title !== after.title) add('title', 'title', before.title, after.title)
    if ((before.subtitle ?? '') !== (after.subtitle ?? '')) add('subtitle', 'subtitle', before.subtitle ?? '', after.subtitle ?? '')
    if (before.pinned !== after.pinned) {
      if (after.pinned) learning.stats.pins += 1
      add('pin', 'pinned', before.pinned, after.pinned)
    }
    learning.updatedAt = nowMs()
  }

  /** @param {object} item */
  learnFromDelete(item) {
    const learning = this.state.learning
    learning.stats.deletes += 1
    const group = this.learningGroup(this.groupNameOf(item))
    if ((item.attentionScore ?? 0) >= ATTENTION_THRESHOLD) {
      learning.stats.attentionDismissed += 1
      learning.attentionBias = clamp(learning.attentionBias - 1, -20, 20)
      group.attentionBias = clamp(group.attentionBias - 1, -20, 20)
    }
    this.recordLearningSignal({
      kind: 'delete',
      itemId: item.id,
      title: item.title,
      field: '',
      from: item.status,
      to: 'deleted',
      group: group.name,
    })
    learning.updatedAt = nowMs()
  }

  /** @param {Record<string, any>} patch */
  updateLearning(patch) {
    const learning = this.state.learning
    const input = patch && typeof patch === 'object' ? patch : {}
    if (typeof input.notes === 'string') learning.notes = cleanText(input.notes, MAX_TEXT)
    if (typeof input.importanceBias === 'number' && Number.isFinite(input.importanceBias)) {
      learning.importanceBias = clamp(input.importanceBias, -2, 2)
    }
    if (typeof input.progressBias === 'number' && Number.isFinite(input.progressBias)) {
      learning.progressBias = numberOr(input.progressBias, learning.progressBias, -20, 20)
    }
    if (typeof input.attentionBias === 'number' && Number.isFinite(input.attentionBias)) {
      learning.attentionBias = numberOr(input.attentionBias, learning.attentionBias, -20, 20)
    }
    if (Array.isArray(input.groups)) {
      for (const raw of input.groups.slice(0, 40)) {
        if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') continue
        const group = this.learningGroup(raw.name)
        if (Object.prototype.hasOwnProperty.call(raw, 'importanceBias')) {
          group.importanceBias = clamp(Number(raw.importanceBias) || 0, -2, 2)
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'attentionBias')) {
          group.attentionBias = numberOr(raw.attentionBias, group.attentionBias, -20, 20)
        }
      }
    }
    learning.updatedAt = nowMs()
    this.touch()
    return this.learningView()
  }

  /** Clear every learned preference. */
  resetLearning() {
    this.state.learning = emptyLearning()
    this.touch()
    return this.learningView()
  }

  /** Drop the recent-signal log but keep notes/biases. */
  clearLearningSignals() {
    this.state.learning.signals = []
    this.state.learning.updatedAt = nowMs()
    this.touch()
    return this.learningView()
  }

  /** @param {string} id */
  getSessionSummary(id) {
    return this.state.sessionSummaries[id] ?? null
  }

  /** @param {object} entry */
  putSessionSummary(entry) {
    this.state.sessionSummaries[entry.id] = entry
    const entries = Object.values(this.state.sessionSummaries)
    if (entries.length > SESSION_SUMMARY_KEEP) {
      entries.sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0))
      this.state.sessionSummaries = Object.fromEntries(entries.slice(0, SESSION_SUMMARY_KEEP).map((summary) => [summary.id, summary]))
    }
    this.touch()
  }

  /** @param {number} now */
  snapshot(now = nowMs()) {
    const settings = this.state.settings
    const activities = this.state.activities.slice(0, ACTIVITY_KEEP)
    return {
      ok: true,
      revision: this.state.revision,
      now,
      panelId: PANEL_ID,
      stateDir: this.dir,
      settings: {
        dreamEnabled: settings.dreamEnabled,
        dreamIntervalMinutes: settings.dreamIntervalMinutes,
        windowHours: settings.windowHours,
        staleHours: settings.staleHours,
        forgetHours: settings.forgetHours,
        maxSessions: settings.maxSessions,
        evalMode: settings.evalMode,
        evalProvider: settings.evalProvider,
        evalModel: settings.evalModel,
        evalMaxSessions: settings.evalMaxSessions,
        evalMaxItems: settings.evalMaxItems,
      },
      evaluation: this.evaluator ? this.evaluator.evaluationView(settings) : {
        mode: settings.evalMode,
        enabled: false,
        provider: settings.evalProvider,
        model: settings.evalModel,
        followsDefault: !(settings.evalProvider && settings.evalModel),
        available: false,
        lastModel: null,
        lastDegraded: false,
      },
      learning: this.learningView(),
      groups: this.state.groups.map((group) => ({ id: group.id, name: group.name, createdAt: group.createdAt })),
      items: this.state.items.map((item) => this.itemView(item, now)),
      activities: activities.map((activity) => this.activityView(activity)),
      dream: {
        enabled: settings.dreamEnabled,
        intervalMinutes: settings.dreamIntervalMinutes,
        running: this.engineRunning,
        nextRunAt: settings.dreamEnabled
          ? (this.state.lastDreamAt || now) + settings.dreamIntervalMinutes * 60_000
          : null,
        lastRunAt: this.state.lastDreamAt || null,
        activity: activities.length > 0 ? this.activityView(activities[0]) : null,
        rollup: this.rollupView(),
      },
      loadWarning: this.loadWarning,
    }
  }

  /**
   * Record Session metadata linked from an item.
   * @param {{id:string,title:string,lastTouched:number,cwd?:string}} summary
   */
  rememberSession(summary) {
    this.state.sessionMeta[summary.id] = {
      id: summary.id,
      title: cleanLine(summary.title, MAX_TITLE) || summary.id,
      cwd: summary.cwd,
      lastTouched: summary.lastTouched,
    }
    const entries = Object.values(this.state.sessionMeta)
    if (entries.length > SESSION_META_KEEP) {
      entries.sort((a, b) => b.lastTouched - a.lastTouched)
      this.state.sessionMeta = Object.fromEntries(entries.slice(0, SESSION_META_KEEP).map((entry) => [entry.id, entry]))
    }
  }

  // -- mutations ------------------------------------------------------------

  /**
   * Create a manual (or tool-created) reminder item.
   * @param {Record<string, any>} payload
   */
  createItem(payload) {
    const title = cleanLine(payload?.title, MAX_TITLE)
    if (!title) throw new ReminderError('invalid', 'A reminder needs a non-empty title.')
    const now = nowMs()
    const group = payload?.groupId
      ? this.findGroup(payload.groupId)
      : this.groupForName(payload?.group ?? DEFAULT_GROUP_NAME).group
    if (!group) throw new ReminderError('not_found', 'The selected group does not exist.')
    const status = STATUSES.includes(payload?.status) ? payload.status : 'todo'
    const progress = numberOr(payload?.progress, status === 'done' ? 100 : 0, 0, 100)
    const importance = numberOr(payload?.importance, 3, 1, 5)
    const subtitle = cleanLine(payload?.subtitle, MAX_SUBTITLE)
    const manualFields = ['title']
    if (subtitle) manualFields.push('subtitle')
    if (payload && typeof payload.progress === 'number' && Number.isFinite(payload.progress)) manualFields.push('progress')
    if (payload && typeof payload.importance === 'number' && Number.isFinite(payload.importance)) manualFields.push('importance')
    const item = {
      id: newId('r'),
      title,
      subtitle,
      notes: cleanText(payload?.notes, MAX_TEXT),
      nextStep: cleanLine(payload?.nextStep, MAX_NEXT_STEP),
      groupId: group.id,
      status,
      statusNote: '',
      progress,
      importance,
      pinned: boolOr(payload?.pinned, false),
      source: 'manual',
      autoManaged: false,
      sessionIds: [],
      attentionScore: 0,
      attentionReason: '',
      attentionUpdatedAt: 0,
      lastAttentionFlagAt: 0,
      manualFields: [...new Set(manualFields)],
      lastAutoImportance: importance,
      lastAutoProgress: progress,
      createdAt: now,
      updatedAt: now,
      lastTouched: now,
    }
    this.state.items.push(item)
    this.touch()
    return item
  }

  /**
   * Update a reminder item with a whitelisted patch.
   * @param {string} id @param {Record<string, any>} patch
   */
  updateItem(id, patch) {
    const item = this.findItem(id)
    if (!item) throw new ReminderError('not_found', 'That reminder no longer exists.')
    const before = structuredClone(item)
    const next = patch && typeof patch === 'object' ? patch : {}
    const has = (key) => Object.prototype.hasOwnProperty.call(next, key)
    const lock = (field) => {
      if (!item.manualFields.includes(field)) item.manualFields.push(field)
    }
    if (has('title')) {
      const title = cleanLine(next.title, MAX_TITLE)
      if (!title) throw new ReminderError('invalid', 'A reminder needs a non-empty title.')
      if (title !== item.title) lock('title')
      item.title = title
    }
    if (has('subtitle')) {
      const subtitle = cleanLine(next.subtitle, MAX_SUBTITLE)
      if (subtitle !== item.subtitle) {
        if (subtitle) lock('subtitle')
        else item.manualFields = item.manualFields.filter((field) => field !== 'subtitle')
      }
      item.subtitle = subtitle
    }
    if (has('notes')) item.notes = cleanText(next.notes, MAX_TEXT)
    if (has('nextStep')) item.nextStep = cleanLine(next.nextStep, MAX_NEXT_STEP)
    if (has('groupId')) {
      if (!this.findGroup(next.groupId)) throw new ReminderError('not_found', 'The selected group does not exist.')
      item.groupId = next.groupId
    }
    if (has('status')) {
      if (!STATUSES.includes(next.status)) throw new ReminderError('invalid', 'Unknown status.')
      item.status = next.status
      if (next.status !== 'awaiting') item.statusNote = ''
      if (next.status === 'done') {
        item.progress = 100
        item.attentionScore = 0
        item.attentionReason = ''
      } else if (item.progress === 100) {
        item.progress = 90
      }
    }
    if (has('progress')) {
      const progress = numberOr(next.progress, item.progress, 0, 100)
      if (progress !== item.progress) lock('progress')
      item.progress = progress
    }
    if (has('importance')) {
      const importance = numberOr(next.importance, item.importance, 1, 5)
      if (importance !== item.importance) lock('importance')
      item.importance = importance
    }
    if (has('pinned')) item.pinned = boolOr(next.pinned, item.pinned)
    item.updatedAt = nowMs()
    item.lastTouched = Math.max(item.lastTouched, item.updatedAt)
    item.autoManaged = false
    this.learnFromEdit(before, item)
    this.touch()
    return item
  }

  /**
   * Restore automatic grading for some manual-locked fields.
   * @param {string} id @param {string[]|undefined} fields
   */
  unlockItem(id, fields) {
    const item = this.findItem(id)
    if (!item) throw new ReminderError('not_found', 'That reminder no longer exists.')
    const requested = Array.isArray(fields) && fields.length > 0
      ? fields.filter((field) => MANUAL_FIELDS.includes(field))
      : [...MANUAL_FIELDS]
    item.manualFields = item.manualFields.filter((field) => !requested.includes(field))
    item.updatedAt = nowMs()
    this.touch()
    return item
  }

  /** @param {string} id */
  deleteItem(id) {
    const index = this.state.items.findIndex((item) => item.id === id)
    if (index < 0) throw new ReminderError('not_found', 'That reminder no longer exists.')
    const removed = this.state.items[index]
    this.learnFromDelete(removed)
    this.state.items.splice(index, 1)
    this.touch()
    return removed
  }

  /** @param {string} name */
  createGroup(name) {
    const cleanName = cleanLine(name, 60)
    if (!cleanName) throw new ReminderError('invalid', 'A group needs a non-empty name.')
    const existing = this.findGroupByName(cleanName)
    if (existing) return existing
    const group = { id: newId('g'), name: cleanName, createdAt: nowMs() }
    this.state.groups.push(group)
    this.touch()
    return group
  }

  /** @param {string} id @param {string} name */
  renameGroup(id, name) {
    const group = this.findGroup(id)
    if (!group) throw new ReminderError('not_found', 'That group no longer exists.')
    const cleanName = cleanLine(name, 60)
    if (!cleanName) throw new ReminderError('invalid', 'A group needs a non-empty name.')
    const clash = this.findGroupByName(cleanName)
    if (clash && clash.id !== group.id) throw new ReminderError('invalid', 'Another group already uses that name.')
    group.name = cleanName
    this.touch()
    return group
  }

  /** @param {string} id */
  deleteGroup(id) {
    const index = this.state.groups.findIndex((group) => group.id === id)
    if (index < 0) throw new ReminderError('not_found', 'That group no longer exists.')
    this.state.groups.splice(index, 1)
    const fallback = ensureDefaultGroup(this.state.groups)
    for (const item of this.state.items) {
      if (item.groupId === id) item.groupId = fallback.id
    }
    this.touch()
    return { id, movedTo: fallback.id }
  }

  /** @param {Record<string, any>} payload */
  updateSettings(payload) {
    const settings = this.state.settings
    if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'dreamEnabled')) {
      settings.dreamEnabled = boolOr(payload.dreamEnabled, settings.dreamEnabled)
    }
    if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'dreamIntervalMinutes')) {
      settings.dreamIntervalMinutes = numberOr(payload.dreamIntervalMinutes, settings.dreamIntervalMinutes, 1, 1440)
    }
    if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'windowHours')) {
      settings.windowHours = numberOr(payload.windowHours, settings.windowHours, 1, 720)
    }
    if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'maxSessions')) {
      settings.maxSessions = numberOr(payload.maxSessions, settings.maxSessions, 1, 50)
    }
    if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'staleHours')) {
      settings.staleHours = numberOr(payload.staleHours, settings.staleHours, 1, 720)
    }
    if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'forgetHours')) {
      settings.forgetHours = numberOr(payload.forgetHours, settings.forgetHours, 1, 2160)
    }
    const input = payload && typeof payload === 'object' ? payload : {}
    if (typeof input.evalMode === 'string') {
      settings.evalMode = input.evalMode === 'heuristic' ? 'heuristic' : 'model'
    }
    if (input.evalProvider !== undefined || input.evalModel !== undefined) {
      const provider = cleanLine(input.evalProvider, 120)
      const model = cleanLine(input.evalModel, 120)
      if (provider && model) {
        settings.evalProvider = provider
        settings.evalModel = model
      } else {
        settings.evalProvider = ''
        settings.evalModel = ''
      }
    }
    if (typeof input.evalMaxSessions === 'number') {
      settings.evalMaxSessions = numberOr(input.evalMaxSessions, settings.evalMaxSessions, 1, 30)
    }
    if (typeof input.evalMaxItems === 'number') {
      settings.evalMaxItems = numberOr(input.evalMaxItems, settings.evalMaxItems, 0, 40)
    }
    // "stale" must start before a reminder becomes "cold"/forgotten.
    if (settings.staleHours > settings.forgetHours) settings.forgetHours = settings.staleHours
    this.touch()
    return { ...settings }
  }

  /**
   * Undo the most recent (or named) dream run.
   * @param {string|undefined} activityId
   */
  undoDream(activityId) {
    const activity = activityId
      ? this.state.activities.find((entry) => entry.id === activityId)
      : this.state.activities.find((entry) => entry.undoable && entry.undo)
    if (!activity) throw new ReminderError('not_found', 'There is no dream run to undo.')
    if (!activity.undoable || !activity.undo) throw new ReminderError('invalid', 'That dream run cannot be undone.')
    const restoredItems = activity.undo.items
      .map(normalizeItem)
      .filter(Boolean)
    const restoredGroups = activity.undo.groups
      .map(normalizeGroup)
      .filter(Boolean)
    this.state.items = restoredItems
    this.state.groups = restoredGroups.length > 0 ? restoredGroups : []
    ensureDefaultGroup(this.state.groups)
    const knownGroups = new Set(this.state.groups.map((group) => group.id))
    const fallback = ensureDefaultGroup(this.state.groups)
    for (const item of this.state.items) if (!knownGroups.has(item.groupId)) item.groupId = fallback.id
    activity.undoable = false
    activity.undone = true
    this.touch()
    return this.activityView(activity)
  }
}

// ---------------------------------------------------------------------------
// Session scanner (read-only)
// ---------------------------------------------------------------------------

/** Read-only Session corpus scanner used only by the dreaming engine. */
class SessionScanner {
  /** @param {object} ctx */
  constructor(ctx) {
    this.ctx = ctx
  }

  /**
   * Collect recent Session summaries.
   * @param {{signal?:AbortSignal, windowHours:number, maxSessions:number, maxCandidates?:number}} options
   */
  async scan(options) {
    const { signal } = options
    const now = nowMs()
    const windowHours = options.windowHours
    const maxSessions = options.maxSessions
    const maxCandidates = options.maxCandidates ?? 60
    const query = this.ctx.get('sessionQuery')
    const persistence = this.ctx.get('sessionPersistence')
    const sessionsService = this.ctx.get('sessions')

    /** @type {Map<string, any>} */
    const candidates = new Map()

    let persistedSnapshots = []
    if (persistence) {
      try {
        persistedSnapshots = await persistence.list({ signal })
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    for (const snapshot of persistedSnapshots) {
      const header = snapshot?.header
      if (!header || typeof header.id !== 'string') continue
      if (header.origin === 'subagent') continue
      let recency = typeof header.createdAt === 'number' ? header.createdAt : 0
      const locationPath = snapshot.location?.path
      if (typeof locationPath === 'string') {
        try {
          const stats = await stat(locationPath)
          if (Number.isFinite(stats.mtimeMs)) recency = Math.max(recency, stats.mtimeMs)
        } catch {
          // an unmaterialized or vanishing log keeps its header timestamp
        }
      }
      candidates.set(header.id, {
        id: header.id,
        header,
        live: false,
        recency,
        eventCount: typeof snapshot.eventCount === 'number' ? snapshot.eventCount : undefined,
      })
    }

    if (sessionsService) {
      for (const session of sessionsService.list()) {
        const header = session.header
        if (!header || typeof header.id !== 'string') continue
        if (header.origin === 'subagent') continue
        let lastTime = typeof header.createdAt === 'number' ? header.createdAt : 0
        try {
          const last = session.seq > 0 ? session.eventAt(session.seq - 1) : undefined
          if (last && typeof last.time === 'number') lastTime = Math.max(lastTime, last.time)
        } catch {
          // a session with no readable tail keeps its creation time
        }
        const previous = candidates.get(header.id)
        candidates.set(header.id, {
          id: header.id,
          header,
          live: true,
          session,
          recency: Math.max(lastTime, previous?.recency ?? 0),
          eventCount: previous?.eventCount,
        })
      }
    }

    const cutoff = now - windowHours * 3_600_000
    const ranked = [...candidates.values()]
      .filter((candidate) => candidate.recency >= cutoff)
      .sort((a, b) => b.recency - a.recency)
      .slice(0, maxCandidates)

    // One batched title fold keeps display titles (usually LLM-generated).
    const titles = new Map()
    if (query?.readTitleSnapshots && ranked.length > 0) {
      try {
        const results = await query.readTitleSnapshots(ranked.map((candidate) => candidate.id), signal)
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value?.title?.title) {
            titles.set(result.sessionId, result.value.title.title)
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }

    const summaries = []
    for (const candidate of ranked.slice(0, maxSessions)) {
      signal?.throwIfAborted()
      try {
        const summary = await this.describe(candidate, titles.get(candidate.id), signal)
        if (summary) summaries.push(summary)
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return summaries
  }

  /**
   * Describe one candidate Session from a first-events + tail-events sample.
   * The lightweight event index refines turn count and recovers the latest user
   * request when a long running turn pushed it out of the sampled tail.
   * @param {any} candidate @param {string|undefined} title @param {AbortSignal|undefined} signal
   */
  async describe(candidate, title, signal) {
    const events = await this.readEvents(candidate, signal)
    if (events.length === 0) return null
    const info = analyzeEvents(events)
    const refined = await this.refine(candidate, info, signal)
    const displayTitle = title || info.title
    const hasWork = Boolean(info.firstUserText || refined.lastUserText || displayTitle)
    if (!hasWork) return null
    const cwd = typeof candidate.header.cwd === 'string' ? candidate.header.cwd : undefined
    const pendingIssue = refined.hasApprovalRecords
      ? (refined.pendingApproval ? 'permission' : (info.pendingQuestion ? 'question' : ''))
      : (info.pendingIssue || (refined.pendingApproval ? 'permission' : ''))
    const sessionTitle = titleForSession({ title: displayTitle ?? '', firstUserText: info.firstUserText, lastUserText: refined.lastUserText, cwd })
    const lastActivity = Math.max(candidate.recency ?? 0, info.lastTime ?? 0, refined.lastActivity ?? 0)
    const state = pendingIssue ? 'awaiting' : info.state
    const summary = {
      id: candidate.id,
      title: sessionTitle,
      cwd,
      groupName: groupNameForCwd(cwd),
      lastActivity,
      firstUserText: info.firstUserText,
      lastUserText: refined.lastUserText,
      lastAssistantText: info.lastAssistantText,
      lastError: info.lastError,
      tools: info.tools,
      turnEnds: refined.turnEnds,
      state,
      pendingIssue,
      pendingApproval: pendingIssue === 'permission',
      pendingQuestion: pendingIssue === 'question',
      eventCount: typeof candidate.eventCount === 'number' ? candidate.eventCount : undefined,
      fingerprint: fingerprintOf({
        id: candidate.id,
        title: sessionTitle,
        eventCount: candidate.eventCount,
        lastActivity,
        lastUserText: refined.lastUserText,
        lastAssistantText: info.lastAssistantText,
        lastError: info.lastError,
        state,
        pendingIssue,
        tools: info.tools,
        turnEnds: refined.turnEnds,
      }),
    }
    return summary
  }

  /**
   * Refine sampled facts with `sessionQuery`'s lightweight event index: exact
   * turn ends, real last event time/state, and the latest user text fetched by
   * seq when the sample missed it.
   * @param {any} candidate @param {ReturnType<typeof analyzeEvents>} info @param {AbortSignal|undefined} signal
   */
  async refine(candidate, info, signal) {
    const refined = {
      turnEnds: info.turnEnds,
      lastActivity: 0,
      lastUserText: info.lastUserText,
      state: info.state,
      pendingApproval: info.pendingApproval,
      hasApprovalRecords: false,
    }
    const query = this.ctx.get('sessionQuery')
    if (!query || typeof query.listEvents !== 'function') return refined
    let records
    try {
      records = await query.listEvents(candidate.id)
    } catch (error) {
      if (signal?.aborted) throw error
      return refined
    }
    if (!Array.isArray(records) || records.length === 0) return refined
    refined.turnEnds = records.reduce((count, record) => count + (record?.type === 'turn/end' ? 1 : 0), 0)
    const lastRecord = records[records.length - 1]
    if (typeof lastRecord?.time === 'number') refined.lastActivity = lastRecord.time
    let lastAsked = 0
    let lastDecided = 0
    let sawApproval = false
    for (const record of records) {
      if (record?.type !== 'approval/asked' && record?.type !== 'approval/decided') continue
      sawApproval = true
      const seq = typeof record.seq === 'number' ? record.seq : 0
      if (record.type === 'approval/asked') lastAsked = Math.max(lastAsked, seq)
      else lastDecided = Math.max(lastDecided, seq)
    }
    if (sawApproval) {
      refined.hasApprovalRecords = true
      refined.pendingApproval = lastAsked > lastDecided
    }
    if (!refined.lastUserText && typeof query.readEvent === 'function') {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index]?.type !== 'user/message') continue
        try {
          const window = await query.readEvent({ sessionId: candidate.id, seq: records[index].seq })
          const text = userMessageText(window?.target, 2000)
          if (text) {
            refined.lastUserText = text
            break
          }
        } catch (error) {
          if (signal?.aborted) throw error
        }
      }
    }
    return refined
  }

  /**
   * Read the first and last samples of one Session's event log.
   * @param {any} candidate @param {AbortSignal|undefined} signal
   */
  async readEvents(candidate, signal) {
    const firstSize = 40
    const tailSize = 80
    /** @type {Array<object>} */
    let first = []
    /** @type {Array<object>} */
    let last = []

    if (candidate.live && candidate.session) {
      const session = candidate.session
      const total = typeof session.seq === 'number' ? session.seq : 0
      const firstEnd = Math.min(total, firstSize)
      for (let seq = 0; seq < firstEnd; seq += 1) {
        try {
          const event = session.eventAt(seq)
          if (event) first.push(event)
        } catch {
          break
        }
      }
      const tailStart = Math.max(firstEnd, total - tailSize)
      for (let seq = tailStart; seq < total; seq += 1) {
        try {
          const event = session.eventAt(seq)
          if (event) last.push(event)
        } catch {
          break
        }
      }
      return mergeEvents(first, last)
    }

    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) return []
    let handle
    try {
      handle = await persistence.open(candidate.id, 'read', { signal })
    } catch {
      return []
    }
    try {
      const count = typeof candidate.eventCount === 'number' ? candidate.eventCount : undefined
      const head = await handle.read(0, firstSize, { signal })
      first = [...head.events]
      if (typeof count === 'number' && count > firstSize) {
        const start = Math.max(firstSize, count - tailSize)
        const tail = await handle.read(start, tailSize, { signal })
        last = [...tail.events]
      }
    } catch (error) {
      if (signal?.aborted) throw error
    } finally {
      try {
        await handle.close()
      } catch {
        // closing a read handle is best effort
      }
    }
    return mergeEvents(first, last)
  }
}

// ---------------------------------------------------------------------------
// Dreaming engine
// ---------------------------------------------------------------------------

/**
 * Dreaming engine: scan recent Sessions, evaluate changed work (LLM when a
 * route is available, deterministic heuristics otherwise), fold the result into
 * the reminder list, refresh attention, and record what happened.
 */
class DreamEngine {
  /**
   * @param {ReminderStore} store @param {object} ctx
   */
  constructor(store, ctx) {
    this.store = store
    this.ctx = ctx
    this.scanner = new SessionScanner(ctx)
    this.current = null
    this.evaluator = new DreamEvaluator(ctx, store)
    store.evaluator = this.evaluator
  }

  get running() {
    return this.current !== null
  }

  /**
   * Run one dreaming pass, serialized against other runs.
   * @param {{trigger?:string, signal?:AbortSignal}} options
   */
  async run(options = {}) {
    if (this.current) return this.current
    const promise = this.#run(options).finally(() => {
      this.current = null
    })
    this.current = promise
    return promise
  }

  /**
   * @param {{trigger?:string, signal?:AbortSignal}} options
   */
  async #run(options) {
    const store = this.store
    await store.ready
    const state = store.state
    const settings = state.settings
    const now = nowMs()
    const activity = {
      id: newId('a'),
      status: 'running',
      trigger: typeof options.trigger === 'string' && options.trigger.length > 0 ? cleanLine(options.trigger, 20) : 'auto',
      startedAt: now,
      scanned: 0,
      created: 0,
      updated: 0,
      attention: 0,
      evaluated: 0,
      graded: 0,
      model: null,
      degraded: false,
      summary: 'Scanning recent sessions…',
      undoable: false,
      undone: false,
      changes: [],
      undo: {
        items: state.items.map((item) => structuredClone(item)),
        groups: state.groups.map((group) => structuredClone(group)),
      },
    }
    state.activities.unshift(activity)
    store.pruneActivities()
    store.engineRunning = true
    store.touch()

    try {
      const summaries = await this.scanner.scan({
        signal: options.signal,
        windowHours: settings.windowHours,
        maxSessions: settings.maxSessions,
      })
      activity.scanned = summaries.length
      activity.summary = `Scanned ${summaries.length} session${summaries.length === 1 ? '' : 's'}…`

      const changed = []
      for (const summary of summaries) {
        const cached = store.getSessionSummary(summary.id)
        summary.cached = cached && cached.fingerprint === summary.fingerprint && cached.model ? cached : null
        if (!summary.cached) changed.push(summary)
      }
      const openItems = state.items.filter((item) => item.status !== 'done')
      let sessionEvals = new Map()
      let itemEvals = new Map()
      let modelLabel = null
      let degraded = false
      let evalError = null
      const route = settings.evalMode === 'heuristic' ? null : this.evaluator.resolveRoute(settings)
      const sessionPayload = changed.slice(0, settings.evalMaxSessions).map((summary) => this.#sessionPayload(summary, state))
      const itemPayload = openItems.slice(0, settings.evalMaxItems).map((item) => this.#itemPayload(item, state))
      if (route && (sessionPayload.length > 0 || itemPayload.length > 0)) {
        try {
          const result = await this.evaluator.evaluate({
            sessions: sessionPayload,
            items: itemPayload,
            learning: state.learning,
            settings,
            signal: options.signal,
          })
          sessionEvals = result.sessions
          itemEvals = result.items
          modelLabel = `${result.route.provider}/${result.route.model}`
          activity.evaluated = sessionPayload.length
          activity.graded = itemPayload.length
        } catch (error) {
          degraded = true
          evalError = error instanceof Error ? error.message : String(error)
        }
      }
      activity.model = modelLabel
      activity.degraded = degraded
      if (evalError) activity.error = cleanLine(evalError, 400)

      const decisions = []
      for (const summary of summaries) {
        decisions.push(this.#decideSession(summary, sessionEvals.get(summary.id), settings, state.learning, now, modelLabel))
      }
      // Only model-graded summaries enter the cache; heuristic mode never poisons it.
      if (settings.evalMode !== 'heuristic') {
        for (const decision of decisions) {
          if (!decision.model) continue
          store.putSessionSummary({
            id: decision.summary.id,
            fingerprint: decision.summary.fingerprint,
            title: decision.title,
            subtitle: decision.subtitle,
            progress: decision.progress,
            importance: decision.importance,
            status: decision.status,
            attention: decision.attention ?? 0,
            attentionReason: decision.attentionReason,
            groupName: decision.groupName,
            generatedAt: now,
            model: decision.model,
          })
        }
      }

      const updatedItemIds = new Set()
      for (const decision of decisions) {
        this.#applyDecision(decision, activity, updatedItemIds, settings, state, now, itemEvals)
      }
      this.#applyItemGrades(activity, itemEvals, settings, state, now)
      this.#applyHeuristicAttention(settings, state, now)
      this.#flagAttention(activity, state, now)

      const parts = [`Scanned ${summaries.length} session${summaries.length === 1 ? '' : 's'}`]
      if (activity.created > 0) parts.push(`${activity.created} new`)
      if (activity.updated > 0) parts.push(`${activity.updated} updated`)
      if (activity.attention > 0) parts.push(`${activity.attention} need${activity.attention === 1 ? 's' : ''} attention`)
      if (modelLabel) parts.push(`evaluated by ${modelLabel}`)
      else if (settings.evalMode !== 'heuristic') parts.push(degraded ? 'heuristic fallback' : 'heuristic mode')
      activity.status = 'done'
      activity.endedAt = nowMs()
      activity.summary = parts.join(' · ')
      activity.undoable = activity.created + activity.updated > 0
      if (!activity.undoable) activity.undo = undefined
      state.lastDreamAt = activity.endedAt
      store.touch()
      await store.persist()
      return store.activityView(activity)
    } catch (error) {
      activity.status = 'error'
      activity.endedAt = nowMs()
      activity.error = cleanLine(error instanceof Error ? error.message : String(error), 400)
      activity.summary = `Dreaming failed: ${activity.error}`
      activity.undo = undefined
      state.lastDreamAt = activity.endedAt
      store.touch()
      await store.persist()
      return store.activityView(activity)
    } finally {
      store.engineRunning = false
    }
  }

  /**
   * Compact Session payload for the evaluator.
   * @param {object} summary @param {object} state
   */
  #sessionPayload(summary, state) {
    return {
      id: summary.id,
      title: summary.title,
      cwd: summary.cwd,
      lastUserText: summary.lastUserText,
      lastAssistantText: summary.lastAssistantText,
      state: summary.state,
      pendingIssue: summary.pendingIssue,
      tools: summary.tools,
      lastActivity: summary.lastActivity,
      turnEnds: summary.turnEnds,
      linkedItem: this.#linkedItemView(summary, state),
    }
  }

  /**
   * Compact item payload for the evaluator.
   * @param {object} item @param {object} state
   */
  #itemPayload(item, state) {
    return {
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      groupName: this.store.groupNameOf(item),
      status: item.status,
      importance: item.importance,
      progress: item.progress,
      lastTouched: item.lastTouched,
      freshness: deriveFreshness(item.lastTouched, state.settings, nowMs()),
      pinned: item.pinned,
      statusNote: item.statusNote,
      manualFields: item.manualFields,
    }
  }

  /**
   * @param {object} summary @param {object} state
   */
  #linkedItemView(summary, state) {
    const item = state.items.find((entry) => entry.sessionIds.includes(summary.id))
    if (!item) return null
    return {
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      status: item.status,
      progress: item.progress,
      importance: item.importance,
      manualFields: item.manualFields,
    }
  }

  /**
   * Final evaluation for one Session: cached, model-graded, or heuristic.
   * @param {object} summary @param {object|undefined} llmEval @param {object} settings
   * @param {object} learning @param {number} now @param {string|null} modelLabel
   */
  #decideSession(summary, llmEval, settings, learning, now, modelLabel) {
    const cached = summary.cached
    if (cached) {
      const status = summary.pendingIssue ? 'awaiting' : cached.status
      return {
        summary,
        title: summary.title,
        subtitle: cached.subtitle || heuristicSubtitle(summary),
        progress: cached.progress,
        importance: cached.importance,
        status,
        statusNote: summary.pendingIssue === 'permission'
          ? 'Waiting for your permission.'
          : summary.pendingIssue === 'question'
            ? 'Waiting for your answer.'
            : (status === 'blocked' ? cleanLine(summary.lastError, 160) : ''),
        attention: cached.attention,
        attentionReason: summary.pendingIssue
          ? 'Waiting for you.'
          : (cached.attentionReason || ''),
        groupName: cached.groupName || summary.groupName,
        model: cached.model,
        source: 'cache',
      }
    }
    const groupName = llmEval?.group || summary.groupName || DEFAULT_GROUP_NAME
    const groupImportanceBias = learnedGroupBias(learning, groupName, 'importance')
    const groupAttentionBias = learnedGroupBias(learning, groupName, 'attention')
    const hasModel = Boolean(llmEval)
    const subtitle = (hasModel && llmEval.subtitle) || heuristicSubtitle(summary)
    let progress = hasModel && typeof llmEval.progress === 'number'
      ? llmEval.progress + (settings.evalMode === 'model' ? learning.progressBias : 0)
      : suggestedProgress(summary)
    progress = clamp(progress, 0, 100)
    const importance = hasModel && typeof llmEval.importance === 'number'
      ? clamp(llmEval.importance + learning.importanceBias + groupImportanceBias, 1, 5)
      : null
    let status = summary.pendingIssue ? 'awaiting' : (hasModel && llmEval.status ? llmEval.status : heuristicStatus(summary))
    if (status === 'done') status = 'doing'
    const attention = hasModel && typeof llmEval.attention === 'number'
      ? clamp(llmEval.attention + learning.attentionBias + groupAttentionBias, 0, 100)
      : null
    let attentionReason = hasModel ? (llmEval.attentionReason || '') : ''
    let statusNote = ''
    if (summary.pendingIssue === 'permission') statusNote = 'Waiting for your permission.'
    else if (summary.pendingIssue === 'question') statusNote = 'Waiting for your answer.'
    else if (status === 'blocked') statusNote = cleanLine(summary.lastError, 160)
    else if (status === 'awaiting') statusNote = attentionReason || 'Waiting for you.'
    if (status === 'awaiting' && !attentionReason) attentionReason = statusNote
    return {
      summary,
      title: summary.title,
      subtitle,
      progress,
      importance: importance ?? (summary.cached?.importance ?? 3),
      status,
      statusNote,
      attention,
      attentionReason,
      groupName,
      model: hasModel ? modelLabel : null,
      source: hasModel ? 'model' : 'heuristic',
    }
  }

  /**
   * Fold one Session decision into a reminder item.
   * @param {object} decision @param {object} activity @param {Set<string>} updatedItemIds
   * @param {object} settings @param {object} state @param {number} now @param {Map<string,object>} itemEvals
   */
  #applyDecision(decision, activity, updatedItemIds, settings, state, now, itemEvals) {
    const store = this.store
    const summary = decision.summary
    const group = store.groupForName(decision.groupName).group
    store.rememberSession(summary)
    let item = this.#matchItem(summary, group.id)
    let created = false
    if (!item) {
      item = {
        id: newId('r'),
        title: decision.title,
        subtitle: decision.subtitle,
        notes: cleanLine(summary.lastAssistantText, 300),
        nextStep: cleanLine(summary.lastUserText, MAX_NEXT_STEP),
        groupId: group.id,
        status: decision.status,
        statusNote: decision.statusNote,
        progress: decision.progress,
        importance: decision.importance,
        pinned: false,
        source: 'dream',
        autoManaged: true,
        sessionIds: [summary.id],
        attentionScore: decision.attention ?? 0,
        attentionReason: decision.attentionReason || decision.statusNote || '',
        attentionUpdatedAt: now,
        lastAttentionFlagAt: 0,
        manualFields: [],
        lastAutoImportance: decision.importance,
        lastAutoProgress: decision.progress,
        createdAt: now,
        updatedAt: now,
        lastTouched: summary.lastActivity,
        lastDreamBatchId: activity.id,
      }
      state.items.push(item)
      created = true
    } else {
      const before = structuredClone(item)
      if (!item.sessionIds.includes(summary.id)) item.sessionIds.push(summary.id)
      if (item.status !== 'done') {
        if (!item.manualFields.includes('title') && decision.title) item.title = decision.title
        if (!item.manualFields.includes('subtitle') && decision.subtitle) item.subtitle = decision.subtitle
        if (!item.manualFields.includes('progress')) {
          item.progress = decision.source === 'heuristic'
            ? Math.max(item.progress, decision.progress)
            : decision.progress
        }
        if (!item.manualFields.includes('importance') && decision.source !== 'heuristic') item.importance = decision.importance
        item.status = decision.status
        item.statusNote = decision.statusNote
        if (!item.nextStep && summary.lastUserText) item.nextStep = cleanLine(summary.lastUserText, MAX_NEXT_STEP)
        if (!item.notes && summary.lastAssistantText) item.notes = cleanLine(summary.lastAssistantText, 300)
        item.lastAutoImportance = decision.importance
        item.lastAutoProgress = decision.progress
      }
      item.lastTouched = Math.max(item.lastTouched, summary.lastActivity)
      item.updatedAt = now
      const changedFields = ['title', 'subtitle', 'status', 'progress', 'importance']
        .some((field) => before[field] !== item[field])
      if (changedFields) {
        activity.updated += 1
        activity.changes.push({
          itemId: item.id,
          title: item.title,
          kind: 'updated',
          detail: decision.subtitle || summarizeSession(summary, 'updated'),
        })
      }
    }
    const itemGrade = itemEvals.get(item.id)
    const attention = itemGrade?.attention ?? (decision.source === 'cache' ? undefined : decision.attention)
    if (typeof attention === 'number') {
      item.attentionScore = attention
      item.attentionReason = itemGrade?.attentionReason || decision.attentionReason || decision.statusNote || ''
      item.attentionUpdatedAt = now
    } else {
      const heuristic = attentionForItem(item, state.learning, decision.groupName, now)
      item.attentionScore = heuristic.score
      item.attentionReason = decision.statusNote || heuristic.reason
      item.attentionUpdatedAt = now
    }
    if (created) {
      activity.created += 1
      activity.changes.push({
        itemId: item.id,
        title: item.title,
        kind: 'created',
        detail: decision.subtitle || summarizeSession(summary, 'created'),
      })
    } else if (!itemEvals.has(item.id) && !updatedItemIds.has(item.id) && typeof decision.attention === 'number') {
      item.attentionScore = decision.attention
      item.attentionReason = decision.attentionReason
      item.attentionUpdatedAt = now
    }
    updatedItemIds.add(item.id)
  }

  /**
   * Apply model grades for every evaluated open item (importance/progress/attention),
   * never touching manual-locked fields.
   * @param {object} activity @param {Map<string,object>} itemEvals
   * @param {object} settings @param {object} state @param {number} now
   */
  #applyItemGrades(activity, itemEvals, settings, state, now) {
    const learning = state.learning
    for (const [itemId, grade] of itemEvals) {
      const item = state.items.find((entry) => entry.id === itemId)
      if (!item || item.status === 'done') continue
      const groupName = this.store.groupNameOf(item)
      const groupImportanceBias = learnedGroupBias(learning, groupName, 'importance')
      const groupAttentionBias = learnedGroupBias(learning, groupName, 'attention')
      if (typeof grade.importance === 'number' && !item.manualFields.includes('importance')) {
        item.importance = clamp(grade.importance + learning.importanceBias + groupImportanceBias, 1, 5)
        item.lastAutoImportance = item.importance
      }
      if (typeof grade.progress === 'number' && !item.manualFields.includes('progress')) {
        item.progress = clamp(grade.progress + learning.progressBias, 0, 100)
        item.lastAutoProgress = item.progress
      }
      if (typeof grade.attention === 'number') {
        item.attentionScore = clamp(grade.attention + learning.attentionBias + groupAttentionBias, 0, 100)
        item.attentionReason = grade.attentionReason || item.attentionReason
        item.attentionUpdatedAt = now
      }
      item.updatedAt = now
    }
  }

  /**
   * Refresh attention heuristically for items no evaluation touched this pass.
   * @param {object} settings @param {object} state @param {number} now
   */
  #applyHeuristicAttention(settings, state, now) {
    const learning = state.learning
    for (const item of state.items) {
      if (item.status === 'done') continue
      if (item.attentionUpdatedAt >= now) continue
      const groupName = this.store.groupNameOf(item)
      const attention = attentionForItem(item, learning, groupName, now)
      item.attentionScore = attention.score
      item.attentionReason = attention.reason
      item.attentionUpdatedAt = now
    }
  }

  /**
   * Report items whose attention score crosses the threshold, without repeating
   * the same row on every pass.
   * @param {object} activity @param {object} state @param {number} now
   */
  #flagAttention(activity, state, now) {
    for (const item of state.items) {
      if (item.status === 'done') continue
      if ((item.attentionScore ?? 0) < ATTENTION_THRESHOLD) continue
      const lastFlag = item.lastAttentionFlagAt || 0
      if (now - lastFlag < ATTENTION_REFLAG_MS && (item.attentionScore ?? 0) < 85) continue
      item.lastAttentionFlagAt = now
      activity.attention += 1
      activity.changes.push({
        itemId: item.id,
        title: item.title,
        kind: 'attention',
        detail: cleanLine(item.attentionReason, 200) || `Attention ${item.attentionScore}`,
      })
    }
  }

  /**
   * Find the existing reminder that best represents a Session.
   * @param {object} summary @param {string} groupId
   */
  #matchItem(summary, groupId) {
    const items = this.store.state.items
    const linked = items.find((item) => item.sessionIds.includes(summary.id))
    if (linked) return linked
    const summaryTokens = tokenize(summary.title)
    let best
    let bestScore = 0
    for (const item of items) {
      if (item.groupId !== groupId) continue
      const score = jaccard(summaryTokens, tokenize(item.title))
      if (score > bestScore) {
        bestScore = score
        best = item
      }
    }
    return bestScore >= 0.34 ? best : undefined
  }
}

/** @param {object} summary @param {string} verb */
function summarizeSession(summary, verb) {
  const piece = summary.lastUserText
    ? cleanLine(summary.lastUserText, 110)
    : cleanLine(summary.title, 110)
  return piece ? `${verb}: ${piece}` : `${verb}: ${summary.title}`
}

// ---------------------------------------------------------------------------
// Action dispatch (shared by HTTP routes and the agent tool)
// ---------------------------------------------------------------------------

/**
 * Drop non-JSON values (notably `undefined` object properties) so a tool result
 * passes the canonical lossless-JSON check. Views build optional fields as
 * `undefined` for the browser's convenience; the model-facing value must not.
 * @param {unknown} value
 */
function toLosslessJson(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

/**
 * Normalize an unknown thrown value into the wire error shape.
 * @param {unknown} error
 */
function errorResponse(error) {
  if (error instanceof ReminderError) return { ok: false, error: { code: error.code, message: error.message } }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: 'internal', message: message.slice(0, 400) } }
}

/**
 * Run one user-visible operation.
 * @param {ReminderStore} store @param {DreamEngine} engine
 * @param {string} action @param {Record<string, any>} payload
 * @param {{awaitDream?:boolean, signal?:AbortSignal}} options
 */
async function dispatchAction(store, engine, action, payload, options = {}) {
  await store.ready
  const input = payload && typeof payload === 'object' ? payload : {}
  switch (action) {
    case 'item.create': {
      const item = store.createItem(input)
      await store.persist()
      return { ok: true, value: store.itemView(item) }
    }
    case 'item.update': {
      const item = store.updateItem(input.id, input.patch)
      await store.persist()
      return { ok: true, value: store.itemView(item) }
    }
    case 'item.delete': {
      const removed = store.deleteItem(input.id)
      await store.persist()
      return { ok: true, value: { id: removed.id } }
    }
    case 'group.create': {
      const group = store.createGroup(input.name)
      await store.persist()
      return { ok: true, value: { id: group.id, name: group.name } }
    }
    case 'group.rename': {
      const group = store.renameGroup(input.id, input.name)
      await store.persist()
      return { ok: true, value: { id: group.id, name: group.name } }
    }
    case 'group.delete': {
      const result = store.deleteGroup(input.id)
      await store.persist()
      return { ok: true, value: result }
    }
    case 'item.unlock': {
      const item = store.unlockItem(input.id, input.fields)
      await store.persist()
      return { ok: true, value: store.itemView(item) }
    }
    case 'settings.update': {
      const settings = store.updateSettings(input)
      await store.persist()
      return { ok: true, value: settings }
    }
    case 'learning.update': {
      const learning = store.updateLearning(input)
      await store.persist()
      return { ok: true, value: learning }
    }
    case 'learning.reset': {
      const learning = store.resetLearning()
      await store.persist()
      return { ok: true, value: learning }
    }
    case 'learning.clearSignals': {
      const learning = store.clearLearningSignals()
      await store.persist()
      return { ok: true, value: learning }
    }
    case 'models.list': {
      const catalog = await engine.evaluator.listCatalog()
      return { ok: true, value: catalog }
    }
    case 'dream.run': {
      if (engine.running) return { ok: true, value: { started: false, busy: true } }
      if (options.awaitDream) {
        const activity = await engine.run({ trigger: 'manual', signal: options.signal })
        return { ok: true, value: activity }
      }
      void engine.run({ trigger: 'manual' })
      return { ok: true, value: { started: true } }
    }
    case 'dream.status': {
      return { ok: true, value: store.snapshot() }
    }
    case 'dream.undo': {
      const activity = store.undoDream(input.activityId)
      await store.persist()
      return { ok: true, value: activity }
    }
    default:
      throw new ReminderError('invalid', `Unknown reminder action "${action}".`)
  }
}

/**
 * The agent-facing `reminders` tool.
 * @param {ReminderStore} store @param {DreamEngine} engine
 */
function createRemindersTool(store, engine) {
  return {
    name: TOOL_NAME,
    description:
      'Maintain the user\'s reminder list of work in progress (the Reminders panel). ' +
      'Actions: list (grouped snapshot), get (one item), create, update, delete, item_unlock, ' +
      'group_create, group_delete, dream_run (scan recent Sessions now and fold results in), ' +
      'dream_status, undo_dream, update_settings, learning_status, learning_update, ' +
      'learning_reset, models_list. Dreaming is LLM-evaluated when enabled, so prefer `list` ' +
      'first to avoid duplicating an item that dreaming already created.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list', 'get', 'create', 'update', 'delete', 'item_unlock', 'group_create', 'group_delete',
            'dream_run', 'dream_status', 'undo_dream', 'update_settings', 'learning_status',
            'learning_update', 'learning_reset', 'models_list',
          ],
          description: 'Operation to run.',
        },
        id: { type: 'string', description: 'Reminder id for get/update/delete, or group id for group_delete.' },
        title: { type: 'string', description: 'Reminder title for create/update (non-empty, at most 200 chars).' },
        subtitle: { type: 'string', description: 'Short progress summary shown under the title.' },
        notes: { type: 'string', description: 'Free-form notes for the reminder.' },
        nextStep: { type: 'string', description: 'The concrete next step for this work item.' },
        group: { type: 'string', description: 'Group display name: used by list as a filter and by create as a target group.' },
        groupId: { type: 'string', description: 'Group id for create/update.' },
        status: { type: 'string', enum: STATUSES, description: 'Lifecycle status.' },
        progress: { type: 'integer', description: 'Completion percentage 0-100.' },
        importance: { type: 'integer', description: 'Importance 1 (low) to 5 (critical).' },
        pinned: { type: 'boolean', description: 'Pin the item to the top of its group.' },
        patch: { type: 'object', description: 'Raw update fields for update (same names as above).' },
        activityId: { type: 'string', description: 'Dream activity to undo; omit for the latest run.' },
        dreamEnabled: { type: 'boolean', description: 'Turn automatic dreaming on or off.' },
        dreamIntervalMinutes: { type: 'integer', description: 'Dreaming interval in minutes (1-1440).' },
        windowHours: { type: 'integer', description: 'How far back to scan Sessions, in hours.' },
        evalMode: { type: 'string', enum: ['model', 'heuristic'], description: 'LLM evaluation or deterministic fallback for dreaming.' },
        evalProvider: { type: 'string', description: 'Evaluation model provider; empty follows the default model.' },
        evalModel: { type: 'string', description: 'Evaluation model id; empty follows the default model.' },
        evalMaxSessions: { type: 'integer', description: 'Changed Sessions evaluated per dreaming pass (1-30).' },
        evalMaxItems: { type: 'integer', description: 'Open items re-graded per dreaming pass (0-40).' },
        fields: {
          type: 'array',
          items: { type: 'string', enum: MANUAL_FIELDS },
          description: 'Fields for item_unlock; omit to restore all auto-graded fields.',
        },
        learningNotes: { type: 'string', description: 'What the plugin should remember about how the user prioritizes work.' },
        importanceBias: { type: 'number', description: 'Importance calibration bias (-2..2).' },
        progressBias: { type: 'integer', description: 'Progress calibration bias (-20..20).' },
        attentionBias: { type: 'integer', description: 'Attention calibration bias (-20..20).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          value: {},
        },
      },
      render(_args, value) {
        const record = value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}
        const text = record.summary
          ? `${record.summary}\n\n${JSON.stringify(record.value ?? null, null, 2)}`
          : JSON.stringify(value ?? null, null, 2)
        return [{ type: 'text', text: text.slice(0, 20_000) }]
      },
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? /** @type {Record<string, any>} */ (args) : {}
      const action = typeof input.action === 'string' ? input.action : ''
      try {
        const result = await toolDispatch(store, engine, action, input, exec?.signal)
        const summary = result.ok === false
          ? result.error.message
          : summarizeToolResult(action, result.value)
        return { ok: result.ok, summary, value: toLosslessJson(result.ok ? result.value : result.error) }
      } catch (error) {
        const failure = errorResponse(error)
        return { ok: false, summary: failure.error.message, value: toLosslessJson(failure.error) }
      }
    },
  }
}

/**
 * Map the flat tool arguments onto the shared action dispatcher.
 * @param {ReminderStore} store @param {DreamEngine} engine
 * @param {string} action @param {Record<string, any>} input @param {AbortSignal|undefined} signal
 */
async function toolDispatch(store, engine, action, input, signal) {
  switch (action) {
    case 'list': {
      await store.ready
      const snapshot = store.snapshot()
      const groupName = typeof input.group === 'string' ? groupKey(input.group) : ''
      const groups = snapshot.groups
      const items = snapshot.items
        .filter((item) => (!groupName || groupKey(groups.find((group) => group.id === item.groupId)?.name ?? '') === groupName))
        .map((item) => ({
          id: item.id,
          title: item.title,
          subtitle: item.subtitle,
          group: groups.find((group) => group.id === item.groupId)?.name ?? DEFAULT_GROUP_NAME,
          status: item.status,
          statusNote: item.statusNote,
          progress: item.progress,
          importance: item.importance,
          attentionScore: item.attentionScore,
          attentionReason: item.attentionReason,
          freshness: item.freshness,
          pinned: item.pinned,
          nextStep: item.nextStep,
          sessionIds: item.sessionIds,
          lastTouched: item.lastTouched,
          manualFields: item.manualFields,
        }))
      return { ok: true, value: { groups, items, dream: snapshot.dream, count: items.length } }
    }
    case 'get': {
      await store.ready
      const item = store.state.items.find((entry) => entry.id === input.id)
      if (!item) throw new ReminderError('not_found', 'That reminder no longer exists.')
      return { ok: true, value: store.itemView(item) }
    }
    case 'create': {
      return dispatchAction(store, engine, 'item.create', {
        title: input.title,
        subtitle: input.subtitle,
        notes: input.notes,
        nextStep: input.nextStep,
        group: input.group,
        groupId: input.groupId,
        status: input.status,
        progress: input.progress,
        importance: input.importance,
        pinned: input.pinned,
      })
    }
    case 'update': {
      const patch = { ...(input.patch && typeof input.patch === 'object' ? input.patch : {}) }
      for (const key of ['title', 'subtitle', 'notes', 'nextStep', 'groupId', 'status', 'progress', 'importance', 'pinned']) {
        if (Object.prototype.hasOwnProperty.call(input, key)) patch[key] = input[key]
      }
      return dispatchAction(store, engine, 'item.update', { id: input.id, patch })
    }
    case 'delete':
      return dispatchAction(store, engine, 'item.delete', { id: input.id })
    case 'group_create':
      return dispatchAction(store, engine, 'group.create', { name: input.group ?? input.title })
    case 'group_delete':
      return dispatchAction(store, engine, 'group.delete', { id: input.id })
    case 'dream_run':
      await store.ready
      if (engine.running) return { ok: true, value: { started: false, busy: true } }
      return dispatchAction(store, engine, 'dream.run', {}, { awaitDream: true, signal })
    case 'dream_status': {
      await store.ready
      return { ok: true, value: store.snapshot().dream }
    }
    case 'undo_dream':
      return dispatchAction(store, engine, 'dream.undo', { activityId: input.activityId })
    case 'item_unlock':
      return dispatchAction(store, engine, 'item.unlock', { id: input.id, fields: input.fields })
    case 'update_settings':
      return dispatchAction(store, engine, 'settings.update', {
        dreamEnabled: input.dreamEnabled,
        dreamIntervalMinutes: input.dreamIntervalMinutes,
        windowHours: input.windowHours,
        evalMode: input.evalMode,
        evalProvider: input.evalProvider,
        evalModel: input.evalModel,
        evalMaxSessions: input.evalMaxSessions,
        evalMaxItems: input.evalMaxItems,
      })
    case 'learning_status': {
      await store.ready
      return { ok: true, value: store.learningView() }
    }
    case 'learning_update':
      return dispatchAction(store, engine, 'learning.update', {
        notes: input.learningNotes,
        importanceBias: input.importanceBias,
        progressBias: input.progressBias,
        attentionBias: input.attentionBias,
      })
    case 'learning_reset':
      return dispatchAction(store, engine, 'learning.reset', {})
    case 'models_list':
      return dispatchAction(store, engine, 'models.list', {})
    default:
      throw new ReminderError('invalid', `Unknown action "${action}".`)
  }
}

/** @param {string} action @param {any} value */
function summarizeToolResult(action, value) {
  switch (action) {
    case 'list': {
      const items = Array.isArray(value?.items) ? value.items : []
      const groups = Array.isArray(value?.groups) ? value.groups : []
      return `Reminder list: ${items.length} item${items.length === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'}.`
    }
    case 'create':
      return `Created reminder "${value?.title ?? ''}".`
    case 'update':
      return `Updated reminder "${value?.title ?? ''}".`
    case 'delete':
      return 'Deleted the reminder.'
    case 'group_create':
    case 'group_rename':
      return `Group "${value?.name ?? ''}" is ready.`
    case 'group_delete':
      return 'Deleted the group; its items moved to the default group.'
    case 'dream_run': {
      if (value?.busy) return 'A dreaming pass is already running.'
      return `Dreaming finished: ${value?.summary ?? 'no summary'}.`
    }
    case 'dream_status':
      return 'Current dreaming status.'
    case 'undo_dream':
      return 'Undid the dreaming run.'
    case 'update_settings':
      return 'Updated dreaming settings.'
    case 'item_unlock':
      return 'Restored automatic grading for the reminder.'
    case 'learning_status':
      return 'Learned preferences for the dreaming evaluator.'
    case 'learning_update':
      return 'Updated learned preferences.'
    case 'learning_reset':
      return 'Reset learned preferences.'
    case 'models_list':
      return 'Available evaluation models.'
    default:
      return 'Done.'
  }
}

// ---------------------------------------------------------------------------
// HTTP route handlers (pure over store + engine, so they are unit-testable)
// ---------------------------------------------------------------------------

/**
 * Answer `GET|HEAD /api/dsh-reminders/state`.
 * @param {ReminderStore} store @param {Request} request
 */
async function serveStateRequest(store, request) {
  try {
    await store.ready
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: noStoreHeaders() })
    return jsonResponse(store.snapshot())
  } catch (error) {
    return jsonResponse(errorResponse(error), 500)
  }
}

/**
 * Answer `POST /api/dsh-reminders/action`.
 * @param {ReminderStore} store @param {DreamEngine} engine @param {Request} request
 */
async function serveActionRequest(store, engine, request) {
  try {
    await store.ready
    let body
    try {
      body = await request.json()
    } catch {
      throw new ReminderError('invalid', 'Request body must be JSON.')
    }
    const action = body && typeof body.action === 'string' ? body.action : ''
    const result = await dispatchAction(store, engine, action, body?.payload ?? {})
    return jsonResponse(result)
  } catch (error) {
    return jsonResponse(errorResponse(error))
  }
}

// ---------------------------------------------------------------------------
// Config and plugin entry
// ---------------------------------------------------------------------------

/**
 * Resolve bundle-row config into runtime defaults.
 * @param {Record<string, any>} config
 */
function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    dreamEnabled: boolOr(raw.dreamEnabled, true),
    dreamIntervalMinutes: numberOr(raw.dreamIntervalMinutes, 10, 1, 1440),
    windowHours: numberOr(raw.windowHours, 72, 1, 720),
    staleHours: numberOr(raw.staleHours, 24, 1, 720),
    forgetHours: numberOr(raw.forgetHours, 72, 1, 2160),
    maxSessions: numberOr(raw.maxSessions, 12, 1, 50),
    evalMode: raw.evalMode === 'heuristic' ? 'heuristic' : EVAL_DEFAULTS.evalMode,
    evalProvider: cleanLine(raw.evalProvider, 120),
    evalModel: cleanLine(raw.evalModel, 120),
    evalMaxSessions: numberOr(raw.evalMaxSessions, EVAL_DEFAULTS.evalMaxSessions, 1, 30),
    evalMaxItems: numberOr(raw.evalMaxItems, EVAL_DEFAULTS.evalMaxItems, 0, 40),
    dataDir: typeof raw.dataDir === 'string' && raw.dataDir.trim().length > 0
      ? raw.dataDir.trim()
      : (typeof process.env.DSH_REMINDERS_DIR === 'string' && process.env.DSH_REMINDERS_DIR.trim().length > 0
        ? process.env.DSH_REMINDERS_DIR.trim()
        : join(typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh'), 'reminders')),
  }
}

/**
 * Host plugin entry.
 * @param {object} ctx
 * @param {Record<string, any>} config
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const store = new ReminderStore(resolved.dataDir, resolved)
  const engine = new DreamEngine(store, ctx)
  store.ready.catch((error) => {
    ctx.logger?.warn?.(`reminders: state load failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  const log = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // logging must never break the plugin
    }
  }

  // The agent tool keeps the reminder list editable from a conversation too.
  ctx.effect(() => ctx.tools.register(createRemindersTool(store, engine)), 'reminders: agent tool')

  // Authenticated browser routes: GET state, POST action.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => {
      const disposeState = scope.connection.fetch.register({
        path: ROUTE_STATE,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => serveStateRequest(store, request),
      })
      const disposeAction = scope.connection.fetch.register({
        path: ROUTE_ACTION,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => serveActionRequest(store, engine, request),
      })
      return () => {
        try {
          disposeState()
        } catch {
          // already disposed
        }
        try {
          disposeAction()
        } catch {
          // already disposed
        }
      }
    }, 'reminders: api routes')
  })

  // Dreaming schedule: one lightweight tick; the interval itself is configurable
  // at runtime, so the tick compares against the persisted last-run timestamp.
  ctx.effect(() => {
    let disposed = false
    const tick = async () => {
      if (disposed) return
      try {
        await store.ready
        if (disposed) return
        const settings = store.state.settings
        if (!settings.dreamEnabled || engine.running) return
        const last = store.state.lastDreamAt || 0
        const due = last === 0 ? 12_000 : last + settings.dreamIntervalMinutes * 60_000
        if (nowMs() < due) return
        await engine.run({ trigger: 'auto' })
      } catch (error) {
        log(`reminders: dreaming tick failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const timer = setInterval(() => {
      void tick()
    }, 15_000)
    const warmup = setTimeout(() => {
      void tick()
    }, 10_000)
    return () => {
      disposed = true
      clearInterval(timer)
      clearTimeout(warmup)
    }
  }, 'reminders: dreaming timer')
}

/** @param {unknown} value @param {number} status */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...noStoreHeaders(),
    },
  })
}

function noStoreHeaders() {
  return { 'cache-control': 'no-store' }
}

export {
  ReminderStore,
  DreamEngine,
  SessionScanner,
  DreamEvaluator,
  dispatchAction,
  analyzeEvents,
  deriveFreshness,
  jaccard,
  tokenize,
  groupKey,
  heuristicAttention,
  serveStateRequest,
  serveActionRequest,
  toLosslessJson,
}
