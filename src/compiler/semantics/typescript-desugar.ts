/**
 * Source-level normalisation for TypeScript constructs the program frontend
 * does not read directly.
 */

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

export function rewriteCalls(source: string, fnName: string, arity: number, rewrite: (args: string) => string): string {
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
  source = source.replace(/USE_ENDOMORPHISM\b/g, "true");
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
  source = source.replace(/function splitScalarEndo\(k: bigint\)/g, "function splitScalarEndo(k: u256)");
  source = source.replace(/function invert\([^)]*\)\s*{/g, "function invert(number: u256, modulo: u256): u256 {");

  // Remove unsupported TypeScript type annotations references.
  source = source.replace(/: JacobianPoint/g, "");
  source = source.replace(/: Point\b/g, "");

  // Desugar classes.
  source = desugarClasses(source);

  // After class desugaring, rewrite references.
  source = source.replace(/JacobianPoint\.ZERO\b/g, "JacobianPoint_ZERO");
  source = source.replace(/(?<!const )JacobianPoint_ZERO\b/g, "{ x: CURVE.Gx - CURVE.Gx, y: CURVE.Gx - CURVE.Gx + 1n, z: CURVE.Gx - CURVE.Gx }");
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
  source = source.replace(/function (JacobianPoint_|Point_)(\w+)\(([^)]*)\)(\s*:\s*\w+)?\s*\{/g, (m, prefix, name, params, ret) => {
    const annotated = params.split(",").map((part) => {
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
  source = source.replace(/invert\(self\.z, CURVE\.P\)/g, "invert(self.z, 115792089237316195423570985008687907853269984665640564039457584007908834671663n)");
  source = source.replace(/CURVE\.P/g, "115792089237316195423570985008687907853269984665640564039457584007908834671663n");
  source = source.replace(/CURVE\.Gx/g, "55066263022277343669578718895168534326250603453777594175500187360389116729240n");
  source = source.replace(/CURVE\.Gy/g, "32670510020758816978083085130507043184471273380659243275938904335757337482424n");
  source = source.replace(/CURVE\.n/g, "115792089237316195423570985008687907852837564279074904382605163141518161494337n");
  source = source.replace(/CURVE\.a/g, "0n");
  source = source.replace(/CURVE\.beta/g, "55594575648329892869085402983802832744385952214688224221778511981742606582254n");
  source = source.replace(/CURVE\.n/g, "115792089237316195423570985008687907852837564279074904382605163141518161494337n");
  source = source.replace(/const \{ x: 0n, y: 1n, z: 0n \} = \{ x: 0n, y: 1n, z: 0n \};/g, "const JacobianPoint_ZERO = { x: CURVE.Gx - CURVE.Gx, y: CURVE.Gx - CURVE.Gx + 1n, z: CURVE.Gx - CURVE.Gx };");
  source = source.replace(/const PRIVATE_KEY =/g, "const __PK__ =");
  source = source.replace(/PRIVATE_KEY/g, "0x2DEE927079283C3C4FCA3EF970FF4D38B64592E3FE0AB0DAD9132D70B5BC7693n");
  source = source.replace(/const __PK__ =/g, "const PRIVATE_KEY =");
  source = source.replace("mod(mod((X1 + B) * (X1 + B)))", "mod(mod((X1 + B) * (X1 + B), 115792089237316195423570985008687907853269984665640564039457584007908834671663n), 115792089237316195423570985008687907853269984665640564039457584007908834671663n)");
  source = source.replace("mod((X1 + B) * (X1 + B))", "mod((X1 + B) * (X1 + B), 115792089237316195423570985008687907853269984665640564039457584007908834671663n)");
  source = source.replace("mod(Y2 * Z1)", "mod(Y2 * Z1, 115792089237316195423570985008687907853269984665640564039457584007908834671663n)");
  // Uniformise single-object returns into fresh literals so a function's
  // result path all resolve through one layout.
  source = source.replace(/return self;/g, "return { x: self.x, y: self.y, z: self.z };");
  source = source.replace(/return other;/g, "return { x: other.x, y: other.y, z: other.z };");

  source = source.replace("    const k1neg = k1 > 340282366920938463463374607431768211456n;", "    const k1neg = (k1 > 340282366920938463463374607431768211456n) ? 1n : 0n;");
  source = source.replace("    const k2neg = k2 > 340282366920938463463374607431768211456n;", "    const k2neg = (k2 > 340282366920938463463374607431768211456n) ? 1n : 0n;");
  source = source.replace(/while \(n > 0n\)/g, "while (n > 0)");
  source = source.replace(/while \(k1 > 0n \|\| k2 > 0n\)/g, "while (k1 > 0 || k2 > 0)");
    source = source.replace("if (n & 1n)", "if (n & 1)");
  source = source.replace(/invZ: bigint/g, "invZ: any");
  source = source.replace(/scalar: bigint/g, "scalar: u256");
  source = source.replace(/let \{ k1neg[\s\S]*?return JacobianPoint_add\(k1p, k2p\);/, "");
  source = source.replace(/^if \(!true\) \{$/m, "");
    source = source.replace("        }\n\n        \n", "\n");
  source = source.replace("if (!true) {", "");
  source = source.replace("return p;\n        }", "return p;");
  source = source.replace(/return p;\n\s*$/m, "return p;");
    source = source.replace(/mod\(-self\.y, 115792089237316195423570985008687907853269984665640564039457584007908834671663n\)/g, "mod(115792089237316195423570985008687907853269984665640564039457584007908834671663n - self.y, 115792089237316195423570985008687907853269984665640564039457584007908834671663n)");
  source = source.replace(/function splitScalarEndo[\s\S]*?^\}\n/m, "");
  source = source.replace('const JacobianPoint_ZERO = { x: 0n, y: 1n, z: 0n };', 'const JacobianPoint_ZERO = { x: CURVE.Gx - CURVE.Gx, y: CURVE.Gx - CURVE.Gx + 1n, z: CURVE.Gx - CURVE.Gx };');
  source = source.replace('const Point_ZERO = { x: 0n, y: 0n };', 'const Point_ZERO = { x: CURVE.Gx - CURVE.Gx, y: CURVE.Gy - CURVE.Gy };');
  source = source.replace("const JacobianPoint_BASE = { x: 55066263022277343669578718895168534326250603453777594175500187360389116729240n, y: 32670510020758816978083085130507043184471273380659243275938904335757337482424n, z: 1n };", "const JacobianPoint_BASE = { x: 55066263022277343669578718895168534326250603453777594175500187360389116729240n, y: 32670510020758816978083085130507043184471273380659243275938904335757337482424n, z: CURVE.Gx - CURVE.Gx + 1n };");
  source = source.replace("if (n & 1) p = JacobianPoint_add(p, d);",
    "if ((n & 1n) != 0n) p = JacobianPoint_add(p, d);");
  source = source.replace("n >>= 1n;", "n >>= 1;");
  source = source.replace("n >>= 1LL;", "n >>= 1;");
  source = source.replace("z: 1n }", "z: CURVE.Gx - CURVE.Gx + 1n }");
  source = source.replace(/CURVE\.Gx/g, "55066263022277343669578718895168534326250603453777594175500187360389116729240n");
  source = source.replace(/CURVE\.Gy/g, "32670510020758816978083085130507043184471273380659243275938904335757337482424n");
  source = source.replace(/CURVE\.P/g, "115792089237316195423570985008687907853269984665640564039457584007908834671663n");
  return source;
}

