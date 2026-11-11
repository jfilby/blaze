/**
 * Comparing two build records.
 *
 * A fixed point is not byte equality of binaries: it is the same decisions
 * reached by two stages. The record of a build is those decisions written
 * down, so comparing the records is the first thing a conformance run does.
 * The fields a run cannot make equal are the ones that name where the build
 * happened or when: the path of the project, the path the output was written
 * to, and the two timestamps. Everything else is the build's answer, and an
 * answer that differs is a difference the run reports.
 */

import { join, readFile } from "./platform.ts";
import type { BuildStatus, Candidate } from "./types.ts";

/** The fields that name a run rather than what it decided. */
const RUN_SPECIFIC = new Set(["id", "input", "contract", "output", "createdAt", "updatedAt"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function comparable(build: BuildStatus): Json {
  const copy: Record<string, Json> = {};
  for (const [key, value] of Object.entries(build)) {
    if (RUN_SPECIFIC.has(key) || value === undefined) continue;
    copy[key] = value as Json;
  }
  // A rejected build names the project in its diagnostic; the project is a
  // path, not a decision, so the comparison is of the diagnostic itself.
  const error = copy.error;
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const { project: _project, ...rest } = error as Record<string, Json>;
    copy.error = rest;
  }
  return copy;
}

function show(value: Json | undefined): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

function walk(left: Json | undefined, right: Json | undefined, path: string, differences: string[]): void {
  if (left === right) return;
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      walk(left[index], right[index], `${path}[${index}]`, differences);
    }
    return;
  }
  const leftObject = left !== null && typeof left === "object" && !Array.isArray(left);
  const rightObject = right !== null && typeof right === "object" && !Array.isArray(right);
  if (leftObject || rightObject) {
    const leftRecord = leftObject ? (left as { [key: string]: Json }) : {};
    const rightRecord = rightObject ? (right as { [key: string]: Json }) : {};
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    for (const key of keys) {
      walk(leftRecord[key], rightRecord[key], path === "" ? key : `${path}.${key}`, differences);
    }
    return;
  }
  differences.push(`${path}: ${show(left)} -> ${show(right)}`);
}

/**
 * The decisions two build records disagree on, as `field: left -> right`.
 *
 * An empty list is the fixed point's answer for this pair: the same target,
 * backend, runtime, toolchain, selected candidates and diagnostic, whatever
 * directories and timestamps the two builds were given.
 */
export function compareBuildRecords(left: BuildStatus, right: BuildStatus): string[] {
  const differences: string[] = [];
  walk(comparable(left), comparable(right), "", differences);
  return differences;
}

/** The differences in any two JSON values, under the name `root`. */
export function compareJson(left: unknown, right: unknown, root: string): string[] {
  const differences: string[] = [];
  walk(left as Json, right as Json, root, differences);
  return differences;
}

/**
 * The selected candidate text two project states compiled.
 *
 * A build record names the candidate it selected, but not what that candidate
 * says. The candidate text is the IR the compiler resolved and reviewed, so a
 * fixed point compares it too: the same source and model must produce the same
 * program, not merely choose a candidate with the same name.
 */
async function compareSelectedCandidates(
  leftRoot: string,
  rightRoot: string,
  leftBuild: BuildStatus,
  rightBuild: BuildStatus,
): Promise<string[]> {
  const differences: string[] = [];
  const left = JSON.parse(await readFile(join(leftRoot, "candidates.json"), "utf8")) as Record<string, Candidate[]>;
  const right = JSON.parse(await readFile(join(rightRoot, "candidates.json"), "utf8")) as Record<string, Candidate[]>;
  const named = new Set([
    ...Object.keys(leftBuild.selectedCandidates ?? {}),
    ...Object.keys(rightBuild.selectedCandidates ?? {}),
  ]);
  for (const functionName of [...named].sort()) {
    const leftId = leftBuild.selectedCandidates?.[functionName];
    const rightId = rightBuild.selectedCandidates?.[functionName];
    if (leftId === undefined || rightId === undefined || leftId !== rightId) continue;
    const leftCandidate = (left[functionName] ?? []).find((candidate) => candidate.id === leftId);
    const rightCandidate = (right[functionName] ?? []).find((candidate) => candidate.id === rightId);
    const path = `candidates.${functionName}.${leftId}`;
    if (leftCandidate === undefined || rightCandidate === undefined) {
      differences.push(`${path}: selected candidate is ${leftCandidate === undefined ? "missing on the left" : "missing on the right"}`);
      continue;
    }
    if (leftCandidate.text !== rightCandidate.text) differences.push(`${path}.text: the selected IR differs`);
    if (JSON.stringify(leftCandidate.proposals) !== JSON.stringify(rightCandidate.proposals)) {
      differences.push(`${path}.proposals: the applied proposals differ`);
    }
    if (JSON.stringify(leftCandidate.feedback) !== JSON.stringify(rightCandidate.feedback)) {
      differences.push(`${path}.feedback: the recorded diagnostics differ`);
    }
  }
  return differences;
}

/**
 * The decisions two project states agree on, and the ones they do not.
 *
 * A state directory is the `.blaze/projects/<name>` directory a build leaves:
 * its record, its contract, and the candidates it reviewed. Comparing the
 * record alone would miss a different IR selected under the same candidate
 * name, and comparing the candidates alone would miss a different backend or
 * runtime; a conformance run needs both answers.
 */
export async function compareProjectStates(leftRoot: string, rightRoot: string): Promise<string[]> {
  const leftBuild = JSON.parse(await readFile(join(leftRoot, "build.json"), "utf8")) as BuildStatus;
  const rightBuild = JSON.parse(await readFile(join(rightRoot, "build.json"), "utf8")) as BuildStatus;
  const leftContract = JSON.parse(await readFile(join(leftRoot, "contract.json"), "utf8")) as unknown;
  const rightContract = JSON.parse(await readFile(join(rightRoot, "contract.json"), "utf8")) as unknown;
  return [
    ...compareBuildRecords(leftBuild, rightBuild),
    ...compareJson(leftContract, rightContract, "contract"),
    ...(await compareSelectedCandidates(leftRoot, rightRoot, leftBuild, rightBuild)),
  ];
}
