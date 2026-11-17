/**
 * LLM evaluation + deterministic fallbacks for the dreaming engine.
 *
 * The evaluator turns changed Sessions and open reminder items into one batched
 * model request that returns strict JSON (progress, importance, attention,
 * status, subtitle, group). Every failure degrades to the deterministic
 * heuristics in this module, so dreaming never breaks and never blocks when no
 * model route is available.
 *
 * Kept dependency-free (Node builtins only) so the bundle stays self-contained.
 *
 * @module dsh-reminders-plugin/evaluate
 */

/** Statuses an evaluator may return (`done` is never auto-assigned). */
const EVAL_STATUSES = ['todo', 'doing', 'awaiting', 'blocked']
/** Runtime statuses (index.js owns the authoritative list). */
const ALL_STATUSES = ['todo', 'doing', 'awaiting', 'blocked', 'done']

const EVAL_TIMEOUT_MS = 60_000
const EVAL_MAX_TOKENS = 2600
const EVAL_INPUT_TEXT = 700

/**
 * Trim a value to a single line of text.
 * @param {unknown} value @param {number} max
 */
function line(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n').map((part) => part.trim()).find((part) => part.length > 0)?.slice(0, max) ?? ''
}

/**
 * Trim a value to bounded free text.
 * @param {unknown} value @param {number} max
 */
function text(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/\u0000/g, '').slice(0, max).trim()
}

/**
 * Clamp a numeric value.
 * @param {unknown} value @param {number} lo @param {number} hi
 */
function clamp(value, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(hi, Math.max(lo, Math.round(n * 10) / 10))
}

/**
 * Clamp an integer value.
 * @param {unknown} value @param {number} lo @param {number} hi
 */
function intOr(value, lo, hi) {
  const n = clamp(value, lo, hi)
  return n === null ? null : Math.round(n)
}

/** @param {string} textValue */
function stripFences(textValue) {
  const trimmed = textValue.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim()
}

/**
 * Extract the first JSON object from model output.
 * @param {string} textValue
 * @returns {Record<string, any>|null}
 */
function extractObject(textValue) {
  const source = stripFences(textValue)
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  for (const candidate of [source.slice(start, end + 1)]) {
    try {
      const parsed = JSON.parse(candidate)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      continue
    }
  }
  return null
}

/**
 * Coerce the `sessions` section of an evaluation reply.
 * @param {unknown} section @param {Set<string>} allowed
 */
export function coerceSessionEvaluations(section, allowed) {
  const output = new Map()
  if (!section || typeof section !== 'object') return output
  for (const [id, raw] of Object.entries(section)) {
    if (!allowed.has(id) || !raw || typeof raw !== 'object') continue
    const value = /** @type {Record<string, any>} */ (raw)
    const entry = {}
    const subtitle = line(value.subtitle, 220)
    if (subtitle) entry.subtitle = subtitle
    const progress = intOr(value.progress, 0, 100)
    if (progress !== null) entry.progress = progress
    const importance = intOr(value.importance, 1, 5)
    if (importance !== null) entry.importance = importance
    if (typeof value.status === 'string' && ALL_STATUSES.includes(value.status)) {
      entry.status = value.status === 'done' ? 'doing' : value.status
    }
    const attention = intOr(value.attention, 0, 100)
    if (attention !== null) entry.attention = attention
    const attentionReason = line(value.attentionReason, 200)
    if (attentionReason) entry.attentionReason = attentionReason
    const group = line(value.group, 60)
    if (group) entry.group = group
    if (Object.keys(entry).length > 0) output.set(id, entry)
  }
  return output
}

/**
 * Coerce the `items` section of an evaluation reply.
 * @param {unknown} section @param {Set<string>} allowed
 */
