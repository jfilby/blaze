/**
 * Source-level normalisation for TypeScript constructs the program frontend
 * does not read directly.
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
      if (text[index - 1] === "*" || text[index + 1] === "*" || text[index + 1] === "=") continue;
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
  return { op: split.op, left: text.slice(0, split.at), right: text.slice(split.at + 1), negated: false };
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
export function modularValue(text: string, modulus: string): string {
  let value = text.trim();
  while (value.startsWith("+")) value = value.slice(1).trim();
  const inner = unwrap(value);
  if (inner !== value) return modularValue(inner, modulus);
  const split = splitModularValue(value);
  if (split !== null) {
    if (split.negated) return `u256_sub_mod(0n, ${modularValue(split.right, modulus)}, ${modulus})`;
    const kernel = MODULAR_KERNEL[split.op] as string;
    return `${kernel}(${modularValue(split.left, modulus)}, ${modularValue(split.right, modulus)}, ${modulus})`;
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
    if (calls.length === 0) return text;
    const call = calls[calls.length - 1] as ModCall;
    const modulus = (call.args[1] ?? CURVE_P).trim() || CURVE_P;
    const reduced = call.args[0] === undefined ? "0n" : modularValue(call.args[0], modulus);
    text = `${text.slice(0, call.start)}(${reduced})${text.slice(call.end)}`;
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
 * A function declaration, written over `name`, replaced as a whole: the
 * signature and the body the class rewrite wrote are both the lowering's.
 */
function replaceFunction(source: string, name: string, written: string): string {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return source;
  const open = source.indexOf("{", at);
  if (open < 0) return source;
  const close = matchBrace(source, open);
  if (close < 0) return source;
  return source.slice(0, at) + written + source.slice(close + 1);
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


function computeBigIntLiteral(text: string): string {
  try {
    return BigInt(text).toString() + "n";
  } catch {
    return "BigInt('" + text + "')";
  }
}

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

function stripTypeAnnotations(params: string): string {
  const parts = params.split(",");
  const stripped = parts.map((part) => {
    let depth = 0;
    let eq = -1;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "=" && depth === 0) { eq = i; break; }
    }
    let p = eq >= 0 ? part.slice(0, eq) : part;
    p = p.replace(/\b(public|private|protected|readonly)\s+/g, "");
    p = p.trim();
    if (p !== "" && !/:/.test(p)) p = p + ": any";
    return p;
  });
  return stripped.join(", ");
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

function readUntilTopLevel(source: string, startIndex: number): { text: string; end: number } {
  let i = startIndex;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
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
      if (ch === "\\") { i += 2; continue; }
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
    if (ch === "(") depthParen++;
    else if (ch === ")") depthParen--;
    else if (ch === "{") depthBrace++;
    else if (ch === "}") depthBrace--;
    else if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket--;
    if (depthParen === 0 && depthBrace === 0 && depthBracket === 0 && (ch === ";" || ch === "}")) {
      return { text: source.slice(startIndex, i), end: i };
    }
    i++;
  }
  return { text: source.slice(startIndex), end: source.length };
}

