'use strict'
const assert = require('assert')
const util = require('util')

const Writable = require('stream').Writable
const RTFGroup = require('./rtf-group.js')
const RTFParagraph = require('./rtf-paragraph.js')
const RTFSpan = require('./rtf-span.js')
const iconv = require('iconv-lite')

// 1256 (arabic) added — codeToCP already mapped \fcharset178 to it, so a document could
// select it by font but `\ansicpg1256` was rejected as unavailable. Upstream PR
// iarna/rtf-parser#33 by @facue.
const availableCP = [
  437, 737, 775, 850, 852, 853, 855, 857, 858, 860, 861, 863, 865, 866,
  869, 932, 936, 949, 950, 1125, 1250, 1251, 1252, 1253, 1254, 1256, 1257 ]
const codeToCP = {
  0: 'ASCII',
  // The Symbol font is not a code page at all — see SYMBOL_TO_UNICODE below. iconv has no
  // 'SYMBOL' encoding, so decoding against this name used to throw and take the whole
  // document with it (iarna/rtf-parser#15).
  2: 'SYMBOL',
  77: 'MacRoman',
  128: 'SHIFT_JIS',
  129: 'CP949', // Hangul
  130: 'JOHAB',
  134: 'CP936', // GB2312 simplified chinese
  136: 'BIG5',
  161: 'CP1253', // greek
  162: 'CP1254', // turkish
  163: 'CP1258', // vietnamese
  177: 'CP862', // hebrew
  178: 'CP1256', // arabic
  186: 'CP1257',  // baltic
  204: 'CP1251', // russian
  222: 'CP874', // thai
  // \fcharset238 is EASTEUROPE, which is code page 1250. 'CP238' was never a code page and
  // iconv has never known it, so any document with an east-European font threw on its first
  // hex escape (iarna/rtf-parser#30). Upstream PR iarna/rtf-parser#33 by @facue.
  238: 'CP1250', // eastern european
  254: 'CP437' // PC-437
}

/**
 * Adobe Symbol encoding, 0xA0..0xFE — the range RTF actually uses it for.
 *
 * The Symbol font is a glyph set, not a code page: `\fcharset2` with `\'b7` means BULLET,
 * not the CP1252 middle dot. It is how Word writes bulleted lists, which is why
 * iarna/rtf-parser#15 ("Bullet & Numbering") is common in the wild.
 *
 * PARTIAL BY DESIGN: this covers the symbol half, where bullets and list glyphs live. The
 * 0x20..0x7E half maps ASCII positions onto Greek and is left to fall through as ASCII,
 * which is wrong for Greek but harmless for the list case and never throws. Unmapped bytes
 * become U+FFFD rather than aborting the parse.
 */
const SYMBOL_TO_UNICODE = {
  0xa0: '\u20ac', // euro
  0xa3: '\u2264', // less-or-equal
  0xa5: '\u221e', // infinity
  0xa7: '\u2663', // club
  0xa8: '\u2666', // diamond
  0xa9: '\u2665', // heart
  0xaa: '\u2660', // spade
  0xab: '\u2194', // left-right arrow
  0xac: '\u2190', // left arrow
  0xad: '\u2191', // up arrow
  0xae: '\u2192', // right arrow
  0xaf: '\u2193', // down arrow
  0xb0: '\u00b0', // degree
  0xb1: '\u00b1', // plus-minus
  0xb3: '\u2265', // greater-or-equal
  0xb4: '\u00d7', // multiply
  0xb5: '\u221d', // proportional
  0xb6: '\u2202', // partial diff
  0xb7: '\u2022', // BULLET -- the list glyph #15 is about
  0xb8: '\u00f7', // divide
  0xb9: '\u2260', // not equal
  0xba: '\u2261', // identical
  0xbb: '\u2248', // approx
  0xbc: '\u2026', // ellipsis
  0xbd: '\u23d0', // vertical bar
  0xbe: '\u23af', // horizontal bar
  0xbf: '\u21b5', // carriage return
  0xd6: '\u221a', // radical
  0xd7: '\u22c5', // dot operator
  0xd8: '\u00ac', // not
  0xd9: '\u2227', // logical and
  0xda: '\u2228', // logical or
  0xdb: '\u21d4', // double left-right arrow
  0xdc: '\u21d0', // double left arrow
  0xdd: '\u21d1', // double up arrow
  0xde: '\u21d2', // double right arrow
  0xdf: '\u21d3', // double down arrow
  0xe5: '\u2211', // n-ary sum
  0xf2: '\u222b' // integral
}

