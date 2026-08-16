'use strict'
// Regression tests for the character-encoding and style-scoping defects fixed in the
// Oghmere fork. Every assertion in this file FAILS against upstream rtf-parser@1.3.3.
const test = require('tap').test
const parse = require('../index.js')

const BS = String.fromCharCode(92)

/** Build a minimal well-formed document body with the given header extras. */
function doc (extra, body) {
  return `{${BS}rtf1${BS}ansi${extra || ''}{${BS}fonttbl{${BS}f0${BS}fcharset0 Times;}}` +
    `${BS}pard${BS}plain${BS}f0${BS}fs24 ${body}${BS}par}`
}

/** Flatten a parsed document to its text content. */
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

test('literal 8-bit text bytes decode against the document charset', t => {
  // Word and Atlantis write curly quotes as raw CP1252 bytes rather than escapes.
  // Node's 'ascii' decode used to mask the high bit off, silently mangling each one.
  const source = Buffer.concat([
    Buffer.from(doc(null, 'don').replace(`${BS}par}`, ''), 'latin1'),
    Buffer.from([0x92]),
    Buffer.from('t say ', 'latin1'),
    Buffer.from([0x93]),
    Buffer.from('hi', 'latin1'),
    Buffer.from([0x94]),
    Buffer.from(`${BS}par}`, 'latin1')
  ]).toString('latin1')

  parses(t, source, parsed => {
    t.is(textOf(parsed), 'don’t say “hi”')
    t.end()
  })
})

test('\\ansi with no \\ansicpg means CP1252, not US-ASCII', t => {
  // Previously charset 'ASCII' folded every byte >= 0x80 to U+FFFD.
  parses(t, doc(null, `don${BS}'92t say ${BS}'93hi${BS}'94`), parsed => {
    const text = textOf(parsed)
    t.is(text, 'don’t say “hi”')
    t.is(text.indexOf('�'), -1, 'no replacement characters')
    t.end()
  })
})

test('an explicit \\ansicpg is still honoured', t => {
  parses(t, doc(`${BS}ansicpg1251`, `${BS}'cf${BS}'f0${BS}'e8`), parsed => {
    t.is(textOf(parsed), 'При', 'Cyrillic is not forced to CP1252')
    t.end()
  })
})

test('named character control words are emitted, not dropped', t => {
  const body = `A${BS}endash B${BS}emdash C${BS}bullet D${BS}rquote ` +
    `E${BS}lquote F${BS}ldblquote G${BS}rdblquote H`
  parses(t, doc(null, body), parsed => {
    t.is(textOf(parsed), 'A–B—C•D’E‘F“G”H')
    t.end()
  })
})

test('\\ucN fallback characters after \\uNNNN are skipped', t => {
  // \uc1 is Word's default. Without the skip each character came out twice.
  parses(t, doc(`${BS}ansicpg1252${BS}uc1`, `don${BS}u8217${BS}'92t`), parsed => {
    t.is(textOf(parsed), 'don’t', 'hex fallback consumed')
    t.end()
  })
})

test('\\ucN skips a literal fallback character too', t => {
  parses(t, doc(`${BS}ansicpg1252${BS}uc1`, `don${BS}u8217 ?t`), parsed => {
    t.is(textOf(parsed), 'don’t', 'literal ? fallback consumed')
    t.end()
  })
})

test('\\uc0 declares no fallback and must not eat real text', t => {
  parses(t, doc(`${BS}ansicpg1252${BS}uc0`, `don${BS}u8217t`), parsed => {
    t.is(textOf(parsed), 'don’t')
    t.end()
  })
})

test('a nested group keeps the style it was written under', t => {
  // Closing a group re-parents its content; that used to re-stamp each span with the
  // PARENT's style, so `\i text{\i0 roman}` came back with "roman" italic.
  parses(t, doc(null, `${BS}i ITALIC{${BS}i0  roman }MORE${BS}i0  after`), parsed => {
    const spans = parsed.content[0].content.map(s => ({
      text: s.value.trim(),
      italic: s.style.italic
    }))
    t.same(spans, [
      { text: 'ITALIC', italic: true },
      { text: 'roman', italic: false },
      { text: 'MORE', italic: true },
      { text: 'after', italic: false }
    ])
    t.end()
  })
})

test('flat bold and underline toggles still round-trip', t => {
  parses(t, doc(null, `a${BS}b bold${BS}b0  c${BS}ul under${BS}ulnone  d`), parsed => {
    const spans = parsed.content[0].content.map(s => ({
      text: s.value.trim(),
      bold: !!s.style.bold,
      underline: !!s.style.underline
    }))
    t.same(spans, [
      { text: 'a', bold: false, underline: false },
      { text: 'bold', bold: true, underline: false },
      { text: 'c', bold: false, underline: false },
      { text: 'under', bold: false, underline: true },
      { text: 'd', bold: false, underline: false }
    ])
    t.end()
  })
})

test('paragraph alignment and indent survive', t => {
  parse.string(
    `{${BS}rtf1${BS}ansi{${BS}fonttbl{${BS}f0${BS}fcharset0 Times;}}` +
    `${BS}pard${BS}plain${BS}f0${BS}fs24${BS}qc Centered${BS}par` +
    `${BS}ql${BS}fi720 Indented${BS}par}`,
    (err, parsed) => {
      t.ifError(err)
      t.is(parsed.content[0].style.align, 'center')
      t.is(parsed.content[1].style.align, 'left')
      t.is(parsed.content[1].style.firstLineIndent, 720)
      t.end()
    }
  )
})
