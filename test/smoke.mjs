/**
 * Offline smoke test for the balance plugin, with no Harness and no browser:
 * the Host half runs against a local mock balance endpoint (including the key
 * write route), and the Client half renders both surfaces from synthetic store
 * states.
 *
 *   node test/smoke.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ── Mock DeepSeek platform ───────────────────────────────────────────────────

const server = createServer((request, response) => {
  if (request.url !== '/user/balance') {
    response.writeHead(404).end()
    return
  }
  const authorization = request.headers.authorization ?? ''
  const key = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
  if (!/^sk-test-[a-z0-9]+$/.test(key) || key.startsWith('sk-test-bad')) {
    response.writeHead(401, { 'content-type': 'text/plain' }).end('Authentication Fails')
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    is_available: true,
    balance_infos: [{
      currency: 'CNY', total_balance: '110.25', granted_balance: '10.00', topped_up_balance: '100.25',
    }],
  }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const apiBase = `http://127.0.0.1:${server.address().port}`

// ── Host half ────────────────────────────────────────────────────────────────

const host = await import(pathToFileURL(join(root, 'index.js')).href)
const sysmon = await import(pathToFileURL(join(root, 'sysmon.js')).href)
check('host exports the package name', host.name === '@local/dsh-balance', host.name)
check('host injects connection and webServer', JSON.stringify(host.inject) === '["connection","webServer"]')

/** Build one fake host context that records route registrations by path. */
function hostContext() {
  const routes = new Map()
  const webRoutes = []
  return {
    routes,
    webRoutes,
    ctx: {
      effect(fn) { fn(); return () => {} },
      connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } },
      webServer: { register(route) { webRoutes.push(route); return () => {} } },
      logger: { info() {} },
    },
  }
}

/** GET the state route. */
async function readState(route) {
  const response = await route.fetch(new Request('http://local/api/deepseek-balance/state'))
  return { status: response.status, body: await response.json() }
}

