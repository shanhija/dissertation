/**
 * What the server and the players' browsers say to each other over the WebSocket at
 * /ws, and the numbers both sides share. Types and constants only: the page
 * imports this file and nothing of the sim, so no physics and no made code reach a browser.
 */

import type { Recipe } from './model/kit'

export type { Recipe }
export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

export const WS_PATH = '/ws'
export const TICK_HZ = 60
export const MAX_PLAYERS = 8
export const START_CRED = 100
/**
 * The rounds a doctor must win to take the match, as the chair may set them; left to the room,
 * fewer in a bigger room (5 for 2 to 3 doctors, 4 for 4 to 5, 3 for 6 to 8), fixed at the match's
 * first round.
 */
export const MATCH_WINS = [3, 4, 5, 7] as const
export type MatchWins = (typeof MATCH_WINS)[number]
/** One hit takes at most this much credibility. */
export const HIT_CAP = 10
/** One player (or the arena) takes at most this much a second from another. */
export const PER_SECOND_CAP = 20
/**
 * The control rule: seconds a doctor cannot play (held still, kept from their hands, all but blind,
 * pulled by what they cannot walk against, or lying knocked flat) count up and free seconds count
 * down; at this many they shake free, and for as long again no hold takes and knocks only push.
 */
export const HOLD_MAX = 5
/** What a thing may take from one player in any BUDGET_WINDOW seconds: most 10, a hard-to-hit or risky one 20. */
export const BUDGETS = [10, 20] as const
/** Seconds over which a thing's budget counts; then it may take again (weapons felt like they had "1-2 charges"). */
export const BUDGET_WINDOW = 20
export type Budget = (typeof BUDGETS)[number]
/** Bare hands are budgeted like a thing: a shove takes SHOVE_DAMAGE, at most this much from one player in any BUDGET_WINDOW seconds (the push is never budgeted). */
export const FISTS_BUDGET: Budget = BUDGETS[0]
/** What the 'spent' event calls a doctor's bare hands. */
export const BARE_HANDS = 'bare hands'
export const SHOVE_DAMAGE = 3
/** A fall out of the arena: credited to whoever last moved or hurt the doctor within a few seconds, and always this much, outside every budget and cap. */
export const FALL_DAMAGE = 10
/**
 * Seconds a crate that has turned ready opens only for its asker; then anyone may open it
 * (2026-11-11: "make boxes only open for requester for the first three seconds, then they can be opened by anyone").
 */
export const CRATE_OWNER_ONLY = 3
/** Seconds between two requests of one player. */
export const REQUEST_COOLDOWN = 15
/** Seconds from a request to its crate opening, designed or not (a crate brought to one's defence: from the round going live). */
export const DESIGN_LIMIT = 30
/** Seconds more a crate waits when its design failed its trial and went back to be fixed. */
export const FIX_GRACE = 15
/** Seconds a break may go on once the arena is ready and someone is not. */
export const READY_WAIT = 60
/** Seconds from everyone ready to the round ("when everyone is ready, then the game should start in 5 sec"), counted down in the arena. */
export const COUNTDOWN = 5
/** Seconds of round (from the countdown's start) after which the committee loses patience: everyone still in loses PATIENCE_DRAIN a second. */
export const PATIENCE = COUNTDOWN + 300
export const PATIENCE_DRAIN = 2
/** Metres within which a taunt is heard (louder nearer). */
export const HEARING = 30
/** The doctor's standing height when the look says 1.75; eyes are this far below the top. */
export const STANDARD_HEIGHT = 1.75
/** The world's pull, m/s²: the sim's, and what the page swings worn clothes by. */
export const GRAVITY = 20

export type Phase = 'dressing' | 'countdown' | 'round' | 'roundEnd' | 'matchEnd'
export type ArenaSetting = 'academic' | 'anything'

export interface Settings {
  bots: number
  arena: ArenaSetting
  /** The rounds to win the match, or null: by the room. */
  wins: MatchWins | null
}

/** Where worn parts go. The hand is for the thing held. */
export const SLOTS = ['hair', 'head', 'face', 'body', 'back', 'feet'] as const
export type Slot = (typeof SLOTS)[number]

/**
 * How a doctor walks: only how they move, never how fast or how big a target (one body for
 * everyone). 'chance' picks one by the player's id, the same on every screen.
 */
export const GAITS = ['chance', 'steady', 'limp', 'hunched', 'shuffle', 'waddle', 'pompous', 'doddery'] as const
export type Gait = (typeof GAITS)[number]

