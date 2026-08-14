'use strict'

// Nodes whose style has already been resolved against the group that produced them.
// A WeakSet rather than a property so the emitted document keeps its exact public shape.
const styled = new WeakSet()

class RTFGroup {
  constructor (parent) {
    this.parent = parent
    this.content = []
    this.fonts = []
    this.colors = []
    this.style = {}
    this.ignorable = null
  }
  get (name) {
    return this[name] != null ? this[name] : this.parent.get(name)
  }
  getFont (num) {
    return this.fonts[num] != null ? this.fonts[num] : this.parent.getFont(num)
  }
  getColor (num) {
    return this.colors[num] != null ? this.colors[num] : this.parent.getFont(num)
  }
  getStyle (name) {
    if (!name) return Object.assign({}, this.parent.getStyle(), this.style)
    return this.style[name] != null ? this.style[name] : this.parent.getStyle(name)
  }
  resetStyle () {
    this.style = {}
  }
  // Resolve a node's style against THIS group, but only once. When a group closes, the
  // interpreter re-parents its children by handing each one to the parent's addContent;
  // unconditionally re-stamping there overwrote the style the child was actually written
  // under with the parent's. That silently discarded every nested override — `\i text{\i0
  // roman}` came back with "roman" italic, because the closing group's content inherited
  // the outer \i on the way out.
  addContent (node) {
    if (!styled.has(node)) {
      node.style = Object.assign({}, this.getStyle())
      node.style.font = this.getFont(node.style.font)
      node.style.foreground = this.getColor(node.style.foreground)
      node.style.background = this.getColor(node.style.background)
      styled.add(node)
    }
    this.content.push(node)
  }
}

module.exports = RTFGroup
