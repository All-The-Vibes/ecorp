import assert from 'node:assert/strict'

// Execute production hooks with explicit render/commit boundaries. Browser
// acceptance separately covers React, DOM events, layout and focus behavior.
export function renderHooks() {
  const slots = []
  let cursor = 0, dirty = false, render, value
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]))
  const effect = (phase, create, deps) => {
    const index = cursor++
    if (changed(slots[index]?.deps, deps)) {
      slots[index] = { phase, create, deps, cleanup: slots[index]?.cleanup, pending: true }
    }
  }
  const react = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = (next) => {
          const result = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(slot.value, result)) { slot.value = result; dirty = true }
        }
        slots[index] = slot
      }
      return [slots[index].value, slots[index].set]
    },
    useRef(initial) {
      const index = cursor++
      slots[index] ??= { value: { current: initial } }
      return slots[index].value
    },
    useMemo(create, deps) {
      const index = cursor++
      if (changed(slots[index]?.deps, deps)) slots[index] = { value: create(), deps }
      return slots[index].value
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps) },
    useEffect(create, deps) { effect('passive', create, deps) },
    useLayoutEffect(create, deps) { effect('layout', create, deps) },
  }
  const begin = (next = render) => {
    render = next; cursor = 0; dirty = false; value = render()
    return value
  }
  const commit = () => {
    for (const phase of ['layout', 'passive']) for (const slot of slots) {
      if (slot.phase === phase && slot.pending) {
        slot.cleanup?.(); slot.pending = false; slot.cleanup = slot.create()
      }
    }
  }
  const flush = () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (dirty) begin()
      commit()
      if (!dirty) return value
    }
    assert.fail('Production hook did not settle within 30 render/commit cycles')
  }
  return {
    react, begin, commit, flush,
    render(next) { begin(next); return flush() },
    replayEffects() {
      // Development StrictMode repeats cleanup/setup without resetting state.
      for (const slot of slots) if (slot.phase) { slot.cleanup?.(); slot.cleanup = undefined; slot.pending = true }
      return flush()
    },
    unmount() { for (const slot of slots) slot.cleanup?.() },
    get value() { return value },
  }
}

export function elements(tree, predicate) {
  const found = []
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!node || typeof node !== 'object') return
    if (predicate(node)) found.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return found
}
