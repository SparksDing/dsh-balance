/**
 * Spend accounting for the status panel: fold every provider-reported
 * `assistant/message` usage record into a per-day, per-model cost estimate
 * priced with the DeepSeek rate card (including its peak/off-peak rule).
 *
 * Only usage observed while this Host process is running is counted; the
 * numbers reset on restart. Everything here is pure and injectable so the
 * smoke test can drive it with synthetic events and a fixed clock.
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
 * @returns uncached input, cache-read input, output tokens.
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
function dayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** One empty accumulator. */
function emptyTotals() {
  return { usd: 0, calls: 0, cacheRead: 0, cacheWrite: 0, miss: 0, output: 0 }
}

/**
 * Build a tracker that buckets usage by local day and by model.
 * @param options - `prices`, `usdToCny`, and a `now` override for tests.
 * @returns `{ record, snapshot }`.
 */
export function createUsageTracker(options = {}) {
  const prices = options.prices ?? DEFAULT_PRICES
  const usdToCny = Number(options.usdToCny) > 0 ? Number(options.usdToCny) : 7.1
  const now = options.now ?? (() => new Date())
  const since = now().getTime()
  let day = dayKey(now())
  let totals = emptyTotals()
  const byModel = new Map()
  const sessions = new Set()

  const rollover = () => {
    const current = dayKey(now())
    if (current === day) return
    day = current
    totals = emptyTotals()
    byModel.clear()
    sessions.clear()
  }

  /**
   * Record one provider-reported attempt.
   * @param entry - `model`, `usage`, `sessionId`, and the event time.
   */
  const record = (entry) => {
    rollover()
    const at = new Date(entry.time ?? now().getTime())
    const priced = costOf(entry.usage, priceFor(entry.model, prices), isPeak(at))
    if (priced.miss + priced.cacheRead + priced.cacheWrite + priced.output === 0) return
    const model = entry.model === undefined || entry.model === '' ? 'unknown' : entry.model
    const row = byModel.get(model) ?? { model, ...emptyTotals() }
    for (const target of [totals, row]) {
      target.usd += priced.usd
      target.calls += 1
      target.cacheRead += priced.cacheRead
      target.cacheWrite += priced.cacheWrite
      target.miss += priced.miss
      target.output += priced.output
    }
    byModel.set(model, row)
    if (entry.sessionId !== undefined) sessions.add(entry.sessionId)
  }

  /** Current snapshot for the panel and the route. */
  const snapshot = () => {
    rollover()
    const tokens = totals.cacheRead + totals.miss + totals.cacheWrite
    return {
      ok: true,
      day,
      since,
      usdToCny,
      peak: isPeak(now()),
      totals: {
        usd: Math.round(totals.usd * 10000) / 10000,
        cny: Math.round(totals.usd * usdToCny * 100) / 100,
        calls: totals.calls,
        sessions: sessions.size,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        miss: totals.miss,
        output: totals.output,
        cacheHitPct: tokens === 0 ? null : Math.round((100 * totals.cacheRead) / tokens),
        cacheReadText: formatBytes(totals.cacheRead),
        missText: formatBytes(totals.miss),
        outputText: formatBytes(totals.output),
      },
      byModel: [...byModel.values()].map(row => ({
        model: row.model,
        calls: row.calls,
        usd: Math.round(row.usd * 10000) / 10000,
        cny: Math.round(row.usd * usdToCny * 100) / 100,
        cacheReadText: formatBytes(row.cacheRead),
        missText: formatBytes(row.miss),
        outputText: formatBytes(row.output),
      })).sort((left, right) => right.usd - left.usd),
    }
  }

  return { record, snapshot }
}

/**
 * Register the usage route and subscribe to session events.
 * @param ctx - Cordis context carrying `connection` and the plugin fiber.
 * @param options - `path`, `prices`, `usdToCny`, and optional `now`/`tracker`.
 * @returns the route path, for the ping's route list.
 */
export function registerUsage(ctx, options = {}) {
  const tracker = options.tracker ?? createUsageTracker(options)
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
      model: models.get(session.id),
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
