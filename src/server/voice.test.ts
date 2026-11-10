import { fileURLToPath } from 'node:url'

import { MPEGDecoder } from 'mpg123-decoder'
import { describe, expect, it } from 'vitest'

import { MEN, recipe, speakerOf, voiceFromDisk, WOMEN, type Sex, type Speaker, type Tone } from './voice'

const DIR = fileURLToPath(new URL('../../node_modules/.cache/voice', import.meta.url))
const KEYS = Array.from({ length: 24 }, (_, i) => `browser-key-${i}-a1b2c3`)
const voicesOf = (sex: Sex): readonly string[] => (sex === 'man' ? MEN : WOMEN)

describe('the voice', () => {
  it('gives every key an old English doctor of their own, man or woman, the same every time', () => {
    expect(KEYS.map(speakerOf)).toEqual(KEYS.map(speakerOf))
    expect(new Set(KEYS.map((k) => JSON.stringify(speakerOf(k).own))).size).toBe(KEYS.length)
    expect(new Set(KEYS.map((k) => speakerOf(k).sex))).toEqual(new Set(['man', 'woman']))
    expect(new Set(KEYS.map((k) => speakerOf(k).own[0]![0])).size).toBeGreaterThan(5)
    for (const k of KEYS) {
      const s = speakerOf(k)
      expect(s.own[0]![0]).toMatch(/^b[mf]_/)
      for (const [v] of s.own) {
        expect(voicesOf(s.sex)).toContain(v)
        expect(v).not.toBe('af_nicole')
      }
      // Slower and deeper than Kokoro speaks, and never read faster than it was made.
      expect(s.pace).toBeLessThan(1)
      expect(s.age.deepen * (1 + s.age.depth)).toBeLessThan(1)
    }
  })

  it('a tone moves only the prosody, toward voices of the doctor’s own sex (but Nicole’s hush), and widens the melody', () => {
    const man = speakerOf(KEYS.find((k) => speakerOf(k).sex === 'man')!)
    const woman = speakerOf(KEYS.find((k) => speakerOf(k).sex === 'woman')!)
    const weigh = (mix: [string, number][], ...names: string[]) => mix.filter(([v]) => names.includes(v)).reduce((a, [, w]) => a + w, 0)
    expect(recipe('Sirrah!', man, 'plain').prosody).toEqual(man.own)
    // What a tone pulls toward: 0.6 of the prosody, besides what the doctor's own mix already had of those voices.
    const pulled = (s: Speaker, tone: Tone, ...names: string[]) => weigh(recipe('Sirrah!', s, tone).prosody, ...names) - 0.4 * weigh(s.own, ...names)
    expect(pulled(man, 'booming', 'bm_lewis', 'am_onyx')).toBeCloseTo(0.6)
    expect(pulled(woman, 'booming', 'af_alloy', 'af_kore')).toBeCloseTo(0.6)
    expect(pulled(woman, 'hushed', 'af_nicole')).toBeCloseTo(0.6)
    expect(recipe('Sirrah!', man, 'booming').speed).toBeLessThan(recipe('Sirrah!', man, 'plain').speed)
    for (const s of [man, woman]) {
      for (const tone of ['plain', 'booming', 'indignant', 'gloating', 'hushed', 'sniffy'] satisfies Tone[]) {
        const r = recipe('Sirrah!', s, tone)
        expect(r.timbre).toEqual(s.own)
        expect(r.age).toEqual(s.age)
        expect(r.swing).toBeGreaterThan(1)
        for (const [v] of r.prosody) if (v !== 'af_nicole') expect(voicesOf(s.sex)).toContain(v)
        expect(r.prosody.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1)
      }
    }
  })

  it('says a line as MP3 in a worker while the game keeps its thread (needs what npm install fetched)', async () => {
    const voice = voiceFromDisk(DIR, () => {})
    expect(voice, `Kokoro is not in ${DIR}: run npm run voice`).not.toBeNull()
    let worst = 0
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 5)
    const speech = await voice!.say('Your Latin, sir, is an embarrassment to the entire guild!', 'browser-key-test')
    clearInterval(tick)
    // The model holds its own thread for seconds; this one never waited long.
    expect(worst).toBeLessThan(250)
    const bytes = Buffer.from(speech.mp3, 'base64')
    const decoder = new MPEGDecoder()
    await decoder.ready
    const pcm = decoder.decode(new Uint8Array(bytes))
    decoder.free()
    expect(pcm.sampleRate).toBe(24000)
    const secs = pcm.samplesDecoded / pcm.sampleRate
    expect(secs).toBeGreaterThan(1.5)
    expect(secs).toBeLessThan(10)
    expect(Math.abs(secs - speech.secs)).toBeLessThan(0.2)
    const x = pcm.channelData[0]!
    let sum = 0
    let peak = 0
    for (const v of x) {
      sum += v * v
      peak = Math.max(peak, Math.abs(v))
    }
    // Levelled: speech, not silence, its peaks under -1 dBFS (MP3 may overshoot a little).
    expect(Math.sqrt(sum / x.length)).toBeGreaterThan(0.03)
    expect(peak).toBeLessThan(1)
    // Closed, what is still waiting fails at once.
    const pending = voice!.say('Never to be heard.', 'browser-key-test')
    voice!.close()
    await expect(pending).rejects.toThrow(/closed/)
  }, 60_000)
})
