// PR Studio — GitHub pull requests, diffs, images and reviews inside Hermes Desktop.
// Plain ESM loaded uncompiled: UI is jsx()/jsxs() calls, no JSX syntax.
import {
  host,
  atom,
  useValue,
  useQuery,
  useQueryClient,
  queryClient,
  Button,
  Codicon,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  ModelCatalogMenu,
  ModelMenuCloseContext,
  SearchField,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  PALETTE_AREA,
  STATUSBAR_AREAS
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-pr-studio'
const PANE_ID = `${ID}:studio`
let CTX = null

// ------------------------------------------------------------------ state
// Which list the dropdown shows: ALL (your open PRs across GitHub) or one owner/repo.
const ALL = '*'
const $repo = atom(ALL)
const $selected = atom(null) // { repo, number } of the open PR
const $open = atom(false) // PR Studio tile is open
const $viewer = atom(null) // { src, alt, href } of the image shown full size
const $watch = atom([]) // ['owner/repo#12', ...]
const $watchChanges = atom({}) // key -> human summary of what changed
const $drafts = atom({}) // 'owner/repo#12' -> [{path,line,side,body,hunk}]

const api = (path, opts) => CTX.rest(path, { timeoutMs: 60000, ...(opts || {}) })
const q = obj =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
const prKey = (repo, n) => `${repo}#${n}`
const errText = e => (e && (e.detail || e.message)) || String(e)

function persist() {
  CTX.storage.set('repo', $repo.get())
  CTX.storage.set('watch', $watch.get())
  CTX.storage.set('drafts', $drafts.get())
}

function setRepo(repo) {
  $repo.set(repo)
  $selected.set(null)
  persist()
}

function toggleWatch(key) {
  const list = $watch.get()
  $watch.set(list.includes(key) ? list.filter(k => k !== key) : [...list, key])
  persist()
  pollWatch(true)
}

function addDraft(key, draft) {
  const d = { ...$drafts.get() }
  d[key] = [...(d[key] || []), draft]
  $drafts.set(d)
  persist()
}

function clearDrafts(key) {
  const d = { ...$drafts.get() }
  delete d[key]
  $drafts.set(d)
  persist()
}

function removeDraft(key, idx) {
  const d = { ...$drafts.get() }
  d[key] = (d[key] || []).filter((_, i) => i !== idx)
  if (!d[key].length) delete d[key]
  $drafts.set(d)
  persist()
}

// --------------------------------------------------------- send to hermes
function currentSession() {
  return host.state.focusedSessionId?.get?.() || host.state.activeSessionId?.get?.() || null
}

async function sendToHermes(text, mode = 'send') {
  const sid = currentSession()
  try {
    if (mode === 'send' && host.composer?.submit) {
      if (host.composer.submit(sid, text) || (sid && host.composer.submit(null, text))) {
        host.notify({ kind: 'success', message: 'Sent to Hermes' })
        return true
      }
    }
    if (host.composer?.insertText) {
      const ok = (await host.composer.insertText(sid, text, { mode: 'block' })) ||
        (sid && (await host.composer.insertText(null, text, { mode: 'block' })))
      if (ok) {
        host.notify({ kind: 'info', message: mode === 'send' ? 'No chat ready to send — added to the composer instead' : 'Added to the composer' })
        return true
      }
    }
  } catch (e) {
    /* fall through to clipboard */
  }
  await CTX.os?.writeClipboard?.(text)
  host.notify({ kind: 'warning', message: 'No chat is open — prompt copied to the clipboard. Open a chat and paste it.' })
  return false
}

function promptForComment({ repo, pr, path, line, side, hunk, author, body, url }) {
  const where = path ? `\nFile: ${path}${line ? `:${line}` : ''}${side === 'LEFT' ? ' (old side)' : ''}` : ''
  const code = hunk ? `\n\nCode:\n\`\`\`diff\n${hunk}\n\`\`\`` : ''
  const who = author ? ` by @${author}` : ''
  const quoted = (body || '').trim().split('\n').map(l => `> ${l}`).join('\n')
  return (
    `Please address this review feedback on PR #${pr.number} "${pr.title}" in ${repo} ` +
    `(branch ${pr.headRefName} → ${pr.baseRefName}).${where}${code}\n\n` +
    `Comment${who}:\n${quoted}${url ? `\n\nLink: ${url}` : ''}\n\n` +
    `Make the fix on the PR branch in this workspace, keep it scoped to this feedback, and tell me what changed.`
  )
}

function promptForPR(repo, pr) {
  return (
    `Please review PR #${pr.number} "${pr.title}" in ${repo} (${pr.headRefName} → ${pr.baseRefName}, ` +
    `+${pr.additions}/−${pr.deletions}, ${pr.changedFiles} files). Use \`gh pr view ${pr.number} -R ${repo}\` and ` +
    `\`gh pr diff ${pr.number} -R ${repo}\`. Summarise what it does, then list concrete bugs, risks and missing tests ` +
    `with file:line references. Do not post anything to GitHub.\n\nLink: ${pr.url}`
  )
}

// ------------------------------------------------------------------ watch
let lastSeen = {}

async function pollWatch(silent = false) {
  if (!CTX) return
  const keys = $watch.get()
  if (!keys.length) return
  let res
  try {
    res = await api(`/watch?${q({ items: keys.join(',') })}`)
  } catch (e) {
    return
  }
  const changes = { ...$watchChanges.get() }
  for (const [key, cur] of Object.entries(res.items || {})) {
    const prev = lastSeen[key]
    if (prev && !silent) {
      const what = []
      if (prev.head !== cur.head) what.push('new commits')
      if (prev.checks !== cur.checks && cur.checks) what.push(`checks ${cur.checks.toLowerCase()}`)
      if (prev.reviews !== cur.reviews || prev.review !== cur.review) what.push('new review')
      if (prev.comments !== cur.comments) what.push('new comments')
      if (prev.state !== cur.state) what.push(cur.state.toLowerCase())
      if (what.length) {
        changes[key] = what.join(', ')
        host.notify({ kind: 'info', message: `${key} — ${what.join(', ')}` })
        CTX.os?.notify?.({ title: `PR ${key}`, body: `${cur.title}: ${what.join(', ')}` })
        queryClient.invalidateQueries({ queryKey: [ID] })
      }
    }
    lastSeen[key] = cur
  }
  lastSeen = Object.fromEntries(Object.entries(lastSeen).filter(([k]) => keys.includes(k)))
  CTX.storage.set('lastSeen', lastSeen)
  $watchChanges.set(changes)
}

// PR Studio lives in a closeable workspace tile (host.openWorkspace) rather
// than a static pane: Hermes treats Close on a plugin's only pane as "disable
// the plugin", which left no way back except Settings → Plugins. The tile's
// own ✕ fires onClose, so the status-bar button can reopen it at any time.
const TILE_ID = ID
const TILE_PANE = `plugin-workspace:${TILE_ID}`
let closeTile = null
let disposing = false

const hasTile = () => typeof host.openWorkspace === 'function'

function openStudio() {
  if (!hasTile()) {
    if (typeof host.revealPane === 'function') host.revealPane(PANE_ID)
    return
  }
  closeTile = host.openWorkspace(TILE_ID, {
    title: 'Pull requests',
    dock: { pane: 'workspace', pos: 'right' },
    minWidth: '24rem',
    render: () => jsx(Studio, {}),
    onClose: () => {
      closeTile = null
      $open.set(false)
      // A plugin reload/disable tears the tile down too; only a user Close
      // should forget that it was open.
      if (!disposing) CTX?.storage.set('open', false)
    }
  })
  $open.set(true)
  CTX.storage.set('open', true)
}

function tileVisible() {
  return typeof host.paneVisibility === 'function' ? host.paneVisibility(TILE_PANE).get() : true
}

// Status-bar button and ⌘K command: open when closed, bring to front when
// it is open but behind another tab, close when it is already on screen.
function toggleStudio() {
  if (!hasTile()) return openStudio()
  if (!closeTile) return openStudio()
  if (!tileVisible()) return host.revealPane?.(TILE_PANE)
  closeTile()
}

function openPR(repo, number) {
  $viewer.set(null)
  $selected.set({ repo, number })
  const key = prKey(repo, number)
  const c = { ...$watchChanges.get() }
  delete c[key]
  $watchChanges.set(c)
}

// ------------------------------------------------------------------ styles
const CSS = `
.prs{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12.5px;color:var(--ui-text-primary)}
.prs *{box-sizing:border-box}
.prs-top{display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid var(--ui-stroke-secondary)}
.prs-in{flex:1;min-width:0;border-width:1px;border-style:solid;border-radius:2.5px;padding:4px 8px;font:inherit;color:var(--ui-text-primary)}
.prs-in:focus{outline:none;border-color:var(--ui-accent)}
.prs-in::placeholder,.prs-ta::placeholder{color:var(--ui-text-quaternary)}
.prs-group{display:flex;align-items:center;gap:6px;padding:10px 10px 4px;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ui-text-tertiary)}
.prs-group .prs-count{font-weight:400;color:var(--ui-text-quaternary)}
.prs-repo{font-size:11px;color:var(--ui-text-tertiary);font-family:var(--font-mono,ui-monospace,monospace)}
.prs-row:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.prs-scroll{flex:1;min-height:0;overflow:auto}
.prs-muted{color:var(--ui-text-tertiary)}
.prs-faint{color:var(--ui-text-quaternary)}
.prs-row{display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid var(--ui-stroke-tertiary);cursor:pointer;align-items:flex-start}
.prs-row:hover{background:var(--ui-bg-tertiary)}
.prs-av{width:20px;height:20px;border-radius:50%;flex:none}
.prs-title{font-weight:600;line-height:1.35;word-break:break-word}
.prs-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:3px;font-size:11px;color:var(--ui-text-tertiary)}
.prs-pill{display:inline-flex;align-items:center;gap:3px;border:1px solid var(--ui-stroke-secondary);border-radius:999px;padding:0 7px;font-size:10.5px;line-height:17px;white-space:nowrap}
.prs-ok{color:var(--ui-diff-add-foreground);border-color:var(--ui-diff-add-border)}
.prs-bad{color:var(--ui-diff-remove-foreground);border-color:var(--ui-diff-remove-border)}
.prs-wait{color:var(--ui-accent)}
.prs-add{color:var(--ui-diff-add-foreground)}.prs-del{color:var(--ui-diff-remove-foreground)}
.prs-tabs{display:flex;gap:2px;padding:0 8px;border-bottom:1px solid var(--ui-stroke-secondary)}
.prs-tab{background:none;border:0;border-bottom:2px solid transparent;color:var(--ui-text-secondary);padding:7px 9px;cursor:pointer;font:inherit}
.prs-tab[data-on="1"]{color:var(--ui-text-primary);border-bottom-color:var(--ui-accent)}
.prs-sec{padding:10px}
.prs-card{border:1px solid var(--ui-stroke-secondary);border-radius:6px;margin:0 0 10px;background:var(--ui-bg-card)}
.prs-card-h{display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--ui-stroke-tertiary);font-size:11.5px;color:var(--ui-text-secondary)}
.prs-card-h .prs-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prs-md{padding:8px 10px;line-height:1.55;overflow-wrap:anywhere}
.prs-md img{max-width:100%;height:auto;border-radius:4px;border:1px solid var(--ui-stroke-tertiary)}
.prs-md img[data-loading]{min-height:40px;min-width:80px;background:var(--ui-bg-tertiary)}
.prs-md pre{background:var(--ui-bg-tertiary);padding:8px;border-radius:4px;overflow:auto}
.prs-md code{font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px}
.prs-md blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--ui-stroke-primary);color:var(--ui-text-secondary)}
.prs-md table{border-collapse:collapse;display:block;overflow:auto}
.prs-md td,.prs-md th{border:1px solid var(--ui-stroke-secondary);padding:3px 7px}
.prs-md a{color:var(--ui-accent)}
.prs-md p{margin:4px 0}.prs-md ul,.prs-md ol{padding-left:20px;margin:4px 0}
.prs-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.prs-ta{width:100%;min-height:64px;resize:vertical;color:var(--ui-text-primary);border-width:1px;border-style:solid;border-radius:2.5px;padding:6px 8px;font:inherit}
.prs-ta:focus{outline:none;border-color:var(--ui-accent)}
.prs-file{border:1px solid var(--ui-stroke-secondary);border-radius:6px;margin:0 0 10px;overflow:hidden}
.prs-file-h{display:flex;gap:6px;align-items:center;padding:6px 8px;background:var(--ui-bg-tertiary);cursor:pointer;position:sticky;top:0;z-index:1}
.prs-file-h .prs-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px}
.prs-diff{width:100%;border-collapse:collapse;font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px;table-layout:fixed}
.prs-diff td{padding:0 6px;vertical-align:top;white-space:pre-wrap;word-break:break-all;line-height:18px}
.prs-diff td.n{width:42px;text-align:right;color:var(--ui-text-quaternary);user-select:none;cursor:pointer;padding:0 4px}
.prs-diff td.n:hover{color:var(--ui-accent)}
.prs-diff tr.a td.c,.prs-diff td.c.a{background:var(--ui-diff-add-background)}
.prs-diff tr.d td.c,.prs-diff td.c.d{background:var(--ui-diff-remove-background)}
.prs-diff tr.h td{background:var(--ui-bg-quaternary);color:var(--ui-text-tertiary)}
.prs-diff tr.x>td{padding:6px 8px;background:var(--ui-bg-secondary);white-space:normal;word-break:normal;font-family:var(--font-sans,inherit);font-size:12.5px}
.prs-thread{border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:var(--ui-bg-card);margin:2px 0}
.prs-bar{border-top:1px solid var(--ui-stroke-secondary);padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--ui-bg-secondary)}
.prs-empty{padding:24px 16px;text-align:center;color:var(--ui-text-tertiary);line-height:1.6}
.prs-head{padding:10px;border-bottom:1px solid var(--ui-stroke-secondary)}
.prs-h1{font-size:15px;font-weight:600;line-height:1.35;margin:4px 0 6px;word-break:break-word}
.prs-link{background:none;border:0;padding:0;color:var(--ui-accent);cursor:pointer;font:inherit}
.prs-ic{background:none;border:0;padding:2px 4px;color:var(--ui-text-tertiary);cursor:pointer;border-radius:3px;display:inline-flex;align-items:center}
.prs-ic:hover{color:var(--ui-text-primary);background:var(--ui-bg-tertiary)}
.prs-ic[data-on="1"]{color:var(--ui-accent)}
.prs{position:relative}
.prs-viewer{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;background:color-mix(in srgb,var(--ui-base,#000) 82%,transparent);backdrop-filter:blur(6px)}
.prs-viewer-bar{display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid var(--ui-stroke-secondary);color:var(--ui-text-secondary)}
.prs-viewer-img{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:12px;cursor:zoom-out}
.prs-viewer-img img{max-width:100%;height:auto;border-radius:4px;border:1px solid var(--ui-stroke-tertiary)}
.prs-viewer-img[data-full="1"] img{max-width:none}
`

// ------------------------------------------------------------- primitives
const Ic = (name, size = 14) => jsx(Codicon, { name, size })

function IconBtn({ icon, title, onClick, on }) {
  return jsx('button', {
    className: 'prs-ic', title, 'aria-label': title, 'data-on': on ? '1' : '0',
    onClick: e => { e.stopPropagation(); onClick?.() },
    children: Ic(icon)
  })
}

function Avatar({ user }) {
  if (!user?.avatarUrl) return jsx('span', { className: 'prs-av' })
  return jsx('img', { className: 'prs-av', src: `${user.avatarUrl}${user.avatarUrl.includes('?') ? '&' : '?'}s=40`, alt: '' })
}

function ago(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  const units = [[86400 * 365, 'y'], [86400 * 30, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']]
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`
  return ''
}

function ChecksPill({ state }) {
  if (!state) return null
  const s = String(state).toUpperCase()
  const cls = s === 'SUCCESS' ? 'prs-ok' : ['FAILURE', 'ERROR'].includes(s) ? 'prs-bad' : 'prs-wait'
  const label = s === 'SUCCESS' ? 'checks pass' : ['FAILURE', 'ERROR'].includes(s) ? 'checks fail' : 'checks running'
  return jsx('span', { className: `prs-pill ${cls}`, children: label })
}

function ReviewPill({ decision }) {
  if (!decision) return null
  const map = { APPROVED: ['approved', 'prs-ok'], CHANGES_REQUESTED: ['changes requested', 'prs-bad'], REVIEW_REQUIRED: ['review required', 'prs-wait'] }
  const [label, cls] = map[decision] || [decision.toLowerCase(), '']
  return jsx('span', { className: `prs-pill ${cls}`, children: label })
}

function StatePill({ pr }) {
  const s = pr.isDraft ? 'DRAFT' : pr.state
  const cls = s === 'OPEN' ? 'prs-ok' : s === 'MERGED' ? 'prs-wait' : s === 'CLOSED' ? 'prs-bad' : ''
  return jsx('span', { className: `prs-pill ${cls}`, children: s.toLowerCase() })
}

function ErrorBox({ error, retry }) {
  return jsxs('div', {
    className: 'prs-empty',
    children: [
      jsx('div', { children: errText(error) }),
      retry && jsx('div', { style: { marginTop: 8 }, children: jsx(Button, { size: 'xs', variant: 'outline', onClick: () => retry(), children: 'Retry' }) })
    ]
  })
}

const Loading = ({ label = 'Loading…' }) => jsx('div', { className: 'prs-empty', children: label })

// Sanitized server-side; here we only swap private repo images for proxied data URLs.
function Html({ html }) {
  const ref = useRef(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    let alive = true
    root.querySelectorAll('img[data-gh-src]').forEach(img => {
      const src = img.getAttribute('data-gh-src')
      img.setAttribute('data-loading', '1')
      api(`/image?${q({ url: src })}`)
        .then(r => { if (alive && r?.dataUrl) { img.src = r.dataUrl; img.removeAttribute('data-loading') } })
        .catch(() => {
          if (!alive) return
          img.removeAttribute('data-loading')
          img.alt = `${img.alt || 'image'} (could not load — open on GitHub)`
        })
    })
    // Images open full size inside PR Studio; other links go to the browser.
    root.querySelectorAll('img').forEach(img => {
      img.style.cursor = 'zoom-in'
      img.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        if (!img.src || img.hasAttribute('data-loading')) return
        $viewer.set({ src: img.src, alt: img.alt || '', href: img.closest('a[href]')?.href || img.getAttribute('data-gh-src') || '' })
      })
    })
    root.querySelectorAll('a[href]').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); if (!a.querySelector('img')) CTX.os?.openExternal?.(a.href) })
    })
    return () => { alive = false }
  }, [html])
  if (!html) return jsx('div', { className: 'prs-md prs-faint', children: 'No description.' })
  return jsx('div', { ref, className: 'prs-md', dangerouslySetInnerHTML: { __html: html } })
}

// ---------------------------------------------------------------- PR rows
function PRRow({ pr, repo, showRepo }) {
  const watch = useValue($watch)
  const changes = useValue($watchChanges)
  const key = prKey(repo, pr.number)
  const open = () => openPR(repo, pr.number)
  return jsxs('div', {
    className: 'prs-row', role: 'button', tabIndex: 0, title: `Open #${pr.number}`,
    onClick: open,
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } },
    children: [
      jsx(Avatar, { user: pr.author }),
      jsxs('div', {
        style: { flex: 1, minWidth: 0 },
        children: [
          showRepo && jsx('div', { className: 'prs-repo', children: repo }),
          jsxs('div', { className: 'prs-title', children: [pr.title, ' ', jsx('span', { className: 'prs-faint', children: `#${pr.number}` })] }),
          jsxs('div', {
            className: 'prs-meta',
            children: [
              jsx(StatePill, { pr }),
              jsx(ChecksPill, { state: pr.checks }),
              jsx(ReviewPill, { decision: pr.reviewDecision }),
              jsx('span', { className: 'prs-add', children: `+${pr.additions}` }),
              jsx('span', { className: 'prs-del', children: `−${pr.deletions}` }),
              pr.commentCount ? jsxs('span', { children: [Ic('comment', 11), ' ', pr.commentCount] }) : null,
              jsx('span', { children: `${pr.author?.login || 'ghost'} · ${ago(pr.updatedAt)}` }),
              changes[key] && jsx('span', { className: 'prs-pill prs-wait', children: changes[key] })
            ]
          })
        ]
      }),
      jsx(IconBtn, { icon: watch.includes(key) ? 'eye' : 'eye-closed', on: watch.includes(key), title: watch.includes(key) ? 'Stop watching' : 'Watch for new commits, checks and reviews', onClick: () => toggleWatch(key) })
    ]
  })
}

