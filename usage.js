/**
 * Spend accounting for the status panel: fold every provider-reported
 * `assistant/message` usage record into per-day, per-model cost estimates
 * priced with the DeepSeek rate card (including its peak/off-peak rule).
 *
 * The tracker itself is pure; `spend-store.js` owns durability, so a restart
 * resumes today's figure and the recent-day history. Everything is injectable
 * for the smoke test.
 *
 * @module @local/dsh-balance/usage
 */

import { json } from './http.js'
import { formatBytes } from './sysmon.js'

/** DeepSeek off-peak USD per 1M tokens; peak hours bill every bucket at double. */
const DEFAULT_PRICES = {
  flash: { cacheHit: 0.003, miss: 0.15, output: 0.6 },
  pro: { cacheHit: 0.022, miss: 0.66, output: 1.98 },
}

/** Days kept in the snapshot's recent list. */
const RECENT_DAYS = 7

/**
 * Whether an instant falls in DeepSeek's peak window (01:00-04:00 and
 * 06:00-10:00 UTC, Monday through Friday). Chinese public holidays are not
 * modeled, so a holiday counts as peak.
 * @param date - instant to classify.
 * @returns true for peak billing.
 */
export function isPeak(date) {
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/**
 * Pick the rate card for one model id.
 * @param model - provider model id, possibly empty.
 * @param prices - rate cards, defaulting to the shipped table.
 * @returns the matching rate card.
 */
export function priceFor(model, prices = DEFAULT_PRICES) {
  return /pro/i.test(model ?? '') ? prices.pro : prices.flash
}

/**
 * Split one usage record into priced token buckets.
 * @param usage - provider usage; `inputTokens` includes cache reads and writes.
 * @returns cache reads, cache writes, uncached input, and output tokens.
 */
export function bucketsOf(usage) {
  const input = Number(usage?.inputTokens) || 0
  const cacheRead = Number(usage?.cacheReadTokens) || 0
  const cacheWrite = Number(usage?.cacheWriteTokens) || 0
  return {
    cacheRead,
    cacheWrite,
    miss: Math.max(0, input - cacheRead - cacheWrite),
    output: Number(usage?.outputTokens) || 0,
  }
}

/**
 * Price one usage record.
 * @param usage - provider usage for one attempt.
 * @param price - the model's off-peak rate card.
 * @param peak - whether this attempt billed at peak rates.
 * @returns USD cost and its token buckets.
 */
export function costOf(usage, price, peak) {
  const buckets = bucketsOf(usage)
  const factor = peak ? 2 : 1
  const usd = (
    buckets.miss * price.miss
    + buckets.cacheWrite * price.miss
    + buckets.cacheRead * price.cacheHit
    + buckets.output * price.output
  ) / 1_000_000 * factor
  return { ...buckets, usd }
}

/** Calendar day key in the machine's local time. */
export function dayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** One empty per-model row. */
function emptyRow() {
  return { usd: 0, calls: 0, cacheRead: 0, cacheWrite: 0, miss: 0, output: 0 }
}

/** One empty day bucket. */
function emptyDay() {
  return { ...emptyRow(), byModel: new Map() }
}

/** The numeric fields one bucket and its model rows share. */
const FIELDS = ['usd', 'calls', 'cacheRead', 'cacheWrite', 'miss', 'output']

/**
 * Build a tracker that buckets usage by local day and by model.
 * @param options - `prices`, `usdToCny`, `historyDays`, and a `now` override.
 * @returns `{ record, snapshot, hydrate, exportState, subscribe }`.
 */
export function createUsageTracker(options = {}) {
  const prices = options.prices ?? DEFAULT_PRICES
  const usdToCny = Number(options.usdToCny) > 0 ? Number(options.usdToCny) : 7.1
  const historyDays = Number(options.historyDays) > 0 ? Math.min(60, Number(options.historyDays)) : 30
  const now = options.now ?? (() => new Date())
  const startedAt = now().getTime()
  const days = new Map()
  const listeners = new Set()
  const sessions = new Set()

  /** Keep only the newest `historyDays` buckets. */
  const prune = () => {
    if (days.size <= historyDays) return
    for (const day of [...days.keys()].sort().slice(0, days.size - historyDays)) days.delete(day)
  }

  const bucketOf = (day) => {
    let bucket = days.get(day)
    if (bucket === undefined) {
      bucket = emptyDay()
      days.set(day, bucket)
    }
    return bucket
  }

  /**
   * Add one priced attempt into a day bucket and its model row.
   * @param bucket - target day bucket.
   * @param model - model id.
   * @param priced - cost and token buckets.
   */
  const addTo = (bucket, model, priced) => {
    const fields = {
      usd: priced.usd,
      calls: 1,
      cacheRead: priced.cacheRead,
      cacheWrite: priced.cacheWrite,
      miss: priced.miss,
      output: priced.output,
    }
    for (const key of FIELDS) bucket[key] += fields[key]
    const row = bucket.byModel.get(model) ?? { model, ...emptyRow() }
    for (const key of FIELDS) row[key] += fields[key]
    bucket.byModel.set(model, row)
  }

  /**
   * Record one provider-reported attempt.
   * @param entry - `model`, `usage`, `sessionId`, and the event time.
   */
  const record = (entry) => {
    const at = new Date(entry.time ?? now().getTime())
    const priced = costOf(entry.usage, priceFor(entry.model, prices), isPeak(at))
    if (priced.miss + priced.cacheRead + priced.cacheWrite + priced.output === 0) return
    const model = entry.model === undefined || entry.model === '' ? 'unknown' : entry.model
    addTo(bucketOf(dayKey(at)), model, priced)
    if (entry.sessionId !== undefined) sessions.add(entry.sessionId)
    prune()
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-balance] usage listener crashed:', error)
      }
    }
  }

  /**
   * Merge a persisted state back in, additively, so records taken before the
   * file finished loading are not lost.
   * @param state - `exportState()` output, or undefined for no history.
   */
  const hydrate = (state) => {
    if (state === null || typeof state !== 'object' || !Array.isArray(state.days)) return
    for (const entry of state.days) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [day, raw] = entry
      if (typeof day !== 'string' || raw === null || typeof raw !== 'object') continue
      const bucket = bucketOf(day)
      for (const key of FIELDS) {
        const value = Number(raw[key])
        if (Number.isFinite(value) && value > 0) bucket[key] += value
      }
      for (const pair of Array.isArray(raw.byModel) ? raw.byModel : []) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        const [model, row] = pair
        if (typeof model !== 'string' || row === null || typeof row !== 'object') continue
        const target = bucket.byModel.get(model) ?? { model, ...emptyRow() }
        for (const key of FIELDS) {
          const value = Number(row[key])
          if (Number.isFinite(value) && value > 0) target[key] += value
        }
        bucket.byModel.set(model, target)
      }
    }
    prune()
  }

  /** Serializable state for `spend-store.js`; newest day first. */
  const exportState = () => {
    prune()
    return {
      version: 1,
      days: [...days.entries()]
        .sort(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0))
        .map(([day, bucket]) => [day, {
          usd: bucket.usd,
          calls: bucket.calls,
          cacheRead: bucket.cacheRead,
          cacheWrite: bucket.cacheWrite,
          miss: bucket.miss,
          output: bucket.output,
          byModel: [...bucket.byModel.values()].map(row => [row.model, {
            usd: row.usd,
            calls: row.calls,
            cacheRead: row.cacheRead,
            cacheWrite: row.cacheWrite,
            miss: row.miss,
            output: row.output,
          }]),
        }]),
    }
  }

  /** Current snapshot for the panel and the route. */
  const snapshot = () => {
    const today = dayKey(now())
    const bucket = days.get(today) ?? emptyDay()
    const tokens = bucket.cacheRead + bucket.miss + bucket.cacheWrite
    const recent = [...days.entries()]
      .sort(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0))
      .slice(0, RECENT_DAYS)
      .map(([day, entry]) => ({
        day,
        usd: Math.round(entry.usd * 10000) / 10000,
        cny: Math.round(entry.usd * usdToCny * 100) / 100,
        calls: entry.calls,
      }))
    return {
      ok: true,
      day: today,
      startedAt,
      usdToCny,
      peak: isPeak(now()),
      totals: {
        usd: Math.round(bucket.usd * 10000) / 10000,
        cny: Math.round(bucket.usd * usdToCny * 100) / 100,
        calls: bucket.calls,
        sessions: sessions.size,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        miss: bucket.miss,
        output: bucket.output,
        cacheHitPct: tokens === 0 ? null : Math.round((100 * bucket.cacheRead) / tokens),
        cacheReadText: formatBytes(bucket.cacheRead),
        missText: formatBytes(bucket.miss),
        outputText: formatBytes(bucket.output),
      },
      byModel: [...bucket.byModel.values()].map(row => ({
        model: row.model,
        calls: row.calls,
        usd: Math.round(row.usd * 10000) / 10000,
        cny: Math.round(row.usd * usdToCny * 100) / 100,
        cacheReadText: formatBytes(row.cacheRead),
        missText: formatBytes(row.miss),
        outputText: formatBytes(row.output),
      })).sort((left, right) => right.usd - left.usd),
      recent,
      recentCny: Math.round(recent.reduce((sum, entry) => sum + entry.usd, 0) * usdToCny * 100) / 100,
    }
  }

  return {
    record,
    snapshot,
    hydrate,
    exportState,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Register the usage route and subscribe to session events.
 * @param ctx - Cordis context carrying `connection` and the plugin fiber.
 * @param options - `path`, `tracker`, `defaultModel`, and optional `now`.
 * @returns the route path, for the ping's route list.
 */
export function registerUsage(ctx, options = {}) {
  const tracker = options.tracker ?? createUsageTracker(options)
  // A session whose route metadata predates this plugin has no observed model;
  // label it with the deployment default, which is the card it is priced with.
  const defaultModel = options.defaultModel ?? 'deepseek-flash'
  /** Latest model per session, learned from route metadata events. */
  const models = new Map()

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type === 'request/context') {
      models.set(session.id, event.data.model)
      return
    }
    if (event.type === 'request/header') {
      const model = event.data.header?.config?.model
      if (typeof model === 'string' && model !== '') models.set(session.id, model)
      return
    }
    if (event.type !== 'assistant/message' || event.data.usage === undefined) return
    tracker.record({
      model: models.get(session.id) ?? defaultModel,
      usage: event.data.usage,
      sessionId: session.id,
      time: event.time,
    })
  }), 'dsh-balance: usage accounting')

  ctx.effect(() => ctx.connection.fetch.register({
    path: options.path,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(200, tracker.snapshot()),
  }), 'dsh-balance: usage route')

  return options.path
}
