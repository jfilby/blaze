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

import type { BuildStatus } from "./types.ts";

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
