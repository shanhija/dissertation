/**
 * What the page plays: recordings of the named sounds placed in the arena (audio.ts), the game's
 * own sounds from what physically happens (footsteps by the floor's material and the gait,
 * landings, things striking wood, stone, metal, glass, water or flesh, a body hitting the ground,
 * a cry when hurt), and a few cues of the page's own drawn with oscillators and noise (which also
 * stand in for a recording until it has loaded). Taunts come from the server already said, each
 * doctor in a voice of their own, placed where the doctor is and only heard within HEARING metres.
 */

import { audio, earAt, playRecorded, recorded, route, type Placed } from './audio'
import { options } from './options'
import { HEARING, type MaterialName, type SoundName, type Vec3 } from './protocol'

export { wakeAudio } from './audio'

let noise: AudioBuffer | null = null
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (!noise) {
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return noise
}

function tone(into: AudioNode, type: OscillatorType, from: number, to: number, secs: number, gain: number, delay = 0): void {
  const c = into.context as AudioContext
  const t = c.currentTime + delay
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(from, t)
  o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + secs)
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + secs)
  o.connect(g).connect(into)
  o.start(t)
  o.stop(t + secs + 0.02)
}

function hiss(into: AudioNode, secs: number, gain: number, freq: number, toFreq: number, delay = 0): void {
  const c = into.context as AudioContext
  const t = c.currentTime + delay
  const s = c.createBufferSource()
  s.buffer = noiseBuffer(c)
  const f = c.createBiquadFilter()
  f.type = 'bandpass'
  f.frequency.setValueAtTime(freq, t)
  f.frequency.exponentialRampToValueAtTime(Math.max(30, toFreq), t + secs)
  f.Q.value = 1.2
  const g = c.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + secs)
  s.connect(f).connect(g).connect(into)
  s.start(t, Math.random() * 0.5)
  s.stop(t + secs + 0.02)
}

type Recipe = (into: AudioNode, p: number) => void

/** Sounds drawn by the page: its own cues, the two sounds with no recording, and stand-ins while a recording loads. */
const RECIPES: Partial<Record<string, Recipe>> = {
  bang: (o, p) => {
    hiss(o, 0.5, 0.9, 900 * p, 80)
    tone(o, 'sine', 120 * p, 40, 0.4, 0.6)
  },
  boom: (o, p) => {
    hiss(o, 0.09, 0.6, 3200 * p, 900 * p)
    hiss(o, 1.4, 1.0, 260 * p, 35)
    tone(o, 'sine', 75 * p, 26, 1.1, 0.8)
  },
  zap: (o, p) => tone(o, 'square', 1400 * p, 200 * p, 0.15, 0.12),
  crackle: (o, p) => {
    // Sparks snapping at random over a mains buzz.
    tone(o, 'sawtooth', 110 * p, 104 * p, 0.45, 0.06)
    for (let i = 0; i < 10; i++) hiss(o, 0.015 + Math.random() * 0.03, 0.25 + Math.random() * 0.25, 4200 * p, 2400 * p, Math.random() * 0.4)
  },
  whoosh: (o, p) => hiss(o, 0.25, 0.35, 400 * p, 2200 * p),
  boing: (o, p) => {
    tone(o, 'sine', 180 * p, 520 * p, 0.12, 0.3)
    tone(o, 'sine', 520 * p, 260 * p, 0.25, 0.25, 0.12)
  },
  squeak: (o, p) => tone(o, 'sine', 1200 * p, 2400 * p, 0.09, 0.15),
  thud: (o, p) => {
    tone(o, 'sine', 140 * p, 45 * p, 0.22, 0.6)
    hiss(o, 0.08, 0.25, 300, 120)
  },
  ring: (o, p) => {
    tone(o, 'sine', 880 * p, 870 * p, 0.9, 0.12)
    tone(o, 'sine', 1320 * p, 1300 * p, 0.6, 0.06)
  },
  splat: (o, p) => hiss(o, 0.3, 0.6, 700 * p, 120),
  crunch: (o, p) => {
    for (let i = 0; i < 4; i++) hiss(o, 0.05, 0.4, 1500 * p, 600 * p, i * 0.04)
  },
  hum: (o, p) => tone(o, 'sawtooth', 90 * p, 85 * p, 0.6, 0.08),
  hurt: (o, p) => tone(o, 'triangle', 330 * p, 160 * p, 0.18, 0.25),
  out: (o, p) => {
    tone(o, 'sawtooth', 440 * p, 110 * p, 0.8, 0.12)
    tone(o, 'sine', 220 * p, 55 * p, 0.9, 0.2)
  },
  ui: (o, p) => tone(o, 'sine', 660 * p, 880 * p, 0.06, 0.08),
  crate: (o, p) => {
    tone(o, 'sine', 523 * p, 523 * p, 0.15, 0.12)
    tone(o, 'sine', 784 * p, 784 * p, 0.3, 0.12, 0.12)
  },
  start: (o, p) => {
    for (const [i, f] of [392, 523, 659].entries()) tone(o, 'triangle', f * p, f * p, 0.3, 0.15, i * 0.12)
  },
  win: (o, p) => {
    for (const [i, f] of [523, 659, 784, 1047].entries()) tone(o, 'triangle', f * p, f * p, 0.5, 0.15, i * 0.14)
  },
  // A low rumble under an explosion, felt more than heard, carrying far.
  rumble: (o, p) => {
    tone(o, 'sine', 58 * p, 26, 1.8, 0.9)
    hiss(o, 2.2, 0.5, 140 * p, 40)
  },
}

