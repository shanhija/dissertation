import { fileURLToPath } from 'node:url'

import { MPEGDecoder } from 'mpg123-decoder'
import { describe, expect, it } from 'vitest'

import { delivered, MEN, phrased, recipe, speakerOf, TONE_NAMES, voiceFromDisk, WOMEN, type Sex, type Speaker, type Tone } from './voice'

const DIR = fileURLToPath(new URL('../../node_modules/.cache/voice', import.meta.url))
const KEYS = Array.from({ length: 24 }, (_, i) => `browser-key-${i}-a1b2c3`)
const voicesOf = (sex: Sex): readonly string[] => (sex === 'man' ? MEN : WOMEN)
/** One phrase said in a tone, as the worker is asked it. */
const said = (s: Speaker, tone: Tone) => recipe([{ text: 'Sirrah!', tone }], s, () => 0.5).phrases[0]!

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
    expect(said(man, 'plain').prosody).toEqual(man.own)
    // What a tone pulls toward: 0.6 of the prosody, besides what the doctor's own mix already had of those voices.
    const pulled = (s: Speaker, tone: Tone, ...names: string[]) => weigh(said(s, tone).prosody, ...names) - 0.4 * weigh(s.own, ...names)
    expect(pulled(man, 'booming', 'bm_lewis', 'am_onyx')).toBeCloseTo(0.6)
    expect(pulled(woman, 'booming', 'af_alloy', 'af_kore')).toBeCloseTo(0.6)
    expect(pulled(woman, 'hushed', 'af_nicole')).toBeCloseTo(0.6)
    expect(said(man, 'booming').speed).toBeLessThan(said(man, 'plain').speed)
    for (const s of [man, woman]) {
      for (const tone of TONE_NAMES) {
        const r = recipe([{ text: 'Sirrah!', tone }], s, () => 0.5)
        expect(r.timbre).toEqual(s.own)
        expect(r.age).toEqual(s.age)
        const p = r.phrases[0]!
        expect(p.swing).toBeGreaterThan(1)
        expect(p.pause).toBe(0)
        for (const [v] of p.prosody) if (v !== 'af_nicole') expect(voicesOf(s.sex)).toContain(v)
        expect(p.prosody.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1)
      }
    }
  })

  it('says a line phrase by phrase, each in its tone, with a pause between them, and the temper shows in the first two times in five', () => {
    const s = speakerOf(KEYS[0]!)
    const r = recipe(
      [
        { text: 'Sirrah!', tone: 'indignant' },
        { text: 'Your footnotes wobble.', tone: 'booming' },
      ],
      s,
      () => 0.5,
    )
    expect(r.phrases.map((p) => p.text)).toEqual(['Sirrah!', 'Your footnotes wobble.'])
    expect(r.phrases[1]!.speed).toBeLessThan(r.phrases[0]!.speed)
    expect(r.phrases[1]!.db).toBeGreaterThan(r.phrases[0]!.db)
    expect(r.phrases[1]!.pause).toBeCloseTo(0.2)
    const other = TONE_NAMES.find((t) => t !== s.temper && t !== 'plain')!
    const line = [
      { text: 'Sirrah!', tone: 'plain' },
      { text: 'Begone.', tone: other },
    ] satisfies { text: string; tone: Tone }[]
    expect(delivered(line, s, () => 0.1)).toEqual([{ text: 'Sirrah!', tone: s.temper }, line[1]])
    expect(delivered(line, s, () => 0.9)).toEqual(line)
    // Not when the phrase after it is already in the temper: the tone would not change.
    const tempered = [line[0], { text: 'Begone.', tone: s.temper }]
    expect(delivered(tempered, s, () => 0.1)).toEqual(tempered)
    expect(delivered([line[0]], s, () => 0.1)).toEqual([{ text: 'Sirrah!', tone: s.temper }])
  })

  it('cuts a line written without tones into at most three phrases, each answering the tone before', () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const p = phrased('Sir or madam, your hypothesis wears borrowed trousers!', () => r)
      expect(p.map((x) => x.text)).toEqual(['Sir or madam,', 'your hypothesis wears borrowed trousers!'])
      expect(p[1]!.tone).not.toBe(p[0]!.tone)
    }
    expect(phrased('Even the library mice have dismissed your thesis.', Math.random).map((x) => x.text)).toEqual(['Even the library mice have dismissed your thesis.'])
    expect(phrased('One, two; three: four! Five?', Math.random).map((x) => x.text)).toEqual(['One,', 'two;', 'three: four! Five?'])
  })

  it('says a two-phrase line as MP3 in a worker while the game keeps its thread, its silence cut away and a pause between the phrases (needs what npm install fetched)', async () => {
    const voice = voiceFromDisk(DIR, () => {})
    expect(voice, `Kokoro is not in ${DIR}: run npm run voice`).not.toBeNull()
    let worst = 0
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 5)
    const speech = await voice!.say(
      [
        { text: 'Your Latin is dreadful!', tone: 'indignant' },
        { text: 'An embarrassment to the guild.', tone: 'booming' },
      ],
      'browser-key-test',
    )
    clearInterval(tick)
    // The model holds its own thread for seconds; this one never waited long.
    expect(worst).toBeLessThan(250)
    expect(speech.tones).toHaveLength(2)
    expect(speech.tones[1]).toBe('booming')
    const bytes = Buffer.from(speech.mp3, 'base64')
    const decoder = new MPEGDecoder()
    await decoder.ready
    const pcm = decoder.decode(new Uint8Array(bytes))
    decoder.free()
    expect(pcm.sampleRate).toBe(24000)
    const secs = pcm.samplesDecoded / pcm.sampleRate
    expect(secs).toBeGreaterThan(1.5)
    expect(secs).toBeLessThan(6)
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
    // 10 ms frames within 35 dB of the loudest: little silence before the first or after the last
    // (Kokoro leaves about 0.24 s and 0.58 s), and a pause of at least 150 ms between the phrases
    // (neither has a comma inside, where Kokoro would pause on its own: joined without a pause, the
    // longest quiet was 0.10 to 0.11 s, and 0.2 to 0.3 s with it).
    const db: number[] = []
    for (let i = 0; i + 240 <= x.length; i += 240) db.push(10 * Math.log10(x.subarray(i, i + 240).reduce((a, v) => a + v * v, 0) / 240 + 1e-12))
    const loud = Math.max(...db)
    const sound = db.map((d) => d > loud - 35)
    const first = sound.indexOf(true)
    const end = sound.lastIndexOf(true)
    expect(first / 100).toBeLessThan(0.1)
    expect((db.length - 1 - end) / 100).toBeLessThan(0.3)
    let longest = 0
    for (let f = first, run = 0; f <= end; f++) longest = Math.max(longest, (run = sound[f] ? 0 : run + 1))
    expect(longest / 100).toBeGreaterThanOrEqual(0.15)
    // Closed, what is still waiting fails at once.
    const pending = voice!.say([{ text: 'Never to be heard.', tone: 'plain' }], 'browser-key-test')
    voice!.close()
    await expect(pending).rejects.toThrow(/closed/)
  }, 60_000)
})