/** How a doctor looks: colours as '#rrggbb', sizes, how they walk, and the wardrobe part worn in each slot. */
export interface Look {
  /** Metres, 1.5 to 2.05. */
  height: number
  /** Width, 0.8 thin to 1.3 round. */
  build: number
  skin: string
  eyes: string
  coat: string
  shirt: string
  trousers: string
  shoes: string
  gait: Gait
  worn: Partial<Record<Slot, string>>
}

export interface Profile {
  name: string
  /** The thesis title; empty asks Haiku for one. */
  title: string
  look: Look
}

/** A wardrobe part: its slot and its model, built around the standard doctor (see the look designer's prompt). */
export interface WardrobePart {
  id: string
  name: string
  slot: Slot
  recipe: Recipe
  /** Who asked for it, and in which words; empty for the game's own. */
  by: string
  ask: string
}

export interface PlayerInfo {
  id: string
  name: string
  title: string
  look: Look
  /** One colour per player, for the name tag and the crate's label. */
  color: string
  bot: boolean
  ready: boolean
  /** A typed look is being made. */
  dressing: boolean
  wins: number
  chair: boolean
  connected: boolean
  /** What they bring to their defence this break: nothing asked yet, waiting its turn for a designer, being made, made, or failed (a thing from the archive waits instead). */
  bringing: 'none' | 'queued' | 'making' | 'ready' | 'failed'
}

/** The next arena: being built (for since seconds; it nearly always takes at most expect), built, or none on the way. */
export type ArenaStatus = { state: 'building'; since: number; expect: number; model: string } | { state: 'ready'; name: string } | { state: 'none' }

export interface Lobby {
  players: PlayerInfo[]
  settings: Settings
  phase: Phase
  /** Seconds left in the countdown, the round's end or the break's wait; null when nothing counts down. */
  timer: number | null
  round: number
  /** The arena the next round is played in (or the one being played). */
  arena: ArenaStatus
  /** Who won the last round or the match, for the end screens. */
  winner: string | null
  /** The rounds to win this match (the next one, between matches). */
  wins: MatchWins
  /** Addresses friends open, as the server sees its own network. */
  join: string[]
}

/** A doctor's hands: 0 the left, used with the left mouse button, 1 the right, with the right. */
export type Hand = 0 | 1
export const HANDS: readonly Hand[] = [0, 1]

/**
 * Presses counted since the page began, so a quick click between two steps is not lost: per
 * hand, clicks (use), shift-clicks (the thing's other use) and throws; and picking up and jumping.
 */
export interface Presses {
  use: [number, number]
  other: [number, number]
  throw: [number, number]
  pick: number
  jump: number
}

/** What a player does this frame. */
export interface Input {
  /** x to the right, z forward, each -1..1. */
  move: [number, number]
  yaw: number
  pitch: number
  jump: boolean
  /** The left and the right mouse buttons held down. */
  hands: [boolean, boolean]
  presses: Presses
}

export const NO_PRESSES: Presses = { use: [0, 0], other: [0, 0], throw: [0, 0], pick: 0, jump: 0 }
export const NO_INPUT: Input = { move: [0, 0], yaw: 0, pitch: 0, jump: false, hands: [false, false], presses: NO_PRESSES }

/** A plain shape for a body with no model of its own. */
export interface Prim {
  shape: 'ball' | 'box' | 'capsule' | 'cylinder'
  size: Vec3
  color: string
  glow: boolean
  /** Drawn in an arena surface (the rubble of a broken piece), or null: a made body's plain colour. */
  material: MaterialName | null
}

export interface DoctorSnap {
  id: string
  /** Feet. */
  p: Vec3
  yaw: number
  pitch: number
  cred: number
  alive: boolean
  /** The thing instance in each hand (0 left, 1 right). */
  hands: [string | null, string | null]
  writing: boolean
  /** The thing in hand they ride: it is drawn under them. */
  riding: string | null
  /** Disguised as this model: the doctor, their name and their bar are not drawn, only the model. */
  disguise: string | null
  /** Size from effects, 1 normal. */
  size: number
  /** Seconds since last hurt, for the flash. */
  hurt: number
  grounded: boolean
  /** What the floor under their feet is made of (for their footsteps), or null off the ground. */
  floor: MaterialName | null
  /** Knocked flat or dismissed: the body is a ragdoll, drawn as it lies. */
  rag: RagSnap | null
  /** How the effects on them show, or null when none shows. */
  fx: DoctorFx | null
}

