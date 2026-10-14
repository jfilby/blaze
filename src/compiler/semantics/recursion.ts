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
 * There are three shapes here, and each is the narrowest that can be proved
 * rather than the general one.
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
 * The third is a **cycle of bodies**: `even` ending in a call of `odd` which
 * ends in a call of `even` is the tail-call shape written across two functions
 * rather than one, and it is one recursion and not two — the frames between the
 * turns are the frames of the calls between the bodies. The loop holds the turns
 * of every body of the cycle, one arm each, and a counter says which of them a
 * turn belongs to; the call a turn ends with is what binds the arguments into
 * the parameters of the body that call reaches and moves the counter to it.
 * Every body is renamed as it is put in the loop, which is what lets the turns
 * of two bodies sit beside each other, and every body of the cycle is entered
 * on values written above the loop, which is what the first turn reads its
 * parameters from. It is a whole-program answer: it needs the bodies the cycle
 * runs through, so `eliminateMutualRecursion` reads them where the caller holds
 * them and rewrites only the body it is handed — each body of a cycle is
 * answered the same way when it is the one being compiled, and
 * `eliminateMutualRecursionInProgram` answers all of them at once.
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
 * Every refusal carries the reason it refused, and `recursionRefusal` and
 * `mutualRecursionRefusal` hand it to a caller that wants to say why a body was
 * left alone.
 */

