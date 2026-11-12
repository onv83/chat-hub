// Offline element tree: only tag/class/descendant selectors used by these fixtures.
// No browser, Electron, network, user data, or messenger session is involved.
export class Element {
  constructor(tag, classes = '', text = '', children = []) {
    this.tag = tag
    this.classes = classes.split(/\s+/)
    this.text = text
    this.children = children
    for (const child of children) child.parent = this
  }
  appendChild(child) { this.children.push(child); child.parent = this; return child }
  cloneNode(deep) { return new Element(this.tag, this.classes.join(' '), this.text, deep ? this.children.map(c => c.cloneNode(true)) : []) }
  get textContent() { return this.text + this.children.map(c => c.textContent).join('') }
  matches(selector) {
    const parts = selector.split('.')
    return (!parts[0] || parts[0] === this.tag) && parts.slice(1).every(c => this.classes.includes(c))
  }
  querySelectorAll(selector) {
    const all = []
    const visit = el => { for (const c of el.children) { all.push(c); visit(c) } }
    visit(this)
    return all.filter(el => selector.split(',').some(s => {
      const parts = s.trim().split(/\s+/)
      if (!el.matches(parts.pop())) return false
      let ancestor = el.parent
      while (parts.length) {
        const part = parts.pop()
        while (ancestor && !ancestor.matches(part)) ancestor = ancestor.parent
        if (!ancestor) return false
        ancestor = ancestor.parent
      }
      return true
    }))
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}
export const element = (...args) => new Element(...args)
export function ydxIdentity(row, chatId) {
  row.__reactFiber$fixture = { stateNode: row, memoizedProps: {}, return: { memoizedProps: { chatId }, return: { type: 'div', memoizedProps: {} } } }
  return row
}
export function listFixture(service, { title = 'Synthetic room', preview = '', badge = null, heart = false, chatId = '0/0/00000000-0000-4000-8000-000000000123' } = {}) {
  const e = element
  const row = service === 'max'
    ? e('div', 'item', '', [e('span', 'name', title), e('span', 'text svelte-q2jdqb', preview),
        ...(heart ? [e('span', 'indicator', '', [e('svg', 'heart')])] : []),
        ...(badge === null ? [] : [e('div', 'indicator', '', [e('span', 'text--20', '', [e('span', '', String(badge))])])])])
    : e('div', 'yamb-chat-list-item', '', [e('span', 'yamb-chat-list-item__name', title), e('span', 'ui-entity-block-text', preview),
        ...(badge === null ? [] : [e('span', 'yamb-chat-list-item__badges', String(badge))])])
  if (service === 'ydx') ydxIdentity(row, chatId)
  return e('document', '', '', [e('aside', '', '', [row])])
}
