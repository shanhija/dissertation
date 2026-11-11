/**
 * The doctors' voices, made on the server (2026-11-10: "i would like the taunts to be generated on
 * the server and sent to clients. and not rely on client functionality. if there's a smallish model
 * that could produce varying sounds with varying tones, that would be awesome"). Before, each
 * browser spoke taunts with its own voices, and Chromium on Linux has none.
 *
 * Kokoro-82M (Apache-2.0, `npm install` fetches it into node_modules/.cache/voice) speaks every
 * line in a worker thread (voice-worker.ts), as MP3 that goes out with the taunt. Every doctor has
 * a voice of their own, worked out from their browser's key so a friend sounds the same every
 * game: a man or a woman, two of Kokoro's voices of that sex mixed, led by an English one, a
 * pace, an age and a temper, the tone they fall into most. A player may choose the voice that
 * leads theirs by name in the dressing room (2026-11-11: "allow the player to choose their voice
 * character name"); its sex is then theirs, and the rest still comes from the key.
 *
 * Every doctor is an old British orator (2026-11-10: "can you make the taunts male and more
 * pomptous and oldish?", then "can be woman as well. i'd prefer a bit more similar to old british
 * style with lots of tone changes", "i meant notes. high to low to high"): English phonemes, slow,
 * and played back a little slower than Kokoro said it (Kokoro is asked to hurry by as much), which
 * lowers the pitch and the whole voice as in an older speaker.
 *
 * A line is written as one or two phrases, each with its tone (2026-11-11), and each phrase is
 * said by Kokoro on its own in its tone, so the tone changes within a line and every phrase starts
 * high again; a pause joins them. The doctor's prosody (pitch, pace, intonation) is pulled toward
 * voices of their own sex that speak that way while the timbre stays theirs. The melody is
 * Kokoro's own: widening it afterwards (by PSOLA, each note moved 1.5 to 2.2 times further from
 * the phrase's trend) and an age's tremble in the pitch were what sounded autotuned (2026-11-11:
 * "the voices are, quite flat. considering the docs are fighting", then "these are still flat and
 * autotune-like features stand out in the voice", and of the variants heard side by side: "let's
 * go with No widening, no tremble"). Measured (2026-11-10), before the age: booming lowers the
 * pitch and slows down, indignant raises it about a fifth and hurries, gloating swings it wider,
 * hushed is slower and breathier, sniffy is slower and flatter. The ear has the last word: TONES,
 * PAUSE and the ranges in speakerOf are what to tune, and `npm run voice:bench` says a grid of
 * them to listen to.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

// With its extension: the listening bench runs this file in plain Node.
import { VOICES, type VoiceName } from '../protocol.ts'

/**
 * Kokoro's English voices the doctors are mixed from: those a player may choose (VOICES), and
 * Nicole. Measured with English phonemes: Lewis 81 Hz, Onyx 88, Echo 109, Puck 113, Michael 114,
 * Fable 114, Daniel 122, Liam 126, Fenrir 137, George 142, Santa 150, Eric 160; Alloy 143, Nicole
 * 151 (a whisper), Kore 155, Nova 164, Sky 166, River 178, Emma 180 (the flattest), Aoede 180,
 * Isabella 197, Bella 198, Sarah 198, Heart 205, Lily 205, Jessica 209, Alice 211. Adam is left
 * out: his makers grade him F.
 */
export const KOKORO = [...VOICES, 'af_nicole'] as const
export type KokoroVoice = (typeof KOKORO)[number]
export type Sex = 'man' | 'woman'
export const sexOf = (v: KokoroVoice): Sex => (v[1] === 'm' ? 'man' : 'woman')

/** The voices a doctor's own sound is led by when they choose none: the English ones. The rest of their sex is mixed in (Nicole only as the hushed tone). */
const LEADING: Record<Sex, VoiceName[]> = {
  man: ['bm_george', 'bm_lewis', 'bm_fable', 'bm_daniel'],
  woman: ['bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily'],
}

/** Voices by weight (the worker divides by the sum). */
export type Mix = [KokoroVoice, number][]

export const TONE_NAMES = ['plain', 'booming', 'indignant', 'gloating', 'hushed', 'sniffy'] as const
export type Tone = (typeof TONE_NAMES)[number]

/** A line is said as phrases, each in its own tone. */
export interface Phrase {
  text: string
  tone: Tone
}

