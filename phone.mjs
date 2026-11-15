// phone.mjs — drive an Android phone from this PC over adb.
// No native modules, no services: every command is one adb invocation.
//
//   node phone.mjs devices
//   node phone.mjs size
//   node phone.mjs state                     # screen + keyguard state
//   node phone.mjs wake                      # wake screen, dismiss keyguard
//   node phone.mjs sleep                     # turn screen off
//   node phone.mjs unlock-pin                # type DSH_PIN once, verify, never retry
//   node phone.mjs wait-unlock --timeout 120 # wait for a human to unlock
//   node phone.mjs launch <pkg>
//   node phone.mjs kill   <pkg>
//   node phone.mjs shot   [--out shots/a.png]
//   node phone.mjs tap    540 1200
//   node phone.mjs pct    0.5 0.86
//   node phone.mjs swipe  540 1200 540 600 --ms 300
//   node phone.mjs key    BACK
//   node phone.mjs text   "hello"
//   node phone.mjs flow   flows/craft.json
//   node phone.mjs cycle  --game <pkg> --flow flows/craft.json [--settle 45000]
//                         [--pin-method text|keyevent] [--wait-unlock 0]
//                         [--no-kill] [--no-sleep]
//
// The PIN comes from the DSH_PIN environment variable or --pin-file <path>.
// It is never written to a log, a JSON file, or the evidence screenshot.
//
// Set DSH_ADB to override the adb binary, DSH_SERIAL to pick a device.

import { spawn, execFileSync } from 'node:child_process'
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

const DIGIT_KEYCODES = {
  0: 'KEYCODE_0', 1: 'KEYCODE_1', 2: 'KEYCODE_2', 3: 'KEYCODE_3', 4: 'KEYCODE_4',
  5: 'KEYCODE_5', 6: 'KEYCODE_6', 7: 'KEYCODE_7', 8: 'KEYCODE_8', 9: 'KEYCODE_9',
}

