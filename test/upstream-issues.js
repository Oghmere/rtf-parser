'use strict'
// Regression tests for the open upstream issues this fork closes. Each test names the
// iarna/rtf-parser issue or PR it comes from, and uses that report's own reproduction
// wherever the reporter supplied one.
const test = require('tap').test
const parse = require('../index.js')

const BS = String.fromCharCode(92)

function textOf (parsed) {
  return (parsed.content || [])
    .flatMap(p => (p.content || []).map(s => s.value))
    .join('')
}

function parses (t, source, cb) {
  parse.string(source, (err, parsed) => {
    t.ifError(err)
    cb(parsed)
  })
}

test('#41 — styles survive a group (reporter\'s own repro)', t => {
  // Verbatim from the issue, including its \i1 spelling.
  const src = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}
\pard Normal text {\i1 italic text} more normal\par}`
  parses(t, src, parsed => {
    const italic = parsed.content[0].content.find(s => s.value.includes('italic text'))
    t.ok(italic, 'the span exists')
    t.is(italic.style.italic, true, 'and it is italic')
    t.end()
  })
})

test('#40 — the \\uN downlevel fallback is not emitted', t => {
  const src = `{${BS}rtf1${BS}ansi${BS}ansicpg1252${BS}uc1{${BS}fonttbl{${BS}f0 Times;}}` +
    `${BS}pard${BS}plain${BS}f0 caf${BS}u233 ?${BS}par}`
  parses(t, src, parsed => {
    t.is(textOf(parsed), 'café')
    t.end()
  })
})

test('#40/#28 — \\uN accepts BOTH the signed and unsigned forms', t => {
  // The spec writes code units above 32767 as negative; plenty of producers emit the
  // unsigned value, which used to throw ERR_OUT_OF_RANGE (upstream PR #28).
  const src = `{${BS}rtf1${BS}ansi${BS}ansicpg1252${BS}uc0{${BS}fonttbl{${BS}f0 Times;}}` +
    `${BS}pard${BS}plain${BS}f0 [${BS}u61607][${BS}u-3929]${BS}par}`
  parses(t, src, parsed => {
    t.is(textOf(parsed), '[][]', 'both spellings give the same character')
    t.end()
  })
})

test('#15 — an emoji surrogate pair no longer breaks the interpreter', t => {
  // From the #15 thread: "one emoji is expressed with \u55357? \u56842? which will
  // result in a break in interpreter ctrl$u function".
  const src = `{${BS}rtf1${BS}ansi${BS}ansicpg1252${BS}uc1{${BS}fonttbl{${BS}f0 Times;}}` +
    `${BS}pard${BS}plain${BS}f0 hi ${BS}u55357 ?${BS}u56842 ?${BS}par}`
  parses(t, src, parsed => {
    const text = textOf(parsed)
    t.is(text, 'hi \u{1F60A}', 'the halves combine into one astral character')
    t.is([...text].length, 4, 'and it is a single code point')
    t.end()
  })
})

test('#15 — \\fcharset2 (Symbol) bullets decode instead of throwing', t => {
  const src = `{${BS}rtf1${BS}ansi${BS}ansicpg1252{${BS}fonttbl{${BS}f0 Times;}` +
    `{${BS}f2${BS}fnil${BS}fcharset2 Symbol;}}` +
    `${BS}pard${BS}plain${BS}f0 {${BS}f2${BS}'b7}${BS}tab item${BS}par}`
  parses(t, src, parsed => {
    const text = textOf(parsed)
    t.ok(text.includes('•'), 'the Symbol bullet is a real bullet')
    t.ok(text.includes('item'), 'and the list text survives')
    t.end()
  })
})

test('#30/#33 — \\fcharset238 is CP1250, not the non-existent "CP238"', t => {
  // 0xE8 is `č` in CP1250. Under the old 'CP238' this threw.
  const src = `{${BS}rtf1${BS}ansi${BS}ansicpg1252{${BS}fonttbl` +
    `{${BS}f0${BS}fnil${BS}fcharset238 Arial;}}` +
    `${BS}pard${BS}plain${BS}f0 ${BS}'e8${BS}par}`
  parses(t, src, parsed => {
    t.is(textOf(parsed), 'č', 'decoded as CP1250')
    t.end()
  })
})

test('#33 — \\ansicpg1256 is accepted', t => {
  const src = `{${BS}rtf1${BS}ansi${BS}ansicpg1256{${BS}fonttbl{${BS}f0 Arial;}}` +
    `${BS}pard${BS}plain${BS}f0 ${BS}'c7${BS}par}`
  parse.string(src, (err, parsed) => {
    t.ifError(err, 'the codepage is available, so no "not available" error')
    t.is(textOf(parsed), 'ا', 'arabic alef')
    t.end()
  })
})

test('#32 — a \\pict payload does not leak into the document text', t => {
  const src = `{${BS}rtf1${BS}ansi{${BS}fonttbl{${BS}f0 Times;}}${BS}pard${BS}plain${BS}f0 before ` +
    `{${BS}pict${BS}pngblip${BS}picw100${BS}pich100 89504e470d0a1a0a0000000d49484452} after${BS}par}`
  parses(t, src, parsed => {
    const text = textOf(parsed)
    t.is(text, 'before  after', 'the image hex is dropped')
    t.notOk(/89504e47/.test(text), 'no PNG signature in the text')
    t.end()
  })
})

test('an unknown charset falls back rather than aborting the document', t => {
  // \fcharset130 is JOHAB, which iconv does not ship. The document must still parse.
  const src = `{${BS}rtf1${BS}ansi${BS}ansicpg1252{${BS}fonttbl` +
    `{${BS}f0${BS}fnil${BS}fcharset130 Batang;}}` +
    `${BS}pard${BS}plain${BS}f0 text ${BS}'41 more${BS}par}`
  parse.string(src, (err, parsed) => {
    t.ifError(err, 'no throw')
    t.ok(textOf(parsed).includes('text'), 'and the surrounding text survives')
    t.end()
  })
})