function matches(pr, f, repo) {
  if (!f) return true
  if (f.startsWith('#')) return String(pr.number) === f.slice(1)
  return `${pr.title} ${pr.author?.login} ${pr.headRefName} ${repo || ''}`.toLowerCase().includes(f)
}

function useGhStatus() {
  return useQuery({ queryKey: [ID, 'status'], queryFn: () => api('/status'), staleTime: 300000 })
}

function SignedOut({ status }) {
  return jsx('div', {
    className: 'prs-empty',
    children: status.gh
      ? jsxs(Fragment, { children: ['GitHub CLI is not signed in. Run ', jsx('code', { children: 'gh auth login' }), ' in a terminal, then retry.'] })
      : jsxs(Fragment, { children: ['Install the GitHub CLI (', jsx('code', { children: 'gh' }), ') and run ', jsx('code', { children: 'gh auth login' }), '.'] })
  })
}

function useProjectRepo() {
  const cwd = useValue(host.state.cwd)
  const fromCwd = useQuery({
    queryKey: [ID, 'cwd', cwd],
    queryFn: () => api(`/repo-from-cwd?${q({ cwd: cwd || '' })}`),
    enabled: Boolean(cwd),
    staleTime: 60000
  })
  return fromCwd.data?.repo || null
}

// ------------------------------------------------------------- inbox scope
// Opens straight onto your open PRs across GitHub — no repository to pick.
function Inbox({ filter }) {
  const projectRepo = useProjectRepo()
  const inbox = useQuery({ queryKey: [ID, 'inbox'], queryFn: () => api('/inbox'), refetchInterval: 90000 })
  const project = useQuery({
    queryKey: [ID, 'pulls', projectRepo, 'OPEN'],
    queryFn: () => api(`/pulls?${q({ repo: projectRepo, state: 'OPEN' })}`),
    enabled: Boolean(projectRepo),
    refetchInterval: 90000
  })
  if (inbox.isLoading) return jsx(Loading, { label: 'Loading your pull requests…' })
  if (inbox.error) {
    // The backend module loads once per Hermes run, so right after an update
    // the new route is missing until Hermes restarts.
    if (/not found|404/i.test(errText(inbox.error))) {
      return jsxs('div', {
        className: 'prs-empty',
        children: [
          jsx('div', { children: 'PR Studio was updated, but the Hermes background service is still running the old version. Restarting it loads the new list (open chats reconnect on their own). Meanwhile, pick a repository from the dropdown above.' }),
          typeof host.restartGateway === 'function' && jsx('div', {
            style: { marginTop: 10 },
            children: jsxs(Button, { size: 'xs', variant: 'outline', onClick: () => host.restartGateway().then(() => queryClient.invalidateQueries({ queryKey: [ID] })), children: [Ic('debug-restart', 12), ' Restart Hermes service'] })
          })
        ]
      })
    }
    return jsx(ErrorBox, { error: inbox.error, retry: inbox.refetch })
  }
  const f = filter.trim().toLowerCase()
  const groups = (inbox.data?.groups || []).map(g => ({ ...g, pulls: g.pulls.map(pr => ({ ...pr, _repo: pr.repo })) }))
  if (projectRepo && project.data?.pulls) {
    const shown = new Set(groups.flatMap(g => g.pulls.map(pr => `${pr._repo}#${pr.number}`)))
    const rest = project.data.pulls.filter(pr => !shown.has(`${projectRepo}#${pr.number}`)).map(pr => ({ ...pr, _repo: projectRepo }))
    groups.push({ id: 'project', label: `Open in ${projectRepo}`, pulls: rest })
  }
  const visible = groups.map(g => ({ ...g, pulls: g.pulls.filter(pr => matches(pr, f, pr._repo)) })).filter(g => g.pulls.length)
  if (!visible.length) {
    return jsx('div', { className: 'prs-empty', children: f ? 'No pull requests match the filter.' : 'No open pull requests need you right now.' })
  }
  return jsx(Fragment, {
    children: visible.map(g => jsxs(Fragment, {
      children: [
        jsxs('div', { className: 'prs-group', children: [g.label, jsx('span', { className: 'prs-count', children: g.pulls.length })] }),
        ...g.pulls.map(pr => jsx(PRRow, { pr, repo: pr._repo, showRepo: g.id !== 'project' }, `${pr._repo}#${pr.number}`))
      ]
    }, g.id))
  })
}

