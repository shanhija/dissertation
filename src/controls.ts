/**
 * Keyboard and mouse to an Input: WASD moves, the mouse looks (in pointer lock; the arrow keys
 * turn and look too). The doctor has two hands: the left button uses what is in the left hand,
 * the right button what is in the right (an empty hand shoves), and with Shift held a click is
 * that thing's other use. E picks up, Q throws what is in the left hand and F what is in the
 * right, Space jumps. Presses are counted, so a click between two of the server's steps still counts. The page's own keys
 * (T writes a request, R asks for a random thing, V taunts, Tab shows the scores) go to
 * callbacks. While a text box has the keys, the game ignores them.
 */

import { options } from './options'
import { NO_PRESSES, type Hand, type Input } from './protocol'

export interface Callbacks {
  write: () => void
  random: () => void
  taunt: () => void
  scores: (on: boolean) => void
  /** A click while out of the round: watch the next doctor. */
  next: () => void
}

export class Controls {
  yaw = 0
  pitch = 0
  locked = false
  /** The player is out: clicks change who is watched instead of using. */
  watching = false
  private readonly keys = new Set<string>()
  private presses: Input['presses'] = { ...NO_PRESSES }
  /** Each hand's button held down (a shift-click is not). */
  private down: [boolean, boolean] = [false, false]
  private readonly off: (() => void)[] = []

  constructor(
    private readonly element: HTMLElement,
    private readonly cb: Callbacks,
  ) {
    const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
      document.addEventListener(type, fn)
      this.off.push(() => document.removeEventListener(type, fn))
    }
    on('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element
      if (!this.locked) this.release()
    })
    on('mousemove', (e) => {
      if (!this.locked) return
      const o = options()
      this.yaw -= e.movementX * o.sensitivity
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * o.sensitivity * (o.invertY ? -1 : 1)))
    })
    on('mousedown', (e) => {
      if (!this.locked) return
      if (this.watching) return this.cb.next()
      const hand: Hand | null = e.button === 0 ? 0 : e.button === 2 ? 1 : null
      if (hand === null) return
      if (e.shiftKey) this.count('other', hand)
      else {
        this.down[hand] = true
        this.count('use', hand)
      }
    })
    on('mouseup', (e) => {
      if (e.button === 0) this.down[0] = false
      if (e.button === 2) this.down[1] = false
    })
    on('contextmenu', (e) => {
      if (this.locked) e.preventDefault()
    })
    on('keydown', (e) => {
      if (isTyping(e.target)) return
      const k = e.code
      if (k === 'Tab') {
        e.preventDefault()
        this.cb.scores(true)
        return
      }
      if (k.startsWith('Arrow')) e.preventDefault()
      if (e.repeat) return
      this.keys.add(k)
      if (k === 'Space') {
        e.preventDefault()
        this.presses = { ...this.presses, jump: this.presses.jump + 1 }
      } else if (k === 'KeyE') this.presses = { ...this.presses, pick: this.presses.pick + 1 }
      else if (k === 'KeyQ') this.count('throw', 0)
      else if (k === 'KeyF') this.count('throw', 1)
      else if (k === 'KeyT' || k === 'Enter') {
        e.preventDefault()
        this.cb.write()
      } else if (k === 'KeyR') this.cb.random()
      else if (k === 'KeyV') this.cb.taunt()
    })
    on('keyup', (e) => {
      this.keys.delete(e.code)
      if (e.code === 'Tab') this.cb.scores(false)
    })
    on('visibilitychange', () => this.release())
  }

  /** One more press of a hand's click, shift-click or throw. */
  private count(k: 'use' | 'other' | 'throw', hand: Hand): void {
    const n: [number, number] = [...this.presses[k]]
    n[hand]++
    this.presses = { ...this.presses, [k]: n }
  }

  /** Lets go of every key and button: the page lost the pointer or the keys. */
  release(): void {
    this.keys.clear()
    this.down = [false, false]
  }

  lock(): void {
    const el = this.element as HTMLElement & { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void }
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true })
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => el.requestPointerLock())
    } catch {
      el.requestPointerLock()
    }
  }

  private lastInput = performance.now()

  input(): Input {
    const k = this.keys
    // The arrow keys turn and look too, for a touchpad.
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.lastInput) / 1000)
    this.lastInput = now
    this.yaw += ((k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0)) * 2.4 * dt
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + ((k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0)) * 1.6 * dt))
    const x = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    const z = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)
    return { move: [x, z], yaw: this.yaw, pitch: this.pitch, jump: k.has('Space'), hands: [...this.down], presses: this.presses }
  }

  dispose(): void {
    for (const f of this.off) f()
    if (document.pointerLockElement === this.element) document.exitPointerLock()
  }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}
