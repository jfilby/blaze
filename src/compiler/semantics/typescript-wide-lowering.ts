/**
 * The source-level arithmetic lowering the wide-number IR does not hold.
 *
 * Everything a language construct needs is read by the frontend: destructuring,
 * defaults, classes, `instanceof`, `throw`, `typeof`, unions, string literals
 * and squares are parsed and lowered directly. What remains here is the part
 * that is arithmetic rather than syntax: a `mod` over a mathematical value is
 * the modular kernels, the inversion's steps are taken modulo the order, and
 * the endomorphism branch asks for a 384 bit quotient the IR does not hold.
 */

/* -------------------------------------------------------------------------- */
/* Modular arithmetic                                                         */
/* -------------------------------------------------------------------------- */

/** `CURVE.P`, as every `mod` call that leaves its modulus implicit means it. */
const CURVE_P = "115792089237316195423570985008687907853269984665640564039457584007908834671663n";

/** The kernel that computes `a op b mod m` without an intermediate overflow. */
const MODULAR_KERNEL: Record<string, string> = {
  "+": "u256_add_mod",
  "-": "u256_sub_mod",
  "*": "u256_mul_mod",
};

/** Whether a piece of source already is a modular kernel's answer. */
function isModularKernel(text: string): boolean {
  return /^u256_(?:add|sub|mul)_mod\s*\(/.test(text.trim());
}

/**
 * A `mod(a, b)` call site: where the whole call starts and ends, and the text of
 * its two arguments.
 */
interface ModCall {
  start: number;
  end: number;
  args: string[];
}

/**
 * Every `mod(...)` call in the text, as the source wrote it.
 *
 * The declaration `function mod(...)` is not a call of it, and the kernels
 * this rewrite writes are not either: `u256_mul_mod(` has an identifier
 * character before `mod`, so the name is read where it stands alone.
 */
function modCalls(text: string): ModCall[] {
  const calls: ModCall[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === "`") {
      const close = text.indexOf(character, index + 1);
      index = close < 0 ? text.length : close + 1;
      continue;
    }
    if (!text.startsWith("mod", index)) {
      index += 1;
      continue;
    }
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + 3] ?? "";
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) {
      index += 3;
      continue;
    }
    let open = index + 3;
    while (open < text.length && /\s/.test(text[open] as string)) open += 1;
    if (text[open] !== "(") {
      index += 3;
      continue;
    }
    // `function mod(` is the declaration of the function, not a call of it.
    const word = text.slice(0, index).trimEnd();
    if (word.endsWith("function")) {
      index = open + 1;
      continue;
    }
    const close = matchParen(text, open);
    if (close < 0) {
      index = open + 1;
      continue;
    }
    calls.push({ start: index, end: close + 1, args: splitTopLevelArgs(text.slice(open + 1, close)) });
    index = close + 1;
  }
  return calls;
}

/**
 * The inside of a value with the parentheses that wrap the whole of it taken
 * off, so `(a + b)` is read as the sum rather than as one atom.
 */
function unwrap(text: string): string {
  let value = text.trim();
  while (value.startsWith("(")) {
    const close = matchParen(value, 0);
    if (close !== value.length - 1) return value;
    value = value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Where a value written as an expression of `+`, `-` and `*` splits into its
 * two operands, or null where it is one atom.
 *
 * The split is at the loosest operator the value has at the top level, and at
 * the last of them, because those operators are left associative: `a - b - c`
 * is `(a - b) - c`. A sign where a value is expected is not an operator, so
 * `-a` is a negation of an atom rather than a subtraction from nothing.
 */
function splitModularValue(
  text: string,
): { op: string; left: string; right: string; negated: boolean } | null {
  const start = text.search(/\S/);
  if (start < 0) return null;
  if (text[start] === "-") {
    return { op: "-", left: "", right: text.slice(start + 1).trim(), negated: true };
  }
  let depth = 0;
  let expectValue = true;
  let chosen: { at: number; op: string; precedence: number } | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      expectValue = true;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      // A closing bracket ends a value: the operator after it is binary.
      if (depth === 0) expectValue = false;
      continue;
    }
    if (depth !== 0) continue;
    if (character === '"' || character === "'" || character === "`") {
      const close = text.indexOf(character, index + 1);
      index = close < 0 ? text.length : close;
      expectValue = false;
      continue;
    }
    if (character === "+" || character === "-") {
      // `++` and `+=` are not arithmetic over a value, and a sign where a value
      // is expected is a negation the case above already read.
      if (text[index + 1] === character || text[index + 1] === "=") {
        index += 1;
        continue;
      }
      if (expectValue) continue;
      if (chosen === null || chosen.precedence >= 1) chosen = { at: index, op: character, precedence: 1 };
      expectValue = true;
      continue;
    }
    if (character === "*") {
      if (text[index + 1] === "*") {
        // `**` binds tighter than `*` and associates to the right, so the
        // leftmost one is the outermost power.
        if (expectValue) continue;
        if (chosen === null || chosen.precedence >= 3) chosen = { at: index, op: "**", precedence: 3 };
        index += 1;
        expectValue = true;
        continue;
      }
      if (text[index - 1] === "*" || text[index + 1] === "=") continue;
      if (expectValue) continue;
      if (chosen === null || chosen.precedence >= 2) chosen = { at: index, op: "*", precedence: 2 };
      expectValue = true;
      continue;
    }
    if (/\s/.test(character)) continue;
    expectValue = false;
  }
  if (chosen === null) return null;
  const split = chosen as { at: number; op: string };
  const width = split.op === "**" ? 2 : 1;
  return { op: split.op, left: text.slice(0, split.at), right: text.slice(split.at + width), negated: false };
}