/**
 * A doctor's ragdoll: the pelvis joint (world) and each part's turn, in the order pelvis, chest,
 * head, right upper arm, right forearm, left upper arm, left forearm, right thigh, right shin, left
 * thigh, left shin. Each part's frame is the drawn doctor's joint: it hangs along its own -y.
 */
export interface RagSnap {
  p: Vec3
  q: Quat[]
}

/** Effects on a doctor as drawn: trembling, a glow, models over them, their view covered, and whether they are held (still, or kept from their hands). */
export interface DoctorFx {
  /** 0 still to 1 convulsing. */
  shake: number
  glow: string | null
  /** Model ids, drawn round them with their feet at the origin. */
  wear: string[]
  /** How much of their own view is covered, 0..1, in tint. */
  blind: number
  tint: string | null
  held: boolean
}

export interface ThingSnap {
  id: string
  /** The thing's kind: its model is `thing:<kind>`. */
  kind: string
  holder: string | null
  p: Vec3
  q: Quat
  poses: Record<string, Vec3> | null
  scale: number
}

export interface BodySnap {
  id: string
  model: string | null
  prim: Prim | null
  p: Vec3
  q: Quat
  /** Drawn this many times its size (a model's scale, and what code resized it by). */
  scale: number
  poses: Record<string, Vec3> | null
  /** It leaves a fading trail of this colour. */
  trail: string | null
}

/** One end of a tie: a fixed point, or something it holds on to (a doctor at their chest, a body at its middle, a thing where it is). */
export type TieEnd = { kind: 'point'; p: Vec3 } | { kind: 'doctor' | 'body' | 'thing'; id: string }

/** A rope or spring between two ends, drawn sagging as slack as it is (color null: not drawn). */
export interface TieSnap {
  id: string
  a: TieEnd
  b: TieEnd
  length: number
  spring: boolean
  color: string | null
  width: number
}

/** What a sight goes and turns with: at and its turn are then in that one's frame. */
export interface Follow {
  kind: 'doctor' | 'body' | 'thing'
  id: string
}

export interface CrateSnap {
  id: string
  p: Vec3
  /** The asker's player id. */
  owner: string
  /** Coming in (a sight, nothing touches it yet), then here waiting for its thing, then ready to open. */
  state: 'arriving' | 'waiting' | 'ready'
  /** How far it has come in, 0..1. */
  arrived: number
  /** The asker's words (cut short), or null for something nobody has had (the random button). */
  ask: string | null
  /** Its thing came from the archive (the design failed or came too late), not from the asker's words. */
  archive: boolean
  /** Server seconds (Snap.t) until which only its owner may open it (CRATE_OWNER_ONLY); null until it is ready in a live round. */
  ownerUntil: number | null
}

export interface MoverSnap {
  id: string
  p: Vec3
  q: Quat
}

