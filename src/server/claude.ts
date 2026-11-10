/**
 * The Claude Code CLI, driven headless on the host's own subscription, so no API key is needed.
 * Every process runs from an empty temporary folder with no tools, no MCP servers and only the
 * (empty) project's settings, so nothing of the repo or the user's CLAUDE.md reaches the models;
 * answers are structured output against a JSON schema. A Session is one process for a number of
 * turns; `once` is a process for one answer (one per design).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile()
const dirs = (p: string) => (fs.existsSync(p) ? fs.readdirSync(p) : [])
const version = (s: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(s) ?? ['', '0', '0', '0']).slice(1).map(Number)
const newestFirst = (a: string, b: string) => {
  const [x, y] = [version(a), version(b)]
  return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!
}

/** The CLI: CLAUDE_BIN, the PATH, the desktop app's copy (<version>/<hash>/claude) and the VS Code extension's, newest first. */
export function findClaude(env: NodeJS.ProcessEnv, home: string): string | null {
  if (env.CLAUDE_BIN && isFile(env.CLAUDE_BIN)) return env.CLAUDE_BIN
  for (const dir of (env.PATH ?? '').split(path.delimiter)) if (dir && isFile(path.join(dir, 'claude'))) return path.join(dir, 'claude')
  const desktop = path.join(home, '.config', 'Claude', 'claude-code')
  for (const v of dirs(desktop).filter((d) => /^\d+\.\d+\.\d+/.test(d)).sort(newestFirst))
    for (const hash of dirs(path.join(desktop, v))) if (isFile(path.join(desktop, v, hash, 'claude'))) return path.join(desktop, v, hash, 'claude')
  const extensions = path.join(home, '.vscode', 'extensions')
  for (const ext of dirs(extensions).filter((d) => d.startsWith('anthropic.claude-code-')).sort(newestFirst)) {
    const bin = path.join(extensions, ext, 'resources', 'native-binary', 'claude')
    if (isFile(bin)) return bin
  }
  return null
}

/** What a process is for: the model, its system prompt and the schema it answers in. */
export interface Spec {
  model: string
  system: string
  schema: Record<string, unknown>
}

export interface AskOpts {
  timeoutMs: number
  /** The reply so far as it streams in (its length tells the progress), or null. */
  onText: ((text: string) => void) | null
  /** Aborting kills the process. */
  signal: AbortSignal | null
}

export interface Answer {
  data: unknown
  ms: number
}

/** The CLI answered with an error; `subtype` says which ('error_max_structured_output_retries', 'error_during_execution'...). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly subtype: string,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

interface ResultEvent {
  type: 'result'
  subtype: string
  is_error: boolean
  result?: string
  structured_output?: unknown
}

interface StreamEvent {
  type: 'stream_event'
  event: { type: string; delta?: { type: string; text?: string; partial_json?: string } }
}

/** The answer in a result event: its structured output, or JSON in its text. */
function answerOf(e: ResultEvent): unknown {
  if (e.is_error || e.subtype !== 'success') throw new CliError(`the CLI said ${e.subtype}: ${String(e.result ?? '').slice(0, 300)}`, e.subtype)
  if (e.structured_output !== undefined) return e.structured_output
  try {
    return JSON.parse(String(e.result).replace(/^\s*```(?:json)?|```\s*$/g, ''))
  } catch {
    throw new CliError(`no JSON in the reply: ${String(e.result).slice(0, 300)}`, 'no_json')
  }
}

/** Starts CLI processes in one empty folder and kills whatever is still running on close. */
export class Claude {
  private dir: string | null = null
  private readonly live = new Set<ChildProcess>()

  constructor(
    readonly bin: string,
    private readonly log: (message: string) => void,
  ) {}

  /** Asks again once when the CLI gave up fitting the schema: a second try usually fits. */
  async retrying(ask: () => Promise<Answer>): Promise<Answer> {
    try {
      return await ask()
    } catch (err) {
      if (!(err instanceof CliError && err.subtype === 'error_max_structured_output_retries')) throw err
      this.log('the CLI gave up fitting the schema: asking once more')
      return ask()
    }
  }

