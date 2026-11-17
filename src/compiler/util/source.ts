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

/**
 * Where the walk writes its answer.
 *
 * A source is walked a character at a time, but an array holding one entry per
 * character is a large transient allocation for a long source: the readers here
 * are asked about every source of a program, and a build of a large program
 * holds those arrays, one after another, while it decides which runtime to
 * link. Batching the characters into chunks keeps the same answer without the
 * per-character array: `push` appends to a chunk and flushes it when it is full,
 * and `finish` joins the few chunks that are left.
 */
interface Emitter {
  push(...text: string[]): void;
  finish(): string;
}

/** An emitter that batches characters into bounded chunks. */
function emitter(): Emitter {
  const chunks: string[] = [];
  let chunk = "";
  return {
    push(...text: string[]): void {
      for (const piece of text) chunk += piece;
      if (chunk.length >= 4096) {
        chunks.push(chunk);
        chunk = "";
      }
    },
    finish(): string {
      if (chunk.length > 0) chunks.push(chunk);
      return chunks.join("");
    },
  };
}

/** The one walk both readers share, with a flag for whether literals stay. */
function scan(source: string, blankLiterals: boolean): string {
  const out = emitter();
  let at = 0;
  while (at < source.length) at = scanOne(source, at, out, blankLiterals);
  return out.finish();
}

/** One quoted string, escapes and all. */
function walkString(source: string, start: number, quote: string, out: Emitter, blank: boolean): number {
  // The quotes stay even where the bytes they surround do not: a reader of the
  // blanked source can still see that a literal was here, and the width of the
  // source is the width it was.
  out.push(quote);
  let at = start + 1;
  while (at < source.length) {
    const character = source.slice(at, at + 1);
    if (character === "\\" && at + 1 < source.length) {
      out.push(blank ? " " : character, blank ? " " : source.slice(at + 1, at + 2));
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
function walkTemplate(source: string, start: number, out: Emitter, blank: boolean): number {
  out.push("`");
  let at = start + 1;
  while (at < source.length) {
    const character = source.slice(at, at + 1);
    if (character === "\\" && at + 1 < source.length) {
      out.push(blank ? " " : character, blank ? " " : source.slice(at + 1, at + 2));
      at += 2;
      continue;
    }
    if (character === "`") {
      out.push("`");
      return at + 1;
    }
    if (character === "$" && source.slice(at + 1, at + 2) === "{") {
      out.push("$", "{");
      at += 2;
      let depth = 1;
      while (at < source.length) {
        const inner = source.slice(at, at + 1);
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
function scanOne(source: string, at: number, out: Emitter, blank: boolean): number {
  const character = source.slice(at, at + 1);
  if (character === "/" && source.slice(at + 1, at + 2) === "/") {
    while (at < source.length && source.slice(at, at + 1) !== "\n") {
      out.push(" ");
      at += 1;
    }
    return at;
  }
  if (character === "/" && source.slice(at + 1, at + 2) === "*") {
    out.push(" ", " ");
    at += 2;
    while (at < source.length && !(source.slice(at, at + 1) === "*" && source.slice(at + 1, at + 2) === "/")) {
      out.push(source.slice(at, at + 1) === "\n" ? "\n" : " ");
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
