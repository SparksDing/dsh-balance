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

{
  const { ctx, routes, webRoutes } = hostContext()
  host.apply(ctx, { apiBase, apiKey: 'sk-test-1234', cacheMs: 0 })
  check('host registers the state and key routes', routes.has(STATE) && routes.has(KEY), [...routes.keys()].join(','))
  check('state route is GET only', JSON.stringify(routes.get(STATE).methods) === '["GET"]')
  check('key route is POST only', JSON.stringify(routes.get(KEY).methods) === '["POST"]')
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
check('client registers both surfaces', registrations.length === 2, String(registrations.length))
const row = registrations.find(r => r.options.name === 'settings.general.item')
const pill = registrations.find(r => r.options.name === 'sidebar.footer.action')
check('row registered into settings.general.item', row !== undefined)
check('pill registered into sidebar.footer.action', pill !== undefined)
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