// --------------------------------------------------------- repository scope
const STATES = [{ id: 'OPEN', label: 'Open' }, { id: 'MERGED', label: 'Merged' }, { id: 'CLOSED', label: 'Closed' }, { id: 'ALL', label: 'All' }]

function RepoList({ repo, filter }) {
  const [state, setState] = useState('OPEN')
  const list = useQuery({
    queryKey: [ID, 'pulls', repo, state],
    queryFn: () => api(`/pulls?${q({ repo, state })}`),
    refetchInterval: 90000
  })
  const f = filter.trim().toLowerCase()
  const items = (list.data?.pulls || []).filter(pr => matches(pr, f))
  return jsxs(Fragment, {
    children: [
      jsx('div', { className: 'prs-top', children: jsx(SegmentedControl, { options: STATES, value: state, onChange: setState, sizing: 'content' }) }),
      jsx('div', {
        className: 'prs-scroll',
        children: list.isLoading
          ? jsx(Loading, {})
          : list.error
            ? jsx(ErrorBox, { error: list.error, retry: list.refetch })
            : !items.length
              ? jsx('div', { className: 'prs-empty', children: state === 'OPEN' ? `No open pull requests in ${repo}.` : 'No pull requests.' })
              : items.map(pr => jsx(PRRow, { pr, repo }, pr.number))
      })
    ]
  })
}

