// Gate-by-default property test for the whole main-process IPC surface.
//
//   node scripts/test-ipc-gate-default.cjs
//
// The privileged-IPC surface is gated by DEFAULT: every ipcMain.handle in
// registerIpc is registered through the local `handle()` wrapper (src/main/
// ipc.ts), which runs requireTrustedSender before the listener, and every
// ipcMain.on registration in the main process lets the sender gate DECIDE
// whether its body runs. This test fails the build if:
//
//   * a raw `ipcMain.handle(...)` / `ipcMain.handleOnce(...)` registration
//     appears anywhere other than the two gated wrapper internals in ipc.ts
//     (i.e. a privileged invoke channel that bypassed the gate), OR
//   * an `ipcMain.on(...)` / `.once` / `.addListener` registration in ANY
//     bundled main-process file does not GUARD its body on the gate's result,
//     or is not listed in ON_OPT_OUT, OR
//   * `ipcMain` is used in any way this scanner cannot follow.
//
// It is a source/registration-level check (not runtime). The runtime forgery
// regression lives in scripts/test-trusted-sender.cjs.
//
// ── Why the TypeScript AST, not a regex ──────────────────────────────────────
// The previous version keyed off the literal contiguous text `ipcMain.` + a
// method name. An adversarial review landed four registrations that were live at
// runtime and invisible to it: `ipcMain\n.handle(…)` (whitespace before the
// dot), `const im = ipcMain; im.handle(…)` (alias), `ipcMain["handle"](…)`
// (bracket notation), and `ipcMain./* x */handle(…)` (interposed comment). It
// also accepted a body that CALLED the gate and threw the answer away:
//
//     ipcMain.on("evil", (e) => { isTrustedOnSender(e, "evil"); doPrivileged(); })
//
// So the scan now parses with the TypeScript compiler (already a dependency;
// scripts/test-declared-deps.cjs uses it for the same reason). Formatting,
// comments and bracket notation stop mattering, aliases are followed, and the
// gate check became a real control-flow question ("does the gate's result decide
// whether the body runs?") instead of token presence.
//
// The scanner is FAIL-CLOSED about `ipcMain` itself: every reference to it must
// be one of a registration call, an allowlisted non-registration method
// (removeHandler and friends), a simple local alias binding, or a type
// position. Anything else (capturing `ipcMain.handle` into a variable,
// destructuring it, passing it to a function, re-exporting it) FAILS with
// "cannot follow", because a scanner that silently ignores what it does not
// understand is exactly how the four evasions above got in.
//
// KNOWN, DELIBERATE GAP: this is a static scan of source text, so a genuinely
// dynamic reach for the object (`require("electron")["ipc" + "Main"]`,
// reflection over module namespaces, `eval`) is out of reach for it. Closing
// that would take a type-checker-backed program analysis, which is not worth the
// build cost for a threat model where the attacker is a future commit to this
// repo rather than injected code: any of those spellings is glaring in review,
// and the runtime gate in main-window-trust.ts is what actually stops a hostile
// sender. This scanner's job is to make a plausible ACCIDENT (a new channel
// registered the raw way) impossible to land, and to make a deliberate evasion
// have to look like one.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ts = require(path.join(ROOT, "node_modules", "typescript"));

const MAIN_DIR = path.join(ROOT, "src", "main");
const IPC = path.join(MAIN_DIR, "ipc.ts");
const GATE = path.join(MAIN_DIR, "main-window-trust.ts");

// Every source directory that is BUNDLED INTO THE MAIN PROCESS. The main bundle
// is rolled up from src/main/index.ts (electron.vite.config.ts), and src/main
// imports src/shared through the `@shared` alias (fs-sandbox.ts,
// agent-runtimes.ts, model-prices.ts, …). A registration parked in src/shared
// and pulled in by a main-process import would run in the main process with the
// full privileged surface, so scanning src/main alone left a blind spot.
// src/renderer and src/preload are separate bundles in renderer processes where
// `ipcMain` does not exist, so they are deliberately out of scope.
const SCANNED_DIRS = [path.join(ROOT, "src", "main"), path.join(ROOT, "src", "shared")];