/** Decode Symbol-font bytes; anything outside the table becomes U+FFFD, never a throw. */
function decodeSymbol (buf) {
  let out = ''
  for (const byte of buf) {
    out += byte < 0x80 ? String.fromCharCode(byte) : (SYMBOL_TO_UNICODE[byte] || '\ufffd')
  }
  return out
}

class RTFInterpreter extends Writable {
  constructor (document) {
    super({objectMode: true})
    this.doc = document
    this.parserState = this.parseTop
    this.groupStack = []
    this.group = null
    this.once('prefinish', () => this.finisher())
    this.hexStore = []
  }
  _write (cmd, encoding, done) {
    const method = 'cmd$' + cmd.type.replace(/-(.)/g, (_, char) => char.toUpperCase())
    if (this[method]) {
      this[method](cmd)
    } else {
      process.emit('error', `Unknown RTF command ${cmd.type}, tried ${method}`)
    }
    done()
  }
  finisher () {
    while (this.groupStack.length) this.cmd$groupEnd()
    const initialStyle = this.doc.content.length ? this.doc.content[0].style : []
    for (let prop of Object.keys(this.doc.style)) {
      let match = true
      for (let para of this.doc.content) {
        if (initialStyle[prop] !== para.style[prop]) {
          match = false
          break
        }
      }
      if (match) this.doc.style[prop] = initialStyle[prop]
    }
  }
  // Charset to decode raw bytes with. 'ASCII' cannot represent anything >= 0x80, so decoding
  // against it turns every such byte into U+FFFD -- strictly worse than assuming the ANSI
  // default the RTF spec prescribes when a document gives no better information.
  resolveCharset () {
    const charset = this.group.get('charset')
    return !charset || charset === 'ASCII' ? 'CP1252' : charset
  }
  /**
   * Decode bytes against the charset in force.
   *
   * Never throws. The Symbol font is handled by table (it is a glyph set, not a code page),
   * and a charset iconv does not recognise falls back to CP1252 with a debug note instead of
   * aborting the document — one exotic font table should not cost the reader the whole file
   * (iarna/rtf-parser#15, #30).
   */
  decodeBytes (buf) {
    const charset = this.resolveCharset()
    if (charset === 'SYMBOL') return decodeSymbol(buf)
    if (!iconv.encodingExists(charset)) {
      process.emit('debug', `unknown charset ${charset}, falling back to CP1252`)
      return iconv.decode(buf, 'CP1252')
    }
    return iconv.decode(buf, charset)
  }
  flushHexStore () {
    if (this.hexStore.length > 0) {
      let hexstr = this.hexStore.map(cmd => cmd.value).join('')
      this.group.addContent(new RTFSpan({ value: this.decodeBytes(Buffer.from(hexstr, 'hex')) }))
      this.hexStore.splice(0)
    }
  }