// ------------------------------------------------------------ repo dropdown
const OTHER = '__other__'

function RepoSelect() {
  const repo = useValue($repo)
  const projectRepo = useProjectRepo()
  const repos = useQuery({ queryKey: [ID, 'repos'], queryFn: () => api('/repos'), staleTime: 300000 })
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const known = repos.data?.repos || []
  // Keep the current pick listed even if it isn't one of "your" repos.
  const extra = [projectRepo, repo].filter(r => r && r !== ALL && !known.includes(r))
  const options = [...new Set([...extra, ...known])]
  const pick = v => {
    if (v === OTHER) { setText(''); setTyping(true); return }
    setTyping(false)
    setRepo(v)
  }
  const submit = () => {
    const v = text.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '')
    if (/^[\w.-]+\/[\w.-]+$/.test(v)) { setTyping(false); setRepo(v) } else host.notify({ kind: 'warning', message: 'Enter a repository as owner/name' })
  }
  if (typing) {
    return jsxs('div', {
      style: { flex: 1, minWidth: 0, display: 'flex', gap: 4, alignItems: 'center' },
      children: [
        jsx('input', {
          className: 'prs-in desktop-input-chrome', autoFocus: true, value: text, placeholder: 'owner/repo, then Enter',
          onChange: e => setText(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setTyping(false) }
        }),
        jsx(IconBtn, { icon: 'close', title: 'Cancel', onClick: () => setTyping(false) })
      ]
    })
  }
  return jsx('div', {
    style: { flex: 1, minWidth: 0 },
    children: jsxs(Select, {
      value: repo || ALL,
      onValueChange: pick,
      children: [
        jsx(SelectTrigger, { size: 'sm', 'aria-label': 'Repository', children: jsx(SelectValue, {}) }),
        jsxs(SelectContent, {
          children: [
            jsx(SelectItem, { value: ALL, children: 'All my open PRs' }),
            projectRepo && jsx(SelectItem, { value: projectRepo, children: `${projectRepo} · this project` }, `p:${projectRepo}`),
            ...options.filter(r => r !== projectRepo).map(r => jsx(SelectItem, { value: r, children: r }, r)),
            repos.isLoading && jsx(SelectItem, { value: '__loading__', disabled: true, children: 'Loading your repositories…' }),
            jsx(SelectItem, { value: OTHER, children: 'Other repository…' })
          ]
        })
      ]
    })
  })
}

// ---------------------------------------------------------------- PR list
function PRList() {
  const repo = useValue($repo)
  const [filter, setFilter] = useState('')
  const qc = useQueryClient()
  const status = useGhStatus()
  if (status.data && (!status.data.gh || !status.data.login)) return jsx(SignedOut, { status: status.data })
  const all = !repo || repo === ALL
  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'prs-top',
        children: [
          Ic('repo'),
          jsx(RepoSelect, {}),
          jsx(IconBtn, { icon: 'refresh', title: 'Refresh', onClick: () => qc.invalidateQueries({ queryKey: [ID] }) })
        ]
      }),
      jsx('div', { className: 'prs-top', children: jsx(SearchField, { placeholder: 'Filter (#42, title, author, branch)', value: filter, onChange: setFilter, containerClassName: 'w-full' }) }),
      all
        ? jsx('div', { className: 'prs-scroll', children: jsx(Inbox, { filter }) })
        : jsx(RepoList, { repo, filter }, repo)
    ]
  })
}

// ---------------------------------------------------------------- diff
function parsePatch(patch) {
  const rows = []
  if (!patch) return rows
  let o = 0
  let n = 0
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) { o = +m[1]; n = +m[2] }
      rows.push({ t: 'h', text: raw })
    } else if (raw.startsWith('+')) rows.push({ t: 'a', text: raw.slice(1), n: n++ })
    else if (raw.startsWith('-')) rows.push({ t: 'd', text: raw.slice(1), o: o++ })
    else if (raw.startsWith('\\')) rows.push({ t: 'h', text: raw })
    else rows.push({ t: 'c', text: raw.slice(1), o: o++, n: n++ })
  }
  return rows
}