  spawn(spec: Spec): ChildProcess {
    this.dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dissertation-claude-'))
    const args = [
      '-p', '--model', spec.model, '--tools', '', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence',
      '--system-prompt', spec.system, '--json-schema', JSON.stringify(spec.schema), '--effort', 'low',
      '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
    ]
    const child = spawn(this.bin, args, { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'] })
    this.live.add(child)
    child.once('close', () => this.live.delete(child))
    return child
  }

  close(): void {
    for (const child of this.live) child.kill()
    this.live.clear()
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true })
    this.dir = null
  }
}

interface Turn {
  t0: number
  text: string
  onText: ((text: string) => void) | null
  done: (err: Error | null, answer: Answer | null) => void
}

/**
 * One CLI process kept for many turns, one turn at a time (the rest wait in line). It starts
 * again after `maxTurns` answers, and after any error or timeout, with a fresh conversation.
 */
export class Session {
  private child: ChildProcess | null = null
  private turn: Turn | null = null
  private line: Promise<unknown> = Promise.resolve()
  private turns = 0
  private stderr = ''

  constructor(
    private readonly claude: Claude,
    private readonly spec: Spec,
    private readonly maxTurns: number,
  ) {}

  /** Starts the process ahead of the first turn: a cold start costs a second or so. */
  start(): void {
    if (this.child) return
    const child = this.claude.spawn(this.spec)
    this.child = child
    this.turns = 0
    this.stderr = ''
    let buf = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (this.child === child) this.onLine(line)
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString()).slice(-2000)))
    // A process that died mid-write must not take the dev server down: its 'close' ends the turn.
    child.stdin!.on('error', () => {})
    const gone = (why: string) => {
      if (this.child !== child) return
      this.child = null
      this.turn?.done(new Error(`the CLI ${why}: ${this.stderr.trim().slice(-300)}`), null)
    }
    child.on('error', (err) => gone(`failed to start (${err.message})`))
    child.on('close', (code) => gone(`exited (${code})`))
  }

  private onLine(line: string): void {
    const turn = this.turn
    if (!turn) return
    let e: StreamEvent | ResultEvent | { type: string }
    try {
      e = JSON.parse(line) as typeof e
    } catch {
      return // not an event: the CLI's own chatter
    }
    if (e.type === 'stream_event') {
      const d = (e as StreamEvent).event.delta
      const piece = d?.type === 'text_delta' ? d.text : d?.type === 'input_json_delta' ? d.partial_json : undefined
      if (piece) {
        turn.text += piece
        turn.onText?.(turn.text)
      }
    } else if (e.type === 'result') {
      try {
        turn.done(null, { data: answerOf(e as ResultEvent), ms: Date.now() - turn.t0 })
      } catch (err) {
        turn.done(err as Error, null)
      }
    }
  }

  /** One turn: the answer, or an error after which the session starts afresh. */
  ask(prompt: string, opts: AskOpts): Promise<Answer> {
    const run = () =>
      new Promise<Answer>((resolve, reject) => {
        if (opts.signal?.aborted) return reject(new Error('aborted'))
        this.start()
        const timer = setTimeout(() => this.turn?.done(new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)} s`), null), opts.timeoutMs)
        const abort = () => this.turn?.done(new Error('aborted'), null)
        opts.signal?.addEventListener('abort', abort, { once: true })
        this.turn = {
          t0: Date.now(),
          text: '',
          onText: opts.onText,
          done: (err, answer) => {
            clearTimeout(timer)
            opts.signal?.removeEventListener('abort', abort)
            this.turn = null
            if (err) {
              this.close()
              return reject(err)
            }
            if (++this.turns >= this.maxTurns) this.close()
            resolve(answer!)
          },
        }
        this.child!.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`)
      })
    const turn = this.line.then(run, run)
    this.line = turn.catch(() => {})
    return turn
  }

  close(): void {
    const child = this.child
    this.child = null
    child?.kill()
  }
}

/** One answer from a process of its own. */
export async function once(claude: Claude, spec: Spec, prompt: string, opts: AskOpts): Promise<Answer> {
  const session = new Session(claude, spec, 1)
  try {
    return await claude.retrying(() => session.ask(prompt, opts))
  } finally {
    session.close()
  }
}
