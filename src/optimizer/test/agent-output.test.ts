/**
 * What the coding agent writes, read while it writes it.
 *
 * A run that is asked to show the agent's work asks it in the event mode,
 * because the mode it is otherwise asked in writes its answer at the end and
 * nothing at all on the way. So the stream is read as it arrives, and what
 * comes back out of it is the same answer either way: the text of the last
 * message the agent sent, which is the text the plain mode prints at the end
 * of its work.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentOutput } from "../agent-output.ts";

/** What one event of the agent's stream is, written the way it writes them. */
function event(object: Record<string, unknown>): string {
  return `${JSON.stringify(object)}\n`;
}

/** A run of the agent's stream: what it wrote and what was shown of it. */
function read(
  chunks: readonly string[],
  label = "pi",
): { written: string; summary: string } {
  let shown = "";
  const output = new AgentOutput(true, label, (text) => {
    shown += text;
  });
  for (const chunk of chunks) output.receive(chunk);
  output.finish();
  return { written: shown, summary: output.summary };
}

/** What the agent wrote, given that it is not being watched. */
function kept(chunks: readonly string[]): string {
  const output = new AgentOutput(false, "pi");
  for (const chunk of chunks) output.receive(chunk);
  output.finish();
  return output.summary;
}

test("a tool it calls is shown with what it was given", () => {
  const { written } = read([
    event({ type: "session", version: 3, id: "abc" }),
    event({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/compiler/codegen.ts" } }),
    event({
      type: "tool_execution_start",
      toolCallId: "2",
      toolName: "bash",
      args: { command: "npm run typecheck", timeout: 60000 },
    }),
  ]);

  assert.equal(written, `pi: tool read path=src/compiler/codegen.ts\npi: tool bash command=npm run typecheck timeout=60000\n`);
});

test("what it says is shown, and what it last said is what it hands back", () => {
  const { written, summary } = read([
    event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Reading the code generator." }] },
    }),
    event({ type: "tool_execution_start", toolName: "read", args: { path: "src/compiler/codegen.ts" } }),
    event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "I hoisted the invariant." }] },
    }),
  ]);

  assert.equal(
    written,
    `pi: Reading the code generator.\npi: tool read path=src/compiler/codegen.ts\npi: I hoisted the invariant.\n`,
  );
  // The last thing it said, not the first: it hands back where it got to.
  assert.equal(summary, "I hoisted the invariant.");
});

test("a tool that worked is not answered, and one that failed is", () => {
  const done = event({
    type: "tool_execution_end",
    toolCallId: "1",
    toolName: "bash",
    result: { stdout: "# pass 120", exitCode: 0 },
    isError: false,
  });
  const failed = event({
    type: "tool_execution_end",
    toolCallId: "2",
    toolName: "bash",
    result: { stdout: "error TS2322: Type 'string' is not assignable", exitCode: 2 },
    isError: true,
  });

  const { written } = read([done, failed]);

  // A tool that worked is a tool the next line is about; what it answered is
  // the whole of a build log, and none of that is what it did.
  assert.match(written, /^pi: tool bash failed: stdout=error TS2322/);
  assert.doesNotMatch(written, /# pass 120/);
});

test("a line it writes that is no event is its answer, and is shown", () => {
  // The mode the agent is normally asked in writes the answer and nothing
  // else, so the whole of what it wrote is the answer.
  const { written, summary } = read([`I hoisted the invariant out of the loop.\n`]);

  assert.equal(written, "pi: I hoisted the invariant out of the loop.\n");
  assert.equal(summary, "I hoisted the invariant out of the loop.");
});

test("a chunk is read where it ended rather than where the next one begins", () => {
  const first = event({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
  const second = event({ type: "tool_execution_start", toolName: "read", args: { path: "b.ts" } });
  // Split through the middle of a line, the way a stream delivers it: the
  // chunk does not end where the line does.
  const cut = Math.floor(first.length / 2);

  const { written } = read([first.slice(0, cut), `${first.slice(cut)}${second.slice(0, 10)}`]);

  assert.equal(written, "pi: tool read path=a.ts\n");
});

test("a line the agent was read in the middle of is not shown", () => {
  const whole = event({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
  // The last line of a stream that was cut off is half a line: the agent was
  // killed writing it, and echoing half of it back is reporting nothing.
  const part = event({ type: "tool_execution_start", toolName: "read", args: { path: "b.ts" } });

  const { written, summary } = read([whole, part.slice(0, Math.floor(part.length / 2))]);

  assert.equal(written, "pi: tool read path=a.ts\n");
  assert.equal(summary, "");
});

test("what it wrote is kept whole whether it is shown or not", () => {
  const stream = [
    event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "A focused change." }] },
    }),
    event({ type: "tool_execution_start", toolName: "edit", args: { path: "src/compiler/codegen.ts" } }),
  ];

  assert.equal(kept(stream), "A focused change.");
  // The same answer is read out of the same stream either way.
  assert.equal(read(stream).summary, "A focused change.");
});

test("a run that is not watching writes nothing", () => {
  const output = new AgentOutput(false, "pi", (text) => {
    throw new Error(`nothing should have been written: ${text}`);
  });
  output.receive(event({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } }));
  output.finish();
  assert.equal(output.summary, "");
});

test("what a tool was given is cut where a line ends", () => {
  const long = "let total = 0;\n".repeat(40);
  const { written } = read([
    event({ type: "tool_execution_start", toolName: "edit", args: { path: "src/compiler/codegen.ts", new_string: long } }),
  ]);

  // The change is on the stream whole, and a line showing all of it is a line
  // nobody reads: one path, and a marker for the rest.
  assert.match(written, /path=src\/compiler\/codegen\.ts new_string=(let total = 0; )+\.\.\.\n$/);
  assert.equal(written.split("\n")[0]!.length < 240, true);
});

test("the lines are labelled with the command that wrote them", () => {
  const { written } = read([event({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } })], "pi-coding");

  assert.equal(written, "pi-coding: tool read path=a.ts\n");
});

test("what it said besides its answer is written as it came", () => {
  let shown = "";
  const output = new AgentOutput(true, "pi", (text) => {
    shown += text;
  });
  output.diagnostic("No API key found for the selected model.\n");

  // Diagnostics are its own words already, so they are not read apart and put
  // back together.
  assert.equal(shown, "No API key found for the selected model.\n");
});