function hunkAround(rows, idx, before = 6) {
  const start = Math.max(0, idx - before)
  return rows.slice(start, idx + 1).filter(r => r.t !== 'h').map(r => (r.t === 'a' ? '+' : r.t === 'd' ? '-' : ' ') + r.text).join('\n')
}

function Thread({ t, repo, pr, hunk }) {
  const qc = useQueryClient()
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const first = t.comments[0]
  const send = async () => {
    setBusy(true)
    try {
      await api('/reply', { method: 'POST', body: { repo, number: pr.number, comment_id: first.databaseId, body: reply } })
      setReply('')
      qc.invalidateQueries({ queryKey: [ID, 'threads', repo, pr.number] })
    } catch (e) { host.notify({ kind: 'error', message: `Reply failed: ${errText(e)}` }) }
    setBusy(false)
  }
  const all = t.comments.map(c => `@${c.author?.login}: ${c.body}`).join('\n\n')
  return jsxs('div', {
    className: 'prs-thread',
    children: [
      t.comments.map(c => jsxs('div', {
        children: [
          jsxs('div', {
            className: 'prs-card-h',
            children: [jsx(Avatar, { user: c.author }), jsx('span', { className: 'prs-grow', children: `${c.author?.login || 'ghost'} · ${ago(c.createdAt)}` })]
          }),
          jsx(Html, { html: c.bodyHTML })
        ]
      }, c.id)),
      jsxs('div', {
        style: { padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6 },
        children: [
          jsx('textarea', { className: 'prs-ta desktop-input-chrome', style: { minHeight: 40 }, placeholder: 'Reply…', value: reply, onChange: e => setReply(e.target.value) }),
          jsxs('div', {
            className: 'prs-actions',
            children: [
              jsx(Button, { size: 'xs', disabled: !reply.trim() || busy, onClick: send, children: 'Reply' }),
              jsxs(Button, {
                size: 'xs', variant: 'outline',
                onClick: () => sendToHermes(promptForComment({ repo, pr, path: t.path, line: t.line || t.originalLine, side: t.diffSide, hunk: hunk || first.diffHunk, author: first.author?.login, body: all, url: first.url })),
                children: [Ic('sparkle', 12), ' Send to Hermes']
              }),
              t.isResolved && jsx('span', { className: 'prs-pill', children: 'resolved' }),
              t.isOutdated && jsx('span', { className: 'prs-pill', children: 'outdated' })
            ]
          })
        ]
      })
    ]
  })
}

function LineComposer({ repo, pr, file, row, side, hunk, onClose }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const line = side === 'LEFT' ? row.o : row.n
  const key = prKey(repo, pr.number)
  const now = async () => {
    setBusy(true)
    try {
      await api('/line-comment', { method: 'POST', body: { repo, number: pr.number, commit_id: pr.headRefOid, path: file.filename, line, side, body: text } })
      host.notify({ kind: 'success', message: 'Comment posted' })
      qc.invalidateQueries({ queryKey: [ID, 'threads', repo, pr.number] })
      onClose()
    } catch (e) { host.notify({ kind: 'error', message: `Comment failed: ${errText(e)}` }) }
    setBusy(false)
  }
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6 },
    children: [
      jsx('div', { className: 'prs-muted', children: `${file.filename}:${line}${side === 'LEFT' ? ' (old)' : ''}` }),
      jsx('textarea', { className: 'prs-ta desktop-input-chrome', autoFocus: true, placeholder: 'Leave a comment, or describe what Hermes should change…', value: text, onChange: e => setText(e.target.value) }),
      jsxs('div', {
        className: 'prs-actions',
        children: [
          jsx(Button, { size: 'xs', disabled: !text.trim() || busy, onClick: () => { addDraft(key, { path: file.filename, line, side, body: text.trim(), hunk }); onClose() }, children: 'Add to review' }),
          jsx(Button, { size: 'xs', variant: 'outline', disabled: !text.trim() || busy, onClick: now, children: 'Comment now' }),
          jsxs(Button, {
            size: 'xs', variant: 'outline', disabled: !text.trim(),
            onClick: () => { sendToHermes(promptForComment({ repo, pr, path: file.filename, line, side, hunk, body: text })); onClose() },
            children: [Ic('sparkle', 12), ' Send to Hermes']
          }),
          jsx(Button, { size: 'xs', variant: 'ghost', onClick: onClose, children: 'Cancel' })
        ]
      })
    ]
  })
}

function FileDiff({ file, repo, pr, threads, split }) {
  const [open, setOpen] = useState(file.status !== 'removed' && (file.additions + file.deletions) < 1500)
  const [composer, setComposer] = useState(null) // {idx, side}
  const rows = useMemo(() => parsePatch(file.patch), [file.patch])
  const drafts = useValue($drafts)[prKey(repo, pr.number)] || []
  const byLine = useMemo(() => {
    const m = {}
    for (const t of threads) {
      const k = `${t.diffSide || 'RIGHT'}:${t.line}`
      if (t.line) (m[k] = m[k] || []).push(t)
    }
    return m
  }, [threads])
  const floating = threads.filter(t => !t.line)
  const badge = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' }[file.status] || '?'
  const colSpan = split ? 4 : 3

  const extras = (idx, row) => {
    const out = []
    const keys = []
    if (row.n != null && row.t !== 'd') keys.push(`RIGHT:${row.n}`)
    if (row.o != null && row.t === 'd') keys.push(`LEFT:${row.o}`)
    for (const k of keys) for (const t of byLine[k] || []) out.push(jsx(Thread, { t, repo, pr, hunk: hunkAround(rows, idx) }, t.id))
    for (const d of drafts) {
      if (d.path === file.filename && ((d.side === 'RIGHT' && row.t !== 'd' && d.line === row.n) || (d.side === 'LEFT' && row.t === 'd' && d.line === row.o))) {
        out.push(jsxs('div', { className: 'prs-thread', style: { padding: 8 }, children: [jsx('span', { className: 'prs-pill prs-wait', children: 'pending' }), ' ', d.body] }, `d${d.line}${d.body}`))
      }
    }
    if (composer && composer.idx === idx) {
      out.push(jsx(LineComposer, { repo, pr, file, row, side: composer.side, hunk: hunkAround(rows, idx), onClose: () => setComposer(null) }, 'composer'))
    }
    return out.length ? jsx('tr', { className: 'x', children: jsx('td', { colSpan, children: out }) }, `x${idx}`) : null
  }

  const num = (val, idx, side) => jsx('td', { className: 'n', title: 'Comment on this line', onClick: () => val != null && setComposer({ idx, side }), children: val ?? '' })

  const body = []
  if (!split) {
    rows.forEach((r, i) => {
      if (r.t === 'h') { body.push(jsx('tr', { className: 'h', children: jsx('td', { colSpan, children: r.text }) }, i)); return }
      body.push(jsxs('tr', {
        className: r.t,
        children: [num(r.o, i, 'LEFT'), num(r.n, i, 'RIGHT'), jsx('td', { className: 'c', children: (r.t === 'a' ? '+' : r.t === 'd' ? '-' : ' ') + r.text })]
      }, i))
      const x = extras(i, r)
      if (x) body.push(x)
    })
  } else {
    // pair consecutive deletions with following additions
    let i = 0
    while (i < rows.length) {
      const r = rows[i]
      if (r.t === 'h') { body.push(jsx('tr', { className: 'h', children: jsx('td', { colSpan, children: r.text }) }, i)); i++; continue }
      if (r.t === 'c') {
        body.push(jsxs('tr', { children: [num(r.o, i, 'LEFT'), jsx('td', { className: 'c', children: r.text }), num(r.n, i, 'RIGHT'), jsx('td', { className: 'c', children: r.text })] }, i))
        const x = extras(i, r); if (x) body.push(x)
        i++; continue
      }
      const dels = []; const adds = []
      while (i < rows.length && rows[i].t === 'd') dels.push(i++)
      while (i < rows.length && rows[i].t === 'a') adds.push(i++)
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const di = dels[k]; const ai = adds[k]
        const d = di != null ? rows[di] : null; const a = ai != null ? rows[ai] : null
        body.push(jsxs('tr', {
          children: [
            d ? num(d.o, di, 'LEFT') : jsx('td', { className: 'n' }), jsx('td', { className: `c ${d ? 'd' : ''}`, children: d ? d.text : '' }),
            a ? num(a.n, ai, 'RIGHT') : jsx('td', { className: 'n' }), jsx('td', { className: `c ${a ? 'a' : ''}`, children: a ? a.text : '' })
          ]
        }, `p${di}-${ai}`))
        if (d) { const x = extras(di, d); if (x) body.push(x) }
        if (a) { const x = extras(ai, a); if (x) body.push(x) }
      }
    }
  }

  return jsxs('div', {
    className: 'prs-file',
    children: [
      jsxs('div', {
        className: 'prs-file-h', onClick: () => setOpen(!open),
        children: [
          Ic(open ? 'chevron-down' : 'chevron-right'),
          jsx('span', { className: 'prs-pill', children: badge }),
          jsx('span', { className: 'prs-grow', title: file.filename, children: file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename }),
          threads.length ? jsxs('span', { className: 'prs-muted', children: [Ic('comment', 11), ` ${threads.length}`] }) : null,
          jsx('span', { className: 'prs-add', children: `+${file.additions}` }),
          jsx('span', { className: 'prs-del', children: `−${file.deletions}` })
        ]
      }),
      open && floating.length > 0 && jsx('div', { style: { padding: 6 }, children: floating.map(t => jsx(Thread, { t, repo, pr }, t.id)) }),
      open && (file.patch
        ? jsxs('table', {
          className: 'prs-diff',
          children: [
            split
              ? jsxs('colgroup', { children: [jsx('col', { style: { width: 42 } }), jsx('col', {}), jsx('col', { style: { width: 42 } }), jsx('col', {})] })
              : jsxs('colgroup', { children: [jsx('col', { style: { width: 42 } }), jsx('col', { style: { width: 42 } }), jsx('col', {})] }),
            jsx('tbody', { children: body })
          ]
        })
        : jsx('div', { className: 'prs-empty', children: file.truncated ? 'Diff too large to show here — open it on GitHub.' : 'Binary or empty file.' }))
    ]
  })
}