/** What the page plays by name: a sound made things play, a sound of the game's own, or a cue. */
export type Cue = SoundName | 'hurt' | 'out' | 'ui' | 'crate' | 'start' | 'win' | (string & {})

/** Plays a sound where it is (null: in the ear), at a pitch and a loudness. */
export function play(cue: Cue, pitch = 1, at: Vec3 | null = null, volume = 1): void {
  if (!audio()) return
  const p: Placed = { at, pitch, volume }
  // An explosion: far off, the muffled recording; near or far, the rumble under it.
  if (cue === 'boom' || cue === 'cannon' || cue === 'thunder') {
    const ear = earAt()
    const far = at && Math.hypot(at[0] - ear[0], at[1] - ear[1], at[2] - ear[2]) > 35
    if (!(far && cue === 'boom' && playRecorded('boom-far', p))) if (!playRecorded(cue, p)) drawn(cue, p)
    drawn('rumble', { ...p, volume: volume * (cue === 'cannon' ? 0.6 : 1) })
    return
  }
  if (recorded(cue) && playRecorded(cue, p)) return
  drawn(cue, p)
}

function drawn(cue: string, p: Placed): void {
  const recipe = RECIPES[cue]
  if (!recipe) return
  const r = route(p)
  if (r) recipe(r.into, p.pitch)
}

// ------------------------------------------------------------------------------ the game's own

const STEP: Record<MaterialName, string> = {
  plain: 'step-stone', plaster: 'step-stone', planks: 'step-wood', wood: 'step-wood', stone: 'step-stone', brick: 'step-stone', marble: 'step-stone', tiles: 'step-stone',
  carpet: 'step-soft', fabric: 'step-soft', paper: 'step-soft', books: 'step-wood', chalkboard: 'step-wood', metal: 'step-metal', brass: 'step-metal', glass: 'step-stone',
  concrete: 'step-stone', rock: 'step-stone', earth: 'step-dirt', grass: 'step-dirt', water: 'step-water', lava: 'step-stone',
}

const STRIKE: Record<MaterialName | 'flesh' | 'object', string> = {
  plain: 'hit-stone', plaster: 'hit-stone', planks: 'hit-wood', wood: 'hit-wood', stone: 'hit-stone', brick: 'hit-stone', marble: 'hit-stone', tiles: 'hit-stone',
  carpet: 'hit-soft', fabric: 'hit-soft', paper: 'hit-soft', books: 'hit-soft', chalkboard: 'hit-wood', metal: 'hit-metal', brass: 'hit-metal', glass: 'hit-glass',
  concrete: 'hit-stone', rock: 'hit-stone', earth: 'hit-soft', grass: 'hit-soft', water: 'splash', lava: 'hit-stone', flesh: 'hit-flesh', object: 'hit-soft',
}

/** A footstep on a floor, `weight` 0..1.5 (a limp's lame foot is light, a pompous one heavy). */
export function footstep(at: Vec3, floor: MaterialName | null, weight: number): void {
  play(STEP[floor ?? 'plain'], 0.9 + Math.random() * 0.2, at, 0.55 * weight)
}

