/**
 * What the models are told, and the shapes of their answers. The rule for these prompts: be
 * general, never list what a design may or may not be, and give no examples (an example steers
 * every answer toward itself). The API references below are the only lists, and they name
 * building blocks; they must say exactly what sim/api.ts, sim/arena.ts and the modelling kit do.
 */

import { BODY, SLOT_FRAMES } from '../doctor'
import { BUDGET_WINDOW, BUDGETS, CRATE_OWNER_ONLY, DESIGN_LIMIT, GAITS, HIT_CAP, HOLD_MAX, MATERIALS, PER_SECOND_CAP, SLOTS, SOUNDS, type ArenaSetting, type Gait, type Look } from '../protocol'
import { DOCTOR_MASS } from '../sim/forces'
import { FLOP, MAX_SIGHTS_PER_SOURCE } from '../sim/sim'
import { TONE_NAMES } from './voice'

export type Schema = Record<string, unknown>

const str = (description: string): Schema => ({ type: 'string', description })

/** Written just before a model's code, so the model is built from the real form: it streams in 1 to 2 s. */
const FORM = str('Before the model code: in a sentence or two, the real form of what you will model: its main masses and how they join, what is round, curved, tapered or thin, where its edges are soft and where sharp, its proportions.')

export const MODEL_DOC = `MODEL CODE: the body of  function (m) { ... }  It builds a model out of shapes. Metres, y up.
Every shape takes opts { at: [x, y, z] (its centre), rot: [rx, ry, rz] (radians, applied x then y then z), scale: [sx, sy, sz], color: '#rrggbb' or a CSS colour name, glow: true (lit by itself) }.
  m.box(w, h, d, opts)
  m.sphere(r, opts)
  m.cylinder(rTop, rBottom, h, opts)     upright along y, centred on at; rTop 0 is a cone.   m.cone(r, h, opts)
  m.torus(r, tube, opts)                 a ring in the x-y plane, its hole along z
  m.capsule(r, length, opts)             upright, round ends
  m.lathe([[r, y], ...], opts)           a round shape turned all the way round the y axis through the points
  m.extrude([[x, y], ...], depth, opts)  a flat outline in x-y made depth thick along z
  m.tube([[x, y, z], ...], r, opts)      a bendy tube through the points
  m.part(name, { at, rot }, () => { ... })   shapes made inside belong to a named part pivoting at at (their coordinates are from the pivot); code turns it with me.pose(name, [rx, ry, rz])
  m.anchor(name, [x, y, z])              a named point
At most 400 shapes. Each is drawn as given and smoothly lit: a round shape with about a dozen sides round (a tube six), while a model's box, the ends of a cylinder and an outline made thick, at its rim and between its points, keep sharp edges, and where shapes meet nothing is blended. Seen from within, a shape can be invisible, so a surface seen from within needs a thickness of its own. Model the real form in its true proportions: round where it is round, curved where it curves, thin parts thin, and edges as soft or as sharp as the real ones, a soft edge rounded into the outline or profile. Make each form with the shape that makes it, a curve with enough points to look smooth; a box only for what really is a block.`

