window.__ModuleLoader__.load({ id: 'dsh-skills-symlink', factory: (require) => {
  const React = require('react')
  const { createElement: h, useCallback, useEffect, useState } = React

  const NS = 'dsh-skills-symlink'
  const STORAGE_KEY = 'dsh-skills-symlink:last-project'
  // An exact Fetch route of the host's own client connection, under its /api
  // prefix: same-origin, so the host's session cookie goes with the request
  // and the host's Host/Origin checks run before the plugin sees it. Relative
  // to the document base, so a DSH served under a sub-path works too.
  const PACKAGE_NAME = 'dsh-skills-symlink'
  const ENDPOINT = new URL('api/dsh-skills-symlink/config', document.baseURI).toString()

  const colors = {
    border: 'var(--dsh-color-border, rgba(127,127,127,.25))',
    muted: 'var(--dsh-color-text-secondary, #777)',
    danger: 'var(--dsh-color-danger, #d64545)',
    success: 'var(--dsh-color-success, #2e8b57)',
    surface: 'var(--dsh-color-surface, rgba(127,127,127,.06))',
  }
  const style = {
    card: { border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' },
    header: { width: '100%', border: 0, background: 'transparent', color: 'inherit', padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left', cursor: 'pointer' },
    title: { fontWeight: 650, fontSize: 15 },
    hint: { color: colors.muted, fontSize: 12, lineHeight: 1.5, marginTop: 3 },
    body: { borderTop: `1px solid ${colors.border}`, padding: 18, display: 'grid', gap: 14 },
    label: { display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 },
    input: { boxSizing: 'border-box', width: '100%', border: `1px solid ${colors.border}`, borderRadius: 8, background: 'transparent', color: 'inherit', padding: '9px 11px', font: 'inherit' },
    row: { display: 'flex', gap: 8, alignItems: 'center' },
    button: { border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.surface, color: 'inherit', padding: '8px 12px', cursor: 'pointer', whiteSpace: 'nowrap' },
    primary: { border: '1px solid #246bfd', borderRadius: 8, background: '#246bfd', color: '#fff', padding: '8px 14px', cursor: 'pointer', whiteSpace: 'nowrap' },
    ghostDanger: { border: 0, background: 'transparent', color: colors.danger, padding: 8, cursor: 'pointer' },
    code: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 },
    diagnostic: { border: `1px solid ${colors.border}`, borderRadius: 8, padding: '9px 11px', display: 'grid', gap: 3 },
  }

  const LANG = (() => {
    try {
      const raw = typeof navigator !== 'undefined'
        ? navigator.language || (navigator.languages && navigator.languages[0]) || ''
        : ''
      return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    } catch { return 'en' }
  })()

  const DICT = {
    zh: {
      errRelative: '相对项目目录需要先打开一个 DSH 项目，或点击“选择目录”',
      errMissingProject: '请先填写项目目录',
      errNotWorkspace: '这个目录不是 DSH 已打开的工作区；请先在 DSH 里把它作为工作区打开',
      errExternal: '有路径落在项目外（包括通过符号链接）；需要在插件配置里设 allowExternalPaths: true',
      errUnsafePath: '配置目录或配置文件是符号链接，或者落在项目外，已拒绝写入',
      errInvalidConfig: '配置内容不合法，没有写入',
      errTooLarge: '请求内容过大',
      errForbidden: '请求来源不被允许',
      errInternal: '服务端出错，详情见插件日志',
      noticeSaved: '已保存，Skill 列表会热更新；新会话也会按此项目配置加载。',
      cardTitle: '项目 Skill 路径',
      dirtySuffix: ' · 未保存',
      cardHint: '为当前 Git 项目维护 .dsh/skill-paths.yaml 中的相对 Skill 路径，并显示解析后的技能结构。',
      projectLabel: '项目目录（“.” 表示当前项目）',
      projectPlaceholder: '. 或 C:\\path\\to\\project',
      busyProcessing: '处理中…',
      read: '读取',
      chooseFolder: '选择目录',
      baseRootLabel: '当前项目基准：',
      noBaseRoot: '尚无当前项目；可点击“选择目录”。',
      identified: '识别项目：',
      configFile: '配置文件：',
      externalAllowed: '已允许项目外部路径',
      sandbox: '安全限制：只允许项目内路径',
      rootsLabel: 'Skill 根目录（相对项目根）',
      rootsPlaceholder: '.codex/skills 或 tools/skills',
      removePath: '删除路径 {n}',
      remove: '删除',
      addPath: '+ 添加相对路径',
      diagnostics: '路径诊断',
      dirExists: '目录存在',
      dirMissing: '目录不存在',
      structureTitle: 'Skill 结构 · 本次共 {n} 个',
      emptyDir: '这个目录下没有 SKILL.md',
      watchOnly: '仅监听（等新增技能，当前不贡献）：{list}',
      saving: '正在保存…',
      save: '保存项目配置',
      discard: '放弃修改',
      loadHint: '读取当前项目后，可在这里添加、修改或删除任意数量的相对 Skill 根目录。',
      libraryRoot: '技能库',
      unnamed: '(未命名)',
      subfolders: '{n} 个子目录',
      hideSkills: '收起技能',
      nSkills: '{n} 个技能',
      noConfig: '这个项目没有配置 .dsh/skill-paths.yaml，或者配置里没有可用目录。',
      composition: '技能文件 · 共 {n} 个（含重名）',
      segmentTitle: '{name}：{n} 个',
      directories: '目录',
      overviewTitle: 'Skill 总览',
      overviewHint: '{n} 个项目，点开看各自的结构',
      reload: '重新读取',
      summary: '{roots} 个根 · {skills} 个技能',
      dupes: '（另有 {n} 个重名）',
      failed: '读取失败',
      loading: '读取中…',
      openToLoad: '点开读取',
      close: '收起',
      open: '展开',
      noWorkspace: '还没有打开任何工作区。',
      tabLabel: 'Skill 结构',
    },
    en: {
      errRelative: 'Relative project paths need an open DSH project, or use “Choose folder”.',
      errMissingProject: 'Enter a project folder first.',
      errNotWorkspace: 'This folder is not a workspace DSH knows. Open it as a workspace in DSH first.',
      errExternal: 'A path leaves the project (also through a symbolic link). Set allowExternalPaths: true in the plugin row to allow it.',
      errUnsafePath: 'The config folder or file is a symbolic link or leaves the project; nothing was written.',
      errInvalidConfig: 'The config is not valid; nothing was written.',
      errTooLarge: 'The request is too large.',
      errForbidden: 'This request origin is not allowed.',
      errInternal: 'Server error; see the plugin log.',
      noticeSaved: 'Saved. The skill list reloads live, and new sessions use this config.',
      cardTitle: 'Project skill paths',
      dirtySuffix: ' · unsaved',
      cardHint: 'Maintain the relative skill paths in .dsh/skill-paths.yaml for this Git project, and see the resolved structure.',
      projectLabel: 'Project folder (“.” means the current project)',
      projectPlaceholder: '. or C:\\path\\to\\project',
      busyProcessing: 'Working…',
      read: 'Read',
      chooseFolder: 'Choose folder',
      baseRootLabel: 'Current project base:',
      noBaseRoot: 'No current project yet. Use “Choose folder”.',
      identified: 'Project:',
      configFile: 'Config file:',
      externalAllowed: 'External paths are allowed',
      sandbox: 'Sandbox: project paths only',
      rootsLabel: 'Skill roots (relative to the project)',
      rootsPlaceholder: '.codex/skills or tools/skills',
      removePath: 'Remove path {n}',
      remove: 'Remove',
      addPath: '+ Add a relative path',
      diagnostics: 'Path checks',
      dirExists: 'Directory exists',
      dirMissing: 'Directory missing',
      structureTitle: 'Skill structure · {n} in total',
      emptyDir: 'No SKILL.md under this folder',
      watchOnly: 'Watched only (picks up new skills, contributes nothing yet): {list}',
      saving: 'Saving…',
      save: 'Save project config',
      discard: 'Discard',
      loadHint: 'Read a project to add, edit or remove any number of relative skill roots here.',
      libraryRoot: 'Skills library',
      unnamed: '(unnamed)',
      subfolders: '{n} subfolders',
      hideSkills: 'Hide skills',
      nSkills: '{n} skills',
      noConfig: 'This project has no .dsh/skill-paths.yaml, or it lists no usable directory.',
      composition: 'Skill files · {n} (duplicates included)',
      segmentTitle: '{name}: {n}',
      directories: 'Directories',
      overviewTitle: 'Skills overview',
      overviewHint: '{n} projects, open one to inspect it',
      reload: 'Reload',
      summary: '{roots} roots · {skills} skills',
      dupes: ' ({n} duplicates)',
      failed: 'Failed to read',
      loading: 'Loading…',
      openToLoad: 'Open to load',
      close: 'Close',
      open: 'Open',
      noWorkspace: 'No workspace is open.',
      tabLabel: 'Skill structure',
    },
  }

  function tx(key, vars) {
    const table = DICT[LANG] || DICT.en
    let text = table[key] !== undefined ? table[key] : (DICT.en[key] !== undefined ? DICT.en[key] : key)
    if (vars) for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
    return text
  }

  async function requestJson(url, init) {
    const response = await fetch(url, { cache: 'no-store', ...init })
    const body = await response.json()
    if (!response.ok || body.ok !== true) {
      // Show the server's error in the card's language when its code is known.
      const key = body && typeof body.code === 'string' ? ERROR_KEYS[body.code] : undefined
      throw new Error(key ? tx(key) : (body && body.error) || `HTTP ${response.status}`)
    }
    return body
  }

  const ERROR_KEYS = {
    'missing-project': 'errMissingProject',
    'relative-project': 'errRelative',
    'not-a-workspace': 'errNotWorkspace',
    'external-path': 'errExternal',
    'unsafe-config-path': 'errUnsafePath',
    'invalid-config': 'errInvalidConfig',
    'invalid-json': 'errInvalidConfig',
    'payload-too-large': 'errTooLarge',
    'unsupported-media-type': 'errInvalidConfig',
    'forbidden-origin': 'errForbidden',
    internal: 'errInternal',
  }

  // The plugin detail page passes a structured subject: a bundle page
  // ({ kind: 'bundle', pkg: { name } }) or a plugin row page
  // ({ kind: 'row', pkg, row: { moduleName } }). Match those fields exactly
  // instead of searching the serialized object for the package name.
  function isOwnSubject(subject) {
    if (subject == null || typeof subject !== 'object') return false
    if (subject.kind === 'bundle') return subject.pkg != null && subject.pkg.name === PACKAGE_NAME
    if (subject.kind === 'row') {
      return (subject.pkg != null && subject.pkg.name === PACKAGE_NAME) ||
        (subject.row != null && subject.row.moduleName === PACKAGE_NAME)
    }
    return false
  }

  function resolveProjectInput(value, baseRoot) {
    const input = value.trim()
    if (/^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('/')) return input
    if (!baseRoot) throw new Error(tx('errRelative'))

    const windows = /^[A-Za-z]:[\\/]/.test(baseRoot)
    const separator = windows ? '\\' : '/'
    const parts = baseRoot.split(/[\\/]+/)
    const minimum = windows ? 1 : 0
    for (const part of input.split(/[\\/]+/)) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (parts.length > minimum) parts.pop()
      } else {
        parts.push(part)
      }
    }
    return `${windows ? '' : '/'}${parts.join(separator)}`
  }

  function SettingsCard({ workspaces }) {
    const [open, setOpen] = useState(false)
    const [projectInput, setProjectInput] = useState(() => {
      try { return localStorage.getItem(STORAGE_KEY) || '.' } catch { return '.' }
    })
    const [project, setProject] = useState(null)
    const [paths, setPaths] = useState([])
    const [busy, setBusy] = useState(false)
    const [dirty, setDirty] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [, setWorkspaceRevision] = useState(0)

    useEffect(() => workspaces.list.subscribe(() => setWorkspaceRevision(value => value + 1)), [workspaces])
    const workspaceSnapshot = workspaces.list.getSnapshot()
    const workspaceItems = workspaceSnapshot && Array.isArray(workspaceSnapshot.items) ? workspaceSnapshot.items : []
    const currentWorkspace = workspaceItems.find(item => item.workspaceId === (workspaceSnapshot && workspaceSnapshot.recentWorkspaceId)) || workspaceItems[0]
    const baseRoot = currentWorkspace ? currentWorkspace.path : ''

    useEffect(() => {
      try { if (projectInput) localStorage.setItem(STORAGE_KEY, projectInput) } catch { /* unavailable */ }
    }, [projectInput])

    const load = useCallback(async (requestedRoot = projectInput) => {
      setBusy(true); setError(''); setNotice('')
      try {
        const resolvedRoot = resolveProjectInput(requestedRoot, baseRoot)
        const body = await requestJson(`${ENDPOINT}?projectRoot=${encodeURIComponent(resolvedRoot)}&baseRoot=${encodeURIComponent(baseRoot)}`)
        setProject(body); setProjectInput(requestedRoot); setPaths(body.skillPaths); setDirty(false)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally { setBusy(false) }
    }, [baseRoot, projectInput])

    const chooseProject = useCallback(async () => {
      setBusy(true); setError(''); setNotice('')
      try {
        const selected = await workspaces.pickDirectory()
        if (selected !== null) {
          setProjectInput(selected)
          const body = await requestJson(`${ENDPOINT}?projectRoot=${encodeURIComponent(selected)}&baseRoot=`)
          setProject(body); setPaths(body.skillPaths); setDirty(false)
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally { setBusy(false) }
    }, [workspaces])

    const save = useCallback(async () => {
      setBusy(true); setError(''); setNotice('')
      try {
        const resolvedRoot = resolveProjectInput(projectInput, baseRoot)
        const body = await requestJson(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectRoot: resolvedRoot, baseRoot, skillPaths: paths }),
        })
        setProject(body); setPaths(body.skillPaths); setDirty(false)
        setNotice(tx('noticeSaved'))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally { setBusy(false) }
    }, [baseRoot, paths, projectInput])

    const updatePath = (index, value) => {
      setPaths(current => current.map((item, i) => i === index ? value : item)); setDirty(true)
    }
    const removePath = (index) => {
      setPaths(current => current.filter((_, i) => i !== index)); setDirty(true)
    }

    return h('div', { style: style.card },
      h('button', { type: 'button', style: style.header, 'aria-expanded': open, onClick: () => setOpen(!open) },
        h('div', null,
          h('div', { style: style.title }, tx('cardTitle'), dirty ? tx('dirtySuffix') : ''),
          h('div', { style: style.hint }, tx('cardHint')),
        ),
        h('span', { 'aria-hidden': true }, open ? '⌃' : '⌄'),
      ),
      open ? h('div', { style: style.body },
        h('label', { style: style.label },
          tx('projectLabel'),
          h('div', { style: style.row },
            h('input', { style: style.input, value: projectInput, placeholder: tx('projectPlaceholder'), onChange: event => setProjectInput(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && !busy) void load(projectInput) } }),
            h('button', { type: 'button', style: style.button, disabled: busy, onClick: () => void load(projectInput) }, busy ? tx('busyProcessing') : tx('read')),
            h('button', { type: 'button', style: style.button, disabled: busy, onClick: chooseProject }, tx('chooseFolder')),
          ),
          baseRoot ? h('div', { style: style.hint }, tx('baseRootLabel'), h('span', { style: style.code }, baseRoot)) : h('div', { style: style.hint }, tx('noBaseRoot')),
        ),
        project ? h(React.Fragment, null,
          h('div', { style: style.hint },
            h('div', null, tx('identified'), h('span', { style: style.code }, project.projectRoot)),
            h('div', null, tx('configFile'), h('span', { style: style.code }, project.configPath)),
            project.allowExternalPaths ? h('div', { style: { color: colors.danger } }, tx('externalAllowed')) : h('div', null, tx('sandbox')),
          ),
          h('div', { style: { display: 'grid', gap: 8 } },
            h('div', { style: style.label }, tx('rootsLabel')),
            paths.map((value, index) => h('div', { key: index, style: style.row },
              h('input', { style: { ...style.input, ...style.code }, value, placeholder: tx('rootsPlaceholder'), onChange: event => updatePath(index, event.target.value) }),
              h('button', { type: 'button', style: style.ghostDanger, onClick: () => removePath(index), 'aria-label': tx('removePath', { n: index + 1 }) }, tx('remove')),
            )),
            h('button', { type: 'button', style: { ...style.button, justifySelf: 'start' }, onClick: () => { setPaths(current => [...current, '']); setDirty(true) } }, tx('addPath')),
          ),
          project.roots && project.roots.length ? h('div', { style: { display: 'grid', gap: 6 } },
            h('div', { style: style.label }, tx('diagnostics')),
            project.roots.map((root, index) => h('div', { key: index, style: style.diagnostic },
              h('div', { style: style.code }, root.configuredPath),
              h('div', { style: style.hint }, root.resolvedPath),
              h('div', { style: { color: root.exists ? colors.success : colors.danger, fontSize: 12 } }, root.exists ? tx('dirExists') : tx('dirMissing')),
            )),
          ) : null,
          project.structure && project.structure.length ? h('div', { style: { display: 'grid', gap: 6 } },
            h('div', { style: style.label }, tx('structureTitle', { n: project.skillCount ?? 0 })),
            project.structure.map((entry, index) => h('details', { key: index, style: style.diagnostic },
              h('summary', { style: { cursor: 'pointer', ...style.code, wordBreak: 'break-all' } },
                `${entry.path}（${entry.skills.length}）`),
              entry.skills.length
                ? h('div', { style: { marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 12px' } },
                    entry.skills.map((skill, position) => h('span', { key: position, style: { ...style.code, color: colors.muted } }, skill.name)))
                : h('div', { style: { ...style.hint, marginTop: 6 } }, tx('emptyDir')),
            )),
            project.watchOnlyRoots && project.watchOnlyRoots.length
              ? h('div', { style: style.hint }, tx('watchOnly', { list: project.watchOnlyRoots.join(', ') }))
              : null,
            project.expansionWarnings && project.expansionWarnings.length
              ? h('div', { style: { color: colors.danger, fontSize: 12, display: 'grid', gap: 2 } },
                  project.expansionWarnings.map((warning, position) => h('div', { key: position }, warning)))
              : null,
          ) : null,
          h('div', { style: style.row },
            h('button', { type: 'button', style: style.primary, disabled: busy || !dirty, onClick: save }, busy ? tx('saving') : tx('save')),
            dirty ? h('button', { type: 'button', style: style.button, disabled: busy, onClick: () => { setPaths(project.skillPaths); setDirty(false); setError(''); setNotice('') } }, tx('discard')) : null,
          ),
        ) : h('div', { style: style.hint }, tx('loadHint')),
        error ? h('div', { style: { color: colors.danger, fontSize: 13 } }, error) : null,
        notice ? h('div', { style: { color: colors.success, fontSize: 13 } }, notice) : null,
      ) : null,
    )
  }

  // Rendered on this plugin's own page in the Plugins section. Every workspace
  // is one collapsible row; opening it shows how its skills split across the
  // categories, then the directory tree that produced them.
  const PALETTE = ['#246bfd', '#12a594', '#e08b2a', '#8b5cf6', '#d64545', '#0ea5e9', '#6b7280', '#a16207']

  function buildTree(structure) {
    const split = (value) => String(value).split(/[\\/]+/).filter(Boolean)
    const parts = structure.map((entry) => split(entry.path))
    let common = parts.length ? parts[0].slice() : []
    for (const segments of parts) {
      let i = 0
      while (i < common.length && i < segments.length && common[i].toLowerCase() === segments[i].toLowerCase()) i += 1
      common = common.slice(0, i)
    }
    const root = { name: common.length ? common[common.length - 1] : tx('libraryRoot'), children: new Map(), own: 0, skills: [] }
    for (const entry of structure) {
      let node = root
      for (const segment of split(entry.path).slice(common.length)) {
        if (!node.children.has(segment)) node.children.set(segment, { name: segment, children: new Map(), own: 0, skills: [] })
        node = node.children.get(segment)
      }
      node.own += entry.skills.length
      node.skills = entry.skills
      node.path = entry.path
    }
    const count = (node) => {
      let sum = node.own
      for (const child of node.children.values()) sum += count(child)
      node.total = sum
      return sum
    }
    count(root)
    return root
  }

  function workspaceName(item) {
    if (item && typeof item.name === 'string' && item.name.trim()) return item.name.trim()
    const parts = String(item && item.path ? item.path : '').split(/[\\/]+/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : tx('unnamed')
  }

  function OverviewSection({ workspaces }) {
    const [openIds, setOpenIds] = useState({})
    const [state, setState] = useState({})
    const [openPath, setOpenPath] = useState('')

    const snapshot = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null
    const raw = snapshot && Array.isArray(snapshot.items) ? snapshot.items.slice() : []
    const currentId = raw.length ? raw[0].workspaceId : ''
    const items = raw.sort((left, right) => {
      if (left.workspaceId === currentId) return -1
      if (right.workspaceId === currentId) return 1
      return workspaceName(left).localeCompare(workspaceName(right))
    })

    const load = useCallback(async (item) => {
      setState((prev) => ({ ...prev, [item.workspaceId]: { status: 'loading' } }))
      try {
        const body = await requestJson(`${ENDPOINT}?projectRoot=${encodeURIComponent(item.path)}&baseRoot=`)
        setState((prev) => ({ ...prev, [item.workspaceId]: { status: 'ready', data: body } }))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setState((prev) => ({ ...prev, [item.workspaceId]: { status: 'error', error: message } }))
      }
    }, [])

    const toggle = (item) => {
      const id = item.workspaceId
      const willOpen = !openIds[id]
      setOpenIds({ ...openIds, [id]: willOpen })
      if (willOpen && state[id] === undefined) void load(item)
    }

    const refreshAll = () => {
      setState({})
      setOpenPath('')
      for (const item of items) if (openIds[item.workspaceId]) void load(item)
    }

    const renderTree = (node, depth, rows) => {
      const clickable = node.skills.length > 0 && node.path
      const opened = Boolean(node.path) && openPath === node.path
      rows.push(h('div', {
        key: `n-${rows.length}`,
        style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'center', paddingLeft: depth * 18 },
      },
        h('button', {
          type: 'button',
          title: node.path || '',
          onClick: clickable ? () => setOpenPath(opened ? '' : node.path) : undefined,
          style: { display: 'flex', alignItems: 'center', gap: 7, background: 'transparent', border: 0, color: 'inherit', padding: 0, textAlign: 'left', cursor: clickable ? 'pointer' : 'default' },
        },
          h('svg', {
            width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': true,
            style: { flex: '0 0 auto', color: depth === 0 ? 'inherit' : colors.muted },
          }, h('path', {
            d: 'M1.9 3.6h4.05l1.35 1.55h6.8a.7.7 0 0 1 .7.7v6.55a.7.7 0 0 1-.7.7H1.9a.7.7 0 0 1-.7-.7V4.3a.7.7 0 0 1 .7-.7Z',
            fill: 'none', stroke: 'currentColor', 'stroke-width': 1.25, 'stroke-linejoin': 'round',
          })),
          h('span', { style: { ...style.code, fontWeight: depth === 0 ? 600 : 400 } }, node.name),
          node.children.size ? h('span', { style: { ...style.hint, fontSize: 11 } }, tx('subfolders', { n: node.children.size })) : null,
          clickable ? h('span', { style: { ...style.hint, fontSize: 11 } }, opened ? tx('hideSkills') : tx('nSkills', { n: node.skills.length })) : null,
        ),
        h('span', { style: { ...style.code, color: colors.muted, fontVariantNumeric: 'tabular-nums' } }, String(node.total)),
      ))
      if (opened) {
        rows.push(h('div', {
          key: `s-${rows.length}`,
          style: { display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: depth * 18 + 22, paddingTop: 4, paddingBottom: 4 },
        }, node.skills.map((skill, position) => h('span', {
          key: position,
          style: {
            display: 'inline-flex', alignItems: 'center',
            padding: '2px 9px', borderRadius: 999,
            background: colors.surface, border: `1px solid ${colors.border}`,
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 11.5, lineHeight: 1.75, color: colors.muted,
          },
        }, skill.name))))
      }
      for (const child of node.children.values()) renderTree(child, depth + 1, rows)
    }

    const renderDetail = (data) => {
      const structure = data && Array.isArray(data.structure) ? data.structure : []
      if (!structure.length) {
        return h('div', { style: style.hint }, tx('noConfig'))
      }
      const tree = buildTree(structure)
      const segments = Array.from(tree.children.values())
      const total = tree.total || 1
      const rows = []
      renderTree(tree, 0, rows)
      return h('div', { style: { display: 'grid', gap: 14 } },
        h('div', { style: { display: 'grid', gap: 8 } },
          h('div', { style: style.label }, tx('composition', { n: tree.total })),
          h('div', { style: { display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: colors.surface } },
            segments.map((segment, index) => h('div', {
              key: index,
              title: tx('segmentTitle', { name: segment.name, n: segment.total }),
              style: { width: `${(segment.total / total) * 100}%`, background: PALETTE[index % PALETTE.length] },
            }))),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px' } },
            segments.map((segment, index) => h('span', {
              key: index,
              style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.muted },
            },
              h('span', { style: { width: 8, height: 8, borderRadius: 2, background: PALETTE[index % PALETTE.length] } }),
              `${segment.name} ${segment.total}`,
            ))),
        ),
        h('div', { style: { display: 'grid', gap: 8 } },
          h('div', { style: style.label }, tx('directories')),
          h('div', { style: { display: 'grid', gap: 7 } }, rows),
        ),
      )
    }

    return h('section', { style: { borderTop: `1px solid ${colors.border}`, marginTop: 24, paddingTop: 20, display: 'grid', gap: 6 } },
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4 } },
        h('div', null,
          h('div', { style: style.title }, tx('overviewTitle')),
          h('div', { style: style.hint }, tx('overviewHint', { n: items.length })),
        ),
        h('button', { type: 'button', style: style.button, onClick: refreshAll }, tx('reload')),
      ),
      items.length
        ? items.map((item) => {
            const id = item.workspaceId
            const entry = state[id]
            const isOpen = Boolean(openIds[id])
            const summary = entry && entry.status === 'ready'
              ? tx('summary', { roots: entry.data.rootCount ?? entry.data.structure.length, skills: entry.data.skillCount ?? 0 })
                + (entry.data.duplicateSkills ? tx('dupes', { n: entry.data.duplicateSkills }) : '')
                + ` · maxDepth ${entry.data.maxDepth ?? '?'}`
              : entry && entry.status === 'error' ? tx('failed') : isOpen ? tx('loading') : tx('openToLoad')
            return h('div', { key: id, style: { borderTop: `1px solid ${colors.border}`, paddingTop: 10, paddingBottom: 6, display: 'grid', gap: 12 } },
              h('button', {
                type: 'button',
                onClick: () => toggle(item),
                style: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'baseline', background: 'transparent', border: 0, color: 'inherit', padding: 0, textAlign: 'left', cursor: 'pointer' },
              },
                h('span', { style: { ...style.code, fontWeight: 600 } }, workspaceName(item)),
                h('span', { style: style.hint }, summary),
                h('span', { style: { ...style.hint, fontSize: 12 } }, isOpen ? tx('close') : tx('open')),
              ),
              isOpen
                ? (entry && entry.status === 'ready'
                    ? renderDetail(entry.data)
                    : h('div', { style: { ...style.hint, color: entry && entry.status === 'error' ? colors.danger : colors.muted } },
                        entry && entry.error ? entry.error : tx('loading')))
                : null,
            )
          })
        : h('div', { style: style.hint }, tx('noWorkspace')),
    )
  }

  const name = 'dsh-skills-symlink-client'
  const inject = ['slots', 'workspaces']
  function apply(ctx) {
    // This host exposes settings contributions as tabs of the Plugins section.
    // The older `settingsScope` service and `settings.plugin.item` slot are gone,
    // so registering into them left the card mounted nowhere.
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: NS,
      order: 20,
      label: () => tx('tabLabel'),
      inject: () => ({ workspaces: ctx.workspaces }),
    }, () => h(SettingsCard, { workspaces: ctx.workspaces })))

    // ...and a section on this plugin's own page, which is where the structure
    // belongs: it answers "what does this plugin do for me right now".
    ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
      name: 'plugins.detail.section',
      id: NS,
      order: 10,
    }, ({ subject }) => {
      return isOwnSubject(subject) ? h(OverviewSection, { workspaces: ctx.workspaces }) : null
    }))
  }

  return { name, inject, apply }
} })
