/**
 * System sampling for the status row: CPU busy ratio from `/proc/stat`, disk
 * usage per real filesystem from `/proc/mounts` plus `statfs`, and the load
 * average. Linux-shaped, dependency-free, and injectable so the smoke test can
 * drive it with synthetic `/proc` text.
 *
 * @module @local/dsh-balance/sysmon
 */

import { readFile, statfs } from 'node:fs/promises'
import { cpus, loadavg } from 'node:os'
import { json } from './http.js'

/** Filesystems whose usage is worth reporting; pseudo filesystems are skipped. */
const REAL_FS = new Set([
  'bcachefs', 'btrfs', 'exfat', 'ext2', 'ext3', 'ext4', 'f2fs', 'jfs',
  'ntfs', 'ntfs3', 'overlay', 'reiserfs', 'vfat', 'xfs', 'zfs',
])
/** Kernel trees that never represent a disk a person is filling. */
const SKIP_MOUNT = /^\/(proc|sys|dev|run|snap|var\/lib\/docker)(\/|$)/
/** Mountpoints listed at most, largest filesystem first. */
const MAX_DISKS = 8

/**
 * Decode the octal escapes `/proc/mounts` uses for whitespace and backslashes.
 * @param value - raw field.
 * @returns the decoded field.
 */
function unescapeMount(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
}

/**
 * Read the aggregate CPU counters out of one `/proc/stat` snapshot.
 * @param text - file contents.
 * @returns total and idle+iowait jiffies, or undefined when the line is absent.
 */
export function parseCpuLine(text) {
  const line = String(text).split('\n').find(row => row.startsWith('cpu '))
  if (line === undefined) return undefined
  const fields = line.trim().split(/\s+/).slice(1).map(Number)
  if (fields.length < 5 || fields.some(value => !Number.isFinite(value))) return undefined
  return {
    total: fields.reduce((sum, value) => sum + value, 0),
    idle: fields[3] + fields[4],
  }
}

/**
 * Busy percentage between two counter snapshots.
 * @param previous - earlier snapshot, absent for the first sample.
 * @param next - later snapshot.
 * @returns percentage rounded to one decimal, or null before a delta exists.
 */
export function busyPct(previous, next) {
  if (previous === undefined || next === undefined) return null
  const total = next.total - previous.total
  const idle = next.idle - previous.idle
  if (total <= 0) return null
  const pct = (100 * (total - idle)) / total
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10
}

/**
 * Pick the reportable filesystems out of one `/proc/mounts` snapshot.
 * @param text - file contents.
 * @returns one row per device, using its shortest mountpoint.
 */
export function parseMounts(text) {
  const byDevice = new Map()
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue
    const [device, rawMount, fstype] = line.split(' ')
    if (device === undefined || rawMount === undefined || fstype === undefined) continue
    if (!REAL_FS.has(fstype)) continue
    const mount = unescapeMount(rawMount)
    if (SKIP_MOUNT.test(mount)) continue
    const kept = byDevice.get(device)
    if (kept === undefined || mount.length < kept.mount.length) byDevice.set(device, { device, mount, fstype })
  }
  return [...byDevice.values()]
}

/**
 * Format a byte count the way `df -h` does, with one decimal above a gigabyte.
 * @param bytes - non-negative byte count.
 * @returns compact text such as `42.1G`.
 */
export function formatBytes(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T', 'P']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // Round up the way `df -h` does: one decimal below ten, whole numbers above,
  // so a nearly full disk never reads smaller than it is.
  const rounded = unit === 0 ? Math.round(value) : value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value)
  return `${rounded}${units[unit]}`
}

/**
 * Sample every reportable filesystem once.
 * @param deps - optional `readFile`/`statfs` overrides for tests.
 * @returns rows sorted by size, largest first.
 */