export const THING_DOC = `THING CODE: the body of  function (me, w) { ... }
It runs once, when the thing comes out of its crate. Keep whatever it remembers in your own variables, then return its handlers, any of:
  use()            the holder clicked it (a doctor holds a thing in each hand, each used with the mouse button on its side)
  hold(dt)         every step (1/60 s) while the click is held down
  release()        the click is let go
  alt()            the holder shift-clicked it, its other use
  tick(dt)         every step while the thing exists, in a hand or lying loose
  picked(doctor)   someone took it in hand
  dropped()        it fell from a hand (its holder was knocked out)
  thrown()         its holder threw it; a thrown thing that hits a doctor takes 6 from them by itself
Plain JavaScript: no imports, no async, no timers (count time with w.time). Every call must be quick.

A doctor (as code sees one): a plain object of values taken at that moment, not a live handle, so its fields are read, never called: { id, name, pos (feet, [x, y, z]), eye ([x, y, z]), aim (a unit vector where they look), vel, yaw, pitch, cred, alive, grounded, holding (a name or null), size }. Ask w for it again to see it later; pass it to w.hurt and the rest.
  Doctors are ${BODY.height} m tall with their eyes at 1.55 m; yaw 0 looks along +z. The world pulls down at 20 m/s².

me:
  me.holder()            the doctor holding it, or null
  me.aim()               the holder's { from (the hand), eye, dir (a unit vector) }
  me.pos()               where it is now
  me.pose(part, [rx, ry, rz])   turns a named part of its model (radians)
  me.ride(on = true)     its holder rides it: it is drawn under their feet, facing where they face, and goes where they go
  me.disguise(name?)     its holder is drawn as this thing (or as a model made with w.model) instead of a doctor, with no name or bar over them; me.disguise(false) ends it. Hits still find the doctor.
  me.resize(k)           draws it k times its size
  me.dealt(doctor)       what it has taken from that doctor in the last ${BUDGET_WINDOW} s;  me.budget, what it may take from one doctor in any ${BUDGET_WINDOW} s
  me.drop()              its holder lets go of it
  me.spend()             it is used up and gone

w:
  w.time                 seconds since the round started
  w.random()
  w.doctors()            every doctor;  w.others(), the ones still in except the holder;  w.doctor(id)
  w.ray(from, dir, max = 100)   the first thing a line meets, leaving out the holder and the thing's own bodies: { dist, point, normal, doctor, body, arena } or null
  w.near(at, radius)     { doctors, bodies } within the radius
  w.hurt(doctor, amount, { push, from })   takes credibility and returns what it took (0 or less takes none and gives none back). push: metres a second away from \`from\` (default: the holder), or a vector [x, y, z]
  w.push(doctor or body, [x, y, z])        adds speed. A doctor knocked at ${FLOP} m/s or more is knocked flat: they tumble as a ragdoll and get up when they come to rest.
  w.topple(doctor, [x, y, z])   knocks them flat at any speed, thrown at that velocity (within 1.5 s of getting up, or after shaking a hold off, only pushed)
  w.blast(at, radius, speed)    throws everyone and everything within radius away from at (doctors, bodies, loose things; not the holder): speed m/s at the middle, falling to nothing at the edge, lighter bodies flying faster; the arena shelters what is behind it, and what of the arena can break, it strikes. Returns [{ doctor, strength 0..1 }] for the doctors it reached; it takes no credibility by itself.
  w.field({ at, radius, follow, secs, pull, swirl, lift, wind, drag })   a space that keeps moving whatever is inside it (doctors, bodies, loose things; not the holder), each in m/s²: pull toward its middle (below 0 pushes out), swirl round it, lift up (over 20 lifts a doctor off their feet), wind a push [x, y, z], drag slows. follow as a zone's, or a doctor. secs 5, at most 30. Returns { set(spec), alive(), remove() }.
  w.tie(a, b, { length, spring, secs, color, width })   a rope between two of: a doctor (at their chest), a body, me (the hand that holds it, so it pulls the holder), or a point [x, y, z]. It never lets them get further apart than length (the distance now, by default); spring 0..1 makes it pull and push back toward its length, softly to stiffly. The heavier end moves less. Drawn sagging when slack, in color and width (color false: not drawn). secs 10, at most 30. Returns { length(), setLength(l), distance() (how far apart its ends are now), alive(), remove() }.
  w.affect(doctor, { speed, jump, gravity, size, slip, reverse, hands, blind, tint, shake, glow, wear }, secs)   changes a doctor for up to 15 s: speed, jump, gravity and size multiply (1 is normal; speed 0 and jump 0 keep them where they stand), slip 0..1, reverse swaps their keys, hands false keeps them from using, picking up or throwing anything, blind 0..1 covers their own view in tint (a colour; dark unless given), 1 seeing nothing;
      and how they look meanwhile: shake 0..1 makes them tremble (1 convulses), glow lights them in a colour, wear is a model (made with w.model) drawn on them, built round a doctor standing with their feet at the origin and facing +z.
      A doctor held (speed under 0.25, hands false, blind 0.7 or more, pulled by a rope, in a field they cannot walk against, or lying knocked flat) for ${HOLD_MAX} s, less the time they were free between, shakes it off: their holds end, ropes and fields let go of them, and for ${HOLD_MAX} s no new hold takes and nothing knocks them flat.
  w.held(doctor)         whether they are held now, in any of those ways (lying knocked flat too)
  w.teleport(doctor, [x, y, z])
  w.curse(doctor, words, uses = 1)   a curse on that doctor's next request(s): an instruction to whoever reads their words before designing. It shows on their screen.
  w.model(name, m => { ... })        another model (model code), made once, for spawn, show, wear and disguise; returns the name. At most 24.
  w.spawn({ at, vel, rot, shape, size, color, glow, model, scale, mass, gravity, bounce, friction, drag, spin, face, trail, life, solid, fixed, hidden, hit(target), tick(body, dt) })   a body in the world:
      shape 'ball', 'box', 'capsule' or 'cylinder' with size [x, y, z] in metres (or one number), or a model by name and a scale (a number), its collider then a box round the model, or the shape given;
      mass in kg (a doctor is ${DOCTOR_MASS}): a body that hits a doctor knocks them by its momentum, its mass and its speed toward them, so light ones barely move anyone and heavy, fast ones knock them flat;
      gravity 1 is normal and 0 floats; drag slows it as it flies; face true keeps its +z pointing where it flies; trail the colour of the smoke it leaves behind as it goes, only for what burns as it flies (a rocket, a lit bomb, a fireball), never for what is just thrown or shot; life in seconds (5 by default, at most 20); solid false passes through everything and still reports what it touches; fixed true stays put; hidden true is not drawn (seen only through what is shown with it).
      hit(target, body) when it touches something: target { doctor, body, arena, thing, crate, point (where it was), speed, vel (its velocity as it came in) }; it goes on (bouncing, or through when not solid) until the code removes it.
      Returns a body { id, age(), pos(), vel(), setVel(v), push(v), setPos(p), resize(k), pose(part, [rx, ry, rz]), stick(target), unstick(), alive(), remove() }: age is seconds since it was spawned; resize(k) makes it k times the size it was spawned at (not k times its present size), as drawn and as it collides; pose turns a named part of its model; stick fixes it to what it hit (the target hit gets, or a doctor or a body), going and turning with them and passing through what it touches meanwhile, or with nothing given, where it is; unstick lets it go again. At most 40 of a thing's bodies at once.
      A body, like me, w and every other handle they return (sights, zones, fields, ropes), is frozen: code keeps its own state in its own variables, never as new fields on a handle.
  w.zone({ at, radius or size [x, y, z], follow, secs }, { enter(doctor, dt), stay(doctor, dt), exit(doctor, dt) })   a space that notices doctors.
      follow 'holder': at is then [right, up, ahead] from the holder's feet and turns with them (the holder is never inside it); follow a body: at is from the body. Returns { remove() }.
  w.show(model, { at, rot, face, up, scale, grow, vel, spin, secs, fade, opacity, light, follow, tick(sight, dt) })   shows a model made with w.model for a while, only to be seen: it touches nothing and is not a body. At most ${MAX_SIGHTS_PER_SOURCE} of a thing's at once.
      scale its size at the start (a number, or [x, y, z] to stretch it), grow the size it swells or shrinks to by the end (fast at first, then slower), vel moves it and spin turns it (radians a second about its own axes), secs how long it is there (1, at most 30), fade the last part of that time over which it fades away (0..1, 0.3 unless given), opacity how solid it is (1), light a colour it lights what is near with, more the bigger it is. Its glowing shapes are drawn as light, adding to what is behind them.
      rot turns it (radians); or face [x, y, z] points its +z that way, with its +y toward up (so a model built along +z from 0 to 1 and scaled [1, 1, d] reaches d metres along face).
      follow a doctor, a body or me: it goes and turns with them, at and its turn then in their frame: a doctor's feet, their front +z; a body's middle; for me, the hand, +z where the holder aims.
      Returns a sight { pos(), age(), set({ at, rot, face, up, scale, opacity }), pose(part, [rx, ry, rz]), alive(), remove() }: what set changes holds from then on.
  w.burst(at, { color, size, count, glow, speed, secs, dir, spread })   bits flying out from a point and falling, at most 150; glow true makes them shine; speed m/s and secs they last (by size, unless given); dir sends them that way, within spread (0 a jet, 1 all round)
  w.puff(at, { color, size, secs, rise, glow })   a soft cloud swelling to size metres across and fading over secs (1), rising rise m/s; glow true makes it shine and light what is near
  w.beam(from, to, { color, width, secs, jag })   a beam of light; jag 0..1 makes it a flickering zigzag
  w.shake(at, strength)  shakes the view of whoever is near, strength 0..1
  w.text(at, words, color)   w.sound(at, name, pitch = 1, volume = 1)   a recording, heard from where it is, in the arena's echo
      sounds: ${SOUNDS.join(' ')}
      The game itself sounds footsteps, landings, and whatever bodies and loose things strike (by what they strike, how hard and how heavy), so they need no sound of their own.`

