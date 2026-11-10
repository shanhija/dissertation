/**
 * The doctors' voices, made on the server (2026-11-10: "i would like the taunts to be generated on
 * the server and sent to clients. and not rely on client functionality. if there's a smallish model
 * that could produce varying sounds with varying tones, that would be awesome"). Before, each
 * browser spoke taunts with its own voices, and Chromium on Linux has none.
 *
 * Kokoro-82M (Apache-2.0, `npm install` fetches it into node_modules/.cache/voice) speaks every
 * line in a worker thread (voice-worker.ts), as MP3 that goes out with the taunt. Every doctor has
 * a voice of their own, worked out from their browser's key so a friend sounds the same every
 * game: two of Kokoro's men mixed, an accent (mostly English), a pace, an age and a temper, the
 * tone they fall into most. Every doctor is a pompous old man (2026-11-10: "can you make the
 * taunts male and more pomptous and oldish?"): slow, and played back a little slower than Kokoro
 * said it (Kokoro is asked to hurry by as much), which lowers the pitch and the whole voice as in
 * a bigger, older man, with a slight tremble of age in the pitch. Each line is said in a tone: the
 * doctor's prosody (pitch, pace, intonation) is pulled toward voices that speak that way while
 * the timbre stays theirs, a man's in every tone. Measured on three doctors (2026-11-10), before
 * the age: booming lowers the pitch and slows down, indignant raises it about a fifth and hurries,
 * gloating swings it wider, hushed is slower and breathier, sniffy is slower and plummier. The ear
 * has the last word: TONES and the ranges in speakerOf are what to tune.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

/** Kokoro's English men the doctors are mixed from, American (am) and British (bm), and Nicole, whose prosody alone (her whisper, never her timbre) is the hushed tone. Adam is left out: his makers grade him F. */
export const MEN = ['am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'] as const
export const KOKORO = [...MEN, 'af_nicole'] as const
export type KokoroVoice = (typeof KOKORO)[number]
type Man = (typeof MEN)[number]

/** The voices a doctor's own sound is mostly made of: the English gentlemen and the steadier Americans (measured with English phonemes: Lewis 81 Hz, Onyx 88, Michael 114, Fable 114, Daniel 122, Fenrir 137, George 142). */
const LEADING: Man[] = ['bm_george', 'bm_lewis', 'bm_fable', 'bm_daniel', 'am_michael', 'am_fenrir', 'am_onyx']

export type Accent = 'en' | 'en-us'
/** Voices by weight (the worker divides by the sum). */
export type Mix = [KokoroVoice, number][]

export type Tone = 'plain' | 'booming' | 'indignant' | 'gloating' | 'hushed' | 'sniffy'

interface ToneRecipe {
  /** The voices that speak this way: only their prosody (pitch, pace, intonation) is taken. */
  toward: Mix
  /** How far the prosody goes toward them, 0..1. */
  prosody: number
  /** Times the doctor's own pace. */
  speed: number
  /** Loudness against a plain line, dB. */
  db: number
}

/** Measured on George with Onyx, Fable with Santa and Michael with Lewis (2026-11-10), before the age deepens them: pitches in Hz from plain. */
const TONES: Record<Tone, ToneRecipe> = {
  plain: { toward: [], prosody: 0, speed: 1, db: 0 },
  /** A pronouncement: lower and slower. */
  booming: { toward: [['bm_lewis', 1], ['am_onyx', 1]], prosody: 0.6, speed: 0.9, db: 2 },
  /** How dare you, sir: up from 123, 133, 112 to 145, 153, 150, quicker, swinging wider. */
  indignant: { toward: [['am_eric', 1], ['am_santa', 1]], prosody: 0.65, speed: 1.05, db: 1 },
  /** Chuckling: Santa's wide swing. */
  gloating: { toward: [['am_santa', 1]], prosody: 0.7, speed: 0.95, db: 0 },
  /** An aside: Nicole's slow breathy delivery (a third longer at the same speed), up 10 Hz or so, quiet. */
  hushed: { toward: [['af_nicole', 1]], prosody: 0.6, speed: 1.15, db: -5 },
  /** Haughty: George's and Daniel's measured delivery, slower. */
  sniffy: { toward: [['bm_george', 1], ['bm_daniel', 1]], prosody: 0.7, speed: 0.88, db: -1 },
}
const TEMPERS = (Object.keys(TONES) as Tone[]).filter((t) => t !== 'plain')

export interface Speaker {
  accent: Accent
  /** What the doctor's own voice is mixed from, their timbre and their usual prosody alike. */
  own: [Man, number][]
  /** Their usual pace, as heard. */
  pace: number
  /** Their age: played back at this rate (under 1, lower and fuller), the pitch trembling by `depth` (a share of it) `hz` times a second. */
  age: Age
  /** The tone they fall into most. */
  temper: Tone
}

export interface Age {
  deepen: number
  depth: number
  hz: number
}

