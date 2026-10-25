/**
 * Browser half of `@local/dsh-balance`: a sidebar balance pill and a General
 * settings row, both polling the authenticated Host state route. The row also
 * stores or clears the API key through the Host, so the key never enters the
 * page or the plugin bundle.
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
    /** Host routes relative to the page origin, behind Connection's authentication. */
    const ROUTE = '/api/deepseek-balance/state'
    const KEY_ROUTE = '/api/deepseek-balance/key'
    const SYSMON_ROUTE = '/api/deepseek-balance/sysmon'
    const USAGE_ROUTE = '/api/deepseek-balance/usage'
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
      missingKey: '未配置 API key：点下面的「设置 key」直接粘贴保存',
      unauthorized: 'API key 无效、已删除或已过期',
      failed: '查询失败：{message}',
      empty: '账户没有钱包记录',
      unconfiguredShort: '未配置',
      errorShort: '查询失败',
      setKey: '设置 key',
      changeKey: '更换 key',
      clearKey: '清除',
      confirmClear: '确认清除？',
      cancel: '取消',
      save: '保存',
      saving: '校验中…',
      keyPlaceholder: 'sk-...（只会写进这台机器的 key 文件）',
      keyHint: '保存前会先查一次余额校验；文件写入 {path}，权限 600。',
      invalidKey: 'key 格式不对，应该是 sk- 开头',
      keySaved: '已保存',
      keyCleared: '已清除',
      sourceConfig: '插件配置',
      sourceEnv: '环境变量',
      sourceWarning: '当前 key 来自{source}，文件里的设置不生效',
      keyTailLabel: '当前 key …{tail}',
      sysTitle: '系统状态',
      sysCpu: 'CPU {pct}%',
      sysCores: '{n} 核',
      sysLoad: '负载 {l1} {l5} {l15}',
      sysDisk: '{mount} {used} / {total}（已用 {pct}%）',
      sysUnavailable: '系统信息不可用',
      sysMem: '内存 {used} / {total}（已用 {pct}%）',
      sysIo: '磁盘读 {read} · 写 {write} · 网络 ↓{rx} ↑{tx}',
      sysDetails: '详情',
      sysCollapse: '收起',
      sysCpuShort: 'CPU',
      sysMemShort: '内存',
      sysWriteShort: '磁盘写',
      sysNetShort: '网络↓',
      sysTrendEmpty: '采样点还不够画趋势',
      sysPill: 'CPU {cpu}% · 磁盘 {disk}%',
      spendTitle: '消耗',
      spendToday: '今日 {cny}',
      spendHit: '缓存命中 {pct}%',
      spendPeak: '高峰（双倍计价）',
      spendOffPeak: '平峰（半价）',
      spendCalls: '{n} 次调用 · {n2} 个会话',
      spendEmpty: '还没有用量记录（自本次启动起、按自然日统计）',
      spendModel: '{model}  命中 {hit} · 未命中 {miss} · 输出 {out}  {cny}',
      spendRecent: '近 7 天 {cny}',
      spendDay: '{day}  {cny}  {n} 次',
      spendSessionRow: '{label}  {cny}  {n} 次',
      spendUnnamed: '（未命名会话）',
    }

    const en = {
      title: 'DeepSeek API balance',
      refresh: 'Refresh',
      loading: 'Checking…',
      updated: 'Updated {time}',
      poll: 'Refreshes every 30s',
      granted: '+{amount} granted',
      toppedUp: '{amount} topped up',
      missingKey: 'No API key yet — use "Set key" below to paste one',
      unauthorized: 'API key is invalid, deleted, or expired',
      failed: 'Query failed: {message}',
      empty: 'No wallet on this account',
      unconfiguredShort: 'No key',
      errorShort: 'Unavailable',
      setKey: 'Set key',
      changeKey: 'Change key',
      clearKey: 'Clear',
      confirmClear: 'Confirm clear?',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Verifying…',
      keyPlaceholder: 'sk-... (stored on this machine only)',
      keyHint: 'The key is verified against the balance endpoint before saving, then written to {path} with mode 600.',
      invalidKey: 'Not a valid key: it should start with sk-',
      keySaved: 'Saved',
      keyCleared: 'Cleared',
      sourceConfig: 'the plugin config',
      sourceEnv: 'the environment',
      sourceWarning: 'The key comes from {source}, so the stored file is ignored',
      keyTailLabel: 'key …{tail}',
      sysTitle: 'System status',
      sysCpu: 'CPU {pct}%',
      sysCores: '{n} cores',
      sysLoad: 'load {l1} {l5} {l15}',
      sysDisk: '{mount} {used} / {total} ({pct}% used)',
      sysUnavailable: 'System information unavailable',
      sysMem: 'Memory {used} / {total} ({pct}% used)',
      sysIo: 'Disk {read} read · {write} write · net ↓{rx} ↑{tx}',
      sysDetails: 'Details',
      sysCollapse: 'Hide',
      sysCpuShort: 'CPU',
      sysMemShort: 'Memory',
      sysWriteShort: 'Disk write',
      sysNetShort: 'Net ↓',
      sysTrendEmpty: 'Not enough samples for a trend yet',
      sysPill: 'CPU {cpu}% · disk {disk}%',
      spendTitle: 'Spend',
      spendToday: 'today {cny}',
      spendHit: 'cache hit {pct}%',
      spendPeak: 'Peak hours (×2)',
      spendOffPeak: 'Off-peak (½ price)',
      spendCalls: '{n} calls · {n2} sessions',
      spendEmpty: 'No usage recorded yet (since this start, per calendar day)',
      spendModel: '{model}  hit {hit} · miss {miss} · out {out}  {cny}',
      spendRecent: 'last 7 days {cny}',
      spendDay: '{day}  {cny}  {n} calls',
      spendSessionRow: '{label}  {cny}  {n} calls',
      spendUnnamed: '(untitled session)',
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
        /** Adopt one Host state response (after a save or clear) without a second read. */
        replace(data) {
          publish({ phase: 'ready', data, transportError: undefined })
        },
      }
    }

    /**
     * Subscribe one component to the store.
     * @param store - balance store.
     * @returns the current state, re-rendering on every publish.
     */
    function useStoreState(store) {
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
        ? t('missingKey')
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
      link: {
        border: 'none',
        background: 'transparent',
        padding: 0,
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-state-business-primary)',
        cursor: 'pointer',
      },
      hint: {
        flexBasis: '100%',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      input: {
        flex: 1,
        minWidth: 160,
        height: 30,
        padding: '0 8px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
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

    /** One inline action link. */
    function ActionLink({ label, onClick, disabled }) {
      return h('button', {
        type: 'button',
        style: { ...TEXT.link, opacity: disabled ? 0.5 : 1 },
        disabled: disabled === true,
        onClick,
      }, label)
    }

    /**
     * Settings → General row: title, state detail, refresh, and the key editor.
     * @param props - composed slot props (locale seat plus the injected store).
     * @returns the row element tree.
     */
    function BalanceRow({ t, bal }) {
      const state = useStoreState(bal)
      const view = describe(state, t)
      const data = state.data
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [confirmClear, setConfirmClear] = React.useState(false)
      const pending = state.phase === 'loading'
      const configured = data?.configured === true
      const keyFile = data?.keyFile ?? '~/.config/deepseek/api_key'
      const busyNote = busy ? t('saving') : undefined

      /** Send one key write and adopt the returned state on success. */
      const send = async (body) => {
        setBusy(true)
        setError(undefined)
        setNotice(undefined)
        try {
          const response = await fetch(KEY_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const value = await response.json().catch(() => undefined)
          if (!response.ok || value?.ok !== true) {
            const code = value?.error?.code
            setError(code === 'invalid-key'
              ? t('invalidKey')
              : t('failed', { message: value?.error?.message ?? `HTTP ${response.status}` }))
            return false
          }
          bal.replace(value)
          return true
        } catch (failure) {
          setError(t('failed', { message: failure instanceof Error ? failure.message : String(failure) }))
          return false
        } finally {
          setBusy(false)
        }
      }

      const save = async () => {
        if (draft.trim() === '') {
          setError(t('invalidKey'))
          return
        }
        if (await send({ apiKey: draft.trim() })) {
          setEditing(false)
          setDraft('')
          setNotice(t('keySaved'))
        }
      }

      const clear = async () => {
        if (confirmClear !== true) {
          setConfirmClear(true)
          return
        }
        setConfirmClear(false)
        if (await send({ clear: true })) setNotice(t('keyCleared'))
      }

      const startEditing = () => {
        setEditing(true)
        setDraft('')
        setError(undefined)
        setNotice(undefined)
      }

      return h('div', {
        style: { padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 24 } },
          h('div', { style: TEXT.title }, t('title')),
          h('div', { style: TEXT.detail, title: view.detail }, view.detail)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flex: 'none' } },
          h('span', {
            style: {
              ...TEXT.value,
              color: view.healthy ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
            },
          }, pending && data === undefined ? '…' : view.value),
          h('button', {
            type: 'button',
            style: { ...TEXT.refresh, opacity: pending ? 0.5 : 1 },
            title: t('refresh'),
            'aria-label': t('refresh'),
            disabled: pending,
            onClick: () => { void bal.refresh() },
            onMouseEnter: event => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' },
            onMouseLeave: event => { event.currentTarget.style.background = 'transparent' },
          }, '↻'))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, flexWrap: 'wrap' } },
        h(ActionLink, { label: configured ? t('changeKey') : t('setKey'), onClick: startEditing, disabled: busy || editing }),
        configured ? h(ActionLink, { label: confirmClear ? t('confirmClear') : t('clearKey'), onClick: clear, disabled: busy }) : null,
        configured && typeof data.keyTail === 'string' && data.keyTail !== ''
          ? h('span', { style: { ...TEXT.detail, flex: 'none' } }, t('keyTailLabel', { tail: data.keyTail }))
          : null,
        notice !== undefined ? h('span', { style: { ...TEXT.detail, color: 'var(--dsw-alias-label-secondary)', flex: 'none' } }, notice) : null,
        busyNote !== undefined ? h('span', { style: { ...TEXT.detail, flex: 'none' } }, busyNote) : null,
        configured && data.source !== 'file'
          ? h('span', { style: { ...TEXT.detail, flex: 'none' } },
            t('sourceWarning', { source: data.source === 'config' ? t('sourceConfig') : t('sourceEnv') }))
          : null),
      error !== undefined
        ? h('div', { style: { ...TEXT.detail, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'normal', marginTop: 6 } }, error)
        : null,
      editing
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('input', {
            type: 'password',
            value: draft,
            placeholder: t('keyPlaceholder'),
            autoComplete: 'off',
            spellCheck: false,
            style: TEXT.input,
            onChange: event => { setDraft(event.target.value) },
            onKeyDown: event => {
              if (event.key === 'Enter') void save()
              if (event.key === 'Escape') { setEditing(false); setDraft(''); setError(undefined) }
            },
          }),
          h('button', {
            type: 'button',
            style: {
              ...TEXT.input,
              flex: 'none',
              width: 'auto',
              padding: '0 14px',
              background: 'var(--dsw-alias-bg-module-platform)',
              cursor: 'pointer',
            },
            disabled: busy,
            onClick: () => { void save() },
          }, busy ? t('saving') : t('save')),
          h(ActionLink, {
            label: t('cancel'),
            disabled: busy,
            onClick: () => { setEditing(false); setDraft(''); setError(undefined) },
          }),
          h('div', { style: TEXT.hint }, t('keyHint', { path: keyFile })))
        : null)
    }

    /**
     * Sidebar footer pill: the glanceable balance; one click re-reads it.
     * @param props - composed slot props (`wide` owner share plus locale and store).
     * @returns the pill element tree.
     */
    function BalancePill({ t, bal, wide }) {
      const state = useStoreState(bal)
      const view = describe(state, t)
      const wallet = primaryWallet(state.data)
      const label = wide
        ? view.value
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


    /** Format a percentage for display, tolerating a missing sample. */
    function pctText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '—'
    }

    /** The filesystem a summary should feature: root, else the largest. */
    function primaryDisk(disks) {
      if (!Array.isArray(disks)) return undefined
      return disks.find(disk => disk.mount === '/') ?? disks[0]
    }

    /** Height of one sparkline, in SVG units. */
    const CHART_HEIGHT = 28

    /**
     * Project one series into an SVG polyline, oldest sample on the left.
     * @param values - series, possibly containing nulls before the first delta.
     * @param ceiling - fixed upper bound (percent charts), or undefined to scale.
     * @returns the polyline `points`, empty when the series has no numbers.
     */
    function sparkPoints(values, ceiling) {
      const clean = values.filter(value => typeof value === 'number' && Number.isFinite(value))
      if (clean.length === 0) return ''
      const max = ceiling ?? Math.max(...clean, 1)
      const step = clean.length === 1 ? 0 : 100 / (clean.length - 1)
      return clean.map((value, index) => {
        const x = (index * step).toFixed(2)
        const y = (CHART_HEIGHT - Math.min(1, value / (max || 1)) * CHART_HEIGHT).toFixed(2)
        return `${x},${y}`
      }).join(' ')
    }

    /**
     * One labelled mini chart for a sampled series.
     * @param props - label, current text, series, and optional fixed ceiling.
     * @returns the chart element tree.
     */
    function MetricSpark({ label, value, values, ceiling }) {
      const points = sparkPoints(values, ceiling)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('div', {
          style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, lineHeight: '18px' },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, label),
        h('span', {
          style: {
            color: 'var(--dsw-alias-label-primary)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          },
        }, value)),
        points === ''
          ? h('div', { style: { ...TEXT.hint, fontSize: 11 } }, '—')
          : h('svg', {
            viewBox: `0 0 100 ${CHART_HEIGHT}`,
            preserveAspectRatio: 'none',
            style: { display: 'block', width: '100%', height: CHART_HEIGHT },
            'aria-hidden': true,
          }, h('polyline', {
            points,
            fill: 'none',
            stroke: 'var(--dsw-alias-state-business-primary)',
            strokeWidth: 1.5,
            vectorEffect: 'non-scaling-stroke',
          })))
    }

    /**
     * Settings → General row for CPU, memory, I/O, and disk usage, with an
     * expandable table plus trend charts.
     * @param props - composed slot props (locale seat plus the injected store).
     * @returns the row element tree.
     */
    function SysmonRow({ t, sys }) {
      const state = useStoreState(sys)
      const [open, setOpen] = React.useState(false)
      const data = state.data
      const pending = state.phase === 'loading'
      const healthy = data !== undefined && data.ok === true
      const cpu = healthy ? data.cpu : undefined
      const memory = healthy ? data.memory : undefined
      const io = healthy ? data.io : undefined
      const net = healthy ? data.net : undefined
      const disks = healthy && Array.isArray(data.disks) ? data.disks : []
      const history = healthy && Array.isArray(data.history) ? data.history : []
      const featured = primaryDisk(disks)
      const series = (key) => history.map(entry => entry[key])
      const lines = []
      if (data === undefined) {
        lines.push(state.phase === 'error'
          ? t('failed', { message: state.transportError ?? 'route' })
          : t('loading'))
      } else if (!healthy) {
        lines.push(data.error?.code === 'sampling-failed'
          ? t('failed', { message: data.error.message })
          : t('sysUnavailable'))
      } else {
        lines.push([
          t('sysCpu', { pct: pctText(cpu?.usagePct).replace('%', '') }),
          t('sysCores', { n: cpu?.cores ?? '—' }),
          t('sysLoad', { l1: cpu?.load1 ?? '—', l5: cpu?.load5 ?? '—', l15: cpu?.load15 ?? '—' }),
        ].join(' · '))
        for (const disk of disks.slice(0, open ? disks.length : 1)) {
          lines.push(t('sysDisk', {
            mount: disk.mount, used: disk.usedText, total: disk.totalText, pct: disk.usedPct,
          }))
        }
        if (memory !== undefined) {
          lines.push(t('sysMem', { used: memory.usedText, total: memory.totalText, pct: memory.usedPct }))
        }
      }
      const details = open && healthy
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 } },
          h('div', { style: { ...TEXT.detail, whiteSpace: 'normal' } }, t('sysIo', {
            read: io?.readText ?? '—',
            write: io?.writeText ?? '—',
            rx: net?.rxText ?? '—',
            tx: net?.txText ?? '—',
          })),
          history.length < 2
            ? h('div', { style: { ...TEXT.hint, flexBasis: 'auto' } }, t('sysTrendEmpty'))
            : h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' } },
              h(MetricSpark, {
                label: t('sysCpuShort'), ceiling: 100,
                value: pctText(cpu?.usagePct), values: series('cpu'),
              }),
              h(MetricSpark, {
                label: t('sysMemShort'), ceiling: 100,
                value: pctText(memory?.usedPct), values: series('mem'),
              }),
              h(MetricSpark, {
                label: t('sysWriteShort'),
                value: io?.writeText ?? '—', values: series('write'),
              }),
              h(MetricSpark, {
                label: t('sysNetShort'),
                value: net?.rxText ?? '—', values: series('rx'),
              })))
        : null
      return h('div', {
        style: { padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
      },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 24 } },
          h('div', { style: TEXT.title }, t('sysTitle')),
          ...lines.map((line, index) => h('div', {
            key: String(index),
            style: { ...TEXT.detail, whiteSpace: 'normal' },
            title: line,
          }, line)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 } },
            h(ActionLink, {
              label: open ? t('sysCollapse') : t('sysDetails'),
              onClick: () => { setOpen(value => !value) },
              disabled: !healthy,
            }))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flex: 'none' } },
          h('span', { style: { ...TEXT.value, color: 'var(--dsw-alias-label-tertiary)' } },
            featured === undefined ? '—' : pctText(featured.usedPct)),
          h('button', {
            type: 'button',
            style: { ...TEXT.refresh, opacity: pending ? 0.5 : 1 },
            title: t('refresh'),
            'aria-label': t('refresh'),
            disabled: pending,
            onClick: () => { void sys.refresh() },
            onMouseEnter: event => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' },
            onMouseLeave: event => { event.currentTarget.style.background = 'transparent' },
          }, '↻'))),
      details)
    }


    /**
     * Settings → General row for the money spent, folded from provider usage.
     * @param props - composed slot props (locale seat plus the injected store).
     * @returns the row element tree.
     */
    function SpendRow({ t, spend }) {
      const state = useStoreState(spend)
      const [open, setOpen] = React.useState(false)
      const data = state.data
      const pending = state.phase === 'loading'
      const healthy = data !== undefined && data.ok === true
      const totals = healthy ? data.totals : undefined
      const byModel = healthy && Array.isArray(data.byModel) ? data.byModel : []
      const lines = []
      if (data === undefined) {
        lines.push(state.phase === 'error'
          ? t('failed', { message: state.transportError ?? 'route' })
          : t('loading'))
      } else if (!healthy) {
        lines.push(t('sysUnavailable'))
      } else if (totals.calls === 0) {
        lines.push(t('spendEmpty'))
      } else {
        const parts = [t('spendToday', { cny: `¥${totals.cny.toFixed(2)}` })]
        if (totals.cacheHitPct !== null) parts.push(t('spendHit', { pct: totals.cacheHitPct }))
        lines.push(parts.join(' · '))
        const recent = Array.isArray(data.recent) ? data.recent : []
        const window = [
          data.peak ? t('spendPeak') : t('spendOffPeak'),
          t('spendCalls', { n: totals.calls, n2: totals.sessions }),
        ]
        if (recent.length > 1) window.push(t('spendRecent', { cny: `¥${(data.recentCny ?? 0).toFixed(2)}` }))
        lines.push(window.join(' · '))
      }
      const recent = healthy && Array.isArray(data.recent) ? data.recent : []
      const bySession = healthy && Array.isArray(data.bySession) ? data.bySession : []
      const details = open && healthy && totals.calls > 0
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } },
          ...byModel.map(row => h('div', {
            key: row.model,
            style: { ...TEXT.detail, whiteSpace: 'normal', fontVariantNumeric: 'tabular-nums' },
            title: row.model,
          }, t('spendModel', {
            model: row.model,
            hit: row.cacheReadText,
            miss: row.missText,
            out: row.outputText,
            cny: `¥${row.cny.toFixed(2)}`,
          }))),
          bySession.length === 0
            ? null
            : h('div', { style: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 } },
              ...bySession.map(row => h('div', {
                key: row.id,
                style: { ...TEXT.detail, whiteSpace: 'normal', fontVariantNumeric: 'tabular-nums' },
                title: `${row.id} · ${new Date(row.lastAt).toLocaleString()}`,
              }, t('spendSessionRow', {
                label: row.label === '' ? t('spendUnnamed') : row.label,
                cny: `¥${row.cny.toFixed(2)}`,
                n: row.calls,
              })))),
          recent.length < 2
            ? null
            : h('div', { style: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 } },
              ...recent.map(entry => h('div', {
                key: entry.day,
                style: { ...TEXT.detail, whiteSpace: 'normal', fontVariantNumeric: 'tabular-nums' },
              }, t('spendDay', { day: entry.day, cny: `¥${entry.cny.toFixed(2)}`, n: entry.calls })))))
        : null
      return h('div', {
        style: { padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
      },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 24 } },
          h('div', { style: TEXT.title }, t('spendTitle')),
          ...lines.map((line, index) => h('div', {
            key: String(index),
            style: { ...TEXT.detail, whiteSpace: 'normal' },
            title: line,
          }, line)),
          healthy && totals.calls > 0
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 } },
              h(ActionLink, {
                label: open ? t('sysCollapse') : t('sysDetails'),
                onClick: () => { setOpen(value => !value) },
              }))
            : null),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flex: 'none' } },
          h('span', { style: { ...TEXT.value, color: 'var(--dsw-alias-label-tertiary)' } },
            totals === undefined || totals.calls === 0 ? '—' : `¥${totals.cny.toFixed(2)}`),
          h('button', {
            type: 'button',
            style: { ...TEXT.refresh, opacity: pending ? 0.5 : 1 },
            title: t('refresh'),
            'aria-label': t('refresh'),
            disabled: pending,
            onClick: () => { void spend.refresh() },
            onMouseEnter: event => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' },
            onMouseLeave: event => { event.currentTarget.style.background = 'transparent' },
          }, '↻'))),
      details)
    }

    /**
     * Sidebar footer pill for CPU usage; hidden on the collapsed rail, where the
     * balance symbol already owns the tight space.
     * @param props - composed slot props (`wide` owner share plus locale and store).
     * @returns the pill element tree, or null on the rail.
     */
    function SysmonPill({ t, sys, wide }) {
      const state = useStoreState(sys)
      if (wide !== true) return null
      const data = state.data
      const healthy = data !== undefined && data.ok === true
      const cpu = healthy ? data.cpu : undefined
      const featured = healthy ? primaryDisk(data.disks) : undefined
      const label = t('sysPill', {
        cpu: pctText(cpu?.usagePct).replace('%', ''),
        disk: featured === undefined ? '—' : String(featured.usedPct),
      })
      const tooltip = featured === undefined
        ? `${t('sysTitle')} · ${label}`
        : `${t('sysTitle')} · ${label} · ${t('sysDisk', {
          mount: featured.mount, used: featured.usedText, total: featured.totalText, pct: featured.usedPct,
        })}`
      return h('button', {
        type: 'button',
        style: { ...TEXT.pill, color: 'var(--dsw-alias-label-tertiary)' },
        title: tooltip,
        'aria-label': tooltip,
        onClick: () => { void sys.refresh() },
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
          replace: store.replace,
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
        const sysmonStore = createStore(async () => {
          const response = await fetch(SYSMON_ROUTE, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        })
        const sys = {
          get: sysmonStore.get,
          subscribe: sysmonStore.subscribe,
          refresh: sysmonStore.refresh,
        }
        ctx.effect(() => {
          void sysmonStore.refresh()
          const timer = setInterval(() => { void sysmonStore.refresh() }, 10_000)
          const onVisibility = () => {
            if (document.visibilityState === 'visible') void sysmonStore.refresh()
          }
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }, 'dsh-balance: system polling')
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'system-status',
          order: 30,
          locale: NS,
          inject: () => ({ sys }),
        }, SysmonRow))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'system-status',
          order: 20,
          locale: NS,
          inject: () => ({ sys }),
        }, SysmonPill))
        const usageStore = createStore(async () => {
          const response = await fetch(USAGE_ROUTE, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        })
        const spend = {
          get: usageStore.get,
          subscribe: usageStore.subscribe,
          refresh: usageStore.refresh,
        }
        ctx.effect(() => {
          void usageStore.refresh()
          const timer = setInterval(() => { void usageStore.refresh() }, 30_000)
          const onVisibility = () => {
            if (document.visibilityState === 'visible') void usageStore.refresh()
          }
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisibility)
          }
        }, 'dsh-balance: usage polling')
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'deepseek-spend',
          order: 25,
          locale: NS,
          inject: () => ({ spend }),
        }, SpendRow))
      },
    }
  },
})
