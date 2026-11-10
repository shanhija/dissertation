/**
 * The guard for made code. The designer writes only a function's body; here it is wrapped in
 * its function (the header the caller gives), parsed with Vite's parser as strict code, and
 * `__g();` goes at the start of every loop body and every function body, so the game can stop
 * code that runs too long (sandbox.ts counts the calls). Nothing is put on a new line: the
 * designer's line N is line N + 1 of the guarded function, whose header is line 1. A syntax
 * error comes back as one line naming the line in the designer's code.
 *
 * Made code runs in the game's own process, so the guard also keeps it to what it needs: its
 * own names, its function's parameters and the plain JavaScript in GLOBALS. Everything else is
 * out of reach: the process and what it can load (process, require, globalThis), code made from
 * text (eval, the Function constructor, import(), WebAssembly), which would run without the
 * guard, the guard itself, and the prototypes of the built-ins. A name that leads there is
 * refused like a syntax error, and a key worked out as the code runs (`o[k]`) goes through
 * `__k` on the header line, which refuses the same keys and names the designer's line of the key.
 */

import { parseAst } from 'vite'

/** The plain JavaScript made code may use besides its own names and its parameters. */
const GLOBALS = new Set([
  'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Date',
  'Error', 'TypeError', 'RangeError', 'Infinity', 'NaN', 'undefined', 'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'console',
])

/** Keys that lead to a constructor (and from there to code made from text) or to a shared prototype, besides every key starting with __ (__proto__, __defineGetter__...). */
const HIDDEN = ['constructor', 'prototype', 'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'defineProperty', 'defineProperties', 'eval', 'Function']
const hidden = (key: string) => key.startsWith('__') || HIDDEN.includes(key)

/**
 * The check of a key worked out as the code runs, put on the header line when the code has such
 * a key: the same keys as `hidden`, and no object or function, whose text could be anything. It
 * uses nothing made code could change: whatever it throws, it throws. Each use passes its line
 * in the designer's code (`o[__k((k), 4)]`), which the error names: the stack would only show
 * the header line, where the check itself is.
 */
const KEY_CHECK =
  "const __k = (k, l) => { if (typeof k === 'object' && k !== null || typeof k === 'function' || typeof k === 'string' && (k[0] === '_' && k[1] === '_' || " +
  HIDDEN.map((h) => `k === '${h}'`).join(' || ') +
  ")) throw new TypeError((typeof k === 'string' ? 'made code cannot use the key ' + k : 'made code cannot use a thing as a key') + ' (line ' + l + ')'); return k };"

export type Guarded = { ok: true; guarded: string } | { ok: false; error: string }

interface AstNode {
  type: string
  start: number
  end: number
}

/** A node with its fields, read by name. */
type Node = AstNode & Record<string, unknown>

const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'])
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as AstNode).type === 'string'

/** The nodes directly under a node, in order. */
function children(node: Node): Node[] {
  const out: Node[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) out.push(...value.filter(isNode))
    else if (isNode(value)) out.push(value)
  }
  return out
}

/** Text to put in at a position. At one position, closers go before openers, inner closers before outer ones and outer openers before inner ones. */
interface Insert {
  at: number
  text: string
  close: boolean
  depth: number
}

/** The designer's line for an offset in the wrapped source: the header is line 0, and the closing line counts as the code's last. */
function lineOf(src: string, at: number): number {
  const line = src.slice(0, at).split('\n').length - 1
  const last = src.split('\n').length - 2
  return Math.max(1, Math.min(last, line))
}

// ------------------------------------------------------------------------------ what made code may reach

/** Names declared in a block or a function, and the scope around it. */
class Scope {
  readonly names = new Set<string>()
  constructor(readonly up: Scope | null) {}

  has(name: string): boolean {
    for (let s: Scope | null = this; s !== null; s = s.up) if (s.names.has(name)) return true
    return false
  }

  add(names: string[]): this {
    for (const n of names) this.names.add(n)
    return this
  }
}

/** The names a declaration's pattern binds. */
function bound(pattern: Node | null): string[] {
  if (pattern === null) return []
  if (pattern.type === 'Identifier') return [pattern.name as string]
  if (pattern.type === 'ObjectPattern') return (pattern.properties as Node[]).flatMap((p) => bound((p.type === 'RestElement' ? p.argument : p.value) as Node))
  if (pattern.type === 'ArrayPattern') return (pattern.elements as (Node | null)[]).flatMap(bound)
  if (pattern.type === 'RestElement') return bound(pattern.argument as Node)
  if (pattern.type === 'AssignmentPattern') return bound(pattern.left as Node)
  return []
}

/** The let, const, class and function declarations directly in these statements. */
function blockNames(statements: Node[]): string[] {
  return statements.flatMap((s) => {
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') return (s.declarations as Node[]).flatMap((d) => bound(d.id as Node))
    if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && isNode(s.id)) return [s.id.name as string]
    return []
  })
}