  cmd$groupStart () {
    this.flushHexStore()
    if (this.group) this.groupStack.push(this.group)
    this.group = new RTFGroup(this.group || this.doc)
  }
  cmd$ignorable () {
    this.flushHexStore()
    this.group.ignorable = true
  }
  cmd$endParagraph () {
    this.flushHexStore()
    this.group.addContent(new RTFParagraph())
  }
  cmd$groupEnd () {
    this.flushHexStore()
    const endingGroup = this.group
    this.group = this.groupStack.pop()
    const doc = this.group || this.doc
    if (endingGroup instanceof FontTable) {
      doc.fonts = endingGroup.table
    } else if (endingGroup instanceof ColorTable) {
      doc.colors = endingGroup.table
    } else if (endingGroup !== this.doc && !endingGroup.get('ignorable')) {
      for (const item of endingGroup.content) {
        doc.addContent(item)
      }
      process.emit('debug', 'GROUP END', endingGroup.type, endingGroup.get('ignorable'))
    }
  }
  cmd$text (cmd) {
    this.flushHexStore()
    if (!this.group) { // an RTF fragment, missing the {\rtf1 header
      this.group = this.doc
    }
    let value = this.consumeSkip(cmd.value)
    if (value === '') return
    this.group.addContent(new RTFSpan(Object.assign({}, cmd, {value: this.decodeText(value)})))
  }
  // Literal 8-bit bytes are legal in the text of an \ansi document and are how Word and
  // Atlantis write curly quotes and dashes. The tokenizer preserves them as U+0080..U+00FF
  // (latin1 is byte-transparent); turn them back into bytes and decode against whatever
  // charset is in force. Pure 7-bit text -- the overwhelming majority -- short-circuits.
  decodeText (value) {
    if (!/[\u0080-\u00ff]/.test(value)) return value
    return this.decodeBytes(Buffer.from(value, 'latin1'))
  }
  // \ucN declares how many fallback characters follow each \uNNNN for readers that cannot
  // handle Unicode. They must be DROPPED. Word emits \uc1 by default, so leaving them in
  // doubled every non-ASCII character it wrote: a \uNNNN followed by its
  // \'xx fallback byte came out as TWO characters instead of one.
  consumeSkip (value) {
    if (!this.unicodeSkip) return value
    const n = Math.min(this.unicodeSkip, value.length)
    this.unicodeSkip -= n
    return value.slice(n)
  }
  cmd$controlWord (cmd) {
    this.flushHexStore()
    // Any control word other than the \uNNNN itself terminates a pending fallback run.
    // ctrl$u re-arms it below, after this reset.
    this.unicodeSkip = 0
    if (!this.group.type) this.group.type = cmd.value
    const method = 'ctrl$' + cmd.value.replace(/-(.)/g, (_, char) => char.toUpperCase())
    if (this[method]) {
      this[method](cmd.param)
    } else {
      if (!this.group.get('ignorable')) process.emit('debug', method, cmd.param)
    }
  }
  cmd$hexchar (cmd) {
    // A \'xx sitting in a \uNNNN fallback run is one of the characters to drop.
    if (this.unicodeSkip > 0) {
      this.unicodeSkip -= 1
      return
    }
    this.hexStore.push(cmd)
  }
  cmd$error (cmd) {
    this.emit('error', new Error('Error: ' + cmd.value + (cmd.row && cmd.col ? ' at line ' + cmd.row + ':' + cmd.col : '') + '.'))
  }

  ctrl$rtf () {
    this.group = this.doc
  }

  // new line
  ctrl$line () {
    this.group.addContent(new RTFSpan({ value: '\n' }))
  }

  // tab
  ctrl$tab () {
    this.group.addContent(new RTFSpan({ value: '\t' }))
  }

  // Named character control words. Every one of these was previously unhandled, which meant
  // it fell through to the debug branch and the character was SILENTLY DELETED -- an en dash
  // or a curly quote written this way simply vanished from the output.
  ctrl$emdash () { this.group.addContent(new RTFSpan({ value: '\u2014' })) }
  ctrl$endash () { this.group.addContent(new RTFSpan({ value: '\u2013' })) }
  ctrl$bullet () { this.group.addContent(new RTFSpan({ value: '\u2022' })) }
  ctrl$lquote () { this.group.addContent(new RTFSpan({ value: '\u2018' })) }
  ctrl$rquote () { this.group.addContent(new RTFSpan({ value: '\u2019' })) }
  ctrl$ldblquote () { this.group.addContent(new RTFSpan({ value: '\u201c' })) }
  ctrl$rdblquote () { this.group.addContent(new RTFSpan({ value: '\u201d' })) }
  ctrl$emspace () { this.group.addContent(new RTFSpan({ value: '\u2003' })) }
  ctrl$enspace () { this.group.addContent(new RTFSpan({ value: '\u2002' })) }
  ctrl$qmspace () { this.group.addContent(new RTFSpan({ value: '\u2005' })) }
  ctrl$zwnj () { this.group.addContent(new RTFSpan({ value: '\u200c' })) }
  ctrl$zwj () { this.group.addContent(new RTFSpan({ value: '\u200d' })) }
  ctrl$ltrmark () { this.group.addContent(new RTFSpan({ value: '\u200e' })) }
  ctrl$rtlmark () { this.group.addContent(new RTFSpan({ value: '\u200f' })) }

  // alignment
  ctrl$qc () {
    this.group.style.align = 'center'
  }
  ctrl$qj () {
    this.group.style.align = 'justify'
  }
  ctrl$ql () {
    this.group.style.align = 'left'
  }
  ctrl$qr () {
    this.group.style.align = 'right'
  }