interface ToneRecipe {
  /** The voices that speak this way, of each sex: only their prosody (pitch, pace, intonation) is taken. */
  toward: Record<Sex, Mix>
  /** How far the prosody goes toward them, 0..1. */
  prosody: number
  /** Times the doctor's own pace. */
  speed: number
  /** Loudness against a plain phrase, dB. */
  db: number
}

/**
 * Pulling a voice toward the other sex pulls it toward their pitch (Emma's prosody lifted the men
 * 35 Hz), so each tone pulls toward voices of the doctor's own sex, but hushed: Nicole's slow,
 * breathy delivery, which lifts a man only about 10 Hz.
 */
const TONES: Record<Tone, ToneRecipe> = {
  plain: { toward: { man: [], woman: [] }, prosody: 0, speed: 1, db: 0 },
  /** A pronouncement: lower and slower. */
  booming: { toward: { man: [['bm_lewis', 1], ['am_onyx', 1]], woman: [['af_alloy', 1], ['af_kore', 1]] }, prosody: 0.6, speed: 0.9, db: 2 },
  /** How dare you: higher and quicker. */
  indignant: { toward: { man: [['am_eric', 1], ['am_santa', 1]], woman: [['bf_alice', 1], ['af_jessica', 1]] }, prosody: 0.65, speed: 1.05, db: 1 },
  /** Chuckling: the widest swingers. */
  gloating: { toward: { man: [['am_santa', 1]], woman: [['af_aoede', 1], ['bf_alice', 1]] }, prosody: 0.7, speed: 0.95, db: 0 },
  /** An aside: slow, breathy and quiet. */
  hushed: { toward: { man: [['af_nicole', 1]], woman: [['af_nicole', 1]] }, prosody: 0.6, speed: 1.15, db: -5 },
  /** Haughty: a measured delivery, drawled up and down. */
  sniffy: { toward: { man: [['bm_george', 1], ['bm_daniel', 1]], woman: [['bf_emma', 1]] }, prosody: 0.7, speed: 0.88, db: -1 },
}
const TEMPERS = (Object.keys(TONES) as Tone[]).filter((t) => t !== 'plain')

export interface Speaker {
  sex: Sex
  /** What the doctor's own voice is mixed from, their timbre and their usual prosody alike: the voice that leads it, and a second of its sex. */
  own: [[VoiceName, number], [VoiceName, number]]
  /** Their usual pace, as heard. */
  pace: number
  /** Their age: played back at this rate (under 1: lower, fuller and slower). */
  deepen: number
  /** The tone they fall into most. */
  temper: Tone
}

/**
 * A doctor's voice from their browser's key, the same key the same voice: led by the voice the
 * player chose (null: one drawn from the key) and of its sex. The draws are taken in the same
 * order whatever is chosen, so a key keeps its pace, age and temper; two of them set the age's
 * tremble until 2026-11-11 and are still taken, so the temper after them is what it was.
 */
export function speakerOf(key: string, chosen: VoiceName | null): Speaker {
  // FNV-1a into mulberry32.
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  const rnd = () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const drawn: Sex = rnd() < 0.5 ? 'man' : 'woman'
  const ownLead = LEADING[drawn][Math.floor(rnd() * LEADING[drawn].length)]!
  const lead = chosen ?? ownLead
  const sex = sexOf(lead)
  const others = VOICES.filter((v) => v !== lead && sexOf(v) === sex)
  const second = others[Math.floor(rnd() * others.length)]!
  const w = 0.2 + rnd() * 0.25
  const pace = 0.86 + rnd() * 0.1
  // A woman is deepened less: as much takes her toward a man's pitch.
  const deepen = (sex === 'man' ? 0.88 : 0.91) + rnd() * 0.05
  rnd()
  rnd()
  return {
    sex,
    own: [
      [lead, 1 - w],
      [second, w],
    ],
    pace,
    deepen,
    temper: TEMPERS[Math.floor(rnd() * TEMPERS.length)]!,
  }
}

/** How often the first phrase of a line is said in the doctor's temper instead of the tone it was written in. */
const TEMPER = 0.4

/**
 * A line as this doctor says it: two times in five the first phrase in their temper, so tempers
 * show, but never in the tone of the phrase after it, so the tone still changes.
 */
export function delivered(phrases: Phrase[], s: Speaker, random: () => number): Phrase[] {
  return random() < TEMPER && phrases[1]?.tone !== s.temper ? [{ text: phrases[0]!.text, tone: s.temper }, ...phrases.slice(1)] : phrases
}

