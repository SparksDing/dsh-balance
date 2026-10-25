/**
 * System sampling for the status row: CPU busy ratio from `/proc/stat`, memory
 * from `/proc/meminfo`, disk I/O from `/proc/diskstats`, network from
 * `/proc/net/dev`, per-filesystem usage from `/proc/mounts` plus `statfs`, and
 * the load average. Linux-shaped, dependency-free, and injectable so the smoke
 * test can drive it with synthetic `/proc` text.
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
/** Snapshots kept for the sparklines; at the 3s default this is two minutes. */
const MAX_HISTORY = 40
/** Block devices whose counters represent real I/O (partitions roll up into them). */
const DISK_NAME = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/
/** Bytes in one `/proc/diskstats` sector. */
const SECTOR_BYTES = 512

/**
 * Read total and available memory out of `/proc/meminfo`.
 * @param text - file contents.
 * @returns memory figures, or undefined when the file is unusable.
 */
export function parseMeminfo(text) {
  const values = new Map()
  for (const line of String(text).split('\n')) {
    const match = /^(\w+):\s+(\d+)/.exec(line)
    if (match !== null) values.set(match[1], Number(match[2]) * 1024)
  }
  const totalBytes = values.get('MemTotal')
  const availBytes = values.get('MemAvailable') ?? values.get('MemFree')
  if (!(totalBytes > 0) || availBytes === undefined) return undefined
  const usedBytes = Math.max(0, totalBytes - availBytes)
  return {
    totalBytes,
    usedBytes,
    availBytes,
    usedPct: Math.round((100 * usedBytes) / totalBytes),
    totalText: formatBytes(totalBytes),
    usedText: formatBytes(usedBytes),
    availText: formatBytes(availBytes),
  }
}

/**
 * Sum cumulative read/written bytes out of `/proc/diskstats`.
 * @param text - file contents.
 * @returns cumulative byte counters for real block devices.
 */
export function parseDiskstats(text) {
  let readSectors = 0
  let writeSectors = 0
  for (const line of String(text).trim().split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    if (!DISK_NAME.test(fields[2])) continue
    readSectors += Number(fields[5]) || 0
    writeSectors += Number(fields[9]) || 0
  }
  return { readBytes: readSectors * SECTOR_BYTES, writeBytes: writeSectors * SECTOR_BYTES }
}

/**
 * Sum cumulative received/sent bytes out of `/proc/net/dev`, loopback excluded.
 * @param text - file contents.
 * @returns cumulative byte counters.
 */
export function parseNetdev(text) {
  let rxBytes = 0
  let txBytes = 0
  for (const line of String(text).split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const name = line.slice(0, separator).trim()
    if (name === '' || name === 'lo') continue
    const fields = line.slice(separator + 1).trim().split(/\s+/)
    if (fields.length < 9) continue
    rxBytes += Number(fields[0]) || 0
    txBytes += Number(fields[8]) || 0
  }
  return { rxBytes, txBytes }
}

/**
 * Per-second rate between two cumulative counters.
 * @param previousBytes - earlier reading, absent for the first sample.
 * @param nextBytes - later reading.
 * @param elapsedMs - time between the readings.
 * @returns bytes per second, rounded, or null before a delta exists.
 */
export function ratePerSecond(previousBytes, nextBytes, elapsedMs) {
  if (previousBytes === undefined || nextBytes === undefined || !(elapsedMs > 0)) return null
  const delta = nextBytes - previousBytes
  if (delta < 0) return null
  return Math.round((delta * 1000) / elapsedMs)
}

/**
 * Format a bytes-per-second rate.
 * @param bytesPerSecond - rate, or null before the first delta.
 * @returns text such as `12.3K/s`.
 */
export function formatRate(bytesPerSecond) {
  return bytesPerSecond === null ? '—' : `${formatBytes(bytesPerSecond)}/s`
}

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
  const now = deps.now ?? (() => Date.now())
  const history = []
  let previous
  let snapshot = {
    ok: true,
    sampledAt: 0,
    intervalMs: 0,
    cpu: { usagePct: null, cores: cpuCount(), load1: 0, load5: 0, load15: 0 },
    memory: undefined,
    io: { readBps: null, writeBps: null, readText: '—', writeText: '—' },
    net: { rxBps: null, txBps: null, rxText: '—', txText: '—' },
    disks: [],
    history: [],
  }

  const sample = async () => {
    const at = now()
    const elapsedMs = previous === undefined ? 0 : at - previous.at
    const cpu = parseCpuLine(await read('/proc/stat', 'utf8'))
    const usagePct = busyPct(previous?.cpu, cpu)
    const memory = parseMeminfo(await read('/proc/meminfo', 'utf8'))
    const io = parseDiskstats(await read('/proc/diskstats', 'utf8'))
    const net = parseNetdev(await read('/proc/net/dev', 'utf8'))
    const readBps = ratePerSecond(previous?.io.readBytes, io.readBytes, elapsedMs)
    const writeBps = ratePerSecond(previous?.io.writeBytes, io.writeBytes, elapsedMs)
    const rxBps = ratePerSecond(previous?.net.rxBytes, net.rxBytes, elapsedMs)
    const txBps = ratePerSecond(previous?.net.txBytes, net.txBytes, elapsedMs)
    previous = { at, cpu, io, net }
    const [load1, load5, load15] = load()
    const disks = await sampleDisks({ readFile: read, statfs: fs })
    history.push({
      t: at,
      cpu: usagePct,
      mem: memory === undefined ? null : memory.usedPct,
      read: readBps,
      write: writeBps,
      rx: rxBps,
      tx: txBps,
    })
    if (history.length > MAX_HISTORY) history.shift()
    snapshot = {
      ok: true,
      sampledAt: at,
      intervalMs: elapsedMs,
      cpu: {
        usagePct,
        cores: cpuCount(),
        load1: Math.round(load1 * 100) / 100,
        load5: Math.round(load5 * 100) / 100,
        load15: Math.round(load15 * 100) / 100,
      },
      memory,
      io: { readBps, writeBps, readText: formatRate(readBps), writeText: formatRate(writeBps) },
      net: { rxBps, txBps, rxText: formatRate(rxBps), txText: formatRate(txBps) },
      disks,
      history: [...history],
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
