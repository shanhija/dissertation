import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { thingApi } from './api'
import { BUILD_MS, buildArena } from './arena'
import { GUARD_LIMIT, GUARD_MS, TOO_SLOW, call, callFor, compile, type Called } from './sandbox'
import { Sim, initPhysics } from './sim'

beforeAll(async () => {
  await initPhysics()
})

/** Builds arena code as the game does, and how long it took. */
function build(body: string): { error: string | null; ms: number } {
  const sim = new Sim()
  sim.apiFor = thingApi
  const t0 = performance.now()
  try {
    buildArena(sim, { id: 'test', name: 'Test', build: compile('arena', body) })
    return { error: null, ms: performance.now() - t0 }
  } catch (err) {
    return { error: (err as Error).message, ms: performance.now() - t0 }
  } finally {
    sim.free()
  }
}

/**
 * Arena code that sets up a floor, a spawn point and `dust`, an array whose JSON takes about `ms`
 * to write on this machine (timed here), so a test of time holds however fast the machine is.
 */
function floor(ms: number): string {
  const dust = new Array(2500).fill('dust')
  for (let i = 0; i < 50; i++) JSON.stringify(dust)
  const t0 = performance.now()
  for (let i = 0; i < 200; i++) JSON.stringify(dust)
  const turn = (performance.now() - t0) / 200
  return `const dust = new Array(${Math.max(1, Math.round((2500 * ms) / turn))}).fill('dust'); a.box([60, 1, 60], { at: [0, -0.5, 0] }); a.spawn([0, 0, 0]);`
}

/**
 * A turn of a loop that writes the dust takes a fifth of what the turn limit leaves a turn in the
 * build's time: GUARD_LIMIT turns would take five times BUILD_MS, and the 1,024 turns between two
 * looks at the clock a tenth of a second.
 */
const TURN_MS = BUILD_MS / GUARD_LIMIT / 0.2

describe('the arena build', () => {
  it('may take far longer than a call of a thing', () => {
    const r = build(`${floor(TURN_MS)} for (let i = 0; i < 1100; i++) JSON.stringify(dust)`)
    expect(r.error).toBeNull()
    expect(r.ms).toBeGreaterThan(GUARD_MS)
  })

  it('is stopped once it has run past its time, and told to build lighter', () => {
    const r = build(`${floor(TURN_MS)} for (;;) JSON.stringify(dust)`)
    expect(r.error).toMatch(new RegExp(`took over ${BUILD_MS} ms to build .*build it lighter`))
    expect(r.ms).toBeLessThan(BUILD_MS + 500)
  })

  it('counts what it builds inside on its own clock', () => {
    const r = build(`${floor(TURN_MS)} for (;;) a.decor((m) => { for (let i = 0; i < 1100; i++) JSON.stringify(dust); m.box(1, 1, 1) })`)
    expect(r.error).toMatch(/build it lighter/)
    expect(r.ms).toBeLessThan(BUILD_MS + 500)
  })

  it('that fails for something else after its time is told what failed, not that it was stopped', () => {
    // A few dozen turns of heavy work: past the build's time, but too few turns for the guard to look at the clock.
    const r = build(`${floor(50)} const t = Date.now(); while (Date.now() - t < ${BUILD_MS + 100}) JSON.stringify(dust); const none = null; none.x`)
    expect(r.ms).toBeGreaterThan(BUILD_MS)
    expect(r.error).toMatch(/^the arena would not build: TypeError/)
  })
})

describe('a call made inside another', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A clock only made code moves, by calling `wait(ms)`. */
  function clock(): { wait: (ms: number) => void } {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    return { wait: (ms) => (now += ms) }
  }

  // 1,100 turns of 0.01 ms: 11 ms, under a thing's GUARD_MS, the clock looked at once on the way. Then the call w makes, if any.
  const WAITS = compile('thing', `for (let i = 0; i < 1100; i++) me.wait(0.01); return w ? w() : 'done'`)

  it("has a clock of its own when a thing's handler runs inside another thing's call (a dropped from a blow)", () => {
    const me = clock()
    const r = call<Called<string>>(WAITS, null, me, () => call(WAITS, null, me, null))
    expect(r).toEqual({ ok: true, value: { ok: true, value: 'done' } })
  })

  it("counts on the build's clock inside an arena's build", () => {
    const me = clock()
    // The build has 5 ms of its time left when it builds what takes 11.
    const build = compile('arena', `a.wait(${BUILD_MS - 5}); return w()`)
    const r = callFor<Called<string>>(BUILD_MS, build, null, me, () => call(WAITS, null, me, null))
    expect(r).toEqual({ ok: true, value: { ok: false, error: expect.stringContaining(TOO_SLOW) } })
  })
})
