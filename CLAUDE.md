# Dissertation: instructions for Claude

Canonical project rules are in **`.cursor/rules/`** (plus root **`.cursorrules`** as a short Cursor pointer). **Read and follow those files** before substantive work; do not rely only on this summary.

**Load these paths** (principles; long examples stay in `docs/`):

- `.cursor/rules/maintain-canonical-rules.mdc`: keeping rules in sync; user corrections and redirects
- `.cursor/rules/coding-style.md`: languages, tooling, engineering defaults
- `.cursor/rules/plans.md`: the one design document (`design.md`) and how it evolves

Dissertation is a first-person party brawl for adults at a LAN party: mad doctors defend their theses, with credibility for health. The game runs on the host's computer inside the Vite dev server (Rapier physics, a WebSocket for the local network only) and the players' browsers only draw. Opus builds each round's arena, makes whatever a player writes into a crate from the sky, and dresses doctors from words; Haiku writes taunts and thesis titles, and Kokoro-82M on the host says the taunts in each doctor's voice. The brief, the decisions and the open work are in `design.md`; how to run and play it is in `README.md`.

- **`src/server/`**: the game server, started by the Vite plugin (`plugin.ts`); the models through the Claude Code CLI (`opus.ts`, `prompts.ts`, `claude.ts`); the doctors' voices (`voice.ts`, speaking in `voice-worker.ts`); the library on disk (`store.ts`).
- **`src/sim/`**: the simulation on Rapier, the API made code calls (`api.ts`), and running made code (`sandbox.ts`, `guard.ts`).
- **`src/scene/`** and **`src/*.tsx`**: what the browser draws and the page around it; **`src/protocol.ts`**: what the server and the browsers say to each other.
- **`src/model/`**: the modelling kit made code builds models with (`kit.ts`) and its recipes as three.js geometry (`mesh.ts`), used on both sides.
- **`library/`**: everything the game made and its log, kept on this computer and out of git. **`fonts/`**: OFL fonts with a README of where they came from. **`sounds/`**: built by `npm install` from CC0 packs and kept out of git; what it is made of and the credits are in **`scripts/sounds/`**. The voice model is fetched by `npm install` into `node_modules/.cache/voice` (**`scripts/voice/`**).

`src/model/`, `src/sim/guard.ts` and `src/server/claude.ts` began in Silly Billy, an earlier game; they are this repo's own now, cut to what Dissertation uses.

Commands run at the root: `npm install` once, `npm run dev` (http on port 3003), `npm run typecheck`, `npm test`.
