# @oghma/rtf-parser

> **This is a fork.** It is [iarna/rtf-parser](https://github.com/iarna/rtf-parser)
> by Rebecca Turner, maintained by [Oghmere](https://github.com/Oghmere) with fixes for
> character-encoding and style-scoping defects that silently corrupted imported
> manuscripts. Upstream is unmaintained (last release 1.3.3), so these could not be
> landed there. Original work is © Rebecca Turner under the ISC licence; see
> [LICENSE](./LICENSE), which is unchanged. Our changes are offered under the same terms,
> and we would be glad to see any of them upstreamed.

## What this fork changes

All five defects below cause **silent data loss** — no error, no warning, just characters
or formatting missing from the output. Each has a regression test in [`test/encoding.js`](./test/encoding.js)
that fails against upstream 1.3.3.

| Fix | Symptom before |
|---|---|
| Decode literal 8-bit text bytes against the document charset | Word/Atlantis write curly quotes as raw CP1252 bytes; `Buffer.toString('ascii')` masked off the high bit, mangling every one into an invisible control character |
| `\ansi` means CP1252, not US-ASCII | A document declaring `\ansi` without `\ansicpg` had every `\'xx` escape ≥ 0x80 folded to `U+FFFD` |
| Implement `\ucN` Unicode fallback skip | `\uc1` is Word's default; its fallback characters were emitted as well as the real one, **doubling** every non-ASCII character |
| Emit named character control words | `\endash`, `\emdash`, `\bullet`, `\lquote`, `\rquote`, `\ldblquote`, `\rdblquote` and friends were unhandled, so the character was **deleted** |
| Resolve span style once, at the group that wrote it | Closing a group re-stamped its content with the *parent's* style, so `\i text{\i0 roman}` came back with `roman` italic |

On a real 315k-character manuscript this recovers 1,966 apostrophes, 1,943 quotation
marks and 308 en dashes, and eliminates 4,059 invisible control characters — bringing the
extracted length to exactly the `\nofchars` count the authoring tool recorded.

## Usage

```js
const parseRTF = require('@oghma/rtf-parser')
const fs = require('fs')

parseRTF.string('{\\rtf1\\ansi\\b hi there\\b0}', (err, doc) => {
  …
})

parseRTF.stream(fs.createReadStream('example.rtf'), (err, doc) => {
  …
})

const parser = parseRTF((err, doc) => {
  …
})
fs.createReadStream('example.rtf').pipe(parser)
```

RTF, unlike HTML, is NOT declarative and is instead a series of commands
that mutate document state.  As such, to accurately convert it you have to
load into something tha tracks that state, then emit chunks of text with
whatever that state was when they were emitted.

RTF, like HTML, allows (mostly) seamless degrading when you don't understand
an element.  As such, while this parser is still quite incomplete it is
already useful

RTF fragments are supported.  `\b hi there\b0` will generate a document with
`hi there` flagged as bold text.

The document returned is of the `RTFDocument` class, see below for details.

## RTF FEATURES SUPPORTED

* The following document code pages:<br>
  437, 737, 775, 850, 852, 853, 855, 857, 858, 860, 861, 863, 865, 866, 869,
  932, 936, 949, 950, 1125, 1250, 1251, 1252, 1253, 1254, 1257
* Unicode characters.
* Non-unicode representations of: non-breaking spaces, soft hyphens and non-breaking hyphens.
* Paragraph alignment: center, justified, left and right
* Style resets.
* Setting the style to "plain".
* Bold, Italic, Underline and Strikethrough.
* Superscript and Subscript.
* first line indent (for indenting the first line of paragraphs)
* indent (for indenting the entire block)
* Fonts
  * The following font character sets:<br>
    ASCII, MacRoman, SHIFT_JIS, CP949, JOHAB, CP936, BIG5, CP1253, CP1254,
    CP1258, CP862, CP1256, CP1257, CP1251, CP874, CP238, CP437
* Colors (foreground and background) 
* Margins
* Text direction

## NOTABLY MISSING

Most notably, stylesheets, list styling and tables are not supported.  List
styling degrades cleanly but tables do not.  There are certainly other
required bits from the spec that are currently ignored.

## CLASSES

### RTFDocument

This is the class you get back from the parse functions.  It has some
document global options and the paragraph objects that make up the document.

* marginLeft, marginRight, marginBottom, marginTop — the margins for this document. These are in
  twips, which are one twentieth of a point.
* content — An array of RTFParagraph objects

### RTFParagraph

* style — An object with paragraph level styling information.
  * firstLineIndent
  * indent
  * align
  * valign

* content — An array of RTFSpan objects

### RTFSpan

* value — a string with the content of this region of text.
* style — an object with the span level styling infomration.
  * font
  * fontSize: In half points
  * bold: boolean
  * italic: boolean
  * underline: boolean
  * strikethrough: boolean
  * foreground: color (an object with red, green and blue values, 0-255)
  * background: color
  * dir (rtl or ltr)
