/**
 * Browser half of `@local/dsh-balance`: a sidebar balance pill and a General
 * settings row, both polling the authenticated Host state route.
 *
 * The module registers one lazy factory with `window.__ModuleLoader__`; the id
 * equals the package name. React comes from the shared platform module table.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-balance',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dshBalance'
    /** Host route relative to the page origin, behind Connection's authentication. */
    const ROUTE = '/api/deepseek-balance/state'
    /** Background refresh cadence while the page is open. */
    const POLL_MS = 30_000
    /** Currency symbols for the wallets DeepSeek reports. */
    const SYMBOLS = { CNY: '¥', USD: '$' }

    const zh = {
      title: 'DeepSeek API 余额',
      refresh: '刷新',
      loading: '正在查询…',
      updated: '更新于 {time}',
      poll: '每 30 秒自动刷新',
      granted: '含赠送 {amount}',
      toppedUp: '充值 {amount}',
      missingKey: '未配置 API key：把 key 写入 {path}',
      unauthorized: 'API key 无效、已删除或已过期',
      failed: '查询失败：{message}',
      empty: '账户没有钱包记录',
      unconfiguredShort: '未配置',
      errorShort: '查询失败',
    }

    const en = {
      title: 'DeepSeek API balance',
      refresh: 'Refresh',
      loading: 'Checking…',
      updated: 'Updated {time}',
      poll: 'Refreshes every 30s',
      granted: '+{amount} granted',
      toppedUp: '{amount} topped up',
      missingKey: 'No API key: write one to {path}',
      unauthorized: 'API key is invalid, deleted, or expired',
      failed: 'Query failed: {message}',
      empty: 'No wallet on this account',
      unconfiguredShort: 'No key',
      errorShort: 'Unavailable',
    }

    /**
     * Create the shared balance store: one fetch at a time, subscribers
     * notified on every settled read.
     * @param request - the state fetch returning parsed JSON.
     * @returns the store handle read by both surfaces.
     */
    function createStore(request) {
      let state = { phase: 'idle', data: undefined, transportError: undefined }
      const listeners = new Set()
      let inflight
      const publish = (next) => {
        state = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-balance] subscriber crashed:', error)
          }
        }
      }
      const refresh = () => {
        if (inflight !== undefined) return inflight
        if (state.phase !== 'ready') publish({ ...state, phase: 'loading' })
        inflight = (async () => {
          try {
            const data = await request()
            publish({ phase: 'ready', data, transportError: undefined })
          } catch (error) {
            publish({
              phase: 'error',
              data: state.data,
              transportError: error instanceof Error ? error.message : String(error),
            })
          } finally {
            inflight = undefined
          }
        })()
        return inflight
      }
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        refresh,
      }
    }

    /**
     * Subscribe one component to the store.
     * @param store - balance store.
     * @returns the current state, re-rendering on every publish.
     */
    function useBalance(store) {
      const [state, setState] = React.useState(store.get())
      React.useEffect(() => store.subscribe(() => { setState(store.get()) }), [store])
      return state
    }

    /** The wallet to feature: CNY when present, otherwise the first one. */
    function primaryWallet(data) {
      if (data === undefined || !Array.isArray(data.wallets) || data.wallets.length === 0) return undefined
      return data.wallets.find(wallet => wallet.currency === 'CNY') ?? data.wallets[0]
    }

    /** Format one wallet total with its currency symbol. */
    function money(wallet) {
      return `${SYMBOLS[wallet.currency] ?? `${wallet.currency} `}${wallet.total}`
    }

    /**
     * Compose the one-line status the row and the pill share.
     * @param state - store state.
     * @param t - translated string for this namespace.
     * @returns the headline value, the detail line, and whether it is healthy.
     */
    function describe(state, t) {
      const data = state.data
      if (data === undefined) {
        return {
          value: state.phase === 'error' ? t('errorShort') : '…',
          detail: state.phase === 'error'
            ? t('failed', { message: state.transportError ?? 'route' })
            : t('loading'),
          healthy: false,
        }
      }
      if (data.ok === true) {
        const wallet = primaryWallet(data)
        if (wallet === undefined) return { value: '—', detail: t('empty'), healthy: false }
        const parts = [t('updated', { time: new Date(data.fetchedAt).toLocaleTimeString() }), t('poll')]
        const granted = Number(wallet.granted)
        if (Number.isFinite(granted) && granted > 0) parts.unshift(t('granted', { amount: `${SYMBOLS[wallet.currency] ?? ''}${wallet.granted}` }))
        return { value: money(wallet), detail: parts.join(' · '), healthy: data.isAvailable !== false }
      }
      const error = data.error ?? { code: 'unknown', message: state.transportError ?? 'unknown' }
      const detail = error.code === 'missing-key'
        ? t('missingKey', { path: data.keyFile })
        : error.code === 'unauthorized'
          ? t('unauthorized')
          : t('failed', { message: error.message ?? '' })
      return {
        value: error.code === 'missing-key' ? t('unconfiguredShort') : t('errorShort'),
        detail,
        healthy: false,
      }
    }

    const TEXT = {
      title: { fontSize: 14, fontWeight: 400, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
      detail: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      value: {
        fontSize: 14,
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      refresh: {
        flex: 'none',
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        font: 'inherit',
        fontSize: 14,
        lineHeight: '22px',
        cursor: 'pointer',
      },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        height: 28,
        padding: '0 10px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        cursor: 'pointer',
      },
    }

    /**
     * Settings → General row: title, state detail, and a refresh control.
     * @param props - composed slot props (locale seat plus the injected store).
     * @returns the row element tree.
     */
    function BalanceRow({ t, bal }) {
      const state = useBalance(bal)
      const view = describe(state, t)
      const pending = state.phase === 'loading'
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '16px 0',
          borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        },
      },
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 24 } },
        h('div', { style: TEXT.title }, t('title')),
        h('div', { style: TEXT.detail, title: view.detail }, view.detail)),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flex: 'none' } },
        h('span', {
          style: {
            ...TEXT.value,
            color: view.healthy ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
          },
        }, pending ? '…' : view.value),
        h('button', {
          type: 'button',
          style: { ...TEXT.refresh, opacity: pending ? 0.5 : 1 },
          title: t('refresh'),
          'aria-label': t('refresh'),
          disabled: pending,
          onClick: () => { void bal.refresh() },
          onMouseEnter: event => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' },
          onMouseLeave: event => { event.currentTarget.style.background = 'transparent' },
        }, '↻')))
    }

    /**
     * Sidebar footer pill: the glanceable balance; one click re-reads it.
     * @param props - composed slot props (`wide` owner share plus locale and store).
     * @returns the pill element tree.
     */
    function BalancePill({ t, bal, wide }) {
      const state = useBalance(bal)
      const view = describe(state, t)
      const wallet = primaryWallet(state.data)
      const label = wide
        ? (state.data?.ok === true ? view.value : view.value)
        : (wallet === undefined ? '¥' : (SYMBOLS[wallet.currency] ?? '¥'))
      const tooltip = `${t('title')} · ${view.value} — ${view.detail}`
      return h('button', {
        type: 'button',
        style: {
          ...TEXT.pill,
          padding: wide ? '0 10px' : 0,
          width: wide ? undefined : 28,
          justifyContent: 'center',
          color: view.healthy ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        },
        title: tooltip,
        'aria-label': tooltip,
        onClick: () => { void bal.refresh() },
        onMouseEnter: event => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' },
        onMouseLeave: event => { event.currentTarget.style.background = 'transparent' },
      }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-balance: dictionaries')
        const store = createStore(async () => {
          const response = await fetch(ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        })
        const bal = {
          get: store.get,
          subscribe: store.subscribe,
          refresh: store.refresh,
        }
        ctx.effect(() => {
          void store.refresh()
          const timer = setInterval(() => { void store.refresh() }, POLL_MS)
          const onVisibility = () => {
            if (document.visibilityState === 'visible') void store.refresh()
          }
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }, 'dsh-balance: balance polling')
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'deepseek-balance',
          order: 20,
          locale: NS,
          inject: () => ({ bal }),
        }, BalanceRow))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'deepseek-balance',
          order: 10,
          locale: NS,
          inject: () => ({ bal }),
        }, BalancePill))
      },
    }
  },
})
