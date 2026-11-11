# Voice

The taunts are said on the host's computer by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0), an 82-million-parameter speech model, in the ONNX export from [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) (Apache-2.0). It runs on the CPU through [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node) (MIT), and the words are made into phonemes by [phonemizer](https://www.npmjs.com/package/phonemizer) (Apache-2.0, espeak-ng in WebAssembly). None of it is kept in git: `npm install` fetches the model, its tokenizer and 27 of its 28 English voices (all but Adam, whom its makers grade F) into `node_modules/.cache/voice` (about 340 MB). `npm run voice` does the same on its own.

- [`sources.json`](sources.json) pins the revision and names every file with its SHA-256.
- [`fetch.ts`](fetch.ts) downloads what is missing or wrong and checks each file against its hash. A fetch is skipped while `sources.json` and the script are unchanged.

- [`bench.ts`](bench.ts) (`npm run voice:bench`) is a listening bench: it says three fixed lines as written and in each of the six tones, in four men's and four women's voices, into `node_modules/.cache/voice-bench/`, and writes an `index.html` there that plays every variant said so far side by side, with the recipe on each button. `--whole` makes a variant to compare (each line in one Kokoro call, in its first tone); `--name` names one. Tune `TONES`, `PAUSE` and the ranges in `speakerOf` (`src/server/voice.ts`), say them again, and listen.

How the game uses it is in `src/server/voice.ts`.
