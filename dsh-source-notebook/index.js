/**
 * Host half of Source Notebook. Owns the source registry, the text index, and
 * the agent tools; the Client half only renders the panel and calls in here.
 *
 * Grounding rule: every answer the tools produce is a quotation of an imported
 * file with a locator (page, slide, or line range). Nothing is invented, and a
 * miss is reported as a miss so the agent can say the sources do not cover it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, basename, resolve, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractDocument, extensionOf, isSupportedPath, SUPPORTED_EXTENSIONS } from './extract.js'

export const name = 'source-notebook'
export const inject = ['fs', 'tools', 'systemPrompt', 'commands']

/*
 * `workspaceRegistry` is deliberately not in `inject`: it is optional, so it is
 * read through `ctx.get('workspaceRegistry')` and the store falls back to the
 * process directory when it has not activated yet.
 */

/* poppler's pdftotext: on PATH, or at the usual Windows install locations. */
const PDFTOTEXT_FLAGS = ['-layout', '-enc', 'UTF-8']
const PDFTOTEXT_CANDIDATES = [
  'pdftotext',
  'pdftotext.exe',
  'C:\\msys64\\ucrt64\\bin\\pdftotext.exe',
  'C:\\msys64\\mingw64\\bin\\pdftotext.exe',
  'C:\\Program Files\\poppler\\Library\\bin\\pdftotext.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe',
  '/usr/bin/pdftotext',
  '/usr/local/bin/pdftotext',
  '/opt/homebrew/bin/pdftotext',
]

/*
 * `pdftotext` recovers slide exports correctly, but it cannot always run: the
 * sandbox can refuse to spawn it. Resolve that once instead of once per file,
 * and remember why it failed so the extractor can report it per file.
 */
const pdfLayoutProbe = (() => {
  let failure = null
  let settled = false
  return {
    /** The executable to use, or null when none of the candidates ran. */
    resolve() {
      if (settled) return failure ? null : this.command || null
      for (const command of PDFTOTEXT_CANDIDATES) {
        try {
          const output = execFileSync(command, ['-v'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true,
          })
          if (typeof output === 'string') {
            settled = true
            this.command = command
            return command
          }
        } catch (error) {
          // pdftotext -v exits non-zero but still proves the binary runs.
          const banner = `${(error && error.stderr) || ''}${(error && error.stdout) || ''}`
          if (/pdftotext version/i.test(banner)) {
            settled = true
            this.command = command
            return command
          }
          // Keep the first real reason: later candidates only say "missing".
          if (!failure) {
            failure = `${command}: ${(error && (error.code || error.message)) || 'unavailable'}`
          }
        }
      }
      settled = true
      ctxLog('info', `source-notebook: pdftotext unavailable (${failure}); PDFs use the built-in reader`)
      return null
    },
    /** Why no candidate ran, once the probe has settled. */
    reason() {
      return failure
    },
  }
})()

function ctxLog(level, message) {
  try {
    if (typeof console[level] === 'function') console[level](message)
  } catch {
    /* logging must never break extraction */
  }
}

const DEFAULTS = {
  maxSources: 400,
  maxSourceBytes: 25165824,
  maxChunksPerSource: 4000,
  searchResults: 8,
  chunkChars: 1200,
}

/** Chunk one fragment into overlapping windows so no sentence is cut in half. */
function chunkFragment(fragment, limit) {
  const pieces = []
  const paragraphs = fragment.text.split(/\n{2,}/)
  let buffer = ''
  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length + 2 > limit) {
      pieces.push(buffer)
      buffer = ''
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    while (buffer.length > limit) {
      pieces.push(buffer.slice(0, limit))
      buffer = buffer.slice(limit)
    }
  }
  if (buffer.trim()) pieces.push(buffer)
  return pieces.filter((piece) => piece.trim())
}

