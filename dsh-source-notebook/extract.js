/**
 * Dependency-free text extraction for the Source Notebook.
 *
 * Every extractor returns a list of `{ label, text }` fragments. `label` names
 * where the text came from in the user's own terms ("page 4", "slide 12",
 * "lines 40-84"), because those labels are what citations quote back.
 *
 * The runtime a bundle sees has no package resolution, so nothing here may
 * import a third-party parser. PDF, DOCX and PPTX are read straight out of
 * their container formats (FlateDecode via node:zlib, ZIP entries via their
 * central directory). PDF is the one format where that is not enough: readers
 * built on the content stream's draw order cannot recover the reading order of
 * slide exports, so `extractDocument` accepts an optional `pdfLayout` callback.
 * The caller passes poppler's `pdftotext -layout` output; when it is absent or
 * blocked, the built-in reader still runs and `qualityGate` warns when its
 * output is scrambled. Unsupported or scanned documents return a fragment list
 * with only diagnostics; the caller decides how to report them.
 */

import { inflateRawSync, inflateSync } from 'node:zlib'

const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.text', '.rst', '.csv', '.tsv', '.log', '.json', '.yaml', '.yml', '.html', '.htm']

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".pptx", ...TEXT_EXTENSIONS]

export function extensionOf(path) {
  const match = /(\.[^./\\]+)$/.exec(path)
  return match ? match[1].toLowerCase() : ''
}

export function isSupportedPath(path) {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(path))
}

/**
 * @param {string} path
 * @param {Uint8Array} bytes
 * @param {{ pdfLayout?: (path: string) => (string | null) }} [options]
 * @returns {{ format: string, fragments: Array<{ label: string, text: string }>, warnings: string[] }}
 */
/**
 * Dev-only view of one PDF page: the font map the reader built and the raw
 * placed parts, before line joining. Used by the workspace's pdfdiff script.
 */
export function inspectPdfPage(bytes, pageIndex = 0) {
  const text = latin1(Buffer.from(bytes))
  const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g
  const objects = new Map()
  let match
  while ((match = objectPattern.exec(text))) {
    const number = Number(match[1])
    const from = match.index + match[0].length
    const end = text.indexOf('endobj', from)
    if (end < 0) continue
    objects.set(number, { from, end })
    objectPattern.lastIndex = end
  }
  const expanded = expandObjectStreams(text, objects, Buffer.from(bytes))
  const order = collectPageOrder(expanded, objects)
  const entry = order[pageIndex]
  if (!entry) return { error: 'no such page' }
  const span = objects.get(entry.number)
  const dict = expanded.slice(span.from, span.end)
  const fontMap = new Map()
  const resources = entry.resources === null ? resolvePageResources(expanded, objects, dict) : entry.resources
  if (resources) readFontEncodings(expanded, objects, resources, fontMap, Buffer.from(bytes))
  const fonts = []
  for (const [name, font] of fontMap) {
    const sample = new Map()
    let shown = 0
    if (font.cmap) {
      for (const [code, value] of font.cmap.map) {
        if (shown >= 8) break
        sample.set(code, value)
        shown += 1
      }
    }
    fonts.push({
      name,
      encoding: font.encoding,
      codeBytes: font.cmap ? font.cmap.codeBytes : null,
      cmapSize: font.cmap ? font.cmap.map.size : 0,
      sample: Object.fromEntries(sample),
    })
  }
  const content = pageContent(expanded, objects, dict, Buffer.from(bytes))
  return { fonts, contentHead: content ? content.slice(0, 600) : null }
}

export function extractDocument(path, bytes, options = {}) {
  const extension = extensionOf(path)
  try {
    if (extension === '.pdf') return extractPdfDocument(path, bytes, options)
    if (extension === '.docx') return extractDocx(bytes)
    if (extension === '.pptx') return extractPptx(bytes)
    if (TEXT_EXTENSIONS.includes(extension)) return extractPlainText(bytes, extension)
  } catch (error) {
    return {
      format: extension.replace(/^\./, '') || 'unknown',
      fragments: [],
      warnings: [`could not read ${path}: ${messageOf(error)}`],
    }
  }
  return {
    format: extension.replace(/^\./, '') || 'unknown',
    fragments: [],
    warnings: [`unsupported file type ${extension || '(none)'}; supported: ${SUPPORTED_EXTENSIONS.join(', ')}`],
  }
}

/* -------------------------------------------------------------------- pdf -- */

/**
 * PDFs are extracted with poppler's `pdftotext -layout` when the host can run
 * it, because slide-deck exports emit one text block per glyph run in draw
 * order, which defeats any purely local parser. The internal parser stays as a
 * fallback for hosts without poppler, and a quality gate below stops a
 * scrambled fallback result from being indexed as if it were readable.
 */
function extractPdfDocument(path, bytes, options) {
  const warnings = []
  let pdftotextFailure = null
  const layout = typeof options.pdfLayout === 'function' ? options.pdfLayout : null
  if (layout) {
    try {
      const output = layout(path)
      if (typeof output === 'string' && output.trim()) {
        const fragments = splitPdfPages(output)
        if (fragments.length) {
          return { format: 'pdf', fragments, warnings: qualityGate(fragments, warnings, 'pdftotext') }
        }
      }
    } catch (error) {
      pdftotextFailure = messageOf(error)
    }
  }

  const internal = extractPdf(bytes)
  if (layout && !internal.fragments.length) return internal
  const gateWarnings = qualityGate(internal.fragments, internal.warnings, 'the built-in PDF reader')
  if (pdftotextFailure) {
    gateWarnings.push(`pdftotext was unavailable (${pdftotextFailure}); fell back to the built-in PDF reader`)
  }
  return { format: 'pdf', fragments: internal.fragments, warnings: gateWarnings }
}

/**
 * `pdftotext` separates pages with a form feed. Page numbers come from that
 * order, so they still match the printed pages the user sees.
 */
function splitPdfPages(output) {
  const fragments = []
  const pages = output.split('\f')
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index].replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
    if (!page) continue
    fragments.push({ label: `page ${index + 1}`, text: normalizeLayout(reflowSplitGlyphs(page)) })
  }
  return fragments
}

/**
 * Text extracted in draw order reads as letter soup: every word arrives as a
 * scattering of fragments in drawing sequence. That survives word-length checks,
 * because the fragments are still 3-8 letters, but it leaves the letters of each
 * word out of order, so the ratio of words that look like English separates real
 * extraction (~33%) from scrambled extraction (0%).
 */
function qualityGate(fragments, warnings, reader) {
  const text = fragments.map((fragment) => fragment.text).join(' ')
  const tokens = text.split(/\s+/).filter((token) => /[A-Za-z]{2}/.test(token))
  if (tokens.length < 60) return warnings
  let real = 0
  for (const token of tokens) {
    const word = token.replace(/[^A-Za-z]/g, '').toLowerCase()
    if (word.length >= 3 && COMMON_WORDS.has(word)) real += 1
  }
  const ratio = real / tokens.length
  if (ratio < 0.02) {
    warnings.push(
      `${reader} produced scrambled text (almost no recognisable words), so this PDF's reading order could not be recovered and citations from it are unreliable`,
    )
  }
  return warnings
}

/*
 * Deliberately small: a tight word list widens the gap between prose and letter
 * soup, so a low share of these words is a sharp signal. A larger list starts
 * matching fragments such as "section" inside "soitwrcssa".
 */
const COMMON_WORDS = new Set(`
  a an and are as at be been by can do for from has have how in into is it its not
  of on or other our than that the their them then there these they this those to
  up use using was we were what when where which who will with would you your
  access after all also any before both each every file first for from get give
  just like list look make many more most need new next note now once one only
  page per point read right same say see set should show such take time very want
  way well work
  database security data system server user password table role profile control
  privilege session object schema audit policy grant revoke column row index
  oracle instance memory process area global background lecture course code
  college faculty science slide chapter example review question answer summary
  guide study exam practice source document text content information management
`.trim().split(/\s+/))

