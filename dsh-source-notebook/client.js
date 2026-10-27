/*
 * Source Notebook — client half.
 *
 * The Sources list is a Conversation View: it is registered into
 * `conversation.view` beside Chat and Trajectory, so it appears as a third tab
 * at the top of the chat and renders as a full view when selected. It holds no
 * index and extracts nothing. Reads use the host's read-only HTTP endpoint and
 * mutations use `/source-notebook-*` commands, so opening the tab, switching
 * Sessions, or refreshing the status light never writes a command row into the
 * Trajectory. The host half owns the sources, so the view and the agent tools
 * can never disagree about what is in the notebook.
 *
 * A tab label is plain display text, so the "is the notebook loaded?" light is
 * carried by the label itself (a coloured status dot). Two invisible helpers
 * keep it truthful:
 *
 *   - a header bridge that re-reads the list when a Session opens and when the
 *     Conversation becomes active again (so sources the agent added mid-turn
 *     show up);
 *   - a tiny add form in the composer dock, rendered ONLY while the Session is
 *     blank. Blank Sessions hide the header (and therefore the tabs), so
 *     without this the first source could not be added from the UI at all.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-source-notebook',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LIST = '/source-notebook-list'
    const ADD = '/source-notebook-add'
    const REMOVE = '/source-notebook-remove'

    const NS = 'sourceNotebook'

    const STRINGS = {
      'tab.idle': '\ud83d\udd34 Sources',
      'tab.active': '\ud83d\udfe2 Sources \u00b7 {count}',
      sources: 'Sources',
      none: 'none yet',
      count: '{count} files',
      empty: 'No files are in the notebook yet. Add one below and the agent can search and cite it.',
      hint: 'Files the agent can search and cite. Add a path and the notebook indexes it.',
      placeholder: 'Path to a PDF, DOCX, PPTX, or text file',
      add: 'Add',
      working: 'Working\u2026',
      remove: 'Remove',
      noText: 'no text',
      'error.unavailable': 'The notebook is unavailable in this session.',
      'error.failed': 'The notebook could not complete that request.',
      'error.unreadable': 'The notebook returned an unreadable reply.',
    }

    /*
     * Count of indexed sources for the Session being looked at. Shared by the
     * view, the dock form and the tab-label projection; the tab label is only
     * re-projected when the slot registry changes, so `set` notifies and the
     * apply hook re-registers the view entry with the new label.
     */
    const status = {
      count: 0,
      known: false,
      listeners: new Set(),
      set(count) {
        const value = Number(count) || 0
        if (this.known && value === this.count) return
        this.count = value
        this.known = true
        for (const listener of Array.from(this.listeners)) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    /** Run one notebook command and return its decoded payload, or a failure. */
    const ask = async (run, t, line) => {
      let envelope
      try {
        envelope = await run(line)
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
      if (!envelope) return { ok: false, error: t('error.unavailable') }
      if (envelope.ok === false) return { ok: false, error: envelope.reason || t('error.failed') }
      // execute() answers { ok: true, value: { commandId, result } }; an
      // unresolved or unparsed line leaves value undefined.
      const payload = envelope.value
      if (!payload || !payload.result) return { ok: false, error: t('error.unavailable') }
      const result = payload.result
      if (result.kind !== 'success') {
        return { ok: false, error: result.text || t('error.failed') }
      }
      try {
        const value = JSON.parse(result.text)
        if (value && typeof value === 'object') return value
      } catch {
        /* fall through to the unreadable reply */
      }
      return { ok: false, error: t('error.unreadable') }
    }

    /**
     * One list request, without a Trajectory entry.
     *
     * The host serves this JSON over HTTP precisely because a slash command is
     * a conversation event: executing `/source-notebook-list` to paint a tab
     * left a `source-notebook-list` row behind every time a view mounted. The
     * command path stays only as a fallback for a host that has not restarted
     * onto the route yet, so the UI keeps working across an upgrade.
     */
    const readList = async (source) => {
      if (source && typeof source.read === 'function') {
        const listed = await source.read()
        if (listed) return listed
      }
      if (!source || typeof source.run !== 'function' || typeof source.t !== 'function') return null
      return ask(source.run, source.t, LIST)
    }

    /** The HTTP read itself; null means "use the command fallback". */
    const fetchList = async (sessionId) => {
      if (!sessionId || typeof fetch !== 'function') return null
      try {
        const path = '/source-notebook/sources?session=' + encodeURIComponent(sessionId)
        const response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!response.ok) return null
        const value = await response.json()
        return value && typeof value === 'object' && value.ok !== false ? value : null
      } catch {
        return null
      }
    }

    const size = (chars) => {
      const value = Number(chars) || 0
      if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M chars'
      if (value >= 1000) return Math.round(value / 1000) + 'k chars'
      return value + ' chars'
    }

    /** The Sources View: reached through the third tab at the top of the chat. */
    function SourcesView(props) {
      const t = props.t
      const run = props.run

      const [state, setState] = React.useState({ sources: [], error: '' })
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      /* The slot hands in fresh closures; keep them out of the effect deps so a
       * re-render cannot turn into another list request. */
      const latest = React.useRef(null)
      latest.current = { t, run, read: props.read }
      const shown = React.useRef(0)

      /* Adopt one authoritative list from the host and publish its length. */
      const adopt = React.useCallback((next) => {
        const sources = Array.isArray(next) ? next : []
        shown.current = sources.length
        setState({ sources, error: '' })
        status.set(sources.length)
      }, [])

      const fail = React.useCallback((error) => {
        setState((previous) => ({ sources: previous.sources, error: error || '' }))
      }, [])

      const refresh = React.useCallback(async () => {
        const listed = await readList(latest.current)
        if (listed && listed.ok) adopt(listed.sources)
        else fail((listed && listed.error) || '')
      }, [adopt, fail])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      /* Follow the other readers (the dock form, the header bridge), but skip
       * the notification this View's own adopt() just caused. */
      React.useEffect(() => {
        return status.subscribe(() => {
          if (status.count !== shown.current) refresh()
        })
      }, [refresh])

      const submit = async (event) => {
        if (event && event.preventDefault) event.preventDefault()
        const path = draft.trim()
        if (!path || busy) return
        setBusy(true)
        const reply = await ask(run, t, ADD + ' ' + path)
        setBusy(false)
        if (!reply || !reply.ok) {
          fail((reply && reply.error) || '')
          return
        }
        const added = reply.added
        const failed = added && added.ok === false
        const sources = Array.isArray(reply.sources) ? reply.sources : []
        shown.current = sources.length
        setDraft(failed ? draft : '')
        setState({ sources, error: failed ? String(added.error || '') : '' })
        status.set(sources.length)
      }

      const drop = async (source) => {
        if (busy) return
        setBusy(true)
        const reply = await ask(run, t, REMOVE + ' ' + source.id)
        setBusy(false)
        if (reply && reply.ok) adopt(reply.sources)
        else fail((reply && reply.error) || '')
      }

      const sources = state.sources || []
      const label = t('sources')

      const rows = sources.map((source) =>
        h(
          'li',
          { key: source.id, className: props.classes.item },
          h('span', { className: props.classes.name, title: source.path }, source.name),
          h(
            'span',
            { className: props.classes.fmt },
            (source.format || '').toUpperCase() + (source.chars ? ' \u00b7 ' + size(source.chars) : ''),
          ),
          source.indexed === false
            ? h(
                'span',
                { className: props.classes.warn, title: (source.warnings || []).join(' ') },
                t('noText'),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              onClick: () => drop(source),
              disabled: busy,
              'aria-label': t('remove') + ' ' + source.name,
              title: t('remove'),
              className: props.classes.remove,
            },
            '\u00d7',
          ),
        ),
      )

      return h(
        'section',
        { 'aria-label': label, className: props.classes.view },
        h(
          'div',
          { className: props.classes.head },
          h('h2', { className: props.classes.title }, label),
          h(
            'span',
            { className: props.classes.meta },
            sources.length > 0 ? t('count', { count: sources.length }) : t('none'),
          ),
        ),
        h('p', { className: props.classes.hint }, t('hint')),
        h(
          'form',
          { onSubmit: submit, className: props.classes.form },
          h('input', {
            type: 'text',
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            placeholder: t('placeholder'),
            'aria-label': t('placeholder'),
            disabled: busy,
            className: props.classes.input,
          }),
          h(
            'button',
            { type: 'submit', disabled: busy || !draft.trim(), className: props.classes.submit },
            busy ? t('working') : t('add'),
          ),
        ),
        state.error ? h('div', { role: 'alert', className: props.classes.error }, state.error) : null,
        sources.length > 0 ? h('ul', { className: props.classes.list }, rows) : h('p', { className: props.classes.empty }, t('empty')),
      )
    }

    /*
     * Invisible: the header (and with it the tab row) is the only place that
     * knows a Session has opened, so this reads the list once when it mounts
     * and again whenever the Conversation's activity set changes (a Turn
     * started or settled). That is what keeps the tab light honest when the
     * agent adds or drops a source itself. The read goes over HTTP, so all of
     * that is free: nothing lands in the Trajectory.
     */
    function StatusBridge(props) {
      const run = props.run
      const t = props.t
      const useConversation = props.useConversation
      const activity =
        typeof useConversation === 'function'
          ? useConversation((snapshot) => (snapshot && snapshot.activeTargets ? snapshot.activeTargets.size || 0 : 0))
          : 0

      React.useEffect(() => {
        let live = true
        const sync = async () => {
          const listed = await readList({ read: props.read, run, t })
          if (live && listed && listed.ok) status.set(Array.isArray(listed.sources) ? listed.sources.length : 0)
        }
        sync()
        return () => {
          live = false
        }
      }, [activity])

      return null
    }

    /*
     * The blank-Session fallback: tabs do not exist until the first Turn, so a
     * one-line add form sits in the composer dock while `session.blank` is true.
     * It disappears the moment the header (and the Sources tab) appears.
     */
    function AddSourceDock(props) {
      const t = props.t
      const run = props.run
      const useSession = props.useSession
      const blank = typeof useSession === 'function' ? useSession((session) => (session ? session.blank === true : false)) : false

      const [count, setCount] = React.useState(status.count)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => status.subscribe(() => setCount(status.count)), [])

      React.useEffect(() => {
        if (!blank) return undefined
        let live = true
        readList({ read: props.read, run, t }).then((listed) => {
          if (live && listed && listed.ok) status.set(Array.isArray(listed.sources) ? listed.sources.length : 0)
        })
        return () => {
          live = false
        }
      }, [blank])

      if (!blank) return null

      const submit = async (event) => {
        if (event && event.preventDefault) event.preventDefault()
        const path = draft.trim()
        if (!path || busy) return
        setBusy(true)
        const reply = await ask(run, t, ADD + ' ' + path)
        setBusy(false)
        if (!reply || !reply.ok) {
          setError((reply && reply.error) || '')
          return
        }
        const added = reply.added
        const failed = added && added.ok === false
        const sources = Array.isArray(reply.sources) ? reply.sources : []
        setDraft(failed ? draft : '')
        setError(failed ? String(added.error || '') : '')
        status.set(sources.length)
      }

      return h(
        'div',
        { className: props.classes.dock },
        error ? h('span', { role: 'alert', className: props.classes.dockError }, error) : null,
        h(
          'div',
          { className: props.classes.dockRow },
          h('span', { className: props.classes.dockLabel }, t('sources')),
          h('span', { className: props.classes.dockMeta }, count > 0 ? t('count', { count }) : t('none')),
          h(
            'form',
            { onSubmit: submit, className: props.classes.dockForm },
            h('input', {
              type: 'text',
              value: draft,
              onChange: (event) => setDraft(event.target.value),
              placeholder: t('placeholder'),
              'aria-label': t('placeholder'),
              disabled: busy,
              className: props.classes.input,
            }),
            h(
              'button',
              { type: 'submit', disabled: busy || !draft.trim(), className: props.classes.submit },
              busy ? t('working') : t('add'),
            ),
          ),
        ),
      )
    }

    /* One style tag for the plugin; every colour is a host theme token. */
    const CSS = [
      '.dsnb-view{width:100%;max-width:760px;margin:0 auto;padding:20px 24px 28px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}',
      '.dsnb-head{display:flex;align-items:baseline;gap:10px;min-width:0}',
      '.dsnb-title{margin:0;font-size:15px;font-weight:600;line-height:22px}',
      '.dsnb-meta{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
      '.dsnb-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsnb-form{display:flex;gap:8px}',
      '.dsnb-input{flex:1 1 auto;min-width:0;padding:7px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);box-sizing:border-box}',
      '.dsnb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dsnb-submit{flex:none;padding:7px 16px;font:inherit;font-size:13px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dsnb-submit:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.dsnb-submit:disabled{cursor:default;opacity:.5}',
      '.dsnb-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);overflow:hidden}',
      '.dsnb-item{display:flex;align-items:center;gap:10px;padding:10px 12px;font-size:13px;line-height:20px;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsnb-item:last-child{border-bottom:none}',
      '.dsnb-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsnb-fmt{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.dsnb-warn{flex:none;color:var(--dsw-alias-state-warn-primary);font-size:11px;white-space:nowrap}',
      '.dsnb-remove{flex:none;background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:16px;line-height:1;padding:0 2px}',
      '.dsnb-remove:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
      '.dsnb-remove:disabled{cursor:default;opacity:.5}',
      '.dsnb-empty{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsnb-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.dsnb-dock{display:flex;flex-direction:column;gap:4px;width:100%;max-width:var(--dsh-composer-card-max-width,760px);margin:0 auto;padding:2px 4px 4px;box-sizing:border-box}',
      '.dsnb-dockRow{display:flex;align-items:center;gap:8px;width:100%;min-width:0}',
      '.dsnb-dockLabel{flex:none;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dsnb-dockMeta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsnb-dockForm{flex:1 1 auto;min-width:0;display:flex;gap:6px}',
      '.dsnb-dock .dsnb-input{padding:4px 8px;font-size:12px}',
      '.dsnb-dock .dsnb-submit{padding:4px 12px;font-size:12px}',
      '.dsnb-dockError{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:11px}',
    ].join('')

    const styleId = 'source-notebook/sources.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(styleId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'source-notebook'
      tag.dataset.pluginCss = styleId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const classes = {
      view: 'dsnb-view',
      head: 'dsnb-head',
      title: 'dsnb-title',
      meta: 'dsnb-meta',
      hint: 'dsnb-hint',
      form: 'dsnb-form',
      input: 'dsnb-input',
      submit: 'dsnb-submit',
      list: 'dsnb-list',
      item: 'dsnb-item',
      name: 'dsnb-name',
      fmt: 'dsnb-fmt',
      warn: 'dsnb-warn',
      remove: 'dsnb-remove',
      empty: 'dsnb-empty',
      error: 'dsnb-error',
      dock: 'dsnb-dock',
      dockRow: 'dsnb-dockRow',
      dockLabel: 'dsnb-dockLabel',
      dockMeta: 'dsnb-dockMeta',
      dockForm: 'dsnb-dockForm',
      dockError: 'dsnb-dockError',
    }

    return {
      inject: ['slots', 'remote', 'remote.commands', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en: STRINGS }))
        const t = ctx.locale.bind(NS)

        const run = (sessionId) => (line) => ctx.remote.commands.execute(sessionId, line, [])

        /*
         * The tab label is projected only when the View registry changes, so a
         * count change re-registers the same id (which replaces the cell in
         * place and keeps the rendered View mounted). Registering an unchanged
         * label is skipped, so this cannot loop.
         */
        let declared = false
        let registeredLabel = null
        const disposers = []

        const labelNow = () => (status.count > 0 ? t('tab.active', { count: status.count }) : t('tab.idle'))

        const syncLabel = () => {
          if (!declared) return
          const next = labelNow()
          if (next === registeredLabel) return
          const label = next
          registeredLabel = label
          try {
            disposers.push(
              ctx.slots.register(
                {
                  name: 'conversation.view',
                  id: 'sources',
                  order: 20,
                  label: () => labelNow(),
                  inject: (sessionId) => ({
                    t,
                    classes,
                    run: run(sessionId),
                    read: () => fetchList(sessionId),
                  }),
                },
                SourcesView,
              ),
            )
          } catch (error) {
            registeredLabel = null
            // A registry that rejects the replacement keeps whatever entry it
            // already has; report once rather than retrying every refresh.
            console.warn('source-notebook: could not update the Sources tab label', error)
          }
        }

        ctx.effect(() => status.subscribe(syncLabel))

        ctx.slots.inject('conversation.view', () => {
          declared = true
          syncLabel()
          return () => {
            declared = false
            registeredLabel = null
            for (const dispose of disposers.splice(0)) {
              try {
                dispose()
              } catch {
                /* the declaration may already be gone */
              }
            }
          }
        })

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'source-notebook-status',
              order: 100,
              inject: (sessionId) => ({
                t,
                run: run(sessionId),
                read: () => fetchList(sessionId),
              }),
            },
            StatusBridge,
          ),
        )

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'source-notebook-add',
              order: 40,
              inject: (sessionId) => ({
                t,
                classes,
                run: run(sessionId),
                read: () => fetchList(sessionId),
              }),
            },
            AddSourceDock,
          ),
        )
      },
    }
  },
})