export type GameEvent =
  /** Credibility taken: by whom (null: the arena or nobody; 'committee': its patience), and with what (a thing's name, 'a shove', 'a fall', 'a fall from the arena', 'the arena', "the committee's patience"). */
  | { type: 'hit'; victim: string; amount: number; at: Vec3; by: string | null; what: string }
  /**
   * A thing (or bare hands) that has taken all its budget from this doctor struck them again and
   * took nothing: said at most once per thing and doctor every few seconds. back: seconds until it
   * may take from them again. The caps (a hit, a second) say nothing.
   */
  | { type: 'spent'; victim: string; by: string | null; thing: string; back: number }
  | { type: 'out'; victim: string; by: string | null; what: string }
  /** Bits flying from a point: all round, or toward dir within spread (0 a jet, 1 all round); speed and secs null: by size. */
  | { type: 'burst'; at: Vec3; color: string; size: number; count: number; glow: boolean; speed?: number | null; secs?: number | null; dir?: Vec3 | null; spread?: number }
  /** jag 0 straight, up to 1 a crackling zigzag. */
  | { type: 'beam'; from: Vec3; to: Vec3; color: string; width: number; secs: number; jag: number }
  /** A soft cloud swelling to `size` metres across and fading over `secs`, rising; a glowing one lights what is near. */
  | { type: 'puff'; at: Vec3; color: string; size: number; secs: number; rise: number; glow: boolean }
  /** Shakes the view of whoever is near, strength 0..1 at the point. */
  | { type: 'shake'; at: Vec3; strength: number }
  | { type: 'text'; at: Vec3; text: string; color: string }
  | { type: 'sound'; at: Vec3; sound: SoundName; pitch: number; volume?: number }
  /** A body or a loose thing struck something (the arena's material, a doctor, or another object) this fast, this heavy. */
  | { type: 'impact'; at: Vec3; speed: number; mass: number; on: MaterialName | 'flesh' | 'object' }
  /**
   * A breakable piece of the arena broke: gone from the drawing (its rubble comes as bodies),
   * heard and seen by what it was made of, size its reach in metres; fell: it lost what held it
   * up and drops whole, with no crash of its own.
   */
  | { type: 'break'; piece: string; at: Vec3; material: MaterialName; color: string; size: number; fell: boolean }
  /** A curse laid on a doctor's next request (a review, by a player dismissed; or a thing's), by whom (a player, or null: the arena). */
  | { type: 'curse'; victim: string; text: string; by: string | null }
  /** A doctor pressed E at a crate that is still only its asker's: secs until anyone may open it. */
  | { type: 'notYet'; who: string; owner: string; secs: number }
  /**
   * A crate opened by `by`, asked for by `owner` in these words (null: the random button); its
   * thing came twisted by the genie, or from the archive, or under a curse's words (null: none).
   */
  | { type: 'opened'; crate: string; by: string; owner: string; thing: string; ask: string | null; genie: boolean; archive: boolean; curse: string | null }
  /** A doctor did something with a hand, for the drawing to show. */
  | { type: 'act'; who: string; act: 'use' | 'alt' | 'throw' | 'shove' | 'pick'; hand: Hand }
  | { type: 'fizzle'; thing: string; holder: string | null }
  /**
   * A sight: a model shown for secs, never touched. Its size goes from scale to grow (easing out),
   * it moves at vel and turns at spin (radians a second about its own axes), and fades over the
   * last `fade` of its life. Followed, at and q are in the frame of what it follows.
   */
  | { type: 'show'; id: string; model: string; at: Vec3; q: Quat; scale: Vec3; grow: Vec3 | null; vel: Vec3; spin: Vec3; secs: number; fade: number; opacity: number; light: string | null; follow: Follow | null }
  /** Code steered a sight: what it set now holds from here on (gone: it is removed). */
  | { type: 'reshow'; id: string; at?: Vec3; q?: Quat; scale?: Vec3; opacity?: number; poses?: Record<string, Vec3>; gone?: boolean }

/**
 * The sounds made things (and the game) may play by name: recordings in sounds/ (crackle
 * and hum are drawn by the page). Footsteps, landings and what things strike are the game's own
 * and are not listed here.
 */
export const SOUNDS = [
  'bang', 'gunshot', 'rifle', 'shotgun', 'smg', 'cannon', 'boom', 'firework',
  'laser', 'zap', 'crackle', 'teleport', 'powerup', 'scifi', 'beep', 'magic', 'hum',
  'whoosh', 'boing', 'squeak', 'creak', 'thud', 'ring', 'gong', 'splat', 'crunch',
  'punch', 'clang', 'knock', 'smash', 'shatter', 'clink', 'splash', 'bubble', 'slime',
  'clash', 'blade', 'chain', 'coins', 'chime', 'page', 'book', 'door', 'keys', 'click', 'hammer', 'drill', 'steam', 'stones', 'thunder', 'rustle',
  'grunt', 'yell', 'scream', 'ouch', 'cough', 'burp', 'roar', 'creature', 'bark',
] as const
export type SoundName = (typeof SOUNDS)[number]

export interface Snap {
  /** Server seconds. */
  t: number
  doctors: DoctorSnap[]
  things: ThingSnap[]
  bodies: BodySnap[]
  crates: CrateSnap[]
  movers: MoverSnap[]
  ties: TieSnap[]
  events: GameEvent[]
}

/** How a thing came out of its crate: asked for by a player in these words (null: something nobody has had), twisted by the genie, or from the archive in their place. */
export interface Origin {
  by: string
  ask: string | null
  genie: boolean
  archive: boolean
}

export interface HeldInfo {
  name: string
  description: string
  budget: Budget
  /** Null for a thing that came from no crate. */
  origin: Origin | null
}