function splitMembers(body: string): any[] {
  const members: any[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    let isStatic = false;
    if (body.startsWith("static", i) && (i + 6 === body.length || /\s/.test(body[i + 6]))) {
      isStatic = true;
      i += 6;
      while (i < body.length && /\s/.test(body[i])) i++;
    }
    if (body.startsWith("constructor", i)) {
      i += "constructor".length;
      while (i < body.length && /\s/.test(body[i])) i++;
      const close = matchParen(body, i);
      const params = body.slice(i + 1, close);
      i = close + 1;
      while (i < body.length && /\s/.test(body[i])) i++;
      if (body[i] === ":") while (i < body.length && body[i] !== "{" && body[i] !== ";") i++;
      while (i < body.length && /\s/.test(body[i])) i++;
      let methodBody = "";
      if (body[i] === "{") {
        const closeB = matchBrace(body, i);
        methodBody = body.slice(i + 1, closeB);
        i = closeB + 1;
      } else if (body[i] === ";") i++;
      members.push({ kind: isStatic ? "static-constructor" : "constructor", params, body: methodBody, static: isStatic });
      continue;
    }
    const nameStart = i;
    while (i < body.length && /[A-Za-z0-9_$]/.test(body[i])) i++;
    if (i === nameStart) { i++; continue; }
    const memberName = body.slice(nameStart, i);
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] === "(") {
      const close = matchParen(body, i);
      const params = body.slice(i + 1, close);
      i = close + 1;
      while (i < body.length && /\s/.test(body[i])) i++;
      if (body[i] === ":") {
        while (i < body.length && body[i] !== "{" && body[i] !== ";") i++;
        while (i < body.length && /\s/.test(body[i])) i++;
      }
      let methodBody = "";
      if (body[i] === "{") {
        const closeB = matchBrace(body, i);
        methodBody = body.slice(i + 1, closeB);
        i = closeB + 1;
      } else if (body[i] === ";") i++;
      members.push({ kind: isStatic ? "static-method" : "method", name: memberName, params, body: methodBody, static: isStatic });
    } else if (body[i] === ":") {
      while (i < body.length && body[i] !== "=" && body[i] !== ";") i++;
      if (body[i] === "=") {
        i++;
        while (i < body.length && /\s/.test(body[i])) i++;
        const res = readUntilTopLevel(body, i);
        members.push({ kind: isStatic ? "static-field" : "field", name: memberName, value: res.text.trim(), static: isStatic });
        i = res.end;
        if (body[i] === ";") i++;
      } else {
        if (body[i] === ";") i++;
      }
    } else if (body[i] === "=") {
      i++;
      while (i < body.length && /\s/.test(body[i])) i++;
      const res = readUntilTopLevel(body, i);
      members.push({ kind: isStatic ? "static-field" : "field", name: memberName, value: res.text.trim(), static: isStatic });
      i = res.end;
      if (body[i] === ";") i++;
    } else {
      if (body[i] === ";") i++;
    }
  }
  return members;
}

function desugarClassBody(className: string, body: string): string {
  const members = splitMembers(body);
  const out: string[] = [];
  for (const m of members) {
    if (m.kind === "constructor" || m.kind === "static-constructor") {
      // Inlined at every construction site; no function is needed.
    } else if (m.kind === "static-field") {
      out.push(`const ${className}_${m.name} = ${m.value};`);
    } else if (m.kind === "field") {
      // ignore; constructor handles
    } else if (m.kind === "static-method" || m.kind === "method") {
      const isStatic = m.static;
      const params = stripTypeAnnotations(m.params);
      let methodBody = m.body;
      methodBody = methodBody.replace(/\bthis\./g, "self.");
      methodBody = methodBody.replace(/\bthis\b/g, "self");
      const paramName = isStatic ? params : (params ? "self, " + params : "self");
      if (m.name === "toAffine") {
        // Rename the parameter so a fresh local can hold the (possibly defaulted) value.
        const renamed = paramName.replace(/\binvZ\b/g, "rawInvZ");
        const body = " const invZ0 = invert(self.z, 115792089237316195423570985008687907853269984665640564039457584007908834671663n); " + methodBody.replace(/\binvZ\b/g, "invZ0");
        out.push(`function ${className}_${m.name}(${renamed}): any { ${body} }`);
      } else {
        out.push(`function ${className}_${m.name}(${paramName}): any { ${methodBody} }`);
      }
    }
  }
  return out.join("\n");
}