// Event-style ipcMain.on registrations that are intentionally ungated. Each
// entry is keyed "<basename>:<channelLiteralOrSnippet>" and must be justified
// at its call site. Empty today: every ipcMain.on in the main process gates its
// sender.
const ON_OPT_OUT = new Set([]);

// Invoke channels registered through the explicit ungated opt-out wrapper
// handleOpen(...) in ipc.ts. Each must be justified at its call site. Empty
// today: no channel legitimately accepts a non-main-window sender.
const OPT_OUT = new Set([]);

// Listener-registering members of ipcMain. Reaching any of these means a
// channel just became live.
const REGISTER_METHODS = new Set([
  "handle",
  "handleOnce",
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);
const INVOKE_METHODS = new Set(["handle", "handleOnce"]);

// Members that only ever REMOVE or introspect listeners. They cannot open a
// channel, so they are allowed anywhere.
const SAFE_METHODS = new Set([
  "removeHandler",
  "removeListener",
  "removeAllListeners",
  "off",
  "listenerCount",
  "listeners",
  "rawListeners",
  "eventNames",
  "setMaxListeners",
  "getMaxListeners",
]);

// The gate functions from src/main/main-window-trust.ts, by what a TRUTHY
// result means about the sender.
const GATE_TRUTHY_IS_TRUSTED = new Set(["isTrustedOnSender"]);
const GATE_TRUTHY_IS_UNTRUSTED = new Set(["untrustedSenderReason"]);
// Throws when the sender is untrusted, so calling it IS the guard.
const GATE_THROWS = new Set(["requireTrustedSender"]);
const ALL_GATE_FNS = new Set([
  ...GATE_TRUTHY_IS_TRUSTED,
  ...GATE_TRUTHY_IS_UNTRUSTED,
  ...GATE_THROWS,
]);

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.log("FAIL " + msg);
  } else {
    console.log("PASS " + msg);
  }
};

// ── AST helpers ──────────────────────────────────────────────────────────────

function parse(file) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
}

function sourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function unwrap(node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) {
    n = n.expression;
  }
  return n;
}

// A reference sitting in a type annotation (`Parameters<typeof ipcMain.handle>`)
// emits nothing at runtime, so it is not a use of the object.
function isInTypePosition(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isTypeQueryNode(p) || ts.isQualifiedName(p)) return true;
  }
  return false;
}

// The name of the member being accessed off `expr`, for both `a.b` and `a["b"]`.
// Returns null when the key is computed (`a[k]`), which the scanner treats as
// unfollowable rather than ignorable.
function accessedMemberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const arg = unwrap(node.argumentExpression);
    if (arg && ts.isStringLiteralLike(arg)) return arg.text;
    return null;
  }
  return null;
}

// The callee identifier name of a call, if it is a plain `name(...)` call.
function calleeName(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = unwrap(node.expression);
  return callee && ts.isIdentifier(callee) ? callee.text : null;
}

