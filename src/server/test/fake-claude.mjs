// A stand-in for the Claude Code CLI in tests: reads stream-json user messages from stdin and
// answers each with the events the real CLI prints (stream deltas, then a result with the
// structured output). What it answers is the JSON in the file FAKE_CLAUDE_ANSWER, read on every
// turn. Words in the prompt steer it:
//   HANG          never answers          CRASH        exits mid-turn
//   FAIL_ONCE     the first such turn ends in error_max_structured_output_retries (state in FAKE_CLAUDE_STATE)
//   TEXT_JSON     the answer only as JSON text in fences, no structured output
// Each turn is logged to FAKE_CLAUDE_LOG as a JSON line: { pid, turn, argv, cwd, prompt }.
import fs from 'node:fs'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const arg = (name) => argv[argv.indexOf(name) + 1]
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`)
let turn = 0

out({ type: 'system', subtype: 'init', model: arg('--model'), tools: ['StructuredOutput'] })
process.stderr.write('fake claude ready\n')

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const prompt = JSON.parse(line).message.content
  turn++
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, turn, argv, cwd: process.cwd(), prompt })}\n`)
  if (prompt.includes('HANG')) return
  if (prompt.includes('CRASH')) process.exit(3)
  if (prompt.includes('FAIL_ONCE') && !fs.existsSync(process.env.FAKE_CLAUDE_STATE)) {
    fs.writeFileSync(process.env.FAKE_CLAUDE_STATE, 'failed once')
    return out({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: '' })
  }
  const data = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_ANSWER, 'utf8'))
  const json = JSON.stringify(data)
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'StructuredOutput', input: {} } } })
  for (let i = 0; i < json.length; i += 16) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 16) } } })
  process.stdout.write('not json: the CLI sometimes says other things\n')
  if (prompt.includes('TEXT_JSON')) out({ type: 'result', subtype: 'success', is_error: false, result: `\`\`\`json\n${json}\n\`\`\`` })
  else out({ type: 'result', subtype: 'success', is_error: false, result: json, structured_output: data })
})
