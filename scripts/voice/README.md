# Voice

The taunts are said on the host's computer by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0), an 82-million-parameter speech model, in the ONNX export from [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) (Apache-2.0). It runs on the CPU through [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node) (MIT), and the words are made into phonemes by [phonemizer](https://www.npmjs.com/package/phonemizer) (Apache-2.0, espeak-ng in WebAssembly). None of it is kept in git: `npm install` fetches the model, its tokenizer and the 13 of its voices the doctors are made of (its English and American men, and Nicole for the hushed tone) into `node_modules/.cache/voice` (about 330 MB). `npm run voice` does the same on its own.

- [`sources.json`](sources.json) pins the revision and names every file with its SHA-256.
- [`fetch.ts`](fetch.ts) downloads what is missing or wrong and checks each file against its hash. A fetch is skipped while `sources.json` and the script are unchanged.

How the game uses it is in `src/server/voice.ts`.