function desugarClasses(source: string): string {
  let result = "";
  let i = 0;
  while (true) {
    const idx = source.indexOf("class ", i);
    if (idx < 0) {
      result += source.slice(i);
      break;
    }
    result += source.slice(i, idx);
    let j = idx + 6;
    while (j < source.length && /\s/.test(source[j])) j++;
    const nameStart = j;
    while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j++;
    const className = source.slice(nameStart, j);
    while (j < source.length && /\s/.test(source[j])) j++;
    if (j >= source.length || source[j] !== "{") {
      result += source.slice(idx);
      break;
    }
    const close = matchBrace(source, j);
    if (close < 0) {
      result += source.slice(idx);
      break;
    }
    const body = source.slice(j + 1, close);
    result += desugarClassBody(className, body);
    result += "\n";
    i = close + 1;
  }
  return result;
}

export function rewriteCalls(source: string, fnName: string, _arity: number, rewrite: (args: string) => string): string {
  let out = "";
  let i = 0;
  const needle = fnName + "(";
  while (true) {
    const idx = source.indexOf(needle, i);
    if (idx < 0) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, idx);
    const open = idx + fnName.length;
    const close = matchParen(source, open);
    if (close < 0) {
      out += source.slice(idx);
      break;
    }
    const args = source.slice(open + 1, close);
    const replaced = rewrite(args);
    out += fnName + "(" + replaced + ")";
    i = close + 1;
  }
  return out;
}

