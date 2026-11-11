# Coding style

## Engineering defaults

- **Learn from corrections**: When the user overrides your approach or redirects you (implementation, location, tooling, style of answer), persist **repeatable** preferences in the canonical rules or `docs/` as described in [`maintain-canonical-rules.mdc`](./maintain-canonical-rules.mdc), including **small** corrections, not only big design decisions.
- **Discourage backward compatibility and legacy support**: Do not add shims, duplicate code paths, deprecated aliases, or "keep old behavior" branches unless there is an explicit, documented requirement. Prefer **remove and migrate** over **carry forever**.
- **Simplify**: Prefer the smallest change that matches types and architecture.
- **Prevent silent failures**: Design solutions to not have silent failures if not necessary or requested, but raise exceptions when assumptions are not met. Make code specialized and not generalized, having assumptions and accepting exceptions when assumptions are not met. Prefer union/enum types over free strings so the compiler already checks validity. Avoid defensive optional-chaining/`if (x != null)` guards that silently skip logic; access directly so missing values surface immediately.
- **Strict arguments, no optional by default**: Function parameters should be required and non-nullable unless the current code path genuinely has callers that legitimately pass nothing. Don't widen a signature to `arg?: T` just because the only caller "might not" pass it, or to keep tests / scaffolding compiling; a forgotten argument in a future caller then becomes a silent no-op instead of a compile error. Add optionality only when a real call site has nothing to pass (and document why at the call site).
- **Screenshots yes, the user's browser no**: check that the game boots and how it looks with a headless Chromium (Playwright from the terminal, the script kept outside the repo); never drive the user's own browser (no Claude in Chrome). Logic is still proven by `npm run typecheck` and `npm test`; the user has the last look and tunes.
- **Keep scratch runs out of the user's dev server**: a harness, worktree or test run keeps Vite's and vitest's caches out of the repo's `node_modules` (its own `cacheDir`, or a scratch `node_modules` of per-package links), uses its own port, and is stopped by its PID. The user's `npm run dev` on 3003 reads that cache, and a scratch run once broke it.
- **Tests hold on a busy machine**: wait for what is awaited (the server fakes' `settled()`), never a fixed real time, and size a time limit by work measured on the machine running the test.
- **Audience-visible text reads human-written**: no em-dashes, plain sentences.
- **Stop at 95% of the weekly limit**: before Claude's weekly usage limit passes 95%, save the work (everything on disk, the plan and a note of where to resume) and stop; never run past it. Size each batch of agent work so it fits in what is left.

## Stack and tooling

- **Stack**: TypeScript, React 19, Vite, vitest; three.js through react-three-fiber on the page, Rapier for the physics on the server. Pin `react` to the range `@react-three/fiber` accepts (`~19.2.x` for fiber 9.7).
- **The game runs in the dev server**: `src/server/plugin.ts` starts it inside Vite and meets the players' browsers on a WebSocket, which send their input and draw the snapshots that come back. There is no build. Only local addresses may connect.
- **Made code runs only on the server**: guarded (`src/sim/guard.ts`) and in a `node:vm` context of its own (`src/sim/sandbox.ts`). `src/protocol.ts` is types and constants only, so no physics and no made code reach a browser.
- **The server makes the sound of speech**: taunts are said by Kokoro-82M (onnxruntime-node) in a worker thread on the host and sent as MP3; the page relies on no browser speech. Anything that holds a thread for long (onnxruntime does, for each phrase it says) runs off the game's own thread.
- **No state and no credentials in git**: `library/` (what the game made, the lines handed out, the log, with the words friends typed) stays on the computer that runs the game, and a fresh clone starts with an empty one. The models are reached through the Claude Code CLI and its own sign-in; nothing in the repo holds a key, a token or a certificate.
- **Commands** (at the repo root): `npm install` once (it also downloads the sound packs and builds `sounds/`, and fetches the voice into `node_modules/.cache/voice`; `npm run sounds` and `npm run voice` do those alone), `npm run dev` (port 3003, plain http on every address of this computer), `npm run typecheck`, `npm test`; `npx vitest run <path>` for one part's tests; `npm run voice:bench` says fixed lines in every tone and eight voices for the user to compare by ear.
- **Links for the user**: `http://localhost:3003/` on this computer; the dressing room shows the addresses friends join at.

## Code formatting

- Never prefix private class or module members with underscore.
- Prefer larger functions that are concise and complete, instead of splitting to multiple small ones, except when necessary.
- Never duplicate code and strive to remove duplication whenever possible. Couple of lines repeated code in few places is not a big problem, but more than that becomes a problem.