  // text direction
  ctrl$rtlch () {
    this.group.style.dir = 'rtl'
  }
  ctrl$ltrch () {
    this.group.style.dir = 'ltr'
  }

  // general style
  ctrl$par () {
    this.group.addContent(new RTFParagraph())
  }
  ctrl$pard () {
    this.group.resetStyle()
  }
  ctrl$plain () {
    this.group.style.fontSize = this.doc.getStyle('fontSize')
    this.group.style.bold = this.doc.getStyle('bold')
    this.group.style.italic = this.doc.getStyle('italic')
    this.group.style.underline = this.doc.getStyle('underline')
  }
  ctrl$b (set) {
    this.group.style.bold = set !== 0
  }
  ctrl$i (set) {
    this.group.style.italic = set !== 0
  }
  ctrl$u (num) {
    // RTF represents a unicode character as a SIGNED 16-bit integer, so code units above
    // 32767 are written negative. Plenty of producers emit the unsigned value instead, and
    // `writeInt16LE` threw ERR_OUT_OF_RANGE on those — an uncaught crash, not a bad
    // character. That is upstream iarna/rtf-parser#28, and it is also why the surrogate
    // pair in iarna/rtf-parser#15 (\u55357 \u56842, an emoji) broke the interpreter.
    //
    // Accept both forms. A negative value is normalised to its unsigned counterpart; a
    // value outside the UTF-16 code-unit range is not representable and is skipped rather
    // than thrown, so one malformed escape cannot abort the whole document.
    const code = typeof num === 'number' && num < 0 ? num + 0x10000 : num
    if (!Number.isInteger(code) || code < 0 || code > 0xffff) {
      process.emit('debug', 'ctrl$u: skipping out-of-range value', num)
    } else {
      // fromCharCode, not a Buffer round-trip: this is already a UTF-16 code unit, and
      // adjacent surrogate halves then combine into one astral character naturally.
      this.group.addContent(new RTFSpan({value: String.fromCharCode(code)}))
    }
    // Arm the fallback run: the next \uc characters are a downlevel representation of the
    // character just emitted and must be dropped. cmd$controlWord zeroed this immediately
    // before dispatching here, so consecutive \uNNNN each re-arm cleanly.
    const uc = this.group.get('uc')
    this.unicodeSkip = uc == null ? 1 : uc
  }
  // Number of fallback characters following each \uNNNN. Defaults to 1 per the spec.
  ctrl$uc (num) {
    this.group.uc = num === false ? 0 : num
  }
  ctrl$super () {
    this.group.style.valign = 'super'
  }
  ctrl$sub () {
    this.group.style.valign = 'sub'
  }
  ctrl$nosupersub () {
    this.group.style.valign = 'normal'
  }
  ctrl$strike (set) {
    this.group.style.strikethrough = set !== 0
  }
  ctrl$ul (set) {
    this.group.style.underline = set !== 0
  }
  ctrl$ulnone (set) {
    this.group.style.underline = false
  }
  ctrl$fi (value) {
    this.group.style.firstLineIndent = value
  }
  ctrl$cufi (value) {
    this.group.style.firstLineIndent = value * 100
  }
  ctrl$li (value) {
    this.group.style.indent = value
  }
  ctrl$lin (value) {
    this.group.style.indent = value
  }
  ctrl$culi (value) {
    this.group.style.indent = value * 100
  }

// encodings
  // \ansi means Windows ANSI, which is CP1252 -- not US-ASCII. Mapping it to 'ASCII' made
  // iconv fold every byte >= 0x80 to U+FFFD, so a document that declared \ansi without an
  // explicit \ansicpg lost every curly quote, dash and ellipsis to a replacement char.
  ctrl$ansi () {
    this.group.charset = 'CP1252'
  }
  ctrl$mac () {
    this.group.charset = 'MacRoman'
  }
  ctrl$pc () {
    this.group.charset = 'CP437'
  }
  ctrl$pca () {
    this.group.charset = 'CP850'
  }
  ctrl$ansicpg (codepage) {
    if (availableCP.indexOf(codepage) === -1) {
      this.emit('error', new Error('Codepage ' + codepage + ' is not available.'))
    } else {
      this.group.charset = 'CP' + codepage
    }
  }

// fonts
  ctrl$fonttbl () {
    this.group = new FontTable(this.group.parent)
  }
  ctrl$f (num) {
    if (this.group instanceof FontTable) {
      this.group.currentFont = this.group.table[num] = new Font()
    } else if (this.group.parent instanceof FontTable) {
      this.group.parent.currentFont = this.group.parent.table[num] = new Font()
    } else {
      this.group.style.font = num

      let fontCharset = this.group.getFont(num).charset
      fontCharset = fontCharset && fontCharset !== 'ASCII' ? fontCharset : this.group.charset// default font charset
      this.group.charset = fontCharset
    }
  }
  ctrl$fnil () {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').family = 'nil'
    }
  }
  ctrl$froman () {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').family = 'roman'
    }
  }
  ctrl$fswiss () {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').family = 'swiss'
    }
  }
  ctrl$fmodern () {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').family = 'modern'
    }
  }
  ctrl$fscript () {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').family = 'script'
    }
  }
  ctrl$fdecor () {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').family = 'decor'
    }
  }
  ctrl$ftech () {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').family = 'tech'
    }
  }
  ctrl$fbidi () {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').family = 'bidi'
    }
  }
  ctrl$fcharset (code) {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      let charset = null
      if (code === 1) {
        charset = this.group.get('charset')
      } else {
        charset = codeToCP[code]
      }
      if (charset == null) {
        return this.emit('error', new Error('Unsupported charset code #' + code))
      }
      this.group.get('currentFont').charset = charset
    }
  }
  ctrl$fprq (pitch) {
    if (this.group instanceof FontTable || this.group.parent instanceof FontTable) {
      this.group.get('currentFont').pitch = pitch
    }
  }

  // colors
  ctrl$colortbl () {
    this.group = new ColorTable(this.group.parent)
  }
  ctrl$red (value) {
    if (this.group instanceof ColorTable) {
      this.group.red = value
    }
  }
  ctrl$blue (value) {
    if (this.group instanceof ColorTable) {
      this.group.blue = value
    }
  }
  ctrl$green (value) {
    if (this.group instanceof ColorTable) {
      this.group.green = value
    }
  }
  ctrl$cf (value) {
    this.group.style.foreground = value
  }
  ctrl$cb (value) {
    this.group.style.background = value
  }
  ctrl$fs (value) {
    this.group.style.fontSize = value
  }

