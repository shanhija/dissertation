/**
 * The CLI driver against a fake CLI (test/fake-claude.mjs) that prints the real CLI's
 * stream-json events: one-shot answers with streamed progress, a session that keeps its
 * process, and every way a call can go wrong.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Claude, Session, findClaude, once, type AskOpts, type Spec } from './claude'

interface Call {
  pid: number
  turn: number
  argv: string[]
  cwd: string
  prompt: string
}

const SCHEMA = { type: 'object', properties: { name: { type: 'string' }, code: { type: 'string' } }, required: ['name', 'code'] }
const ANSWER = { name: 'Hand Cannon', code: 'return { use() { me.drop() } }' }

let dir: string
let claude: Claude
const logs: string[] = []
const calls = (): Call[] => (fs.existsSync(process.env.FAKE_CLAUDE_LOG!) ? fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call) : [])
const spec: Spec = { model: 'haiku', system: 'You are a test.', schema: SCHEMA }
const opts = (more: Partial<AskOpts> = {}): AskOpts => ({ timeoutMs: 5000, onText: null, signal: null, ...more })

/** Waits until `ok()` holds, checking every 20 ms; throws after `ms`. */
async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`waited ${ms} ms for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dissertation-claude-test-'))
  process.env.FAKE_CLAUDE_ANSWER = path.join(dir, 'answer.json')
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'calls.jsonl')
  process.env.FAKE_CLAUDE_STATE = path.join(dir, 'failed-once')
  fs.writeFileSync(process.env.FAKE_CLAUDE_ANSWER, JSON.stringify(ANSWER))
  // An executable that runs the fake script with this very node, as if it were the real CLI.
  const bin = path.join(dir, 'fake-claude')
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL('test/fake-claude.mjs', import.meta.url))}" "$@"\n`, { mode: 0o755 })
  claude = new Claude(bin, (m) => logs.push(m))
})
afterEach(() => {
  claude.close()
  fs.rmSync(process.env.FAKE_CLAUDE_LOG!, { force: true })
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('findClaude', () => {
  it('looks in CLAUDE_BIN, the PATH, the desktop app and the VS Code extension, newest first', () => {
    const home = path.join(dir, 'home')
    const put = (...parts: string[]) => {
      const file = path.join(home, ...parts)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '')
      return file
    }
    const ext = (v: string) => put('.vscode', 'extensions', `anthropic.claude-code-${v}-linux-x64`, 'resources', 'native-binary', 'claude')
    expect(findClaude({ PATH: '' }, home)).toBeNull()
    ext('2.1.2')
    const newestExt = ext('2.1.11')
    expect(findClaude({ PATH: '' }, home)).toBe(newestExt)
    put('.config', 'Claude', 'claude-code', '2.1.9', 'aaaa', 'claude')
    const desktop = put('.config', 'Claude', 'claude-code', '2.1.10', 'bbbb', 'claude')
    expect(findClaude({ PATH: '' }, home)).toBe(desktop)
    const onPath = put('bin', 'claude')
    expect(findClaude({ PATH: ['/nowhere', path.dirname(onPath)].join(path.delimiter) }, home)).toBe(onPath)
    expect(findClaude({ PATH: path.dirname(onPath), CLAUDE_BIN: newestExt }, home)).toBe(newestExt)
    expect(findClaude({ PATH: '', CLAUDE_BIN: '/no/such/claude' }, home)).toBe(desktop)
  })
})

describe('once', () => {
  it('answers with the structured output, streaming the reply as it comes', async () => {
    const texts: string[] = []
    const answer = await once(claude, spec, 'Make a hand cannon.', opts({ onText: (t) => texts.push(t) }))
    expect(answer.data).toEqual(ANSWER)
    expect(answer.ms).toBeGreaterThanOrEqual(0)
    expect(texts.length).toBeGreaterThan(1)
    expect(texts.at(-1)).toBe(JSON.stringify(ANSWER))
    const [call] = calls()
    expect(call!.prompt).toBe('Make a hand cannon.')
    expect(call!.argv).toEqual([
      '-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence',
      '--system-prompt', 'You are a test.', '--json-schema', JSON.stringify(SCHEMA), '--effort', 'low',
      '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
    ])
    // An empty folder of its own, so no CLAUDE.md or settings reach the model.
    expect(call!.cwd.startsWith(os.tmpdir())).toBe(true)
    expect(fs.readdirSync(call!.cwd)).toEqual([])
    await until(() => !alive(call!.pid), 2000, 'the process to end')
  })

  it('reads the JSON from the text when there is no structured output', async () => {
    expect((await once(claude, spec, 'TEXT_JSON', opts())).data).toEqual(ANSWER)
  })

  it('asks once more when the CLI gave up fitting the schema', async () => {
    fs.rmSync(process.env.FAKE_CLAUDE_STATE!, { force: true })
    expect((await once(claude, spec, 'FAIL_ONCE', opts())).data).toEqual(ANSWER)
    const [first, second] = calls()
    expect(first!.pid).not.toBe(second!.pid)
    expect(logs).toContain('the CLI gave up fitting the schema: asking once more')
  })

  it('times out and kills the process', async () => {
    await expect(once(claude, spec, 'HANG', opts({ timeoutMs: 2000 }))).rejects.toThrow('timed out after 2 s')
    await until(() => !alive(calls()[0]!.pid), 2000, 'the hung process to be killed')
  })

  it('stops when aborted', async () => {
    const abort = new AbortController()
    const asked = once(claude, spec, 'HANG', opts({ signal: abort.signal }))
    await until(() => calls().length === 1, 5000, 'the hung turn to start')
    abort.abort()
    await expect(asked).rejects.toThrow('aborted')
    await until(() => !alive(calls()[0]!.pid), 2000, 'the aborted process to be killed')
    const aborted = new AbortController()
    aborted.abort()
    await expect(once(claude, spec, 'A hat.', opts({ signal: aborted.signal }))).rejects.toThrow('aborted')
  })

  it('fails with what the CLI said when it exits mid-turn', async () => {
    await expect(once(claude, spec, 'CRASH', opts())).rejects.toThrow(/the CLI exited \(3\): fake claude ready/)
  })

  it('fails when the CLI cannot start', async () => {
    const missing = new Claude(path.join(dir, 'no-such-claude'), () => {})
    await expect(once(missing, spec, 'A hat.', opts())).rejects.toThrow(/the CLI failed to start/)
    missing.close()
  })
})

describe('Session', () => {
  it('keeps one process, one turn at a time, and starts afresh after maxTurns', async () => {
    const session = new Session(claude, spec, 3)
    const answers = await Promise.all([1, 2, 3, 4].map((n) => session.ask(`turn ${n}`, opts())))
    expect(answers.map((a) => a.data)).toEqual([ANSWER, ANSWER, ANSWER, ANSWER])
    const log = calls()
    expect(log.map((c) => c.prompt)).toEqual(['turn 1', 'turn 2', 'turn 3', 'turn 4'])
    expect(log.map((c) => c.turn)).toEqual([1, 2, 3, 1])
    expect(new Set(log.slice(0, 3).map((c) => c.pid)).size).toBe(1)
    expect(log[3]!.pid).not.toBe(log[0]!.pid)
    session.close()
  })

  it('starts afresh after an error and keeps answering', async () => {
    const session = new Session(claude, spec, 12)
    await session.ask('first', opts())
    await expect(session.ask('CRASH', opts())).rejects.toThrow(/exited/)
    await expect(session.ask('HANG', opts({ timeoutMs: 1500 }))).rejects.toThrow(/timed out/)
    expect((await session.ask('after', opts())).data).toEqual(ANSWER)
    const pids = calls().map((c) => c.pid)
    expect(new Set(pids).size).toBe(3)
    session.close()
  })

  it('starts its process ahead of the first turn', async () => {
    const session = new Session(claude, spec, 12)
    session.start()
    session.start()
    await session.ask('warm', opts())
    expect(calls()[0]!.turn).toBe(1)
    session.close()
  })
})