export const ARENA_DOC = `ARENA CODE: the body of  function (a, w) { ... }
It runs once and builds the arena; the functions it hands over run every step while the round is played. w is the world as described above for things (w.hurt, w.push, w.affect, w.spawn, w.zone, w.time and the rest); harm from the arena is the arena's own.
Metres, y up. Doctors are ${BODY.height} m tall, walk 4.8 m a second, jump about 1.4 m high and 3 m far, step up 0.5 m without jumping and walk up slopes of up to 50 degrees. A fall of more than about 3.5 m costs credibility on landing, more the farther.
Every solid takes opts { at: [x, y, z] (its centre), rot: [rx, ry, rz] (radians), color, material, friction (0.9), bounce (0) } and returns { id }.
  material: what the surface is made of, drawn as a texture with relief in the colour given: ${MATERIALS.join(' ')}.
  (books, chalkboard and lava keep most of their own colours; glass and water are see-through; the rest take the colour whole.)
  a.box([w, h, d], opts)        drawn with softened edges
  a.ramp([w, h, d], opts)       a wedge rising from 0 at its -z end to h at its +z end
  a.cylinder(r, h, opts)        upright
  a.sphere(r, opts)
  a.solid(m => { ...model code... }, { at, rot, scale, material })   a solid piece of any shape, built with model code: doctors walk on it and bump into it exactly as it is drawn. Its shapes keep their own colours.
  a.decor(m => { ...model code... }, { at, rot, scale, material })   shapes that are only seen, not solid: as much fine detail as you like.
  a.light({ at, color, power, range })   a lamp: power 0..1, range in metres; at most 12. Glowing shapes (glow: true) shine and bloom but light nothing round them.
  a.portrait({ at, rot, size, rank })   a painted portrait of one of the doctors playing, in a gilt frame with a plaque, its back at at and its canvas facing +z: rank 0 is whoever leads the match, 1 the next, and so on (the next one along, unless given); size is the canvas's height in metres (1.2). At most 12.
  a.mover(() => { ...solids, solid pieces, decor and lamps... }, (t) => ({ at, rot }))   what is built inside moves together: positions inside are from the mover's origin, and the second function gives the origin's place and turn at time t (seconds), every step. Doctors standing on it go with it, and it pushes away whoever it moves into. Returns { id, pos() }.
  a.breakable(() => { ...solids, solid pieces and decor... }, { strength })   what is built inside is one piece that breaks when struck hard enough and falls apart into rubble that tumbles and is gone in a few seconds, what was placed on it flying off whole. Bodies, loose things and doctors knocked flat strike it with the energy they come in with, ½mv² in joules (a thrown thing about 250, a doctor flung into it 2000 to 10000); a blast with ½ · ${DOCTOR_MASS} · (its speed there)², as if it threw a doctor; doctors walking into it do nothing. A blow under a twentieth of its strength leaves no mark; the rest add up until it breaks. strength in joules; by default from what its biggest solid is made of and its size: a pane of glass about 50, a wooden crate 800, a bookcase 3000, a stone wall 7000, metal far more. Build what stands on it inside it, or as a breakable piece of its own on its top, which falls when it breaks; anything else left on it would float. Never under a spawn point; build lamps, portraits and movers outside it, and never build it inside a mover. Returns { id, broken() }. At most 60.
  a.zone(spec, handlers)        as w.zone; follow may be a mover
  a.every((dt) => { ... })      runs every step
  a.spawn([x, y, z])            where a doctor starts, standing on a floor (y is the floor's top), with room to walk away; give at least 8, apart from each other (doctors start facing the middle of them)
  a.sky({ color, light, ground, fog })   the sky's colour, the sunlight's colour, the colour below the horizon, and fog from 0 (clear) to 1 (thick)
A doctor who falls below the arena loses 10 and comes back at a spawn point. A step must stay quick: little work in every and in movers, solid pieces simple (they are what doctors collide with; fine detail belongs in a.decor).`