function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

/* ------------------------------------------------------------------ text -- */

function extractPlainText(bytes, extension) {
  let text = decodeText(bytes)
  if (extension === '.html' || extension === '.htm') text = htmlToText(text)
  return {
    format: extension.replace(/^\./, ''),
    fragments: splitIntoLabels(text),
    warnings: [],
  }
}

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8', skip: 3 },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le', skip: 4 },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be', skip: 4 },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le', skip: 2 },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be', skip: 2 },
]

function decodeText(bytes) {
  for (const bom of BOMS) {
    if (bom.bytes.every((value, index) => bytes[index] === value)) {
      return new TextDecoder(bom.encoding, { fatal: false }).decode(bytes.subarray(bom.skip))
    }
  }
  // Heuristic UTF-16 without a BOM: an ASCII-dominated document puts a zero in
  // every other byte. Only trust it when the sample is unambiguous.
  const sample = Math.min(bytes.length, 4096) & ~1
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < sample; index += 2) {
    if (bytes[index] === 0) evenZeros += 1
    if (bytes[index + 1] === 0) oddZeros += 1
  }
  const pairs = Math.max(1, sample / 2)
  if (oddZeros / pairs > 0.6 && evenZeros / pairs < 0.1) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(bytes)
  }
  if (evenZeros / pairs > 0.6 && oddZeros / pairs < 0.1) {
    return new TextDecoder('utf-16be', { fatal: false }).decode(bytes)
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = ENTITIES[body]
    return named === undefined ? whole : named
  })
}

/**
 * Plain text has no internal page markers, so ~45-line chunks are labelled by
 * their line range. Line ranges are still exact citations a student can find.
 */
function splitIntoLabels(text) {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
  const lines = normalized.split('\n')
  const fragments = []
  const chunkLines = 45
  for (let start = 0; start < lines.length; start += chunkLines) {
    const body = lines.slice(start, start + chunkLines).join('\n').trim()
    if (!body) continue
    const first = start + 1
    const last = Math.min(lines.length, start + chunkLines)
    fragments.push({ label: first === last ? `line ${first}` : `lines ${first}\u2013${last}`, text: body })
  }
  return fragments
}

/* ------------------------------------------------------------------- pdf -- */

function extractPdf(bytes) {
  const warnings = []
  const pages = []
  let text = latin1(bytes)

  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) {
    return {
      format: 'pdf',
      fragments: [],
      warnings: ['document is encrypted or password-protected; export a plain PDF copy to include it as a source'],
    }
  }

  const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g
  const objects = new Map()
  let match
  while ((match = objectPattern.exec(text))) {
    const number = Number(match[1])
    const from = match.index + match[0].length
    const end = text.indexOf('endobj', from)
    if (end < 0) continue
    // Later definitions win: an appended update section overrides the original.
    objects.set(number, { from, end })
    objectPattern.lastIndex = end
  }

  // Offsets recorded above stay valid; packed object bodies are appended.
  text = expandObjectStreams(text, objects, bytes)

  // Page order lives in the page tree; when the tree cannot be walked, object
  // order is a usable approximation and the warning says so.
  const order = []
  const treeOrder = collectPageOrder(text, objects)
  if (treeOrder.length) {
    order.push(...treeOrder)
    if (order.length !== countPageObjects(text)) {
      warnings.push('page tree may be incomplete; page numbers follow the trailer /Root /Pages order')
    }
  } else {
    for (const [number, span] of objects) {
      const dict = text.slice(span.from, Math.min(span.end, span.from + 4096))
      if (/\/Type\s*\/Page\b/.test(dict) && !/\/Type\s*\/Pages\b/.test(dict)) order.push({ number, resources: null })
    }
    if (order.length > 1) warnings.push('page tree unavailable; page numbers follow object order and may differ from the printed pages')
  }

  let scannedCandidates = 0
  for (let index = 0; index < order.length; index += 1) {
    const pageNumber = index + 1
    const entry = order[index]
    const span = objects.get(entry.number)
    if (!span) continue
    const dict = text.slice(span.from, span.end)
    const fontMap = new Map()
    const resources = entry.resources === null ? resolvePageResources(text, objects, dict) : entry.resources
    if (resources) readFontEncodings(text, objects, resources, fontMap, bytes)
    let pageText = ''
    let drewImage = false
    const content = pageContent(text, objects, dict, bytes)
    if (content != null) {
      const result = renderContentStream(content, fontMap)
      pageText = result.text
      drewImage = result.drewImage
    }
    if (!pageText.trim()) {
      if (drewImage) scannedCandidates += 1
      continue
    }
    pages.push({ label: `page ${pageNumber}`, text: normalizeLayout(pageText) })
  }

  if (scannedCandidates > 0) {
    warnings.push(`${scannedCandidates} page(s) drew images without a text layer (scanned or photographed pages); those pages have no searchable text`)
  }
  return { format: 'pdf', fragments: pages, warnings }
}

/**
 * Many writers squeeze every non-stream object into an /ObjStm. Fonts and their
 * /ToUnicode maps usually live there, so without unpacking them the text decodes
 * through fallback tables and loses ligatures. Only dictionaries are recovered:
 * a stream's bytes are never re-embedded, so /Length values stay untouched.
 */
function expandObjectStreams(text, objects, bytes) {
  // Scan the bytes rather than the object map: the files that need this pass most
  // can have the object stream's own dictionary packed inside another one.
  const streams = []
  const objStmPattern = /(\d+)\s+\d+\s+obj\b/g
  let objStm
  while ((objStm = objStmPattern.exec(text))) {
    const from = objStm.index + objStm[0].length
    const end = text.indexOf('endobj', from)
    if (end < 0) continue
    const dict = text.slice(from, Math.min(end, from + 2048))
    if (/\/Type\s*\/ObjStm\b/.test(dict)) streams.push(Number(objStm[1]))
  }
  if (!streams.length) return text

  const packed = new Map()
  for (const number of streams) {
    const span = objects.get(number)
    if (!span) continue
    const header = text.slice(span.from, span.end)
    const countMatch = /\/N\s+(\d+)/.exec(header)
    const firstMatch = /\/First\s+(\d+)/.exec(header)
    if (!countMatch || !firstMatch) continue
    const count = Number(countMatch[1])
    const first = Number(firstMatch[1])
    if (!Number.isSafeInteger(count) || count <= 0 || count > 100000) continue
    const body = streamOf(text, objects, number, bytes)
    if (body == null) continue
    const pairs = []
    const numberPattern = /(\d+)\s+(\d+)/g
    const head = body.slice(0, Math.min(first, body.length))
    let pair
    while ((pair = numberPattern.exec(head)) && pairs.length < count) {
      pairs.push({ number: Number(pair[1]), offset: Number(pair[2]) })
    }
    for (let index = 0; index < pairs.length; index += 1) {
      const start = first + pairs[index].offset
      const stop = index + 1 < pairs.length ? first + pairs[index + 1].offset : body.length
      if (start >= body.length || stop <= start) continue
      packed.set(pairs[index].number, body.slice(start, Math.min(stop, body.length)))
    }
  }
  if (!packed.size) return text
  // Packed bodies are appended to the uncompressed view so existing offsets keep
  // pointing at the same bytes; only lookups for absent objects reach them.
  let appended = text
  for (const [number, body] of packed) {
    if (objects.has(number)) continue
    const from = appended.length
    appended += ` ${body} `
    objects.set(number, { from, end: appended.length, packed: true })
  }
  return appended
}