/** The tones that answer each tone, for a phrase after it. */
const CONTRAST: Record<Tone, [Tone, Tone]> = {
  plain: ['indignant', 'booming'],
  booming: ['sniffy', 'hushed'],
  indignant: ['hushed', 'gloating'],
  gloating: ['booming', 'indignant'],
  hushed: ['indignant', 'booming'],
  sniffy: ['booming', 'gloating'],
}

/**
 * A line written without tones (the game's own) as phrases: cut after , ; : ! ? into at most
 * three, the first in any tone and each after it in a tone answering the one before.
 */
export function phrased(text: string, random: () => number): Phrase[] {
  const parts = (text.match(/[^,;:!?]+[,;:!?]*/g) ?? []).map((t) => t.trim()).filter((t) => /\p{L}/u.test(t))
  const cut = [...parts.slice(0, 2), ...(parts.length > 2 ? [parts.slice(2).join(' ')] : [])]
  const out: Phrase[] = []
  for (const t of cut) out.push({ text: t, tone: out.length ? CONTRAST[out.at(-1)!.tone][Math.floor(random() * 2)]! : TONE_NAMES[Math.floor(random() * TONE_NAMES.length)]! })
  return out
}

/** Seconds of silence between two phrases, at least and at most. */
const PAUSE = [0.15, 0.25] as const

/** What the worker is asked: the timbre as a mix of voices, the age, and each phrase. */
export interface Render {
  id: number
  timbre: Mix
  /** The age: the line played back at this rate. */
  deepen: number
  phrases: PhraseRender[]
}

/** A phrase as the worker is asked to say it: the prosody as a mix of voices, the pace as heard, the level and the pause before it. */
export interface PhraseRender {
  text: string
  prosody: Mix
  speed: number
  /** Loudness against a plain phrase, dB. */
  db: number
  /** Seconds of silence before it (0 for the first). */
  pause: number
}

export type Rendered = { id: number; mp3: Uint8Array; secs: number } | { id: number; error: string }

export function recipe(phrases: Phrase[], s: Speaker, random: () => number): Omit<Render, 'id'> {
  return {
    timbre: s.own,
    deepen: s.deepen,
    phrases: phrases.map((p, i) => {
      const t = TONES[p.tone]
      const toward = t.toward[s.sex]
      const total = toward.reduce((a, [, x]) => a + x, 0)
      const prosody: Mix = [...s.own.map(([v, w]): [KokoroVoice, number] => [v, w * (1 - t.prosody)]), ...toward.map(([v, w]): [KokoroVoice, number] => [v, (w / total) * t.prosody])]
      return { text: p.text, prosody, speed: s.pace * t.speed, db: t.db, pause: i ? PAUSE[0] + random() * (PAUSE[1] - PAUSE[0]) : 0 }
    }),
  }
}

/** A line as said. */
export interface Speech {
  /** MP3, base64. */
  mp3: string
  /** Each phrase's tone, as said. */
  tones: Tone[]
  /** How long it is heard, from the first sound to the last. */
  secs: number
  /** How long it took to make. */
  ms: number
}

export interface Voice {
  /** The line as the doctor with this key says it, phrase by phrase, led by the voice they chose (null: their own). */
  say(phrases: Phrase[], key: string, chosen: VoiceName | null): Promise<Speech>
  close(): void
}

/** Cores the worker may use: measured on a 6-core i7-8750H, 4 speak a 6 s line in 1.9 s and more are no faster. */
const THREADS = 4

export class Kokoro implements Voice {
  private readonly worker: Worker
  private readonly waiting = new Map<number, { resolve: (r: { mp3: Uint8Array; secs: number; ms: number }) => void; reject: (e: Error) => void; t0: number }>()
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
      else w.resolve({ mp3: m.mp3, secs: m.secs, ms: Math.round(performance.now() - w.t0) })
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

  /** A recipe said as MP3, how long it is heard and how long it took to make (the listening bench asks for its own). */
  render(r: Omit<Render, 'id'>): Promise<{ mp3: Uint8Array; secs: number; ms: number }> {
    if (this.broken) return Promise.reject(this.broken)
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, t0: performance.now() })
      this.worker.postMessage({ id, ...r } satisfies Render)
    })
  }

  async say(phrases: Phrase[], key: string, chosen: VoiceName | null): Promise<Speech> {
    const speaker = speakerOf(key, chosen)
    const said = delivered(phrases, speaker, Math.random)
    const r = await this.render(recipe(said, speaker, Math.random))
    return { mp3: Buffer.from(r.mp3).toString('base64'), tones: said.map((p) => p.tone), secs: r.secs, ms: r.ms }
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
