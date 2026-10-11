/**
 * Which model a run asks, and whether it can be asked at all.
 *
 * A run works by one of three methods, and none of them writes a change any
 * more: each gathers what the coding agent is given to read, and the agent
 * writes the change. What every method still needs is a model, and which one
 * is answered the way the compiler answers it — the compiler's own resolver
 * is what says whether a spec can be asked and which key is absent, because a
 * selection the compiler refuses is one a run cannot propose under either.
 */

import { resolveModel } from "../compiler/ai/model.ts";
import type { ProjectInfo } from "./project.ts";

/** The three ways a run works. */
export type Method = "research" | "build-feedback" | "code-review";

/**
 * The model a run would ask, named the way the environment names it.
 */
export function modelSpec(): string | null {
  const spec = process.env["AI_MODEL"];
  return spec === undefined || spec.trim() === "" ? null : spec.trim();
}

/**
 * The model a run asks: the environment's, or the project's own when the
 * environment names none.
 *
 * A project already knows what it is compiled with, so a run aimed at one
 * asks that when `AI_MODEL` is not set — the same model the build it is
 * aimed at would ask.
 */
export function modelToAsk(project?: ProjectInfo): string | null {
  return modelSpec() ?? project?.model ?? null;
}

/**
 * Why no model could be asked, or null when one could be.
 *
 * Every method proposes through a model, so a session that cannot ask one
 * cannot do anything at all. This is asked before the session does anything,
 * because the answer is the same at the start of a run as it is at the end of
 * one — and finding it out at the end means a baseline suite, a project build
 * and three turns of the loop have been spent learning what a look at the
 * environment says.
 */
export function modelProblem(project?: ProjectInfo): string | null {
  const spec = modelToAsk(project);
  if (spec === null) {
    return project === undefined
      ? "no AI_MODEL is set: it names the provider and the model, as anthropic/claude-sonnet-4-5"
      : `no AI_MODEL is set and ${project.tomlPath} names no model`;
  }
  // The compiler's own resolver is what says whether a spec can be asked: it
  // is the same one a build resolves with, and it names the key that is absent.
  try {
    resolveModel(spec, process.env);
    return null;
  } catch (cause) {
    const error = cause as { message?: string; detail?: string };
    const detail = error.detail === undefined ? "" : ` (${error.detail})`;
    return `the model ${spec} cannot be asked: ${error.message ?? String(cause)}${detail}`;
  }
}
