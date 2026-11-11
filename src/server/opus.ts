/**
 * The models, through the Claude Code CLI (claude.ts):
 * one process per answer, no tools, an empty folder, structured output. Things and looks go to
 * Opus while it keeps up; when more designs are in flight at once than Opus was measured to keep
 * up with, or Opus has failed, or missed its crates twice running, the next ones go to Sonnet,
 * then Haiku ("if the game sees it's becoming congested, then switch to sonnet or haiku
 * online"). Arenas always go to Opus; taunts and thesis titles to Haiku.
 */

import os from 'node:os'

import { Claude, findClaude, once } from './claude'
import type { ArenaSetting } from '../protocol'
import { ARENA_SCHEMA, LINES_SCHEMA, LINES_SYSTEM, THING_SCHEMA, THING_SYSTEM, WEAR_SCHEMA, WEAR_SYSTEM, arenaSystem, type ArenaAnswer, type Schema, type ThingAnswer, type WearAnswer } from './prompts'
import type { Phrase } from './voice'

export type ModelName = 'opus' | 'sonnet' | 'haiku'
const LEVELS: ModelName[] = ['opus', 'sonnet', 'haiku']
/**
 * Designs in flight from which the next goes to Sonnet, and from which to Haiku. Measured on
 * 2026-11-11 (Opus, the thing prompt): with 1, 2 and 4 designs at once Opus took a median 25,
 * 21 and 25 s, so four at once are no slower than one; more were not measured.
 */
export const TO_SONNET = 4
const TO_HAIKU = 6
/** A design answered less than this before its crate falls back to the archive missed it (the trial and filling it take the rest). */
const MARGIN_MS = 2000
/** How long a model that failed, or missed its crates twice running, is passed over. */
const SLOW_FOR_MS = 120_000

export interface Answered<T> {
  data: T
  model: ModelName
  ms: number
}

/** What the game asks of the models; tests give a fake. */
export interface Designers {
  /**
   * A thing's design. crateMs: how long its crate waits for it from now, before a thing from the
   * archive takes its place (null: no crate waits for it yet, as for a thing brought to a defence
   * made in the break).
   */
  thing(message: string, timeoutMs: number, crateMs: number | null): Promise<Answered<ThingAnswer>>
  wear(message: string, timeoutMs: number): Promise<Answered<WearAnswer>>
  arena(setting: ArenaSetting, message: string, timeoutMs: number): Promise<Answered<ArenaAnswer>>
  /** Taunts as their phrases, each with its tone. */
  taunts(message: string): Promise<Phrase[][]>
  titles(message: string): Promise<string[]>
  /** The model the next design would go to. */
  next(): ModelName
  close(): void
}

/** Chooses the model for the next design by how busy they are and how they have kept up. */
export class Picker {
  inFlight = 0
  private readonly slowUntil: Record<ModelName, number> = { opus: 0, sonnet: 0, haiku: 0 }
  /** Each model's thing designs in a row, up to now, that missed their crates. */
  private readonly missed: Record<ModelName, number> = { opus: 0, sonnet: 0, haiku: 0 }

  constructor(private readonly now: () => number) {}

  pick(): ModelName {
    let level = this.inFlight >= TO_HAIKU ? 2 : this.inFlight >= TO_SONNET ? 1 : 0
    while (level < 2 && this.slowUntil[LEVELS[level]!] > this.now()) level++
    return LEVELS[level]!
  }

  /**
   * A failed design passes its model over for a while, and so do two in a row that missed their
   * crates: one alone is no sign of congestion (measured, 7 of 20 Opus designs took over 28 s, one
   * to four at once). Each is judged by its own crate's time (crateMs, from when it was asked).
   * A design no crate waits for counts toward no streak, slow or not: a look, or a thing brought
   * to a defence made in the break; two slow ones there would have passed Opus over for the round.
   */
  done(model: ModelName, crateMs: number | null, ms: number, failed: boolean): void {
    if (crateMs !== null) this.missed[model] = ms > crateMs - MARGIN_MS ? this.missed[model] + 1 : 0
    if (failed || this.missed[model] >= 2) {
      this.slowUntil[model] = this.now() + SLOW_FOR_MS
      this.missed[model] = 0
    }
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

  /** A design through the picker: in-flight counted, a late or failed model marked, late by the whole wait (a second try included). */
  private async design<T>(crateMs: number | null, system: string, schema: Schema, message: string, timeoutMs: number): Promise<Answered<T>> {
    const model = this.picker.pick()
    this.picker.inFlight++
    const t0 = Date.now()
    try {
      const a = await this.ask<T>(model, system, schema, message, timeoutMs)
      this.picker.done(model, crateMs, Date.now() - t0, false)
      return a
    } catch (err) {
      this.picker.done(model, crateMs, Date.now() - t0, true)
      this.log(`${model} failed: ${(err as Error).message}`)
      throw err
    } finally {
      this.picker.inFlight--
    }
  }

  next(): ModelName {
    return this.picker.pick()
  }

  thing(message: string, timeoutMs: number, crateMs: number | null) {
    return this.design<ThingAnswer>(crateMs, THING_SYSTEM, THING_SCHEMA, message, timeoutMs)
  }

  wear(message: string, timeoutMs: number) {
    // No crate waits for a look.
    return this.design<WearAnswer>(null, WEAR_SYSTEM, WEAR_SCHEMA, message, timeoutMs)
  }

  arena(setting: ArenaSetting, message: string, timeoutMs: number) {
    return this.ask<ArenaAnswer>('opus', arenaSystem(setting), ARENA_SCHEMA, message, timeoutMs)
  }

  async taunts(message: string): Promise<Phrase[][]> {
    return (await this.ask<{ lines: { phrases: Phrase[] }[] }>('haiku', LINES_SYSTEM.taunt, LINES_SCHEMA.taunt, message, 40_000)).data.lines.map((l) => l.phrases)
  }

  async titles(message: string): Promise<string[]> {
    return (await this.ask<{ lines: string[] }>('haiku', LINES_SYSTEM.title, LINES_SCHEMA.title, message, 40_000)).data.lines
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