/** POST the key route with JSON. */
async function postKey(route, body) {
  const response = await route.fetch(new Request('http://local/api/deepseek-balance/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

const STATE = '/api/deepseek-balance/state'
const KEY = '/api/deepseek-balance/key'
const SYSMON = '/api/deepseek-balance/sysmon'

{
  const { ctx, routes, webRoutes } = hostContext()
  host.apply(ctx, { apiBase, apiKey: 'sk-test-1234', cacheMs: 0 })
  check('host registers the state, key, and system routes',
    routes.has(STATE) && routes.has(KEY) && routes.has(SYSMON), [...routes.keys()].join(','))
  check('state route is GET only', JSON.stringify(routes.get(STATE).methods) === '["GET"]')
  check('key route is POST only', JSON.stringify(routes.get(KEY).methods) === '["POST"]')
  check('system route is GET only', JSON.stringify(routes.get(SYSMON).methods) === '["GET"]')
  const { status, body } = await readState(routes.get(STATE))
  check('state route answers 200', status === 200)
  check('state reports the wallet', body.ok === true && body.wallets[0].total === '110.25', JSON.stringify(body))
  check('state never carries the key', JSON.stringify(body).includes('sk-test') === false, JSON.stringify(body))
  check('state masks the key tail', body.keyTail === '1234', body.keyTail)
  check('state keeps isAvailable', body.isAvailable === true)
  check('ping route registered', webRoutes.length === 1 && webRoutes[0].path === '/dsh-balance/ping')
  let pingBody
  webRoutes[0].handler({}, { writeHead() {}, end(value) { pingBody = value } })
  check('ping carries no account data', pingBody.includes('"ok":true') && !pingBody.includes('110'), pingBody)
  check('ping lists the served routes', pingBody.includes('"routes"') && pingBody.includes('sysmon'), pingBody)
}

{
  const { ctx, routes } = hostContext()
  host.apply(ctx, { apiBase, apiKey: 'sk-wrong', cacheMs: 0 })
  const { body } = await readState(routes.get(STATE))
  check('bad key reports unauthorized', body.ok === false && body.error.code === 'unauthorized', JSON.stringify(body))
}

{
  const { ctx, routes } = hostContext()
  host.apply(ctx, { apiBase, apiKeyFile: join(root, 'test', 'no-such-key'), cacheMs: 0 })
  const { body } = await readState(routes.get(STATE))
  check('missing key is a configured:false state', body.configured === false && body.error.code === 'missing-key', JSON.stringify(body))
}

{
  const { ctx, routes } = hostContext()
  host.apply(ctx, { apiBase: 'http://127.0.0.1:1', apiKey: 'sk-test-1234', timeoutMs: 500, cacheMs: 0 })
  const { body } = await readState(routes.get(STATE))
  check('unreachable endpoint reports network', body.ok === false && body.error.code === 'network', JSON.stringify(body))
}

{
  const { ctx, routes } = hostContext()
  host.apply(ctx, { apiBase, apiKey: 'sk-test-1234', cacheMs: 0 })
  const response = await routes.get(SYSMON).fetch(new Request('http://local/api/deepseek-balance/sysmon'))
  const body = await response.json()
  check('system route answers 200', response.status === 200)
  check('system route reports either a snapshot or a sampling failure',
    body.ok === true || body.error?.code === 'sampling-failed', JSON.stringify(body).slice(0, 200))
  if (body.ok === true) {
    check('system route reports CPU cores', Number(body.cpu.cores) > 0, JSON.stringify(body.cpu))
    check('system route reports at least the root filesystem',
      body.disks.some(disk => disk.mount === '/'), JSON.stringify(body.disks).slice(0, 200))
    check('system route formats disk sizes', body.disks.every(disk => /^\d/.test(disk.usedText) && /^\d/.test(disk.totalText)))
  }
}

// ── Sampler primitives ───────────────────────────────────────────────────────

{
  const parsed = sysmon.parseCpuLine('cpu  1 2 3 4 5 6 7 8 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\n')
  check('cpu line sums every field', parsed.total === 36 && parsed.idle === 9, JSON.stringify(parsed))
  check('cpu line ignores a missing aggregate', sysmon.parseCpuLine('cpu0 1 2 3 4 5 6 7 8 0 0') === undefined)
  check('busy percentage uses the delta',
    sysmon.busyPct({ total: 100, idle: 80 }, { total: 200, idle: 100 }) === 80,
    String(sysmon.busyPct({ total: 100, idle: 80 }, { total: 200, idle: 100 })))
  check('the first sample has no percentage', sysmon.busyPct(undefined, { total: 10, idle: 5 }) === null)
  check('a stalled counter yields no percentage', sysmon.busyPct({ total: 10, idle: 5 }, { total: 10, idle: 5 }) === null)

  const mounts = sysmon.parseMounts([
    '/dev/vda3 / ext4 rw,relatime 0 0',
    'proc /proc proc rw 0 0',
    'tmpfs /run tmpfs rw 0 0',
    '/dev/vda3 /mnt/bind ext4 rw 0 0',
    '/dev/vda2 /boot/efi vfat rw 0 0',
    'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
    '/dev/vdb1 /mnt/my\\040disk xfs rw 0 0',
  ].join('\n'))
  check('mounts keep only real filesystems', mounts.every(row => row.fstype !== 'proc' && row.fstype !== 'tmpfs'),
    JSON.stringify(mounts))
  check('mounts keep one row per device', mounts.filter(row => row.device === '/dev/vda3').length === 1,
    JSON.stringify(mounts))
  check('mounts decode escaped spaces', mounts.some(row => row.mount === '/mnt/my disk'), JSON.stringify(mounts))
  check('mounts skip container mounts',
    mounts.every(row => !row.mount.startsWith('/var/lib/docker')), JSON.stringify(mounts))

  check('byte formatting keeps one decimal above a gigabyte',
    sysmon.formatBytes(42949672960) === '40G' && sysmon.formatBytes(1536) === '1.5K' && sysmon.formatBytes(1023) === '1023B',
    `${sysmon.formatBytes(42949672960)} ${sysmon.formatBytes(1536)} ${sysmon.formatBytes(1023)}`)

  const fakeStatfs = async () => ({ bsize: 4096, blocks: 10485760, bfree: 7340032, bavail: 6815744 })
  const disks = await sysmon.sampleDisks({
    readFile: async () => '/dev/vda3 / ext4 rw 0 0\nproc /proc proc rw 0 0\n',
    statfs: fakeStatfs,
  })
  check('disk sampling reports one filesystem', disks.length === 1, JSON.stringify(disks))
  check('disk sampling computes totals and percentages',
    disks[0].totalBytes === 42_949_672_960 && disks[0].usedPct === 32 && disks[0].totalText === '40G' && disks[0].usedText === '12G',
    JSON.stringify(disks[0]))
  check('disk sampling tolerates an unreadable mount',
    (await sysmon.sampleDisks({
      readFile: async () => '/dev/vda3 / ext4 rw 0 0\n',
      statfs: async () => { throw new Error('EACCES') },
    })).length === 0)

  const meminfo = 'MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\n'
  const mountText = '/dev/vda3 / ext4 rw 0 0\n'
  let call = 0
  let clock = 1_000_000
  const sampler = sysmon.createSampler({
    readFile: async (path) => {
      if (path === '/proc/stat') {
        call += 1
        return call === 1 ? 'cpu  0 0 0 100 0 0 0 0 0 0\n' : 'cpu  50 0 0 150 0 0 0 0 0 0\n'
      }
      if (path === '/proc/meminfo') return meminfo
      if (path === '/proc/diskstats') {
        return call === 1
          ? '254 0 vda 10 0 100 0 20 0 200 0 0 0 0\n'
          : '254 0 vda 20 0 300 0 40 0 600 0 0 0 0\n'
      }
      if (path === '/proc/net/dev') {
        return call === 1
          ? 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 9 0 0 0 0 0 0 0 9 0 0 0 0 0 0 0\n  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n'
          : 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 9 0 0 0 0 0 0 0 9 0 0 0 0 0 0 0\n  eth0: 4000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0\n'
      }
      return mountText
    },
    statfs: fakeStatfs,
    loadavg: () => [0.5, 0.4, 0.3],
    cpuCount: () => 2,
    now: () => { const value = clock; clock += 3_000; return value },
  })
  const first = await sampler.sample()
  const second = await sampler.sample()
  check('the first sample has no CPU percentage yet', first.cpu.usagePct === null, JSON.stringify(first.cpu))
  check('the second sample diffs the counters', second.cpu.usagePct === 50, JSON.stringify(second.cpu))
  check('the sampler reports cores and load',
    second.cpu.cores === 2 && second.cpu.load1 === 0.5 && second.cpu.load15 === 0.3, JSON.stringify(second.cpu))
  check('the sampler keeps the last snapshot', sampler.get() === second)
  check('the sampler reports memory', second.memory?.usedPct === 50 && second.memory.totalText === '2G', JSON.stringify(second.memory))
  check('the sampler turns disk sectors into a rate',
    second.io.writeBps === Math.round((400 * 512) / 3) && second.io.writeText.endsWith('/s'), JSON.stringify(second.io))
  check('the sampler turns network counters into a rate',
    second.net.rxBps === 1000 && second.net.txBps === 1000, JSON.stringify(second.net))
  check('the first sample leaves rates unknown', first.io.readBps === null && first.net.rxBps === null, JSON.stringify(first.io))
  check('the sampler accumulates a trend history',
    second.history.length === 2 && second.history[1].cpu === 50 && second.history[1].mem === 50,
    JSON.stringify(second.history))
}

{
  const mem = sysmon.parseMeminfo('MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\n')
  check('meminfo converts kB and computes the percentage',
    mem.totalBytes === 2_147_483_648 && mem.usedBytes === 1_073_741_824 && mem.usedPct === 50, JSON.stringify(mem))
  check('meminfo falls back to MemFree', sysmon.parseMeminfo('MemTotal: 1024 kB\nMemFree: 256 kB\n')?.usedBytes === 768 * 1024)
  check('meminfo rejects a missing total', sysmon.parseMeminfo('MemFree: 256 kB\n') === undefined)

  const io = sysmon.parseDiskstats('254 0 vda 10 0 100 0 20 0 200 0 0 0 0\n254 1 vda3 5 0 999 0 1 0 999 0 0 0 0\n')
  check('diskstats counts whole devices only',
    io.readBytes === 100 * 512 && io.writeBytes === 200 * 512, JSON.stringify(io))

  const net = sysmon.parseNetdev('Inter-| Receive | Transmit\n    lo: 9 0 0 0 0 0 0 0 9 0 0 0 0 0 0 0\n  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n')
  check('netdev skips loopback', net.rxBytes === 1000 && net.txBytes === 2000, JSON.stringify(net))

  check('rates divide by the elapsed time', sysmon.ratePerSecond(1000, 4000, 3_000) === 1000)
  check('rates stay unknown without an earlier reading', sysmon.ratePerSecond(undefined, 4000, 3_000) === null)
  check('rate text carries the unit', sysmon.formatRate(1024) === '1K/s' && sysmon.formatRate(null) === '—')
}

// ── System route failure shape ───────────────────────────────────────────────

{
  const registered = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    connection: { fetch: { register(route) { registered.push(route); return () => {} } } },
  }
  sysmon.registerSysmon(ctx, {
    path: '/api/deepseek-balance/sysmon',
    intervalMs: 50,
    sampler: { get: () => ({ ok: true, sampledAt: 1, cpu: {}, disks: [] }), sample: async () => { throw new Error('boom') } },
  })
  await new Promise(resolve => setTimeout(resolve, 120))
  const response = await registered[0].fetch(new Request('http://local/api/deepseek-balance/sysmon'))
  const body = await response.json()
  check('a sampling failure is reported, not thrown', body.ok === false && body.error.code === 'sampling-failed', JSON.stringify(body))
}

// ── Key write route ──────────────────────────────────────────────────────────

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
const keyFile = join(sandbox, 'api_key')

{
  const { ctx, routes } = hostContext()
  host.apply(ctx, { apiBase, apiKeyFile: keyFile, cacheMs: 0 })
  const state = routes.get(STATE)
  const keyRoute = routes.get(KEY)

  const before = await readState(state)
  check('a fresh temp key file starts unconfigured', before.body.configured === false, JSON.stringify(before.body))

  const provided = 'sk-test-7777aaaabbbbccccdddd'
  const saved = await postKey(keyRoute, { apiKey: provided })
  check('saving a verified key answers 200', saved.status === 200 && saved.body.saved === true, JSON.stringify(saved.body))
  check('saving reports the wallet immediately', saved.body.ok === true && saved.body.wallets[0].total === '110.25', JSON.stringify(saved.body))
  check('saving reports the file as the key source', saved.body.source === 'file' && saved.body.keyTail === 'dddd', JSON.stringify(saved.body))
  check('saving never echoes the key', JSON.stringify(saved.body).includes('sk-test') === false, JSON.stringify(saved.body))

  const stored = await readFile(keyFile, 'utf8')
  check('the key file holds exactly the key', stored === provided, stored)
  const mode = (await stat(keyFile)).mode & 0o777
  check('the key file is 600', mode === 0o600, mode.toString(8))

  const after = await readState(state)
  check('the state route picks up the stored key', after.body.ok === true && after.body.source === 'file', JSON.stringify(after.body))

  const malformed = await postKey(keyRoute, { apiKey: 'not-a-key' })
  check('a malformed key is rejected', malformed.status === 400 && malformed.body.error.code === 'invalid-key', JSON.stringify(malformed.body))
  check('a rejected key leaves the file untouched', (await readFile(keyFile, 'utf8')) === provided)

  const rejected = await postKey(keyRoute, { apiKey: 'sk-test-bad0000111122223333' })
  check('a platform-rejected key is not stored', rejected.status === 400 && rejected.body.error.code === 'unauthorized', JSON.stringify(rejected.body))
  check('a platform-rejected key leaves the file untouched', (await readFile(keyFile, 'utf8')) === provided)

  const wrongType = await keyRoute.fetch(new Request('http://local/api/deepseek-balance/key', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: provided,
  }))
  check('a non-JSON key write is refused', wrongType.status === 415, String(wrongType.status))

  const cleared = await postKey(keyRoute, { clear: true })
  check('clearing answers 200 and reports cleared', cleared.status === 200 && cleared.body.cleared === true, JSON.stringify(cleared.body))
  check('clearing returns the unconfigured state', cleared.body.configured === false, JSON.stringify(cleared.body))
  let gone = false
  try {
    await readFile(keyFile, 'utf8')
  } catch {
    gone = true
  }
  check('clearing removes the key file', gone)
}

await rm(sandbox, { recursive: true, force: true })
server.close()

// ── Client half ──────────────────────────────────────────────────────────────

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...props, children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children } }
  },
  useState(initial) { return [initial, () => {}] },
  useEffect() {},
}

