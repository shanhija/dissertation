# Dissertation

A first-person party brawl for a LAN party, where mad doctors defend their theses and Opus makes whatever the players ask for. One computer, the host, runs the game; everyone plays in a browser on the same network.

## 1. Requirements

**On the host's computer**

- **Node.js 22.18 or newer**, with npm.
- **The Claude Code CLI, signed in to a Claude subscription.** The game finds it through `CLAUDE_BIN`, the `PATH`, the Claude desktop app or the VS Code extension. Without it the game still plays, but only in its own hall with its own four things, and makes nothing new.
- **About 1.5 GB of disk** for the packages, the sounds and the voice.
- **The internet**, during installation for the downloads and while playing for Claude.
- **Port 3003 open** to the local network, so friends can join.

Made and tested on Linux.

**On each player's computer**

- A recent desktop browser (the game draws with WebGL 2), a keyboard and a mouse.
- The same local network as the host.

## 2. Installation

Once, on the host's computer:

```
git clone https://github.com/shanhija/dissertation.git
cd dissertation
npm install
```

`npm install` also downloads the CC0 sound packs (about 284 MB) and builds `sounds/` from them, and fetches the voice, Kokoro-82M (about 340 MB), into `node_modules/.cache/voice`. If either download fails, run `npm run sounds` or `npm run voice` later.

If Claude Code is not signed in yet, run `claude` once and log in.

## 3. Startup

On the host's computer, in the `dissertation` folder:

```
npm run dev
```

- **The host** opens http://localhost:3003/.
- **Friends** open `http://<the host's address>:3003/`. The dressing room shows the addresses to use, and so does the terminal.
- Only computers on the local network can connect. It is plain http and there is no build: the game runs inside this dev server.
- Ctrl+C stops it. Everything the game made stays in `library/` for next time.

## What it is

A first-person party brawl for adults, for a LAN party. The players are mad doctors defending their theses, literally: credibility is the health bar, and a doctor at 0 is out of the round. Nothing comes from a weapon stand. A player stops, writes what they want, and a crate comes in beside them while Opus designs it; whoever opens the crate first gets it. Opus builds every round's arena, dresses the doctors from words in the dressing room, and keeps everything it ever made. Haiku writes the taunts and thesis titles, and no line is ever said twice. Kokoro, a small speech model on the host's computer, says every taunt in the doctor's own voice and a tone of the moment.

The brief is [`design.md`](design.md); the decisions and what is still open are in [`plans/dissertation.md`](plans/dissertation.md).

## How it works