function hasExportModifier(node) {
  return (node.modifiers || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function containsNode(root, predicate) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

// Best-effort channel label for messages.
function channelLabel(call) {
  const arg = call.arguments[0];
  if (!arg) return "<no-args>";
  if (ts.isStringLiteralLike(arg)) return arg.text;
  return arg.getText().replace(/\s+/g, " ").slice(0, 48);
}

function where(node) {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${path.basename(sf.fileName)}:${line + 1}`;
}

// ── Finding every ipcMain reference in a file ────────────────────────────────
// Seeds from the electron import, then reaches a fixpoint over local aliases
// (`const im = ipcMain; const im2 = im;`) so an alias chain is followed rather
// than stepped around.
function ipcMainBindings(sf) {
  const names = new Set(); // identifiers whose value IS ipcMain
  const namespaces = new Set(); // identifiers bound to the whole electron module
  const problems = []; // uses the scanner refuses to accept

  const importsFromElectron = (node) =>
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "electron";

  const visitImports = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      const fromElectron = importsFromElectron(node);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        if (fromElectron && !clause.isTypeOnly) namespaces.add(clause.namedBindings.name.text);
      } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const imported = (el.propertyName || el.name).text;
          if (imported !== "ipcMain") continue;
          if (clause.isTypeOnly || el.isTypeOnly) continue;
          if (!fromElectron) {
            // A re-export shim would let a registration reach ipcMain by a name
            // this scanner never seeds from. Refuse it outright.
            problems.push(
              `${where(el)}: \`ipcMain\` imported from "${node.moduleSpecifier.text}", not "electron"; the gate scanner only follows the direct electron import`,
            );
            continue;
          }
          names.add(el.name.text);
        }
      }
    }
    // `export { ipcMain } from "electron"` / `export { im }` re-exports move the
    // object into another module's namespace, out of this file's analysis.
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const local = (el.propertyName || el.name).text;
        if (local === "ipcMain" || names.has(local)) {
          problems.push(
            `${where(el)}: \`${local}\` (ipcMain) is re-exported; the gate scanner cannot follow it into another module`,
          );
        }
      }
    }
    // `const { ipcMain } = require("electron")` / `const electron = require("electron")`.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      const isElectronRequire =
        ts.isCallExpression(init) &&
        calleeName(init) === "require" &&
        init.arguments.length === 1 &&
        ts.isStringLiteralLike(init.arguments[0]) &&
        init.arguments[0].text === "electron";
      if (isElectronRequire) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const key = el.propertyName ? el.propertyName.getText() : el.name.getText();
            if (key === "ipcMain" && ts.isIdentifier(el.name)) names.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(sf);

  // An expression that evaluates to ipcMain: a seeded identifier, or
  // `<electronNamespace>.ipcMain`.
  const isIpcMainExpr = (expr) => {
    const e = unwrap(expr);
    if (!e) return false;
    if (ts.isIdentifier(e)) return names.has(e.text);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const base = unwrap(e.expression);
      return (
        base && ts.isIdentifier(base) && namespaces.has(base.text) && accessedMemberName(e) === "ipcMain"
      );
    }
    return false;
  };

  // Fixpoint over `const alias = <ipcMainExpr>`.
  const aliasDecls = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.name) &&
        !names.has(node.name.text) &&
        isIpcMainExpr(node.initializer)
      ) {
        names.add(node.name.text);
        aliasDecls.add(node);
        changed = true;
        const stmt = node.parent && node.parent.parent;
        if (stmt && ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
          problems.push(
            `${where(node)}: \`${node.name.text}\` aliases ipcMain and is exported; the gate scanner cannot follow it into another module`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { names, namespaces, aliasDecls, isIpcMainExpr, problems };
}

// Classify every runtime reference to ipcMain in the file. Returns the
// registration call sites, plus a `problems` list of references the scanner
// cannot vouch for (which are hard failures).
function scanFile(sf) {
  const { names, namespaces, aliasDecls, isIpcMainExpr, problems } = ipcMainBindings(sf);
  const registrations = [];
  if (names.size === 0 && namespaces.size === 0) return { registrations, problems };

  const visit = (node) => {
    // The reference itself is either a seeded identifier or ns.ipcMain; anchor
    // on the smallest expression that evaluates to ipcMain.
    const isRef =
      (ts.isIdentifier(node) && names.has(node.text) && !isInTypePosition(node)) ||
      ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        isIpcMainExpr(node) &&
        !isInTypePosition(node));
    if (!isRef) {
      ts.forEachChild(node, visit);
      return;
    }
    // Skip the identifier of a binding we already understood (its own name in
    // `const im = ipcMain`, or the import specifier).
    const parent = node.parent;
    if (
      parent &&
      ((ts.isVariableDeclaration(parent) && parent.name === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isBindingElement(parent))
    ) {
      ts.forEachChild(node, visit);
      return;
    }
    // A recognized alias creation: `const im = ipcMain`.
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && aliasDecls.has(parent)) {
      ts.forEachChild(node, visit);
      return;
    }
    // A member access off ipcMain, which must be an immediately-invoked
    // registration or an allowlisted removal/introspection method.
    if (
      parent &&
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node
    ) {
      const member = accessedMemberName(parent);
      const call = parent.parent;
      const isCallee = call && ts.isCallExpression(call) && unwrap(call.expression) === parent;
      if (member === null) {
        problems.push(
          `${where(parent)}: computed member access on ipcMain (\`ipcMain[expr]\`); the gate scanner cannot tell which method this reaches`,
        );
      } else if (!isCallee) {
        problems.push(
          `${where(parent)}: \`ipcMain.${member}\` is captured without being called; the gate scanner cannot follow where it is invoked`,
        );
      } else if (REGISTER_METHODS.has(member)) {
        registrations.push({ method: member, call });
      } else if (!SAFE_METHODS.has(member)) {
        problems.push(
          `${where(parent)}: unrecognized ipcMain member \`${member}\`; add it to REGISTER_METHODS or SAFE_METHODS in this scanner`,
        );
      }
      ts.forEachChild(node, visit);
      return;
    }
    problems.push(
      `${where(node)}: ipcMain escapes into an expression the gate scanner cannot follow (\`${node.parent.getText().replace(/\s+/g, " ").slice(0, 60)}\`)`,
    );
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { registrations, problems };
}

// ── N2: does the gate's RESULT actually decide whether the body runs? ────────
// Token presence is not an answer. `isTrustedOnSender(e, ch); doPrivileged();`
// mentions the gate and is completely ungated at runtime. What follows is a
// small control-flow question: is there an early exit, a throw, or an `if` that
// wraps the work, whose condition is derived from the gate?

function isGateCall(node, gateVars) {
  const name = calleeName(node);
  return name !== null && ALL_GATE_FNS.has(name) ? name : null;
}

// "trusted"  -> the expression is truthy exactly when the sender IS trusted
// "untrusted"-> the expression is truthy exactly when the sender is NOT trusted
// null       -> the scanner cannot tell (fail closed)
function gatePolarity(expr, gateVars) {
  const e = unwrap(expr);
  if (!e) return null;
  if (ts.isIdentifier(e)) return gateVars.get(e.text) || null;
  if (ts.isCallExpression(e)) {
    const name = calleeName(e);
    if (name && GATE_TRUTHY_IS_TRUSTED.has(name)) return "trusted";
    if (name && GATE_TRUTHY_IS_UNTRUSTED.has(name)) return "untrusted";
    return null;
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = gatePolarity(e.operand, gateVars);
    return inner === "trusted" ? "untrusted" : inner === "untrusted" ? "trusted" : null;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    // `untrustedSenderReason(e, ch) === null` means trusted; `!== null` means not.
    const isNullish = (n) => {
      const u = unwrap(n);
      return (
        u &&
        (u.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(u) && u.text === "undefined"))
      );
    };
    const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const ne =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (eq || ne) {
      const side = isNullish(e.right) ? e.left : isNullish(e.left) ? e.right : null;
      if (!side) return null;
      const inner = gatePolarity(side, gateVars);
      if (!inner) return null;
      // `=== null` inverts the truthiness the polarity was stated in.
      if (eq) return inner === "trusted" ? "untrusted" : "trusted";
      return inner;
    }
    // `A && B` is truthy only if BOTH hold, so a "trusted" operand still governs
    // the wrapped body. `A || B` is truthy if EITHER holds, so an "untrusted"
    // operand still governs an early exit. Both directions are sound.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = gatePolarity(e.left, gateVars);
      const r = gatePolarity(e.right, gateVars);
      return l === "trusted" || r === "trusted" ? "trusted" : null;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = gatePolarity(e.left, gateVars);
      const r = gatePolarity(e.right, gateVars);
      return l === "untrusted" || r === "untrusted" ? "untrusted" : null;
    }
  }
  return null;
}

