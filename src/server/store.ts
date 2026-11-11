/**
 * The library on disk, kept between runs: one pretty-printed JSON file per thing, worn part and
 * arena (`things/`, `wear/`, `arenas/`), every taunt (in the style written now) and thesis title
 * ever handed out with the ones ready to go (`lines.json`), and `log.jsonl` (git-ignored) with
 * every request and how it went, every taunt said among them. Only the dev server writes it.
 * Reading skips a file it cannot parse, and says so.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { Slot } from '../protocol'
import type { ThingDesign } from '../sim/things'
import { TAUNT_STYLE } from './prompts'
import type { Phrase } from './voice'

export interface WearDesign {
  id: string
  name: string
  slot: Slot
  code: string
  ask: string
  by: string
  model: string
  made: string
}

export interface ArenaDesign {
  id: string
  name: string
  setting: string
  code: string
  model: string
  ms: number
  made: string
}

export interface LineStock<T> {
  /** Every line handed out, never again, as read. */
  used: string[]
  /** Written and not yet handed out. */
  ready: T[]
}

export interface Lines {
  /** Each taunt as its phrases, each with its tone, all written in one style. */
  taunts: LineStock<Phrase[]> & { style: typeof TAUNT_STYLE }
  titles: LineStock<string>
}

/** A line as read: a title, or a taunt's phrases one after the other. */
export const lineText = (line: string | Phrase[]): string => (typeof line === 'string' ? line : line.map((p) => p.text).join(' '))

/** A file name and id: lowercase a-z, 0-9 and single dashes. */
export function slug(s: string): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return out || 'thing'
}

/** Two lines are the same line when they read the same without case, spaces and stops. */
export const lineKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

export class Store {
  readonly things = new Map<string, ThingDesign>()
  readonly wear = new Map<string, WearDesign>()
  readonly arenas = new Map<string, ArenaDesign>()
  lines: Lines = { taunts: { style: TAUNT_STYLE, used: [], ready: [] }, titles: { used: [], ready: [] } }

  constructor(
    readonly dir: string,
    private readonly log: (message: string) => void,
  ) {
    for (const sub of ['things', 'wear', 'arenas']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
    this.readAll('things', this.things)
    this.readAll('wear', this.wear)
    this.readAll('arenas', this.arenas)
    // Taunts in another style than TAUNT_STYLE are dropped once, ready and handed out alike, so
    // Haiku is never shown them; the titles stay. Those from before modern English (2026-11-11)
    // have no style, some not even phrases. Every taunt said is still in the log.
    const lines = this.readJson<Omit<Lines, 'taunts'> & { taunts: LineStock<Phrase[]> & { style?: string } }>(path.join(dir, 'lines.json'))
    if (lines) {
      const { style, used, ready } = lines.taunts
      if (style === TAUNT_STYLE) this.lines = { taunts: { style, used, ready }, titles: lines.titles }
      else {
        this.lines = { taunts: { style: TAUNT_STYLE, used: [], ready: [] }, titles: lines.titles }
        log(`lines.json: the taunts were written ${style ? `in the style "${style}"` : 'before modern English'}: ${ready.length} ready and ${used.length} handed out dropped, for Haiku to write anew in the style "${TAUNT_STYLE}"`)
        this.saveLines()
      }
    }
  }

  private readJson<T>(file: string): T | null {
    if (!fs.existsSync(file)) return null
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T
    } catch (err) {
      this.log(`skipped ${file}: ${(err as Error).message}`)
      return null
    }
  }

  private readAll<T extends { id: string }>(sub: string, into: Map<string, T>): void {
    for (const f of fs.readdirSync(path.join(this.dir, sub)).filter((f) => f.endsWith('.json')).sort()) {
      const e = this.readJson<T>(path.join(this.dir, sub, f))
      if (e && typeof e.id === 'string') into.set(e.id, e)
    }
  }

  /** An id not taken yet in that folder, from a name. */
  freeId(sub: 'things' | 'wear' | 'arenas', name: string): string {
    const taken = sub === 'things' ? this.things : sub === 'wear' ? this.wear : this.arenas
    const base = slug(name)
    let id = base
    for (let k = 2; taken.has(id) || fs.existsSync(path.join(this.dir, sub, `${id}.json`)); k++) id = `${base}-${k}`
    return id
  }

  private write(sub: string, id: string, data: unknown): void {
    fs.writeFileSync(path.join(this.dir, sub, `${id}.json`), `${JSON.stringify(data, null, 2)}\n`)
  }

  saveThing(d: ThingDesign): void {
    this.things.set(d.id, d)
    this.write('things', d.id, d)
  }

  saveWear(d: WearDesign): void {
    this.wear.set(d.id, d)
    this.write('wear', d.id, d)
  }

  saveArena(d: ArenaDesign): void {
    this.arenas.set(d.id, d)
    this.write('arenas', d.id, d)
  }

  saveLines(): void {
    fs.writeFileSync(path.join(this.dir, 'lines.json'), `${JSON.stringify(this.lines, null, 2)}\n`)
  }

  append(entry: Record<string, unknown>): void {
    fs.appendFileSync(path.join(this.dir, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  }
}
