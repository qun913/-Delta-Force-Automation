// watch.mjs — capture the phone screen on an interval while a human demonstrates
// a flow. One PNG per tick plus a manifest, so the resulting sequence can be
// replayed frame by frame afterwards.
//
//   node watch.mjs --dir shots/session-01 --interval 800 --minutes 15
//
// Stop early by creating <dir>/STOP (or just let the time budget run out).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ADB_CANDIDATES = [
  process.env.DSH_ADB,
  'K:\\dsh\\tools\\platform-tools\\adb.exe',
  'adb',
].filter(Boolean)

function resolveAdb() {
  for (const candidate of ADB_CANDIDATES) {
    if (candidate === 'adb') return candidate
    if (fs.existsSync(candidate)) return candidate
  }
  return 'adb'
}

const ADB = resolveAdb()
const SERIAL = process.env.DSH_SERIAL ?? ''
const BASE = SERIAL ? ['-s', SERIAL] : []

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(String(process.argv[i]).replace(/^--/, ''), process.argv[i + 1])
}

const dir = args.get('dir') ?? path.join('shots', `session-${Date.now()}`)
const interval = Number(args.get('interval') ?? 800)
const minutes = Number(args.get('minutes') ?? 15)
const stopFile = path.join(dir, 'STOP')
const manifest = path.join(dir, 'manifest.jsonl')

fs.mkdirSync(dir, { recursive: true })
if (fs.existsSync(stopFile)) fs.rmSync(stopFile)

const t0 = Date.now()
let index = 0
let failures = 0

function capture(file) {
  return new Promise((resolve) => {
    const fd = fs.openSync(file, 'w')
    const child = spawn(ADB, [...BASE, 'exec-out', 'screencap', '-p'], {
      stdio: ['ignore', fd, 'ignore'],
    })
    child.on('exit', (code) => {
      try { fs.closeSync(fd) } catch { /* closed */ }
      if (code === 0) {
        const size = fs.statSync(file).size
        if (size < 1024) { fs.rmSync(file, { force: true }); return resolve(false) }
        return resolve(true)
      }
      fs.rmSync(file, { force: true })
      resolve(false)
    })
    child.on('error', () => {
      try { fs.closeSync(fd) } catch { /* closed */ }
      fs.rmSync(file, { force: true })
      resolve(false)
    })
  })
}

console.log(`[watch] dir=${dir} interval=${interval}ms budget=${minutes}min`)

while (Date.now() - t0 < minutes * 60_000) {
  if (fs.existsSync(stopFile)) {
    console.log('[watch] stop file found')
    break
  }
  index += 1
  const name = `frame-${String(index).padStart(5, '0')}.png`
  const file = path.join(dir, name)
  const ok = await capture(file)
  if (ok) {
    fs.appendFileSync(manifest, `${JSON.stringify({ i: index, file: name, t: Date.now() - t0 })}\n`)
    if (index % 10 === 0) console.log(`[watch] ${index} frames, ${Math.round((Date.now() - t0) / 1000)}s`)
  } else {
    failures += 1
    if (failures % 20 === 1) console.log(`[watch] capture failed (${failures} total)`)
  }
  await new Promise((r) => setTimeout(r, interval))
}

console.log(`[watch] done: ${index} attempts, ${failures} failures, dir=${dir}`)
