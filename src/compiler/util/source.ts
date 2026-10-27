/**
 * Reading a source as code.
 *
 * Several decisions a build makes are decisions about what a program *runs*:
 * whether it starts an HTTP server, whether it asks a server over TLS, whether
 * it calls into the SQLite facility. Each of them is read off the source today
 * with a regular expression, and a regular expression cannot tell code from
 * the prose beside it — so a comment that cites a URL was read as a program
 * that serves HTTP, and a program whose comments carry links was linked
 * against a server runtime and OpenSSL it never calls. That is a cost the
 * program pays at every run: two libraries loaded, a table of connections
 * allocated, and a binary hundreds of kilobytes larger than the code in it.
 *
 * The two functions here answer the question the regular expressions wanted to
 * ask. `withoutComments` takes the prose out and leaves the literals, and
 * `codeOnly` takes the literals out as well. Both keep the length of the
 * source roughly as it was — a comment is replaced by spaces and its newlines
 * are kept — so a line number read from either still names the line of the
 * original.
 */

/**
 * Whether a source character starts a string literal rather than code.
 *
 * Backtick is listed as a string because a template literal is one: the part
 * of it between backticks is data, and only an interpolation inside `${}` is
 * code. `withoutComments` walks the interpolation as code and returns to the
 * literal at the brace that closes it.
 */
function quoteOf(character: string): string | null {
  return character === '"' || character === "'" || character === "`" ? character : null;
}

/** The source with its comments blanked out, and its literals left as they are. */
export function withoutComments(source: string): string {
  return scan(source, false);
}

/**
 * The source with its comments and its string literals blanked out.
 *
 * This is the form a question about *what a program does* is asked of: the
 * word "http" in a comment and the word "http" in a string are not a program
 * that serves HTTP, and they are how a program that prints documentation was
 * once given the server runtime. A literal is blanked rather than removed so
 * that what is left has the shape of the program around it.
 */
export function codeOnly(source: string): string {
  return scan(source, true);
}

/** The one walk both readers share, with a flag for whether literals stay. */
function scan(source: string, blankLiterals: boolean): string {
  const out: string[] = [];
  let at = 0;
  while (at < source.length) at = scanOne(source, at, out, blankLiterals);
  return out.join("");
}

/** One quoted string, escapes and all. */
function walkString(source: string, start: number, quote: string, out: string[], blank: boolean): number {
  // The quotes stay even where the bytes they surround do not: a reader of the
  // blanked source can still see that a literal was here, and the width of the
  // source is the width it was.
  out.push(quote);
  let at = start + 1;
  while (at < source.length) {
    const character = source[at] as string;
    if (character === "\\" && at + 1 < source.length) {
      out.push(blank ? " " : character, blank ? " " : (source[at + 1] as string));
      at += 2;
      continue;
    }
    if (character === quote) {
      out.push(quote);
      return at + 1;
    }
    out.push(blank && character !== "\n" ? " " : character);
    at += 1;
  }
  return at;
}

/** One template literal, whose interpolations are walked as code. */
function walkTemplate(source: string, start: number, out: string[], blank: boolean): number {
  out.push("`");
  let at = start + 1;
  while (at < source.length) {
    const character = source[at] as string;
    if (character === "\\" && at + 1 < source.length) {
      out.push(blank ? " " : character, blank ? " " : (source[at + 1] as string));
      at += 2;
      continue;
    }
    if (character === "`") {
      out.push("`");
      return at + 1;
    }
    if (character === "$" && source[at + 1] === "{") {
      out.push("$", "{");
      at += 2;
      let depth = 1;
      while (at < source.length) {
        const inner = source[at] as string;
        if (inner === "{") depth += 1;
        if (inner === "}") {
          depth -= 1;
          if (depth === 0) {
            out.push("}");
            at += 1;
            break;
          }
        }
        // The inside of an interpolation is code: a comment or a literal in it
        // is read the same way the same text in the program would be.
        const next = scanOne(source, at, out, blank);
        at = next;
      }
      continue;
    }
    out.push(blank && character !== "\n" ? " " : character);
    at += 1;
  }
  return at;
}

/**
 * One step of the walk inside an interpolation, which is the walk of the whole
 * source again for the one character it is on: a comment, a literal or a
 * character of code, with the index it stopped at.
 */
function scanOne(source: string, at: number, out: string[], blank: boolean): number {
  const character = source[at] as string;
  if (character === "/" && source[at + 1] === "/") {
    while (at < source.length && source[at] !== "\n") {
      out.push(" ");
      at += 1;
    }
    return at;
  }
  if (character === "/" && source[at + 1] === "*") {
    out.push(" ", " ");
    at += 2;
    while (at < source.length && !(source[at] === "*" && source[at + 1] === "/")) {
      out.push(source[at] === "\n" ? "\n" : " ");
      at += 1;
    }
    if (at < source.length) {
      out.push(" ", " ");
      at += 2;
    }
    return at;
  }
  const quote = quoteOf(character);
  if (quote === "`") return walkTemplate(source, at, out, blank);
  if (quote !== null) return walkString(source, at, quote, out, blank);
  out.push(character);
  return at + 1;
}
