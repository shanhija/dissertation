/**
 * The voice's own thread (voice.ts starts it): Kokoro-82M on onnxruntime holds its thread for the
 * whole of a line (about 2 s for a long taunt on 4 cores), so it runs here and not beside the
 * physics. Node loads this file itself, without Vite, so it imports packages and types only.
 *
 * Each phrase of a line is read as English phonemes by espeak-ng, the punctuation kept between
 * the words as Kokoro wants it. A Kokoro voice is 510 rows of 256 numbers, one row per length of
 * line: the first 128 are the timbre (who is speaking), the last 128 the prosody (pitch, pace and
 * intonation; measured 2026-11-10, Bella's prosody on George's timbre speaks at Bella's pitch).
 * Each half is mixed from the voices asked and each phrase spoken on its own, in its own tone, with
 * Kokoro's own melody, its silence around it cut away, levelled like the game's recorded cries
 * (its loudest 200 ms at -16 dBFS, then the tone's own level). The phrases are joined by their
 * pauses, and the line is aged (played back steadily slower), kept under -1 dBFS and encoded as
 * mono MP3.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import { Mp3Encoder } from '@breezystack/lamejs'
import * as ort from 'onnxruntime-node'
import { phonemize } from 'phonemizer'

import type { Mix, PhraseRender, Render, Rendered } from './voice'

const RATE = 24000
const ROWS = 510
const { dir, threads } = workerData as { dir: string; threads: number }
if (!parentPort) throw new Error('voice-worker.ts runs as a worker thread')
const port = parentPort

const vocab = (JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')) as { model: { vocab: Record<string, number> } }).model.vocab
const session = await ort.InferenceSession.create(path.join(dir, 'onnx', 'model.onnx'), { intraOpNumThreads: threads, interOpNumThreads: 1 })

const voices = new Map<string, Float32Array>()
function voice(name: string): Float32Array {
  let v = voices.get(name)
  if (!v) {
    const b = fs.readFileSync(path.join(dir, 'voices', `${name}.bin`))
    if (b.byteLength !== ROWS * 256 * 4) throw new Error(`voices/${name}.bin is ${b.byteLength} bytes, not ${ROWS * 256 * 4}`)
    v = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    voices.set(name, v)
  }
  return v
}

/** Kokoro's punctuation, kept as it is between the phonemized runs of words. */
const PUNCTUATION = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g

async function phonemes(text: string): Promise<string> {
  const plain = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
  const parts: string[] = []
  let last = 0
  for (const m of plain.matchAll(PUNCTUATION)) {
    if (m.index > last) parts.push((await phonemize(plain.slice(last, m.index), 'en')).join(' '))
    parts.push(m[0])
    last = m.index + m[0].length
  }
  if (last < plain.length) parts.push((await phonemize(plain.slice(last), 'en')).join(' '))
  return parts.join('').replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l').trim()
}

function style(timbre: Mix, prosody: Mix, row: number): Float32Array {
  const out = new Float32Array(256)
  for (const [mix, from] of [
    [timbre, 0],
    [prosody, 128],
  ] as const) {
    const total = mix.reduce((s, [, w]) => s + w, 0)
    if (!(total > 0)) throw new Error(`a mix of voices weighing ${total}`)
    for (const [name, w] of mix) {
      const v = voice(name)
      for (let i = from; i < from + 128; i++) out[i]! += (v[row * 256 + i]! * w) / total
    }
  }
  return out
}

// ------------------------------------------------------------------------------ the phrases

/** Seconds of Kokoro's silence kept before a phrase and after it, and after the line's last. */
const EDGE = 0.03
const END = 0.15

/**
 * The phrase without Kokoro's silence around it (about 0.24 s before and 0.58 s after): from
 * `lead` seconds before its first 10 ms within 45 dB of its loudest to `trail` after its last,
 * faded in and out over 10 ms where it was cut.
 */
function trim(x: Float32Array, lead: number, trail: number): Float32Array {
  const w = RATE / 100
  const db: number[] = []
  for (let i = 0; i + w <= x.length; i += w) {
    let e = 0
    for (let k = 0; k < w; k++) e += x[i + k]! ** 2
    db.push(10 * Math.log10(e / w + 1e-12))
  }
  const loud = Math.max(...db)
  const first = db.findIndex((d) => d > loud - 45)
  let last = db.length - 1
  while (db[last]! <= loud - 45) last--
  const y = x.slice(Math.max(0, first * w - Math.round(lead * RATE)), Math.min(x.length, (last + 1) * w + Math.round(trail * RATE)))
  for (let i = 0; i < w && i < y.length; i++) {
    y[i]! *= i / w
    y[y.length - 1 - i]! *= i / w
  }
  return y
}