/** Case- and accent-insensitive searchable form, keeping offsets stable. */
function fold(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function tokenizeQuery(query) {
  const words = fold(query).match(/[a-z0-9][a-z0-9+#._-]*/g) || []
  const unique = []
  for (const word of words) {
    if (word.length > 1 && !unique.includes(word)) unique.push(word)
  }
  return unique.slice(0, 12)
}

function countOccurrences(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Best window of a chunk around the words that matched. */
function windowAround(text, words, size) {
  if (text.length <= size) return text
  const folded = fold(text)
  let best = 0
  let bestScore = -1
  for (let start = 0; start < text.length; start += 200) {
    const slice = folded.slice(start, start + size)
    let score = 0
    for (const word of words) if (slice.includes(word)) score += 1
    if (score > bestScore) {
      bestScore = score
      best = start
    }
  }
  const from = Math.max(0, Math.min(best, text.length - size))
  const out = text.slice(from, from + size)
  return `${from > 0 ? '\u2026' : ''}${out}${from + size < text.length ? '\u2026' : ''}`
}

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config || {}) }

  /*
   * One file per workspace, so sources imported in one workspace never appear
   * in another, while every session inside a workspace shares them.
   *
   * The store lives beside the installed package: the loader imports this file
   * as a real ESM module, so its own URL is a stable anchor. A profile that
   * cannot be written still works, it just forgets sources on restart.
   *
   * Files are named after the workspace directory rather than kept in one
   * combined map, so two workspaces cannot overwrite each other's list when
   * both are open at once.
   */
  const stateRoot = (() => {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      return join(here, 'source-notebook')
    } catch {
      return join(process.cwd(), 'source-notebook')
    }
  })()

  /** Folder name for a workspace key, stable across restarts and case. */
  const bucketName = (key) => {
    const tail = basename(key.replace(/[\\/]+$/, '')) || 'workspace'
    const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)
    let hash = 2166136261
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return `${cleaned}-${(hash >>> 0).toString(36)}`
  }

  /**
   * The workspace a Session belongs to, as an absolute directory path.
   *
   * Sessions outlive the workspace they were started in, so the session id is
   * resolved through the durable workspace registry on every call instead of
   * being cached. Without that service the process directory is the fallback.
   * The HTTP endpoint below has no Agent, only a session id from the query.
   */
  const workspaceKeyOf = (sessionId) => {
    if (sessionId) {
      try {
        const registryService = ctx.get('workspaceRegistry')
        if (registryService && typeof registryService.list === 'function') {
          for (const workspace of registryService.list()) {
            if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
              if (typeof workspace.path === 'string' && workspace.path) return workspace.path
            }
          }
        }
      } catch {
        /* an unavailable registry falls through to the directory below */
      }
    }
    return process.cwd()
  }

  /** The workspace of the Agent that issued the current call. */
  const workspaceKey = (agent) => workspaceKeyOf(agent && agent.id)

  /** @type {Map<string, {file: string, registry: Array<object>, documents: Map<string, object>}>} */
  const buckets = new Map()

  const bucketFor = (key) => {
    const name = bucketName(key)
    const cached = buckets.get(name)
    if (cached) return cached
    const bucket = { file: join(stateRoot, `${name}.json`), root: key, registry: [], documents: new Map() }
    buckets.set(name, bucket)
    bucket.registry = loadRegistry(bucket.file, key)
    return bucket
  }

  /** The bucket of the session that issued the current call. */
  const current = (agent) => bucketFor(workspaceKey(agent))

  /*
   * Turn whatever the model or the panel typed into an absolute path.
   *
   * A relative path means "relative to this session's workspace", not to the
   * directory the host process happens to have been started in: those are
   * different directories, and a bare filename like "notes.pdf" used to miss
   * on the first try and only land once the caller retried with an absolute
   * path. A filename with no directory at all is also looked up one level down,
   * so "notes.pdf" still finds "sub/notes.pdf" in a small workspace.
   */
  const resolveSourcePath = (agent, rawPath) => {
    const given = String(rawPath || '').trim().replace(/^"+|"+$/g, '').replace(/^'|'$/g, '')
    if (!given) return { ok: false, error: 'no file path given' }
    const root = workspaceKey(agent)
    if (isAbsolute(given)) {
      return existsSync(given)
        ? { ok: true, path: resolve(given), how: 'absolute' }
        : { ok: false, error: `file not found: ${given}` }
    }
    const direct = resolve(root, given)
    if (existsSync(direct)) return { ok: true, path: direct, how: 'workspace' }
    // A bare name is the common case: search shallowly before giving up.
    if (!/[\\/]/.test(given)) {
      const found = findByName(root, given, 3)
      if (found) return { ok: true, path: found, how: 'workspace-search' }
    }
    return {
      ok: false,
      error: `file not found: ${given} (looked in the workspace ${root})`,
    }
  }

  /** Breadth-first search for one file name beneath `root`, at most `depth` deep. */
  const findByName = (root, wanted, depth) => {
    const target = wanted.toLowerCase()
    let level = [root]
    for (let step = 0; step < depth && level.length; step += 1) {
      const next = []
      for (const directory of level) {
        let names = []
        try {
          names = readdirSync(directory, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of names) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          const full = join(directory, entry.name)
          if (entry.isDirectory()) {
            next.push(full)
          } else if (entry.name.toLowerCase() === target && isSupportedPath(full)) {
            return full
          }
        }
      }
      level = next
    }
    return null
  }

  const loadRegistry = (file, root) => {
    try {
      if (!existsSync(file)) return []
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(parsed && parsed.workspace && parsed.workspace.sources)
        ? parsed.workspace.sources
        : Array.isArray(parsed && parsed.sources)
          ? parsed.sources
          : []
      return list
        .filter((entry) => entry && typeof entry.path === 'string')
        .map((entry) => {
          /*
           * Entries saved before paths were anchored were stored exactly as
           * typed. Re-anchor them on the workspace so an old list keeps working
           * instead of pointing at wherever the host happened to start.
           */
          let stored = entry.path
          if (!isAbsolute(stored)) {
            const fromRoot = resolve(root || process.cwd(), stored)
            stored = existsSync(fromRoot) ? fromRoot : resolve(stored)
          }
          return {
            id: String(entry.id || entry.path),
            path: stored,
            name: String(entry.name || basename(stored)),
            addedAt: String(entry.addedAt || new Date().toISOString()),
            workspaceRelative:
              typeof entry.workspaceRelative === 'string' ? entry.workspaceRelative : null,
          }
        })
    } catch {
      return []
    }
  }

  const saveRegistry = (bucket) => {
    try {
      mkdirSync(dirname(bucket.file), { recursive: true })
      const body = { version: 2, workspace: { sources: bucket.registry } }
      writeFileSync(bucket.file, JSON.stringify(body, null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`source-notebook: could not save the source list: ${error && error.message}`)
    }
  }

  /**
   * PDF text through poppler's `pdftotext -layout`, which is the only reader
   * that recovers reading order from slide exports. This is optional: when the
   * binary is missing or the sandbox blocks spawning, it returns null and the
   * extractor falls back to its own parser.
   */
  const pdfLayout = (path) => {
    const command = pdfLayoutProbe.resolve()
    /* Throwing, rather than returning null, is what makes the extractor put
     * "pdftotext was unavailable (…)" in the per-file warnings. */
    if (!command) throw new Error(pdfLayoutProbe.reason() || 'no PDF text command was found')
    try {
      const output = execFileSync(command, PDFTOTEXT_FLAGS.concat(path), {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30000,
        windowsHide: true,
      })
      return typeof output === 'string' && output.trim() ? output : null
    } catch (error) {
      if (error && error.stdout && String(error.stdout).trim()) return String(error.stdout)
      throw error
    }
  }

  /** Read, extract, and index one file. Returns a summary or a failure reason. */
  const indexSource = (bucket, entry) => {
    const existing = bucket.documents.get(entry.id)
    if (existing) return { ok: true, cached: true, ...summarize(bucket, entry) }
    try {
      const bytes = new Uint8Array(readFileSync(entry.path))
      if (bytes.byteLength > settings.maxSourceBytes) {
        bucket.documents.set(entry.id, {
          fragments: [], chunks: [], format: extensionOf(entry.path).replace(/^\./, ''), chars: 0,
          warnings: [`file is ${Math.round(bytes.byteLength / 1048576)} MB, above the ${Math.round(settings.maxSourceBytes / 1048576)} MB limit; not indexed`],
          addedAt: entry.addedAt,
        })
        return { ok: true, ...summarize(bucket, entry) }
      }
      const extracted = extractDocument(entry.path, bytes, { pdfLayout })
      const chunks = []
      for (const fragment of extracted.fragments.slice(0, settings.maxChunksPerSource)) {
        for (const piece of chunkFragment(fragment, settings.chunkChars)) {
          chunks.push({
            id: `${entry.id}#${chunks.length}`,
            label: fragment.label,
            text: piece,
            folded: fold(piece),
          })
        }
      }
      const chars = extracted.fragments.reduce((total, fragment) => total + fragment.text.length, 0)
      bucket.documents.set(entry.id, {
        fragments: extracted.fragments,
        chunks,
        format: extracted.format,
        chars,
        warnings: extracted.warnings || [],
        addedAt: entry.addedAt,
      })
      return { ok: true, ...summarize(bucket, entry) }
    } catch (error) {
      bucket.documents.set(entry.id, {
        fragments: [], chunks: [], format: extensionOf(entry.path).replace(/^\./, ''), chars: 0,
        warnings: [`could not read the file: ${error && error.message}`],
        addedAt: entry.addedAt,
      })
      return { ok: false, error: `could not read ${entry.name}: ${error && error.message}`, ...summarize(bucket, entry) }
    }
  }

  const summarize = (bucket, entry) => {
    const document = bucket.documents.get(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      format: document ? document.format : extensionOf(entry.path).replace(/^\./, ''),
      chars: document ? document.chars : 0,
      pages: document ? document.fragments.length : 0,
      warnings: document ? document.warnings : [],
      indexed: Boolean(document && document.chars > 0),
    }
  }

  const ensureIndexed = (bucket) => {
    for (const entry of bucket.registry) if (!bucket.documents.has(entry.id)) indexSource(bucket, entry)
  }

  /** Add one file. `rawPath` may be relative; it resolves in the caller's workspace. */
  const addSource = (bucket, rawPath, agent) => {
    const located = resolveSourcePath(agent, rawPath)
    if (!located.ok) return located
    const path = located.path
    if (!isSupportedPath(path)) {
      return { ok: false, error: `unsupported file type; supported: ${SUPPORTED_EXTENSIONS.join(', ')}` }
    }
    if (bucket.registry.length >= settings.maxSources) {
      return { ok: false, error: `source limit reached (${settings.maxSources}); remove a source first` }
    }
    const existing = bucket.registry.find((entry) => entry.path.toLowerCase() === path.toLowerCase())
    if (existing) return { ok: true, duplicate: true, source: summarize(bucket, existing) }
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      name: basename(path),
      addedAt: new Date().toISOString(),
      // Relative to the workspace, so moving the workspace keeps the source.
      workspaceRelative: workspaceRelativePath(bucket, path),
    }
    bucket.registry.push(entry)
    bucket.documents.delete(entry.id)
    const result = indexSource(bucket, entry)
    if (!result.ok) {
      bucket.registry = bucket.registry.filter((candidate) => candidate.id !== entry.id)
      bucket.documents.delete(entry.id)
      return result
    }
    saveRegistry(bucket)
    return { ok: true, source: summarize(bucket, entry), warnings: result.warnings, path, how: located.how }
  }

  /** `path` relative to the bucket's workspace, or null when it sits outside it. */
  const workspaceRelativePath = (bucket, path) => {
    const root = bucket.root
    if (!root) return null
    const rel = relative(root, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return rel.split(sep).join('/')
  }

  const removeSource = (bucket, id) => {
    const entry = bucket.registry.find((candidate) => candidate.id === id || candidate.name === id)
    if (!entry) return { ok: false, error: `no such source: ${id}` }
    bucket.registry = bucket.registry.filter((candidate) => candidate.id !== entry.id)
    bucket.documents.delete(entry.id)
    saveRegistry(bucket)
    return { ok: true, removed: entry.name }
  }

  const listSources = (bucket) => {
    ensureIndexed(bucket)
    return { ok: true, count: bucket.registry.length, sources: bucket.registry.map((entry) => summarize(bucket, entry)) }
  }

  /** Ranked passages across every source, each carrying its own locator. */
  const search = (bucket, query, limit) => {
    ensureIndexed(bucket)
    const words = tokenizeQuery(query)
    if (!words.length) return { ok: true, query, hits: [], note: 'the query had no searchable words' }
    const hits = []
    for (const entry of bucket.registry) {
      const document = bucket.documents.get(entry.id)
      if (!document) continue
      for (const chunk of document.chunks) {
        let score = 0
        for (const word of words) {
          const found = countOccurrences(chunk.folded, word)
          if (found) score += found * (word.length > 4 ? 2 : 1)
        }
        if (!score) continue
        // Prefer chunks that cover more distinct query words.
        const distinct = words.filter((word) => chunk.folded.includes(word)).length
        hits.push({ entry, chunk, score: score + distinct * 6, distinct })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    const top = hits.slice(0, Math.max(1, limit || settings.searchResults))
    return {
      ok: true,
      query,
      terms: words,
      total: hits.length,
      hits: top.map((hit) => ({
        source: hit.entry.name,
        sourceId: hit.entry.id,
        locator: hit.chunk.label,
        excerpt: windowAround(hit.chunk.text, words, 700),
        score: hit.score,
      })),
      note: hits.length
        ? undefined
        : 'no passage in the imported sources matched; the sources do not appear to cover this',
    }
  }

  /** Every passage for one topic, in document order, with locators. */
  const gather = (bucket, topic, budget) => {
    ensureIndexed(bucket)
    const words = tokenizeQuery(topic)
    const picked = []
    for (const entry of bucket.registry) {
      const document = bucket.documents.get(entry.id)
      if (!document) continue
      if (!words.length) {
        for (const chunk of document.chunks) picked.push({ entry, chunk })
        continue
      }
      for (const chunk of document.chunks) {
        if (words.some((word) => chunk.folded.includes(word))) picked.push({ entry, chunk })
      }
    }
    const cap = Math.max(2000, budget || 24000)
    let used = 0
    const passages = []
    for (const item of picked) {
      if (used + item.chunk.text.length > cap) break
      used += item.chunk.text.length
      passages.push({
        source: item.entry.name,
        locator: item.chunk.label,
        text: item.chunk.text,
      })
    }
    return { passages, used, matched: picked.length }
  }

  const coverage = (bucket) => {
    ensureIndexed(bucket)
    const indexed = bucket.registry.filter((entry) => {
      const document = bucket.documents.get(entry.id)
      return document && document.chars > 0
    })
    return { count: bucket.registry.length, indexed: indexed.length }
  }

  const formatPassages = (passages) =>
    passages
      .map((passage) => `[${passage.source} \u2014 ${passage.locator}]\n${passage.text}`)
      .join('\n\n')

  /* ------------------------------------------------------------ host UI -- */

  /*
   * The Sources panel runs in the browser and reaches this host half through
   * slash commands: the Client executes `/source-notebook-list` and reads the
   * JSON payload back out of the `CommandResult.text`. Command results carry
   * text only, so every payload is JSON-encoded here and decoded there.
   */
  const describe = (bucket) => {
    const listed = listSources(bucket)
    return {
      ok: true,
      count: listed.count,
      sources: listed.sources,
      coverage: coverage(bucket),
      supported: SUPPORTED_EXTENSIONS,
    }
  }

  const command = (name, description, handler) => {
    ctx.commands.register({
      name,
      description,
      handler: async (invocation) => {
        try {
          const bucket = current(invocation && invocation.agent)
          return { kind: 'success', text: JSON.stringify(handler(invocation, bucket)) }
        } catch (error) {
          return {
            kind: 'error',
            text: String(error && error.message ? error.message : error),
          }
        }
      },
    })
  }

  command('source-notebook-list', 'List the files indexed by Source Notebook', (_invocation, bucket) => describe(bucket))

  command('source-notebook-add', 'Index a file path as a Source Notebook source', (invocation, bucket) => {
    const path = String(invocation.rawInput || '').trim().replace(/^"+|"+$/g, '')
    if (!path) {
      return { ok: false, error: 'no path given; use /source-notebook-add <path>' }
    }
    const added = addSource(bucket, path, invocation && invocation.agent)
    if (!added.ok) return { ...describe(bucket), ok: false, error: added.error, added }
    return { ...describe(bucket), added }
  })

  command('source-notebook-remove', 'Drop one Source Notebook source by its id', (invocation, bucket) => {
    const id = String(invocation.rawInput || '').trim()
    if (!id) return { ok: false, error: 'no source id given' }
    const removed = removeSource(bucket, id)
    if (!removed.ok) return { ...describe(bucket), ok: false, error: removed.error, removed }
    return { ...describe(bucket), removed }
  })

  /*
   * Read-only JSON endpoint for the Client half.
   *
   * The Sources view needs this list every time it mounts, and a slash command
   * is the wrong carrier for that: each execution appends an entry to the
   * Session log, so opening the tab or switching Sessions left a trail of
   * `source-notebook-list` rows in the Trajectory. The same payload over HTTP
   * never touches the conversation, which is what a refresh should look like.
   * Mutations stay on commands: those are explicit user actions, and one row
   * recording them is worth keeping.
   *
   * `webServer` is optional. Without it (or before the route is mounted) the
   * Client falls back to the command, so a headless composition still works.
   */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (injected) =>
      injected.effect(() => {
        const answer = (response, status, body) => {
          const text = JSON.stringify(body)
          response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(text),
            'cache-control': 'no-store',
          })
          response.end(text)
        }

        const listing = (request, response) => {
          try {
            const method = String((request && request.method) || 'GET').toUpperCase()
            if (method !== 'GET') {
              answer(response, 405, { ok: false, error: 'GET only' })
              return
            }
            let sessionId = ''
            try {
              const url = new URL(String((request && request.url) || '/'), 'http://localhost')
              sessionId = url.searchParams.get('session') || ''
            } catch {
              /* an unparsable URL means "no Session given" */
            }
            answer(response, 200, describe(bucketFor(workspaceKeyOf(sessionId))))
          } catch (error) {
            answer(response, 500, { ok: false, error: String((error && error.message) || error) })
          }
        }

        try {
          return injected.webServer.register({
            kind: 'exact',
            path: '/source-notebook/sources',
            handler: listing,
          })
        } catch (error) {
          // A composition that already claims the path keeps working: the
          // Client falls back to the command.
          ctxLog('warn', `source-notebook: could not serve the source list (${error && error.message})`)
          return () => {}
        }
      }),
    )
  }

  /* -------------------------------------------------------- agent tools -- */

  /**
   * Render a tool result as the text the model reads. The model never sees the
   * raw JSON: citations are the point, so each passage is emitted as
   * "file — locator" followed by its text.
   */
  const renderForModel = (toolName, value) => {
    if (!value || typeof value !== 'object') return String(value)
    if (value.ok === false) return `Error: ${value.summary || value.error || 'the notebook could not complete this request'}`
    const lines = [String(value.summary || '')]
    const passage = (item) => {
      lines.push('')
      lines.push(`[${item.source} \u2014 ${item.locator}]`)
      lines.push(item.text)
    }
    if (toolName === 'notebook_add_source' || toolName === 'notebook_remove_source') {
      for (const source of value.sources || []) {
        lines.push(`- ${source.name} (${source.format}, ${source.chars} chars) id=${source.id} \u2014 ${source.path}`)
      }
      for (const warning of value.warnings || []) lines.push(`Warning: ${warning}`)
    } else if (toolName === 'notebook_search') {
      for (const hit of value.hits || []) passage({ source: hit.source, locator: hit.locator, text: hit.excerpt })
    } else if (toolName === 'notebook_study_guide') {
      for (const item of value.passages || []) passage(item)
    } else if (toolName === 'notebook_practice_exam') {
      for (const area of value.areas || []) {
        lines.push('')
        lines.push(`## ${area.topic} \u2014 ${area.summary}`)
        for (const item of area.passages || []) passage(item)
      }
    }
    return lines.join('\n').trim()
  }

  const statusSchema = { type: 'string', enum: ['found', 'no-match', 'empty', 'ready', 'error'] }
  const passageSchema = {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'File name of the source document.' },
      locator: { type: 'string', description: 'Page, slide, or line range inside that file.' },
      text: { type: 'string', description: 'Quoted passage.' },
    },
    required: ['source', 'locator', 'text'],
    additionalProperties: false,
  }

  const sourcesSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable id; pass it to notebook_remove_source.' },
      name: { type: 'string' },
      path: { type: 'string' },
      format: { type: 'string' },
      chars: { type: 'integer' },
      pages: { type: 'integer', description: 'Page, slide, or section count.' },
      indexed: { type: 'boolean', description: 'False when the file yielded no readable text.' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'name', 'path', 'format', 'chars', 'pages', 'indexed', 'warnings'],
    additionalProperties: false,
  }

  const tools = {
    notebook_add_source: {
      description:
        'Add one file to the source notebook so it can be searched and cited. Pass the path as a plain relative path inside the workspace (for example "notes/lecture.pdf") or a bare file name; it is resolved against the workspace, not the process directory. An absolute path also works. Supported formats are listed in the error when a path is rejected.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to index.' },
        },
        required: ['path'],
      },
      execute: async (input, exec) => {
        const bucket = current(exec && exec.agent)
        const attempt = addSource(bucket, input && input.path, exec && exec.agent)
        if (!attempt.ok) {
          return { ok: false, status: 'error', summary: attempt.error, sources: [], warnings: [] }
        }
        return {
          ok: true,
          status: 'ready',
          summary: attempt.duplicate
            ? `${attempt.source.name} was already in the notebook.`
            : `Indexed ${attempt.source.name} (${attempt.source.chars} characters) from ${attempt.path}.`,
          sources: listSources(bucket).sources,
          warnings: Array.isArray(attempt.warnings) ? attempt.warnings : [],
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: statusSchema,
          summary: { type: 'string' },
          sources: { type: 'array', items: sourcesSchema },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'status', 'summary', 'sources', 'warnings'],
        additionalProperties: false,
      },
    },

    notebook_remove_source: {
      description: 'Remove one file from the source notebook by its id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Source id from notebook_add_source or notebook_search.' },
        },
        required: ['id'],
      },
      execute: async (input, exec) => {
        const bucket = current(exec && exec.agent)
        const attempt = removeSource(bucket, input && input.id)
        return {
          ok: attempt.ok,
          status: attempt.ok ? 'ready' : 'error',
          summary: attempt.ok ? `Removed ${attempt.removed}.` : attempt.error,
          sources: listSources(bucket).sources,
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: statusSchema,
          summary: { type: 'string' },
          sources: { type: 'array', items: sourcesSchema },
        },
        required: ['ok', 'status', 'summary', 'sources'],
        additionalProperties: false,
      },
    },

    notebook_search: {
      name: 'notebook_search',
      description:
        'Search the files the student imported into their source notebook and return the best matching passages. Each passage names its file and its page, slide, or line range.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Words to look for, such as "EPSP summation" or "SSRI reuptake". Matches ignore case and accents.',
          },
          limit: {
            type: 'number',
            description: 'Maximum passages to return, from 1 to 20. Defaults to 8.',
          },
        },
        required: ['query'],
      },
      execute: async (input, exec) => {
        const bucket = current(exec && exec.agent)
        if (!bucket.registry.length) {
          return {
            ok: true,
            status: 'empty',
            summary: 'The source notebook is empty, so there is nothing to search.',
            hits: [],
          }
        }
        const result = search(bucket, input && input.query, input && input.limit)
        return {
          ok: true,
          status: result.hits.length ? 'found' : 'no-match',
          summary: result.hits.length
            ? `${result.hits.length} passage(s) matched out of ${result.total}. Cite them as "file \u2014 locator".`
            : 'No imported source covers this. Tell the student the notebook does not cover it.',
          hits: result.hits.map((hit) => ({
            source: hit.source,
            locator: hit.locator,
            excerpt: hit.excerpt,
          })),
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: statusSchema,
          summary: { type: 'string', description: 'One-line orientation for the model.' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                locator: { type: 'string' },
                excerpt: { type: 'string' },
              },
              required: ['source', 'locator', 'excerpt'],
              additionalProperties: false,
            },
          },
        },
        required: ['ok', 'status', 'summary', 'hits'],
        additionalProperties: false,
      },
    },

    notebook_study_guide: {
      name: 'notebook_study_guide',
      description:
        'Collect the passages from the imported sources that relate to a topic and return them as the material for a study guide. Each passage names its file and its page, slide, or line range.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'The topic to gather material for, such as "synaptic transmission" or "the whole CV".',
          },
          budgetChars: {
            type: 'number',
            description: 'Approximate character budget for the gathered passages. Defaults to 24000.',
          },
        },
        required: ['topic'],
      },
      execute: async (input, exec) => {
        const bucket = current(exec && exec.agent)
        const counts = coverage(bucket)
        if (!counts.indexed) {
          return { ok: true, status: 'empty', summary: 'No indexed sources. Ask the student to add files first.', passages: [] }
        }
        const gathered = gather(bucket, input && input.topic, input && input.budgetChars)
        return {
          ok: true,
          status: gathered.passages.length ? 'ready' : 'no-match',
          summary: gathered.passages.length
            ? `${gathered.passages.length} of ${gathered.matched} matching passages (${
                gathered.used
              } characters) from ${counts.indexed} source(s). Write the guide from these and cite each point.`
            : 'No imported source covers this topic. Tell the student the sources do not cover it.',
          passages: gathered.passages,
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: statusSchema,
          summary: { type: 'string', description: 'One-line orientation for the model.' },
          passages: { type: 'array', items: passageSchema },
        },
        required: ['ok', 'status', 'summary', 'passages'],
        additionalProperties: false,
      },
    },

    notebook_practice_exam: {
      name: 'notebook_practice_exam',
      description:
        'Collect source passages for the requested topic areas and return them as the material for a practice exam, so every answer can be traced back to its file and locator. Report an area the sources do not cover instead of inventing questions for it.',
      parameters: {
        type: 'object',
        properties: {
          topics: {
            type: 'array',
            items: { type: 'string' },
            description: 'Topic areas to draw questions from, for example ["EPSP summation", "neurotransmitter clearance"].',
          },
          questionsPerTopic: {
            type: 'number',
            description: 'How many questions to plan per topic area. Defaults to 3.',
          },
        },
        required: ['topics'],
      },
      execute: async (input, exec) => {
        const bucket = current(exec && exec.agent)
        const counts = coverage(bucket)
        const topics = Array.isArray(input && input.topics) ? input.topics.filter((topic) => typeof topic === 'string') : []
        if (!counts.indexed) {
          return { ok: true, status: 'empty', summary: 'No indexed sources. Ask the student to add files first.', areas: [] }
        }
        if (!topics.length) {
          return {
            ok: true,
            status: 'error',
            summary: 'No topic areas were given; nothing to gather. Ask the student which areas the exam should cover.',
            areas: [],
          }
        }
        const perTopic = Math.max(1, Math.min(10, Number(input && input.questionsPerTopic) || 3))
        const areas = topics.map((topic) => {
          const gathered = gather(bucket, topic, 9000)
          return {
            topic,
            plannedQuestions: gathered.passages.length ? perTopic : 0,
            summary: gathered.passages.length
              ? `${gathered.passages.length} passage(s) support this area.`
              : 'No imported source covers this area; leave it out of the exam.',
            passages: gathered.passages,
          }
        })
        const usable = areas.filter((area) => area.passages.length)
        return {
          ok: true,
          status: usable.length ? 'ready' : 'no-match',
          summary: `${usable.length} of ${topics.length} topic area(s) have supporting material. For each question, name the file and locator of the answer.`,
          areas,
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: statusSchema,
          summary: { type: 'string', description: 'One-line orientation for the model.' },
          areas: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                topic: { type: 'string' },
                plannedQuestions: { type: 'integer', description: 'How many questions this area can support; 0 when uncovered.' },
                summary: { type: 'string' },
                passages: { type: 'array', items: passageSchema },
              },
              required: ['topic', 'plannedQuestions', 'summary', 'passages'],
              additionalProperties: false,
            },
          },
        },
        required: ['ok', 'status', 'summary', 'areas'],
        additionalProperties: false,
      },
    },
  }

  for (const [toolName, definition] of Object.entries(tools)) {
    ctx.effect(() =>
      ctx.tools.register({
        name: toolName,
        description: definition.description,
        parameters: definition.parameters,
        output: {
          schema: definition.outputSchema,
          render: (_args, value) => [{ type: 'text', text: renderForModel(toolName, value) }],
        },
        execute: definition.execute,
      }),
    )
  }

  // Grounding contract: the agent must not answer notebook questions from memory.
  // Placed after the tool-guidance band (the last repository tool section is
  // MCP_SERVERS at 3100) and before TOOLS_SDK at 5000. A prompt section has no
  // calling agent, so it counts whichever workspaces have already been opened.
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'source-notebook',
      order: 3200,
      text: () => {
        let count = 0
        let indexed = 0
        for (const bucket of buckets.values()) {
          const counts = coverage(bucket)
          count += counts.count
          indexed += counts.indexed
        }
        const placement = [
          'Write generated documents into a "notebook" folder at the workspace root, creating it if needed; put transcript exports in "notebook/transcripts".',
          "Never move, rewrite, rename, or delete the student's source files, and never copy one into that folder: files inside \"notebook\" are yours, files outside it belong to the student.",
        ].join('\n')
        if (!count) {
          return [
            'The student has not imported any notebook sources yet. If they ask about their own course material, ask them to add the files from the Sources tab beside the chat.',
            placement,
          ].join('\n')
        }
        return [
          `The student has ${count} source file(s) in the notebook (${indexed} readable).`,
          'For questions about their own material, call notebook_search first and answer from the returned passages only.',
          'Cite every claim as "file \u2014 locator" (for example "synaptic.docx \u2014 lines 12\u201324" or "cortex.pdf \u2014 page 2").',
          'When the sources do not cover something, say plainly that the notebook does not cover it instead of answering from general knowledge.',
          placement,
        ].join('\n')
      },
    }),
  )

  ctx.effect(() => () => {
    for (const bucket of buckets.values()) bucket.documents.clear()
    buckets.clear()
  })

  return {
    listSources: (agent) => listSources(current(agent)),
    addSource: (agent, path) => addSource(current(agent), path, agent),
    removeSource: (agent, id) => removeSource(current(agent), id),
    search: (agent, query, limit) => search(current(agent), query, limit),
    workspaceKey,
  }
}
