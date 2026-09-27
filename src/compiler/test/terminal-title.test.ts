import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRAND,
  NO_TITLE_ANIMATION,
  SPINNER_FRAMES,
  sanitizeTitlePart,
  settledTitle,
  startBuildTitle,
  streamTitleSink,
  workingTitle,
  type Ticker,
} from "../core/terminal-title.ts";

/** A ticker that only advances when the test says so. */
function manualTicker(): { ticker: Ticker; advance: () => void; cancelled: () => boolean } {
  let tick: (() => void) | undefined;
  let cancelled = false;
  return {
    ticker: (start) => {
      tick = start;
      return () => {
        cancelled = true;
        tick = undefined;
      };
    },
    advance: () => tick?.(),
    cancelled: () => cancelled,
  };
}

test("the working title is the brand, the spinner, then the project", () => {
  const titles = SPINNER_FRAMES.map((_, frame) => workingTitle("hello_world", frame));
  assert.deepEqual(titles, SPINNER_FRAMES.map((glyph) => `${BRAND} ${glyph} hello_world`));
  // A whole loop comes back to where it started, so a long build keeps moving.
  assert.equal(workingTitle("hello_world", SPINNER_FRAMES.length), titles[0]);
  // The brand leads and the spinner follows it, so a tab too narrow for the
  // project still says who is working and that it is working.
  for (const title of titles) {
    assert.ok(title.startsWith(`${BRAND} `));
    assert.ok(SPINNER_FRAMES.includes(title.split(" ")[1] as (typeof SPINNER_FRAMES)[number]));
  }
  assert.equal(workingTitle("", 3), `${BRAND} ${SPINNER_FRAMES[3]}`);
});

test("a settled title keeps the brand and replaces the spinner", () => {
  assert.equal(settledTitle("hello_world", "ok"), `${BRAND} ✓ hello_world`);
  assert.equal(settledTitle("hello_world", "fail"), `${BRAND} ✗ hello_world`);
  assert.equal(settledTitle("", "ok"), `${BRAND} ✓`);
});

test("a label cannot drive the terminal", () => {
  // A project name comes from a directory, so it may hold anything a
  // filesystem accepts, including an escape that would repaint the screen.
  assert.equal(sanitizeTitlePart("a\u001b]0;pwned\u0007b"), "a ]0;pwned b");
  assert.equal(sanitizeTitlePart("  spaced\tout\nname  "), "spaced out name");
  assert.equal(sanitizeTitlePart("x".repeat(80)).length, 48);
  assert.ok(sanitizeTitlePart("x".repeat(80)).endsWith("…"));
});

test("the animation writes each frame once and settles on the outcome", () => {
  const written: string[] = [];
  const { ticker, advance, cancelled } = manualTicker();
  const animation = startBuildTitle("hello_world", { sink: (title) => written.push(title), ticker });

  assert.deepEqual(written, [`${BRAND} ${SPINNER_FRAMES[0]} hello_world`]);
  advance();
  advance();
  assert.deepEqual(written, [
    `${BRAND} ${SPINNER_FRAMES[0]} hello_world`,
    `${BRAND} ${SPINNER_FRAMES[1]} hello_world`,
    `${BRAND} ${SPINNER_FRAMES[2]} hello_world`,
  ]);

  animation.stop("ok");
  assert.equal(written.at(-1), `${BRAND} ✓ hello_world`);
  assert.equal(cancelled(), true);

  // Stopping twice, and a frame after, must not repaint a finished title.
  animation.stop("fail");
  advance();
  assert.equal(written.at(-1), `${BRAND} ✓ hello_world`);
});

test("a build that dies still settles the title", () => {
  const written: string[] = [];
  const { ticker } = manualTicker();
  startBuildTitle("hello_world", { sink: (title) => written.push(title), ticker });
  // The process exits with the animation running, which is what a build that
  // throws, or a Ctrl-C, does.
  process.emit("exit", 1);
  assert.equal(written.at(-1), `${BRAND} ✗ hello_world`);
  // The exit handler is gone, so a later exit is not the animation's business.
  const before = written.length;
  process.emit("exit", 0);
  assert.equal(written.length, before);
});

test("a stream that is not a terminal never receives a title", () => {
  const piped: string[] = [];
  streamTitleSink({ write: (text) => piped.push(text), isTTY: false })("🏗 hello_world");
  assert.deepEqual(piped, []);

  const terminal: string[] = [];
  streamTitleSink({ write: (text) => terminal.push(text), isTTY: true })("hello_world");
  assert.deepEqual(terminal, ["\x1b]0;hello_world\x07"]);
});

test("the no-op animation settles nothing", () => {
  NO_TITLE_ANIMATION.stop("ok");
  NO_TITLE_ANIMATION.stop("fail");
});