// Does this statement always leave the listener (so nothing after the guard
// runs for an untrusted sender)?
function alwaysExits(stmt) {
  if (!stmt) return false;
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return stmt.statements.some((s) => alwaysExits(s));
  if (ts.isIfStatement(stmt)) {
    return alwaysExits(stmt.thenStatement) && alwaysExits(stmt.elseStatement);
  }
  return false;
}

// A statement that cannot itself do privileged work: a plain binding with no
// call, no await, no assignment, no `new`. Allowed to precede the guard so
// destructuring the payload first is not a failure.
function isInertStatement(stmt) {
  if (!ts.isVariableStatement(stmt)) return false;
  return !containsNode(
    stmt,
    (n) =>
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isAwaitExpression(n) ||
      ts.isDeleteExpression(n) ||
      (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken),
  );
}

// Verify the listener passed to ipcMain.on(...) lets the gate decide.
// Returns null when it does, or a reason string when it does not.
function guardFailureReason(call) {
  const listener = unwrap(call.arguments[1]);
  if (!listener || !(ts.isArrowFunction(listener) || ts.isFunctionExpression(listener))) {
    return "its listener is not an inline function, so the gate scanner cannot verify it guards the sender";
  }
  const mentionsGate = containsNode(listener, (n) => ts.isCallExpression(n) && isGateCall(n));
  if (!mentionsGate) return "it does not consult the sender gate at all";

  // Concise arrow body: the only guarding shape is `(e) => gate(e, ch) && work()`.
  if (!ts.isBlock(listener.body)) {
    const body = unwrap(listener.body);
    if (
      ts.isBinaryExpression(body) &&
      body.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      gatePolarity(body.left, new Map()) === "trusted"
    ) {
      return null;
    }
    return "its expression body does not make the gate's result decide whether the work runs";
  }

  const statements = listener.body.statements;
  const gateVars = new Map(); // local name -> polarity
  for (let i = 0; i < statements.length; i += 1) {
    const stmt = statements[i];

    // `const ok = isTrustedOnSender(e, ch);` records the polarity, then the
    // guard below must actually branch on `ok`.
    if (ts.isVariableStatement(stmt)) {
      let bound = false;
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
        const polarity = gatePolarity(decl.initializer, gateVars);
        if (polarity) {
          gateVars.set(decl.name.text, polarity);
          bound = true;
        }
      }
      if (bound) continue;
      if (isInertStatement(stmt)) continue;
      return `it runs \`${stmt.getText().replace(/\s+/g, " ").slice(0, 48)}\` before the sender gate decides anything`;
    }

    // `requireTrustedSender(event, channel);` throws for an untrusted sender, so
    // the bare call is itself the guard.
    if (ts.isExpressionStatement(stmt)) {
      const expr = unwrap(stmt.expression);
      if (ts.isCallExpression(expr)) {
        const name = calleeName(expr);
        if (name && GATE_THROWS.has(name)) return null;
        if (name && ALL_GATE_FNS.has(name)) {
          // THE N2 EVASION: the gate ran and its answer went in the bin.
          return `it calls ${name}() as a bare statement and DISCARDS the result, so the body runs for an untrusted sender`;
        }
      }
      return `it runs \`${stmt.getText().replace(/\s+/g, " ").slice(0, 48)}\` before the sender gate decides anything`;
    }

    if (ts.isIfStatement(stmt)) {
      const polarity = gatePolarity(stmt.expression, gateVars);
      if (!polarity) {
        return `its first branch (\`${stmt.expression.getText().replace(/\s+/g, " ").slice(0, 48)}\`) is not derived from the sender gate`;
      }
      // Early exit: `if (untrusted) return;`
      if (polarity === "untrusted") {
        if (alwaysExits(stmt.thenStatement)) return null;
        return "its untrusted branch does not return or throw, so the body runs anyway";
      }
      // Wrapping guard: `if (trusted) { …work… }` with nothing after it, or
      // `if (trusted) {…} else return;`
      if (alwaysExits(stmt.elseStatement)) return null;
      if (i === statements.length - 1 && !stmt.elseStatement) return null;
      return "the work is not confined to the trusted branch (statements follow the guard)";
    }

    return `it runs \`${stmt.getText().replace(/\s+/g, " ").slice(0, 48)}\` before the sender gate decides anything`;
  }
  return "its body never branches on the sender gate";
}