/** Its loudest 200 ms at -16 dBFS, then `db` more. */
function level(x: Float32Array, db: number): void {
  const win = Math.floor(RATE * 0.2)
  let best = 0
  let sum = 0
  for (let i = 0; i < x.length; i++) {
    sum += x[i]! * x[i]!
    if (i >= win) sum -= x[i - win]! * x[i - win]!
    best = Math.max(best, sum / Math.min(win, i + 1))
  }
  const g = 10 ** ((-16 + db) / 20) / (Math.sqrt(best) || 1e-6)
  for (let i = 0; i < x.length; i++) x[i]! *= g
}

/** The phrases one after the other, each `pause` seconds of silence after the last one's sound. */
function join(parts: Float32Array[], phrases: PhraseRender[]): Float32Array {
  const gaps = phrases.map((p, i) => (i ? Math.max(0, Math.round((p.pause - 2 * EDGE) * RATE)) : 0))
  const y = new Float32Array(parts.reduce((n, x, i) => n + x.length + gaps[i]!, 0))
  let at = 0
  parts.forEach((x, i) => {
    at += gaps[i]!
    y.set(x, at)
    at += x.length
  })
  return y
}

// ------------------------------------------------------------------------------ the age

/**
 * Older: the line read through at `deepen` of its own rate, steadily (lower and fuller, as from a
 * bigger, older speaker, and longer by as much). Cubic between the samples; never read faster than
 * they were made, so nothing aliases.
 */
function older(x: Float32Array, deepen: number): Float32Array {
  if (!(deepen > 0 && deepen <= 1)) throw new Error(`an age that reads the line at ${deepen}`)
  const out = new Float32Array(Math.ceil(x.length / deepen))
  let at = 1
  let n = 0
  for (; at < x.length - 2; n++) {
    const i = Math.floor(at)
    const f = at - i
    const a = x[i - 1]!
    const b = x[i]!
    const c = x[i + 1]!
    const d = x[i + 2]!
    out[n] = b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)))
    at += deepen
  }
  return out.subarray(0, n)
}

/** Peaks kept under -1 dBFS. */
function cap(x: Float32Array): void {
  let peak = 0
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!))
  const g = Math.min(1, 10 ** (-1 / 20) / (peak || 1e-6))
  for (let i = 0; i < x.length; i++) x[i]! *= g
}

function mp3(x: Float32Array): Uint8Array {
  const enc = new Mp3Encoder(1, RATE, 64)
  const pcm = new Int16Array(x.length)
  for (let i = 0; i < x.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767)))
  const parts: Uint8Array[] = []
  for (let i = 0; i < pcm.length; i += 1152) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + 1152))
    if (b.length) parts.push(new Uint8Array(b))
  }
  const end = enc.flush()
  if (end.length) parts.push(new Uint8Array(end))
  return Buffer.concat(parts)
}

/** A phrase as Kokoro says it, quicker by as much as the age will slow it. */
async function spoken(p: PhraseRender, r: Render): Promise<Float32Array> {
  const ph = await phonemes(p.text)
  const ids = [0, ...[...ph].flatMap((c) => (c in vocab ? [vocab[c]!] : [])), 0]
  if (ids.length - 2 >= ROWS) throw new Error(`"${p.text}" is too long to say (${ids.length - 2} sounds, at most ${ROWS - 1})`)
  const out = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (i) => BigInt(i)), [1, ids.length]),
    style: new ort.Tensor('float32', style(r.timbre, p.prosody, ids.length - 2), [1, 256]),
    speed: new ort.Tensor('float32', [p.speed / r.deepen], [1]),
  })
  return out.waveform!.data as Float32Array
}

/**
 * One line at a time, in the order asked. Each phrase waits for its own Kokoro call, so lines
 * started together took turns phrase by phrase and the first asked came back late (measured
 * 2026-11-11, three two-phrase lines asked at once, 7 runs each: the first back after 38 to 63% of
 * the time all three took, median 57%; one at a time, 25 to 40%, median 29%).
 */
let queue = Promise.resolve()

port.on('message', (r: Render) => {
  queue = queue.then(async () => {
    try {
      const parts: Float32Array[] = []
      for (const [i, p] of r.phrases.entries()) {
        const y = trim(await spoken(p, r), EDGE, i === r.phrases.length - 1 ? END : EDGE)
        level(y, p.db)
        parts.push(y)
      }
      const wave = older(join(parts, r.phrases), r.deepen)
      cap(wave)
      const bytes = mp3(wave)
      port.postMessage({ id: r.id, mp3: bytes, secs: wave.length / RATE } satisfies Rendered)
    } catch (err) {
      port.postMessage({ id: r.id, error: (err as Error).message } satisfies Rendered)
    }
  })
})
