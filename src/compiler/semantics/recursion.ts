/**
 * Recursion the compiler answers with a loop.
 *
 * A function that calls itself hands back a frame for every turn it takes, and
 * a call is not free: the frame is laid out, the arguments are marshalled
 * across it and the register allocator is asked for a callee-saved set around
 * it. On a program whose recursion is deep and whose work per turn is small
 * that is most of the run. A sum written `return sum(n - 1, acc + x)` over ten
 * million elements builds ten million frames to add ten million numbers.
 *
 * This pass removes the frame. A body that ends in a call of itself is a body
 * whose turns are a loop already: the call passes its arguments to the next
 * turn and its result is the result of the whole. Written as a loop the
 * arguments go into the names the next turn reads them by, and the loop is a
 * loop the passes that follow — invariant hoisting, commoning, counted-loop
 * recognition, parallelism, regions — can read. A loop the compiler cannot see
 * is a loop none of them can do anything with.
 *
 * The rewrite is deterministic and rule-based, like every other rewrite in this
 * directory, and it runs on the semantic IR before any of them: `optimize-ir.ts`
 * calls it after the IR is written and before the rounds. It is written once
 * against the IR rather than once per backend, so every output kind lowers the
 * loop this produces and none of them re-derives it.
 *
 * There are two shapes here, and both are the narrowest that can be proved
 * rather than the general ones.
 *
 * The first is a **tail call**: the entry block ends in `return f(args)` where
 * `f` is the function itself, and the statement before it is the test that ends
 * the recursion. Every statement between the start of the block and that test
 * becomes the body of a loop, the arguments are bound to fresh names in the
 * order they are written — which is the order the call evaluated them in, so a
 * body that has effects keeps them — and the parameters are written from those
 * names. What a turn does is unchanged: it runs the same statements in the same
 * order, computes the same arguments in the same order, and the base case still
 * ends the function with the same value. What is gone is the frame between one
 * turn and the next.
 *
 * The second is a **linear recursion whose answer is accumulated**: the entry
 * block ends in `return <something holding exactly one call of itself>`, and
 * that call sits at the end of a chain of `+` or `*` over whole numbers. This
 * is the state machine the requirements ask for, and an accumulator is one: the
 * answer the turn before this one was going to hand back is held in a name,
 * this turn combines into it, and the loop carries it to the next turn. It is
 * restricted to that chain because the loop runs the turns *the opposite way
 * round* to the recursion — the recursion nests `E0(E1(E2(base)))` where the
 * loop combines `E2` into `base`, then `E1` into that, then `E0` — and the two
 * are the same number only where the combination does not care which way round
 * it goes. `+` and `*` over whole numbers are exact however they are grouped,
 * which is the same fact the reductions in `parallel.ts` rest on. A double is
 * not exact that way and a subtraction is not the same operation either way
 * round, so both are refused rather than approximated.
 *
 * What is left as it was written is most of the language's recursion, and
 * deliberately so. A recursion with two calls of itself in one return — `fib`,
 * or a tree walked with a left and a right — is not a state machine this IR can
 * hold: answering it needs storage whose length is not known until the walk has
 * finished, and an array in `core/semantic-ir.ts` is allocated where the
 * program wrote it out, at a length the program states. There is no push and no
 * growth, so an explicit stack of unbounded depth is not a program this IR can
 * be written as, and a traversal is not answered with one that would overflow
 * where the recursion did not. Those bodies keep their calls, which is what
 * every body the compiler cannot prove gets.
 *
 * Every refusal carries the reason it refused, and `recursionRefusal` hands it
 * to a caller that wants to say why a body was left alone.
 */