/** Landing from a jump or a fall: the floor and the body on it. */
export function landing(at: Vec3, floor: MaterialName | null, hard: number): void {
  play(STEP[floor ?? 'plain'], 0.8, at, 0.8 * hard)
  play('land', 0.9, at, 0.6 * hard)
  play('cloth', 1, at, 0.4 * hard)
}

/** Something striking something: what it struck, how fast, how heavy. */
export function impact(at: Vec3, on: MaterialName | 'flesh' | 'object', speed: number, mass: number): void {
  const loud = Math.min(1.2, speed / 10) * (0.45 + 0.55 * Math.min(1, mass / 15))
  // Heavier things sound lower.
  const pitch = Math.max(0.6, Math.min(1.4, 1.25 - Math.log10(1 + mass) * 0.25))
  play(STRIKE[on], pitch, at, loud)
  if (mass > 30 && speed > 6) play('thud', pitch * 0.85, at, loud * 0.8)
}

const BREAK: Record<MaterialName, SoundName> = {
  plain: 'smash', plaster: 'smash', planks: 'smash', wood: 'smash', stone: 'stones', brick: 'stones', marble: 'stones', tiles: 'shatter',
  carpet: 'rustle', fabric: 'rustle', paper: 'book', books: 'book', chalkboard: 'smash', metal: 'clang', brass: 'clang', glass: 'shatter',
  concrete: 'stones', rock: 'stones', earth: 'stones', grass: 'rustle', water: 'splash', lava: 'stones',
}

/** A piece of the arena breaking: by what it was made of, lower and louder the bigger it was (size its reach, metres). */
export function shatter(at: Vec3, material: MaterialName, size: number): void {
  const loud = Math.min(1.3, 0.7 + size * 0.2)
  const pitch = Math.max(0.6, Math.min(1.2, 1.15 - size * 0.12))
  play(BREAK[material], pitch, at, loud)
  play('crunch', pitch * 0.8, at, loud * 0.6)
  if (size > 1.5) play('thud', pitch * 0.7, at, loud * 0.8)
}

/** A body hitting the ground, as a ragdoll lands or rolls. */
export function bodyFall(at: Vec3, hard: number): void {
  play('land', 0.8 + Math.random() * 0.15, at, Math.min(1.2, hard))
  play('cloth', 0.9, at, Math.min(1, hard) * 0.6)
}

/** A doctor's own voice crying out: hurt (a short cry) or dismissed (a long yell), pitched by who they are. */
export function cry(who: string, at: Vec3 | null, kind: 'hurt' | 'out'): void {
  const p = 0.85 + (hash(who) % 9) * 0.045
  play(kind === 'hurt' ? 'ouch' : 'yell', p, at, kind === 'hurt' ? 0.8 : 1)
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

// ------------------------------------------------------------------------------ taunts aloud

/** A taunt's loudness against the game's other sounds (the server levels voices like the recorded cries). */
const VOICE = 1.2

/**
 * Plays a taunt as the server said it (MP3, base64) from where the doctor is, following them as
 * they go (`where`: their head now, or null once they are gone), louder nearer; nothing beyond
 * HEARING metres. Returns whether it is heard: with spoken taunts off in the options, or no voice
 * from the server, it is heard as a subtitle only.
 */
export function speak(voice: string | null, at: Vec3 | null, ear: Vec3 | null, where: () => Vec3 | null): boolean {
  if (at && ear && Math.hypot(at[0] - ear[0], at[1] - ear[1], at[2] - ear[2]) > HEARING) return false
  const c = audio()
  if (!voice || !c || !options().voices) return true
  void c.decodeAudioData(Uint8Array.from(atob(voice), (ch) => ch.charCodeAt(0)).buffer).then((buf) => {
    const r = route({ at, pitch: 1, volume: VOICE })
    if (!r) return
    const s = c.createBufferSource()
    s.buffer = buf
    s.connect(r.into)
    s.start()
    let on = true
    s.onended = () => (on = false)
    const follow = () => {
      if (!on) return
      const w = where()
      if (w) r.moveTo(w)
      requestAnimationFrame(follow)
    }
    if (at) requestAnimationFrame(follow)
  })
  return true
}