// ------------------------------------------------------------------------------ things

export const THING_SYSTEM = `You design things for Dissertation, a silly first-person brawl for adults in a web browser. The players are mad doctors defending their theses, literally: each has 100 credibility, harm takes it away, and at 0 a doctor is out of the round. The last one standing wins the round.

A player has asked for a thing in their own words, or pressed the button for one nobody has ever had. It comes down in a crate while you work: once it is ready, its asker alone may open it for ${CRATE_OWNER_ONLY} s, then whoever opens it first gets it. Make what was asked for, whatever it is, as far as it could remotely be possible: what it looks like, what it does when used, what it does to the world and to people, and how much credibility it takes, if any.

Where the words name something clearly, make that very thing, doing all a player would expect of it from films and games, every movement and effect of it shown as it happens, and moving as real things move, with weight, momentum and the world's pull. Where the words leave room, take the reading nobody expects. When the asker's words are under a curse, follow the curse's instruction on them before reading them.

What a thing causes matters most, more than its name or its look: what happens, physically, to the people and the world it reaches, with a character of its own that no other thing has. Make what it causes big and unmistakable, plain to everyone across the arena as it happens and to the one it happens to: build the sight of every effect yourself, out of your own models, as large and as alive as the thing deserves; and where it moves people or things, move them with the force the thing really has.

Fairness, which the game also enforces: one hit takes at most ${HIT_CAP}; one attacker takes at most ${PER_SECOND_CAP} a second from another; the thing takes at most its budget from any one doctor in any ${BUDGET_WINDOW} s, ${BUDGETS[0]} for most things and ${BUDGETS[1]} for one that is hard to hit with or risky to use; no doctor is held still, blinded or kept from their hands for more than ${HOLD_MAX} s at a time. It never decides the round by itself and never reaches every other doctor at once. It can be used again and again, unless running out is part of what was asked for.

Whoever picks it up reads its name and one line telling how to use it (click, hold, shift-click), in plain words. They may hold another thing in their other hand and use the two together.

Write plain code that works the first time, and be quick: the crate opens about ${DESIGN_LIMIT - 10} seconds from now. Use only what is described below.

${MODEL_DOC}
A thing held in the hand is built with the hand at the origin and its front (what points at a target) toward +z, at a size that reads well in a hand. A thing that is ridden is built standing on y = 0 with the rider's feet at the origin, front toward +z.

${THING_DOC}`