/** The var declarations anywhere under a node, short of the functions and static blocks inside, which have their own. */
function varNames(node: Node): string[] {
  if (FUNCTIONS.has(node.type) || node.type === 'StaticBlock') return []
  const own = node.type === 'VariableDeclaration' && node.kind === 'var' ? (node.declarations as Node[]).flatMap((d) => bound(d.id as Node)) : []
  return [...own, ...children(node).flatMap(varNames)]
}

/** What an assignment writes to: the pattern's targets. */
function targets(p: Node): Node[] {
  if (p.type === 'ArrayPattern') return (p.elements as (Node | null)[]).flatMap((e) => (e === null ? [] : targets(e)))
  if (p.type === 'ObjectPattern') return (p.properties as Node[]).flatMap((q) => targets((q.type === 'RestElement' ? q.argument : q.value) as Node))
  if (p.type === 'RestElement') return targets(p.argument as Node)
  if (p.type === 'AssignmentPattern') return targets(p.left as Node)
  return [p]
}

class Refused extends Error {
  constructor(
    readonly at: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Walks the wrapped function with its scopes and throws Refused at the first name made code may
 * not use. Returns the keys worked out as the code runs, which `__k` must check.
 */
function reach(fn: Node): Node[] {
  const keys: Node[] = []
  const refuse = (node: AstNode, why: string): never => {
    throw new Refused(node.start, why)
  }
  const isGlobal = (name: string, scope: Scope) => !scope.has(name) && GLOBALS.has(name)

  /** A key written out: `o.key`, `{ key: 1 }`, `o['key']`. */
  const key = (node: Node) => {
    const k = node.type === 'Identifier' ? (node.name as string) : node.type === 'Literal' && typeof node.value === 'string' ? node.value : null
    if (k !== null && hidden(k)) refuse(node, `NotAllowed: .${k}, made code cannot reach constructors or prototypes`)
  }

  /** No built-in may change. */
  const writes = (target: Node, scope: Scope) => {
    for (const t of targets(target)) {
      let root = t
      while (root.type === 'MemberExpression') root = root.object as Node
      if (root.type === 'Identifier' && isGlobal(root.name as string, scope)) refuse(t, `NotAllowed: made code cannot change ${String(root.name)}`)
    }
  }

  /** A function: its parameters, its own name (for an expression), arguments, and the names declared in its body. */
  const func = (node: Node, scope: Scope, top = false) => {
    if (!top && node.type === 'FunctionDeclaration' && isNode(node.id)) walk(node.id, scope)
    const body = node.body as Node
    const inner = new Scope(scope).add((node.params as Node[]).flatMap(bound))
    if (node.type !== 'ArrowFunctionExpression') inner.add(['arguments'])
    if (node.type === 'FunctionExpression' && isNode(node.id)) {
      inner.add([node.id.name as string])
      walk(node.id, inner)
    }
    for (const p of node.params as Node[]) walk(p, inner)
    if (body.type !== 'BlockStatement') return walk(body, inner)
    const statements = body.body as Node[]
    inner.add(varNames(body)).add(blockNames(statements))
    for (const s of statements) walk(s, inner)
  }

  const walk = (node: Node, scope: Scope): void => {
    switch (node.type) {
      case 'Identifier': {
        const name = node.name as string
        if (name.startsWith('__')) refuse(node, `NotAllowed: ${name}, names starting with __ belong to the game`)
        if (!scope.has(name) && !GLOBALS.has(name)) refuse(node, `ReferenceError: ${name} is not defined (made code has its own names, its args and plain JavaScript like Math)`)
        return
      }
      case 'Literal':
        return key(node)
      case 'TemplateElement': {
        const cooked = (node.value as { cooked: string | null }).cooked
        if (cooked !== null && hidden(cooked)) refuse(node, `NotAllowed: .${cooked}, made code cannot reach constructors or prototypes`)
        return
      }
      case 'ImportExpression':
        return refuse(node, 'NotAllowed: import(), made code uses only what it is given')
      case 'MemberExpression': {
        walk(node.object as Node, scope)
        const property = node.property as Node
        if (!node.computed) return key(property)
        if (property.type !== 'Literal') keys.push(property)
        return walk(property, scope)
      }
      case 'ObjectExpression':
      case 'ObjectPattern':
        for (const p of node.properties as Node[]) {
          if (p.type !== 'Property') {
            walk(p, scope)
            continue
          }
          const k = p.key as Node
          // A key worked out as it runs only reads something in a pattern; in an object it names a new key of a new object.
          if (p.computed && node.type === 'ObjectPattern' && k.type !== 'Literal') keys.push(k)
          if (p.computed) walk(k, scope)
          else key(k)
          walk(p.value as Node, scope)
        }
        return
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        const k = node.key as Node
        if (node.computed) walk(k, scope)
        else if (node.kind !== 'constructor') key(k)
        if (isNode(node.value)) walk(node.value, scope)
        return
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (isNode(node.superClass)) walk(node.superClass, scope)
        const inner = new Scope(scope)
        if (isNode(node.id)) {
          inner.add([node.id.name as string])
          walk(node.id, inner)
        }
        return walk(node.body as Node, inner)
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return func(node, scope)
      case 'BlockStatement': {
        const statements = node.body as Node[]
        const inner = new Scope(scope).add(blockNames(statements))
        for (const s of statements) walk(s, inner)
        return
      }
      case 'StaticBlock': {
        const statements = node.body as Node[]
        const inner = new Scope(scope).add(statements.flatMap(varNames)).add(blockNames(statements))
        for (const s of statements) walk(s, inner)
        return
      }
      case 'SwitchStatement': {
        walk(node.discriminant as Node, scope)
        const cases = node.cases as Node[]
        const inner = new Scope(scope).add(blockNames(cases.flatMap((c) => c.consequent as Node[])))
        for (const c of cases) walk(c, inner)
        return
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const head = (node.type === 'ForStatement' ? node.init : node.left) as Node | null
        const inner = new Scope(scope)
        if (head?.type === 'VariableDeclaration' && head.kind !== 'var') inner.add((head.declarations as Node[]).flatMap((d) => bound(d.id as Node)))
        else if (head !== null && node.type !== 'ForStatement') writes(head, scope)
        for (const c of children(node)) walk(c, inner)
        return
      }
      case 'CatchClause': {
        const inner = new Scope(scope).add(bound((node.param as Node | null) ?? null))
        for (const c of children(node)) walk(c, inner)
        return
      }
      case 'AssignmentExpression':
        writes(node.left as Node, scope)
        break
      case 'UpdateExpression':
        writes(node.argument as Node, scope)
        break
      case 'UnaryExpression':
        if (node.operator === 'delete') writes(node.argument as Node, scope)
        break
      case 'LabeledStatement':
        return walk(node.body as Node, scope)
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
        return
    }
    for (const c of children(node)) walk(c, scope)
  }

  func(fn, new Scope(null), true)
  return keys
}

/**
 * Wraps the body in the function whose header is given (`function __thing(me, w) {`) and guards
 * it: the function's whole text, or the syntax error (or the name it may not use) with the
 * designer's line. The header's parameters are the only names the body gets besides its own and
 * GLOBALS.
 */
export function guardBody(head: string, code: string): Guarded {
  const src = `${head}\n${code}\n}`
  let program: { body: Node[] }
  try {
    program = parseAst(src, { sourceType: 'module', showSemanticErrors: true }) as unknown as { body: Node[] }
  } catch (err) {
    const pos = (err as { pos?: unknown }).pos
    if (typeof pos !== 'number') throw err
    const message = String((err as Error).message).split('\n')[1] ?? 'Unexpected token'
    return { ok: false, error: `SyntaxError: ${message} (line ${lineOf(src, pos)})` }
  }
  const fn = program.body[0]!
  if (program.body.length !== 1) return { ok: false, error: `SyntaxError: an extra } ends the function early (line ${lineOf(src, fn.end - 1)})` }

  let keys: Node[]
  try {
    keys = reach(fn)
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    return { ok: false, error: `${err.message} (line ${lineOf(src, err.at)})` }
  }

  const inserts: Insert[] = []
  const depthOf = new Map<Node, number>()
  const visit = (node: Node, depth: number) => {
    depthOf.set(node, depth)
    if (LOOPS.has(node.type) || FUNCTIONS.has(node.type)) {
      const body = (node as Node & { body: Node }).body
      if (body.type === 'BlockStatement') inserts.push({ at: body.start + 1, text: '__g();', close: false, depth })
      else if (LOOPS.has(node.type)) inserts.push({ at: body.start, text: '{__g();', close: false, depth }, { at: body.end, text: '}', close: true, depth })
      else inserts.push({ at: body.start, text: '(__g(), (', close: false, depth }, { at: body.end, text: '))', close: true, depth })
    }
    for (const child of children(node)) visit(child, depth + 1)
  }
  visit(fn, 0)
  // A key's check goes round whatever the guard put into the key itself, so it counts as half a level further out.
  // The key goes in parentheses of its own: a comma in it (`o[(x, y)]`, whose parentheses the key's range leaves out) stays one argument.
  for (const k of keys) {
    const depth = depthOf.get(k)! - 0.5
    inserts.push({ at: k.start, text: '__k((', close: false, depth }, { at: k.end, text: `), ${lineOf(src, k.start)})`, close: true, depth })
  }
  // The check itself goes on the header line, after the function's own guard call.
  if (keys.length > 0) inserts.push({ at: (fn.body as Node).start + 1, text: KEY_CHECK, close: false, depth: 0.5 })
  inserts.sort((a, b) => a.at - b.at || Number(b.close) - Number(a.close) || (a.close ? b.depth - a.depth : a.depth - b.depth))

  let out = ''
  let from = 0
  for (const ins of inserts) {
    out += src.slice(from, ins.at) + ins.text
    from = ins.at
  }
  return { ok: true, guarded: out + src.slice(from) }
}
