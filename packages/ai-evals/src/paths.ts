/**
 * Tiny path language for grader targets: dotted keys, `[n]` indexes and `[*]` wildcards, e.g.
 * `json.segments[*].citations`, `meta.move`, `case.context.answer`. Always returns a flat list of
 * values (wildcards flatten one level; a missing path yields an empty list).
 */
export function resolvePath(scope: unknown, path: string): unknown[] {
  const tokens: (string | number | '*')[] = []
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(part)
    if (!m) throw new Error(`invalid path segment "${part}" in ${path}`)
    if (m[1]) tokens.push(m[1])
    for (const idx of m[2]!.matchAll(/\[(\d+|\*)\]/g)) tokens.push(idx[1] === '*' ? '*' : Number(idx[1]))
  }
  let values: unknown[] = [scope]
  for (const t of tokens) {
    const next: unknown[] = []
    for (const v of values) {
      if (v === null || v === undefined) continue
      if (t === '*') {
        if (Array.isArray(v)) next.push(...v)
      } else if (typeof t === 'number') {
        if (Array.isArray(v) && t < v.length) next.push(v[t])
      } else if (typeof v === 'object' && t in (v as object)) {
        next.push((v as Record<string, unknown>)[t])
      }
    }
    values = next
  }
  // a terminal array (without wildcard) is returned as its elements when it holds scalars, so
  // `json.segments[*].citations` yields every citation id
  return values.flatMap((v) => (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object') ? v : [v]))
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