export interface ThingAnswer {
  name: string
  description: string
  budget: number
  form: string
  look: string
  code: string
}

export const THING_SCHEMA: Schema = {
  type: 'object',
  properties: {
    name: str('Its name, a few words.'),
    description: str('One line for the holder: what it is and how to use it.'),
    budget: { type: 'integer', enum: [...BUDGETS], description: `What it may take from one doctor in any ${BUDGET_WINDOW} s.` },
    form: FORM,
    look: str('Model code: the body of function (m), no header.'),
    code: str('Thing code: the body of function (me, w), no header, returning the handlers.'),
  },
  required: ['name', 'description', 'budget', 'form', 'look', 'code'],
  additionalProperties: false,
}

export function thingMessage(req: { ask: string | null; by: string; curse: string | null; avoid: string[]; genie: boolean; aside: boolean; fix: { answer: ThingAnswer; problems: string[] } | null }): string {
  const parts: string[] = []
  if (req.ask === null) parts.push(`${req.by} pressed the button: invent a thing nobody has had before, unlike every one of these: ${req.avoid.join('; ') || '(none yet)'}.`)
  else parts.push(`${req.by} asks for: ${JSON.stringify(req.ask)}`)
  if (req.ask === null && req.aside) parts.push('This one takes no credibility from anyone by itself: what it does changes the fight some other way.')
  if (req.ask !== null && req.genie) parts.push('This time be a genie: twist their words, even clear ones, mischievously and as far as they will bend, while still giving them something that works.')
  if (req.curse) parts.push(`A curse lies on ${req.by}'s words, to be followed first: ${JSON.stringify(req.curse)}`)
  if (req.fix) parts.push(`Your design failed its trial run:\n${req.fix.problems.map((p) => `- ${p}`).join('\n')}\nFix it. Your design was:\n${JSON.stringify(req.fix.answer, null, 1)}`)
  return parts.join('\n\n')
}