import {
  UNSTATED_LINE,
  hasCall,
  isInteger,
  slotType,
  statementBlocksOf,
  statementValues,
  typeText,
  walkValues,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticTerminator,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import { freshName, renameBindings, replaceBlockIds, slotFor, type Scope } from "./repair.ts";
import type { CallEdge, Effect, ObjectLayout } from "../core/types.ts";

/** Why a body may not be answered with a loop, in terms of what it is written as. */
export type Refusal = string;

/** A truth, which is what a loop condition and a negation of one are written at. */
const TRUTH = { kind: "primitive", name: "bool" } as const;

/** The counter that says which body of a cycle a turn belongs to. */
const COUNT = { kind: "primitive", name: "i64" } as const;

/** As many shapes one body is read for before the reading stops finding any. */
const SHAPES_PER_BODY = 4;

/**
 * The names a turn of one loop may call as the next turn.
 *
 * A body that ends in a call of itself is one loop over one body, and the set is
 * that one name; a cycle of bodies is one loop over all of them, and the set is
 * every name of the cycle. What the set decides is which calls are *turns* — the
 * ones the loop carries — and which are the calls a turn makes while it runs,
 * which is what the rest of the pass refuses. Reading a body with a set rather
 * than with a name is what lets one pass answer both shapes without answering
 * either of them twice.
 */
type Turns = ReadonlySet<string>;

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
  | {
      readonly kind: "accumulated";
      readonly plan: Plan;
      readonly carried: string;
      readonly combined: SemanticValue;
      /**
       * The one call of itself the chain was read down to. It is carried rather
       * than looked up again, because a second search finds a call the walk never
       * checked: a body whose chain runs down to a call of *another* function with
       * its own call buried in that call's arguments has one call of itself and no
       * call of itself on the chain, and a search over the terminator would hand
       * back the buried one — a different call with different arguments, so the
       * turn written from it carries the recursion while the value the chain
       * answered with is thrown away.
       */
      readonly call: SemanticCall;
    };

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
    const shape = readShape(fn, new Set([fn.name]));
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
  const shape = readShape(fn, new Set([fn.name]));
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
function readShape(fn: SemanticFunction, cycle: Turns): Shape | Refusal {
  const plan = readPlan(fn, cycle);
  if (typeof plan === "string") return plan;
  const end = fn.entry.terminator;
  if (end.k !== "return") return "the body does not end by handing something back";
  if (end.value === null) return "the body ends without handing anything back";

  if (end.value.k === "call") {
    return cycle.has(end.value.call.callee) ? carried(fn, plan, cycle) : "the body ends in a call of another function";
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
function readPlan(fn: SemanticFunction, cycle: Turns): Plan | Refusal {
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
    if (answer !== null && answer.k === "call" && cycle.has(answer.call.callee)) continue;

    const before = statements.slice(0, at);
    const turns = [...before, ...statements.slice(at + 1)];
    const written = namesWrittenIn(turns);
    if (testEffect(test.condition)) return "the test that ends the recursion runs something of its own";
    // The loop runs the test *before* the statements of a turn, and the
    // recursion ran them before the test as well — so the statements written
    // above it run on every call in the recursion and on every call but the one
    // that reaches the base case in the loop. The call that reaches the base
    // case is the one whose effects the program cannot do without: `walk` that
    // prints the depth it was entered at printed it on the last call too, and a
    // loop that skips that call answers a run one line shorter than the source
    // wrote.
    //
    // A statement that only binds a name or writes one is invisible there,
    // because the two refusals below cover the only things that read it: the
    // test cannot read what a turn writes, and neither can the answer the base
    // case gives back. Anything else — a print, a call kept for what it does, a
    // write to memory, a `raise` that ends the program — is something the loop
    // would leave out, so the body keeps its calls.
    for (const statement of before) {
      if (statement.k !== "let" && statement.k !== "set" && statement.k !== "step") {
        return "a statement written before the test that ends the recursion runs on every call, and the loop does not run it on the call that reaches the base case";
      }
      if ((statement.k === "let" || statement.k === "set") && testEffect(statement.value)) {
        return "a statement written before the test that ends the recursion runs something of its own, and the loop does not run it on the call that reaches the base case";
      }
    }
    const read = namesReadBy(test.condition);
    for (const name of written) {
      if (read.has(name)) return `the test that ends the recursion reads "${name}", which a turn writes`;
    }
    // The loop leaves the function holding what the base case answered, and the
    // answer is read where the base case was — after every turn has run. A name
    // the turns write holds whatever the last turn left there, not what the base
    // case read, so an answer reading one is a different number. A parameter is
    // not caught by this and does not need to be: the parameters a turn writes
    // are written from the arguments the call carried, so the loop leaves them
    // holding the values the base case was called with, which is what that call
    // read.
    for (const name of answer === null ? [] : namesReadBy(answer)) {
      if (written.has(name)) return `the base case answers with "${name}", which a turn writes`;
    }
    return { turns, guard: test.condition, answer };
  }
  return "the body has no arm that answers without calling itself again";
}

/** Why one call of itself may not be a turn of the loop, or null when every one may. */
function carried(fn: SemanticFunction, plan: Plan, cycle: Turns): Shape | Refusal {
  let tailCalls = 0;
  for (const block of blocksWithin(fn.entry)) {
    const end = block.terminator;
    if (end.k !== "return" || end.value === null || end.value.k !== "call" || !cycle.has(end.value.call.callee)) continue;
    const refusal = callRefusal(fn, end.value.call);
    if (refusal !== null) return refusal;
    tailCalls += 1;
  }
  const calls = selfCallsIn(fn.entry, cycle);
  if (calls.length === 0) return "the body makes no call of itself";
  if (calls.length !== tailCalls) return "the body makes a call of itself that is not the last thing it does";
  return { kind: "tail", plan };
}

/**
 * Why one call may not be turned into a turn of a loop, or null when it may.
 *
 * The signature it is held to is the callee's own: a turn carries its arguments
 * into the parameters of the body that runs next, so it is the body on the far
 * side of the call that says how many of them there are and whether each of them
 * is a name a turn may write. For a body that calls itself the two are one body,
 * which is why this was written over `fn` before a cycle of bodies existed.
 */
function callRefusal(callee: SemanticFunction, call: SemanticCall): Refusal | null {
  if (call.builtin) return "the call is one the compiler provides";
  if (call.ownership !== "none") return "the call hands back storage the caller owns";
  if (call.retain) return "the call hands back storage the caller keeps";
  if (call.args.length !== callee.params.length) {
    return `the call of "${call.callee}" is made with a different number of arguments than it has parameters`;
  }
  // The `mutable` a parameter's slot carries is not asked about: it says how
  // the source declared the binding, a parameter crosses the ABI by value, and
  // nothing in the IR or in a backend constrains a store by it — so a turn
  // writing one is invisible to every caller and to nothing else.
  for (const param of callee.params) {
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
  if (selfCallsIn(fn.entry, new Set([fn.name])).length !== 1) return "the body makes more than one call of itself";
  if (namesReadBy(plan.answer).size > 0) return "the base case answers with something the turns move";
  // The answer is carried from a name bound *before* the loop rather than
  // computed where the base case was, so it is evaluated on every call instead
  // of only on the one that reaches the base case. Reading a name is what
  // `namesReadBy` catches, and it is the same wrongness one step further on: a
  // call reads nothing and would be hoisted, so `if (n <= 0) return tick();`
  // printed once per call instead of once per recursion. A base case whose
  // answer is a call is only the same program if the call is one the compiler
  // provides, which computes its answer out of what it is handed and is the
  // same number whenever it is evaluated.
  if (plan.answer !== null && callsIn(plan.answer).some((call) => !call.builtin)) {
    return "the base case answers with a call, and the answer is carried from before the loop, so the call would run on every call";
  }

  // The chain is read before the types are, so a body whose call is combined
  // the wrong way round is told what is wrong with the way round rather than
  // with the numbers it happens to be written at.
  // The walk stops at a call *of this function* and at nothing else. A call of
  // another function is where the chain ends without the call of itself ever
  // appearing on it — `acc + wrap(f(n - 1, acc + 2), 3)` has one call of itself
  // in the body and none on the chain — and stopping there would answer that
  // call with the carried name and carry the recursion off as a turn of the
  // loop, which deletes `wrap` and answers a number the program never computed.
  const returns = typeText(fn.returns);
  let node: SemanticValue = value;
  while (node.k !== "call" || node.call.callee !== fn.name) {
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
  return { kind: "accumulated", plan, carried, combined: answeredWith(value, node, fn.returns, carried), call: node.call };
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
    block.statements.push(...argumentsCarried(end.value.call, fn.params, taken));
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
  // The call is the one the chain was read down to, which is the call the
  // combination answered with — so the arguments this turn carries are the
  // arguments that call was made with. Finding it again over the terminator
  // would be a second search over a tree the first one has already read, and it
  // answers a different question: a body whose chain runs down to a call of
  // another function holds its own call inside that call's arguments, and the
  // second search finds that one instead — a call whose arguments are not the
  // chain's, carried as though they were.
  const combined = freshName(taken, "blaze_combined");
  return [
    ...shape.plan.turns,
    { k: "let", slot: slotFor(shape.combined, combined), value: shape.combined, line: UNSTATED_LINE },
    ...argumentsCarried(shape.call, fn.params, taken),
    { k: "set", name: shape.carried, op: "=", value: { k: "local", type: fn.returns, name: combined }, line: UNSTATED_LINE },
  ];
}

/**
 * The bindings and the stores one turn's call becomes: every argument bound to
 * a name of its own, in the order the call wrote them, and then every parameter
 * written from the name its argument was bound to.
 */
function argumentsCarried(call: SemanticCall, params: readonly SemanticSlot[], taken: Set<string>): SemanticStatement[] {
  const bound: SemanticStatement[] = [];
  const stores: SemanticStatement[] = [];
  call.args.forEach((arg, index) => {
    const name = freshName(taken, "blaze_arg");
    bound.push({ k: "let", slot: slotFor(arg, name), value: arg, line: UNSTATED_LINE });
    const param = params[index] as SemanticSlot;
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
/* A cycle of bodies                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A body of a cycle, as the merged loop reads it: the body with its own names
 * out of the way, what one turn of it runs, and the slots its turns read its
 * parameters by.
 */
interface Member {
  /** The body as the source wrote it, which the rest of the function is read from. */
  readonly body: SemanticFunction;
  /** The block this body's turns are written in, which is one arm of the loop. */
  readonly arm: string;
  /** The body as the loop holds it: every name it declares renamed beside the rest. */
  readonly entry: SemanticBlock;
  /** The statements a turn of this body runs, and the test and answer that end it. */
  readonly plan: Plan;
  /** The parameters this body is entered with, under the names the loop gave them. */
  readonly params: readonly SemanticSlot[];
  /** Which turn of the loop this body is, which is what the counter says. */
  readonly at: number;
}

/** The names one merged loop is written with, which every part of it shares. */
interface Loop {
  /** The block a turn goes back to, which is the loop's own header. */
  readonly header: string;
  /** Which body of the cycle a turn belongs to. */
  readonly counter: string;
  /** The test of the body a turn belongs to, which is what the loop runs while it is false. */
  readonly guard: string;
  /** Every name the loop has taken, which is what a fresh name is counted against. */
  readonly taken: Set<string>;
}

/** The loop a cycle of bodies is one function of, and what it leaves the function saying. */
interface Merged {
  /** The block the loop is written in, which is the whole cycle after the rewrite. */
  readonly entry: SemanticBlock;
  /** What the body now does beyond computing its result, which is every body's of the cycle. */
  readonly prints: boolean;
  readonly allocates: boolean;
  readonly readsArgv: boolean;
  readonly effects: Effect[];
  readonly objects: Record<string, ObjectLayout>;
  /** Every call the merged body still makes, which is every call but the cycle's own. */
  readonly calls: CallEdge[];
}

/** The bodies a cycle may be looked for in: every name of one, and where a name is read from. */
interface Program {
  /** Every name the program holds a body under. */
  readonly names: readonly string[];
  /** The body a name is, or undefined where the program holds none. */
  readonly body: (name: string) => SemanticFunction | undefined;
}

/**
 * Answers a body that hands back to another body with the one loop the two of
 * them are, reading every body it may call.
 *
 * A cycle is one recursion and not as many as it has bodies in it: the frames
 * between the turns are the frames of the calls, and a body that ends in a call
 * of *another* body is the shape a body that ends in a call of itself is, only
 * the loop has to carry which of the bodies a turn belongs to. That is what the
 * counter in the loop is, and what each of its arms is.
 *
 * Only the body it is handed is rewritten. A build holds one body per function
 * and compiles them one at a time, so the other bodies of the cycle are read
 * where they are and left as they are: each of them is answered the same way
 * when it is the one being compiled, and a body that is in no cycle — or a cycle
 * this pass refuses — is left exactly as the source wrote it.
 */
export function eliminateMutualRecursion(subject: SemanticFunction, known: ReadonlyMap<string, SemanticFunction>): boolean {
  const names = [...known.keys()];
  if (!names.includes(subject.name)) names.push(subject.name);
  return answerCycle(subject, { names, body: (name) => (known.get(name) ?? (name === subject.name ? subject : undefined)) });
}

/**
 * The same over a whole program, where every body of a cycle is answered.
 *
 * Each body is rewritten from the same copy of every body of the cycle, so what
 * one of them is answered with does not depend on the order they are visited
 * in: the body that was answered first is read by the others as the source
 * wrote it, which is the copy they are rewritten from. A build that compiles
 * the functions one at a time answers each of them on its own, and both answers
 * are the loop.
 */
export function eliminateMutualRecursionInProgram(bodies: Iterable<SemanticFunction>): boolean {
  const all = [...bodies];
  const pristine = new Map(all.map((body) => [body.name, structuredClone(body)]));
  const program: Program = { names: [...pristine.keys()], body: (name) => pristine.get(name) };
  let changed = false;
  for (const body of all) changed = answerCycle(body, program) || changed;
  return changed;
}

/**
 * Why a cycle of bodies is left as the source wrote it, or null when it is not
 * left. As with a body that recurses into itself, this asks the question
 * without answering it, so a caller that wants to name the reason gets the
 * reason and a body that is exactly as it was.
 */
export function mutualRecursionRefusal(subject: SemanticFunction, known: ReadonlyMap<string, SemanticFunction>): Refusal | null {
  const names = [...known.keys()];
  if (!names.includes(subject.name)) names.push(subject.name);
  const program: Program = { names, body: (name) => (known.get(name) ?? (name === subject.name ? subject : undefined)) };
  const cycle = cycleThrough(subject, program);
  if (cycle === null) return "the body hands back to no body that hands back to it";
  const merged = mergeCycle(subject, cycle, program);
  return typeof merged === "string" ? merged : null;
}

/**
 * The merged loop a cycle of bodies is, written into the body it is handed, or
 * `false` where it could not be one. This is the one place both are done, so a
 * function path and a program path cannot answer the same cycle two ways.
 */
function answerCycle(subject: SemanticFunction, program: Program): boolean {
  const cycle = cycleThrough(subject, program);
  if (cycle === null) return false;
  const merged = mergeCycle(subject, cycle, program);
  if (typeof merged === "string") return false;
  writeCycle(subject, merged);
  return true;
}

/**
 * The bodies a hand back reaches and comes back to, the one it is handed first.
 *
 * An edge is a call in tail position, because a call that is not the last thing
 * a turn does is a frame the loop cannot carry: the turn that call makes is not
 * the next turn of this loop but an answer this one is still waiting for. The
 * walk follows one call at a time and takes the first cycle it comes back to the
 * body it started from, and it is bounded: a program of a handful of bodies
 * cannot spend unbounded search here, and a cycle it does not find is a cycle
 * that keeps its frames.
 */
function cycleThrough(subject: SemanticFunction, program: Program): string[] | null {
  const edges = new Map<string, string[]>();
  for (const name of program.names) {
    const body = program.body(name);
    if (body === undefined) continue;
    const targets: string[] = [];
    for (const call of turnCallsOf(body.entry, new Set(program.names))) {
      if (!targets.includes(call.callee)) targets.push(call.callee);
    }
    edges.set(name, targets);
  }
  let searched = SEARCH_LIMIT;
  const walk = (path: string[]): string[] | null => {
    const at = path[path.length - 1] as string;
    for (const next of edges.get(at) ?? []) {
      if (searched-- <= 0) return null;
      // A name the path already holds closes a cycle. One that came back to the
      // body the walk started from is this body's cycle, as long as it has more
      // than one body in it: a body that hands back to itself is one body and
      // one loop, which the per-body pass answers, and a walk that stopped there
      // would never look for the cycle that body is also in.
      if (path.includes(next)) {
        if (next !== subject.name) return null;
        if (path.length > 1) return path;
        continue;
      }
      if (path.length >= program.names.length) continue;
      const found = walk([...path, next]);
      if (found !== null) return found;
    }
    return null;
  };
  return walk([subject.name]);
}

/** How many calls of bodies one body's cycle is looked for through. */
const SEARCH_LIMIT = 4096;

/**
 * The loop a cycle of bodies is, or why the cycle may not be one.
 *
 * What the bodies of a cycle share is checked once, here, rather than body by
 * body, because it is what makes them one loop: they hand back the same type, so
 * that one loop leaves one function handing back one answer; every call one of
 * them makes of another is the last thing it does, so that it is a turn; and
 * every one of them can be entered by the loop, so that its parameters are
 * never read before a turn wrote them.
 */
function mergeCycle(subject: SemanticFunction, cycle: readonly string[], program: Program): Merged | Refusal {
  if (cycle.length < 2) return "the body hands back to itself, which is one body and one loop";
  const bodies: SemanticFunction[] = [];
  for (const name of cycle) {
    const body = program.body(name);
    if (body === undefined) return `the program holds no body of "${name}", which the cycle of bodies reaches`;
    bodies.push(body);
  }
  const first = bodies[0] as SemanticFunction;
  const returns = typeText(first.returns);
  for (const body of bodies) {
    if (typeText(body.returns) !== returns) {
      return `${first.name} hands back a ${returns} and ${body.name} hands back a ${typeText(body.returns)}, and one loop leaves one function handing back one type`;
    }
  }
  const names: Turns = new Set(cycle);
  const known = new Map(bodies.map((body) => [body.name, body]));
  for (const body of bodies) {
    const refusal = callRefusals(body, names, known);
    if (refusal !== null) return `${body.name}: ${refusal}`;
  }

  const taken = namesOf(subject);
  const loop: Loop = {
    header: freshName(taken, "blaze_turn"),
    counter: freshName(taken, "blaze_cycle"),
    guard: freshName(taken, "blaze_guard"),
    taken,
  };

  const members: Member[] = [];
  for (const [at, body] of bodies.entries()) {
    const arm = freshName(taken, `blaze_${body.name}`);
    const read = readMember(body, at, arm, taken, names);
    if (typeof read === "string") return read;
    members.push(read);
  }

  // The block the loop is written in enters the cycle where the call came from:
  // the first body is the one that was called and is entered with the arguments
  // the caller handed over, and every other body is entered with the arguments
  // of a call that reaches it. Those are written above the loop rather than
  // where the call was made, so they are evaluated on every call into the
  // function rather than on every turn of the loop.
  const readable = new Set<string>(subject.params.map((param) => param.name));
  const start: SemanticStatement[] = [
    { k: "let", slot: slotFor({ k: "const", type: COUNT, text: "0" }, loop.counter, true), value: { k: "const", type: COUNT, text: "0" }, line: UNSTATED_LINE },
  ];
  for (const member of members) {
    const entering: readonly SemanticValue[] | Refusal = member.at === 0
      ? subject.params.map((param) => ({ k: "local" as const, type: slotType(param), name: param.name }))
      : startingWith(member, members, readable);
    if (typeof entering === "string") return entering;
    entering.forEach((value, index) => {
      const param = member.params[index];
      if (param === undefined) return;
      start.push({ k: "let", slot: param, value, line: UNSTATED_LINE });
      readable.add(param.name);
    });
  }
  const opening = members[0] as Member;
  start.push({ k: "let", slot: slotFor(opening.plan.guard, loop.guard, true), value: opening.plan.guard, line: UNSTATED_LINE });

  const firstTurn = turnOf(opening, members, loop);
  const turns: SemanticLoop = {
    kind: "while",
    condition: { k: "unary", type: TRUTH, op: "not", operand: { k: "local", type: TRUTH, name: loop.guard } },
    header: loop.header,
    exit: subject.entry.id,
    body: {
      id: freshName(taken, "blaze_body"),
      statements: [
        {
          k: "if",
          condition: isBodyAt(loop.counter, opening.at),
          then: firstTurn,
          otherwise: elseArms(members, 1, loop),
          line: UNSTATED_LINE,
        },
      ],
      releases: [],
      terminator: { k: "jump", target: loop.header, releases: [] },
    },
  };

  const finish = answeringOf(members, loop.counter, taken);
  return {
    entry: {
      id: subject.entry.id,
      statements: [...start, { k: "loop", loop: turns, line: UNSTATED_LINE }, ...finish.statements],
      releases: [],
      terminator: finish.last,
    },
    prints: members.some((member) => member.body.prints),
    allocates: members.some((member) => member.body.allocates),
    readsArgv: members.some((member) => member.body.readsArgv),
    effects: [...new Set(members.flatMap((member) => member.body.effects))],
    objects: Object.assign({}, ...members.map((member) => member.body.objects)),
    calls: edgesOf(members, names),
  };
}

/** Puts the loop a cycle of bodies is in place of the calls between the bodies. */
function writeCycle(fn: SemanticFunction, merged: Merged): void {
  fn.entry = merged.entry;
  fn.prints = merged.prints;
  fn.allocates = merged.allocates;
  fn.readsArgv = merged.readsArgv;
  fn.effects = merged.effects;
  fn.objects = merged.objects;
  fn.calls = merged.calls;
}

/**
 * Why one body of a cycle may not be a turn of the loop, or null when it may.
 *
 * What a body of a cycle is held to is what a body is held to when it calls
 * itself: every call it makes of another body of the cycle has to be the last
 * thing it does, and every one of them has to be made the way the loop carries
 * it. A call of a body outside the cycle is a call a turn makes while it runs,
 * and is left alone.
 */
function callRefusals(body: SemanticFunction, names: Turns, known: ReadonlyMap<string, SemanticFunction>): Refusal | null {
  const calls = selfCallsIn(body.entry, names);
  if (calls.length === 0) return "the body makes no call of another body of the cycle";
  let turns = 0;
  for (const call of turnCallsOf(body.entry, names)) {
    const refusal = callRefusal(known.get(call.callee) ?? body, call);
    if (refusal !== null) return refusal;
    turns += 1;
  }
  if (turns !== calls.length) return "the body makes a call of another body of the cycle that is not the last thing it does";
  return null;
}

/** Every call of the named bodies that a body ends a turn with. */
function turnCallsOf(entry: SemanticBlock, names: Turns): SemanticCall[] {
  const found: SemanticCall[] = [];
  for (const block of blocksWithin(entry)) {
    const end = block.terminator;
    if (end.k !== "return" || end.value === null || end.value.k !== "call" || !names.has(end.value.call.callee)) continue;
    found.push(end.value.call);
  }
  return found;
}

/**
 * One body of a cycle as the loop holds it: the same statements under names of
 * their own, and the test and the answer that end a turn of it.
 *
 * Every name the body declares is renamed before a turn of it is read, which is
 * what lets the turns of two bodies sit beside each other: two bodies very
 * often declare one spelling — the same counter, the same temporary — and each
 * of those is a binding of its own. The block ids are renamed the same way and
 * for the same reason, and the block the body started in is renamed to the arm
 * of the loop its turns are written in, which is where a loop written among them
 * leaves for when it breaks.
 */
function readMember(body: SemanticFunction, at: number, arm: string, taken: Set<string>, cycle: Turns): Member | Refusal {
  const entry = structuredClone(body.entry);
  const scope: Scope = { reads: new Map(), targets: new Map() };
  const params: SemanticSlot[] = body.params.map((param) => {
    const name = freshName(taken, `blaze_${body.name}_${param.name}`);
    scope.reads.set(param.name, { k: "local", type: slotType(param), name });
    scope.targets.set(param.name, name);
    return { ...param, name };
  });
  const shadowed = renameBindings(entry, scope, taken, body.name);
  if (shadowed !== null) return shadowed;
  const blocks = new Map<string, string>([[entry.id, arm]]);
  for (const inner of blocksWithin(entry)) {
    if (inner.id !== entry.id) blocks.set(inner.id, freshName(taken, "blaze_block"));
  }
  for (const inner of blocksWithin(entry)) {
    for (const statement of inner.statements) {
      if (statement.k !== "loop") continue;
      for (const id of [statement.loop.header, statement.loop.exit]) {
        if (!blocks.has(id)) blocks.set(id, freshName(taken, "blaze_block"));
      }
    }
  }
  const renamed = replaceBlockIds(entry, blocks) as SemanticBlock;
  const plan = readPlan({ ...body, entry: renamed }, cycle);
  if (typeof plan === "string") return `${body.name}: ${plan}`;
  return { body, arm, entry: renamed, plan, params, at };
}

/**
 * The arguments a body of a cycle is entered with the first time the loop runs
 * it, or why it may not be entered at all.
 *
 * A turn writes the parameters of the body that runs next, and the loop reads
 * the parameters of the body it runs first before any turn has written them, so
 * every body of the cycle is entered on values that are written above the loop.
 * The first body is entered with the arguments the caller handed over and every
 * other one with the arguments of a call that reaches it, which are the values
 * that call would have handed it — as long as the loop can read them where they
 * are written, and is writing them on every call rather than on every turn. An
 * argument that calls something is refused for that reason: a call that prints
 * would print on every call into the function, for a body the loop may never
 * have reached.
 */
function startingWith(member: Member, members: readonly Member[], readable: ReadonlySet<string>): readonly SemanticValue[] | Refusal {
  for (const caller of members) {
    if (caller.at >= member.at) continue;
    for (const call of turnCallsOf(caller.entry, new Set([member.body.name]))) {
      if (call.args.length !== member.params.length) continue;
      if (call.args.some((argument) => hasCall(argument))) continue;
      const reads: string[] = [];
      for (const argument of call.args) reads.push(...namesReadBy(argument));
      if (!reads.every((name) => readable.has(name))) continue;
      return call.args;
    }
  }
  return `${member.body.name} is entered by no call whose arguments the loop can read above itself, so its parameters would be read before any turn wrote them`;
}

/**
 * One turn of a body of a cycle: the statements the turn runs, and then the
 * arguments of the call it ends with, written into the parameters of the body
 * that call reaches, the counter saying which body that is, and the test of that
 * body being what the loop runs next.
 *
 * The test of the next body is written at the end of a turn rather than read at
 * the head of the next one because the parameters it reads are the ones this
 * turn has just written: the test of the body that runs next is a question about
 * the arguments its call carried, and the loop reads one test per turn rather
 * than one per call — the test of the body it starts in is the one it reads
 * above itself.
 */
function turnOf(member: Member, members: readonly Member[], loop: Loop): SemanticBlock {
  const turn: SemanticBlock = {
    id: member.arm,
    statements: [...member.plan.turns],
    releases: [],
    terminator: member.entry.terminator,
  };
  for (const block of blocksWithin(turn)) {
    const end = block.terminator;
    if (end.k !== "return" || end.value === null || end.value.k !== "call") continue;
    const call = end.value.call;
    const next = members.find((one) => one.body.name === call.callee);
    if (next === undefined) continue;
    block.statements.push(
      ...argumentsCarried(call, next.params, loop.taken),
      { k: "set", name: loop.counter, op: "=", value: { k: "const", type: COUNT, text: String(next.at) }, line: UNSTATED_LINE },
      { k: "set", name: loop.guard, op: "=", value: next.plan.guard, line: UNSTATED_LINE },
    );
    block.terminator = { k: "jump", target: loop.header, releases: [] };
  }
  return turn;
}

/** The arms of the loop that are written after the one the loop starts in. */
function elseArms(members: readonly Member[], at: number, loop: Loop): SemanticBlock | null {
  const member = members[at];
  if (member === undefined) return null;
  const last = turnOf(member, members, loop);
  if (members[at + 1] === undefined) return last;
  return {
    id: freshName(loop.taken, "blaze_arm"),
    statements: [
      { k: "if", condition: isBodyAt(loop.counter, member.at), then: last, otherwise: elseArms(members, at + 1, loop), line: UNSTATED_LINE },
    ],
    releases: [],
    terminator: { k: "next" },
  };
}

/**
 * What the function hands back once the loop has left, which is the answer of
 * the base case of whichever body the loop was on when it left.
 *
 * The counter says which body answered, and the answer is read where the loop is
 * written in: the parameters a turn wrote are the ones the base case of the body
 * it belongs to was called with, which is what the recursion left in them when
 * that call returned.
 */
function answeringOf(members: readonly Member[], counter: string, taken: Set<string>): { statements: SemanticStatement[]; last: SemanticTerminator } {
  const final = members[members.length - 1] as Member;
  return {
    statements: answeringArms(members, 0, counter, taken),
    last: { k: "return", value: final.plan.answer },
  };
}

/**
 * One arm per body of the cycle but the last, each handing back the answer that
 * body's base case gave, and the last of them falling out to the return the
 * block the loop is written in ends with.
 */
function answeringArms(members: readonly Member[], at: number, counter: string, taken: Set<string>): SemanticStatement[] {
  const member = members[at] as Member;
  if (members[at + 1] === undefined) return [];
  return [
    {
      k: "if",
      condition: isBodyAt(counter, member.at),
      then: { id: freshName(taken, "blaze_answer"), statements: [], releases: [], terminator: { k: "return", value: member.plan.answer } },
      otherwise: { id: freshName(taken, "blaze_answer"), statements: answeringArms(members, at + 1, counter, taken), releases: [], terminator: { k: "next" } },
      line: UNSTATED_LINE,
    },
  ];
}

/** The truth that says which body of the cycle a turn belongs to. */
function isBodyAt(counter: string, at: number): SemanticValue {
  return {
    k: "compare",
    type: TRUTH,
    op: "eq",
    operand: COUNT,
    left: { k: "local", type: COUNT, name: counter },
    right: { k: "const", type: COUNT, text: String(at) },
  };
}

/** Every call the merged body still makes, which is every call but the cycle's own. */
function edgesOf(members: readonly Member[], names: Turns): CallEdge[] {
  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    for (const edge of member.body.calls) {
      if (names.has(edge.callee) || seen.has(edge.callee)) continue;
      seen.add(edge.callee);
      edges.push({ ...edge });
    }
  }
  return edges;
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

/** Every call a body makes of the functions a turn of its loop is made of. */
function selfCallsIn(entry: SemanticBlock, turns: Turns): SemanticCall[] {
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
      if (inner.k === "call" && turns.has(inner.call.callee)) found.push(inner.call);
    });
  }
}

/** Every call one value makes, of any function. */
function callsIn(value: SemanticValue): SemanticCall[] {
  const found: SemanticCall[] = [];
  walkValues(value, (inner) => {
    if (inner.k === "call") found.push(inner.call);
  });
  return found;
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
      else if (statement.k === "fill") names.add(statement.buffer);
      else if (statement.k === "storeField") for (const name of namesReadBy(statement.object)) names.add(name);
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