function adbText(args) {
  try {
    return execFileSync(ADB, [...BASE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = error.stderr?.toString?.() ?? error.message
    throw new Error(`adb ${args.join(' ')} failed: ${detail.trim()}`)
  }
}

// Binary output goes straight to a file descriptor: no pipe in the middle.
function adbBinaryToFile(args, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(file, 'w')
    const child = spawn(ADB, [...BASE, ...args], { stdio: ['ignore', fd, 'inherit'] })
    child.on('error', (error) => { try { fs.closeSync(fd) } catch { /* closed */ } reject(error) })
    child.on('exit', (code) => {
      try { fs.closeSync(fd) } catch { /* closed */ }
      if (code === 0) resolve(file)
      else reject(new Error(`adb ${args.join(' ')} exited with ${code}`))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function devices() {
  const out = adbText(['devices', '-l'])
  return out
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('List of devices'))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/)
      return { serial, state, detail: rest.join(' ') }
    })
}

function requireDevice() {
  const list = devices()
  const ready = list.filter((d) => d.state === 'device')
  if (ready.length === 0) {
    const hint = list.length
      ? `found ${list.map((d) => `${d.serial}(${d.state})`).join(', ')} — authorize it on the phone`
      : 'no device attached: enable wireless debugging and pair, or plug in USB with debugging on'
    throw new Error(hint)
  }
  return ready[0].serial
}

function screenSize() {
  const out = adbText(['shell', 'wm', 'size'])
  const match = out.match(/Override size:\s*(\d+)x(\d+)/) ?? out.match(/Physical size:\s*(\d+)x(\d+)/)
  if (!match) throw new Error(`cannot parse screen size from: ${out.trim()}`)
  return { w: Number(match[1]), h: Number(match[2]) }
}

// Best effort: dumpsys output differs per Android version and per ROM. Anything
// we cannot read confidently reports "unknown", and callers must treat that as
// a failure rather than guessing.
function screenState() {
  let wakefulness = 'unknown'
  let keyguard = 'unknown'
  try {
    const power = adbText(['shell', 'dumpsys', 'power'])
    const m = power.match(/mWakefulness=(\w+)/)
    if (m) wakefulness = m[1]
  } catch { /* keep unknown */ }
  try {
    const win = adbText(['shell', 'dumpsys', 'window'])
    const patterns = [
      /keyguardShowing=(true|false)/,
      /isStatusBarKeyguard=(true|false)/,
      /mKeyguardShowing=(true|false)/,
      /mDreamingLockscreen=(true|false)/,
    ]
    for (const re of patterns) {
      const m = win.match(re)
      if (m) {
        keyguard = m[1] === 'true' ? 'showing' : 'dismissed'
        break
      }
    }
  } catch { /* keep unknown */ }
  return { wakefulness, keyguard }
}

function isAwake(state) {
  return state.wakefulness === 'Awake' || state.wakefulness === 'Dozing'
}

function isLocked(state) {
  return state.keyguard !== 'dismissed'
}

function tap(x, y) {
  adbText(['shell', 'input', 'tap', String(x), String(y)])
}

async function wakeScreen() {
  if (!isAwake(screenState())) {
    adbText(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
    await sleep(700)
  }
  return screenState()
}

// Only works when the keyguard is not secure. Harmless when it is.
async function dismissKeyguard() {
  adbText(['shell', 'wm', 'dismiss-keyguard'])
  await sleep(700)
  return screenState()
}

function readPin(argv) {
  const inline = process.env.DSH_PIN
  if (inline) return inline.trim()
  const file = valueOf(argv, '--pin-file')
  if (file && fs.existsSync(file)) {
    const pin = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0].trim()
    if (pin) return pin
  }
  return ''
}

function mask(pin) {
  return `${'*'.repeat(Math.max(0, pin.length - 1))}${pin.slice(-1)} (${pin.length} digits)`
}

// Type the PIN exactly once. A wrong or partially delivered entry would count as
// a failed unlock attempt, and several of those can escalate a lockout, so this
// never retries on its own.
async function tryPinOnce(pin, method) {
  const { w, h } = screenSize()
  // Reveal the PIN pad: most keyguards need a swipe up first.
  adbText(['shell', 'input', 'swipe',
    String(Math.round(w / 2)), String(Math.round(h * 0.82)),
    String(Math.round(w / 2)), String(Math.round(h * 0.35)), '180'])
  await sleep(600)

  if (method === 'keyevent') {
    for (const ch of pin) {
      const code = DIGIT_KEYCODES[ch]
      if (!code) throw new Error('PIN must contain digits only')
      adbText(['shell', 'input', 'keyevent', code])
      await sleep(140)
    }
  } else {
    adbText(['shell', 'input', 'text', pin])
  }
  await sleep(1500)

  let state = screenState()
  if (!isLocked(state)) return { ok: true, state, pressedEnter: false }

  // Some keypads wait for an explicit confirm. Only send it when still locked,
  // so a successful auto-submit never leaks an ENTER onto the launcher.
  adbText(['shell', 'input', 'keyevent', 'KEYCODE_ENTER'])
  await sleep(1500)
  state = screenState()
  return { ok: !isLocked(state), state, pressedEnter: true }
}

async function waitForUnlock(seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const state = screenState()
    if (!isLocked(state)) return state
    await sleep(1500)
  }
  return screenState()
}

async function runFlow(file) {
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'))
  const log = []
  for (const [index, step] of steps.entries()) {
    const label = step.name ?? `step ${index + 1}`
    if (step.sleep) {
      await sleep(step.sleep)
      log.push(`${label}: slept ${step.sleep}ms`)
      continue
    }
    if (step.shot) {
      await adbBinaryToFile(['exec-out', 'screencap', '-p'], step.shot)
      log.push(`${label}: shot -> ${step.shot}`)
      continue
    }
    if (step.pct) {
      const { w, h } = screenSize()
      const x = Math.round(w * step.pct[0])
      const y = Math.round(h * step.pct[1])
      tap(x, y)
      log.push(`${label}: tap ${x},${y}`)
      continue
    }
    if (step.tap) {
      tap(step.tap[0], step.tap[1])
      log.push(`${label}: tap ${step.tap[0]},${step.tap[1]}`)
      continue
    }
    if (step.key) {
      adbText(['shell', 'input', 'keyevent', String(step.key).toUpperCase()])
      log.push(`${label}: key ${step.key}`)
      continue
    }
    log.push(`${label}: unknown step, skipped`)
  }
  return log
}