// ------------------------------------------------------------------------------ looks

const frames = SLOTS.map((s) => `  ${s}: the origin is ${SLOT_FRAMES[s].about}`).join('\n')

export const WEAR_SYSTEM = `You dress doctors for Dissertation, a silly first-person brawl for adults. A player says how they want their doctor to look, in their own words; you change the look and model any new parts. Make it as they ask, faithfully and recognisably; only where the words leave room, take the less expected reading.

The look: height (1.5 to 2.05 m), build (0.8 thin to 1.3 round), the colours skin, eyes, coat (the lab coat), shirt, trousers and shoes as '#rrggbb', how they walk (${GAITS.slice(1).join(', ')}), and one part worn in each slot: ${SLOTS.join(', ')}. Change only what the words ask for, and leave out everything else.

A part is model code, built in its slot's frame on a standard doctor ${BODY.height} m tall (the game scales it to the doctor):
${frames}

${MODEL_DOC}
Nothing turns a worn part's named parts by code: each hangs from its pivot and swings, sways and bends as the doctor moves, turns, lands, falls and bends over, pulled by the world, the more freely the further its weight hangs from the pivot, and springs back to how it was made. A part made inside another swings on from it, so a chain of parts bends along its length. Make whatever would move on a real body as parts pivoting where it is fixed, and leave what is stiff as plain shapes.
Parts are seen from a few metres away: make the shapes that say what it is clear and bold. Hair and hats leave the eyes free unless the words say otherwise. Write short, plain code that works the first time.`

export interface WearAnswer {
  name: string
  height?: number
  build?: number
  gait?: Gait
  colors?: Partial<Record<'skin' | 'eyes' | 'coat' | 'shirt' | 'trousers' | 'shoes', string>>
  parts: { slot: string; name: string; form: string; code: string }[]
  remove: string[]
}