function countPageObjects(text) {
  const total = /\/(?:Count)\s+(\d+)/.exec(text)
  if (total) {
    const value = Number(total[1])
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  const matches = text.match(/\/Type\s*\/Page[^s]/g)
  return matches ? matches.length : 0
}

function resolvePageResources(text, objects, dict) {
  const direct = /\/Resources\s*(\d+)\s+\d+\s+R/.exec(dict)
  if (direct) {
    const span = objects.get(Number(direct[1]))
    return span ? text.slice(span.from, span.end) : null
  }
  const inline = /\/Resources\s*<</.exec(dict)
  if (inline) {
    const start = inline.index + inline[0].length - 2
    const end = matchBalancedDictionary(text, start)
    return end > 0 ? text.slice(start, end) : null
  }
  return null
}

function readFontEncodings(text, objects, resources, fontMap, bytes) {
  const fontDictMatch = /\/Font\s*(?:(\d+)\s+\d+\s+R|<<)/.exec(resources)
  if (!fontDictMatch) return
  let fontDict = ''
  if (fontDictMatch[1]) {
    const span = objects.get(Number(fontDictMatch[1]))
    if (span) fontDict = text.slice(span.from, span.end)
  } else {
    const start = fontDictMatch.index + fontDictMatch[0].length - 2
    const end = matchBalancedDictionary(resources, start)
    if (end > 0) fontDict = resources.slice(start, end)
  }
  const entryPattern = /\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g
  let entry
  while ((entry = entryPattern.exec(fontDict))) {
    const span = objects.get(Number(entry[2]))
    if (!span) continue
    const fontObject = text.slice(span.from, span.end)
    const composite = /\/Subtype\s*\/Type0/.test(fontObject)
    const encoding = composite ? 'ucs2' : 'latin1'
    const cmap = readToUnicode(text, objects, fontObject, bytes)
    fontMap.set(entry[1], { encoding, cmap, widths: readWidths(text, objects, fontObject) })
  }
}

/**
 * Glyph advances from /FirstChar + /Widths (or /W). The numbers only size text
 * runs so neighbours can be spaced correctly; they never alter characters. A
 * font without usable widths reports null and the caller falls back to a guess.
 */
function readWidths(text, objects, fontObject) {
  /*
   * A simple font lists advances per character code from /FirstChar. A composite
   * font lists them per CID instead, either as explicit /W ranges or implicitly
   * from /DW, and those are the fonts whose runs carry no ink width to fall back
   * on. Both shapes are indexed by code, so the caller reads widths[code] either
   * way. A code the table never mentions advances by /DW; a spike glyph that only
   * delays the next run keeps a width of zero on purpose.
   */
  const firstChar = /\/FirstChar\s+(\d+)/.exec(fontObject)
  const widthsRef = /\/Widths\s*(?:(\d+)\s+\d+\s+R|\[)/.exec(fontObject)
  if (firstChar && widthsRef) {
    let body = ''
    if (widthsRef[1]) {
      const span = objects.get(Number(widthsRef[1]))
      if (!span) return null
      body = text.slice(span.from, span.end)
    } else {
      const anchor = widthsRef.index + widthsRef[0].length - 1
      const end = matchBracket(fontObject, anchor)
      body = end > 0 ? fontObject.slice(anchor, end) : ''
    }
    const numbers = body.match(/-?\d+(?:\.\d+)?/g) || []
    if (!numbers.length) return null
    return { first: Number(firstChar[1]), list: numbers.map(Number) }
  }
  const cidFont = descendantFont(text, objects, fontObject) || fontObject
  if (!/\/Subtype\s*\/CIDFontType2/.test(cidFont)) return null
  const table = readCidWidths(text, objects, cidFont)
  if (!table) return null
  const codes = [...table.keys()].sort((left, right) => left - right)
  const first = codes[0]
  const list = []
  for (let index = 0; index < codes.length; index += 1) {
    const value = table.get(first + index)
    list.push(value === undefined ? 0 : value)
  }
  return { first, list }
}

/**
 * The CIDFont dictionary a /Type0 font delegates its metrics to. The wrapper the
 * page names in Tf holds the encoding and the CMap; the advances live one level
 * down in /DescendantFonts, which is a plain reference to a CIDFontType2 object.
 */
function descendantFont(text, objects, fontObject) {
  const reference = /\/DescendantFonts\s*\[?\s*(\d+)\s+\d+\s+R/.exec(fontObject)
  if (!reference) return null
  const span = objects.get(Number(reference[1]))
  return span ? text.slice(span.from, span.end) : null
}

/**
 * The CID advance table of a /W array, in both permitted forms: one width for a
 * range of CIDs ("120 130 600") and a run of widths for consecutive CIDs
 * ("4 [1030 1145 ...]"). CIDs the array never mentions advance by /DW.
 */
function readCidWidths(text, objects, fontObject) {
  const reference = /\/W\s*(?:(\d+)\s+\d+\s+R|\[)/.exec(fontObject)
  if (!reference) return null
  const dwMatch = /\/DW\s+(\d+(?:\.\d+)?)/.exec(fontObject)
  const defaultWidth = dwMatch ? Number(dwMatch[1]) : 1000
  let body = ''
  if (reference[1]) {
    const span = objects.get(Number(reference[1]))
    if (!span) return null
    body = text.slice(span.from, span.end)
  } else {
    const anchor = reference.index + reference[0].length - 1
    const end = matchBracket(fontObject, anchor)
    body = end > 0 ? fontObject.slice(anchor, end) : ''
  }
  const table = new Map()
  const tokens = body.match(/\[|\]|-?\d+(?:\.\d+)?/g) || []
  let implied = -1
  let cursor = 0
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token === ']') {
      cursor += 1
      continue
    }
    if (token === '[') {
      cursor += 1
      while (cursor < tokens.length && tokens[cursor] !== ']') {
        const width = Number(tokens[cursor])
        if (implied >= 0 && Number.isFinite(width)) table.set(implied, width)
        implied += 1
        cursor += 1
      }
      cursor += 1
      continue
    }
    const startCid = Number(token)
    if (tokens[cursor + 1] === '[') {
      implied = startCid
      cursor += 1
      continue
    }
    if (cursor + 2 < tokens.length) {
      const lastCid = Number(tokens[cursor + 1])
      const width = Number(tokens[cursor + 2])
      const stop = Math.min(lastCid, startCid + 65535)
      for (let cid = startCid; cid <= stop; cid += 1) table.set(cid, width)
      implied = lastCid + 1
      cursor += 3
      continue
    }
    cursor += 1
  }
  return table.size ? table : null
}

/**
 * A /ToUnicode CMap is the only reliable way to recover real characters from a
 * subset font: the raw bytes are glyph ids. Without it a ligature encoded as one
 * glyph disappears ("Pr" + "ole" for "Profile"), so this table is worth reading.
 */
function readToUnicode(text, objects, fontObject, bytes) {
  const reference = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObject)
  if (!reference) return null
  const stream = streamOf(text, objects, Number(reference[1]), bytes)
  if (!stream) return null
  const map = new Map()
  let codeBytes = 1
  const header = /begincodespacerange([\s\S]{0,2000}?)endcodespacerange/.exec(stream)
  if (header) {
    const range = /<([0-9a-fA-F]+)>/.exec(header[1])
    if (range) codeBytes = Math.max(1, Math.ceil(range[1].length / 2))
  }
  const chars = /beginbfchar([\s\S]*?)endbfchar/g
  let block
  while ((block = chars.exec(stream))) {
    const pair = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g
    let entry
    while ((entry = pair.exec(block[1]))) {
      map.set(entry[1].toUpperCase(), utf16FromHex(entry[2]))
    }
  }
  const ranges = /beginbfrange([\s\S]*?)endbfrange/g
  while ((block = ranges.exec(stream))) {
    const triple = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([\s\S]*?)\])/g
    let entry
    while ((entry = triple.exec(block[1]))) {
      const low = Number.parseInt(entry[1], 16)
      const high = Number.parseInt(entry[2], 16)
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low || high - low > 65535) continue
      const width = entry[1].length
      if (entry[3] !== undefined) {
        for (let code = low; code <= high; code += 1) {
          const key = code.toString(16).toUpperCase().padStart(width, '0')
          // Only the final UTF-16 unit walks with the range; any lead-in is fixed.
          const tail = entry[3].slice(-4)
          const prefix = entry[3].slice(0, -4)
          const start = Number.parseInt(tail || '0', 16)
          map.set(key, utf16FromHex(prefix) + String.fromCharCode(start + (code - low)))
        }
      } else if (entry[4] !== undefined) {
        const items = entry[4].match(/<([0-9a-fA-F]*)>/g) || []
        items.forEach((item, offset) => {
          const code = low + offset
          if (code > high) return
          const key = code.toString(16).toUpperCase().padStart(width, '0')
          map.set(key, utf16FromHex(item.slice(1, -1)))
        })
      }
    }
  }
  let widest = 0
  let narrowest = 0
  for (const key of map.keys()) {
    if (!widest || key.length > widest) widest = key.length
    if (!narrowest || key.length < narrowest) narrowest = key.length
  }
  if (widest > 0 && widest < codeBytes && narrowest === widest) codeBytes = widest
  return map.size ? { map, codeBytes } : null
}

