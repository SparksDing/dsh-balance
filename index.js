/**
 * Host half of `@local/dsh-balance`: reads the DeepSeek platform wallet
 * balances for the browser plugin, and serves the JSON state the UI polls.
 *
 * The balance read happens here rather than in the browser so the API key
 * never reaches the page (and because api.deepseek.com allows no CORS). Both
 * routes ride Connection's authenticated `/api` channel, so only a signed-in
 * page can read the balance or store a key; the separate unauthenticated ping
 * names the plugin only and carries no account data.
 *
 * @module @local/dsh-balance
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { json } from './http.js'
import { registerSysmon } from './sysmon.js'
import { createUsageTracker, registerUsage } from './usage.js'
import { startUsagePersistence } from './spend-store.js'

/** Stable Cordis plugin name; the Client module registers under the package name. */
export const name = '@local/dsh-balance'

/** Services this plugin reads: the authenticated API channel and the raw HTTP carrier. */
export const inject = ['connection', 'webServer']

/** Default DeepSeek platform origin. */
const DEFAULT_API_BASE = 'https://api.deepseek.com'
/** Authenticated state route, absolute below `/api`. */
const STATE_PATH = '/api/deepseek-balance/state'
/** Authenticated key write route; only a signed-in page reaches it. */
const KEY_PATH = '/api/deepseek-balance/key'
/** Authenticated system-status route (CPU, disk, load). */
const SYSMON_PATH = '/api/deepseek-balance/sysmon'
/** Authenticated spend route (token usage folded into money). */
const USAGE_PATH = '/api/deepseek-balance/usage'
/** Unauthenticated liveness probe naming this plugin and nothing else. */
const PING_PATH = '/dsh-balance/ping'
/** Plugin version reported by the ping, so a running Host's loaded build is visible. */
const VERSION = '0.7.0'
/** Key file used when neither config nor environment supplies one. */
const DEFAULT_KEY_FILE = join(homedir(), '.config', 'deepseek', 'api_key')
/** DeepSeek answers 401 for a missing, deleted, or mistyped key. */
const UNAUTHORIZED = 401
/** Shape of a DeepSeek API key: `sk-` followed by an opaque tail. */
const KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,}$/
/** Upper bound on an accepted key, so a stray paste cannot fill the disk. */
const MAX_KEY_LENGTH = 200

/**
 * Expand one leading `~/` against the home directory.
 * @param path - configured or default path.
 * @returns the absolute path.
 */
function expandHome(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/**
 * Keep only the last four characters of a key, for "which key is this" display.
 * @param key - resolved API key.
 * @returns the masked tail, or an empty string for very short keys.
 */
function maskTail(key) {
  return key.length <= 4 ? '' : key.slice(-4)
}

/**
 * Normalize one wallet row from the platform response.
 * @param value - one `balance_infos` entry.
 * @returns the wallet, or undefined when the row is unusable.
 */
function walletOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const currency = typeof value.currency === 'string' ? value.currency.toUpperCase() : undefined
  if (currency === undefined) return undefined
  const amount = text => (typeof value[text] === 'string' || typeof value[text] === 'number'
    ? String(value[text])
    : '0')
  return {
    currency,
    total: amount('total_balance'),
    toppedUp: amount('topped_up_balance'),
    granted: amount('granted_balance'),
  }
}

/**
 * Query the platform balance endpoint once.
 * @param apiBase - platform origin without a trailing slash.
 * @param key - API key sent as a bearer credential.
 * @param timeoutMs - per-request deadline.
 * @returns the parsed outcome; failures carry a code the UI can explain.
 */
async function queryBalance(apiBase, key, timeoutMs) {
  let response
  try {
    response = await fetch(`${apiBase}/user/balance`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code: 'network', message: `${apiBase} 不可达：${detail}` } }
  }
  if (response.status === UNAUTHORIZED) {
    return {
      ok: false,
      error: { code: 'unauthorized', status: response.status, message: 'API key 无效、已删除或已过期' },
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      error: { code: 'http', status: response.status, message: `接口返回 HTTP ${response.status}` },
    }
  }
  let body
  try {
    body = await response.json()
  } catch {
    return { ok: false, error: { code: 'protocol', status: response.status, message: '响应不是 JSON' } }
  }
  if (body === null || typeof body !== 'object' || !Array.isArray(body.balance_infos)) {
    return { ok: false, error: { code: 'protocol', status: response.status, message: '响应缺少 balance_infos' } }
  }
  return {
    ok: true,
    isAvailable: body.is_available !== false,
    wallets: body.balance_infos.map(walletOf).filter(wallet => wallet !== undefined),
  }
}

/**
 * Register the balance state route, the key write route, and the ping.
 * @param ctx - Cordis context carrying `connection`, `webServer`, and the plugin fiber.
 * @param raw - profile patch row config (`apiKey`, `apiKeyFile`, `apiBase`, `timeoutMs`, `cacheMs`).
 */