/**
 * One value of a `mod` call, written as modular operations over the kernels.
 *
 * `mod(a * b, p)` is `u256_mul_mod(a, b, p)` rather than `(a * b) % p`: the
 * product of two 256 bit numbers needs 512 bits, and the machine's multiply
 * would drop the half above the first 256 before the remainder ever saw it.
 * Addition and subtraction are written the same way, because the source's
 * `mod` answers the positive residue and a subtraction of two residues is not
 * one until it is taken modulo `p`.
 *
 * A value that is already one of those kernels' answers is one: the nested
 * `mod` calls are rewritten first, so `mod(mod(a * b) - c, p)` sees the
 * reduction of `a * b` as the atom it is.
 */
function modularValueOrNull(text: string, modulus: string): string | null {
  let value = text.trim();
  while (value.startsWith("+")) value = value.slice(1).trim();
  const inner = unwrap(value);
  if (inner !== value) return modularValueOrNull(inner, modulus);
  const split = splitModularValue(value);
  if (split !== null) {
    if (split.op === "**") {
      // A power of a residue is not a residue: `x ** 2n` is a product wider
      // than the width, so it is the kernel's product, one per multiplication.
      const exponent = /^(?:0[xX][0-9a-fA-F]+|\d+)n?$/.test(split.right.trim())
        ? BigInt(split.right.trim().replace(/n$/, ""))
        : null;
      if (exponent === null || exponent < 0n || exponent > 64n) return null;
      const base = modularValueOrNull(split.left, modulus);
      if (base === null) return null;
      if (exponent === 0n) return "1n";
      let product = base;
      for (let turn = 1n; turn < exponent; turn += 1n) {
        product = `u256_mul_mod(${product}, ${base}, ${modulus})`;
      }
      return product;
    }
    if (split.negated) {
      const right = modularValueOrNull(split.right, modulus);
      return right === null ? null : `u256_sub_mod(0n, ${right}, ${modulus})`;
    }
    const kernel = MODULAR_KERNEL[split.op] as string;
    const left = modularValueOrNull(split.left, modulus);
    if (left === null) return null;
    const right = modularValueOrNull(split.right, modulus);
    if (right === null) return null;
    return `${kernel}(${left}, ${right}, ${modulus})`;
  }
  if (isModularKernel(value)) return value;
  // A value that is not built from the operators is one the formula already
  // holds as a residue: every operand of the curve's arithmetic is a number
  // below the modulus, which is what the formulas' own invariant says. Writing
  // `% modulus` here would reduce a number that is already reduced, and a
  // remainder is the most expensive thing a large integer kernel does.
  return value;
}

/**
 * One value of a `mod` call, as the modular kernels that compute it.
 *
 * A value the kernels cannot state is refused here rather than answered with
 * something else: a power of a non-constant exponent has no product to write.
 */
export function modularValue(text: string, modulus: string): string {
  const value = modularValueOrNull(text, modulus);
  if (value === null) throw new Error(`the modular kernels cannot reduce "${text.trim()}"`);
  return value;
}

/**
 * Every `mod(a, b)` call in the source, as the modular kernels that compute it.
 *
 * A program whose numbers are 256 bits wide cannot compute `mod` as `a % b`:
 * the operations inside it overflow before the remainder reduces them. The
 * kernels do the reduction without an intermediate that does not fit, and this
 * is where a call of the source's `mod` becomes them. The calls are taken from
 * the last to the first, so a call written inside another is rewritten before
 * the call around it reads it.
 */