function utf16FromHex(hex) {
  let out = ''
  for (let index = 0; index < hex.length; index += 4) {
    const unit = hex.slice(index, index + 4)
    if (unit.length < 4) break
    out += String.fromCharCode(Number.parseInt(unit, 16))
  }
  return out
}

/** Turn the font's own escape for a ligature into the letters a reader sees. */
function expandLigatures(text) {
  return text
    .replace(/[\uFB00]/g, 'ff')
    .replace(/[\uFB01]/g, 'fi')
    .replace(/[\uFB02]/g, 'fl')
    .replace(/[\uFB03]/g, 'ffi')
    .replace(/[\uFB04]/g, 'ffl')
    .replace(/[\uFB05\uFB06]/g, 'st')
}

function collectPageOrder(text, objects) {
  const order = []
  const seen = new Set()
  const roots = []
  for (const [number, span] of objects) {
    const dict = text.slice(span.from, Math.min(span.end, span.from + 2048))
    if (/\/Type\s*\/Pages\b/.test(dict) && !/\/Parent\b/.test(dict)) roots.push(number)
  }
  const visit = (number) => {
    if (seen.has(number) || order.length > 20000) return
    seen.add(number)
    const span = objects.get(number)
    if (!span) return
    const dict = text.slice(span.from, span.end)
    if (/\/Type\s*\/Page\b/.test(dict) && !/\/Type\s*\/Pages\b/.test(dict)) {
      order.push({ number, resources: null })
      return
    }
    const kids = /\/Kids\s*\[([\s\S]{0,200000}?)\]/.exec(dict)
    if (!kids) return
    const refs = kids[1].match(/(\d+)\s+\d+\s+R/g) || []
    for (const ref of refs) visit(Number(ref.split(/\s+/)[0]))
  }
  for (const root of roots) visit(root)
  return order
}

/** Concatenate the content streams of one page object. */
function pageContent(text, objects, dict, bytes) {
  const parts = []
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict)
  if (single) {
    const stream = streamOf(text, objects, Number(single[1]), bytes)
    if (stream != null) parts.push(stream)
  } else {
    const array = /\/Contents\s*\[([\s\S]*?)\]/.exec(dict)
    if (array) {
      const refs = array[1].match(/(\d+)\s+\d+\s+R/g) || []
      for (const ref of refs) {
        const stream = streamOf(text, objects, Number(ref.split(/\s+/)[0]), bytes)
        if (stream != null) parts.push(stream)
      }
    }
  }
  return parts.length ? parts.join('\n') : null
}

function streamOf(text, objects, number, bytes) {
  const span = objects.get(number)
  if (!span) return null
  const header = text.slice(span.from, Math.min(span.end, span.from + 4096))
  if (!/\/Length\s*(\d+)(?:\s+\d+\s+R)?/.test(header)) return null
  const streamKeyword = text.indexOf('stream', span.from)
  if (streamKeyword < 0 || streamKeyword > span.end) return null
  let start = streamKeyword + 'stream'.length
  if (text[start] === '\r') start += 1
  if (text[start] === '\n') start += 1
  let end = span.end
  const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(header)
  if (declared) {
    const candidate = start + Number(declared[1])
    if (candidate <= text.length && /^\s*endstream/.test(text.slice(candidate, candidate + 24))) end = candidate
  }
  if (end >= span.end || !declared || !/^\s*endstream/.test(text.slice(end, end + 24))) {
    const fallback = text.lastIndexOf('endstream', span.end)
    if (fallback > start) end = fallback
  }
  if (end <= start) return null
  const raw = bytes.subarray(start, end)
  const isFlate = /\/FlateDecode/.test(header)
  const hasPredictor = /\/Predictor\s+(\d+)/.test(header)
  if (isFlate) {
    try {
      const inflated = inflateSync(raw)
      return latin1(hasPredictor ? applyPngPredictor(inflated) : inflated)
    } catch {
      try {
        return latin1(inflateRawSync(raw))
      } catch {
        return null
      }
    }
  }
  if (/\/Filter/.test(header)) return null
  return latin1(raw)
}

function applyPngPredictor(data) {
  const columns = Number((/\/Columns\s+(\d+)/.exec(latin1(data)) || [])[1] || 0)
  if (!columns || data.length < columns + 1) return data
  const rowLength = columns + 1
  const rows = Math.floor(data.length / rowLength)
  if (rows < 1) return data
  const out = new Uint8Array(rows * columns)
  let previous = new Uint8Array(columns)
  for (let row = 0; row < rows; row += 1) {
    const offset = row * rowLength
    const type = data[offset]
    const current = data.subarray(offset + 1, offset + rowLength)
    const line = new Uint8Array(columns)
    for (let index = 0; index < columns; index += 1) {
      const left = index >= 1 ? line[index - 1] : 0
      const up = previous[index]
      const upperLeft = index >= 1 ? previous[index - 1] : 0
      let value = current[index]
      if (type === 1) value += left
      else if (type === 2) value += up
      else if (type === 3) value += Math.floor((left + up) / 2)
      else if (type === 4) {
        const estimate = left + up - upperLeft
        const dLeft = Math.abs(estimate - left)
        const dUp = Math.abs(estimate - up)
        const dUpperLeft = Math.abs(estimate - upperLeft)
        value += dLeft <= dUp && dLeft <= dUpperLeft ? left : dUp <= dUpperLeft ? up : upperLeft
      }
      line[index] = value & 0xff
    }
    out.set(line, row * columns)
    previous = line
  }
  return out
}