// ── The gate wrappers must still exist and be gated ──────────────────────────
const ipcSf = parse(IPC);

function findFunction(sf, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const handleFn = findFunction(ipcSf, "handle");
check(handleFn !== null, "the gate-by-default handle() wrapper is defined in ipc.ts");
if (handleFn) {
  // The wrapper must call requireTrustedSender BEFORE it calls the caller's
  // listener, not merely mention it somewhere in the file.
  let gatedBeforeListener = false;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const inner = unwrap(node.arguments[1]);
      if (inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) && ts.isBlock(inner.body)) {
        const first = inner.body.statements[0];
        if (
          first &&
          ts.isExpressionStatement(first) &&
          ts.isCallExpression(unwrap(first.expression)) &&
          GATE_THROWS.has(calleeName(unwrap(first.expression)) || "")
        ) {
          gatedBeforeListener = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(handleFn);
  check(gatedBeforeListener, "handle() calls requireTrustedSender as the first thing before the listener");
}

check(fs.existsSync(GATE), "the shared sender-gate module (main-window-trust.ts) exists");
if (fs.existsSync(GATE)) {
  const gateSf = parse(GATE);
  for (const fn of ["requireTrustedSender", "isTrustedOnSender", "untrustedSenderReason"]) {
    const decl = findFunction(gateSf, fn);
    check(
      decl !== null && hasExportModifier(decl),
      `main-window-trust exports ${fn} (a gate this scanner recognizes)`,
    );
  }
}

// ── Scan every bundled main-process file ─────────────────────────────────────
const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(dir));
check(
  files.length > 5,
  `scanning every source dir bundled into main (${SCANNED_DIRS.map((d) => path.relative(ROOT, d)).join(", ")}; ${files.length} files)`,
);

let invokeRegistrations = 0; // ipcMain.handle / handleOnce across ALL files
let onRegistrations = 0;

for (const file of files) {
  const sf = parse(file);
  const base = path.basename(file);
  const { registrations, problems } = scanFile(sf);

  for (const problem of problems) check(false, `ipcMain is used in a way the gate scanner cannot follow: ${problem}`);

  for (const reg of registrations) {
    const label = channelLabel(reg.call);
    if (INVOKE_METHODS.has(reg.method)) {
      invokeRegistrations += 1;
      // A raw invoke registration is only ever legitimate inside one of the two
      // wrapper functions in ipc.ts; anywhere else it bypassed the gate.
      let enclosing = null;
      for (let p = reg.call.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name) {
          enclosing = p.name.text;
          break;
        }
      }
      check(
        base === "ipc.ts" && (enclosing === "handle" || enclosing === "handleOpen"),
        `raw ipcMain.${reg.method}( at ${where(reg.call)} must be inside the handle()/handleOpen() wrapper in ipc.ts (channel: ${label})`,
      );
      continue;
    }
    onRegistrations += 1;
    const key = `${base}:${label}`;
    if (ON_OPT_OUT.has(key)) {
      check(true, `ipcMain.${reg.method} "${label}" (${base}) is in ON_OPT_OUT`);
      continue;
    }
    const reason = guardFailureReason(reg.call);
    check(
      reason === null,
      reason === null
        ? `ipcMain.${reg.method} "${label}" (${base}) lets the sender gate decide whether its body runs`
        : `ipcMain.${reg.method} "${label}" (${where(reg.call)}) does NOT let the sender gate decide whether its body runs: ${reason}`,
    );
  }
}