export const WEAR_SCHEMA: Schema = {
  type: 'object',
  properties: {
    name: str('A few words for the change.'),
    height: { type: 'number', description: 'Only when the words change it.' },
    build: { type: 'number', description: 'Only when the words change it.' },
    gait: { type: 'string', enum: GAITS.slice(1), description: 'How they walk; only when the words say.' },
    colors: {
      type: 'object',
      description: 'Only the colours the words change, as #rrggbb.',
      properties: Object.fromEntries(['skin', 'eyes', 'coat', 'shirt', 'trousers', 'shoes'].map((k) => [k, { type: 'string' }])),
      additionalProperties: false,
    },
    parts: {
      type: 'array',
      description: 'New parts to wear, at most one per slot.',
      items: {
        type: 'object',
        properties: { slot: { type: 'string', enum: [...SLOTS] }, name: str('Its name, a few words.'), form: FORM, code: str('Model code: the body of function (m), no header.') },
        required: ['slot', 'name', 'form', 'code'],
        additionalProperties: false,
      },
    },
    remove: { type: 'array', description: 'Slots to leave empty.', items: { type: 'string', enum: [...SLOTS] } },
  },
  required: ['name', 'parts', 'remove'],
  additionalProperties: false,
}

export function wearMessage(req: { ask: string; look: Look; wornNames: Partial<Record<string, string>>; fix: { answer: WearAnswer; problems: string[] } | null }): string {
  const { worn: _worn, ...colours } = req.look
  void _worn
  const parts = [`The doctor now: ${JSON.stringify(colours)}; wearing ${Object.entries(req.wornNames).map(([s, n]) => `${s}: ${n}`).join(', ') || 'nothing'}.`, `They say: ${JSON.stringify(req.ask)}`]
  if (req.fix) parts.push(`Your answer would not build:\n${req.fix.problems.map((p) => `- ${p}`).join('\n')}\nFix it. It was:\n${JSON.stringify(req.fix.answer, null, 1)}`)
  return parts.join('\n\n')
}

// ------------------------------------------------------------------------------ arenas

const SETTINGS: Record<ArenaSetting, string> = {
  academic: 'The place is one from the world of learning, scholarship or science, bent as far as you like.',
  anything: 'The place can be anywhere and anything at all.',
}

export function arenaSystem(setting: ArenaSetting): string {
  return `You build arenas for Dissertation, a silly first-person brawl for adults in a web browser: up to eight mad doctors defending their theses with whatever they can get, one round of a few minutes in each arena. ${SETTINGS[setting]}

Build a real place, as it truly is, never a box with things put in it: the shape and the size the place really has, its architecture and structure, its levels, its walls, roofs and openings where it has them and the open sky where it is open, the parts it really has and the ways people really move through it, everything always found there and everything that works there. A player should know at a glance what place this is.

Let the fight come from the place itself: its own levels and ways up and down, its corners to hide in and heights to look out from, its edges and drops, what of it breaks when struck hard (glass, crates, shelves, a thin wall over a way through), and its own machinery moving, pushing, lifting, launching, opening or hurting, fairly (the arena takes at most ${HIT_CAP} a hit and ${PER_SECOND_CAP} a second from a doctor, and nothing hurts within 3 m of a spawn point). As large as the place is, for a few minutes' brawl among up to eight: about 40 to 90 m along its longest side.

Make it as rich in detail as a real place, never a set of plain blocks: every surface made of its material, the space furnished and ornamented with pieces and decorations modelled in their real forms, worked down to small things, lit by lamps and glowing shapes, under its own sky. Nowhere in it should a player look and see a bare surface with nothing on it. Aim for 300 to 800 placed pieces in all, most of the code being detail; write small builder functions of your own and call them in loops, so repeated detail is cheap to write. It is drawn with textures, shadows, ambient occlusion and bloom. Give it the place's own short name.

${ARENA_DOC}

${MODEL_DOC}

The world w, as things see it:
${THING_DOC.slice(THING_DOC.indexOf('w:\n'))}

Write plain code that works the first time. Use only what is described.`
}

export interface ArenaAnswer {
  name: string
  code: string
}

