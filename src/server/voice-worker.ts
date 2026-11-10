/**
 * The voice's own thread (voice.ts starts it): Kokoro-82M on onnxruntime holds its thread for the
 * whole of a line (about 2 s for a long taunt on 4 cores), so it runs here and not beside the
 * physics. Node loads this file itself, without Vite, so it imports packages and types only.
 *
 * A line is read as phonemes by espeak-ng in the accent asked, the punctuation kept between the
 * words as Kokoro wants it. A Kokoro voice is 510 rows of 256 numbers, one row per length of line:
 * the first 128 are the timbre (who is speaking), the last 128 the prosody (pitch, pace and
 * intonation; measured 2026-11-10, Bella's prosody on George's timbre speaks at Bella's pitch). Each
 * half is mixed from the voices asked, the line spoken, aged (played back slower and trembling),
 * levelled like the game's recorded cries (its loudest 200 ms at -16 dBFS, peaks under -1 dBFS,
 * then the tone's own level) and encoded as mono MP3.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import { Mp3Encoder } from '@breezystack/lamejs'
import * as ort from 'onnxruntime-node'
import { phonemize } from 'phonemizer'

import type { Render, Rendered } from './voice'

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

async function phonemes(text: string, accent: Render['accent']): Promise<string> {
  const plain = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
  const parts: string[] = []
  let last = 0
  for (const m of plain.matchAll(PUNCTUATION)) {
    if (m.index > last) parts.push((await phonemize(plain.slice(last, m.index), accent)).join(' '))
    parts.push(m[0])
    last = m.index + m[0].length
  }
  if (last < plain.length) parts.push((await phonemize(plain.slice(last), accent)).join(' '))
  return parts.join('').replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l').trim()
}

function style(r: Render, row: number): Float32Array {
  const out = new Float32Array(256)
  for (const [mix, from] of [
    [r.timbre, 0],
    [r.prosody, 128],
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

/**
 * Older: the line read through at `deepen` of its own rate (lower and fuller, as from a bigger,
 * older man, and longer by as much), the rate wavering by `depth` `hz` times a second so the pitch
 * trembles. Cubic between the samples; never read faster than they were made, so nothing aliases.
 */
function older(x: Float32Array, { deepen, depth, hz }: Render['age']): Float32Array {
  if (!(deepen > 0 && deepen * (1 + depth) <= 1)) throw new Error(`an age that reads the line at ${deepen} trembling by ${depth}`)
  const out = new Float32Array(Math.ceil(x.length / (deepen * (1 - depth))))
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
    at += deepen * (1 + depth * Math.sin((2 * Math.PI * hz * n) / RATE))
  }
  return out.subarray(0, n)
}

function level(x: Float32Array, db: number): void {
  const win = Math.floor(RATE * 0.2)
  let best = 0
  let sum = 0
  let peak = 0
  for (let i = 0; i < x.length; i++) {
    sum += x[i]! * x[i]!
    if (i >= win) sum -= x[i - win]! * x[i - win]!
    best = Math.max(best, sum / Math.min(win, i + 1))
    peak = Math.max(peak, Math.abs(x[i]!))
  }
  const g = Math.min(10 ** ((-16 + db) / 20) / (Math.sqrt(best) || 1e-6), 10 ** (-1 / 20) / (peak || 1e-6))
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

port.on('message', (r: Render) => {
  void (async () => {
    try {
      const ph = await phonemes(r.text, r.accent)
      const ids = [0, ...[...ph].flatMap((c) => (c in vocab ? [vocab[c]!] : [])), 0]
      if (ids.length - 2 >= ROWS) throw new Error(`"${r.text}" is too long to say (${ids.length - 2} sounds, at most ${ROWS - 1})`)
      const out = await session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (i) => BigInt(i)), [1, ids.length]),
        style: new ort.Tensor('float32', style(r, ids.length - 2), [1, 256]),
        // Quicker by as much as the age will slow it.
        speed: new ort.Tensor('float32', [r.speed / r.age.deepen], [1]),
      })
      const wave = older(out.waveform!.data as Float32Array, r.age)
      level(wave, r.db)
      const bytes = mp3(wave)
      port.postMessage({ id: r.id, mp3: bytes, secs: wave.length / RATE } satisfies Rendered)
    } catch (err) {
      port.postMessage({ id: r.id, error: (err as Error).message } satisfies Rendered)
    }
  })()
})
