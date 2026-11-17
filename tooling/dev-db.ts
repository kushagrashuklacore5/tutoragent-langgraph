/**
 * Local development/test PostgreSQL cluster, isolated from any system database.
 *   node tooling/dev-db.ts up    – initdb (first run) + start on PGPORT (default 54329)
 *   node tooling/dev-db.ts down  – stop
 * Uses PG_BIN (default: the PostgreSQL 17 install on Windows) and stores data in .data/pg.
 * Trust auth is bound to 127.0.0.1 only; never use this cluster for real data.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bin = process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/lib/postgresql/17/bin')
const exe = (n: string) => join(bin, process.platform === 'win32' ? `${n}.exe` : n)
const data = join(root, '.data', 'pg')
const port = process.env.PGPORT ?? '54329'
const cmd = process.argv[2]

if (cmd === 'up') {
  if (!existsSync(join(data, 'PG_VERSION'))) {
    mkdirSync(data, { recursive: true })
    execFileSync(exe('initdb'), ['-D', data, '-U', 'platform_owner', '--auth=trust', '-E', 'UTF8', '--locale=C'], { stdio: 'inherit' })
    appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 200\n`)
  }
  try {
    execFileSync(exe('pg_ctl'), ['-D', data, 'status'], { stdio: 'ignore' })
    console.log(`dev db already running on ${port}`)
  } catch {
    // stdio must not be inherited: on Windows the server would keep the console handles open
    execFileSync(exe('pg_ctl'), ['-D', data, '-l', join(root, '.data', 'pg.log'), '-w', 'start'], { stdio: 'ignore', windowsHide: true })
    console.log(`dev db started on 127.0.0.1:${port}`)
  }
} else if (cmd === 'down') {
  execFileSync(exe('pg_ctl'), ['-D', data, '-w', 'stop'], { stdio: 'inherit' })
} else {
  console.error('usage: node tooling/dev-db.ts up|down')
  process.exit(1)
}
