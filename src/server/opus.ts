/**
 * The models, through the Claude Code CLI (claude.ts):
 * one process per answer, no tools, an empty folder, structured output. Things and looks go to
 * Opus while it keeps up; when several designs are in flight at once, or Opus has lately been
 * slow, the next ones go to Sonnet, then Haiku ("if the game sees it's becoming
 * congested, then switch to sonnet or haiku online"). Arenas always go to Opus; taunts and
 * thesis titles to Haiku.
 */

import os from 'node:os'

import { Claude, findClaude, once } from './claude'
import type { ArenaSetting } from '../protocol'
import { ARENA_SCHEMA, LINES_SCHEMA, LINES_SYSTEM, THING_SCHEMA, THING_SYSTEM, WEAR_SCHEMA, WEAR_SYSTEM, arenaSystem, type ArenaAnswer, type Schema, type ThingAnswer, type WearAnswer } from './prompts'

export type ModelName = 'opus' | 'sonnet' | 'haiku'
const LEVELS: ModelName[] = ['opus', 'sonnet', 'haiku']
/** A design that takes longer than this marks its model slow for a while. */
const SLOW_MS = 22_000
const SLOW_FOR_MS = 120_000

export interface Answered<T> {
  data: T
  model: ModelName
  ms: number
}

/** What the game asks of the models; tests give a fake. */
export interface Designers {
  thing(message: string, timeoutMs: number): Promise<Answered<ThingAnswer>>
  wear(message: string, timeoutMs: number): Promise<Answered<WearAnswer>>
  arena(setting: ArenaSetting, message: string, timeoutMs: number): Promise<Answered<ArenaAnswer>>
  lines(kind: 'taunt' | 'title', message: string): Promise<string[]>
  /** The model the next design would go to. */
  next(): ModelName
  close(): void
}

/** Chooses the model for the next design by how busy and how slow they have been. */
export class Picker {
  inFlight = 0
  private readonly slowUntil: Record<ModelName, number> = { opus: 0, sonnet: 0, haiku: 0 }

  constructor(private readonly now: () => number) {}

  pick(): ModelName {
    let level = this.inFlight >= 4 ? 2 : this.inFlight >= 2 ? 1 : 0
    while (level < 2 && this.slowUntil[LEVELS[level]!] > this.now()) level++
    return LEVELS[level]!
  }

  done(model: ModelName, ms: number, failed: boolean): void {
    if (failed || ms > SLOW_MS) this.slowUntil[model] = this.now() + SLOW_FOR_MS
  }
}

export class CliDesigners implements Designers {
  private readonly picker = new Picker(() => Date.now())

  constructor(
    private readonly claude: Claude,
    private readonly log: (message: string) => void,
  ) {}

  private async ask<T>(model: ModelName, system: string, schema: Schema, message: string, timeoutMs: number): Promise<Answered<T>> {
    const answer = await once(this.claude, { model, system, schema }, message, { timeoutMs, onText: null, signal: null })
    return { data: answer.data as T, model, ms: answer.ms }
  }

  /** A design through the picker: in-flight counted, a slow or failed model marked. */
  private async design<T>(system: string, schema: Schema, message: string, timeoutMs: number): Promise<Answered<T>> {
    const model = this.picker.pick()
    this.picker.inFlight++
    const t0 = Date.now()
    try {
      const a = await this.ask<T>(model, system, schema, message, timeoutMs)
      this.picker.done(model, a.ms, false)
      return a
    } catch (err) {
      this.picker.done(model, Date.now() - t0, true)
      this.log(`${model} failed: ${(err as Error).message}`)
      throw err
    } finally {
      this.picker.inFlight--
    }
  }

  next(): ModelName {
    return this.picker.pick()
  }

  thing(message: string, timeoutMs: number) {
    return this.design<ThingAnswer>(THING_SYSTEM, THING_SCHEMA, message, timeoutMs)
  }

  wear(message: string, timeoutMs: number) {
    return this.design<WearAnswer>(WEAR_SYSTEM, WEAR_SCHEMA, message, timeoutMs)
  }

  arena(setting: ArenaSetting, message: string, timeoutMs: number) {
    return this.ask<ArenaAnswer>('opus', arenaSystem(setting), ARENA_SCHEMA, message, timeoutMs)
  }

  async lines(kind: 'taunt' | 'title', message: string): Promise<string[]> {
    const a = await this.ask<{ lines: unknown }>('haiku', LINES_SYSTEM[kind], LINES_SCHEMA, message, 40_000)
    return Array.isArray(a.data.lines) ? a.data.lines.filter((l): l is string => typeof l === 'string') : []
  }

  close(): void {
    this.claude.close()
  }
}

/** The real designers, or null when no CLI is on this computer (then nothing new is made). */
export function designersFromEnv(log: (message: string) => void): Designers | null {
  const bin = findClaude(process.env, os.homedir())
  log(bin ? `Claude: ${bin}` : 'Claude: no CLI found, so nothing new can be made (set CLAUDE_BIN)')
  return bin ? new CliDesigners(new Claude(bin, log), log) : null
}