/** What only this player sees. */
export interface Me {
  /** Seconds until the next request may go. */
  cooldown: number
  /** A crate they asked for in the round is in the air or waiting (the one brought to their defence aside). */
  crate: boolean
  /** Their next request is under review: the words, and whose (a player, or null: the arena). */
  curse: { text: string; by: string | null } | null
  /** What is in each hand (0 left, 1 right). */
  hands: [HeldInfo | null, HeldInfo | null]
  /** The last request's fate, shown for a moment. */
  note: string | null
  /** They may write a review now: dismissed in a round, with a name, and none written yet this round (of a player: bots ask for nothing). */
  review: boolean
}

/**
 * The surfaces an arena is made of. Each is a texture with relief, drawn in the colour given
 * (most are neutral and take the colour whole; books, chalkboard and lava keep most of their own).
 */
export const MATERIALS = [
  'plain', 'plaster', 'planks', 'wood', 'stone', 'brick', 'marble', 'tiles', 'carpet', 'fabric', 'paper', 'books', 'chalkboard',
  'metal', 'brass', 'glass', 'concrete', 'rock', 'earth', 'grass', 'water', 'lava',
] as const
export type MaterialName = (typeof MATERIALS)[number]

/** The arena as drawn: solids (each a collider too), shaped pieces and decorations, lamps and the sky. */
export interface ArenaSolid {
  id: string
  kind: 'box' | 'ramp' | 'cylinder' | 'sphere'
  /** box and ramp [w, h, d]; cylinder [r, h, r]; sphere [r, r, r]. */
  size: Vec3
  /** In its mover's frame when it has one. */
  at: Vec3
  rot: Vec3
  color: string
  material: MaterialName
  mover: string | null
  /** The breakable piece it is part of, or null. */
  piece: string | null
}

/** A model placed in the arena: a decoration, or a shaped piece that is solid too (its collider built from its shapes). */
export interface ArenaDecor {
  model: string
  at: Vec3
  rot: Vec3
  scale: number
  material: MaterialName
  solid: boolean
  mover: string | null
  /** The breakable piece it is part of, or null. */
  piece: string | null
}

export interface ArenaLight {
  at: Vec3
  color: string
  /** 0..1 of the brightest a lamp may be. */
  power: number
  /** Metres it reaches. */
  range: number
  mover: string | null
}

/**
 * A painted portrait of one of the doctors playing, in a gilt frame, its canvas facing +z: rank 0
 * is whoever leads the match, 1 the next (round the players again when there are fewer). size is
 * the canvas's height in metres.
 */
export interface ArenaPortrait {
  at: Vec3
  rot: Vec3
  size: number
  rank: number
  mover: string | null
}

export interface Sky {
  color: string
  fog: number
  light: string
  ground: string
}

export interface ArenaView {
  id: string
  name: string
  sky: Sky
  solids: ArenaSolid[]
  decor: ArenaDecor[]
  lights: ArenaLight[]
  portraits: ArenaPortrait[]
  movers: string[]
  /** The breakable pieces broken so far this round, for a page that comes in late. */
  broken: string[]
}

export type ServerMsg =
  | { type: 'welcome'; you: string }
  | { type: 'lobby'; lobby: Lobby }
  | { type: 'arena'; arena: ArenaView | null }
  | { type: 'models'; models: Record<string, Recipe> }
  | { type: 'wardrobe'; parts: WardrobePart[] }
  | { type: 'snap'; me: Me; snap: Snap }
  /**
   * A taunt, said in the doctor's voice by the server: played by every browser that hears it,
   * louder nearer (at null: heard by all, as in the dressing room). voice is MP3 in base64, null
   * when the server has no voice (then the taunt is only read).
   */
  | { type: 'taunt'; by: string; text: string; at: Vec3 | null; voice: string | null }
  /** The player's own profile as the server now has it (a title written for them, a look dressed). */
  | { type: 'profile'; profile: Profile }
  /** A line for this player alone, shown for a moment. */
  | { type: 'note'; text: string }
  | { type: 'refused'; why: string }

export type ClientMsg =
  | { type: 'hello'; key: string; profile: Profile | null }
  | { type: 'profile'; profile: Profile }
  | { type: 'dress'; text: string }
  | { type: 'ready'; ready: boolean }
  | { type: 'input'; input: Input }
  | { type: 'writing'; on: boolean }
  | { type: 'request'; text: string }
  | { type: 'random' }
  /** What they will bring to their defence, as written so far (empty: something nobody has had). */
  | { type: 'bring'; text: string }
  /** A dismissed player's review of a doctor still in, laid on that doctor's next request. */
  | { type: 'review'; target: string; text: string }
  | { type: 'taunt' }
  | { type: 'settings'; settings: Settings }
  | { type: 'endRound' }