function FilesTab({ repo, pr }) {
  const [split, setSplit] = useState(CTX.storage.get('split', false))
  const files = useQuery({ queryKey: [ID, 'files', repo, pr.number, pr.headRefOid], queryFn: () => api(`/files?${q({ repo, number: pr.number })}`) })
  const threads = useQuery({ queryKey: [ID, 'threads', repo, pr.number], queryFn: () => api(`/threads?${q({ repo, number: pr.number })}`), refetchInterval: 60000 })
  if (files.isLoading) return jsx(Loading, {})
  if (files.error) return jsx(ErrorBox, { error: files.error, retry: files.refetch })
  const all = threads.data?.threads || []
  return jsxs('div', {
    className: 'prs-sec',
    children: [
      jsxs('div', {
        className: 'prs-actions', style: { marginBottom: 8 },
        children: [
          jsx('span', { className: 'prs-muted', style: { flex: 1 }, children: `${files.data.files.length} files · click a line number to comment` }),
          jsx(Button, { size: 'xs', variant: split ? 'outline' : 'secondary', onClick: () => { setSplit(false); CTX.storage.set('split', false) }, children: 'Unified' }),
          jsx(Button, { size: 'xs', variant: split ? 'secondary' : 'outline', onClick: () => { setSplit(true); CTX.storage.set('split', true) }, children: 'Split' })
        ]
      }),
      files.data.files.map(f => jsx(FileDiff, { file: f, repo, pr, split, threads: all.filter(t => t.path === f.filename) }, f.filename))
    ]
  })
}

// ------------------------------------------------------------ conversation
function TimelineItem({ item, repo, pr }) {
  const reviewLabel = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'review dismissed' }
  const label = item.kind === 'review' ? reviewLabel[item.state] || 'reviewed' : 'commented'
  const cls = item.state === 'APPROVED' ? 'prs-ok' : item.state === 'CHANGES_REQUESTED' ? 'prs-bad' : ''
  return jsxs('div', {
    className: 'prs-card',
    children: [
      jsxs('div', {
        className: 'prs-card-h',
        children: [
          jsx(Avatar, { user: item.author }),
          jsxs('span', { className: 'prs-grow', children: [jsx('b', { children: item.author?.login || 'ghost' }), ` ${label} · ${ago(item.at)}`] }),
          item.kind === 'review' && item.state !== 'COMMENTED' && jsx('span', { className: `prs-pill ${cls}`, children: reviewLabel[item.state] }),
          item.body && jsx(IconBtn, {
            icon: 'sparkle', title: 'Send to Hermes',
            onClick: () => sendToHermes(promptForComment({ repo, pr, author: item.author?.login, body: item.body, url: item.url }))
          })
        ]
      }),
      item.bodyHTML ? jsx(Html, { html: item.bodyHTML }) : null
    ]
  })
}

function ConversationTab({ repo, pr, refetch }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const post = async () => {
    setBusy(true)
    try {
      await api('/comment', { method: 'POST', body: { repo, number: pr.number, body: text } })
      setText('')
      refetch()
    } catch (e) { host.notify({ kind: 'error', message: `Comment failed: ${errText(e)}` }) }
    setBusy(false)
  }
  return jsxs('div', {
    className: 'prs-sec',
    children: [
      jsxs('div', {
        className: 'prs-card',
        children: [
          jsxs('div', { className: 'prs-card-h', children: [jsx(Avatar, { user: pr.author }), jsx('span', { className: 'prs-grow', children: `${pr.author?.login} opened ${ago(pr.createdAt)}` })] }),
          jsx(Html, { html: pr.bodyHTML })
        ]
      }),
      pr.timeline.map(it => jsx(TimelineItem, { item: it, repo, pr }, it.id)),
      jsx('textarea', { className: 'prs-ta desktop-input-chrome', placeholder: 'Add a comment to the conversation…', value: text, onChange: e => setText(e.target.value) }),
      jsx('div', { className: 'prs-actions', style: { marginTop: 6 }, children: jsx(Button, { size: 'xs', disabled: !text.trim() || busy, onClick: post, children: 'Comment' }) })
    ]
  })
}

function CommitsTab({ pr }) {
  return jsx('div', {
    className: 'prs-sec',
    children: pr.commits.slice().reverse().map(c => jsxs('div', {
      className: 'prs-row', onClick: () => CTX.os?.openExternal?.(c.url),
      children: [
        jsx(Avatar, { user: c.author?.user }),
        jsxs('div', {
          style: { flex: 1, minWidth: 0 },
          children: [
            jsx('div', { className: 'prs-title', style: { fontWeight: 500 }, children: c.messageHeadline }),
            jsxs('div', { className: 'prs-meta', children: [jsx('code', { children: c.abbreviatedOid }), jsx('span', { children: `${c.author?.user?.login || c.author?.name} · ${ago(c.committedDate)}` }), jsx(ChecksPill, { state: c.statusCheckRollup?.state })] })
          ]
        })
      ]
    }, c.oid))
  })
}