import {
  UNSTATED_LINE,
  isInteger,
  statementBlocksOf,
  statementValues,
  typeText,
  walkValues,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import { freshName, slotFor } from "./repair.ts";

/** Why a body may not be answered with a loop, in terms of what it is written as. */
export type Refusal = string;

/** A truth, which is what a loop condition and a negation of one are written at. */
const TRUTH = { kind: "primitive", name: "bool" } as const;

/** As many shapes one body is read for before the reading stops finding any. */
const SHAPES_PER_BODY = 4;

/**
 * The statements a turn runs, the test that ends the recursion, and what the
 * base case hands back — which is what the loop leaves the function holding.
 */
interface Plan {
  readonly turns: readonly SemanticStatement[];
  readonly guard: SemanticValue;
  readonly answer: SemanticValue | null;
}

/**
 * A body the pass has a loop for.
 *
 * An accumulated body carries the name its turns combine into and the value the
 * chain becomes once the call of itself is answered by that name, because the
 * name has to exist before the loop that carries it is written.
 */
type Shape =
  | { readonly kind: "tail"; readonly plan: Plan }
  | { readonly kind: "accumulated"; readonly plan: Plan; readonly carried: string; readonly combined: SemanticValue };

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Answers a body's own recursion with loops, and reports whether it did.
 *
 * The rounds are bounded rather than open-ended: a loop this pass writes calls
 * nothing, so one shape is all a body can take, and a body it cannot read is a
 * body it will not read on the next one either. The bound is there because that
 * is a claim about the two shapes below rather than a search.
 */
export function eliminateRecursion(fn: SemanticFunction): boolean {
  let changed = false;
  for (let round = 0; round < SHAPES_PER_BODY; round += 1) {
    const shape = readShape(fn);
    if (typeof shape === "string") break;
    writeShape(fn, shape);
    changed = true;
  }
  return changed;
}

/**
 * Why a body's own recursion is left as the source wrote it, or null when it is
 * not left. This asks the question without answering it, so a caller that wants
 * to name the reason a body kept its calls gets the reason and a body that is
 * exactly as it was.
 */
export function recursionRefusal(fn: SemanticFunction): Refusal | null {
  const shape = readShape(fn);
  return typeof shape === "string" ? shape : null;
}

/* -------------------------------------------------------------------------- */
/* Reading a body                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The loop a body may be written as, or why it may not be one.
 *
 * A tail call is read first, because a body that ends in one has nothing left
 * to accumulate. A body whose last statement combines the call of itself into
 * something else is read second, and only what the first did not take reaches
 * it.
 */
function readShape(fn: SemanticFunction): Shape | Refusal {
  const plan = readPlan(fn);
  if (typeof plan === "string") return plan;
  const end = fn.entry.terminator;
  if (end.k !== "return") return "the body does not end by handing something back";
  if (end.value === null) return "the body ends without handing anything back";

  if (end.value.k === "call") {
    return end.value.call.callee !== fn.name ? "the body ends in a call of another function" : carried(fn, plan);
  }
  if (end.value.k === "const" || end.value.k === "bool" || end.value.k === "nothing") {
    return "the body ends in a value that holds no call of itself";
  }
  return accumulated(fn, plan, end.value);
}

/**
 * The statements a turn runs and the test that ends the recursion, or why the
 * body is not written as one turn at all.
 *
 * The test is the first arm of the body that answers without calling the
 * function again, and it answers without computing anything first. Everything
 * around it — before it and after it alike — is a statement of a turn, because
 * in the recursion it ran on every call and in the loop it runs on every turn.
 * That is what carries a body whose work sits between the base case and the
 * call, which is where a body that prints or writes something belongs.
 *
 * An arm that computed before it answered would have to be written after the
 * loop, where those statements would run on a turn that never reached them, and
 * an answer read from a name the arm declared would have nothing left to read.
 * An arm that calls the function again is not a base case: it is another turn,
 * and the pass carries it as one.
 *
 * The loop runs the test before the statements of a turn rather than after
 * them, because the test is the loop's own condition. The two answer the same
 * question only where nothing a turn does can be seen from the test, which is
 * what the last two refusals say.
 */
function readPlan(fn: SemanticFunction): Plan | Refusal {
  const entry = fn.entry;
  if (entry.releases.length > 0) return "the body frees what it owns on its way out of it";
  if (entry.terminator.k !== "return") return "the body does not end by handing something back";

  const statements = entry.statements;
  const arms = statements.flatMap((statement, at) => (statement.k === "if" && statement.otherwise === null ? [at] : []));
  if (arms.length === 0) return "the body does not end in a test of its own";
  for (const at of arms) {
    const test = statements[at];
    if (test === undefined || test.k !== "if") continue;
    const arm = test.then;
    if (arm.statements.length > 0) return "the base case computes something before it answers";
    if (arm.releases.length > 0) return "the base case frees what it owns on its way out of it";
    if (arm.terminator.k !== "return") return "the base case does not end by handing something back";

    const answer = arm.terminator.value;
    if (fn.returns.kind === "void" ? answer !== null : answer === null || typeText(answer.type) !== typeText(fn.returns)) {
      return "the base case answers with something the function is not declared to return";
    }
    // An arm that calls the function again is not a base case: it is a turn
    // written as an arm, and the pass carries it as one. The next arm is read.
    if (answer !== null && answer.k === "call" && answer.call.callee === fn.name) continue;

    const turns = [...statements.slice(0, at), ...statements.slice(at + 1)];
    if (testEffect(test.condition)) return "the test that ends the recursion runs something of its own";
    const read = namesReadBy(test.condition);
    for (const name of namesWrittenIn(turns)) {
      if (read.has(name)) return `the test that ends the recursion reads "${name}", which a turn writes`;
    }
    return { turns, guard: test.condition, answer };
  }
  return "the body has no arm that answers without calling itself again";
}

/** Why one call of itself may not be a turn of the loop, or null when every one may. */
function carried(fn: SemanticFunction, plan: Plan): Shape | Refusal {
  let tailCalls = 0;
  for (const block of blocksWithin(fn.entry)) {
    const end = block.terminator;
    if (end.k !== "return" || end.value === null || end.value.k !== "call" || end.value.call.callee !== fn.name) continue;
    const refusal = callRefusal(fn, end.value.call);
    if (refusal !== null) return refusal;
    tailCalls += 1;
  }
  const calls = selfCallsIn(fn.entry, fn.name);
  if (calls.length === 0) return "the body makes no call of itself";
  if (calls.length !== tailCalls) return "the body makes a call of itself that is not the last thing it does";
  return { kind: "tail", plan };
}

/** Why one call may not be turned into a turn of a loop, or null when it may. */
function callRefusal(fn: SemanticFunction, call: SemanticCall): Refusal | null {
  if (call.builtin) return "the call is one the compiler provides";
  if (call.ownership !== "none") return "the call hands back storage the caller owns";
  if (call.retain) return "the call hands back storage the caller keeps";
  if (call.args.length !== fn.params.length) {
    return "the call is made with a different number of arguments than the function has parameters";
  }
  // The `mutable` a parameter's slot carries is not asked about: it says how
  // the source declared the binding, a parameter crosses the ABI by value, and
  // nothing in the IR or in a backend constrains a store by it — so a turn
  // writing one is invisible to every caller and to nothing else.
  for (const param of fn.params) {
    if (param.kind !== "value") return `the parameter "${param.name}" is not one name a turn writes`;
  }
  return null;
}

/**
 * The accumulated shape of a body that hands back a chain holding its own call,
 * or null when that chain is not one a loop may carry.
 *
 * The chain runs down the right of every node on the way to the call, and every
 * node on it is a sum or a product of whole numbers. Both halves of that are
 * load-bearing. The right is what says the call is the innermost term of the
 * chain rather than something the chain is applied around. The sum and the
 * product say the chain does not care which way round it is grouped, because
 * the loop accumulates the turns backwards through the recursion and whole
 * numbers are exact however they are grouped. A double is not exact that way and
 * a subtraction is not the same operation either way round, so both are refused
 * rather than approximated.
 *
 * The base case is what the carried name starts at, and it starts there before
 * the loop rather than where the base case is reached, so the answer has to be
 * the same whatever the turns did to the names around it: it has to be written
 * out of nothing.
 */
function accumulated(fn: SemanticFunction, plan: Plan, value: SemanticValue): Shape | Refusal {
  if (plan.answer === null) return "the body answers with nothing to carry an answer in";
  if (selfCallsIn(fn.entry, fn.name).length !== 1) return "the body makes more than one call of itself";
  if (namesReadBy(plan.answer).size > 0) return "the base case answers with something the turns move";

  // The chain is read before the types are, so a body whose call is combined
  // the wrong way round is told what is wrong with the way round rather than
  // with the numbers it happens to be written at.
  const returns = typeText(fn.returns);
  let node: SemanticValue = value;
  while (node.k !== "call") {
    if (node.k !== "arith" || (node.op !== "add" && node.op !== "mul")) {
      return "the call of itself is not combined into a sum or a product";
    }
    if (selfCallsInValue(node.left, fn.name).length > 0) return "the body makes more than one call of itself";
    node = node.right;
  }
  if (!isInteger(fn.returns)) return "the answer is combined into a double, which the loop may not regroup";
  for (let along: SemanticValue = value; along !== node; along = along.k === "arith" ? along.right : along) {
    if (typeText(along.type) !== returns) return "the call of itself is combined into something of another type";
  }
  const refusal = callRefusal(fn, node.call);
  if (refusal !== null) return refusal;

  const carried = freshName(namesOf(fn), "blaze_acc");
  return { kind: "accumulated", plan, carried, combined: answeredWith(value, node, fn.returns, carried) };
}

/**
 * The chain with the one call inside it answered by the name the loop carries,
 * rebuilt from the inside out so that every other term is exactly what the
 * source wrote.
 */
function answeredWith(value: SemanticValue, call: SemanticValue, type: SemanticType, name: string): SemanticValue {
  if (value === call) return { k: "local", type, name };
  const arith = value as Extract<SemanticValue, { k: "arith" }>;
  return { ...arith, right: answeredWith(arith.right, call, type, name) };
}

/* -------------------------------------------------------------------------- */
/* Writing a body as a loop                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Puts the loop a body was read as in place of the calls it makes of itself.
 *
 * The name each argument is carried under is the compiler's own, and it is what
 * makes the ordering argument hold: the arguments are bound in the order the
 * call wrote them, which is the order the call evaluated them in, and the
 * parameters are written only once every argument has been read. A body whose
 * second argument reads the name its first one writes — `f(n - 1, acc * n)` —
 * therefore computes the same two values it computed before, in the same order,
 * and only then moves on.
 */
function writeShape(fn: SemanticFunction, shape: Shape): void {
  const taken = namesOf(fn);
  const header = freshName(taken, "blaze_turn");
  const accumulatedShape = shape.kind === "accumulated" ? shape : null;
  const start = accumulatedShape === null || shape.plan.answer === null ? [] : [carriedFrom(shape.plan.answer, accumulatedShape, fn.returns)];

  const loop: SemanticLoop = {
    kind: "while",
    condition: negated(shape.plan.guard),
    header,
    exit: fn.entry.id,
    body: {
      id: freshName(taken, "blaze_body"),
      statements: accumulatedShape === null ? tailTurns(fn, shape.plan, header, taken) : accumulatedTurns(fn, accumulatedShape, taken),
      releases: [],
      terminator: { k: "jump", target: header, releases: [] },
    },
  };

  fn.entry.statements = [...start, { k: "loop", loop, line: UNSTATED_LINE }];
  fn.entry.terminator = {
    k: "return",
    value: accumulatedShape === null ? shape.plan.answer : { k: "local", type: fn.returns, name: accumulatedShape.carried },
  };
  fn.calls = fn.calls.filter((edge) => edge.callee !== fn.name);
}

/** The name an accumulated body carries its answer in, starting where the base case starts. */
function carriedFrom(answer: SemanticValue, shape: Extract<Shape, { kind: "accumulated" }>, type: SemanticType): SemanticStatement {
  return { k: "let", slot: { kind: "value", name: shape.carried, mutable: true, type }, value: answer, line: UNSTATED_LINE };
}

/**
 * The turns of a body that ends in a call of itself: everything the entry block
 * ran before the test, and then the arguments that call was made with written
 * into the parameters.
 *
 * Every call of itself the body makes as the last thing it does becomes the
 * same two things, wherever it is written: the arguments bound and the
 * parameters written. A body that chooses between two sets of arguments has
 * both of them inside the loop, and each one goes on with the loop rather than
 * returning from the function — which is the same turn of the same loop the
 * call it replaced would have been the next of.
 */
function tailTurns(fn: SemanticFunction, plan: Plan, header: string, taken: Set<string>): SemanticStatement[] {
  const root: SemanticBlock = {
    id: fn.entry.id,
    statements: [...plan.turns],
    releases: [],
    terminator: fn.entry.terminator,
  };
  for (const block of blocksWithin(root)) {
    const end = block.terminator;
    if (end.k !== "return" || end.value === null || end.value.k !== "call" || end.value.call.callee !== fn.name) continue;
    block.statements.push(...argumentsCarried(end.value.call, fn, taken));
    block.terminator = { k: "jump", target: header, releases: [] };
  }
  return root.statements;
}

/**
 * The turns of a body that combines the call of itself into a sum or a product:
 * the same statements, then the combination written into a name of its own, the
 * arguments bound and written, and the combination carried to the next turn.
 *
 * The combination is bound before the parameters are written because it reads
 * them, and it is carried after they are written because the arguments read
 * what the combination read. Both orders are the order the recursion had: the
 * combination was computed from the turn's own values, and so were the
 * arguments, before anything moved on.
 */
function accumulatedTurns(fn: SemanticFunction, shape: Extract<Shape, { kind: "accumulated" }>, taken: Set<string>): SemanticStatement[] {
  const end = fn.entry.terminator;
  if (end.k !== "return" || end.value === null) return [];
  const call = selfCallsInValue(end.value, fn.name)[0] as SemanticCall;
  const combined = freshName(taken, "blaze_combined");
  return [
    ...shape.plan.turns,
    { k: "let", slot: slotFor(shape.combined, combined), value: shape.combined, line: UNSTATED_LINE },
    ...argumentsCarried(call, fn, taken),
    { k: "set", name: shape.carried, op: "=", value: { k: "local", type: fn.returns, name: combined }, line: UNSTATED_LINE },
  ];
}

/**
 * The bindings and the stores one turn's call becomes: every argument bound to
 * a name of its own, in the order the call wrote them, and then every parameter
 * written from the name its argument was bound to.
 */
function argumentsCarried(call: SemanticCall, fn: SemanticFunction, taken: Set<string>): SemanticStatement[] {
  const bound: SemanticStatement[] = [];
  const stores: SemanticStatement[] = [];
  call.args.forEach((arg, index) => {
    const name = freshName(taken, "blaze_arg");
    bound.push({ k: "let", slot: slotFor(arg, name), value: arg, line: UNSTATED_LINE });
    const param = fn.params[index] as SemanticFunction["params"][number];
    stores.push({ k: "set", name: param.name, op: "=", value: { k: "local", type: arg.type, name }, line: UNSTATED_LINE });
  });
  return [...bound, ...stores];
}

/**
 * The test a loop runs while it is false, which is what the base case's test is
 * written as.
 *
 * A test the source wrote out as a truth is answered the other way round
 * directly. Anything else is negated rather than compared the other way,
 * because a comparison of doubles has no negation that gives the same answer:
 * `!(a < b)` is true where `a >= b` is false, for every `a` that is not a
 * number.
 */
function negated(guard: SemanticValue): SemanticValue {
  if (guard.k === "bool") return { ...guard, value: !guard.value };
  return { k: "unary", type: TRUTH, op: "not", operand: guard };
}

/* -------------------------------------------------------------------------- */
/* Names and walks                                                             */
/* -------------------------------------------------------------------------- */

/** Every name a function holds, which a name this pass writes may not shadow. */
function namesOf(fn: SemanticFunction): Set<string> {
  const names = new Set<string>();
  for (const param of fn.params) names.add(param.name);
  for (const block of blocksWithin(fn.entry)) {
    names.add(block.id);
    for (const statement of block.statements) {
      if (statement.k === "let") names.add(statement.slot.name);
    }
  }
  return names;
}

/** A block and every block nested inside it, itself included. */
function blocksWithin(block: SemanticBlock): SemanticBlock[] {
  const blocks: SemanticBlock[] = [block];
  for (const statement of block.statements) {
    for (const nested of statementBlocksOf(statement)) blocks.push(...blocksWithin(nested));
  }
  return blocks;
}

/** Every call a body makes of the function it is the body of, wherever it is written. */
function selfCallsIn(entry: SemanticBlock, name: string): SemanticCall[] {
  const found: SemanticCall[] = [];
  for (const block of blocksWithin(entry)) {
    for (const statement of block.statements) {
      for (const value of statementValues(statement)) collect(value);
    }
    const end = block.terminator;
    if (end.k === "return" && end.value !== null) collect(end.value);
  }
  return found;

  function collect(value: SemanticValue): void {
    walkValues(value, (inner) => {
      if (inner.k === "call" && inner.call.callee === name) found.push(inner.call);
    });
  }
}

/** Every call one value makes of the function the body belongs to. */
function selfCallsInValue(value: SemanticValue, name: string): SemanticCall[] {
  const found: SemanticCall[] = [];
  walkValues(value, (inner) => {
    if (inner.k === "call" && inner.call.callee === name) found.push(inner.call);
  });
  return found;
}

/** Every name one value reads. */
function namesReadBy(value: SemanticValue): Set<string> {
  const names = new Set<string>();
  walkValues(value, (inner) => {
    if (inner.k === "local") names.add(inner.name);
  });
  return names;
}

/** Every name a run of statements writes, which a name it declares included. */
function namesWrittenIn(statements: readonly SemanticStatement[]): Set<string> {
  const names = new Set<string>();
  for (const placed of blocksOfStatements(statements)) {
    for (const statement of placed.statements) {
      if (statement.k === "let") names.add(statement.slot.name);
      else if (statement.k === "set" || statement.k === "step") names.add(statement.name);
      else if (statement.k === "setElement") names.add(statement.buffer);
    }
  }
  return names;
}

/** Every block a run of statements holds of its own, and the run itself. */
function blocksOfStatements(statements: readonly SemanticStatement[]): SemanticBlock[] {
  const blocks: SemanticBlock[] = [{ id: "", statements: [...statements], releases: [], terminator: { k: "next" } }];
  for (const placed of blocks) {
    for (const statement of placed.statements) {
      for (const nested of statementBlocksOf(statement)) blocks.push(...blocksWithin(nested));
    }
  }
  return blocks;
}

/** Whether a value does anything besides reading, which a test the loop hoists may not. */
function testEffect(value: SemanticValue): boolean {
  let effect = false;
  walkValues(value, (inner) => {
    if (inner.k === "call" || inner.k === "newObject") effect = true;
  });
  return effect;
}