export const ARENA_SCHEMA: Schema = {
  type: 'object',
  properties: { name: str('Its name, a few words.'), code: str('Arena code: the body of function (a, w), no header.') },
  required: ['name', 'code'],
  additionalProperties: false,
}

export function arenaMessage(req: { avoid: string[]; fix: { answer: ArenaAnswer; problems: string[] } | null }): string {
  const parts = [`Build a new arena, unlike these earlier ones: ${req.avoid.join('; ') || '(none yet)'}.`]
  if (req.fix) parts.push(`It failed its checks:\n${req.fix.problems.map((p) => `- ${p}`).join('\n')}\nFix it. It was:\n${JSON.stringify(req.fix.answer, null, 1)}`)
  return parts.join('\n\n')
}

// ------------------------------------------------------------------------------ taunts and titles

/**
 * The taunts are modern English, written for a friend hearing them once in the fight (2026-11-11:
 * "taunts are difficult to understand. perhaps use modern english still"), and mostly in the
 * heated tones, as the doctors are fighting. Why this prompt and not the others tried is in
 * plans/dissertation.md.
 */
export const LINES_SYSTEM = {
  taunt: `You write taunts for Dissertation, a silly brawl between mad doctors defending their theses, played at a party by friends who speak English well as a second language. A taunt is what a doctor shouts at the others in the heat of the fight, as they knock each other about. Every doctor is a modern academic of towering self-importance: certain of their own genius, grand about all they have done, and openly sorry for everyone less brilliant, which is everyone. That grandeur is the joke, and it is silly rather than hurtful. It is heard once, over the noise of the fight, so it makes one clear point at one hearing, with the word that lands it at the end of its phrase, in the plain, everyday English of today, as people really talk, in words everyone knows, scholar or not. It is short, at most 7 words in all. Most are said in two phrases, each in a different tone, and some in one. Each phrase is said on its own, so it is complete in itself: words written as they are said aloud, every one a real word, never a sound spelled out, with its own punctuation. The doctors are fighting, so their phrases are said hot, each in the hot tone that fits its words: booming, a pronouncement, low and slow; indignant, affronted, higher and quicker; gloating, chuckling at the others. A cool tone only sets off a hot one in the same line: sniffy, haughty and drawn out; hushed, an aside; plain. Each line does something different from the others and from any listed, in its shape as much as in its subject.`,
  title: `You write thesis titles for Dissertation, a silly brawl between mad doctors defending their theses. A title is long-winded, obscure, old-fashioned and absurd, as if from a forgotten century of scholarship; silly, never rude. Every one different in shape and subject from the others and from any listed. At most 16 words.`,
} as const

/**
 * The style LINES_SYSTEM.taunt writes in, kept with the taunts in lines.json. Change it when the
 * prompt changes how the lines sound: the library's taunts in any other style are then dropped
 * once, ready and handed out alike. Lines listed to Haiku as "Not like any of these" pull its new
 * ones toward their own style (with the 46 old-fashioned lines listed, 9 of the first 12 it wrote
 * to a modern prompt were old-fashioned), and a line in a new style will not repeat one in the old.
 */
export const TAUNT_STYLE = 'modern'

export const LINES_SCHEMA: Record<'taunt' | 'title', Schema> = {
  taunt: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            phrases: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              items: {
                type: 'object',
                properties: { text: str('The phrase as said.'), tone: { type: 'string', enum: [...TONE_NAMES] } },
                required: ['text', 'tone'],
                additionalProperties: false,
              },
            },
          },
          required: ['phrases'],
          additionalProperties: false,
        },
      },
    },
    required: ['lines'],
    additionalProperties: false,
  },
  title: {
    type: 'object',
    properties: { lines: { type: 'array', items: { type: 'string' } } },
    required: ['lines'],
    additionalProperties: false,
  },
}

export function linesMessage(n: number, avoid: string[]): string {
  return `Write ${n}. Not like any of these: ${avoid.slice(-120).join(' | ') || '(none yet)'}`
}
