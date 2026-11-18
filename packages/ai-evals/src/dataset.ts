import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { AppError } from '@platform/core'
import type { EvalCase } from './types.ts'

/** JSON Schema of one dataset line. */
export const CASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'task', 'input', 'context', 'expect', 'tags', 'split', 'source'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' },
    task: { type: 'string', pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' },
    input: { type: 'object' },
    context: { type: 'object' },
    expect: { type: 'array', items: { type: 'object', required: ['grader'], properties: { grader: { type: 'string', minLength: 1 } } } },
    tags: { type: 'array', items: { type: 'string', minLength: 1 } },
    split: { enum: ['dev', 'test'] },
    source: { enum: ['educator', 'synthetic', 'consented'] },
  },
} as const

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateCase = ajv.compile(CASE_SCHEMA)

export interface Dataset {
  file: string
  /** sha256 of the canonical (parsed, key-sorted) cases — stable under whitespace/formatting changes */
  version: string
  cases: EvalCase[]
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/**
 * Parse and validate JSONL. Every problem is reported with its line number; any problem rejects the
 * whole dataset (a partially loaded dataset would silently change what a gate measures).
 */
export function parseDataset(text: string, file = 'dataset.jsonl'): Dataset {
  const problems: string[] = []
  const cases: EvalCase[] = []
  const ids = new Set<string>()
  // a file named dev.jsonl / test.jsonl may only hold cases of that split (test is never used for tuning)
  const fileSplit = /(^|[^a-z])(dev|test)\.jsonl$/i.exec(basename(file))?.[2]?.toLowerCase()
  text.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1
    if (!line.trim() || line.trimStart().startsWith('//')) return
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch (e) {
      problems.push(`line ${n}: invalid JSON (${(e as Error).message})`)
      return
    }
    if (!validateCase(v)) {
      problems.push(`line ${n}: ${ajv.errorsText(validateCase.errors)}`)
      return
    }
    const c = v as unknown as EvalCase
    if (ids.has(c.id)) problems.push(`line ${n}: duplicate case id ${c.id}`)
    ids.add(c.id)
    if (fileSplit && c.split !== fileSplit) problems.push(`line ${n}: case ${c.id} has split ${c.split} but the file holds ${fileSplit} cases`)
    const hasTurns = Array.isArray(c.input.turns)
    if (hasTurns && !(c.input.turns as unknown[]).every((t) => !!t && typeof (t as { student?: unknown }).student === 'string')) {
      problems.push(`line ${n}: every dialogue turn needs a "student" message`)
    }
    cases.push(c)
  })
  if (problems.length) throw new AppError('eval_dataset_invalid', `${file}: ${problems.length} problem(s):\n- ${problems.join('\n- ')}`, { details: { problems } })
  if (!cases.length) throw new AppError('eval_dataset_invalid', `${file}: no cases`)
  return { file, version: sha256(cases.map(canonicalJson).join('\n')), cases }
}

export async function loadDataset(path: string): Promise<Dataset> {
  return parseDataset(await readFile(path, 'utf8'), path)
}

/** Load several files; ids must be unique across them. The combined version hashes the per-file versions. */
export async function loadDatasets(paths: string[]): Promise<{ datasets: Dataset[]; version: string; cases: EvalCase[] }> {
  const datasets = await Promise.all(paths.map(loadDataset))
  const seen = new Map<string, string>()
  for (const d of datasets) {
    for (const c of d.cases) {
      const prev = seen.get(c.id)
      if (prev) throw new AppError('eval_dataset_invalid', `case id ${c.id} appears in both ${prev} and ${d.file}`)
      seen.set(c.id, d.file)
    }
  }
  const version = sha256(datasets.map((d) => d.version).sort().join(':'))
  return { datasets, version, cases: datasets.flatMap((d) => d.cases) }
}

export interface SelectOptions {
  split?: 'dev' | 'test'
  tags?: string[]
  /** keep a deterministic fraction (0..1] of cases, e.g. 0.1 for the PR smoke suite */
  sample?: number
  /** salt for the deterministic sample */
  seed?: string
}

/** Select cases by split / tags, and take a deterministic hash-based sample (stable across runs). */
export function selectCases(cases: EvalCase[], o: SelectOptions = {}): EvalCase[] {
  let out = cases
  if (o.split) out = out.filter((c) => c.split === o.split)
  if (o.tags?.length) out = out.filter((c) => o.tags!.every((t) => c.tags.includes(t)))
  if (o.sample !== undefined && o.sample < 1) {
    if (!(o.sample > 0)) throw new AppError('invalid_sample', 'sample must be in (0, 1]')
    const ranked = out.map((c) => ({ c, h: sha256(`${o.seed ?? ''}:${c.id}`) })).sort((a, b) => a.h.localeCompare(b.h))
    const keep = new Set(ranked.slice(0, Math.max(1, Math.ceil(out.length * o.sample))).map((r) => r.c.id))
    out = out.filter((c) => keep.has(c.id))
  }
  return out
}
