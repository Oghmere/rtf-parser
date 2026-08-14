# Change Log

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

<a name="2.0.0"></a>
## 2.0.0 (2026-08-13)

First release of the Oghmere fork of `iarna/rtf-parser`, published as
`@oghma/rtf-parser`. Forked from upstream 1.3.3; upstream is unmaintained.

### Bug Fixes

* **parser:** decode input as latin1, not ascii. Node's `ascii` decoder masks off the
  high bit instead of rejecting it, so literal 8-bit text — legal in an `\ansi`
  document, and how Word and Atlantis write curly quotes and dashes — had every such
  byte silently mangled (`0x92` → `0x12`).
* **interpreter:** decode literal 8-bit text bytes against the document charset.
* **interpreter:** `\ansi` now selects CP1252 rather than US-ASCII, per the RTF spec's
  ANSI default. Previously every byte >= 0x80 in a document without an explicit
  `\ansicpg` was folded to `U+FFFD`.
* **interpreter:** implement `\ucN` Unicode fallback skipping. `\uc1` is Microsoft
  Word's default output, and the unskipped fallback characters doubled every non-ASCII
  character in the document.
* **interpreter:** emit the named character control words `\emdash`, `\endash`,
  `\bullet`, `\lquote`, `\rquote`, `\ldblquote`, `\rdblquote`, `\emspace`, `\enspace`,
  `\qmspace`, `\zwnj`, `\zwj`, `\ltrmark` and `\rtlmark`. All were previously unhandled
  and the character was dropped from the output entirely.
* **group:** resolve a node's style exactly once, against the group that produced it.
  Closing a group re-parents its content through the parent's `addContent`, which
  unconditionally re-stamped the style — discarding every nested override, so
  `\i text{\i0 roman}` returned `roman` as italic.

### BREAKING CHANGES

* The default charset for `\ansi` (and for raw bytes when no charset is determinable)
  is now CP1252 instead of ASCII. Output that previously contained `U+FFFD` or masked
  7-bit characters will now contain the intended characters. This is a fix, but it
  changes output for any consumer that had adapted to the old behaviour.

<a name="1.3.1"></a>
## [1.3.1](https://github.com/iarna/rtf-parser/compare/v1.3.0...v1.3.1) (2019-01-08)


### Bug Fixes

* **interpreter:** avoid finish callback after err ([#14](https://github.com/iarna/rtf-parser/issues/14)) ([2882b17](https://github.com/iarna/rtf-parser/commit/2882b17)), closes [#13](https://github.com/iarna/rtf-parser/issues/13)
* **interpreter:** Unknown RTF command error ([#16](https://github.com/iarna/rtf-parser/issues/16)) ([63314fe](https://github.com/iarna/rtf-parser/commit/63314fe)), closes [#13](https://github.com/iarna/rtf-parser/issues/13)



<a name="1.3.0"></a>
# [1.3.0](https://github.com/iarna/rtf-parser/compare/v1.2.0...v1.3.0) (2018-07-08)


### Bug Fixes

* **nulls:** If a file is null terminated, don't emit the null ([7eee9a2](https://github.com/iarna/rtf-parser/commit/7eee9a2)), closes [#5](https://github.com/iarna/rtf-parser/issues/5)


### Features

* **fragments:** Add RTF fragment support ([a3fb225](https://github.com/iarna/rtf-parser/commit/a3fb225)), closes [#8](https://github.com/iarna/rtf-parser/issues/8)
* **line:** Add support for rtf \line command ([1ebda17](https://github.com/iarna/rtf-parser/commit/1ebda17)), closes [#9](https://github.com/iarna/rtf-parser/issues/9)



<a name="1.2.0"></a>
# [1.2.0](https://github.com/iarna/rtf-parser/compare/v1.1.0...v1.2.0) (2018-07-07)


### Bug Fixes

* **unicode:** Allow for interpretation of signed integers ([e27780e](https://github.com/iarna/rtf-parser/commit/e27780e)), closes [#12](https://github.com/iarna/rtf-parser/issues/12)


### Features

* **cp932:** Add support for code page 932 ([#11](https://github.com/iarna/rtf-parser/issues/11)) ([8dc793f](https://github.com/iarna/rtf-parser/commit/8dc793f))
* **fonttbl:** support groups in fonttbl ([#10](https://github.com/iarna/rtf-parser/issues/10)) ([b6c0f37](https://github.com/iarna/rtf-parser/commit/b6c0f37))