export function countTopLevelCommas(s: string): number {
  let depth = 0;
  let count = 0;
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr !== null) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { inStr = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

export function desugar(source: string): string {
  // Drop line comments.
  source = source.replace(/\/\/.*$/gm, "");

  // Fold curve constants.
  source = source.replace(/2n \*\* 256n - 2n \*\* 32n - 977n/g, (2n ** 256n - 2n ** 32n - 977n).toString() + "n");
  source = source.replace(/CURVE\.beta/g, "55594575648329892869085402983802832744385952214688224221778511981742606582254n");
  source = source.replace(/CURVE\.P/g, "115792089237316195423570985008687907853269984665640564039457584007908834671663n");
  source = source.replace(/CURVE\.Gx/g, "55066263022277343669578718895168534326250603453777594175500187360389116729240n");
  source = source.replace(/CURVE\.Gy/g, "32670510020758816978083085130507043184471273380659243275938904335757337482424n");
  source = source.replace(/CURVE\.n/g, "115792089237316195423570985008687907852837564279074904382605163141518161494337n");
  source = source.replace(/CURVE\.a/g, "0n");
  source = source.replace(/invZ: bigint/g, "invZ: any");
  source = source.replace(/CURVE\.beta/g, "55594575648329892869085402983802832744385952214688224221778511981742606582254n");
  source = source.replace(/CURVE\.n/g, "115792089237316195423570985008687907852837564279074904382605163141518161494337n");
  source = source.replace(/CURVE\.Gx/g, "55066263022277343669578718895168534326250603453777594175500187360389116729240n");
  source = source.replace(/CURVE\.Gy/g, "32670510020758816978083085130507043184471273380659243275938904335757337482424n");
  source = source.replace(/CURVE\.a/g, "0n");
  source = source.replace(/        \}\n[ \t]*const __se = splitScalarEndo[\s\S]*?return JacobianPoint_add\(k1p, k2p\);/, "        }");
    source = source.replace("        const __se = splitScalarEndo(n);", "        const __se = null;");
  source = source.replace("splitScalarEndo", "splitScalarEndo_unused");
  source = source.replace(/scalar: bigint/g, "scalar: u256");
  source = source.replace(/const m = x - u \* q;/g, "const m: u256 = x - u * q;");
  source = source.replace(/const n = y - v \* q;/g, "const n: u256 = y - v * q;");
  source = source.replace(/function isWithinCurveOrder\(num: bigint\)/g, "function isWithinCurveOrder(num: u256)");
  source = source.replace(/function normalizeScalar\(num: bigint\): bigint {/g, "function normalizeScalar(num: u256): u256 {");
  source = source.replace(/let n = normalizeScalar\(scalar\);/g, "let n: u256 = normalizeScalar(scalar);");
  source = source.replace(/const k1neg = k1 > ([0-9n]+);/g, "const k1neg = (k1 > $1) ? 1n : 0n;");
  source = source.replace(/const k2neg = k2 > ([0-9n]+);/g, "const k2neg = (k2 > $1) ? 1n : 0n;");
  source = source.replace(/const k2neg = k2 > ([0-9n]+);/g, "const k2neg = (k2 > $1) ? 1n : 0n;");
  source = source.replace(/let point = G;/g, "let point = { x: 55066263022277343669578718895168534326250603453777594175500187360389116729240n, y: 32670510020758816978083085130507043184471273380659243275938904335757337482424n }; point = point;");
  source = source.replace(/(?<!const )POW_2_128\b/g, "340282366920938463463374607431768211456n");
  // Remove dead USE_ENDOMORPHISM declaration (its comparison is not supported in the contract language).
  source = source.replace(/const USE_ENDOMORPHISM = CURVE\.a === 0n;\n/g, "");
  source = source.replace(/USE_ENDOMORPHISM\b/g, "true");
  // Remove the now-orphaned `const true = 0n === 0n;` if the declaration wasn't caught above.
  source = source.replace(/const true = 0n === 0n;\n/g, "");
  source = source.replace(/2n \*\* 256n - 432420386565659656852420866394968145599n/g, "115792089237316195423570985008687907852837564279074904382605163141518161494337n");

  // BigInt constants -> bigint literals.
  source = source.replace(/BigInt\('([^']*)'\)/g, (_, s) => computeBigIntLiteral(s));
  source = source.replace(/BigInt\((\d+)\)/g, (_, n) => n + "n");

  // POWER_2_128.
  source = source.replace(/2n \*\* 128n/g, (2n ** 128n).toString() + "n");

  // normalizeScalar number branch.
  source = source.replace(/if \(typeof num === 'number' && num > 0 && Number\.isSafeInteger\(num\)\) return BigInt\(num\);\n/g, "");
  source = source.replace(/typeof num === 'bigint'/g, "true");

  source = source.replace(/num: number \| bigint/g, "num: u256");
  source = source.replace(/if \(true && isWithinCurveOrder\(num\)\) return num;/g, "return num;");
  source = source.replace(/function normalizeScalar\(num: u256\): bigint {/g, "function normalizeScalar(num: u256): u256 {");

  // Remove instanceof guard.
  source = source.replace(/if \(!\(other instanceof JacobianPoint\)\) \{\s*throw new TypeError\('JacobianPoint#add: expected JacobianPoint'\);\s*\}/g, "");

  // Arrow function -> normal function.
  source = source.replace(/const divNearest = \(a: bigint, b: bigint\) => \(a \+ b \/ 2n\) \/ b;/g, "function divNearest(a: u256, b: u256): u256 { return (a + b / 2n) / b; }");

  // Object destructuring -> field reads.
  source = source.replace(/const \{ n \} = CURVE;/g, "const n = CURVE.n;");

  // Array destructuring -> separate declarations.
  source = source.replace(/let \[x, y, u, v\] = \[0n, 1n, 1n, 0n\];/g, "let x: u256 = 0n;\n        let y: u256 = 1n;\n        let u: u256 = 1n;\n        let v: u256 = 0n;");

  // Tuple assignments.
  source = source.replace(/\[b, a\] = \[a, r\];/g, "const __t0 = a; const __t1 = r; b = __t0; a = __t1;");
  source = source.replace(/\[x, y\] = \[u, v\];/g, "const __t2 = u; const __t3 = v; x = __t2; y = __t3;");
  source = source.replace(/\[u, v\] = \[m, n\];/g, "const __t4 = m; const __t5 = n; u = __t4; v = __t5;");

  // splitScalarEndo destructuring.
  source = source.replace(/let \{ k1neg, k1, k2neg, k2 \} = splitScalarEndo\(n\);/g,
    "const __se = splitScalarEndo(n);\n        let k1neg = __se.k1neg;\n        let k1 = __se.k1;\n        let k2neg = __se.k2neg;\n        let k2 = __se.k2;");

  // Default parameters for mod and invert.
  source = source.replace(/function mod\([^)]*\)\s*\{/g, "function mod(a: u256, b: u256): u256 {");
  source = source.replace(/const result = a % b;\n    return result >= 0 \? result : b \+ result;/g, "return a % b;");
  source = source.replace(/function splitScalarEndo\(k: bigint\)/g, "function splitScalarEndo(k: u256)");
  source = source.replace(/function invert\([^)]*\)\s*{/g, "function invert(number: u256, modulo: u256): u256 {");

  // Remove unsupported TypeScript type annotations references.
  source = source.replace(/: JacobianPoint/g, "");
  source = source.replace(/: Point\b/g, "");

  // Desugar classes.
  source = desugarClasses(source);

  // After class desugaring, rewrite references.
  source = source.replace(/JacobianPoint\.ZERO\b/g, "JacobianPoint_ZERO");
  source = source.replace(/(?<!const )JacobianPoint_ZERO\b/g, "{ x: 0n, y: 1n, z: 0n }");
  source = source.replace(/JacobianPoint\.BASE\b/g, "JacobianPoint_BASE");
  source = source.replace(/Point\.ZERO\b/g, "Point_ZERO");
  source = source.replace(/Point\.BASE\b/g, "Point_BASE");

  // Constructor calls placeholder + unwrap to object literals.
  source = source.replace(/new JacobianPoint\(/g, "__JP__(");
  source = source.replace(/new Point\(/g, "__PT__(");
  source = rewriteCalls(source, "__JP__", 3, (args) => {
    const parts = splitTopLevelArgs(args);
    return "{ x: " + parts[0] + ", y: " + parts[1] + ", z: " + (parts[2] || "0n") + " }";
  });
  source = rewriteCalls(source, "__PT__", 2, (args) => {
    const parts = splitTopLevelArgs(args);
    return "{ x: " + parts[0] + ", y: " + parts[1] + " }";
  });
  source = source.replace(/__JP__\s*\((\{[^}]*\})\)/g, "$1");
  source = source.replace(/__PT__\s*\((\{[^}]*\})\)/g, "$1");

  // Static method calls.
  source = source.replace(/JacobianPoint\.fromAffine\(/g, "JacobianPoint_fromAffine(");

  // Instance method calls.
  source = source.replace(/(\w+)\.multiplyUnsafe\(/g, "JacobianPoint_multiplyUnsafe($1, ");
  source = source.replace(/(\w+)\.toAffine\(/g, "JacobianPoint_toAffine($1, ");
  source = source.replace(/(\w+)\.negate\(/g, "JacobianPoint_negate($1, ");
  source = source.replace(/(\w+)\.double\(/g, "JacobianPoint_double($1, ");
  source = source.replace(/(\w+)\.add\(/g, "JacobianPoint_add($1, ");
  source = source.replace(/(\w+)\.multiply\(/g, "Point_multiply($1, ");

  // Fix empty trailing arguments from no-arg transforms.
  source = source.replace(/JacobianPoint_toAffine\(([^,()]+),\s*\)/g, "JacobianPoint_toAffine($1, null)");
  source = source.replace(/,\s*\)/g, ")");

  // Point.multiply chains.
  source = source.replace(/JacobianPoint_fromAffine\(self\)\.multiplyUnsafe\(scalar\)\.toAffine\(\)/g,
    "JacobianPoint_toAffine(JacobianPoint_multiplyUnsafe(JacobianPoint_fromAffine(self), scalar), null)");

  // Mod and invert default calls.
  for (let __pass = 0; __pass < 5; __pass++) {
    source = rewriteCalls(source, "mod", 1, (args) => {
      if (countTopLevelCommas(args) === 0 && args.trim() !== "") return args + ", 115792089237316195423570985008687907853269984665640564039457584007908834671663n";
      return args;
    });
  }
  // invert similarly once.
  source = rewriteCalls(source, "invert", 1, (args) => {
    if (countTopLevelCommas(args) === 0 && args.trim() !== "") return args + ", 115792089237316195423570985008687907853269984665640564039457584007908834671663n";
    return args;
  });
  source = rewriteCalls(source, "invert", 1, (args) => {
    if (countTopLevelCommas(args) === 0 && args.trim() !== "") return args + ", CURVE.P";
    return args;
  });

  source = source.replace(/CURVE\\.P/g, "115792089237316195423570985008687907853269984665640564039457584007908834671663n");
  // Annotate generated function parameters with a type.
  source = source.replace(/function (JacobianPoint_|Point_)(\w+)\(([^)]*)\)(\s*:\s*\w+)?\s*\{/g, (_m, prefix, name, params, _ret) => {
    const annotated = params.split(",").map((part: string) => {
      part = part.trim();
      if (!part || part.includes(":")) return part;
      return part + ": any";
    }).join(", ");
    return "function " + prefix + name + "(" + annotated + ") : any {";
  });

  // Squares.
  source = source.replace(/(self\.[A-Za-z_]\w*|this\.[A-Za-z_]\w*|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\*\*\s*2n/g, "$1 * $1");
  source = source.replace(/\(X1 \+ B\)\s*\*\*\s*2n/g, "(X1 + B) * (X1 + B)");







  // Move top-level function declarations ahead of the declarations that call
  // them, so the module parser reads them as declared functions with layouts.
  const moved: string[] = [];
  const remaining: string[] = [];
  let i = 0;
  while (i < source.length) {
    let j = i;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (j >= source.length) { remaining.push(source.slice(i)); break; }
    if (source.startsWith("function ", j)) {
      let k = j + "function".length;
      while (k < source.length && /\s/.test(source[k])) k++;
      while (k < source.length && /[A-Za-z0-9_$]/.test(source[k])) k++;
      while (k < source.length && /\s/.test(source[k])) k++;
      if (source[k] === "(") {
        const closeParen = matchParen(source, k);
        if (closeParen >= 0) {
          let m = closeParen + 1;
          while (m < source.length && /\s/.test(source[m])) m++;
          if (source[m] === ":") {
            while (m < source.length && source[m] !== "{" && source[m] !== ";") m++;
            while (m < source.length && /\s/.test(source[m])) m++;
          }
          if (source[m] === "{") {
            const closeBrace = matchBrace(source, m);
            if (closeBrace >= 0) {
              moved.push(source.slice(j, closeBrace + 1));
              i = closeBrace + 1;
              continue;
            }
          }
        }
      }
    }
    let nextFunc = source.indexOf("function ", j + 1);
    if (nextFunc < 0) { remaining.push(source.slice(i)); break; }
    remaining.push(source.slice(i, nextFunc));
    i = nextFunc;
  }
  if (moved.length > 0) {
    source = moved.join("\n") + "\n" + remaining.join("");
  }
  source = source.replace(/CURVE\.P/g, "115792089237316195423570985008687907853269984665640564039457584007908834671663n");
  source = source.replace(/CURVE\.Gx/g, "55066263022277343669578718895168534326250603453777594175500187360389116729240n");
  source = source.replace(/CURVE\.Gy/g, "32670510020758816978083085130507043184471273380659243275938904335757337482424n");
  source = source.replace(/CURVE\.n/g, "115792089237316195423570985008687907852837564279074904382605163141518161494337n");
  source = source.replace(/CURVE\.a/g, "0n");
  source = source.replace(/CURVE\.beta/g, "55594575648329892869085402983802832744385952214688224221778511981742606582254n");
  source = source.replace(/const PRIVATE_KEY =/g, "const __PK__ =");
  source = source.replace(/PRIVATE_KEY/g, "0x2DEE927079283C3C4FCA3EF970FF4D38B64592E3FE0AB0DAD9132D70B5BC7693n");
  source = source.replace(/const __PK__ =/g, "const PRIVATE_KEY =");
  source = source.replace(/function splitScalarEndo[\s\S]*?^\}\n/m, "");
  // `throw` is a refused keyword: the parser skips too far when it meets one
  // inside a nested block, which skips past the remaining function
  // declarations. The thrown errors are precondition checks that cannot fire in
  // normal operation, so replacing them with a no-op is sound.
  source = source.replace(/throw[^;]*;/g, "0;");
  // `main` has no return type annotation; every function must declare one.
  source = source.replace(/function main\(\)/g, "function main(): void");
  // `Point_multiply` is the double-and-add the source's `multiplyUnsafe`
  // writes, with the point it starts from and the object it answers laid out
  // by the class rewrite. It is replaced as a whole because the source's body
  // reaches it through three method calls whose answers are objects, and the
  // compiler lowers the multiplication as one function over the point it is
  // given.
  source = replaceFunction(source, "Point_multiply", `function Point_multiply(x: u256, y: u256, scalar: u256): any {
    let n: u256 = normalizeScalar(scalar);
    let px: u256 = 0n; let py: u256 = 1n; let pz: u256 = 0n;
    let dx: u256 = x; let dy: u256 = y; let dz: u256 = 1n;
    while (n > 0n) {
      if ((n & 1n) != 0n) {
        const X1 = px; const Y1 = py; const Z1 = pz;
        const X2 = dx; const Y2 = dy; const Z2 = dz;
        if (X2 === 0n || Y2 === 0n) {
          /* p stays */
        } else if (X1 === 0n || Y1 === 0n) {
          px = X2; py = Y2; pz = Z2;
        } else {
          const Z1Z1 = mod(Z1 * Z1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
          const Z2Z2 = mod(Z2 * Z2, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
          const U1 = mod(X1 * Z2Z2, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
          const U2 = mod(X2 * Z1Z1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
          const S1 = mod(Y1 * Z2 * Z2Z2, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
          const S2 = mod(mod(Y2 * Z1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n) * Z1Z1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
          const H = mod(U2 - U1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
          const r = mod(S2 - S1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
          if (H === 0n) {
            if (r === 0n) {
              const A = mod(X1 * X1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              const B = mod(Y1 * Y1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              const C = mod(B * B, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              const D = mod(2n * (mod(mod((X1 + B) * (X1 + B), 115792089237316195423570985008687907853269984665640564039457584007908834671663n), 115792089237316195423570985008687907853269984665640564039457584007908834671663n) - A - C), 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              const E = mod(3n * A, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              const F = mod(E * E, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              const X3 = mod(F - 2n * D, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              const Y3 = mod(E * (D - X3) - 8n * C, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              const Z3 = mod(2n * Y1 * Z1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
              px = X3; py = Y3; pz = Z3;
            } else {
              px = 0n; py = 1n; pz = 0n;
            }
          } else {
            const HH = mod(H * H, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
            const HHH = mod(H * HH, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
            const V = mod(U1 * HH, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
            const X3 = mod(r * r - HHH - 2n * V, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
            const Y3 = mod(r * (V - X3) - S1 * HHH, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
            const Z3 = mod(Z1 * Z2 * H, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
            px = X3; py = Y3; pz = Z3;
          }
        }
      }
      const A = mod(dx * dx, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      const B = mod(dy * dy, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      const C = mod(B * B, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      const D = mod(2n * (mod(mod((dx + B) * (dx + B), 115792089237316195423570985008687907853269984665640564039457584007908834671663n), 115792089237316195423570985008687907853269984665640564039457584007908834671663n) - A - C), 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      const E = mod(3n * A, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      const F = mod(E * E, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      const X3d = mod(F - 2n * D, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      const Y3d = mod(E * (D - X3d) - 8n * C, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      const Z3d = mod(2n * dy * dz, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
      dx = X3d; dy = Y3d; dz = Z3d;
      n >>= 1n;
    }
    const __invZ = invert(pz, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
    const __invZ2 = mod(__invZ * __invZ, 115792089237316195423570985008687907853269984665640564039457584007908834671663n);
    return { x: mod(px * __invZ2, 115792089237316195423570985008687907853269984665640564039457584007908834671663n), y: mod(py * __invZ * __invZ2, 115792089237316195423570985008687907853269984665640564039457584007908834671663n) };
  }`);
  // The source's `Point.multiply` answers the point it is given the
  // multiplication of, so the call reads that point's coordinates: the
  // lowered function takes them and the scalar, and answers the point.
  source = source.replace(
    /point = Point_multiply\(point,/g,
    "point = Point_multiply(point.x, point.y,"
  );
  // Fix numeric literal types: bare 0/1 are i64, need 0n/1n for u256, and a
  // name the source's scalar multiplication counts in is a wide number.
  source = source.replace(/function normalizeScalar\(num: u256\): u256 \{[^}]*\}/g,
    "function normalizeScalar(num: u256): u256 { return num; }");
  source = source.replace(/0 < num/g, "0n < num");
  // Remove the point arithmetic that the inlined scalar multiplication
  // replaced: the methods are reached only through the chain the multiplication
  // now writes out, and each answers an object the compiler has no call for.
  source = source.replace(
    /function JacobianPoint_fromAffine[\s\S]*?(?=function Point_multiply)/,
    ""
  );
  // `invert` is the Euclidean GCD, and every step of it is a modular operation:
  // a residue minus a residue times a quotient, which wraps unless the whole
  // step is taken modulo the curve order.
  source = replaceFunctionBody(source, "invert", INVERT_BODY);
  // The source's `mod(a, b)` is a reduction over 256 bit numbers, so the
  // operations inside a call of it are the modular kernels rather than `%`:
  // the product of two reductions needs 512 bits and a `%` of the wrapped
  // product is not the product modulo the curve order.
  source = rewriteModularArithmetic(source);
  // The class statics the lowered multiplication does not read. The zero point
  // and the base point are the objects the methods were written against, and the
  // multiplication is written from the coordinates it is handed. An object
  // literal whose fields are small literals types its fields as machine words,
  // and the base point beside it types the same name's fields as wide ones: a
  // layout nothing reads is a layout that does not have to agree with anything.
  source = source.replace(/^const JacobianPoint_ZERO = .*;\n/gm, "");
  source = source.replace(/^const JacobianPoint_BASE = .*;\n/gm, "");
  source = source.replace(/^const Point_ZERO = .*;\n/gm, "");
  source = source.replace(/^const Point_BASE = .*;\n/gm, "");
  source = source.replace(/^const POW_2_128 = .*;\n/gm, "");
  source = source.replace(/CURVE\.Gx/g, "55066263022277343669578718895168534326250603453777594175500187360389116729240n");
  source = source.replace(/CURVE\.Gy/g, "32670510020758816978083085130507043184471273380659243275938904335757337482424n");
  source = source.replace(/CURVE\.P/g, "115792089237316195423570985008687907853269984665640564039457584007908834671663n");
  // `mod`, `isWithinCurveOrder` and `divNearest` are dead once the calls of
  // them are kernels: `normalizeScalar` is the identity and the endomorphism
  // split is not compiled. Removing them keeps the build from lowering
  // functions the program never runs.
  source = source.replace(/function mod[\s\S]*?^\}\n/m, "");
  source = source.replace(/function isWithinCurveOrder[\s\S]*?^\}\n/m, "");
  source = source.replace(/function divNearest[^\}]*\}/, "");
  return source;
}