// PDF standard/Finder text strings use a MacRoman-like high range. Mapping
// the printable subset keeps curly quotes and dashes readable instead of
// turning them into mojibake; unspecified slots fall back to U+2022.
const HIGH_RANGE_GLYPHS = {
  0x80: 0x2022, 0x81: 0x2022, 0x82: 0x2020, 0x83: 0x2021, 0x84: 0x2022, 0x85: 0x2022, 0x86: 0x00B6, 0x87: 0x2022, 
  0x88: 0x2070, 0x89: 0x00A3, 0x8A: 0x00A7, 0x8B: 0x00AB, 0x8C: 0x00AC, 0x8D: 0x00AE, 0x8E: 0x00A5, 0x8F: 0x2022, 
  0x90: 0x2022, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9D: 0x2022, 0x9E: 0x017E, 0x9F: 0x0178, 
  0xA0: 0x0020, 0xA1: 0x00A1, 0xA2: 0x00A2, 0xA3: 0x00A3, 0xA4: 0x2044, 0xA5: 0x00A5, 0xA6: 0x0192, 0xA7: 0x00A7, 
  0xA8: 0x00A4, 0xA9: 0x0027, 0xAA: 0x201C, 0xAB: 0x00AB, 0xAC: 0x2039, 0xAD: 0x203A, 0xAE: 0xFB01, 0xAF: 0xFB02, 
  0xB0: 0x0020, 0xB1: 0x2013, 0xB2: 0x2020, 0xB3: 0x2021, 0xB4: 0x00B7, 0xB5: 0x0020, 0xB6: 0x00B6, 0xB7: 0x2022, 
  0xB8: 0x201A, 0xB9: 0x201E, 0xBA: 0x201D, 0xBB: 0x00BB, 0xBC: 0x2026, 0xBD: 0x2030, 0xBE: 0x00BF, 0xBF: 0x00BF, 
  0xC0: 0x0060, 0xC1: 0x00B4, 0xC2: 0x02C6, 0xC3: 0x02DC, 0xC4: 0x00AF, 0xC5: 0x02D8, 0xC6: 0x02D9, 0xC7: 0x00A8, 
  0xC8: 0x00B8, 0xC9: 0x02DA, 0xCA: 0x00B8, 0xCB: 0x02DD, 0xCC: 0x02DB, 0xCD: 0x02C7, 0xCE: 0x2014, 0xCF: 0x00B8, 
  0xD0: 0x2013, 0xD1: 0x2014, 0xD2: 0x201C, 0xD3: 0x201D, 0xD4: 0x2018, 0xD5: 0x2019, 0xD6: 0x00F7, 0xD7: 0x25CA, 
  0xD8: 0x00FF, 0xD9: 0x0178, 0xDA: 0x2044, 0xDB: 0x20AC, 0xDC: 0x2039, 0xDD: 0x203A, 0xDE: 0xFB01, 0xDF: 0xFB02, 
  0xE0: 0x2021, 0xE1: 0x00B7, 0xE2: 0x201A, 0xE3: 0x201E, 0xE4: 0x2030, 0xE5: 0x00C2, 0xE6: 0x00CA, 0xE7: 0x00C1, 
  0xE8: 0x00CB, 0xE9: 0x00C8, 0xEA: 0x00CD, 0xEB: 0x00CE, 0xEC: 0x00CF, 0xED: 0x00CC, 0xEE: 0x00D3, 0xEF: 0x00D4, 
  0xF0: 0xF8FF, 0xF1: 0x00D2, 0xF2: 0x00DA, 0xF3: 0x00DB, 0xF4: 0x00D9, 0xF5: 0x0131, 0xF6: 0x02C6, 0xF7: 0x02DC, 
  0xF8: 0x00AF, 0xF9: 0x02D8, 0xFA: 0x02D9, 0xFB: 0x02DA, 0xFC: 0x00B8, 0xFD: 0x02DD, 0xFE: 0x02DB, 0xFF: 0x02C7, 
}

/**
 * Decode one shown string. A /ToUnicode CMap wins when present; otherwise a
 * composite font is read as UTF-16BE and a simple font through the standard
 * high-range glyph table.
 */
function decodeString(value, font) {
  const cmap = font && font.cmap
  if (cmap) {
    // A simple font stores one byte per glyph no matter what the /ToUnicode
    // codespace claims, and its keys are one byte wide. Trusting the declared
    // width here strides past every other byte and loses the text outright.
    const width = font && font.encoding === 'ucs2' ? cmap.codeBytes : 1
    let out = ''
    for (let index = 0; index + width <= value.length; index += width) {
      let key = ''
      for (let offset = 0; offset < width; offset += 1) {
        key += value.charCodeAt(index + offset).toString(16).toUpperCase().padStart(2, '0')
      }
      const mapped = cmap.map.get(key)
      out += mapped === undefined ? fallbackChar(value, index, font.encoding) : mapped
    }
    return expandLigatures(out)
  }
  if (font && font.encoding === 'ucs2') {
    let out = ''
    for (let index = 0; index + 1 < value.length; index += 2) {
      out += String.fromCharCode((value.charCodeAt(index) << 8) | value.charCodeAt(index + 1))
    }
    return expandLigatures(out)
  }
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const glyph = HIGH_RANGE_GLYPHS[code]
    out += String.fromCharCode(glyph === undefined ? code : glyph)
  }
  return expandLigatures(out)
}

function fallbackChar(value, index, encoding) {
  if (encoding === 'ucs2') {
    const unit = value.charCodeAt(index)
    return unit >= 32 && unit !== 127 ? String.fromCharCode(unit) : ''
  }
  const code = value.charCodeAt(index)
  if (code < 32) return /[\t\n]/.test(value[index]) ? value[index] : ''
  return String.fromCharCode(code)
}

/**
 * Enough of a PDF content-stream interpreter to place glyphs: text-showing
 * operators, font selection, and text-matrix translations. Coordinates feed
 * line and paragraph reconstruction only; they are never shown to the user.
 */