export function coerceItemEvaluations(section, allowed) {
  const output = new Map()
  if (!section || typeof section !== 'object') return output
  for (const [id, raw] of Object.entries(section)) {
    if (!allowed.has(id) || !raw || typeof raw !== 'object') continue
    const value = /** @type {Record<string, any>} */ (raw)
    const entry = {}
    const importance = intOr(value.importance, 1, 5)
    if (importance !== null) entry.importance = importance
    const progress = intOr(value.progress, 0, 100)
    if (progress !== null) entry.progress = progress
    const attention = intOr(value.attention, 0, 100)
    if (attention !== null) entry.attention = attention
    const attentionReason = line(value.attentionReason, 200)
    if (attentionReason) entry.attentionReason = attentionReason
    if (typeof value.status === 'string' && EVAL_STATUSES.includes(value.status)) entry.status = value.status
    if (Object.keys(entry).length > 0) output.set(id, entry)
  }
  return output
}

/**
 * Deterministic subtitle fallback for a Session summary.
 * @param {object} summary
 */
export function heuristicSubtitle(summary) {
  if (summary.pendingIssue === 'permission') return 'Waiting for your permission.'
  if (summary.pendingIssue === 'question') return 'Waiting for your answer.'
  if (summary.state === 'blocked') return line(summary.lastError, 180) || 'Blocked on an error.'
  const candidate = line(summary.lastAssistantText, 180) || line(summary.lastUserText, 180)
  return candidate || line(summary.title, 180) || 'In progress.'
}

/**
 * Deterministic status fallback for a Session summary.
 * @param {object} summary
 */
export function heuristicStatus(summary) {
  if (summary.pendingIssue) return 'awaiting'
  if (summary.state === 'blocked') return 'blocked'
  return 'doing'
}

/**
 * Deterministic attention fallback, combining lifecycle state, importance,
 * pins and idle time. The LLM path refines this with context and learning.
 * @param {{item:object, now:number, learning:object, groupAttentionBias?:number}} input
 * @returns {{score:number, reason:string}}
 */
export function heuristicAttention(input) {
  const item = input.item
  const now = input.now
  const learning = input.learning ?? {}
  const status = item.status
  let score = status === 'awaiting' ? 86
    : status === 'blocked' ? 70
      : status === 'doing' ? 48
        : status === 'todo' ? 38
          : 0
  score += (Number(item.importance) || 3) * 6
  if (item.pinned) score += 8
  const hoursIdle = Math.max(0, (now - (Number(item.lastTouched) || now)) / 3_600_000)
  if (status !== 'done') {
    score += Math.min(24, hoursIdle / 8)
    if (hoursIdle <= 2) score -= 12
  }
  score += Number(learning.attentionBias ?? 0)
  score += Number(input.groupAttentionBias ?? 0)
  const clamped = Math.max(0, Math.min(100, Math.round(score)))
  let reason = ''
  if (item.status === 'awaiting') reason = item.statusNote || 'Waiting for you.'
  else if (item.status === 'blocked') reason = line(item.statusNote, 180) || 'Blocked and needs attention.'
  else if (hoursIdle >= 48) reason = `No activity for ${Math.round(hoursIdle / 24)} days.`
  else if (item.status === 'doing') reason = 'In progress; check whether it needs the next step.'
  else reason = 'Not started yet.'
  return { score: clamped, reason }
}

/**
 * Build the compact learned-context block inserted into the evaluator payload.
 * @param {object} learning
 */
function learningContext(learning) {
  return {
    notes: text(learning.notes, 1600),
    importanceBias: Number(learning.importanceBias ?? 0),
    progressBias: Number(learning.progressBias ?? 0),
    attentionBias: Number(learning.attentionBias ?? 0),
    learnedGroups: (Array.isArray(learning.groups) ? learning.groups : []).slice(0, 8).map((group) => ({
      name: line(group.name, 60),
      samples: Number(group.samples) || 0,
      importanceBias: Number(group.importanceBias ?? 0),
      attentionBias: Number(group.attentionBias ?? 0),
    })),
    recentSignals: (Array.isArray(learning.signals) ? learning.signals : []).slice(0, 10).map((signal) => ({
      kind: line(signal.kind, 30),
      field: line(signal.field, 30),
      title: line(signal.title, 120),
      from: signal.from ?? null,
      to: signal.to ?? null,
    })),
    stats: learning.stats ?? {},
  }
}

