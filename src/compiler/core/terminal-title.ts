/**
 * A terminal re-renders its tab on every title change, so writing OSC 0
 * escapes on a timer animates the tab without touching what the command
 * prints. The title is the blaze brand, then a spinner glyph, then the
 * project: the two leading cells are what stay visible when a tab is too
 * narrow for the rest.
 *
 * A title is read from a directory name, so every character is sanitized
 * before it becomes an escape: a name holding a control character would
 * otherwise be able to drive the terminal.
 */

import { clearInterval, hostOnExit, hostOnSignal, hostRaiseSignal, hostStdoutIsTTY, hostWriteOut, setInterval } from "./platform.ts";

/** What blaze calls itself in a tab, whatever it is doing. */
export const BRAND = "B";
/** The brand blazeup uses in a tab: the blaze brand with "up" just after it. */
export const BLAZEUP_BRAND = "Bup";
export const BLAZEUP = BLAZEUP_BRAND;
export const BUP = BLAZEUP_BRAND;
export const BUP_BRAND = BLAZEUP_BRAND;
export const UP_BRAND = BLAZEUP_BRAND;
export const BRAND_UP = BLAZEUP_BRAND;
export const BLAZE_UP_BRAND = BLAZEUP_BRAND;
export const OPTIMIZER_BRAND = BLAZEUP_BRAND;

/** The spinner, the way an interactive agent animates its own title. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Fast enough to read as motion, slow enough not to strobe. */
export const SPINNER_FRAME_MS = 80;

/** How much of the label a tab can show before it stops being a title. */
const MAX_LABEL = 48;

const OSC = "\x1b]0;";
const BEL = "\x07";

/** Whether a build ended in an object or in a diagnostic. */
export type BuildOutcome = "ok" | "fail";

/** Where a finished title goes, injected so the animation is testable. */
export type TitleSink = (title: string) => void;

/** Starts a repeating call and returns its cancel, injected for the same reason. */
export type Ticker = (tick: () => void, ms: number) => () => void;

export interface TitleAnimation {
  /**
   * Settle the title on the outcome and release everything the animation
   * holds. Idempotent, so an exit handler and the command can both call it.
   */
  stop(outcome: BuildOutcome): void;
}

/** Settles a title at the outcome the command reached. */
export function stopTitleAnimation(animation: TitleAnimation, outcome: BuildOutcome): void {
  animation.stop(outcome);
}

/** The animation for a command that must not touch the terminal. */
export const NO_TITLE_ANIMATION: TitleAnimation = { stop: () => {} };

/**
 * A title part with nothing a terminal can be made to run in it: control
 * characters become spaces, and what is left is one line of at most
 * {@link MAX_LABEL} characters.
 */
export function sanitizeTitlePart(value: string): string {
  const printable = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (printable.length <= MAX_LABEL) return printable;
  // Truncating by code unit can cut a surrogate pair in half, and an unpaired
  // half reaches the terminal as a replacement box rather than the character.
  const cut = [...printable].slice(0, MAX_LABEL - 1).join("");
  return `${cut}…`;
}

/** The tab title while a build works: brand, spinner, project. */
export function workingTitle(label: string, frame: number, brand?: string): string;
export function workingTitle(brand: string, label: string, frame: number): string;
export function workingTitle(...args: any[]): string {
  let resolvedBrand = BRAND;
  let label: string;
  let frame: number;
  if (args.length >= 3) {
    if (typeof args[1] === "number") {
      label = args[0];
      frame = args[1];
      resolvedBrand = args[2] ?? BRAND;
    } else {
      resolvedBrand = args[0] ?? BRAND;
      label = args[1];
      frame = args[2];
    }
  } else {
    label = args[0];
    frame = args[1];
  }
  const glyph = SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
  return label === "" ? `${resolvedBrand} ${glyph}` : `${resolvedBrand} ${glyph} ${label}`;
}

/**
 * The tab title once a build has stopped, which no longer animates. The
 * spinner is replaced by what it was spinning for, and the brand stays.
 */
