/**
 * What the coding agent writes, while it writes it.
 *
 * The agent is asked in print mode: one prompt, it works with its own tools
 * for as long as it takes, and what it says about its work arrives at the
 * end. The mode it is normally asked in writes that answer and nothing else,
 * so a run that wants to watch it work asks in the event mode instead
 * (`--mode json`), which carries every tool it calls as it calls it — a read
 * of the file it is about to change is on the stream when it reads it, not
 * when it has finished.
 *
 * What comes back is read the same way either way, because it is the same
 * answer: the text of the last message the agent sent. In the plain mode
 * that is the whole of what it wrote, and here it is the same text read out
 * of the last assistant message — the very text the plain mode prints at
 * the end of its work.
 *
 * The stream is read as it arrives rather than kept whole and read at the
 * end, for two reasons: a line is written out while the agent is still
 * working on the next one, which is the whole of what watching it is; and a
 * tool call carries the file it read with it, so keeping the stream is
 * keeping a copy of the compiler in memory to read one line out of.
 *
 * Whether a run is watching is the one question here, and it decides both
 * halves: the event mode is asked only so that the work can be shown, and
 * what a run is not watching is read exactly as it was read before there was
 * anything to watch — the answer, and nothing else.
 */

/** How much of one value is written beside the tool that was given it. */
const VALUE_BUDGET = 120;

/** How much of what a tool was given is written on one line. */
const ARGUMENT_BUDGET = 240;

/** What the agent wrote, read line by line as it wrote it. */
export class AgentOutput {
  /** A line that is not whole yet, which the next chunk ends. */
  private pending = "";
  /** What it wrote that was no event: its answer in the plain mode. */
  private raw = "";
  /** The last thing it said, which is what it hands back. */
  private answer = "";
  /** Whether it was asked in the event mode, which is what it is shown as. */
  private readonly shown: boolean;
  /** What its lines are labelled with, which is the command it is asked as. */
  private readonly label: string;
  /** Where it writes, which is the run's own console. */
  private readonly write: (text: string) => void;

  /**
   * @param shown Whether it was asked in the event mode and what it does is
   *   written out as it does it: the event mode is asked only to be shown
   * @param label What its lines are labelled with
   * @param write Where it writes, for a run that has somewhere else to put it
   */
  constructor(
    shown: boolean,
    label: string,
    write: (text: string) => void = (text) => {
      process.stdout.write(text);
    },
  ) {
    this.shown = shown;
    this.label = label;
    this.write = write;
  }

  /** One chunk of what it wrote. */
  receive(chunk: string): void {
    const lines = (this.pending + chunk).split("\n");
    // The last of them is the one the chunk ended in the middle of.
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.readLine(line);
  }

  /** It wrote no more, so the line it left is the whole of it. */
  finish(): void {
    if (this.pending === "") return;
    const line = this.pending;
    this.pending = "";
    // A line it was killed in the middle of is not a line it wrote: in the
    // event mode a whole line is an event, and half of one says nothing.
    if (this.shown && eventOf(line) === null) return;
    this.readLine(line);
  }

  /** What the agent says it did, which is what a run records it as having said. */
  get summary(): string {
    return this.answer !== "" ? this.answer : this.raw.trim();
  }

  /**
   * One chunk of what it said besides its answer.
   *
   * Diagnostics are its own words already — the error it could not ask a
   * model with, the key that is missing — so they are written out as they
   * came rather than read apart and put back together.
   */
  diagnostic(chunk: string): void {
    if (!this.shown) return;
    this.write(chunk);
  }

  /** One whole line of what it wrote. */
  private readLine(line: string): void {
    const event = eventOf(line);
    if (event === null) {
      // Not an event: what the agent writes when it was not asked in the
      // event mode, which is the answer and the whole of it.
      this.raw += `${line}\n`;
      this.emit(line);
      return;
    }

    switch (event["type"]) {
      case "message_end": {
        const said = saidText(event["message"]);
        // The last thing it said is what it hands back, so an earlier one is
        // replaced rather than kept beside it.
        if (said !== "") this.answer = said;
        this.emit(said);
        break;
      }
      case "tool_execution_start": {
        const tool = text(event["toolName"]);
        const given = givenText(event["args"]);
        this.emit(given === "" ? `tool ${tool}` : `tool ${tool} ${given}`);
        break;
      }
      case "tool_execution_end": {
        // What a tool answered is on the stream whole: a file it read, a
        // build log, a test run. That is more than a line of what it did is
        // worth, so it is written when it went wrong and dropped when it did
        // not — a tool that worked is a tool the next line is about.
        if (event["isError"] === true) {
          this.emit(`tool ${text(event["toolName"])} failed: ${givenText(event["result"])}`);
        }
        break;
      }
      case "auto_retry_start":
        this.emit(`retrying: ${text(event["errorMessage"])}`);
        break;
      default:
        // Everything else on the stream is the agent's own bookkeeping —
        // when a turn starts, when it ends, what the model said one token at
        // a time — and none of it is what it did.
        break;
    }
  }

  /** Write one line of what it did, labelled with the command that did it. */
  private emit(line: string): void {
    if (!this.shown) return;
    const trimmed = line.trim();
    if (trimmed === "") return;
    this.write(`${this.label}: ${trimmed}\n`);
  }
}

/** One object read out of a line of what the agent wrote, or null. */
function eventOf(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One field of an event, as the text it holds. */
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** What one message said, which is the text of it and nothing else. */
function saidText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  if (text((message as { role?: unknown }).role) !== "assistant") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const piece = part as { type?: unknown; text?: unknown };
    if (text(piece.type) !== "text") continue;
    const said = text(piece.text);
    if (said !== "") parts.push(said);
  }
  return parts.join("\n");
}

/**
 * What a tool was given, on one line.
 *
 * The arguments are an object of them — a path, a command, the text of an
 * edit — and each is said by name with its value on one line. What a value
 * holds is cut where a line ends rather than left to run down the console:
 * an edit carries the whole of the change, and a line that shows all of it
 * is a line nobody reads.
 */
function givenText(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return oneLine(args);
  const parts: string[] = [];
  for (const [name, value] of Object.entries(args as Record<string, unknown>)) {
    const shown = oneLine(value);
    if (shown === "") continue;
    parts.push(`${name}=${shown}`);
  }
  return cut(parts.join(" "), ARGUMENT_BUDGET);
}

/** One value, on one line, with a marker for where it was cut. */
function oneLine(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : text(value);
  return cut(raw.replace(/\s+/g, " "), VALUE_BUDGET);
}

/** A text, and a marker for what was left out of it. */
function cut(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget)}...`;
}
