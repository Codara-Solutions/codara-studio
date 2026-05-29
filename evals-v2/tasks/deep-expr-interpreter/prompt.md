Build a small arithmetic **expression-language interpreter** ("calclang") in Node.js (CommonJS, no external dependencies). The interpreter is a classic staged pipeline — **tokenize → parse → evaluate** — so the work has a deep dependency chain: later stages cannot be written before the earlier ones they consume. Every module uses `module.exports`. Keep the public API exactly as specified — hidden tests call these functions directly.

Suggested module layout (you choose the internal token/AST shapes — only the public API and observable behavior are tested):

- Foundation (independent): `src/tokens.js` (token-type constants/helpers), `src/ast.js` (AST node constructors), `src/errors.js` (error helpers), `src/env.js` (variable environment).
- `src/lexer.js` — `tokenize` (uses tokens, errors).
- `src/parser.js` — `parse` (uses tokens, ast, errors).
- `src/builtins.js` — the built-in functions (uses errors).
- `src/evaluator.js` — `evaluate` (uses ast, env, builtins, errors).
- `src/interpreter.js` — `run` (uses lexer, parser, evaluator, env).
- `src/index.js` — re-exports the public API.

## Language

- **Numbers**: integers (`42`) and decimals (`3.5`), parsed as JS numbers.
- **Variables**: identifiers matching `[A-Za-z_][A-Za-z0-9_]*`.
- **Binary operators**, precedence from lowest to highest:
  1. `+` `-` — left-associative
  2. `*` `/` — left-associative
  3. `^` — exponentiation, **right-associative**
- **Unary minus** (`-x`): binds tighter than `* /` but looser than `^`. So `-2 ^ 2` is `-(2 ^ 2)` = `-4`, and `2 * -3` = `-6`.
- **Parentheses** `( )` for grouping.
- **Function calls**: `name(arg1, arg2, ...)`. Built-ins: `sqrt(x)`, `abs(x)`, `floor(x)`, `ceil(x)`, `min(a, b)`, `max(a, b)`, `pow(a, b)`.
- **Assignment**: `x = expr` evaluates `expr`, stores it in the environment under `x`, and returns that value.
- **Statement sequencing**: statements are separated by `;`. A trailing `;` is allowed. `run(src)` returns the value of the **last** statement.
- Whitespace between tokens is insignificant.

### Worked examples (all exact)

- `run("2 + 3 * 4")` → `14`  (precedence)
- `run("(2 + 3) * 4")` → `20`
- `run("10 - 2 - 3")` → `5`  (left-assoc)
- `run("2 ^ 3 ^ 2")` → `512`  (right-assoc: `2 ^ (3 ^ 2)` = `2 ^ 9`)
- `run("2 * 3 ^ 2")` → `18`  (`^` before `*`)
- `run("-2 ^ 2")` → `-4`  (`^` before unary minus)
- `run("2 * -3")` → `-6`
- `run("3.5 * 2")` → `7`,  `run("1 / 4")` → `0.25`
- `run("sqrt(16) + abs(-3)")` → `7`,  `run("max(2, 9) - min(4, 1)")` → `8`,  `run("pow(2, 10)")` → `1024`
- `run("floor(3.9)")` → `3`,  `run("ceil(3.1)")` → `4`
- `run("x = 5; x * 2")` → `10`,  `run("a = 3; b = 4; a*a + b*b")` → `25`

### Errors

`run` (and the stage that detects the problem) must `throw` an `Error` whose `message` **contains** the quoted phrase:

- Division by zero → `"division by zero"`:  `run("1 / 0")`
- Reference to an unset variable → `"undefined variable"` (include the name):  `run("y + 1")`
- Call to an unknown function → `"unknown function"` (include the name):  `run("foo(2)")`
- Malformed input → `"syntax error"`:  `run("2 +")`, `run("(2 + 3")`

## Public API (`src/index.js`)

Re-export so `require("./src/index")` (or `require("./src")`) exposes:

- `tokenize(src)` — source string → token array.
- `parse(tokens)` — token array → AST.
- `evaluate(ast, env)` — AST → number; `env` is optional and defaults to a fresh environment.
- `run(src, env)` — source string → number (the value of the last statement); `env` is optional and defaults to a fresh environment. Must compose the three stages so `evaluate(parse(tokenize(src)))` and `run(src)` agree.
- `createEnv()` — returns a fresh environment object that can be passed to `run`/`evaluate` so variables persist across calls. Example: with `const e = createEnv()`, after `run("n = 7", e)`, `run("n * 2", e)` returns `14`.

Keep everything in `src/`. Do not add dependencies or build tooling.
