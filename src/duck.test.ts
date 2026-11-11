/**
 * The other sounds dipping while a voice is near (audio.ts), without a browser: a stand-in for the
 * Web Audio nodes that keeps where each gain is headed.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { ducker, wakeAudio } from './audio'

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
  createConvolver() {
    return { ...node(), buffer: null }
  }
  createBuffer(_: number, n: number) {
    return { getChannelData: () => new Float32Array(n) }
  }
}

beforeAll(() => {
  Object.assign(globalThis, { AudioContext: FakeContext, fetch: () => Promise.reject(new Error('no sounds here')) })
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