function renderContentStream(content, fontMap) {
  const operations = tokenizeContentStream(content)
  const parts = []
  const stack = []
  let textMatrix = [1, 0, 0, 1, 0, 0]
  let lineMatrix = [1, 0, 0, 1, 0, 0]
  // Where the current line began; `Td` offsets are measured from here.
  let lineOrigin = [0, 0]
  let leading = 0
  // Character spacing and horizontal scaling. Slide exports lean on these
  // heavily: a run can be placed glyph by glyph with `Tc` adding the gap
  // between them, so without them every glyph reads as a separate word.
  let charSpace = 0
  let wordSpace = 0
  let scale = 1
  let drewImage = false

  const moveTo = (tx, ty) => {
    lineMatrix = [lineMatrix[0], lineMatrix[1], lineMatrix[2], lineMatrix[3], tx, ty]
    textMatrix = lineMatrix.slice()
  }
  const nextLine = () => {
    moveTo(lineMatrix[4], lineMatrix[5] - leading)
  }
  /**
   * Width of one shown run, and how much of it was spacing rather than ink.
   * `Tc`/`Tw` put the gap inside the run, so a glyph-per-run export announces
   * its word breaks through `spacing`, not through where the next run starts.
   */
  const measureRun = (value, font) => {
    // estimateAdvance already folds in the matrix scale, which is where the
    // font size lives; applying `scale` again shrinks every advance.
    const glyphs = estimateAdvance(value, textMatrix, font)
    let spacing = 0
    if (charSpace) spacing += value.length * charSpace * scale
    if (wordSpace) {
      let spaces = 0
      for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) === 32) spaces += 1
      }
      spacing += spaces * wordSpace * scale
    }
    return { width: glyphs + spacing, spacing }
  }
  const showText = (value) => {
    if (!value) return
    const font = stack.length ? stack[stack.length - 1].font : null
    const decoded = decodeString(value, font)
    const measured = measureRun(value, font)
    const advance = measured.width
    parts.push({
      x: textMatrix[4],
      y: textMatrix[5],
      endX: textMatrix[4] + advance,
      spacing: measured.spacing,
      // Real font size in device units; word gaps are judged against this
      // rather than against a run's own ink width.
      em: Math.hypot(textMatrix[0], textMatrix[1]) || 1,
      text: decoded,
    })
    // Advance the text matrix so successive runs on one line keep their gaps.
    textMatrix = [textMatrix[0], textMatrix[1], textMatrix[2], textMatrix[3], textMatrix[4] + advance, textMatrix[5]]
  }

  for (const operation of operations) {
    const { operator, operands } = operation
    switch (operator) {
      case 'BT':
        /*
         * `BT` opens a fresh text object, so the whole text state string starts
         * over: char/word spacing, horizontal scale and leading must not leak in
         * from the previous object. Carrying them over shifts later lines by the
         * previous line's spacing and loses the gaps between words.
         */
        textMatrix = [1, 0, 0, 1, 0, 0]
        lineMatrix = textMatrix.slice()
        lineOrigin = [0, 0]
        charSpace = 0
        wordSpace = 0
        scale = 1
        leading = 0
        break
      case 'ET':
        break
      case 'Tf':
        stack.push({ font: fontMap.get(nameAt(operands, 0)) || { encoding: 'latin1', cmap: null } })
        break
      case 'TL':
        leading = numberAt(operands, 0, leading)
        break
      case 'Tc':
        charSpace = numberAt(operands, 0, charSpace)
        break
      case 'Tw':
        wordSpace = numberAt(operands, 0, wordSpace)
        break
      case 'Tz':
        scale = numberAt(operands, 0, 100) / 100
        break
      /*
       * These exports continue a line with a small `Td` (4.306 0 Td after a run
       * ending at x=382). Relative to the line origin that would land back on the
       * text, so the offset has to build on the live pen position instead.
       */
      case 'Td':
        moveTo(textMatrix[4] + numberAt(operands, 0, 0), textMatrix[5] + numberAt(operands, 1, 0))
        break
      case 'TD':
        leading = -numberAt(operands, 1, 0)
        moveTo(textMatrix[4] + numberAt(operands, 0, 0), textMatrix[5] + numberAt(operands, 1, 0))
        break
      case 'Tm':
        textMatrix = [
          numberAt(operands, 0, 1), numberAt(operands, 1, 0), numberAt(operands, 2, 0),
          numberAt(operands, 3, 1), numberAt(operands, 4, 0), numberAt(operands, 5, 0),
        ]
        lineMatrix = textMatrix.slice()
        // `Td` offsets are measured from this new origin, not the old one.
        lineOrigin = [textMatrix[4], textMatrix[5]]
        break
      case 'T*':
        nextLine()
        break
      case 'Tj':
        showText(stringAt(operands, 0))
        break
      case 'TJ': {
        const array = operands[0]
        if (Array.isArray(array)) {
          /*
           * Each array element is shown in place and the numbers between them
           * move the text matrix, so those kerning offsets are the real word
           * gaps. Concatenating the elements first throws the offsets away and
           * welds every word on the line into one broken token.
           */
          for (const item of array) {
            if (typeof item === 'string') {
              showText(item)
            } else if (typeof item === 'number' && Number.isFinite(item)) {
              // Thousandths of an em, scaled by the font size in the matrix.
              const em = Math.hypot(textMatrix[0], textMatrix[1]) || 1
              const shift = (-item / 1000) * em * scale
              textMatrix = [
                textMatrix[0], textMatrix[1], textMatrix[2], textMatrix[3],
                textMatrix[4] + shift, textMatrix[5],
              ]
            }
          }
        }
        break
      }
      case "'":
        nextLine()
        showText(stringAt(operands, 0))
        break
      case '"':
        nextLine()
        showText(stringAt(operands, 2))
        break
      case 'Do':
        drewImage = true
        break
      default:
        break
    }
  }
  return { text: layoutParts(parts), drewImage }
}

/**
 * Approximate where a run ends, so separately placed runs that sit next to each
 * other become "Pro file" -> "Profile" instead of being glued or spaced blindly.
 * A simple font's average advance is close to half an em for text faces; only
 * adjacency decisions depend on this, never the extracted characters.
 */
function estimateAdvance(text, matrix, font) {
  const scaleX = Math.hypot(matrix[0], matrix[1]) || 1
  const widths = font && font.widths
  if (!widths) return text.length * 0.5 * scaleX
  let total = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const advance = widths.list[code - widths.first]
    total += typeof advance === 'number' && advance > 0 ? advance : 500
  }
  return total / 1000 * scaleX
}

