/**
 * The voice's own thread (voice.ts starts it): Kokoro-82M on onnxruntime holds its thread for the
 * whole of a line (about 2 s for a long taunt on 4 cores), so it runs here and not beside the
 * physics. Node loads this file itself, without Vite, so it imports packages and types only.
 *
 * A line is read as English phonemes by espeak-ng, the punctuation kept between the words as
 * Kokoro wants it. A Kokoro voice is 510 rows of 256 numbers, one row per length of line:
 * the first 128 are the timbre (who is speaking), the last 128 the prosody (pitch, pace and
 * intonation; measured 2026-11-10, Bella's prosody on George's timbre speaks at Bella's pitch). Each
 * half is mixed from the voices asked, the line spoken, its melody widened, aged (played back
 * slower and trembling),
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

// ------------------------------------------------------------------------------ the melody

/** Pitch frames: every 10 ms, 40 ms long, on a half-rate copy, between 55 and 500 Hz. */
const HOP = 240
const WINDOW = 480
const LAGS = [Math.floor(RATE / 2 / 500), Math.ceil(RATE / 2 / 55)] as const

/** The pitch of each frame (Hz, 0 where it is not voiced); frame f is centred on sample f * HOP + WINDOW. */
function pitch(x: Float32Array): Float32Array {
  const half = new Float32Array(x.length >> 1)
  for (let i = 0; i < half.length; i++) half[i] = (x[2 * i]! + x[2 * i + 1]!) / 2
  const [minLag, maxLag] = LAGS
  const frames = Math.max(0, Math.floor((half.length - WINDOW - maxLag - 2) / (HOP / 2)))
  const rms = new Float32Array(frames)
  let loud = 0
  for (let f = 0; f < frames; f++) {
    let e = 0
    for (let i = 0; i < WINDOW; i++) e += half[(f * HOP) / 2 + i]! ** 2
    rms[f] = Math.sqrt(e / WINDOW)
    loud = Math.max(loud, rms[f]!)
  }
  const f0 = new Float32Array(frames)
  const r = new Float32Array(maxLag + 2)
  for (let f = 0; f < frames; f++) {
    if (rms[f]! < loud * 0.05) continue
    const s = (f * HOP) / 2
    let best = 0
    for (let l = minLag; l <= maxLag + 1; l++) {
      let c = 0
      let a = 0
      let b = 0
      for (let i = 0; i < WINDOW; i++) {
        const p = half[s + i]!
        const q = half[s + i + l]!
        c += p * q
        a += p * p
        b += q * q
      }
      r[l] = c / Math.sqrt(a * b + 1e-12)
      if (l <= maxLag) best = Math.max(best, r[l]!)
    }
    if (best < 0.6) continue
    // The shortest lag nearly as alike as the best is one period (the best may be two).
    let lag = 0
    for (let l = minLag + 1; l <= maxLag && !lag; l++) if (r[l]! >= 0.85 * best && r[l]! >= r[l - 1]! && r[l]! >= r[l + 1]!) lag = l
    if (!lag) continue
    const bend = r[lag - 1]! - 2 * r[lag]! + r[lag + 1]!
    f0[f] = RATE / 2 / (lag + (bend < 0 ? (r[lag - 1]! - r[lag + 1]!) / (2 * bend) : 0))
  }
  return f0
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!

/**
 * How far from the middle note the melody may go, as ratios: 9 semitones up and 8 down. Without
 * it a gloating man's highs reached 330 Hz, a squeak.
 */
const NOTES = [2 ** (-8 / 12), 2 ** (9 / 12)] as const

/**
 * The melody widened: each voiced moment's pitch moved away from the line's middle note `swing`
 * times as far on a log scale, within NOTES and at most 0.6 to 1.7 times its own, its length and
 * its voice kept.
 * TD-PSOLA: the line is cut into grains of two periods centred on each period's peak (every 10 ms
 * where it is not voiced) and laid down again at the same times, closer together for a higher
 * note and further apart for a lower one. At a swing of 1 the line comes back as it was, but for
 * any note beyond NOTES.
 */
function widen(x: Float32Array, swing: number): Float32Array {
  const f0 = pitch(x)
  const frames = f0.length
  const voiced = [...f0].filter((f) => f > 0)
  if (voiced.length < 3) return x
  const middle = median(voiced)
  // An octave out is the tracking's mistake, not a note.
  for (let f = 0; f < frames; f++) {
    if (!f0[f]) continue
    while (f0[f]! > 1.9 * middle) f0[f]! /= 2
    while (f0[f]! < 0.5 * middle) f0[f]! *= 2
  }
  // Each over five frames by its median; a frame without two voiced neighbours there is not voiced.
  const smooth = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    if (!f0[f]) continue
    const near: number[] = []
    for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) if (f0[k]) near.push(f0[k]!)
    if (near.length >= 3) smooth[f] = median(near)
  }
  const frameAt = (t: number) => Math.min(frames - 1, Math.max(0, Math.round((t - WINDOW) / HOP)))
  // Peaks one period apart where it is voiced, every HOP where it is not.
  const marks = [0]
  const periodic = [false]
  for (let c = 0; ; ) {
    const hz = smooth[frameAt(c)]!
    let m = c + HOP
    if (hz > 0) {
      const period = RATE / hz
      const after = periodic.at(-1)!
      const lo = after ? Math.round(c + 0.75 * period) : c + 1
      const hi = Math.round(c + (after ? 1.25 : 1) * period)
      if (hi >= x.length) break
      m = lo
      for (let i = lo; i <= hi; i++) if (x[i]! > x[m]!) m = i
    }
    if (m >= x.length) break
    marks.push(m)
    periodic.push(hz > 0)
    c = m
  }
  const y = new Float32Array(x.length)
  let j = 0
  for (let t = 0; t < x.length; ) {
    while (j + 1 < marks.length && Math.abs(marks[j + 1]! - t) <= Math.abs(marks[j]! - t)) j++
    const m = marks[j]!
    const right = j + 1 < marks.length ? marks[j + 1]! - m : HOP
    const left = j > 0 ? m - marks[j - 1]! : right
    const hz = smooth[frameAt(m)]!
    // How much higher this note is to be; the grains are as many more, each as much quieter.
    const note = Math.min(NOTES[1], Math.max(NOTES[0], (hz / middle) ** swing))
    const up = periodic[j] && hz > 0 ? Math.min(1.7, Math.max(0.6, (note * middle) / hz)) : 1
    const at = Math.round(t)
    for (let i = Math.max(-left, -m, -at); i < right && m + i < x.length && at + i < y.length; i++) {
      const w = i < 0 ? 0.5 - 0.5 * Math.cos((Math.PI * (i + left)) / left) : 0.5 + 0.5 * Math.cos((Math.PI * i) / right)
      y[at + i]! += (x[m + i]! * w) / up
    }
    t += right / up
  }
  return y
}

// ------------------------------------------------------------------------------ the age

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
      const ph = await phonemes(r.text)
      const ids = [0, ...[...ph].flatMap((c) => (c in vocab ? [vocab[c]!] : [])), 0]
      if (ids.length - 2 >= ROWS) throw new Error(`"${r.text}" is too long to say (${ids.length - 2} sounds, at most ${ROWS - 1})`)
      const out = await session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (i) => BigInt(i)), [1, ids.length]),
        style: new ort.Tensor('float32', style(r, ids.length - 2), [1, 256]),
        // Quicker by as much as the age will slow it.
        speed: new ort.Tensor('float32', [r.speed / r.age.deepen], [1]),
      })
      const wave = older(widen(out.waveform!.data as Float32Array, r.swing), r.age)
      level(wave, r.db)
      const bytes = mp3(wave)
      port.postMessage({ id: r.id, mp3: bytes, secs: wave.length / RATE } satisfies Rendered)
    } catch (err) {
      port.postMessage({ id: r.id, error: (err as Error).message } satisfies Rendered)
    }
  })()
})