/**
 * Build the evaluator system prompt.
 * @param {object} learning
 */
function systemPrompt(learning) {
  const notes = text(learning?.notes, 1600)
  return [
    "You are the dreaming evaluator for a developer's reminder list. You read recently used AI coding Sessions and the current reminder items, then grade the work and decide what deserves the user's attention.",
    'Return STRICT JSON only, no markdown fences and no commentary, exactly in this shape:',
    '{"sessions":{"<session id>":{"subtitle":"...","progress":0-100,"importance":1-5,"status":"todo|doing|awaiting|blocked","attention":0-100,"attentionReason":"...","group":"..."}},',
    '"items":{"<item id>":{"importance":1-5,"progress":0-100,"attention":0-100,"attentionReason":"..."}}}',
    'Grading rules:',
    '- subtitle: one short sentence (max 160 chars) naming what the session accomplished and where it stands. Do not repeat the title.',
    '- progress: estimated completion of that piece of work, 0-100. Be conservative; do not invent completion.',
    '- importance: 1 (low) to 5 (critical), based on the user priorities encoded below and on the work itself.',
    '- attention: 0-100 for "should the user act on this now". Raise it for sessions waiting on the user (questions/permissions), blocked or errored work, stalled important work; lower it for work just being actively progressed.',
    '- status: "awaiting" ONLY when the session is explicitly waiting for the user to answer a question or grant permission; "blocked" for errors; otherwise todo/doing. Never output "done".',
    '- group: only when the project grouping is clearly wrong; otherwise omit.',
    '- Omit ids you cannot judge. Never invent ids.',
    notes ? `What the plugin has learned about this user (follow it):\n${notes}` : '',
  ].filter(Boolean).join('\n')
}

/** Default evaluator implementation over `ctx.llm`. */
export class DreamEvaluator {
  /**
   * @param {object} ctx Cordis Host context.
   * @param {object} store ReminderStore (for state/activity context).
   */
  constructor(ctx, store) {
    this.ctx = ctx
    this.store = store
  }

  /** @returns {object|undefined} */
  llm() {
    return this.ctx.get('llm')
  }

  /** @returns {{provider:string, model:string}|undefined} */
  defaultRoute() {
    try {
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // A missing/invalid default model is a normal heuristic-mode situation.
    }
    return undefined
  }

  /**
   * Resolve the evaluation route under one settings object.
   * @param {object} settings
   */
  resolveRoute(settings) {
    const provider = text(settings?.evalProvider, 120)
    const model = text(settings?.evalModel, 120)
    if (provider && model) return { provider, model, followsDefault: false }
    const fallback = this.defaultRoute()
    return fallback ? { ...fallback, followsDefault: true } : null
  }

  /**
   * Model availability / route summary for the Client.
   * @param {object} settings
   */
  evaluationView(settings) {
    const llm = this.llm()
    const route = this.resolveRoute(settings)
    let available = false
    if (llm && route) {
      try {
        available = llm.listProviders().some((provider) => provider.id === route.provider)
      } catch {
        available = false
      }
    }
    const latest = this.store?.state?.activities?.[0]
    return {
      mode: settings?.evalMode === 'heuristic' ? 'heuristic' : 'model',
      enabled: (settings?.evalMode !== 'heuristic') && available,
      provider: route?.provider ?? '',
      model: route?.model ?? '',
      followsDefault: route?.followsDefault ?? false,
      available,
      lastModel: typeof latest?.model === 'string' ? latest.model : null,
      lastDegraded: latest?.degraded === true,
    }
  }

  /**
   * Providers and models for the Configure page selectors.
   * @returns {Promise<{providers: Array<{id:string,name:string,models:Array<{id:string,name:string}>}>}>}
   */
  async listCatalog() {
    const llm = this.llm()
    if (!llm) throw new Error('The Host has no LLM service.')
    const providers = llm.listProviders()
    const output = []
    for (const provider of providers) {
      let models = []
      try {
        models = await llm.listModels(provider.id)
      } catch {
        models = []
      }
      output.push({
        id: provider.id,
        name: provider.name || provider.id,
        models: (Array.isArray(models) ? models : []).map((model) => ({ id: String(model.id), name: String(model.name || model.id) })),
      })
    }
    return { providers: output }
  }