- **The game runs on the host's computer**, inside the dev server: the physics (Rapier), the bots, the rounds and every bit of code Opus writes. The players' browsers send their keys and mouse 60 times a second and draw the snapshots that come back. Only local addresses may connect.
- **Opus writes code.** A thing is a model (shapes) and a few handlers (use, hold, release, alt, tick, picked, dropped, thrown) against the game's API: bodies, rays, harm, pushes, blasts, fields, ropes and springs, knocking flat, effects on a doctor, sights, zones, curses, riding, disguises, sounds. An arena is code that builds solids, movers, breakable pieces, zones and spawn points. Code is guarded (`src/sim/guard.ts`) and run in a `node:vm` context of its own with a loop and time budget.
- **What is asked for works as it should.** Clear words make the very thing, doing what a player expects of it from films and games and moving with real weight in the world's pull (20 m/s²); one typed request in four the game has Opus twist like a genie instead. Bodies fly, bounce, grow, open, point along their flight, trail smoke when they burn and stick where they hit; an effect can hold a doctor where they stand, bind their hands, blind them in a colour, make them tremble or convulse, glow, or wear a model (a net over them); fire and smoke billow and light what is near, blasts shake the view, beams can crackle.
- **What a thing causes comes first, and big** ("what they cause is more important. and the cause should be visually bigger and more clear"). Opus models the sight of each effect itself: any model shown for a while, swelling or shrinking, turning, drifting, fading, stretched between two points, following a doctor, a body or the thing, lighting the room. And it moves people with real force: blasts that throw everything outward (walls shelter what is behind them) and break what of the arena can break, fields that pull, swirl, lift or blow, ropes and springs that drag, hang or reel in, knocking a doctor flat on purpose, and heavy bodies that knock doctors by their own momentum. Whoever is hit sees their view flash red at its edges.
- **Every design is tried before it is used.** A thing is played for a few seconds in the game's own hall (used, held, thrown); an arena is built, stood on and walked from every spawn point. A design that fails goes back to the model with what went wrong, once for a thing and twice for an arena.
- **Doctors move like people, big, and each in their own way.** They have knees, elbows, wrists, ankles, a waist and a neck, and every movement is made large, as in a cartoon: strides, the hips turning to where they go while the chest keeps to the aim, a tuck in a jump and a deep squash on landing, flinching, struggling when held, shaking under an effect. They walk at an old academic's pace (4.8 m/s), and each has a gait: steady, with a limp, hunched, shuffling, waddling, pompous or doddery (chosen in the dressing room, said in words, or left to chance), which changes only how they move, never how fast or how big a target they are. The less credibility they have left, the more they bow under stress and doubt: hunched, shoulders slumped, the head hanging, steps shorter, trembling near the end. The coat below the waist hangs in four panels that swing and flare with every start, stop, turn and fall, pushed by the legs, each bending below the pockets as its hem trails. What is worn moves too: every part Opus models as a part of its own (a cape, a tassel, a ponytail, a chain) hangs from where it is fixed and swings, sways and bends with the doctor's moves, falls toward the ground when they lie down, and never swings into their body; a hanging part is limp, one sticking out or up springs back. The head lags the body; the arms follow through. Each hand holds what is in it where the game puts it (a long thing in both hands when the other is free), swaying with the stride, lagging a turn and kicking back on use, before one's own eyes too. Using, shoving, throwing, picking up and taunting each have a gesture, and a doctor who gets up after a fall stays dazed a moment, stars circling their head.
- **Ragdolls, the same for everyone.** A doctor knocked hard (11.5 m/s or more, as a blast does; a shove only pushes) or dismissed becomes a ragdoll in the game itself: pelvis, chest, head, arms and legs of Rapier bodies, the waist and the neck sprung so the chest folds and the head lolls, the other joints bending only the ways they bend. It flies flailing (arms windmilling, legs pedalling, the coat fluttering), goes limp as it comes down, and rolls; things that hit it hit the doctor, a knock throws it again, and it drops what it held. A doctor still in gets up where it settles (within 3.5 s), and cannot be knocked flat again for 1.5 s; one who is out lies 7 s and sinks through the floor. While down, the player's own camera pulls back to watch their body.
- **One look for everything: an old, dusty, illustrated book** (begun from A Gentlemen's Dispute's painterly pipeline). Whatever made a model (the game, Opus, a player), the page draws it the same way: fine paper grain in relief that catches the light, a slow mottle with foxed spots, dust settled in patches on what faces up, engraved hatching where the light falls off (crossed in the dark), the light in three soft bands, a matte finish, colours pulled into an old print's range (no pure black or white, the inks faded; glowing colour keeps more). Smoke, dust and fire are dabs of a flat brush, sparks are short strokes along their flight, and one grade finishes every frame in every arena: warm highlights, cool shadows, a soft curve, darker corners and the weave of a canvas.
- **The page around the game is set like the same book.** Whatever is read or chosen is a page: paper with a printer's double rule, ink, headings in IM Fell English (cut for Oxford's press in the 1670s), text in EB Garamond, both served with the game (`fonts/`, OFL). The dressing room is an open book over the robing room: the committee on the left page, your dossier on the right, and the doctor turning between them as large as the gap allows, over a brass plaque with their name; Ready is in oxblood leather at the foot. The pause card (with every key on a keycap), the request, the standings, the options and the waiting screen are pages too; what stays over the game (credibility, the hands, the feed, the patience, subtitles) is on dark plates with a gilt rule. Buttons and type are large.
- **The doctors' portraits hang in the arenas.** Each doctor as they look now, head and shoulders, painted (the picture falls into flat dabs of colour, as oils do) in a gilt frame with a brass plaque; whoever leads the match hangs largest. Opus places them where its arena has room (`a.portrait`); the game's own hall has seven over its gallery and between its columns.
- **Sounds are recorded and placed in the room.** Every sound is a recording (CC0 packs from OpenGameArt, downloaded and built by `npm install`; `scripts/sounds/README.md` lists them), several of each played at a slightly different pitch, so no two shots or footsteps are alike. Each is placed in 3D (left, right, behind), gets duller with distance, is muffled through walls, and rings in the arena's own echo, worked out from its size, what it is made of and how much sky is open over it. The game makes its own sounds from what happens: footsteps by the floor's material and the doctor's gait (a limp is heard), landings, a body hitting the ground, whatever things strike (wood, stone, metal, glass, water or a doctor, by how hard and how heavy), a cry when hurt and a yell when dismissed, explosions with a rumble that carries and a muffled boom far off. Made things choose from some sixty recorded sounds by name.
- **Arenas are drawn in detail.** Every solid is made of a material (planks, stone, brick, marble, books, chalkboard, brass, glass, water, lava and more), painted in the page as a texture with relief, no image files. Arenas also have solid pieces of any shape built with the modelling kit, decorations and lamps. The page merges it all into one mesh per material, then adds environment reflections, shadows fitted to the arena, ambient occlusion, bloom, a sky with clouds and dust in the light.
- **The engine is the referee.** One hit takes at most 10. One thing takes at most its budget from a player in any 20 s (10, or 20 for one that is hard to hit or risky), and then it may take again; things can be used again and again unless running out is what was asked for. One attacker takes at most 20 a second from another. No thing reaches every other player at once. Nobody is held still, blinded, kept from their hands, or pulled by a rope or a field more than 5 s at a time: then they shake free, ropes and fields let go, and no new hold takes for 2 s. A fall of more than about 3.5 m costs credibility on landing (put down to whoever hurt the doctor in the last 3 s), and a fall out of the arena costs 10. A thing whose code keeps failing fizzles away.

