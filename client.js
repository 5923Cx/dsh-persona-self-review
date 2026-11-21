/**
 * dsh-persona-self-review — 浏览器半。
 *
 * 侧栏一个入口，主面板三页签：角色卡 / 自我审视 / 设置。
 * 另挂一个 shell.overlay 提醒，负责自动审视触发与延迟替换的提示。
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-self-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/persona-card'
    let appCtx = null

    const tone = {
      text: 'var(--dsw-alias-text-primary, #1b1b1f)',
      sub: 'var(--dsw-alias-text-secondary, #5c6068)',
      line: 'var(--dsw-alias-border-subtle, rgba(0,0,0,.12))',
      bg: 'var(--dsw-alias-bg-primary, #fff)',
      bg2: 'var(--dsw-alias-bg-secondary, #f5f6f8)',
      accent: 'var(--dsw-alias-text-link, #247bbf)',
      danger: '#c0392b',
      warn: '#b26b00',
    }

    async function api(path, options = {}) {
      const init = { method: options.method ?? 'GET', headers: { 'x-persona-card': '1' } }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(API + path, init)
      const text = await response.text()
      let value = {}
      try { value = text ? JSON.parse(text) : {} } catch { value = { error: text } }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      return value
    }

    /** 路径默认打码用户名，避免截图或共享时泄露。 */
    function maskPath(path) {
      const value = String(path ?? '')
      if (!value) return value
      return value
        .replace(/^([A-Za-z]:\\Users\\)[^\\]+/i, '$1***')
        .replace(/^([A-Za-z]:\\Documents and Settings\\)[^\\]+/i, '$1***')
        .replace(/^\/(?:home|Users)\/[^/]+/i, match => match.replace(/[^/]+$/, '***'))
    }

    function fmtTime(ms) {      if (!ms) return '—'
      const d = new Date(ms)
      const pad = n => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function useRemote(interval = 3000) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const load = React.useCallback(async () => {
        try {
          const next = await api('/api/state')
          setState(next)
          setError('')
        } catch (err) {
          setError(String(err.message ?? err))
        }
      }, [])
      React.useEffect(() => {
        let alive = true
        load()
        const timer = setInterval(() => { if (alive) load() }, interval)
        return () => { alive = false; clearInterval(timer) }
      }, [load, interval])
      return { state, error, reload: load }
    }

    const btn = (label, onClick, opts = {}) => h('button', {
      onClick,
      disabled: opts.disabled === true,
      style: {
        padding: '6px 14px', borderRadius: 8, cursor: opts.disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${opts.primary ? tone.accent : tone.line}`,
        background: opts.primary ? tone.accent : tone.bg,
        color: opts.primary ? '#fff' : tone.text,
        fontSize: 13, opacity: opts.disabled ? 0.5 : 1,
      },
    }, label)

    const label = text => h('div', { style: { fontSize: 12, color: tone.sub, marginBottom: 4 } }, text)

    const input = props => h('input', {
      ...props,
      style: {
        width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontSize: 13,
        borderRadius: 8, border: `1px solid ${tone.line}`, background: tone.bg, color: tone.text,
        caretColor: 'var(--dsw-alias-text-primary, #1b1b1f)',
        ...(props.style ?? {}),
      },
    })

    const area = props => h('textarea', {
      ...props,
      style: {
        width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 13,
        lineHeight: 1.6, borderRadius: 10, border: `1px solid ${tone.line}`,
        background: tone.bg, color: tone.text, resize: 'vertical', fontFamily: 'inherit',
        caretColor: 'var(--dsw-alias-text-primary, #1b1b1f)',
        ...(props.style ?? {}),
      },
    })

    function Icon() {
      const { state } = useRemote(5000)
      const alert = Boolean(state && (state.pending || state.delayedApply || state.missedAt))
      return h('span', { style: { position: 'relative', display: 'inline-flex' } },
        h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('circle', { cx: 12, cy: 13, r: 3.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M8 8h8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })),
        alert ? h('span', {
          style: {
            position: 'absolute', top: -2, right: -2, width: 8, height: 8, borderRadius: 4,
            background: '#e74c3c', boxShadow: '0 0 0 2px var(--dsw-alias-bg-primary, #fff)',
          },
        }) : null)
    }

    function TabButton({ active, children, onClick }) {
      return h('button', {
        onClick,
        style: {
          padding: '7px 14px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
          border: `1px solid ${active ? tone.accent : 'transparent'}`,
          background: active ? tone.bg2 : 'transparent',
          color: active ? tone.text : tone.sub,
        },
      }, children)
    }

    function CardTab({ state, reload }) {
      const [draft, setDraft] = React.useState(state?.card ?? '')
      const [backups, setBackups] = React.useState([])
      const [message, setMessage] = React.useState('')
      const [dirty, setDirty] = React.useState(false)
      const [newName, setNewName] = React.useState('')
      const [pendingSwitch, setPendingSwitch] = React.useState(null)
      const [pendingDelete, setPendingDelete] = React.useState(null)
      const readonly = state?.readonly === true

      React.useEffect(() => {
        if (!dirty) setDraft(state?.card ?? '')
      }, [state?.card, state?.activeId, dirty])

      React.useEffect(() => {
        api('/api/backups').then(v => setBackups(v.backups ?? [])).catch(() => {})
      }, [state?.version, state?.activeId])

      const save = async () => {
        if (readonly) { setMessage('「系统默认」不可保存'); return }
        try {
          const result = await api('/api/card', { method: 'POST', body: { text: draft } })
          setMessage(result.ok ? `已保存为 ${result.displayVersion ?? 'v' + result.version}` : `保存失败：${result.code}`)
          setDirty(false)
          reload()
        } catch (err) { setMessage(String(err.message ?? err)) }
      }
      const restore = async name => {
        if (!name) return
        try {
          const result = await api('/api/restore', { method: 'POST', body: { name } })
          setMessage(result.ok ? `已恢复 ${name}` : `恢复失败：${result.code}`)
          setDirty(false)
          reload()
        } catch (err) { setMessage(String(err.message ?? err)) }
      }
      const switchTo = async id => {
        if (!id || id === state?.activeId) return
        await api('/api/cards/switch', { method: 'POST', body: { id } })
        setDirty(false)
        reload()
      }
      const createCard = async () => {
        const name = newName.trim()
        if (!name) { setMessage('先给新角色卡起个名字'); return }
        try {
          const result = await api('/api/cards/create', { method: 'POST', body: { name } })
          if (result.ok) {
            await api('/api/cards/switch', { method: 'POST', body: { id: result.card.id } })
            setNewName('')
            setMessage(`已创建「${result.card.id}-${result.card.name}」并切换过去`)
            setDirty(false)
            reload()
          }
        } catch (err) { setMessage(String(err.message ?? err)) }
      }

      const deleteActive = async () => {
        const id = state?.activeId
        if (!id) return
        try {
          const result = await api('/api/cards/delete', { method: 'POST', body: { id } })
          setMessage(result.ok ? '已删除当前角色卡' : `删除失败：${result.code}`)
          setPendingDelete(null)
          setDirty(false)
          reload()
        } catch (err) { setMessage(String(err.message ?? err)) }
      }

      return h('div', { style: { display: 'grid', gap: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('select', {
            value: state?.activeId ?? '',
            onChange: e => setPendingSwitch(e.target.value),
            style: { fontSize: 13, padding: '6px 10px', borderRadius: 8, border: `1px solid ${tone.line}`, background: tone.bg, color: tone.text, minWidth: 140 },
          }, (state?.cards ?? []).map(card => h('option', { key: card.id, value: card.id }, `${card.id}-${card.name}`))),
          h('input', {
            value: newName, placeholder: '新角色卡名称', onChange: e => setNewName(e.target.value),
            style: { fontSize: 13, padding: '6px 10px', borderRadius: 8, border: `1px solid ${tone.line}`, background: tone.bg, color: tone.text, width: 160 },
          }),
          btn('新建角色卡', createCard),
          btn('删除当前卡', () => setPendingDelete(state?.activeId ?? ''), { disabled: readonly }),
          h('div', { style: { flex: 1 } }),
          h('select', {
            onChange: e => restore(e.target.value),
            defaultValue: '',
            disabled: readonly,
            style: { fontSize: 12, padding: '5px 8px', borderRadius: 8, border: `1px solid ${tone.line}`, background: tone.bg, color: tone.text, opacity: readonly ? 0.5 : 1 },
          }, [h('option', { key: '', value: '' }, '从备份恢复…'), ...backups.map(name => h('option', { key: name, value: name }, name))])),
        h('div', { style: { fontSize: 12, color: tone.sub } },
          `${state?.activeId ?? '—'}-${state?.activeName ?? '—'} · ${state?.displayVersion ?? '—'} · 最后更新 ${fmtTime(state?.lastApplied?.at)}`),
        area({
          value: draft,
          onChange: e => { if (readonly) return; setDraft(e.target.value); setDirty(true) },
          readOnly: readonly,
          style: { minHeight: 380, opacity: readonly ? 0.7 : 1 },
          spellCheck: false,
        }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          btn('保存角色卡', save, { primary: true, disabled: readonly }),
          dirty ? btn('放弃修改', () => { setDraft(state?.card ?? ''); setDirty(false) }) : null,
          readonly ? h('span', { style: { fontSize: 12, color: tone.warn } }, '「系统默认」不可编辑、不可保存；切到其它角色卡才能修改。') : null,
          message ? h('span', { style: { fontSize: 12, color: tone.sub } }, message) : null),
        h('div', { style: { fontSize: 12, color: tone.sub } },
          '提示：保存会同时取消尚未生效的延迟替换。'),
        pendingSwitch ? h('div', {
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 20002, display: 'flex', alignItems: 'center', justifyContent: 'center' },
        }, h('div', {
          style: { width: 380, background: tone.bg, color: tone.text, borderRadius: 12, padding: 18, display: 'grid', gap: 12, border: `1px solid ${tone.line}` },
        },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, `切换到「${pendingSwitch}-${(state?.cards ?? []).find(card => card.id === pendingSwitch)?.name ?? pendingSwitch}」？`),
          h('div', { style: { fontSize: 12, color: tone.sub, lineHeight: 1.7 } },
            state?.settings?.onlyNewSessions
              ? '当前开启了「仅在新会话应用」：已存在的会话保持原人格，新会话才使用这张卡。'
              : (state?.settings?.autoInjectOnSwitch !== true
                ? '当前关闭了「切换后自动注入旧会话」：已存在的会话保持原人格，新会话才使用这张卡。'
                : '切换后，所有活跃会话会在下一轮使用这张卡的人设。')),
          h('div', { style: { fontSize: 12, color: tone.sub, lineHeight: 1.7 } },
            '注意：不同角色共用同一份记忆，切换后容易把上一位的经历带进来；建议在角色卡里写清边界与“不适用”的设定。'),
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            btn('取消', () => setPendingSwitch(null)),
            btn('切换', async () => {
              const id = pendingSwitch
              setPendingSwitch(null)
              await switchTo(id)
            }, { primary: true })))) : null,
        pendingDelete ? h('div', {
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 20002, display: 'flex', alignItems: 'center', justifyContent: 'center' },
        }, h('div', {
          style: { width: 380, background: tone.bg, color: tone.text, borderRadius: 12, padding: 18, display: 'grid', gap: 12, border: `1px solid ${tone.line}` },
        },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, `删除「${state?.activeId}-${state?.activeName}」？`),
          h('div', { style: { fontSize: 12, color: tone.sub, lineHeight: 1.7 } }, '卡片正文与版本记录会被删除（已有备份不受影响）。系统默认卡不能删；删掉的编号会被新卡复用。'),
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            btn('取消', () => setPendingDelete(null)),
            btn('删除', deleteActive, { primary: true })))) : null)
    }

    function ReviewTab({ state, reload }) {
      const [draft, setDraft] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        setDraft(state?.pending?.text ?? '')
      }, [state?.pending?.createdAt])

      const startReview = async () => {
        setBusy(true)
        setMessage('正在打开审视会话…')
        try {
          const prompt = await api('/api/prompt')
          const ws = appCtx?.get?.('uiWorkspace')
          if (!ws || typeof ws.startSession !== 'function') throw new Error('找不到 uiWorkspace 服务')
          ws.startSession(undefined, { agentPreset: 'standard', prompt: prompt.prompt })
          await api('/api/review-started', { method: 'POST', body: { mode: 'manual' } })
          setMessage('已在新的会话里开始自我审视；结果会出现在下方文本框。')
          reload()
        } catch (err) { setMessage(String(err.message ?? err)) }
        finally { setBusy(false) }
      }

      const replace = async () => {
        try {
          const result = await api('/api/replace', { method: 'POST', body: { text: draft } })
          setMessage(result.ok ? `已替换为 v${result.version}` : `未替换：${result.code}`)
          setDraft('')
          reload()
        } catch (err) { setMessage(String(err.message ?? err)) }
      }

      const validation = state?.pending?.validation
      const delayed = state?.delayedApply
      const statusLine = delayed
        ? `将在 ${fmtTime(delayed.applyAt)} 应用 v${delayed.version}`
        : state?.missedAt
          ? `本轮自我审视已错过（${fmtTime(state.missedAt)}），不会补跑。`
          : validation
            ? (validation.ok
              ? `校验通过（改动 ${validation.delta} 字符）`
              : `未通过校验：${validation.code}${validation.warnings?.length ? ' / ' + validation.warnings.join(', ') : ''}`)
            : '暂无审视结果。'

      return h('div', { style: { display: 'grid', gap: 10 } },
        h('div', { style: { fontSize: 12, color: validation && !validation.ok ? tone.warn : tone.sub } }, statusLine),
        area({
          value: draft,
          onChange: e => setDraft(e.target.value),
          placeholder: '审视结果会出现在这里；没有结果时为空。',
          style: { minHeight: 300 },
          spellCheck: false,
        }),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          btn('整理', startReview, { primary: true, disabled: busy || state?.readonly === true }),
          btn('替换', replace, { disabled: !draft.trim() }),
          btn('清空', async () => {
            const result = await api('/api/clear', { method: 'POST' })
            setDraft(''); setMessage(result.ok ? '已清空' : '清空失败'); reload()
          }),
          delayed ? btn('立即应用', async () => {
            const result = await api('/api/apply-now', { method: 'POST' })
            setMessage(result.ok ? `已应用 v${result.version}` : `应用失败：${result.code}`)
            reload()
          }) : null,
          delayed ? btn('取消延迟', async () => {
            await api('/api/cancel-delayed', { method: 'POST' })
            setMessage('已取消延迟替换'); reload()
          }) : null),
        message ? h('div', { style: { fontSize: 12, color: tone.sub } }, message) : null)
    }

    function SettingsTab({ state, reload }) {
      const initial = state?.settings ?? {}
      const [form, setForm] = React.useState(initial)
      const [message, setMessage] = React.useState('')
      const [stats, setStats] = React.useState(null)
      // 用序列化后的值做依赖，避免每 3 秒轮询都把未保存的勾选重置回去。
      const settingsKey = JSON.stringify(state?.settings ?? {})
      React.useEffect(() => { setForm(state?.settings ?? {}) }, [settingsKey])

      React.useEffect(() => {
        api('/api/backups').then(v => setStats(v.stats ?? null)).catch(() => {})
      }, [])

      const defaultPrompt = state?.defaultPrompt ?? ''
      const promptText = form.reviewPrompt && String(form.reviewPrompt).trim() ? form.reviewPrompt : defaultPrompt
      const resolvedDir = state?.backupDirResolved ?? ''
      const [revealPath, setRevealPath] = React.useState(false)
      const shownDir = revealPath ? resolvedDir : maskPath(resolvedDir)
      const formRef = React.useRef(form)
      formRef.current = form

      const persist = async next => {
        try {
          const settings = { ...next }
          const text = String(settings.reviewPrompt ?? '').trim()
          if (!text || text === defaultPrompt.trim()) settings.reviewPrompt = ''
          const result = await api('/api/settings', { method: 'POST', body: { settings } })
          setMessage(result.ok ? '已自动保存' : '保存失败')

          const labels = {
            autoInjectNewVersion: '新版本自动注入',
            autoInjectOnSwitch: '切换后自动注入旧会话',
            onlyNewSessions: '仅在新会话应用',
          }
          const previous = state?.settings ?? {}
          const changed = Object.keys(labels).filter(key => Boolean(settings[key]) !== Boolean(previous[key]))
          if (changed.length) {
            const report = changed.map(key => `已${settings[key] ? '开启' : '关闭'}「${labels[key]}」`).join('\n')
            await api('/api/notice', { method: 'POST', body: { text: report } })
          }
          reload()
        } catch (err) { setMessage(String(err.message ?? err)) }
      }

      const set = key => e => {
        const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value
        const next = { ...formRef.current, [key]: value }
        formRef.current = next
        setForm(next)
        if (e.target.type === 'checkbox') persist(next)
      }
      const blur = () => persist(formRef.current)

      const pickFolder = async () => {
        setMessage('正在打开文件夹选择器…')
        try {
          const result = await api('/api/pick-folder', { method: 'POST' })
          if (!result.path) { setMessage('没有选择文件夹'); return }
          const next = { ...formRef.current, backupDir: result.path }
          formRef.current = next
          setForm(next)
          await persist(next)
          setMessage(`已选择：${result.path}`)
        } catch (err) { setMessage(String(err.message ?? err)) }
      }

      const openFolder = async () => {
        try {
          const result = await api('/api/open-folder', { method: 'POST' })
          setMessage(result.ok ? `已打开：${result.path}` : `打开失败：${result.path}`)
        } catch (err) { setMessage(String(err.message ?? err)) }
      }

      return h('div', { style: { display: 'grid', gap: 12, maxWidth: 720 } },
        h('div', { style: { fontSize: 12, color: tone.sub } }, '修改后自动保存，不需要点按钮（文本/数字在离开输入框时保存）'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
          h('input', { type: 'checkbox', checked: form.reviewEnabled === true, onChange: set('reviewEnabled') }),
          '启用自动自我审视（默认关）'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
          h('input', { type: 'checkbox', checked: form.dailyVersionReset !== false, onChange: set('dailyVersionReset') }),
          '版本号每日重置（显示为「今日第几版」，存档文件名也用当日序号）'),
        h('div', { style: { fontSize: 12, color: tone.sub, marginTop: 4 } }, '角色卡生效范围'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
          h('input', { type: 'checkbox', checked: form.autoInjectNewVersion === true, onChange: set('autoInjectNewVersion') }),
          '新版本角色卡自动注入（正在使用该卡的活跃会话）'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
          h('input', { type: 'checkbox', checked: form.autoInjectOnSwitch === true, onChange: set('autoInjectOnSwitch') }),
          '切换角色卡后自动注入旧会话'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
          h('input', { type: 'checkbox', checked: form.onlyNewSessions !== false, onChange: set('onlyNewSessions') }),
          '仅在新会话应用角色卡变化（开启后上面两项不生效）'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
          h('div', null, label('审视间隔（天）'), input({ type: 'number', step: '0.5', min: '0.25', value: form.intervalDays ?? 1, onChange: set('intervalDays'), onBlur: blur })),
          h('div', null, label('延迟应用（小时，2–4）'), input({ type: 'number', step: '0.5', min: '2', max: '4', value: form.delayHours ?? 3, onChange: set('delayHours'), onBlur: blur })),
          h('div', null, label('错过宽限（小时）'), input({ type: 'number', step: '1', min: '0', value: form.graceHours ?? 6, onChange: set('graceHours'), onBlur: blur })),
          h('div', null, label('备份目录（留空 = Documents）'),
            input({ type: 'text', value: form.backupDir ?? '', onChange: set('backupDir'), onBlur: blur, placeholder: `示例：${shownDir}` }),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' } },
              btn('选择文件夹', pickFolder),
              btn('打开文件夹', openFolder),
              btn(revealPath ? '隐藏完整路径' : '显示完整路径', () => setRevealPath(!revealPath)),
              h('span', { style: { fontSize: 12, color: tone.sub, wordBreak: 'break-all' } }, `当前：${shownDir || '（默认 Documents）'}`),
              stats ? h('span', { style: { fontSize: 12, color: tone.sub } }, `备份：${stats.count} 个，${(stats.bytes / 1048576).toFixed(2)} MB`) : null),
            h('div', { style: { fontSize: 11, color: tone.sub } }, '路径里的用户名默认打码；只在本地显示，不会上传。'))),
        h('div', null, label('校验：最小改动字符数'), input({ type: 'number', min: '1', value: form.minDeltaChars ?? 8, onChange: set('minDeltaChars'), onBlur: blur })),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
          h('div', null, label('校验：最大改动比例（0–1）'), input({ type: 'number', step: '0.05', min: '0.05', max: '1', value: form.maxRatio ?? 0.25, onChange: set('maxRatio'), onBlur: blur })),
          h('div', null, label('校验：最大改动字符数'), input({ type: 'number', min: '20', value: form.maxChars ?? 400, onChange: set('maxChars'), onBlur: blur }))),
        h('div', null, label('自定义审视规则（留空 = 内置默认；下方显示的就是内置默认）'),
          area({ value: promptText, onChange: set('reviewPrompt'), onBlur: blur, style: { minHeight: 200 }, spellCheck: false })),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, color: tone.sub } }, `已整理 ${state?.reviewCount ?? 0} 次`),
          state?.missedAt ? h('span', { style: { fontSize: 12, color: tone.danger } }, `上一轮自我审视已错过：${fmtTime(state.missedAt)}`) : null,
          message ? h('span', { style: { fontSize: 12, color: tone.sub } }, message) : null))
    }

    // 会话 id 由 header 槽位提供；overlay 只负责渲染居中窗口。
    const gateStore = { sessionId: '', listeners: new Set() }
    function publishGateSession(sessionId) {
      if (!sessionId || gateStore.sessionId === sessionId) return
      gateStore.sessionId = sessionId
      for (const listener of gateStore.listeners) { try { listener(sessionId) } catch { /* ignore */ } }
    }

    function GateProbe(props) {
      const sessionId = props?.sessionId
      React.useEffect(() => {
        if (!sessionId) return
        publishGateSession(sessionId)
        api('/api/gate-ping', { method: 'POST', body: { sessionId } }).catch(() => {})
      }, [sessionId])
      return null
    }

    function MismatchGate() {
      const [sessionId, setSessionId] = React.useState(gateStore.sessionId)
      const [info, setInfo] = React.useState(null)
      const [dismissed, setDismissed] = React.useState('')
      const [lock, setLock] = React.useState(false)

      React.useEffect(() => {
        const listener = id => setSessionId(id)
        gateStore.listeners.add(listener)
        return () => { gateStore.listeners.delete(listener) }
      }, [])

      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const tick = async () => {
          try {
            const state = await api(`/api/session-state?sessionId=${encodeURIComponent(sessionId)}`)
            if (alive) setInfo(state)
          } catch { /* ignore */ }
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      // 打开设置、插件面板等其它窗口时不打扰：只要有一个侧边/主面板处于打开状态就静默。
      let panelOpen = false
      try {
        const layout = appCtx?.get?.('layout')
        panelOpen = Boolean(layout?.panelInfo?.getSnapshot?.().activePanelId)
      } catch { panelOpen = false }

      if (panelOpen) return null
      if (!sessionId || !info || !info.known || (!info.mismatchCard && !info.mismatchVersion)) return null
      // 勾了「仅在新会话应用角色卡变化」就视为已知且接受，不再弹窗。
      if (info.settings?.onlyNewSessions === true) return null
      const key = [info.sessionId, info.sessionCard, info.sessionVersion, info.activeId, info.activeVersion].join(':')
      if (dismissed === key) return null

      const apply = async () => {
        try { await api('/api/session-apply', { method: 'POST', body: { sessionId: info.sessionId } }) } catch { /* ignore */ }
        setDismissed(key)
      }
      const revert = async () => {
        if (!info.sessionCard) return
        try { await api('/api/cards/switch', { method: 'POST', body: { id: info.sessionCard } }) } catch { /* ignore */ }
        setDismissed(key)
      }
      const keep = () => setDismissed(key)
      const toggleLock = async e => {
        const next = e.target.checked
        setLock(next)
        try { await api('/api/settings', { method: 'POST', body: { settings: { onlyNewSessions: next } } }) } catch { /* ignore */ }
      }

      return h('div', {
        style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 20010, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      }, h('div', {
        style: { width: 420, background: tone.bg, color: tone.text, borderRadius: 12, padding: 18, display: 'grid', gap: 12, border: `1px solid ${tone.line}` },
      },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, '角色卡不匹配'),
        h('div', { style: { fontSize: 13, color: tone.sub, lineHeight: 1.75 } },
          info.mismatchCard
            ? `这个会话还在用「${info.sessionCard}${info.sessionCardName ? '-' + info.sessionCardName : ''}」，当前激活的是「${info.activeId}-${info.activeName}」。继续对话会重新注入一次人设，可能产生幻觉。`
            : `这个会话的人设版本（v${info.sessionVersion}）落后于当前卡（v${info.activeVersion}）。反复注入会浪费上下文长度。`),
        h('div', { style: { fontSize: 12, color: tone.sub } }, '注意：不同角色共用同一份记忆，切换后容易把上一位的经历带进来，建议在角色卡里写清边界。'),
        info.mismatchVersion
          ? h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: tone.sub } },
            h('input', { type: 'checkbox', checked: lock || info.settings?.onlyNewSessions === true, onChange: toggleLock }),
            '仅在新会话应用角色卡变化')
          : null,
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' } },
          info.mismatchCard && info.sessionCard ? btn('切换回原本角色', revert) : null,
          btn('否（先不改）', keep),
          btn('是（注入一次并继续）', apply, { primary: true }))))
    }

    function Panel() {
      const { state, error, reload } = useRemote(3000)
      const [tab, setTab] = React.useState('card')
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
          background: tone.bg, color: tone.text, padding: '14px 18px', gap: 12, boxSizing: 'border-box',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '角色卡 · 自我审视'),
          h('div', { style: { fontSize: 12, color: tone.sub } }, state?.displayVersion ?? `v${state?.version ?? '—'}`),
          h('div', { style: { flex: 1 } }),
          error ? h('div', { style: { fontSize: 12, color: tone.danger } }, error) : null),
        h('div', { style: { display: 'flex', gap: 6 } },
          h(TabButton, { active: tab === 'card', onClick: () => setTab('card') }, '角色卡'),
          h(TabButton, { active: tab === 'review', onClick: () => setTab('review') }, '自我审视'),
          h(TabButton, { active: tab === 'settings', onClick: () => setTab('settings') }, '设置')),
        h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 4 } },
          state === null
            ? h('div', { style: { fontSize: 13, color: tone.sub } }, '正在读取状态…')
            : tab === 'card'
              ? h(CardTab, { state, reload })
              : tab === 'review'
                ? h(ReviewTab, { state, reload })
                : h(SettingsTab, { state, reload })))
    }

    function Toast() {
      const { state, reload } = useRemote(5000)
      const [seen, setSeen] = React.useState(() => {
        try { return Number(localStorage.getItem('persona-card.seen') ?? 0) } catch { return 0 }
      })
      const dueKey = React.useRef('')

      React.useEffect(() => {
        if (!state) return
        const key = String(state.nextDueAt ?? '')
        if (!dueKey.current) dueKey.current = key
        if (key !== dueKey.current) dueKey.current = key
      }, [state?.nextDueAt])

      // 自动审视：到点且开着开关时，开一个审视会话。
      React.useEffect(() => {
        if (!state?.settings?.reviewEnabled) return
        if (state.readonly) return
        if (!state.due) return
        if (state.pending || state.delayedApply) return
        const key = `${state.nextDueAt}`
        let last = ''
        try { last = localStorage.getItem('persona-card.auto') ?? '' } catch { /* ignore */ }
        if (last === key) return
        try { localStorage.setItem('persona-card.auto', key) } catch { /* ignore */ }
        ;(async () => {
          try {
            const prompt = await api('/api/prompt')
            const ws = appCtx?.get?.('uiWorkspace')
            if (ws && typeof ws.startSession === 'function') {
              ws.startSession(undefined, { agentPreset: 'standard', prompt: prompt.prompt })
              await api('/api/review-started', { method: 'POST', body: { mode: 'auto' } })
              reload()
            }
          } catch { /* ignore */ }
        })()
      }, [state?.due, state?.nextDueAt, state?.settings?.reviewEnabled])

      const notice = state?.notice
      const [noticeSeen, setNoticeSeen] = React.useState(0)
      React.useEffect(() => { setNoticeSeen(0) }, [notice?.at])

      const reminder = state?.backupReminder
      const [reminderHidden, setReminderHidden] = React.useState(0)
      React.useEffect(() => { setReminderHidden(0) }, [reminder?.at])

      const stamp = Math.max(state?.pending?.createdAt ?? 0, state?.lastApplied?.at ?? 0)
      const fresh = stamp > seen
      const [dismissed, setDismissed] = React.useState(false)
      React.useEffect(() => { setDismissed(false) }, [stamp])

      if (notice && notice.at && notice.at !== noticeSeen) {
        return h('div', {
          style: {
            position: 'fixed', right: 16, bottom: 16, width: 340, zIndex: 20003,
            background: tone.bg, color: tone.text, border: `1px solid ${tone.line}`,
            borderRadius: 12, padding: 14, boxShadow: '0 12px 30px rgba(0,0,0,.18)',
            display: 'grid', gap: 8,
          },
        },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '设置已更新'),
          h('div', { style: { fontSize: 12, color: tone.sub, whiteSpace: 'pre-wrap', lineHeight: 1.7 } }, notice.text),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            btn('知道了', () => setNoticeSeen(notice.at), { primary: true })))
      }

      if (reminder && reminder.at && reminder.at !== reminderHidden) {
        const dismissReminder = async (mute) => {
          if (mute) {
            await api('/api/settings', { method: 'POST', body: { settings: { ...(state.settings ?? {}), backupReminderDisabled: true } } })
          }
          await api('/api/reminder-dismiss', { method: 'POST' })
          setReminderHidden(reminder.at)
          reload()
        }
        return h('div', {
          style: {
            position: 'fixed', right: 16, bottom: 16, width: 360, zIndex: 20001,
            background: tone.bg, color: tone.text, border: `1px solid ${tone.line}`,
            borderRadius: 12, padding: 14, boxShadow: '0 12px 30px rgba(0,0,0,.18)',
            display: 'grid', gap: 8,
          },
        },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, `已整理 ${reminder.count} 次`),
          h('div', { style: { fontSize: 12, color: tone.sub } },
            `备份目录：${reminder.files ?? 0} 个文件，占用 ${((reminder.bytes ?? 0) / 1048576).toFixed(2)} MB。建议手动清理一次。`),
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' } },
            btn('打开备份文件夹', async () => { try { await api('/api/open-folder', { method: 'POST' }) } catch { /* ignore */ } }),
            btn('不再提示', () => dismissReminder(true)),
            btn('知道了', () => dismissReminder(false), { primary: true })))
      }

      if (!fresh || dismissed || !state) return null

      const title = state.lastApplied?.at === stamp
        ? `角色卡已更新到 v${state.lastApplied.version}`
        : `自我审视有新结果`
      const detail = state.pending?.validation?.ok
        ? `校验通过，改动 ${state.pending.validation.delta} 字符`
        : state.pending?.validation
          ? `未通过校验：${state.pending.validation.code}（可手动决定是否替换）`
          : ''

      return h('div', {
        style: {
          position: 'fixed', right: 16, bottom: 16, width: 340, zIndex: 20000,
          background: tone.bg, color: tone.text, border: `1px solid ${tone.line}`,
          borderRadius: 12, padding: 14, boxShadow: '0 12px 30px rgba(0,0,0,.18)',
          display: 'grid', gap: 8,
        },
      },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, title),
        detail ? h('div', { style: { fontSize: 12, color: tone.sub } }, detail) : null,
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', {
            onClick: () => { setDismissed(true); try { localStorage.setItem('persona-card.seen', String(stamp)) } catch { /* ignore */ } },
            style: { padding: '5px 10px', fontSize: 12, borderRadius: 8, border: `1px solid ${tone.line}`, background: tone.bg, color: tone.text, cursor: 'pointer' },
          }, '知道了')))
    }

    return {
      name: 'persona-self-review',
      inject: ['slots'],
      apply(ctx) {
        appCtx = ctx
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') {
          console.error('[persona-card] slots 服务不可用，放弃注册')
          return
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'persona-card', order: 6,
          label: () => '角色卡',
        }, Icon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'persona-card',
        }, Panel))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'persona-card-toast', label: () => 'persona-card',
        }, Toast))

        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'persona-card-gate', order: 50,
          inject: sessionId => ({ sessionId }),
        }, GateProbe))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'persona-card-mismatch', label: () => 'persona-card mismatch',
        }, MismatchGate))
      },
    }
  },
})
