/**
 * Durability for the spend ledger: load the last state on activation, write it
 * back after a quiet period and once more on disposal, so a Host restart
 * resumes today's figure and the recent-day history.
 *
 * The write is atomic (temp file + rename) and the file holds no secrets: day
 * keys, token counts, and computed money.
 *
 * @module @local/dsh-balance/spend-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Default ledger path; a deployment can override it in the profile row. */
export const DEFAULT_STATE_FILE = join(homedir(), '.local', 'state', 'dsh-balance', 'usage.json')

/**
 * Read one persisted ledger, tolerating every broken-file outcome.
 * @param file - ledger path.
 * @param deps - optional `readFile` override for tests.
 * @returns the parsed state, or undefined when absent or unusable.
 */
export async function loadUsageState(file, deps = {}) {
  const read = deps.readFile ?? readFile
  let text
  try {
    text = await read(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.days)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Write the ledger atomically so a crash mid-write cannot truncate it.
 * @param file - ledger path.
 * @param state - `exportState()` output.
 * @param deps - optional `writeFile`/`rename`/`mkdir` overrides for tests.
 */
export async function saveUsageState(file, state, deps = {}) {
  const save = deps.writeFile ?? writeFile
  const move = deps.rename ?? rename
  const ensure = deps.mkdir ?? mkdir
  await ensure(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  await save(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await move(temporary, file)
}

/**
 * Load the ledger, keep it in memory, and persist it after every quiet period
 * plus once on disposal.
 * @param ctx - Cordis context owning the timers and the final flush.
 * @param options - `file`, the `tracker`, `flushDelayMs`, and fs overrides.
 * @returns the loaded state promise, for tests and diagnostics.
 */
export function startUsagePersistence(ctx, options) {
  const file = options.file ?? DEFAULT_STATE_FILE
  const tracker = options.tracker
  const flushDelayMs = Number(options.flushDelayMs) > 0 ? Number(options.flushDelayMs) : 1_000
  const deps = { readFile: options.readFile, writeFile: options.writeFile, rename: options.rename, mkdir: options.mkdir }

  let timer
  let dirty = false
  let writing

  const flush = async () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!dirty) return
    dirty = false
    if (writing !== undefined) await writing.catch(() => {})
    writing = saveUsageState(file, tracker.exportState(), deps)
      .catch((error) => {
        ctx.logger?.warn?.('[dsh-balance] spend ledger write failed: %s', error instanceof Error ? error.message : String(error))
        dirty = true
      })
      .finally(() => { writing = undefined })
    await writing
  }

  const schedule = () => {
    dirty = true
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, flushDelayMs)
    timer.unref?.()
  }

  const unsubscribe = tracker.subscribe(schedule)

  const loaded = loadUsageState(file, deps).then((state) => {
    if (state !== undefined) tracker.hydrate(state)
    return state
  })

  ctx.effect(() => () => {
    unsubscribe()
    return flush()
  }, 'dsh-balance: spend ledger lifetime')

  ctx.effect(() => () => {
    // A page that never recorded anything still gets the seeds persisted on
    // shutdown; the flush is idempotent when nothing is dirty.
    dirty = true
    return flush()
  }, 'dsh-balance: spend ledger flush')

  return loaded
}