## How to play

| Do | What happens |
|---|---|
| Open the page | The dressing room: your doctor on a stand. Give a name (needed); leave the thesis empty and the committee writes one. |
| Write how you look, "Make it" | Opus changes your colours, sizes and walk and models new parts (hair, hats, glasses, capes, shoes) in 10 to 30 s. Every part made goes into everyone's wardrobe. Height, build and the walk can be set by hand too; the doctor on the stand walks on the spot so the walk shows. |
| Ready | When everyone is ready (bots always are), the arena appears and the round starts 5 s later; 60 s after the first is ready it starts anyway. If Opus's new arena is not done, a kept one is played and the new one comes next round; a bar in the dressing room shows how far along it is. |
| WASD, mouse, Space | Move, look, jump. |
| Left button, right button | A thing in each hand: the left button uses what is in the left hand, the right button what is in the right, so one can hold someone and the other hit them. An empty hand shoves: a push and 3. |
| Shift + click | That hand's thing's other use. |
| E, Q, F | Pick up a thing or open a ready crate (into the left hand if it is empty, else the right; with both full the left hand's drops); throw what is in the left hand, or in the right (a thrown thing hits for 6). |
| T (or Enter), write, Enter | You stop and write while everyone else goes on. A crate comes in near you with your name on it, first a blue drawing in light that turns solid from the bottom up, always on floor you can walk to (indoors too); it opens when Opus is done, within 30 s (else it holds a thing from the archive). Then 15 s before the next. |
| R | A thing nobody has ever had. |
| V | A taunt in your doctor's own voice, heard by everyone within 30 m from where you stand (louder nearer, following you as you go) and shown on screen as a subtitle. The host's computer says it, so every browser hears the same thing. Each doctor is an old British orator, a man or a woman, with a voice of their own (the same every game for the same browser), the melody swooping high and low, and says each taunt in a tone: plain, booming, indignant, gloating, hushed or sniffy, most often the one they are given to. |
| Tab | The scores. |
| Arrow keys | Turn and look, for a touchpad. |
| O, or Options (the pause card after Esc, the dressing room's top right) | The options screen, at any time (O or Esc closes it). Its second tab, Lighting and look, sits at the side with the picture clear behind it (click into the picture to walk about, Esc to come back): exposure, ambient, reflections, the sun's strength, height, direction and warmth, the arena's lamps and their reach, light from effects, glow, ambient occlusion and bloom strength, and the book's light bands, hatching and its size, dust, paper grain, matte, rim light, colour, warmth, contrast, dark corners and the page; "Copy values" gives them to make the game's own. Controls: mouse sensitivity, invert mouse, field of view. Display: fullscreen or windowed, the resolution drawn (a share of the screen's own pixels), sharpening, a frame counter. Graphics: a preset (high, medium, low) or shadows (fine, soft, off), antialiasing (off, FXAA, SMAA, MSAA 2×, 4× or 8×), ambient occlusion, bloom, light from effects and dust one by one. Sound: volume, spoken taunts. Every change takes at once and is kept in the browser. |

The last doctor standing wins the round ("Thesis accepted"); the first to 5 rounds takes the doctorate. After 5 minutes the committee loses patience and everyone still in loses 2 a second.

The chair (the first player in the room) sets the number of bots and whether arenas are academic places or anything at all, and can end a round.

A page that reloads or a network that blinks in a round costs nothing: the doctor stands still for 20 s, and whoever comes back in time plays on.

## Settings

| Setting | What it does |
|---|---|
| `DISSERTATION_LIBRARY` | A library folder instead of `library/`. |
| `CLAUDE_BIN` | The Claude Code CLI to run. |

The library stays on the computer that runs the game, out of git (a fresh clone starts empty): `things/`, `wear/` and `arenas/` (one JSON file each, with the code and who asked for it in which words), `lines.json` (every taunt and title handed out, and the ones ready), and `log.jsonl` (every request, which model, how long, what went wrong and the failing code). A player's profile (name, title, look) is kept in their own browser.

## Development

```
npm run typecheck
npm test         # the sim, the arena and thing trials, the game server against fake models
```

## License

The code is [MIT](LICENSE). The sounds are CC0 and the fonts are under the SIL Open Font License: `scripts/sounds/README.md` and `fonts/README.md` say where each came from. The voice, Kokoro-82M and its voices, is Apache-2.0: `scripts/voice/README.md`.