export async function sampleDisks(deps = {}) {
  const read = deps.readFile ?? readFile
  const fs = deps.statfs ?? statfs
  const mounts = parseMounts(await read('/proc/mounts', 'utf8'))
  const disks = []
  for (const mount of mounts) {
    let stat
    try {
      stat = await fs(mount.mount)
    } catch {
      // An unmounted or unreadable path is not a disk the user can free.
      continue
    }
    const blockSize = Number(stat.bsize)
    const blocks = Number(stat.blocks)
    if (!(blockSize > 0) || !(blocks > 0)) continue
    const totalBytes = blockSize * blocks
    const usedBytes = blockSize * (blocks - Number(stat.bfree))
    const availBytes = blockSize * Number(stat.bavail)
    const denominator = usedBytes + availBytes
    disks.push({
      ...mount,
      totalBytes,
      usedBytes,
      availBytes,
      usedPct: denominator > 0 ? Math.round((100 * usedBytes) / denominator) : 0,
      totalText: formatBytes(totalBytes),
      usedText: formatBytes(usedBytes),
      availText: formatBytes(availBytes),
    })
  }
  disks.sort((left, right) => right.totalBytes - left.totalBytes)
  return disks.slice(0, MAX_DISKS)
}

/**
 * Build a sampler that keeps the last snapshot and diffs two CPU samples.
 * @param deps - optional `readFile`/`statfs`/`loadavg`/`cpuCount` overrides.
 * @returns `{ sample, get }`; `sample` resolves the fresh snapshot.
 */
export function createSampler(deps = {}) {
  const read = deps.readFile ?? readFile
  const fs = deps.statfs ?? statfs
  const load = deps.loadavg ?? loadavg
  const cpuCount = deps.cpuCount ?? (() => cpus().length)
  let previousCpu
  let snapshot = {
    ok: true,
    sampledAt: 0,
    cpu: { usagePct: null, cores: cpuCount(), load1: 0, load5: 0, load15: 0 },
    disks: [],
  }

  const sample = async () => {
    const cpu = parseCpuLine(await read('/proc/stat', 'utf8'))
    const usagePct = busyPct(previousCpu, cpu)
    if (cpu !== undefined) previousCpu = cpu
    const [load1, load5, load15] = load()
    const disks = await sampleDisks({ readFile: read, statfs: fs })
    snapshot = {
      ok: true,
      sampledAt: Date.now(),
      cpu: {
        usagePct,
        cores: cpuCount(),
        load1: Math.round(load1 * 100) / 100,
        load5: Math.round(load5 * 100) / 100,
        load15: Math.round(load15 * 100) / 100,
      },
      disks,
    }
    return snapshot
  }

  return { sample, get: () => snapshot }
}

/**
 * Register the sampling timer and the authenticated state route.
 * @param ctx - Cordis context carrying `connection` and the plugin fiber.
 * @param options - `path`, `intervalMs`, and an optional `sampler` override.
 * @returns the route path, for the ping's route list.
 */
export function registerSysmon(ctx, options = {}) {
  const path = options.path
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 3_000
  const sampler = options.sampler ?? createSampler()
  let inflight
  let failure

  const tick = () => {
    if (inflight !== undefined) return inflight
    inflight = sampler.sample()
      .then((snapshot) => {
        failure = undefined
        return snapshot
      }, (error) => {
        failure = error instanceof Error ? error.message : String(error)
      })
      .finally(() => { inflight = undefined })
    return inflight
  }

  ctx.effect(() => {
    void tick()
    const timer = setInterval(() => { void tick() }, intervalMs)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, 'dsh-balance: system sampling')

  ctx.effect(() => ctx.connection.fetch.register({
    path,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      // The first read waits for one sample, so a fresh page never sees an
      // empty snapshot just because the timer has not fired yet.
      if (sampler.get().sampledAt === 0) await tick()
      const snapshot = sampler.get()
      if (failure !== undefined) {
        return json(200, { ...snapshot, ok: false, error: { code: 'sampling-failed', message: failure } })
      }
      return json(200, snapshot)
    },
  }), 'dsh-balance: system route')

  return path
}
