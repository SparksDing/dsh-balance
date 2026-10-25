/**
 * Offline smoke test for the balance plugin, with no Harness and no browser:
 * the Host half runs against a local mock balance endpoint, and the Client
 * half renders both surfaces from synthetic store states.
 *
 *   node test/smoke.mjs
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ── Host half ────────────────────────────────────────────────────────────────

const server = createServer((request, response) => {
  if (request.url !== '/user/balance') {
    response.writeHead(404).end()
    return
  }
  if (request.headers.authorization !== 'Bearer sk-test-1234') {
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

const host = await import(pathToFileURL(join(root, 'index.js')).href)
check('host exports the package name', host.name === '@local/dsh-balance', host.name)
check('host injects connection and webServer', JSON.stringify(host.inject) === '["connection","webServer"]')

/** Build one fake host context that records route registrations. */
function hostContext() {
  const fetchRoutes = []
  const webRoutes = []
  const effects = []
  return {
    fetchRoutes,
    webRoutes,
    ctx: {
      effect(fn, label) { effects.push([label, fn()]); return () => {} },
      connection: { fetch: { register(route) { fetchRoutes.push(route); return () => {} } } },
      webServer: { register(route) { webRoutes.push(route); return () => {} } },
      logger: { info() {} },
    },
  }
}

/** Read the state route once. */
async function readState(route) {
  const response = await route.fetch(new Request('http://local/api/deepseek-balance/state'))
  return { status: response.status, body: await response.json() }
}

{
  const { ctx, fetchRoutes, webRoutes } = hostContext()
  host.apply(ctx, { apiBase, apiKey: 'sk-test-1234', cacheMs: 0 })
  check('host registers exactly one state route', fetchRoutes.length === 1)
  check('state route path is under /api', fetchRoutes[0].path === '/api/deepseek-balance/state', fetchRoutes[0].path)
  const { status, body } = await readState(fetchRoutes[0])
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
  const { ctx, fetchRoutes } = hostContext()
  host.apply(ctx, { apiBase, apiKey: 'sk-wrong', cacheMs: 0 })
  const { body } = await readState(fetchRoutes[0])
  check('bad key reports unauthorized', body.ok === false && body.error.code === 'unauthorized', JSON.stringify(body))
}

{
  const { ctx, fetchRoutes } = hostContext()
  host.apply(ctx, { apiBase, apiKeyFile: join(root, 'test', 'no-such-key'), cacheMs: 0 })
  const { body } = await readState(fetchRoutes[0])
  check('missing key is a configured:false state', body.configured === false && body.error.code === 'missing-key', JSON.stringify(body))
}

{
  const { ctx, fetchRoutes } = hostContext()
  host.apply(ctx, { apiBase: 'http://127.0.0.1:1', apiKey: 'sk-test-1234', timeoutMs: 500, cacheMs: 0 })
  const { body } = await readState(fetchRoutes[0])
  check('unreachable endpoint reports network', body.ok === false && body.error.code === 'network', JSON.stringify(body))
}
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

const plugin = entry.factory(specifier => {
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
  if (typeof node === 'object' && 'props' in node) return textOf(node.props.children)
  return ''
}

/** Build a synthetic store state. */
const storeState = (phase, data, transportError) => ({
  get: () => ({ phase, data, transportError }),
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
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

// The components receive the framework's `t`; reuse the namespace binder.
const translate = fakeCtx.locale.bind('dshBalance')

{
  const view = row.component({ t: translate, bal: storeState('ready', readyData) })
  const text = textOf(view)
  check('row shows the CNY total', text.includes('¥110.25'), text)
  check('row names the setting', text.includes('title'), text)
  check('row shows the granted amount', text.includes('granted{"amount":"¥10.00"}'), text)
}

{
  const missing = { ...readyData, configured: false, ok: false, wallets: [], error: { code: 'missing-key', message: 'x' } }
  const text = textOf(row.component({ t: translate, bal: storeState('ready', missing) }))
  check('row explains a missing key with its path',
    text.includes('missingKey{"path":"/home/u/.config/deepseek/api_key"}') && text.includes('unconfiguredShort'), text)
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

for (const dispose of fakeCtx.effects) {
  if (typeof dispose === 'function') await dispose()
}

console.log(failures === 0 ? '\nall smoke checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