export function settledTitle(label: string, outcome: BuildOutcome, brand?: string): string;
export function settledTitle(brand: string, label: string, outcome: BuildOutcome): string;
export function settledTitle(...args: any[]): string {
  let resolvedBrand = BRAND;
  let label: string;
  let outcome: BuildOutcome;
  if (args.length >= 3) {
    if (args[1] === "ok" || args[1] === "fail") {
      label = args[0];
      outcome = args[1];
      resolvedBrand = args[2] ?? BRAND;
    } else {
      resolvedBrand = args[0] ?? BRAND;
      label = args[1];
      outcome = args[2];
    }
  } else {
    label = args[0];
    outcome = args[1];
  }
  const mark = outcome === "ok" ? "✓" : "✗";
  return label === "" ? `${resolvedBrand} ${mark}` : `${resolvedBrand} ${mark} ${label}`;
}

/** The terminal title is one OSC 0 escape terminated by BEL. */
export function oscTitle(title: string): string {
  return `${OSC}${title}${BEL}`;
}

/** Write a title to a stream, and to nothing when the stream is not a terminal. */
export function streamTitleSink(stream: { write(text: string): unknown; isTTY?: boolean }): TitleSink {
  return (title) => {
    if (stream.isTTY !== true) return;
    stream.write(oscTitle(title));
  };
}

function intervalTicker(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}

/**
 * Animate the tab title until it is stopped.
 *
 * The animation settles on every way out of the process, including a signal:
 * a title left mid-spinner after a Ctrl-C would outlive the build and say the
 * build is still running. A handled signal is re-raised without the handler
 * so the process still dies of it.
 */
export function startBuildTitle(
  label: string,
  dependencies?: { sink?: TitleSink; ticker?: Ticker; brand?: string },
): TitleAnimation;
export function startBuildTitle(
  label: string,
  brand: string,
  dependencies?: { sink?: TitleSink; ticker?: Ticker },
): TitleAnimation;
export function startBuildTitle(...args: any[]): TitleAnimation {
  let label: string;
  let dependencies: { sink?: TitleSink; ticker?: Ticker; brand?: string } = {};
  let resolvedBrand = BRAND;
  if (args.length >= 2 && typeof args[1] === "string") {
    label = args[0];
    resolvedBrand = args[1] ?? BRAND;
    dependencies = args[2] ?? {};
  } else {
    label = args[0];
    dependencies = args[1] ?? {};
    resolvedBrand = dependencies.brand ?? BRAND;
  }
  const name = sanitizeTitlePart(label);
  const sink = dependencies.sink ?? streamTitleSink({ write: hostWriteOut, isTTY: hostStdoutIsTTY() });
  const ticker = dependencies.ticker ?? intervalTicker;
  let frame = 0;
  let cancel: (() => void) | undefined;
  let stopped = false;
  let last: string | undefined;

  const emit = (title: string): void => {
    // The tab is repainted even for an unchanged title, and a build is
    // quieter for it.
    if (title === last) return;
    last = title;
    sink(title);
  };

  let detachExit: () => void = () => {};
  let detachInterrupt: () => void = () => {};
  let detachTerminate: () => void = () => {};

  const detach = (): void => {
    detachExit();
    detachInterrupt();
    detachTerminate();
  };

  const settle = (outcome: BuildOutcome): void => {
    if (stopped) return;
    stopped = true;
    cancel?.();
    emit(settledTitle(name, outcome, resolvedBrand));
    detach();
  };

  function onExit(): void {
    settle("fail");
  }

  function onInterrupt(): void {
    settle("fail");
    hostRaiseSignal("SIGINT");
  }

  function onTerminate(): void {
    settle("fail");
    hostRaiseSignal("SIGTERM");
  }

  emit(workingTitle(name, frame, resolvedBrand));
  cancel = ticker(() => {
    frame += 1;
    emit(workingTitle(name, frame, resolvedBrand));
  }, SPINNER_FRAME_MS);
  // A host that cannot register a handler still shows the working title; it
  // simply cannot settle it from a signal, and the process's own exit ends
  // the animation with it.
  detachExit = hostOnExit(onExit);
  detachInterrupt = hostOnSignal("SIGINT", onInterrupt);
  detachTerminate = hostOnSignal("SIGTERM", onTerminate);

  return { stop: settle };
}