const cmds = {
  async devices() {
    const list = devices()
    if (!list.length) return 'no devices attached'
    return list.map((d) => `${d.serial.padEnd(24)} ${d.state.padEnd(10)} ${d.detail}`).join('\n')
  },
  async size() {
    const { w, h } = screenSize()
    return `${w}x${h}`
  },
  async state() {
    requireDevice()
    const { wakefulness, keyguard } = screenState()
    return `screen=${wakefulness} keyguard=${keyguard}`
  },
  async wake() {
    requireDevice()
    await wakeScreen()
    const { wakefulness, keyguard } = await dismissKeyguard()
    return `screen=${wakefulness} keyguard=${keyguard}`
  },
  async unlock() {
    requireDevice()
    await wakeScreen()
    const { wakefulness, keyguard } = await dismissKeyguard()
    return `screen=${wakefulness} keyguard=${keyguard}`
  },
  async 'unlock-pin'(argv) {
    requireDevice()
    const pin = readPin(argv)
    if (!pin) throw new Error('no PIN: set DSH_PIN or pass --pin-file <path>')
    const method = valueOf(argv, '--pin-method') ?? 'text'
    await wakeScreen()
    let state = await dismissKeyguard()
    if (!isLocked(state)) return `already unlocked (keyguard=${state.keyguard}), PIN not used`
    const result = await tryPinOnce(pin, method)
    const tail = result.pressedEnter ? ', pressed ENTER' : ''
    if (!result.ok) {
      throw new Error(`PIN did not unlock (keyguard=${result.state.keyguard}${tail}). ` +
        'Not retrying: repeated failures can escalate the lockout. ' +
        'Check the PIN, or try --pin-method keyevent, or leave the phone unlocked.')
    }
    return `unlocked with ${mask(pin)} via ${method}${tail}`
  },
  async 'wait-unlock'(argv) {
    requireDevice()
    const seconds = Number(valueOf(argv, '--timeout') ?? 120)
    await wakeScreen()
    const state = await waitForUnlock(seconds)
    if (isLocked(state)) throw new Error(`still locked after ${seconds}s (keyguard=${state.keyguard})`)
    return 'unlocked'
  },
  async sleep() {
    requireDevice()
    adbText(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP'])
    return 'screen off'
  },
  async launch(argv) {
    requireDevice()
    const pkg = argv[0]
    if (!pkg) throw new Error('usage: launch <package>')
    adbText(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
    return `launched ${pkg}`
  },
  async kill(argv) {
    requireDevice()
    const pkg = argv[0]
    if (!pkg) throw new Error('usage: kill <package>')
    adbText(['shell', 'am', 'force-stop', pkg])
    return `stopped ${pkg}`
  },
  async shot(argv) {
    requireDevice()
    const out = valueOf(argv, '--out') ?? path.join('shots', `shot-${stamp()}.png`)
    await adbBinaryToFile(['exec-out', 'screencap', '-p'], out)
    return out
  },
  async tap(argv) {
    requireDevice()
    const [x, y] = numbers(argv, 2)
    tap(x, y)
    return `tap ${x},${y}`
  },
  async pct(argv) {
    requireDevice()
    const [fx, fy] = numbers(argv, 2)
    const { w, h } = screenSize()
    const x = Math.round(w * fx)
    const y = Math.round(h * fy)
    tap(x, y)
    return `tap ${x},${y} (${fx},${fy} of ${w}x${h})`
  },
  async swipe(argv) {
    requireDevice()
    const [x1, y1, x2, y2] = numbers(argv, 4)
    const ms = Number(valueOf(argv, '--ms') ?? 300)
    adbText(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)])
    return `swipe ${x1},${y1} -> ${x2},${y2} in ${ms}ms`
  },
  async key(argv) {
    requireDevice()
    const code = argv[0]
    if (!code) throw new Error('usage: key BACK|HOME|ENTER|...')
    adbText(['shell', 'input', 'keyevent', code.toUpperCase()])
    return `key ${code}`
  },
  async text(argv) {
    requireDevice()
    if (!argv.length) throw new Error('usage: text "..."')
    adbText(['shell', 'input', 'text', argv.join(' ').replace(/ /g, '%s')])
    return `text ${argv.join(' ')}`
  },
  async flow(argv) {
    requireDevice()
    const file = argv[0]
    if (!file) throw new Error('usage: flow <steps.json>')
    return (await runFlow(file)).join('\n')
  },
  // One unattended round: wake, unlock, launch, run the flow, close, sleep.
  async cycle(argv) {
    requireDevice()
    const pkg = valueOf(argv, '--game')
    const flow = valueOf(argv, '--flow')
    if (!pkg || !flow) throw new Error('usage: cycle --game <pkg> --flow <steps.json> [--settle 45000]')
    const settle = Number(valueOf(argv, '--settle') ?? 45000)
    const pin = readPin(argv)
    const pinMethod = valueOf(argv, '--pin-method') ?? 'text'
    const waitUnlock = Number(valueOf(argv, '--wait-unlock') ?? 0)
    const log = []
    const started = Date.now()

    let state = await wakeScreen()
    log.push(`wake: screen=${state.wakefulness} keyguard=${state.keyguard}`)
    state = await dismissKeyguard()
    log.push(`dismiss: keyguard=${state.keyguard}`)

    if (isLocked(state) && pin) {
      const result = await tryPinOnce(pin, pinMethod)
      state = result.state
      log.push(`pin: ${result.ok ? 'unlocked' : 'FAILED'} (${mask(pin)}, ${pinMethod}${result.pressedEnter ? ', ENTER' : ''})`)
    }
    if (isLocked(state) && waitUnlock > 0) {
      state = await waitForUnlock(waitUnlock)
      log.push(`wait: keyguard=${state.keyguard} after ${waitUnlock}s`)
    }
    if (isLocked(state)) {
      throw new Error('still locked — refusing to tap blind. ' + log.join(' | '))
    }

    adbText(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
    log.push(`launch: ${pkg}, waiting ${settle}ms`)
    await sleep(settle)

    log.push(...(await runFlow(flow)))

    const evidence = path.join('shots', `cycle-${stamp()}.png`)
    await adbBinaryToFile(['exec-out', 'screencap', '-p'], evidence)
    log.push(`evidence: ${evidence}`)

    if (!argv.includes('--no-kill')) {
      adbText(['shell', 'am', 'force-stop', pkg])
      log.push(`kill: ${pkg}`)
    }
    if (!argv.includes('--no-sleep')) {
      await sleep(1200)
      adbText(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP'])
      log.push('sleep: screen off')
    }
    log.push(`done in ${Math.round((Date.now() - started) / 1000)}s`)
    return log.join('\n')
  },
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function numbers(argv, count) {
  const nums = argv.filter((a) => /^-?\d+(\.\d+)?$/.test(a)).slice(0, count).map(Number)
  if (nums.length < count) throw new Error(`expected ${count} numbers, got ${nums.length}`)
  return nums
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const [command, ...rest] = process.argv.slice(2)
if (!command || command === 'help' || command === '--help') {
  console.log(Object.keys(cmds).join(' | '))
  process.exit(0)
}
if (!cmds[command]) {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
try {
  const result = await cmds[command](rest)
  if (result) console.log(result)
} catch (error) {
  console.error(`error: ${error.message}`)
  process.exit(1)
}
