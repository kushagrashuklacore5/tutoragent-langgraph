/**
 * Repository lint (no external linter dependency):
 *  - no debugger / eval / new Function / test.only
 *  - no console.* in library code (allowed in apps' CLI/main, tooling and tests)
 *  - no committed secrets (vendor key shapes, private keys)
 *  - every module folder has a README with Purpose, Dependencies, Setup and Removal sections
 *  - generated registries are up to date
 *   node tooling/lint.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const problems: string[] = []

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === '.data') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const SECRET = /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gsk_[A-Za-z0-9]{24,}|AIza[0-9A-Za-z_-]{30,})\b|-----BEGIN (RSA |EC )?PRIVATE KEY-----/

for (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join('/')
  if (rel === 'package-lock.json') continue
  const text = readFileSync(file, 'utf8')
  if (SECRET.test(text)) problems.push(`${rel}: looks like a committed secret`)
  if (!rel.endsWith('.ts')) continue
  const isTest = /\.test\.ts$|^tests\/|\/conformance\//.test(rel)
  const consoleAllowed = isTest || rel.startsWith('tooling/') || /apps\/[^/]+\/src\/(cli|main)\.ts$/.test(rel)
  text.split('\n').forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    if (/^\s*debugger\b/.test(line)) problems.push(`${at}: debugger statement`)
    if (/\beval\s*\(|new Function\s*\(/.test(line)) problems.push(`${at}: eval/new Function`)
    if (/\b(test|it|describe)\.only\s*\(/.test(line)) problems.push(`${at}: .only left in test`)
    if (!consoleAllowed && /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(line)) problems.push(`${at}: use @platform/observability logger instead of console`)
  })
}

// module README contract (DEPENDENCY_MAP § 3)
const modulesDir = join(root, 'modules')
if (existsSync(modulesDir)) {
  for (const vertical of readdirSync(modulesDir)) {
    const vdir = join(modulesDir, vertical)
    if (!statSync(vdir).isDirectory()) continue
    for (const agent of readdirSync(vdir)) {
      const adir = join(vdir, agent)
      if (!statSync(adir).isDirectory() || agent === 'shared') continue
      const readme = join(adir, 'README.md')
      if (!existsSync(readme)) {
        problems.push(`modules/${vertical}/${agent}: README.md missing`)
        continue
      }
      const md = readFileSync(readme, 'utf8')
      for (const section of ['Purpose', 'Dependencies', 'Setup', 'Removal']) if (!new RegExp(`^#+\\s*${section}`, 'mi').test(md)) problems.push(`modules/${vertical}/${agent}/README.md: missing "${section}" section`)
    }
  }
}

try {
  execFileSync(process.execPath, [join(root, 'tooling/gen-registries.ts'), '--check'], { stdio: 'pipe' })
} catch (e) {
  problems.push(`generated registries are stale: ${(e as { stderr?: Buffer }).stderr?.toString().trim()}`)
}

if (problems.length) {
  console.error(`Lint problems (${problems.length}):\n- ` + problems.join('\n- '))
  process.exit(1)
}
console.log('lint ok')