/** A doctor's voice from their browser's key: the same key, the same voice. */
export function speakerOf(key: string): Speaker {
  // FNV-1a into mulberry32.
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  const rnd = () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const lead = LEADING[Math.floor(rnd() * LEADING.length)]!
  const others = MEN.filter((v) => v !== lead)
  const second = others[Math.floor(rnd() * others.length)]!
  const w = 0.2 + rnd() * 0.25
  return {
    accent: rnd() < 0.75 ? 'en' : 'en-us',
    own: [
      [lead, 1 - w],
      [second, w],
    ],
    pace: 0.86 + rnd() * 0.1,
    age: { deepen: 0.88 + rnd() * 0.06, depth: 0.008 + rnd() * 0.008, hz: 4.5 + rnd() * 1.5 },
    temper: TEMPERS[Math.floor(rnd() * TEMPERS.length)]!,
  }
}

/** The tone of one line: the doctor's temper two times in five, plain one in five, else any other. */
export function toneFor(s: Speaker, random: () => number): Tone {
  const r = random()
  if (r < 0.4) return s.temper
  if (r < 0.6) return 'plain'
  const rest = TEMPERS.filter((t) => t !== s.temper)
  return rest[Math.floor(random() * rest.length)]!
}

/** What the worker is asked: a line, its accent, the style's two halves as mixes of voices, the pace as heard, the age and the level. */
export interface Render {
  id: number
  text: string
  accent: Accent
  timbre: Mix
  prosody: Mix
  speed: number
  age: Age
  db: number
}

export type Rendered = { id: number; mp3: Uint8Array; secs: number } | { id: number; error: string }

export function recipe(text: string, s: Speaker, tone: Tone): Omit<Render, 'id'> {
  const t = TONES[tone]
  const total = t.toward.reduce((a, [, x]) => a + x, 0)
  const prosody: Mix = [...s.own.map(([v, w]): [KokoroVoice, number] => [v, w * (1 - t.prosody)]), ...t.toward.map(([v, w]): [KokoroVoice, number] => [v, (w / total) * t.prosody])]
  return { text, accent: s.accent, timbre: s.own, prosody, speed: s.pace * t.speed, age: s.age, db: t.db }
}

/** A line as said. */
export interface Speech {
  /** MP3, base64. */
  mp3: string
  tone: Tone
  secs: number
  /** How long it took to make. */
  ms: number
}

export interface Voice {
  /** The line as the doctor with this key says it, in a tone picked for it. */
  say(text: string, key: string): Promise<Speech>
  close(): void
}

/** Cores the worker may use: measured on a 6-core i7-8750H, 4 speak a 6 s line in 1.9 s and more are no faster. */
const THREADS = 4

class Kokoro implements Voice {
  private readonly worker: Worker
  private readonly waiting = new Map<number, { resolve: (s: Speech) => void; reject: (e: Error) => void; tone: Tone; t0: number }>()
  private seq = 0
  private broken: Error | null = null

  constructor(dir: string, log: (message: string) => void) {
    this.worker = new Worker(new URL('./voice-worker.ts', import.meta.url), { workerData: { dir, threads: THREADS } })
    // A game that is not closed still lets the process end.
    this.worker.unref()
    this.worker.on('message', (m: Rendered) => {
      const w = this.waiting.get(m.id)
      if (!w) return
      this.waiting.delete(m.id)
      if ('error' in m) w.reject(new Error(m.error))
      else w.resolve({ mp3: Buffer.from(m.mp3).toString('base64'), tone: w.tone, secs: m.secs, ms: Math.round(performance.now() - w.t0) })
    })
    const stop = (err: Error) => {
      if (this.broken) return
      this.broken = err
      log(`voice: ${err.message}`)
      for (const w of this.waiting.values()) w.reject(err)
      this.waiting.clear()
    }
    this.worker.on('error', stop)
    this.worker.on('exit', (code) => stop(new Error(`the voice stopped (exit code ${code})`)))
  }

  say(text: string, key: string): Promise<Speech> {
    if (this.broken) return Promise.reject(this.broken)
    const speaker = speakerOf(key)
    const tone = toneFor(speaker, Math.random)
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, tone, t0: performance.now() })
      this.worker.postMessage({ id, ...recipe(text, speaker, tone) } satisfies Render)
    })
  }

  close(): void {
    this.broken = new Error('the game closed')
    for (const w of this.waiting.values()) w.reject(this.broken)
    this.waiting.clear()
    void this.worker.terminate()
  }
}

/** Kokoro from what `npm install` fetched into `dir`, or null when it is not all there (then taunts are only read). */
export function voiceFromDisk(dir: string, log: (message: string) => void): Voice | null {
  const missing = ['tokenizer.json', 'onnx/model.onnx', ...KOKORO.map((v) => `voices/${v}.bin`)].filter((f) => !fs.existsSync(path.join(dir, f)))
  if (missing.length) {
    log(`voice: ${missing.length} of Kokoro's files are missing from ${dir}, so taunts are only read (npm run voice fetches them)`)
    return null
  }
  log('voice: Kokoro-82M speaks the taunts')
  return new Kokoro(dir, log)
}