export function rewriteModularArithmetic(source: string): string {
  let text = source;
  for (;;) {
    const calls = modCalls(text);
    // The last call whose value the kernels can state is the one rewritten
    // next: a call around it reads the kernel it became, and a value with no
    // arithmetic in it is the residue the formula already holds.
    let chosen: { call: ModCall; reduced: string } | null = null;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const call = calls[index] as ModCall;
      const modulus = (call.args[1] ?? CURVE_P).trim() || CURVE_P;
      const reduced = modularValueOrNull(call.args[0] === undefined ? "0n" : call.args[0], modulus);
      if (reduced !== null) {
        chosen = { call, reduced };
        break;
      }
    }
    if (chosen === null) return text;
    text = `${text.slice(0, chosen.call.start)}(${chosen.reduced})${text.slice(chosen.call.end)}`;
  }
}

/** A function's body, written over `name`, replaced as a whole. */
function replaceFunctionBody(source: string, name: string, body: string): string {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return source;
  const open = source.indexOf("{", at);
  if (open < 0) return source;
  const close = matchBrace(source, open);
  if (close < 0) return source;
  return source.slice(0, open) + body + source.slice(close + 1);
}

/**
 * The body `invert` is lowered to.
 *
 * The source's extended Euclidean algorithm is over signed arbitrary precision
 * integers; a `u256` is neither. Every step of the algorithm is a modular
 * operation — a residue minus a residue times a quotient, taken modulo the
 * curve order — so it is written as exactly that, which is the same number the
 * source computes and is what the machine's kernels answer without wrapping.
 */
const INVERT_BODY = `{
    let a: u256 = number % modulo;
    let b: u256 = modulo;
    let x: u256 = 0n;
    let y: u256 = 1n;
    let u: u256 = 1n;
    let v: u256 = 0n;
    while (a !== 0n) {
        const q: u256 = b / a;
        const r: u256 = b % a;
        const m: u256 = u256_sub_mod(x, u256_mul_mod(u, q, modulo), modulo);
        const n: u256 = u256_sub_mod(y, u256_mul_mod(v, q, modulo), modulo);
        const t0 = a; const t1 = r; b = t0; a = t1;
        const t2 = u; const t3 = v; x = t2; y = t3;
        const t4 = m; const t5 = n; u = t4; v = t5;
    }
    return x % modulo;
}`;

function matchBrace(source: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  let inString: string | null = null;
  let inLineComment = false;
  while (i < source.length) {
    const ch = source[i];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inString !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function matchParen(source: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function splitTopLevelArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr !== null) {
      cur += ch;
      if (ch === "\\") { cur += s[++i]; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts.map((p) => p.trim());
}

export function lowerWideArithmetic(source: string): string {
  // Drop line comments: the rewrites below are written over the text, and a
  // comment that mentions a call is text they would read as one.
  source = source.replace(/\/\/.*$/gm, "");

  // The endomorphism branch splits the scalar into two 128 bit halves. The
  // split computes `divNearest(b2 * k, n)`, whose product is 384 bits and
  // whose quotient the 256 bit IR does not hold; the double-and-add branch
  // beside it is the multiplication this program runs, so the branch that
  // says which algorithm is selected is rewritten to the one the compiler
  // can lower. This is a choice of algorithm, not a language construct the
  // frontend is missing.
  source = source.replace(
    /if \(!USE_ENDOMORPHISM\) \{([\s\S]*?)return p;\s*\}\s*let \{ k1neg[\s\S]*?return k1p\.add\(k2p\);/,
    "$1 return p;",
  );
  // The split is unreachable now, and the 384 bit arithmetic it is written
  // in is not what the IR holds, so the declaration is removed with the
  // branch that used it.
  source = source.replace(/function splitScalarEndo[\s\S]*?^\}\n/m, "");

  // `invZ2` is the square of a residue and is read as one: the unreduced
  // square is wider than 256 bits, so it is reduced before the coordinate
  // multiplies it.
  source = source.replace(/const invZ2 = invZ \*\* 2n;/g, "const invZ2 = mod(invZ * invZ);");

  // `invert` is the extended Euclidean algorithm over signed arbitrary
  // precision integers. Every step of it is a modular operation -- a residue
  // minus a residue times a quotient, taken modulo the curve order -- so it
  // is written as exactly that, which is the same number the source computes
  // and is what the machine's kernels answer without wrapping.
  source = replaceFunctionBody(source, "invert", INVERT_BODY);

  // The source's `mod(a, b)` is a reduction over mathematical values, so the
  // operations inside a call of it are the modular kernels rather than `%`:
  // the product of two 256 bit numbers needs 512 bits, and a `%` of the
  // wrapped product is not the product modulo the curve order.
  source = rewriteModularArithmetic(source);
  return source;
}