export function apply(ctx, raw = {}) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const apiBase = String(config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const keyFile = expandHome(String(config.apiKeyFile ?? DEFAULT_KEY_FILE))
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 15_000
  const cacheMs = Number(config.cacheMs) > 0 ? Number(config.cacheMs) : 1_500
  const configuredKey = typeof config.apiKey === 'string' && config.apiKey.trim() !== ''
    ? config.apiKey.trim()
    : undefined

  /** Resolve the key and where it came from; the key itself never leaves this closure. */
  const resolveKey = async () => {
    if (configuredKey !== undefined) return { key: configuredKey, source: 'config' }
    const environment = (process.env.DEEPSEEK_API_KEY ?? '').trim()
    if (environment !== '') return { key: environment, source: 'env' }
    try {
      const stored = (await readFile(keyFile, 'utf8')).trim()
      if (stored !== '') return { key: stored, source: 'file' }
    } catch {
      // A missing or unreadable key file is the ordinary signed-out state.
    }
    return undefined
  }

  let cached
  let inflight

  /** Read the current state, sharing one in-flight query and a short freshness window. */
  const readState = async () => {
    if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.value
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      const fetchedAt = Date.now()
      const base = { apiBase, keyFile, fetchedAt }
      const resolved = await resolveKey()
      if (resolved === undefined) {
        return {
          ...base,
          configured: false,
          ok: false,
          source: null,
          keyTail: null,
          isAvailable: null,
          wallets: [],
          error: { code: 'missing-key', message: `未配置 API key，见 ${keyFile}` },
        }
      }
      const result = await queryBalance(apiBase, resolved.key, timeoutMs)
      return {
        ...base,
        configured: true,
        source: resolved.source,
        keyTail: maskTail(resolved.key),
        ok: result.ok,
        isAvailable: result.ok ? result.isAvailable : null,
        wallets: result.ok ? result.wallets : [],
        error: result.ok ? null : result.error,
      }
    })()
    try {
      const value = await inflight
      cached = { at: Date.now(), value }
      return value
    } finally {
      inflight = undefined
    }
  }

  /**
   * Verify one candidate key before it is stored, so a typo never replaces a
   * working key file.
   * @param candidate - trimmed key text from the page.
   * @returns `{ ok: true, ...state }` after storing, or a failure response body.
   */
  const storeKey = async (candidate) => {
    if (candidate.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(candidate)) {
      return { status: 400, body: { ok: false, error: { code: 'invalid-key', message: 'key 应以 sk- 开头' } } }
    }
    const verified = await queryBalance(apiBase, candidate, timeoutMs)
    if (!verified.ok) {
      return { status: verified.error.code === 'unauthorized' ? 400 : 502, body: { ok: false, error: verified.error } }
    }
    try {
      await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 })
      await writeFile(keyFile, candidate, { mode: 0o600 })
      await chmod(keyFile, 0o600)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { status: 500, body: { ok: false, error: { code: 'write-failed', message: detail } } }
    }
    const state = {
      apiBase,
      keyFile,
      fetchedAt: Date.now(),
      configured: true,
      source: 'file',
      keyTail: maskTail(candidate),
      ok: true,
      isAvailable: verified.isAvailable,
      wallets: verified.wallets,
      error: null,
    }
    cached = { at: Date.now(), value: state }
    return { status: 200, body: { ...state, saved: true } }
  }

  /** Remove the stored key file and report the resulting state. */
  const clearKey = async () => {
    try {
      await rm(keyFile, { force: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { status: 500, body: { ok: false, error: { code: 'write-failed', message: detail } } }
    }
    cached = undefined
    return { status: 200, body: { ...(await readState()), cleared: true } }
  }

  /**
   * Handle one key write: `{ apiKey }` stores a verified key, `{ clear: true }` removes it.
   * @param request - authenticated POST below `/api`.
   * @returns the response.
   */
  const handleKey = async (request) => {
    const mediaType = (request.headers.get('content-type') ?? '').toLowerCase()
    if (!mediaType.startsWith('application/json')) {
      return json(415, { ok: false, error: { code: 'unsupported-media-type', message: 'expect application/json' } })
    }
    const payload = await request.json().catch(() => undefined)
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(400, { ok: false, error: { code: 'bad-request', message: 'expect a JSON object' } })
    }
    const outcome = payload.clear === true
      ? await clearKey()
      : await storeKey(typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '')
    return json(outcome.status, outcome.body)
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(200, await readState()),
  }), 'dsh-balance: state route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: KEY_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handleKey,
  }), 'dsh-balance: key route')

  const sysmonPath = registerSysmon(ctx, {
    path: SYSMON_PATH,
    intervalMs: Number(config.sysmonIntervalMs) > 0 ? Number(config.sysmonIntervalMs) : 3_000,
  })

  const tracker = createUsageTracker({
    usdToCny: config.usdToCny,
    prices: config.prices,
    historyDays: config.historyDays,
  })
  void startUsagePersistence(ctx, {
    file: config.stateFile,
    tracker,
    flushDelayMs: config.flushDelayMs,
  })
  const usagePath = registerUsage(ctx, {
    path: USAGE_PATH,
    tracker,
    defaultModel: config.defaultModel,
  })

  const routes = [STATE_PATH, KEY_PATH, sysmonPath, usagePath]

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PING_PATH,
    handler: (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, plugin: name, version: VERSION, routes }))
    },
  }), 'dsh-balance: ping route')

  ctx.logger?.info?.('[dsh-balance] routes ready: %s -> %s/user/balance',
    routes.join(', '), apiBase)
}
