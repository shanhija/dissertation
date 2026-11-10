# Sounds

The game's sounds are recordings from CC0 packs on OpenGameArt (public domain: no attribution needed; listed here so they can be found again). They are not kept in git: `npm install` downloads the packs and builds `sounds/`, one folder per sound the game or a made thing plays, with `library.json` listing each sound's variants and its gain in the mix. `npm run sounds` does the same on its own.

- [`sources.json`](sources.json) names every download (`packs`: its page and its file) and, for each sound, its length, its level and the recordings it is made of, in order (`sounds`).
- [`build.ts`](build.ts) downloads the packs into `node_modules/.cache/sounds` (about 284 MB, kept for the next build), unpacks them, and makes each recording into a variant: trimmed of its silence, cut to the sound's length, levelled on its loudest 200 ms, faded at both ends, mono MP3 at 96 kbps. A build is skipped while `sources.json` and the script are unchanged.

| Pack (CC0) | Used for |
|---|---|
| [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) | boing, clang, hammer, hit-metal, hit-wood, keys, knock, smash, squeak, thud |
| [100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx) | boing, boom, bubble, click, clink, gong, page, ring |
| [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | click, hit-stone, shatter, step-water, step-wood, stones, thunder, whoosh |
| [15 vocal male strain/hurt/pain/jump sounds](https://opengameart.org/content/15-vocal-male-strainhurtpainjump-sounds) | ouch |
| [20 Rustles of dry leaves](https://opengameart.org/content/20-rustles-dry-leaves) | rustle |
| [20 Sword Sound Effects (Attacks and Clashes)](https://opengameart.org/content/20-sword-sound-effects-attacks-and-clashes) | blade, clash |
| [25 CC0 bang / firework SFX](https://opengameart.org/content/25-cc0-bang-firework-sfx) | bang, cannon, firework |
| [35 wooden cracks/hits/destructions](https://opengameart.org/content/35-wooden-crackshitsdestructions) | hit-wood, knock, smash |
| [37 hits/punches](https://opengameart.org/content/37-hitspunches) | hit-flesh, punch |
| [40 CC0 water / splash / slime SFX](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | bubble, slime, splash, splat |
| [5 break, crunch impacts](https://opengameart.org/content/5-break-crunch-impacts) | crunch |
| [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | beep, boom, laser, teleport |
| [50 RPG sound effects](https://opengameart.org/content/50-rpg-sound-effects) | blade, book, click, cloth, coins, creak, door, hit-soft, page, squeak, step-wood |
| [60 CC0 Sci-Fi SFX](https://opengameart.org/content/60-cc0-sci-fi-sfx) | scifi |
| [63 Digital sound effects (lasers, phasers, space etc.)](https://opengameart.org/content/63-digital-sound-effects-lasers-phasers-space-etc) | laser, powerup, teleport, zap |
| [68 Workshop Sounds](https://opengameart.org/content/68-workshop-sounds) | drill |
| [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | clang, clink, crunch, hit-glass, hit-metal, hit-soft, hit-stone, land, shatter, smash, thud |
| [8 wet squish, slurp impacts](https://opengameart.org/content/8-wet-squish-slurp-impacts) | splat |
| [80 CC0 creature SFX](https://opengameart.org/content/80-cc0-creature-sfx) | bark, burp, cough, creature, grunt, roar, scream |
| [80 CC0 RPG SFX](https://opengameart.org/content/80-cc0-rpg-sfx) | blade, book, chain, chime, coins, creature, hit-stone, roar, stones |
| [Chunky Explosion](https://opengameart.org/content/chunky-explosion) | boom |
| [Different steps on wood, stone, leaves, gravel and mud](https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud) | step-dirt, step-stone, step-wood |
| [Door Open, Door Close Set](https://opengameart.org/content/door-open-door-close-set) | door |
| [Explosion](https://opengameart.org/content/explosion-0) | boom |
| [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | step-dirt, step-stone |
| [Fireball](https://opengameart.org/content/fireball-1) | boom |
| [Footsteps Leather, Cloth, Armor](https://opengameart.org/content/footsteps-leather-cloth-armor) | step-metal, step-soft |
| [Jump Landing Sound](https://opengameart.org/content/jump-landing-sound) | land |
| [Magic Spell SFX](https://opengameart.org/content/magic-spell-sfx) | magic |
| [Male Grunt/Yelling sounds](https://opengameart.org/content/male-gruntyelling-sounds) | grunt, scream, yell |
| [Metal Interactions](https://opengameart.org/content/metal-interactions) | click |
| [Muffled Distant Explosion](https://opengameart.org/content/muffled-distant-explosion) | boom-far |
| [Steam release sounds](https://opengameart.org/content/steam-release-sounds) | steam |
| [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | whoosh |
| [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) | gunshot, rifle, shotgun, smg |