function numberAt(operands, index, fallback) {
  const value = operands[index]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringAt(operands, index) {
  const value = operands[index]
  return typeof value === 'string' ? value : ''
}

/** Names arrive as { name }, e.g. /F59 in "Tf"; anything else has no font. */
function nameAt(operands, index) {
  const value = operands[index]
  return value && typeof value === 'object' && typeof value.name === 'string' ? value.name : ''
}

/** Group placed glyph runs into lines, then lines into readable paragraphs. */
function layoutParts(parts) {
  if (!parts.length) return ''
  const lines = []
  const sorted = parts.slice()
  for (let index = 0; index < sorted.length; index += 1) {
    const part = sorted[index]
    let placed = false
    for (const line of lines) {
      /*
       * Wrapped lines in these exports sit only ~2.2pt apart while glyph fragments
       * of one line agree to a fraction of a point, so the band has to stay
       * tighter than the leading or three wrapped lines merge and interleave.
       */
      if (Math.abs(line.y - part.y) <= 1.2 && Math.abs(line.y - part.y) <= 0.6 * (part.em || 12)) {
        line.parts.push(part)
        line.y = (line.y * (line.parts.length - 1) + part.y) / line.parts.length
        placed = true
        break
      }
    }
    if (!placed) lines.push({ y: part.y, parts: [part] })
  }
  /*
   * Gaps within one word are imprecision in the measured run end, and that
   * imprecision is a property of the page rather than of any single line, so
   * the page median gives the floor a value no single line can distort.
   */
  const pageGaps = []
  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x)
    for (let index = 1; index < line.parts.length; index += 1) {
      const observed = line.parts[index].x - line.parts[index - 1].endX
      if (observed > 0) pageGaps.push(observed)
    }
  }
  pageGaps.sort((a, b) => a - b)
  const pageFloor = pageGaps.length ? pageGaps[Math.floor(pageGaps.length / 2)] : 0
  lines.sort((a, b) => b.y - a.y)
  const output = []
  for (const line of lines) {
    /*
     * Sorting first is what makes "smallest gap" meaningful: the fragments
     * of one word are emitted out of order, so their raw sequence says
     * nothing about where the spaces belong.
     */
    line.parts.sort((a, b) => a.x - b.x)
    const positiveGaps = []
    for (let index = 1; index < line.parts.length; index += 1) {
      const observed = line.parts[index].x - line.parts[index - 1].endX
      if (observed > 0) positiveGaps.push(observed)
    }
    positiveGaps.sort((a, b) => a - b)
    /*
     * The smallest positive gap on a line is the best local estimate, but one
     * stray letter break sitting near zero would make every other gap on that
     * line look like a word break. The page median backs it up so a single
     * outlier cannot redefine the line.
     */
    const lineFloor = positiveGaps.length ? Math.max(positiveGaps[0], pageFloor) : pageFloor
    line.parts.sort((a, b) => a.x - b.x)
    let text = ''
    let previousEnd = null
    let previousX = null
    for (const part of line.parts) {
      if (previousEnd !== null) {
        /*
         * A negative offset is not a gap: the exporter re-emits glyphs out of order,
         * so a fragment can start behind where the previous one ends. Reading that as
         * a gap misplaces a space, and sometimes a whole word, so it is left alone.
         */
        const gap = part.x - previousEnd
        const startsLowercase = /^[a-z0-9(,;:.]/.test(part.text)
        const endsOpen = /[A-Za-z0-9,;:(\/-]$/.test(text)
        /*
         * Advances come from the real per-glyph widths, so a measured gap is in
         * device units no matter which font or size produced the run and needs no
         * em-relative threshold. Fragments of one word sit at or below a point,
         * the smallest genuine word gap just above it, and a fragment whose own
         * text ends in whitespace has already given its break away, so that break
         * is honoured whatever the arithmetic says.
         */
        /*
         * Positive gaps cluster at the noise floor measured above, so a fixed
         * point value cannot serve: it splits a word wherever that floor happens
         * to sit above it. Real word breaks stand well clear of the floor.
         */
        /*
         * These exports scatter the same word across fragments whose measured
         * end overlaps the next start, and the imprecision behind that overlap
         * differs from page to page, so no single value separates a letter
         * break from a word break. The line measures its own floor instead:
         * letter breaks cluster at or below zero, so the smallest positive gap
         * on the line is the noise, and a word break stands clear of it.
         */
        /*
         * The imprecision behind a measured run end scales with the type size, so
         * a gap has to be judged against the glyph size that produced it: in a
         * 14pt run the same noise reads as 0.07 and in a 29pt run as 0.15, yet
         * both are the same fraction of an em. A word break is a large fraction.
         */
        const wordGap = Math.max(lineFloor * 2.5, 0.8)
        const tight = gap < wordGap || part.spacing * 2 >= (part.em || 12)
        const wide = gap > wordGap
        const needsSpace = !tight && (wide || (startsLowercase && endsOpen))
if (needsSpace && !/\s$/.test(text) && !/^\s/.test(part.text)) text += ' '
      }
      text += part.text
      previousEnd = part.endX
      previousX = part.x
    }
    const cleaned = text.replace(/\s+$/, '')
    if (cleaned.trim()) {
      const last = line.parts[line.parts.length - 1]
      output.push({ y: line.y, text: cleaned, x: line.parts[0].x, right: last.endX })
    }
  }
  if (!output.length) return ''

  // Wrapped lines sit one line-pitch apart; a new paragraph leaves a bigger gap.
  // Joined wrapped lines get a space, paragraph breaks stay as newlines.
  const pitches = []
  for (let index = 1; index < output.length; index += 1) {
    const pitch = output[index - 1].y - output[index].y
    if (pitch > 0.5) pitches.push(pitch)
  }
  pitches.sort((a, b) => a - b)
  const typicalPitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0
  // A paragraph's body lines stop short of its right edge, so the furthest any
  // line reaches is the best available proxy for that margin. Continuation
  // lines stop near it; headings and short final lines do not.
  const margin = output.reduce((best, line) => Math.max(best, line.right), 0)

  let result = output[0].text
  for (let index = 1; index < output.length; index += 1) {
    const previous = output[index - 1].text
    const current = output[index].text
    const pitch = output[index - 1].y - output[index].y
    const runsOn = margin > 0 && output[index - 1].right > margin * 0.82
    const wrapped = typicalPitch > 0 && pitch < typicalPitch * 1.35 && runsOn
    if (wrapped && /[A-Za-z]-$/.test(previous)) result = `${result.slice(0, -1)}${current}`
    else if (wrapped) result += ` ${current}`
    else result += `\n${current}`
  }
  return result
}

/**
 * Rejoin glyph runs that a spacing-heavy export separated with a space.
 *
 * Some exports place every glyph separately and let tracking (`Tc`) or a blank
 * glyph carry the word gap. Read naively that arrives as "P r o f i l e", which
 * survives a word-shape check because the fragments are still letters. Real
 * prose never does this, so the rewrite only runs on lines where most gaps are
 * single letters: it drops the space between two one-character fragments and
 * keeps the wider gaps as word breaks.
 */
function reflowSplitGlyphs(text) {
  return text
    .split('\n')
    .map((line) => reflowLine(line))
    .join('\n')
}

function reflowLine(line) {
  const pieces = line.split(/([ \t]{2,})/)
  const words = []
  let gaps = []
  let current = ''
  let singles = 0
  let breaks = 0
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]
    if (index % 2 === 1) {
      gaps.push(piece.length)
      continue
    }
    if (!piece) continue
    const tokens = piece.split(' ').filter(Boolean)
    if (!tokens.length) continue
    if (singles + breaks === 0) {
      current = tokens[0]
      tokens.slice(1).forEach((token) => {
        words.push(current)
        current = token
        breaks += 1
      })
      continue
    }
    for (const token of tokens) {
      const previousLast = current.slice(-1)
      if (token.length === 1 || previousLast.length === 1) {
        current += token
        singles += 1
      } else {
        words.push(current)
        current = token
        breaks += 1
      }
    }
  }
  if (current) words.push(current)
  if (singles < 3 || singles < breaks * 2) return line
  let result = words[0] || ''
  for (let index = 1; index < words.length; index += 1) {
    const gap = gaps[index - 1]
    const join =
      words[index].length === 1 ||
      (words[index - 1].slice(-1).length === 1 && gap < 3)
    result += join ? words[index] : ` ${words[index]}`
  }
  return result
}

function normalizeLayout(text) {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function tokenizeContentStream(source) {
  const operations = []
  let operands = []
  let index = 0
  const length = source.length
  while (index < length) {
    const char = source[index]
    if (char === '%') {
      while (index < length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\u0000') {
      index += 1
      continue
    }
    if (char === '/') {
      const start = index + 1
      index = start
      while (index < length && !/[\s/<>[\](){}%]/.test(source[index])) index += 1
      operands.push({ name: source.slice(start, index) })
      continue
    }
    if (char === '(') {
      const parsed = readLiteralString(source, index)
      operands.push(parsed.value)
      index = parsed.next
      continue
    }
    if (char === '<' && source[index + 1] === '<') {
      const end = matchBalancedDictionary(source, index)
      const body = source.slice(index, end > 0 ? end : index + 2)
      // Inline image dictionaries terminate with ID; skip the binary payload.
      const idIndex = body.search(/\bID\b/)
      operands.push({ dict: body })
      index = end > 0 ? end : index + 2
      if (idIndex >= 0) {
        const ei = source.indexOf('EI', index)
        index = ei > 0 ? ei + 2 : length
      }
      continue
    }
    if (char === '<') {
      const end = source.indexOf('>', index)
      const hex = end > 0 ? source.slice(index + 1, end) : ''
      operands.push(hexToBytes(hex))
      index = end > 0 ? end + 1 : length
      continue
    }
    if (char === '[') {
      const end = matchBracket(source, index)
      const inner = source.slice(index + 1, end > 0 ? end - 1 : length)
      const items = []
      let innerIndex = 0
      while (innerIndex < inner.length) {
        if (inner[innerIndex] === '(') {
          const parsed = readLiteralString(inner, innerIndex)
          items.push(parsed.value)
          innerIndex = parsed.next
          continue
        }
        if (inner[innerIndex] === '<') {
          const close = inner.indexOf('>', innerIndex)
          items.push(hexToBytes(inner.slice(innerIndex + 1, close > 0 ? close : inner.length)))
          innerIndex = close > 0 ? close + 1 : inner.length
          continue
        }
        const numberMatch = /^-?(\d+\.?\d*|\.\d+)/.exec(inner.slice(innerIndex))
        if (numberMatch) {
          items.push(Number(numberMatch[0]))
          innerIndex += numberMatch[0].length
          continue
        }
        innerIndex += 1
      }
      operands.push(items)
      index = end > 0 ? end : length
      continue
    }
    const numberMatch = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(source.slice(index, index + 32))
    if (numberMatch) {
      operands.push(Number(numberMatch[0]))
      index += numberMatch[0].length
      continue
    }
    const nameMatch = /^[A-Za-z'"]+[0-9*]*/.exec(source.slice(index, index + 32))
    if (nameMatch) {
      const operator = nameMatch[0]
      operations.push({ operator, operands })
      operands = []
      index += operator.length
      continue
    }
    index += 1
  }
  return operations
}

function hexToBytes(hex) {
  const digits = hex.replace(/[^0-9a-fA-F]/g, '')
  if (digits.length % 2) return ''
  let out = ''
  for (let index = 0; index < digits.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(digits.slice(index, index + 2), 16))
  }
  return out
}

function readLiteralString(source, start) {
  let depth = 0
  let out = ''
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      const next = source[index + 1]
      index += 2
      if (next === 'n') out += '\n'
      else if (next === 'r') out += '\r'
      else if (next === 't') out += '\t'
      else if (next === 'b') out += '\b'
      else if (next === 'f') out += '\f'
      else if (next === '\n' || next === '\r') {
        if (next === '\r' && source[index] === '\n') index += 1
      } else if (next >= '0' && next <= '7') {
        let octal = next
        while (octal.length < 3 && source[index] >= '0' && source[index] <= '7') {
          octal += source[index]
          index += 1
        }
        out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff)
      } else if (next !== undefined) out += next
      continue
    }
    if (char === '(') {
      depth += 1
      if (depth > 1) out += char
      index += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      index += 1
      if (depth === 0) return { value: out, next: index }
      out += char
      continue
    }
    out += char
    index += 1
  }
  return { value: out, next: index }
}

