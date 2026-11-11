/**
 * Running made code on the server. The text is guarded first by guard.ts (its own
 * names, its function's parameters and plain JavaScript only; no constructor or prototype keys;
 * `__g()` at the top of every loop and function body), then compiled in a `node:vm` context of
 * its own, so two designs never share a Math or an Array. The guard is the wall; the context
 * only keeps designs apart. Every call into made code goes through `call` (or `callFor`, with
 * a time of its own that covers what it calls), which gives it a fresh budget of loop turns and
 * milliseconds (inside a `callFor`, its turns only) and turns whatever it throws into a short
 * line.
 */

import vm from 'node:vm'

import { guardBody } from './guard'

/** Loop turns and calls one call into made code may take. */
export const GUARD_LIMIT = 50_000
/** Real milliseconds one call may keep looping: the server steps every 16. */
export const GUARD_MS = 12
/** What the guard says of a call it stopped for running past its time. */
export const TOO_SLOW = 'a loop took too long'

export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

/** Made code that would not compile, with the designer's line. */
export class MadeCodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MadeCodeError'
  }
}

/** The call into made code that is running: its turns so far, when its clock started, how long it may take, and whether the calls it makes share that clock (inside a `callFor`). */
let spent = 0
let since = 0
let budget = GUARD_MS
let covers = false

function guard() {
  if (++spent > GUARD_LIMIT) throw new GuardError('a loop ran too long')
  if ((spent & 1023) === 0 && performance.now() - since > budget) throw new GuardError(TOO_SLOW)
}

const QUIET = Object.freeze({ log() {}, warn() {}, error() {}, info() {} })

/** The function headers made code is the body of. */
export const HEADS = {
  look: 'function __model(m) {',
  thing: 'function __thing(me, w) {',
  arena: 'function __arena(a, w) {',
} as const
export type CodeKind = keyof typeof HEADS

/** The guarded text of a body, or a MadeCodeError naming the line. */
export function guarded(kind: CodeKind, code: string): string {
  const g = guardBody(HEADS[kind], code)
  if (!g.ok) throw new MadeCodeError(g.error)
  return g.guarded
}

/** Compiles guarded text into its function, in a context of its own. */
export function compileGuarded(text: string, what: string): (...args: never[]) => unknown {
  const context = vm.createContext({ __g: guard, console: QUIET })
  let fn: unknown
  try {
    fn = new vm.Script(`"use strict";(${text}\n)`, { filename: 'made' }).runInContext(context, { timeout: 100 })
  } catch (err) {
    throw new MadeCodeError(`${what}: ${describeError(err)}`)
  }
  if (typeof fn !== 'function') throw new MadeCodeError(`${what} is not a function`)
  return fn as (...args: never[]) => unknown
}

/** Guards and compiles a body. */
export function compile(kind: CodeKind, code: string): (...args: never[]) => unknown {
  return compileGuarded(guarded(kind, code), kind)
}

export type Called<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * One call into made code with a fresh budget: GUARD_MS of its own, even when made from inside
 * another (a thing's `dropped` when another thing's blow knocks its holder down); inside a
 * `callFor`, on that call's clock. Never throws.
 */
export function call<T>(fn: unknown, self: unknown, ...args: unknown[]): Called<T> {
  return run(covers ? null : GUARD_MS, false, fn, self, args)
}

/**
 * One call into made code that may take `ms` real milliseconds, everything it calls included:
 * what an arena builds as it is built counts on the build's clock, so the build's time covers it
 * all. Never throws.
 */
export function callFor<T>(ms: number, fn: unknown, self: unknown, ...args: unknown[]): Called<T> {
  return run(ms, true, fn, self, args)
}

/**
 * A call with a fresh count of loop turns and a clock of `ms` of its own (whose time covers the
 * calls it makes when `covering`), or, with `ms` null, on the clock it runs inside. The turns and
 * the clock it ran inside are given back after.
 */
function run<T>(ms: number | null, covering: boolean, fn: unknown, self: unknown, args: unknown[]): Called<T> {
  if (typeof fn !== 'function') return { ok: true, value: undefined as T }
  const outer = { spent, since, budget, covers }
  spent = 0
  if (ms !== null) {
    since = performance.now()
    budget = ms
    covers = covering
  }
  try {
    return { ok: true, value: (fn as (...a: unknown[]) => T).apply(self, args) }
  } catch (err) {
    return { ok: false, error: describeError(err) }
  } finally {
    spent = outer.spent
    since = outer.since
    budget = outer.budget
    covers = outer.covers
  }
}

/** An error from made code as one short line: the message and the designer's line (the guarded function's header is line 1). */
export function describeError(err: unknown): string {
  const text = err instanceof Error || (typeof err === 'object' && err !== null && 'message' in err) ? `${(err as Error).name ?? 'Error'}: ${(err as Error).message}` : `thrown: ${String(err)}`
  const stack = typeof err === 'object' && err !== null ? String((err as Error).stack ?? '') : ''
  const m = /made:(\d+)/.exec(stack)
  const line = m ? Number(m[1]) - 1 : null
  return (line !== null && line >= 1 ? `${text} (line ${line})` : text).slice(0, 300)
}