  /**
   * One batched evaluation call.
   * @param {{
   *   sessions: Array<object>,
   *   items: Array<object>,
   *   learning: object,
   *   settings: object,
   *   signal?: AbortSignal,
   * }} input
   * @returns {Promise<{sessions: Map<string,object>, items: Map<string,object>, route: {provider:string,model:string}}>}
   */
  async evaluate(input) {
    const llm = this.llm()
    if (!llm) throw new Error('The Host has no LLM service.')
    const route = this.resolveRoute(input.settings)
    if (!route) throw new Error('No evaluation model route is available.')
    const sessionIds = new Set(input.sessions.map((session) => session.id))
    const itemIds = new Set(input.items.map((item) => item.id))
    const payload = {
      now: new Date().toISOString(),
      learned: learningContext(input.learning),
      sessions: input.sessions.map((session) => ({
        id: session.id,
        title: text(session.title, 200),
        cwd: text(session.cwd, 300),
        lastHumanRequest: text(session.lastUserText, EVAL_INPUT_TEXT),
        lastAssistantReply: text(session.lastAssistantText, EVAL_INPUT_TEXT),
        state: text(session.state, 20),
        pendingIssue: text(session.pendingIssue, 20),
        tools: Array.isArray(session.tools) ? session.tools.slice(0, 8) : [],
        hoursIdle: Math.max(0, Math.round(((Date.now() - Number(session.lastActivity)) / 3_600_000) * 10) / 10),
        turnEnds: Number(session.turnEnds) || 0,
        linkedItem: session.linkedItem ?? null,
      })),
      items: input.items.map((item) => ({
        id: item.id,
        title: text(item.title, 200),
        subtitle: text(item.subtitle, 220),
        group: text(item.groupName, 60),
        status: text(item.status, 20),
        importance: Number(item.importance) || 3,
        progress: Number(item.progress) || 0,
        hoursIdle: Math.max(0, Math.round(((Date.now() - Number(item.lastTouched)) / 3_600_000) * 10) / 10),
        freshness: text(item.freshness, 20),
        pinned: item.pinned === true,
        statusNote: text(item.statusNote, 200),
        manualFields: Array.isArray(item.manualFields) ? item.manualFields : [],
      })),
    }
    const response = await this.#complete({
      system: systemPrompt(input.learning),
      user: JSON.stringify(payload),
      route,
      signal: input.signal,
    })
    const parsed = extractObject(response)
    if (!parsed) throw new Error('The evaluation model did not return a JSON object.')
    return {
      sessions: coerceSessionEvaluations(parsed.sessions, sessionIds),
      items: coerceItemEvaluations(parsed.items, itemIds),
      route,
    }
  }

  /**
   * Run one streaming completion and assemble its text.
   * @param {{system:string, user:string, route:{provider:string,model:string}, signal?:AbortSignal}} input
   */
  async #complete(input) {
    const llm = this.llm()
    if (!llm) throw new Error('The Host has no LLM service.')
    const controller = new AbortController()
    const signal = input.signal
    const abort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), EVAL_TIMEOUT_MS)
    try {
      const call = await llm.prepareCall({
        provider: input.route.provider,
        model: input.route.model,
        maxTokens: EVAL_MAX_TOKENS,
        temperature: 0.2,
      }, controller.signal)
      const options = {
        ...call.config,
        system: input.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: input.user }] }],
        maxTokens: EVAL_MAX_TOKENS,
        temperature: 0.2,
        signal: controller.signal,
      }
      const parts = []
      for await (const chunk of call.stream(options)) {
        if (controller.signal.aborted) throw new Error('The evaluation request was cancelled.')
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
        else if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            throw new Error(chunk.reason?.failure?.message || 'The evaluation model returned an error.')
          }
        }
      }
      return parts.join('')
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abort)
    }
  }
}

export { ALL_STATUSES, EVAL_STATUSES, EVAL_TIMEOUT_MS }