// Exactly the two gated wrapper internals may be raw ipcMain.handle calls, and
// both live in ipc.ts. Any evasion (a third raw handle in any spelling, or a
// handle in another scanned file) pushes this above 2.
check(
  invokeRegistrations === 2,
  `exactly 2 raw ipcMain.handle registrations exist (the gated wrappers); found ${invokeRegistrations}`,
);
console.log(`  info: ${onRegistrations} ipcMain.on-style registrations, all gated above`);

// handleOpen(...) is the explicit UNGATED opt-out wrapper in ipc.ts. Every call
// site must be justified in OPT_OUT (the wrapper definition and `void handleOpen`
// are not calls). Any new opt-out that is not allowlisted fails the build.
const openCalls = [];
{
  const visit = (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === "handleOpen") openCalls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ipcSf);
}
for (const call of openCalls) {
  const label = channelLabel(call);
  check(OPT_OUT.has(label), `handleOpen opt-out "${label}" is in the documented OPT_OUT allowlist`);
}
check(
  openCalls.length === OPT_OUT.size,
  `every OPT_OUT entry is actually used (handleOpen calls=${openCalls.length}, allowlist=${OPT_OUT.size})`,
);

// Sanity: the gated wrapper is in heavy use (the privileged surface is large).
let gatedWrapperCalls = 0;
{
  const visit = (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === "handle" && node.arguments.length === 2) {
      gatedWrapperCalls += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(ipcSf);
}
console.log(`  info: ${gatedWrapperCalls} channels registered via the gated handle() wrapper`);
check(gatedWrapperCalls > 100, `the gated set is non-trivial (${gatedWrapperCalls} channels)`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