function ChecksTab({ pr }) {
  const items = pr.checks.items
  if (!items.length) return jsx('div', { className: 'prs-empty', children: 'No checks reported for the latest commit.' })
  return jsx('div', {
    className: 'prs-sec',
    children: items.map((c, i) => {
      const s = c.state
      const icon = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s) ? 'pass' : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s) ? 'error' : 'loading'
      const cls = icon === 'pass' ? 'prs-add' : icon === 'error' ? 'prs-del' : 'prs-wait'
      return jsxs('div', {
        className: 'prs-row', onClick: () => c.url && CTX.os?.openExternal?.(c.url),
        children: [
          jsx('span', { className: cls, children: Ic(icon) }),
          jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [jsx('div', { children: c.name }), c.description && jsx('div', { className: 'prs-meta', children: c.description })] }),
          jsx('span', { className: 'prs-muted', children: (s || '').toLowerCase() })
        ]
      }, i)
    })
  })
}

// ------------------------------------------------------------- review bar
function ReviewBar({ repo, pr, refetch }) {
  const qc = useQueryClient()
  const key = prKey(repo, pr.number)
  const drafts = useValue($drafts)[key] || []
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [confirm, setConfirm] = useState(null) // event
  const submit = async event => {
    try {
      await api('/review', {
        method: 'POST',
        body: { repo, number: pr.number, event, body: summary, commit_id: pr.headRefOid, comments: drafts.map(({ path, line, side, body }) => ({ path, line, side, body })) }
      })
      clearDrafts(key)
      setSummary('')
      setOpen(false)
      host.notify({ kind: 'success', message: event === 'APPROVE' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Changes requested' : 'Review submitted' })
      refetch()
      qc.invalidateQueries({ queryKey: [ID, 'threads', repo, pr.number] })
    } catch (e) {
      host.notify({ kind: 'error', message: `Review failed: ${errText(e)}` })
      throw e
    }
  }
  const sendAll = () => sendToHermes(
    `Please address these pending review comments on PR #${pr.number} "${pr.title}" in ${repo} (branch ${pr.headRefName}):\n\n` +
    drafts.map((d, i) => `${i + 1}. ${d.path}:${d.line}\n\`\`\`diff\n${d.hunk || ''}\n\`\`\`\n${d.body}`).join('\n\n') +
    `\n\nMake the fixes on the PR branch in this workspace and tell me what changed.`
  )
  const labels = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', COMMENT: 'Submit comments' }
  if (pr.state !== 'OPEN') return null
  return jsxs('div', {
    className: 'prs-bar',
    children: [
      jsxs('div', {
        className: 'prs-actions',
        children: [
          jsx(Button, { size: 'xs', variant: open ? 'secondary' : 'default', onClick: () => setOpen(!open), children: drafts.length ? `Review (${drafts.length} pending)` : 'Review' }),
          drafts.length > 0 && jsxs(Button, { size: 'xs', variant: 'outline', onClick: sendAll, children: [Ic('sparkle', 12), ' Send pending to Hermes'] }),
          drafts.length > 0 && jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => clearDrafts(key), children: 'Discard pending' })
        ]
      }),
      open && jsxs(Fragment, {
        children: [
          drafts.map((d, i) => jsxs('div', {
            className: 'prs-muted', style: { display: 'flex', gap: 6, alignItems: 'center' },
            children: [jsx('code', { children: `${d.path}:${d.line}` }), jsx('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: d.body }), jsx(IconBtn, { icon: 'close', title: 'Remove', onClick: () => removeDraft(key, i) })]
          }, i)),
          jsx('textarea', { className: 'prs-ta desktop-input-chrome', placeholder: 'Review summary (optional for Approve / Comment)', value: summary, onChange: e => setSummary(e.target.value) }),
          jsxs('div', {
            className: 'prs-actions',
            children: [
              jsx(Button, { size: 'xs', disabled: !summary.trim() && !drafts.length, variant: 'outline', onClick: () => setConfirm('COMMENT'), children: 'Comment' }),
              jsx(Button, { size: 'xs', onClick: () => setConfirm('APPROVE'), children: 'Approve' }),
              jsx(Button, { size: 'xs', variant: 'destructive', disabled: !summary.trim() && !drafts.length, onClick: () => setConfirm('REQUEST_CHANGES'), children: 'Request changes' })
            ]
          })
        ]
      }),
      jsx(ConfirmDialog, {
        open: Boolean(confirm),
        onClose: () => setConfirm(null),
        onConfirm: () => submit(confirm),
        title: `${labels[confirm] || ''} on ${repo}#${pr.number}?`,
        description: `This posts to GitHub as you${drafts.length ? `, with ${drafts.length} line comment${drafts.length > 1 ? 's' : ''}` : ''}.`,
        confirmLabel: labels[confirm] || 'Submit',
        busyLabel: 'Submitting…',
        destructive: confirm === 'REQUEST_CHANGES'
      })
    ]
  })
}

// --------------------------------------------------------------- PR detail
function PRDetail({ repo, number }) {
  const watch = useValue($watch)
  const [tab, setTab] = useState(CTX.storage.get('tab', 'conversation'))
  const detail = useQuery({ queryKey: [ID, 'pull', repo, number], queryFn: () => api(`/pull?${q({ repo, number })}`), refetchInterval: 60000 })
  const pickTab = t => { setTab(t); CTX.storage.set('tab', t) }
  const back = jsx(IconBtn, { icon: 'arrow-left', title: 'Back to list', onClick: () => { $viewer.set(null); $selected.set(null) } })
  if (detail.isLoading) return jsxs(Fragment, { children: [jsx('div', { className: 'prs-top', children: back }), jsx(Loading, {})] })
  if (detail.error) return jsxs(Fragment, { children: [jsx('div', { className: 'prs-top', children: back }), jsx(ErrorBox, { error: detail.error, retry: detail.refetch })] })
  const pr = detail.data
  const key = prKey(repo, pr.number)
  const tabs = [['conversation', `Conversation ${pr.timeline.length || ''}`], ['files', `Files ${pr.changedFiles}`], ['commits', `Commits ${pr.commits.length}`], ['checks', 'Checks']]
  return jsxs(Fragment, {
    children: [
      jsxs('div', {
        className: 'prs-head',
        children: [
          jsxs('div', {
            className: 'prs-actions',
            children: [
              back,
              jsx('span', { className: 'prs-muted', style: { flex: 1 }, children: `${repo} #${pr.number}` }),
              jsx(IconBtn, { icon: watch.includes(key) ? 'eye' : 'eye-closed', on: watch.includes(key), title: watch.includes(key) ? 'Stop watching' : 'Watch this PR', onClick: () => toggleWatch(key) }),
              jsx(IconBtn, { icon: 'refresh', title: 'Refresh', onClick: () => detail.refetch() }),
              jsx(IconBtn, { icon: 'link-external', title: 'Open on GitHub', onClick: () => CTX.os?.openExternal?.(pr.url) })
            ]
          }),
          jsx('div', { className: 'prs-h1', children: pr.title }),
          jsxs('div', {
            className: 'prs-meta',
            children: [
              jsx(StatePill, { pr }), jsx(ChecksPill, { state: pr.checks.state }), jsx(ReviewPill, { decision: pr.reviewDecision }),
              jsx('code', { children: `${pr.headRefName} → ${pr.baseRefName}` }),
              jsx('span', { className: 'prs-add', children: `+${pr.additions}` }), jsx('span', { className: 'prs-del', children: `−${pr.deletions}` })
            ]
          }),
          jsxs('div', {
            className: 'prs-actions', style: { marginTop: 8 },
            children: [
              jsxs(Button, { size: 'xs', variant: 'outline', title: 'Send the review request to the chat you have open', onClick: () => sendToHermes(promptForPR(repo, pr)), children: [Ic('sparkle', 12), ' Review in this chat'] }),
              jsx(NewChatReview, { repo, pr })
            ]
          })
        ]
      }),
      jsx('div', { className: 'prs-tabs', children: tabs.map(([id, label]) => jsx('button', { className: 'prs-tab', 'data-on': tab === id ? '1' : '0', onClick: () => pickTab(id), children: label }, id)) }),
      jsx('div', {
        className: 'prs-scroll',
        children: tab === 'files' ? jsx(FilesTab, { repo, pr }) : tab === 'commits' ? jsx(CommitsTab, { pr }) : tab === 'checks' ? jsx(ChecksTab, { pr }) : jsx(ConversationTab, { repo, pr, refetch: detail.refetch })
      }),
      jsx(ReviewBar, { repo, pr, refetch: detail.refetch })
    ]
  })
}

// ------------------------------------------------------------ review flow
// "Review in new chat": create a session pinned to the picked model, start
// the review prompt in it, then open it. session.resume reattaches to the
// live session, so the opened chat shows the review already running.
async function reviewInNewChat(repo, pr, pick) {
  const text = promptForPR(repo, pr)
  try {
    const cwd = host.state.cwd?.get?.() || ''
    const created = await host.request('session.create', {
      model: pick.model,
      provider: pick.provider,
      ...(pick.effort ? { reasoning_effort: pick.effort } : {}),
      ...(cwd ? { cwd } : {}),
      title: `Review PR #${pr.number}`
    }, 60000)
    const sid = created?.session_id
    const stored = created?.stored_session_id || sid
    if (!sid) throw new Error('Hermes did not return a session')
    await host.request('prompt.submit', { session_id: sid, text }, 60000)
    if (typeof host.openSession === 'function') await host.openSession(stored)
    host.notify({ kind: 'success', message: `Reviewing #${pr.number} with ${pick.model} in a new chat` })
  } catch (e) {
    // Fall back to the plain path so the review is never lost.
    host.notify({ kind: 'warning', message: `Could not start a new chat (${errText(e)}). Opening a blank chat with the prompt instead.` })
    host.newChat?.()
    setTimeout(() => sendToHermes(text, 'insert'), 600)
  }
}

function NewChatReview({ repo, pr }) {
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState({ model: '', provider: '', effort: '' })
  const start = (model, provider, effort) => {
    setOpen(false)
    reviewInNewChat(repo, pr, { model, provider, effort: effort ?? pick.effort })
  }
  // The same model menu the chat composer uses; choosing a model starts the review.
  const controller = {
    allowSpeed: false,
    applyPreset: (preset, row) => setPick({ model: row.model, provider: row.provider, effort: preset.effort ?? '' }),
    current: { effort: pick.effort, fast: false, model: pick.model, provider: pick.provider },
    presetFor: () => ({}),
    select: (model, provider) => start(model, provider),
    setOptions: (patch, row) => { if (patch.effort !== undefined) setPick({ model: row.model, provider: row.provider, effort: patch.effort }) }
  }
  return jsxs(DropdownMenu, {
    open, onOpenChange: setOpen,
    children: [
      jsx(DropdownMenuTrigger, { asChild: true, children: jsxs(Button, { size: 'xs', variant: 'outline', children: [Ic('add', 12), ' Review in new chat ', Ic('chevron-down', 11)] }) }),
      jsx(DropdownMenuContent, {
        align: 'start', className: 'w-72 p-0',
        children: jsx(ModelMenuCloseContext.Provider, { value: () => setOpen(false), children: jsx(ModelCatalogMenu, { controller }) })
      })
    ]
  })
}

function ImageViewer() {
  const v = useValue($viewer)
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!v) return
    setFull(false)
    const onKey = e => { if (e.key === 'Escape') $viewer.set(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [v])
  if (!v) return null
  return jsxs('div', {
    className: 'prs-viewer', role: 'dialog', 'aria-label': v.alt || 'Image',
    children: [
      jsxs('div', {
        className: 'prs-viewer-bar',
        children: [
          jsx('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: v.alt || 'Image' }),
          jsx(IconBtn, { icon: full ? 'screen-normal' : 'screen-full', title: full ? 'Fit to pane' : 'Actual size', onClick: () => setFull(!full) }),
          v.href && jsx(IconBtn, { icon: 'link-external', title: 'Open on GitHub', onClick: () => CTX.os?.openExternal?.(v.href) }),
          jsx(IconBtn, { icon: 'close', title: 'Close (Esc)', onClick: () => $viewer.set(null) })
        ]
      }),
      jsx('div', { className: 'prs-viewer-img', 'data-full': full ? '1' : '0', onClick: () => $viewer.set(null), children: jsx('img', { src: v.src, alt: v.alt, onClick: e => { e.stopPropagation(); setFull(!full) } }) })
    ]
  })
}

function Studio() {
  const selected = useValue($selected)
  return jsxs('div', {
    className: 'prs',
    children: [
      jsx('style', { children: CSS }),
      selected
        ? jsx(PRDetail, { repo: selected.repo, number: selected.number }, `${selected.repo}#${selected.number}`)
        : jsx(PRList, {}),
      jsx(ImageViewer, {})
    ]
  })
}

function WatchChip() {
  const watch = useValue($watch)
  const changes = useValue($watchChanges)
  const open = useValue($open)
  const n = Object.keys(changes).length
  const label = open ? 'Close pull requests' : 'Open pull requests'
  return jsxs('button', {
    className: 'prs-ic', 'data-on': open ? '1' : '0',
    title: n ? `${label} · ${n} watched PR${n > 1 ? 's' : ''} changed` : `${label}${watch.length ? ` · watching ${watch.length}` : ''}`,
    'aria-label': label,
    onClick: () => toggleStudio(),
    style: { gap: 4, fontSize: 11 },
    children: [Ic('git-pull-request', 13), watch.length ? jsx('span', { children: n ? `${n} new` : watch.length }) : null]
  })
}

export default {
  id: ID,
  name: 'PR Studio',
  register(ctx) {
    CTX = ctx
    disposing = false
    $repo.set(ctx.storage.get('repo', '') || ALL)
    $watch.set(ctx.storage.get('watch', []))
    $drafts.set(ctx.storage.get('drafts', {}))
    lastSeen = ctx.storage.get('lastSeen', {})

    const items = [
      {
        id: 'open',
        area: PALETTE_AREA,
        data: { id: 'open', label: 'PR Studio: Open / close pull requests', keywords: ['github', 'pr', 'review', 'pull request'], run: () => toggleStudio() }
      },
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 50, render: () => jsx(WatchChip, {}) }
    ]
    // Older desktops without openWorkspace keep the original side pane.
    if (!hasTile()) {
      items.unshift({ id: 'studio', area: 'panes', title: 'PR Studio', data: { placement: 'right', width: '560px' }, render: () => jsx(Studio, {}) })
    }
    ctx.registerMany(items)

    // Disabling or hot-reloading the plugin removes its tile; a reload then
    // reopens it below if it was open, so edits never strand a stale tile.
    ctx.onDispose?.(() => {
      disposing = true
      closeTile?.()
    })
    if (hasTile() && ctx.storage.get('open', false)) openStudio()

    pollWatch(true)
    ctx.setInterval(() => pollWatch(false), 60000)
  }
}
