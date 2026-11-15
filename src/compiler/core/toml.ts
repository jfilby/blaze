/**
 * The TOML parser the compiler reads a project with.
 *
 * The project files a build reads are a small TOML surface: tables, string,
 * number and boolean values, arrays, inline tables and comments. This parser
 * reads that surface directly so a compiled compiler does not have to carry a
 * package whose writer needs a host global.
 */

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldOn(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}

class TomlReader {
  private readonly text: string;
  private at = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let table = root;
    while (this.at < this.text.length) {
      this.skip();
      if (this.at >= this.text.length) break;
      if (this.peek(0) === "[") {
        table = this.readTable(root);
        continue;
      }
      const key = this.readKey();
      this.skip();
      if (this.peek(0) !== "=") this.fail("expected = after a key");
      this.at += 1;
      this.skip();
      const value = this.readValue();
      setFieldOn(table, key, value);
      this.skip();
    }
    return root;
  }

  private peek(offset: number): string {
    return this.text.slice(this.at + offset, this.at + offset + 1);
  }

  private skip(): void {
    while (this.at < this.text.length) {
      const c = this.peek(0);
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.at += 1;
        continue;
      }
      if (c === "#") {
        while (this.at < this.text.length && this.peek(0) !== "\n") this.at += 1;
        continue;
      }
      break;
    }
  }

  private readTable(root: Record<string, unknown>): Record<string, unknown> {
    this.at += 1;
    const arrayTable = this.peek(0) === "[";
    if (arrayTable) this.at += 1;
    const parts: string[] = [];
    for (;;) {
      this.skip();
      const key = this.readKey();
      parts[parts.length] = key;
      this.skip();
      if (this.peek(0) === ".") {
        this.at += 1;
        continue;
      }
      break;
    }
    if (this.peek(0) !== "]") this.fail("expected ] after a table name");
    this.at += 1;
    if (arrayTable) {
      if (this.peek(0) !== "]") this.fail("expected ]] after a table name");
      this.at += 1;
    }
    let table = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] as string;
      const last = index === parts.length - 1;
      const held = fieldOf(table, part);
      if (last && arrayTable) {
        let list = held as unknown[] | undefined;
        if (list === undefined) {
          list = [];
          setFieldOn(table, part, list);
        }
        const made: Record<string, unknown> = {};
        list[list.length] = made;
        table = made;
        continue;
      }
      if (held === undefined) {
        const made: Record<string, unknown> = {};
        setFieldOn(table, part, made);
        table = made;
        continue;
      }
      table = held as Record<string, unknown>;
    }
    return table;
  }

  private readKey(): string {
    const quote = this.peek(0);
    if (quote === '"' || quote === "'") return this.readString();
    const start = this.at;
    while (this.at < this.text.length) {
      const c = this.peek(0);
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "=" || c === "." || c === "]" || c === ",") break;
      this.at += 1;
    }
    if (this.at === start) this.fail("expected a key");
    return this.text.slice(start, this.at);
  }

  private readValue(): unknown {
    const c = this.peek(0);
    if (c === '"' || c === "'") return this.readString();
    if (c === "[") return this.readArray();
    if (c === "{") return this.readInlineTable();
    if (this.text.slice(this.at, this.at + 4) === "true") {
      this.at += 4;
      return true;
    }
    if (this.text.slice(this.at, this.at + 5) === "false") {
      this.at += 5;
      return false;
    }
    return this.readNumber();
  }

  private readString(): string {
    const quote = this.peek(0);
    this.at += 1;
    let out = "";
    while (this.at < this.text.length) {
      const c = this.peek(0);
      if (c === quote) {
        this.at += 1;
        return out;
      }
      if (c === "\\" && quote === '"') {
        const next = this.peek(1);
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === "r") out += "\r";
        else if (next === '"') out += '"';
        else if (next === "\\") out += "\\";
        else out += next;
        this.at += 2;
        continue;
      }
      out += c;
      this.at += 1;
    }
    this.fail("unterminated string");
    return "";
  }

  private readNumber(): number {
    const start = this.at;
    while (this.at < this.text.length) {
      const c = this.peek(0);
      if ((c >= "0" && c <= "9") || c === "+" || c === "-" || c === "." || c === "e" || c === "E" || c === "_") this.at += 1;
      else break;
    }
    if (this.at === start) this.fail("expected a value");
    let text = this.text.slice(start, this.at);
    text = text.split("_").join("");
    const value = Number(text);
    if (Number.isNaN(value)) this.fail("expected a number");
    return value;
  }

  private readArray(): unknown[] {
    this.at += 1;
    const out: unknown[] = [];
    for (;;) {
      this.skip();
      if (this.peek(0) === "]") {
        this.at += 1;
        return out;
      }
      out[out.length] = this.readValue();
      this.skip();
      if (this.peek(0) === ",") {
        this.at += 1;
        continue;
      }
      if (this.peek(0) !== "]") this.fail("expected , or ] in an array");
    }
  }

  private readInlineTable(): Record<string, unknown> {
    this.at += 1;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skip();
      if (this.peek(0) === "}") {
        this.at += 1;
        return out;
      }
      const key = this.readKey();
      this.skip();
      if (this.peek(0) !== "=") this.fail("expected = in an inline table");
      this.at += 1;
      this.skip();
      setFieldOn(out, key, this.readValue());
      this.skip();
      if (this.peek(0) === ",") {
        this.at += 1;
        continue;
      }
      if (this.peek(0) !== "}") this.fail("expected , or } in an inline table");
    }
  }

  private fail(message: string): void {
    throw new Error(`TOML: ${message} at offset ${this.at}`);
  }
}

export function parse(text: string): Record<string, unknown> {
  return new TomlReader(text).parse();
}