function matchBalancedDictionary(source, start) {
  let depth = 0
  for (let index = start; index < source.length - 1; index += 1) {
    if (source[index] === '<' && source[index + 1] === '<') {
      depth += 1
      index += 1
      continue
    }
    if (source[index] === '>' && source[index + 1] === '>') {
      depth -= 1
      index += 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function matchBracket(source, start) {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] === '[') depth += 1
    else if (source[index] === ']') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function latin1(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
}

/* ------------------------------------------------------------------ docx -- */

function extractDocx(bytes) {
  const entries = readZip(bytes)
  const warnings = []
  const documentXml = entries.get('word/document.xml')
  if (!documentXml) {
    return { format: 'docx', fragments: [], warnings: ['word/document.xml is missing; the file may be a .doc renamed to .docx'] }
  }
  const relationships = new Map()
  const rels = entries.get('word/_rels/document.xml.rels')
  if (rels) {
    const pattern = /<Relationship\b([^>]*)\/?>/g
    let match
    while ((match = pattern.exec(rels))) {
      const id = /\bId="([^"]+)"/.exec(match[1])
      const target = /\bTarget="([^"]+)"/.exec(match[1])
      if (id && target) relationships.set(id[1], target[1])
    }
  }
  const headings = []
  const blocks = []
  const paragraphPattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g
  let match
  while ((match = paragraphPattern.exec(documentXml))) {
    const body = match[1] || ''
    const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(body)
    const style = styleMatch ? styleMatch[1] : ''
    if (/^Heading([1-3])$|^heading ([1-3])$/i.test(style)) {
      const level = Number(/[1-3]/.exec(style)[0])
      const text = docxParagraphText(body)
      if (text) headings.push({ level, text })
    }
    const text = docxParagraphText(body)
    if (text) blocks.push(text)
    else if (blocks.length) blocks.push('')
  }
  const fragments = []
  if (headings.length) {
    const outline = headings.slice(0, 40).map((heading) => `${'  '.repeat(heading.level - 1)}${heading.text}`).join('\n')
    fragments.push({ label: 'outline', text: outline })
  }
  let collected = blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  collected = collected.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')

  // Footnotes and endnotes keep citations a student may need to find.
  const notes = []
  for (const [name, prefix] of [['word/footnotes.xml', 'footnote'], ['word/endnotes.xml', 'endnote']]) {
    const xml = entries.get(name)
    if (!xml) continue
    const notePattern = /<w:(footnote|endnote)\b([^>]*)>([\s\S]*?)<\/w:\1>/g
    let note
    while ((note = notePattern.exec(xml))) {
      if (/w:type="(separator|continuation)/.test(note[2])) continue
      const id = /\bw:id="(\d+)"/.exec(note[2])
      const text = docxParagraphText(note[3])
      if (text && id) notes.push(`${prefix} ${id[1]}: ${text}`)
    }
  }
  if (notes.length) fragments.push({ label: 'notes', text: notes.join('\n') })

  const parts = splitIntoLabels(collected)
  for (const part of parts) fragments.push(part)
  if (!fragments.length) warnings.push('no readable text found in the document body')
  if (!relationships.size) warnings.push('no document relationships; embedded images and footnotes were skipped')
  return { format: 'docx', fragments, warnings }
}

function docxParagraphText(xml) {
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
  let out = ''
  const runPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:delText\b[^>]*>([\s\S]*?)<\/w:delText>/g
  let match
  while ((match = runPattern.exec(withBreaks))) {
    out += decodeEntities(match[1] !== undefined ? match[1] : match[2] || '')
  }
  if (!out) {
    // Fall back to newline markers so a paragraph of only breaks still counts.
    out = withBreaks.includes('\n') ? '' : ''
  }
  return out.replace(/[\t ]+/g, ' ').trim()
}

/* ------------------------------------------------------------------ pptx -- */

function extractPptx(bytes) {
  const entries = readZip(bytes)
  const warnings = []
  const slideNames = []
  for (const name of entries.keys()) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)
    if (match) slideNames.push({ name, number: Number(match[1]) })
  }
  slideNames.sort((a, b) => a.number - b.number)
  if (!slideNames.length && entries.has('ppt/slides/slide1.xml') === false) {
    return { format: 'pptx', fragments: [], warnings: ['no ppt/slides/*.xml parts found; the file may not be a .pptx presentation'] }
  }

  const fragments = []
  const notes = []
  for (const slide of slideNames) {
    const xml = entries.get(slide.name)
    const text = pptxText(xml)
    if (text) fragments.push({ label: `slide ${slide.number}`, text })
    const noteName = `ppt/notesSlides/notesSlide${slide.number}.xml`
    const noteXml = entries.get(noteName)
    if (noteXml) {
      const noteText = pptxText(noteXml)
      if (noteText) notes.push(`slide ${slide.number} notes: ${noteText}`)
    }
  }
  if (notes.length) fragments.push({ label: 'speaker notes', text: notes.join('\n\n') })
  if (!fragments.length) warnings.push('slides contained no text (images only)')
  return { format: 'pptx', fragments, warnings }
}

function pptxText(xml) {
  if (!xml) return ''
  const paragraphs = []
  const paragraphPattern = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>|<a:p\b[^>]*\/>/g
  let match
  while ((match = paragraphPattern.exec(xml))) {
    const body = match[1] || ''
    let text = ''
    const textPattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g
    let run
    while ((run = textPattern.exec(body))) {
      if (run[1] === undefined) text += '\n'
      else text += decodeEntities(run[1])
    }
    text = text.replace(/\s+/g, ' ').trim()
    if (text) paragraphs.push(text)
  }
  return paragraphs.join('\n')
}

/* ------------------------------------------------------------------- zip -- */

/**
 * Read a ZIP central directory. Enough for OOXML: the containers are small and
 * every part these extractors want is stored or deflated.
 */
function readZip(bytes) {
  const entries = new Map()
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  const searchFloor = Math.max(0, buffer.length - 66 * 1024)
  for (let index = buffer.length - 22; index >= searchFloor; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)')
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (uncompressedSize > 64 * 1024 * 1024) continue
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = buffer.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) {
      entries.set(name, data)
    } else if (method === 8) {
      try {
        entries.set(name, inflateRawSync(data))
      } catch {
        if (uncompressedSize === 0) entries.set(name, Buffer.alloc(0))
      }
    }
  }
  return entries
}

/* ------------------------------------------------------------------ util -- */

export { readZip }