// margins
  ctrl$margl (value) {
    this.doc.marginLeft = value
  }
  ctrl$margr (value) {
    this.doc.marginRight = value
  }
  ctrl$margt (value) {
    this.doc.marginTop = value
  }
  ctrl$margb (value) {
    this.doc.marginBottom = value
  }

  /**
   * Embedded pictures (iarna/rtf-parser#32).
   *
   * RTF stores an image as a hex (or binary) payload inside a `{\pict ...}` group. With no
   * handler that payload was decoded as ordinary text, so the document's `content` gained a
   * span of raw hex — 'before 89504e470d0a...' — corrupting text extraction and word counts.
   *
   * Marking the group ignorable drops the payload the same way `\stylesheet` and `\info` are
   * dropped. The image is not surfaced as a node: that would be a new public type, and this
   * is a data-corruption fix. Callers who need the bytes still have the raw RTF.
   */
  ctrl$pict () {
    this.group.ignorable = true
  }

// unsupported (and we need to ignore content)
  ctrl$stylesheet (value) {
    this.group.ignorable = true
  }
  ctrl$info (value) {
    this.group.ignorable = true
  }
  ctrl$mmathPr (value) {
    this.group.ignorable = true
  }
}

class FontTable extends RTFGroup {
  constructor (parent) {
    super(parent)
    this.table = []
    this.currentFont = {family: 'roman', charset: 'ASCII', name: 'Serif'}
  }
  addContent (text) {
    this.currentFont.name += text.value.replace(/;\s*$/, '')
  }
}

class Font {
  constructor () {
    this.family = null
    this.charset = null
    this.name = ''
    this.pitch = 0
  }
}

class ColorTable extends RTFGroup {
  constructor (parent) {
    super(parent)
    this.table = []
    this.red = 0
    this.blue = 0
    this.green = 0
  }
  addContent (text) {
    assert(text.value === ';', 'got: ' + util.inspect(text))
    this.table.push({
      red: this.red,
      blue: this.blue,
      green: this.green
    })
    this.red = 0
    this.blue = 0
    this.green = 0
  }
}

module.exports = RTFInterpreter