let entry
globalThis.window = { __ModuleLoader__: { load(value) { entry = value } } }
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.fetch = async () => { throw new Error('offline') }

await import(pathToFileURL(join(root, 'client.js')).href)
check('client registers its factory', entry !== undefined && entry.id === '@local/dsh-balance', entry?.id)

const plugin = entry.factory((specifier) => {
  if (specifier !== 'react') throw new Error(`unexpected external ${specifier}`)
  return React
})
check('client plugin injects slots and locale', JSON.stringify(plugin.inject) === '["slots","locale"]')

const registrations = []
const fakeCtx = {
  effect(fn) { const dispose = fn(); this.effects.push(dispose); return () => {} },
  effects: [],
  locale: {
    register() { return () => {} },
    bind() { return (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`) },
  },
  slots: {
    inject(name, callback) { callback() },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
plugin.apply(fakeCtx)
check('client registers four surfaces', registrations.length === 4, String(registrations.length))
const rows = registrations.filter(r => r.options.name === 'settings.general.item')
const pills = registrations.filter(r => r.options.name === 'sidebar.footer.action')
const row = rows.find(r => r.options.id === 'deepseek-balance')
const pill = pills.find(r => r.options.id === 'deepseek-balance')
const sysRow = rows.find(r => r.options.id === 'system-status')
const sysPill = pills.find(r => r.options.id === 'system-status')
check('row registered into settings.general.item', row !== undefined)
check('pill registered into sidebar.footer.action', pill !== undefined)
check('system row registered into settings.general.item', sysRow !== undefined)
check('system pill registered into sidebar.footer.action', sysPill !== undefined)
check('row carries the locale seat', row.options.locale === 'dshBalance')

/** Flatten a rendered tree into its text. */
function textOf(node) {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && 'props' in node) {
    // Render function components the way React would, so their labels count.
    if (typeof node.type === 'function') return textOf(node.type(node.props))
    return textOf(node.props.children)
  }
  return ''
}

/** Build a synthetic store state. */
const storeState = (phase, data, transportError) => ({
  get: () => ({ phase, data, transportError }),
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
  replace: () => {},
})

const readyData = {
  configured: true,
  ok: true,
  apiBase,
  keyFile: '/home/u/.config/deepseek/api_key',
  fetchedAt: Date.now(),
  source: 'file',
  keyTail: '1234',
  isAvailable: true,
  wallets: [{ currency: 'CNY', total: '110.25', toppedUp: '100.25', granted: '10.00' }],
  error: null,
}

const translate = fakeCtx.locale.bind('dshBalance')

{
  const text = textOf(row.component({ t: translate, bal: storeState('ready', readyData) }))
  check('row shows the CNY total', text.includes('¥110.25'), text)
  check('row names the setting', text.includes('title'), text)
  check('row shows the granted amount', text.includes('granted{"amount":"¥10.00"}'), text)
  check('row offers change and clear once configured',
    text.includes('changeKey') && text.includes('clearKey'), text)
  check('row shows which key is stored', text.includes('keyTailLabel{"tail":"1234"}'), text)
}

{
  const missing = { ...readyData, configured: false, ok: false, source: null, keyTail: null, wallets: [], error: { code: 'missing-key', message: 'x' } }
  const text = textOf(row.component({ t: translate, bal: storeState('ready', missing) }))
  check('row offers the set-key action when unconfigured', text.includes('setKey') && !text.includes('clearKey'), text)
  check('row explains the missing key', text.includes('missingKey'), text)
}

{
  const bad = { ...readyData, ok: false, wallets: [], error: { code: 'unauthorized', status: 401, message: 'x' } }
  const text = textOf(row.component({ t: translate, bal: storeState('ready', bad) }))
  check('row explains an unauthorized key', text.includes('unauthorized') && text.includes('errorShort'), text)
}

{
  const text = textOf(row.component({ t: translate, bal: storeState('error', undefined, 'HTTP 500') }))
  check('row reports a transport failure',
    text.includes('failed{"message":"HTTP 500"}') && text.includes('errorShort'), text)
}

{
  const fromEnv = { ...readyData, source: 'env' }
  const text = textOf(row.component({ t: translate, bal: storeState('ready', fromEnv) }))
  check('row warns when the key comes from the environment',
    text.includes('sourceWarning{"source":"sourceEnv"}'), text)
}

{
  const text = textOf(pill.component({ t: translate, bal: storeState('ready', readyData), wide: true }))
  check('wide pill shows the amount', text.includes('¥110.25'), text)
  const rail = textOf(pill.component({ t: translate, bal: storeState('ready', readyData), wide: false }))
  check('rail pill shows only the symbol', rail.trim() === '¥', rail)
}

{
  const view = pill.component({ t: translate, bal: storeState('ready', readyData), wide: true })
  check('pill carries a tooltip',
    typeof view.props.title === 'string' && view.props.title.startsWith('title') && view.props.title.includes('¥110.25'))
}

const sysmonData = {
  ok: true,
  sampledAt: Date.now(),
  intervalMs: 3000,
  cpu: { usagePct: 12.5, cores: 2, load1: 0.68, load5: 0.43, load15: 0.35 },
  memory: { totalBytes: 2_147_483_648, usedBytes: 1_073_741_824, usedPct: 50, totalText: '2G', usedText: '1G', availText: '1G' },
  io: { readBps: 0, writeBps: 1024, readText: '0B/s', writeText: '1K/s' },
  net: { rxBps: 2048, txBps: 512, rxText: '2K/s', txText: '512B/s' },
  history: [
    { t: 1, cpu: 8, mem: 49, read: 0, write: 512, rx: 1024, tx: 256 },
    { t: 2, cpu: 12.5, mem: 50, read: 0, write: 1024, rx: 2048, tx: 512 },
  ],
  disks: [
    { device: '/dev/vda3', mount: '/', fstype: 'ext4', totalBytes: 42_949_672_960, usedBytes: 10_200_000_000, availBytes: 30_000_000_000, usedPct: 26, totalText: '40G', usedText: '9.5G', availText: '28G' },
    { device: '/dev/vda2', mount: '/boot/efi', fstype: 'vfat', totalBytes: 206_000_000, usedBytes: 6_600_000, availBytes: 200_000_000, usedPct: 4, totalText: '197M', usedText: '6.3M', availText: '191M' },
  ],
}

{
  const text = textOf(sysRow.component({ t: translate, sys: storeState('ready', sysmonData) }))
  check('system row shows CPU percentage and cores',
    text.includes('sysCpu{"pct":"12.5"}') && text.includes('sysCores{"n":2}') && text.includes('sysLoad'), text)
  check('system row lists disks', text.includes('sysDisk{"mount":"/","used":"9.5G","total":"40G","pct":26}'), text)
  check('system row reports memory',
    text.includes('sysMem{"used":"1G","total":"2G","pct":50}'), text)
  check('system row offers the details toggle', text.includes('sysDetails'), text)
  check('system row features the root usage on the right', text.includes('26%'), text)
}

{
  const text = textOf(sysRow.component({ t: translate, sys: storeState('error', undefined, 'HTTP 500') }))
  check('system row reports a transport failure', text.includes('failed{"message":"HTTP 500"}'), text)
}

{
  const text = textOf(sysPill.component({ t: translate, sys: storeState('ready', sysmonData), wide: true }))
  check('wide system pill names CPU and disk',
    text.includes('sysPill{"cpu":"12.5","disk":"26"}'), text)
  const rail = sysPill.component({ t: translate, sys: storeState('ready', sysmonData), wide: false })
  check('system pill is hidden on the collapsed rail', rail === null)
}

{
  // The dictionaries are not exported; compare their key sets from the source.
  const source = await readFile(join(root, 'client.js'), 'utf8')
  const keys = (name) => {
    const block = source.slice(source.indexOf(`const ${name} = {`))
    const body = block.slice(0, block.indexOf('\n    }'))
    return [...body.matchAll(/^\s{6}(\w+):/gm)].map(match => match[1])
  }
  const zh = keys('zh')
  const en = keys('en')
  check('zh and en dictionaries carry the same keys',
    zh.length === en.length && zh.every(key => en.includes(key)) && en.every(key => zh.includes(key)),
    `zh=${zh.length} en=${en.length}`)
}

for (const dispose of fakeCtx.effects) {
  if (typeof dispose === 'function') await dispose()
}

console.log(failures === 0 ? '\nall smoke checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
