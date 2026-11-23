/**
 * The other sounds dipping while a voice is near, and how many may start at once (audio.ts),
 * without a browser: a stand-in for the Web Audio nodes that keeps where each gain is headed.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { ducker, route, wakeAudio, type Placed } from './audio'

// The options live in the browser's storage: the volume is all a sound reads here.
vi.mock('./options', () => ({ options: () => ({ volume: 1, voices: true }) }))

class Param {
  value = 1
  cancelScheduledValues(): void {}
  setTargetAtTime(v: number): void {
    this.value = v
  }
}
const gains: { gain: Param }[] = []
const node = () => ({ connect: <T>(n: T) => n })
class FakeContext {
  state = 'running'
  currentTime = 0
  sampleRate = 8000
  destination = node()
  resume(): Promise<void> {
    return Promise.resolve()
  }
  createGain() {
    const g = { ...node(), gain: new Param() }
    gains.push(g)
    return g
  }
  createBiquadFilter() {
    return { ...node(), type: '', Q: { value: 0 }, frequency: { value: 0 } }
  }
  createConvolver() {
    return { ...node(), buffer: null }
  }
  createBuffer(_: number, n: number) {
    return { getChannelData: () => new Float32Array(n) }
  }
}

const panned: string[] = []
class FakePanner {
  constructor(_: unknown, o: { panningModel: string }) {
    panned.push(o.panningModel)
  }
  connect<T>(n: T): T {
    return n
  }
}

beforeAll(() => {
  Object.assign(globalThis, { AudioContext: FakeContext, PannerNode: FakePanner, fetch: () => Promise.reject(new Error('no sounds here')) })
  wakeAudio()
})

describe('a voice near the ear', () => {
  it('dips the other sounds while it is within 12 m as it moves, until the last near voice ends', () => {
    // The master, the echo, and the other sounds' dry and echo buses, in the order made.
    const others = () => gains.slice(2, 4).map((g) => Math.round(g.gain.value * 100) / 100)
    const a = ducker()
    a(20)
    expect(others()).toEqual([1, 1])
    // Walking up from 20 m: down once within 12 m.
    a(11)
    expect(others()).toEqual([0.63, 0.63])
    a(4)
    // A second voice near, then the first walks off: still down while the second is near.
    const b = ducker()
    b(3)
    a(15)
    expect(others()).toEqual([0.63, 0.63])
    b(Infinity)
    expect(others()).toEqual([1, 1])
    // One ended while away does not let go of another's dip.
    a(5)
    b(30)
    b(Infinity)
    expect(others()).toEqual([0.63, 0.63])
    a(Infinity)
    expect(others()).toEqual([1, 1])
  })
})

describe('sounds starting at once', () => {
  it('start 16 at once at most, only near ones when few are left, and voices always; near ones pan by the head', () => {
    let now = 1e6
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const at = (x: number): Placed => ({ at: [x, 1.6, 0], pitch: 1, volume: 1 })
    const started = (x: number, n: number, kind: 'sound' | 'voice' = 'sound') => Array.from({ length: n }, () => route(at(x), kind)).filter(Boolean).length
    // After a quiet while: 11 far ones (down to 5 left), then no more far.
    expect(started(30, 12)).toBe(11)
    // Near ones take the rest; then none, but voices.
    expect(started(5, 6)).toBe(5)
    expect(started(30, 1, 'voice')).toBe(1)
    // A second later it is full again.
    now += 1000
    expect(started(5, 17)).toBe(16)
    expect(panned.slice(0, 11).every((m) => m === 'equalpower')).toBe(true)
    expect(panned.slice(11, 16).every((m) => m === 'HRTF')).toBe(true)
    // A voice pans by the head however far.
    expect(panned[16]).toBe('HRTF')
  })
})
