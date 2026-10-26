/**
 * Where a name is live, and what a call the body makes does to it.
 *
 * Two backends hold a name in a register rather than in a frame, and both have
 * to answer the same two questions before they may: is this name live at the
 * same time as that one, and does anything happen in between that takes the
 * register away. A read census cannot answer either — it counts how often a
 * name is reached for, which says nothing about *when*, and a name reached for
 * five times in one straight line and a name reached for five times around a
 * loop are the same name to it.
 *
 * So the answer is computed rather than counted. The body is put into a graph
 * whose nodes are the places control can be, liveness is solved over it
 * backwards, and what comes out for each name is the runs of places it is live
 * across and whether any call the body makes falls inside one of them.
 *
 * Two names live in disjoint runs can be given the same register, and a name no
 * call reaches can be given one the convention does not ask a callee to
 * preserve — which is what makes a register free rather than two instructions
 * of prologue and epilogue. Those are the two things a census cannot see and
 * the whole of what this exists to give them.
 *
 * The graph is over the order the lowering writes the body in, because that
 * order is the order the program runs in: an event index is a place in the
 * instruction stream, and a run of them is a stretch of that stream over which
 * one value is carried.
 */

import { isFloat, isTextType, isWideType, type SemanticBlock, type SemanticStatement, type SemanticValue } from "../core/semantic-ir.ts";

/**
 * The arithmetic whose two sides are written left one first, by the name the
 * IR gives the operator.
 *
 * Every other arithmetic is written right side first, because the side that is
 * not the instruction's own immediate is written first and parked while the
 * other side is written. These three are not that: a concatenation is laid out
 * a part at a time from the left, and a minimum and a maximum are two values
 * taken and then compared.
 */
const LEFT_FIRST_ARITH: Record<string, true> = { concat: true, min: true, max: true };

/* -------------------------------------------------------------------------- */
/* What a name is                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where one name is live, over the linear order the body is written in.
 *
 * `live` is a list of half-open runs of event indices. Two names whose runs
 * never meet are never both live, so the same register can hold either; two
 * whose runs meet cannot, and the register one holds is the other's to be
 * spilled out of.
 */
export interface NameLiveness {
  /** The runs of the body over which the name is live. */
  readonly live: readonly (readonly [number, number])[];
  /**
   * Whether a call the body makes falls inside one of those runs — whether the
   * value has to still be there afterwards.
   *
   * This is what decides the file the register comes from: a name that has to
   * survive a call can only be held in one the convention says a callee leaves
   * as it found it, and one that does not can be held in a register that costs
   * the function nothing to enter and leave.
   */
  readonly acrossCall: boolean;
}

/* -------------------------------------------------------------------------- */
/* The graph                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One thing the body does, in the order it does it: a name read, a name written,
 * or a call made. An index over a list of these is a place in the instruction
 * stream, and a range of them is a stretch of that stream.
 */
type Event =
  | { readonly k: "read"; readonly name: string }
  | { readonly k: "def"; readonly name: string }
  | { readonly k: "call" };

/**
 * A run of events control passes through in one go, and where it goes after.
 *
 * A node is one statement, one block terminator, or one turn of a loop's test —
 * which is not a statement of its own but a place the body comes back to, so
 * it has to be one for the graph to close.
 */
interface Node {
  readonly events: Event[];
  readonly successors: Node[];
  liveIn: Set<string>;
  liveOut: Set<string>;
}

/* -------------------------------------------------------------------------- */
/* Building                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Puts a body into the graph, in the order the lowering writes it.
 *
 * The order of the events inside a node is the order `ir-machine.ts` evaluates
 * them in, and it is load-bearing: a name read before a call in the same node
 * is dead by the time the call is made, and one read after it is not. Two of
 * those orders are worth naming, because they are the ones a reader would
 * otherwise expect to be the other way round:
 *
 *   - an object or an array is **allocated first** and its fields written
 *     afterwards, so the runtime call comes before every value that fills it;
 *
 *   - the condition of a `select` is asked **before** either arm, so a name
 *     read only by the condition is already dead by the time an arm calls.
 *
 * Anything this cannot place is treated as a call, which costs a name a
 * callee-saved register it might have had a caller-saved one in. Being wrong
 * that way loses an instruction; being wrong the other way is a miscompile.
 */
class Graph {
  readonly nodes: Node[] = [];
  /** The loops whose blocks are being written, innermost last. */
  private readonly open: { header: string; exit: string; headerNode: Node; exitNode: Node }[] = [];

  /**
   * The statements that are also a call, which is what a backend that turns a
   * loop into a call into a runtime says here.
   *
   * A loop written as a team of threads is a call: the code stands where the
   * loop was and calls out, and whatever the convention does not preserve
   * across a call is gone for the rest of the body. Nothing in the IR says
   * so, because nothing in the IR knows the loop was not written as a loop —
   * so the backend that writes it that way says it here, and a name live
   * across one of these is held in a register a call leaves alone.
   */
  private readonly calls: (statement: SemanticStatement) => boolean;
  /**
   * The values that are a call, for a backend that writes some of them without
   * one.
   *
   * A builtin the compiler answers itself is written as instructions where the
   * IR says a call, and nothing it does takes a register away: a rounding is
   * arithmetic on the accumulator and the scratch beside it, which is what the
   * rest of the lowering writes with either. A body that rounds down once per
   * element of an array on every turn of a loop is then a body that calls
   * nothing at all, and every name it reaches for is one the convention does
   * not ask a callee to preserve — a register that costs the function nothing
   * to enter and leave, where a callee-saved one costs a push and a pop on
   * every one of the millions of calls it is written inside.
   *
   * What says it is the backend that lowers the call: the IR is written once
   * and every backend reads it, and only this one knows which of its builtins
   * are instructions here.
   */
  private readonly valueCalls: (callee: string) => boolean;

  constructor(
    calls: (statement: SemanticStatement) => boolean = () => false,
    valueCalls: (callee: string) => boolean = () => true,
  ) {
    this.calls = calls;
    this.valueCalls = valueCalls;
  }

  private make(events: Event[]): Node {
    const node: Node = { events, successors: [], liveIn: new Set(), liveOut: new Set() };
    this.nodes.push(node);
    return node;
  }

  private link(from: Node, to: Node): void {
    from.successors.push(to);
  }

  /** A body, and the place control reaches it from — what it falls out to. */
  block(body: SemanticBlock, after: Node | null): Node {
    const terminator = this.terminator(body, after);
    let flow: Node = terminator;
    let entry: Node | null = null;
    for (let at = body.statements.length - 1; at >= 0; at -= 1) {
      const statement = body.statements[at];
      const events: Event[] = [];
      // Where control goes once this statement is done, which is what the
      // arms of an `if`, the body of a block and the exit of a loop fall out to.
      const after = flow;
      let node: Node;
      switch (statement.k) {
        case "let":
          this.value(events, statement.value);
          events.push({ k: "def", name: statement.slot.name });
          node = this.make(events);
          break;
        case "set":
          this.value(events, statement.value);
          // Every operator but `=` reads what the name holds as well as the
          // value it is given, and it reads it after the value: the old value is
          // wanted once the new one has been computed, so a call inside the
          // value is a call the name has to survive.
          if (statement.op !== "=") events.push({ k: "read", name: statement.name });
          events.push({ k: "def", name: statement.name });
          node = this.make(events);
          break;
        case "setElement":
          // The value and the place are written before the buffer is named, and
          // the buffer keeps the pointer it had: what changes is what the
          // pointer reaches, not the pointer, so nothing here is a definition.
          this.value(events, statement.value);
          this.value(events, statement.index);
          events.push({ k: "read", name: statement.buffer });
          node = this.make(events);
          break;
        case "step":
          // `x++` reads the value it hands back and then writes the next one;
          // `++x` the other way round. Either way it is a read and a write, and
          // the read is put first because a postfix step is what carries the
          // old value into the expression it stands in.
          events.push({ k: "read", name: statement.name });
          events.push({ k: "def", name: statement.name });
          node = this.make(events);
          break;
        case "if": {
          this.value(events, statement.condition);
          node = this.make(events);
          const otherwise = statement.otherwise === null ? null : this.block(statement.otherwise, flow);
          // The arm that is taken falls out to the code after the whole `if`,
          // and not into the other arm: an arm is entered on the turn the
          // condition decided it, and the other arm runs on a turn this one
          // does not. Linking the two arms made every name the else arm reads
          // live across the then arm, which is a register or a spill the
          // program did not ask for.
          const thenEntry = this.block(statement.then, flow);
          // The arms are linked in the order they are written, which is what
          // fixes the order the nodes are numbered in below.
          this.link(node, thenEntry);
          this.link(node, otherwise ?? flow);
          break;
        }
        case "loop": {
          const loop = statement.loop;
          if (loop.kind === "counted") {
            this.value(events, loop.from);
            this.value(events, loop.to);
            this.value(events, loop.step);
            events.push({ k: "def", name: loop.variable });
          } else if (loop.kind === "each") {
            this.value(events, loop.length);
            events.push({ k: "def", name: loop.index });
            events.push({ k: "def", name: loop.element });
          }
          // A loop the backend writes as a call into a runtime is a call here
          // too, and it is made after the bound has been read: what is live
          // across the call is everything the body after it still reads.
          if (this.calls(statement)) events.push({ k: "call" });
          node = this.make(events);
          // The test is a place of its own: the body comes back to it on every
          // turn, and a name read or written by it is so on every turn with it.
          // A counted loop's counter is both — the test reads it and the step
          // writes it — and a walk's index is read for the address and stepped,
          // while the element is written from whatever the address produced.
          const headerEvents: Event[] = [];
          if (loop.kind === "while" || loop.kind === "doWhile") this.value(headerEvents, loop.condition);
          else if (loop.kind === "counted") headerEvents.push({ k: "read", name: loop.variable }, { k: "def", name: loop.variable });
          else headerEvents.push({ k: "read", name: loop.index }, { k: "def", name: loop.index }, { k: "def", name: loop.element });
          const headerNode = this.make(headerEvents);
          const exitNode = this.make([]);
          this.open.push({ header: loop.header, exit: loop.exit, headerNode, exitNode });
          const bodyEntry = this.block(loop.body, headerNode);
          this.open.pop();
          this.link(headerNode, bodyEntry);
          this.link(headerNode, exitNode);
          this.link(exitNode, flow);
          this.link(node, headerNode);
          break;
        }
        case "block":
          node = this.make(events);
          this.link(node, this.block(statement.body, flow));
          break;
        case "printText":
        case "printNumber":
          this.value(events, statement.value);
          events.push({ k: "call" });
          node = this.make(events);
          break;
        case "printNewline":
        case "retain":
          if (statement.k === "retain") this.value(events, statement.value);
          events.push({ k: "call" });
          node = this.make(events);
          break;
        case "call":
          for (const argument of statement.call.args) this.value(events, argument);
          if (this.valueCalls(statement.call.callee)) events.push({ k: "call" });
          node = this.make(events);
          break;
        case "raise":
          this.value(events, statement.message);
          events.push({ k: "call" });
          node = this.make(events);
          break;
        case "storeField":
          this.value(events, statement.object);
          this.value(events, statement.value);
          node = this.make(events);
          break;
        case "fill":
          // `a.fill(x)` is the same write a `setElement` is, of every element
          // at once: the value is read once for the whole walk and the array
          // is read as the place the elements are written into, so nothing
          // here is a definition. The index is a counter the backend binds
          // for itself, which no use of the body reads and no use of it
          // crosses.
          this.value(events, statement.value);
          events.push({ k: "read", name: statement.buffer });
          node = this.make(events);
          break;
        default: {
          // A statement kind this walk does not model would leave a name live
          // where it is not, and the register it is put in would be one the
          // missing read or write is carried across. Refusing it here says so
          // at the point the kind was added rather than as a miscompile.
          const unmodelled: never = statement;
          throw new Error(`liveness does not model the statement ${JSON.stringify(unmodelled)}`);
        }
      }
      // What runs next is what this statement leaves for. Every statement links
      // to it, not only the ones that open a block of their own: a `let` and
      // the `let` after it are two nodes with an edge between them, and without
      // that edge a value the first one produces and the second one reads has
      // nothing saying it is still wanted in between.
      this.link(node, after);
      entry = node;
      flow = node;
    }
    // A block with no statements of its own is entered and left at its
    // terminator, which is the one place control passes through.
    return entry ?? terminator;
  }

  private terminator(body: SemanticBlock, after: Node | null): Node {
    // Whatever the block owns is handed back to the runtime as it is left, and
    // the runtime call comes after everything the block computes and before
    // whatever runs next, so it sits in the terminator with the two of them.
    const freeing =
      body.releases.length > 0 || (body.terminator.k === "jump" && body.terminator.releases.length > 0);
    switch (body.terminator.k) {
      case "next": {
        const events: Event[] = freeing ? [{ k: "call" }] : [];
        const node = this.make(events);
        if (after !== null) this.link(node, after);
        return node;
      }
      case "return": {
        const events: Event[] = [];
        this.value(events, body.terminator.value);
        if (freeing) events.push({ k: "call" });
        return this.make(events);
      }
      // A block nothing arrives at links to nothing: it holds no name live
      // across a call, because no call runs after it and nothing reads what it
      // would have held.
      case "unreachable":
        return this.make([]);
      case "jump": {
        const node = this.make(freeing ? [{ k: "call" }] : []);
        // A jump names the header or the exit of a loop it is inside, and the
        // innermost one that answers to the name is the one it leaves for.
        for (let at = this.open.length - 1; at >= 0; at -= 1) {
          const loop = this.open[at] as (typeof this.open)[number];
          if (loop.header === body.terminator.target) {
            this.link(node, loop.headerNode);
            break;
          }
          if (loop.exit === body.terminator.target) {
            this.link(node, loop.exitNode);
            break;
          }
        }
        return node;
      }
    }
  }

  /** One value, in the order the lowering evaluates it in. */
  private value(events: Event[], value: SemanticValue | null): void {
    if (value === null) return;
    switch (value.k) {
      case "local":
        events.push({ k: "read", name: value.name });
        return;
      case "call":
        for (const argument of value.call.args) this.value(events, argument);
        // A builtin the backend answers with instructions is a call the IR
        // states and the code does not make, and a name live across one of
        // those is live across arithmetic.
        if (this.valueCalls(value.call.callee)) events.push({ k: "call" });
        return;
      case "newObject":
      case "buffer": {
        // The allocation comes first and the fields are written into what it
        // answered, so the call is before every value that fills the object.
        events.push({ k: "call" });
        const fields = value.k === "newObject" ? value.fields.map((field) => field.value) : value.values;
        for (const field of fields) this.value(events, field);
        return;
      }
      case "loadField":
        this.value(events, value.object);
        return;
      case "element":
        this.value(events, value.of);
        this.value(events, value.index);
        return;
      case "arith": {
        // The two sides are written in the order the lowering writes them in,
        // and it is not the same for every operation. A concatenation is laid
        // out a part at a time from the left, and so is a minimum and a
        // maximum, whose two values are taken and then compared. A float sum or
        // a float product takes its sides either way round and writes the left
        // one first, since either may be the instruction's own literal. A wide
        // product, quotient or shift is a kernel that is handed both sides as
        // pointers, and the left one is written first.
        //
        // Everything else is written right side first: the side that is not the
        // instruction's own immediate is written first and parked while the
        // other side is written.
        //
        // The order decides what is live across a call, so an order that does
        // not match this one marks a name dead before a call the lowering makes
        // after reading it, and hands it a register the callee is free to
        // overwrite first. Being wrong that way is a miscompile; being right
        // costs a register a callee would have preserved.
        const commutative = value.op === "add" || value.op === "mul";
        const wide = isWideType(value.type);
        const leftFirst =
          LEFT_FIRST_ARITH[value.op] === true ||
          (commutative && isFloat(value.type)) ||
          (wide && (value.op === "mul" || value.op === "div" || value.op === "shl" || value.op === "shr"));
        if (leftFirst) {
          this.value(events, value.left);
          this.value(events, value.right);
        } else {
          this.value(events, value.right);
          this.value(events, value.left);
        }
        // A power is `pow` and a concatenation is the runtime building a string
        // out of its two sides; every other arithmetic on a number the machine
        // holds is one instruction the machine carries out itself.
        //
        // A whole number wider than a machine word is the exception: it has no
        // instruction, so a multiplication or a division of one is the runtime
        // kernel, which is a real call and clobbers every register the caller
        // saved. Leaving these out pins the names around them to registers that
        // the kernel overwrites.
        if (value.op === "pow" || value.op === "concat" || value.op === "arrayConcat") {
          events.push({ k: "call" });
        } else if ((value.op === "mul" || value.op === "div") && isWideType(value.type)) {
          events.push({ k: "call" });
        }
        return;
      }
      case "compare": {
        // A comparison of two numbers is written right side first: it is
        // written down and the left one is compared against it. A comparison of
        // two strings and a comparison of two whole numbers wider than a machine
        // word are written left side first, so where the two orders disagree
        // this is the order the lowering writes the one that is not a number
        // in.
        if (isWideType(value.operand) || isTextType(value.operand)) {
          this.value(events, value.left);
          this.value(events, value.right);
        } else {
          this.value(events, value.right);
          this.value(events, value.left);
        }
        // Two numbers are compared by the machine itself; anything else is
        // compared by the C library, which is a call.
        if (value.operand.kind !== "primitive") events.push({ k: "call" });
        return;
      }
      case "logical":
      case "coalesce":
        this.value(events, value.left);
        this.value(events, value.right);
        return;
      case "select":
        // The condition is asked before either arm, and only one arm runs, so
        // a name read by the condition alone is dead before either of them.
        this.value(events, value.condition);
        this.value(events, value.then);
        this.value(events, value.otherwise);
        return;
      case "unary":
      case "isNull":
        this.value(events, value.operand);
        return;
      case "toText":
        // A number written as text is formatted by the runtime, which is a call
        // that writes the argument registers; a string written as text is not.
        this.value(events, value.of);
        if (!isTextType(value.of.type)) events.push({ k: "call" });
        return;
      case "length":
        this.value(events, value.of);
        events.push({ k: "call" });
        return;
      case "text":
        for (const part of value.parts) {
          if (part.k === "value") this.value(events, part.value);
        }
        // A text is built by the runtime: the buffer is allocated and every
        // part copied into it by a library call.
        events.push({ k: "call" });
        return;
      case "argv":
        this.value(events, value.index);
        events.push({ k: "call" });
        return;
      case "const":
      case "bool":
      case "nothing":
        return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Solving                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where every name of a body is live, and whether any call the body makes falls
 * inside it.
 *
 * `entry` is where control starts, and `parameters` are the names that already
 * hold a value before the first statement runs — a name among them is live from
 * the first instruction of the body, which is where a register it is given is
 * written, and a run that started at its first read would let another name take
 * that register over the prologue.
 *
 * `calls` names the statements that are a call as well as whatever the body
 * says of them, which is how a backend that writes a loop as a call into a
 * runtime gets the names live across that call held in registers one survives.
 *
 * `valueCalls` answers the same question of a value: it says which of the IR's
 * calls the backend is writing as instructions rather than as a call, and a
 * name live across one of those is not across a call at all.
 */
export function nameLiveness(
  entry: SemanticBlock,
  parameters: readonly string[] = [],
  calls: (statement: SemanticStatement) => boolean = () => false,
  valueCalls: (callee: string) => boolean = () => true,
): Map<string, NameLiveness> {
  const graph = new Graph(calls, valueCalls);
  const root = graph.block(entry, null);

  // The nodes in the order control reaches them, which for a body the lowering
  // walks front to back is the order it writes them in.
  const ordered: Node[] = [];
  const seen = new Set<Node>();
  const visit = (node: Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    ordered.push(node);
    for (const successor of node.successors) visit(successor);
  };
  visit(root);

  const uses = new Map<Node, Set<string>>();
  const defines = new Map<Node, Set<string>>();
  for (const node of ordered) {
    const read = new Set<string>();
    const written = new Set<string>();
    for (const event of node.events) {
      if (event.k === "read") read.add(event.name);
      else if (event.k === "def") written.add(event.name);
    }
    uses.set(node, read);
    defines.set(node, written);
  }

  // A name read before it is written in the same node is read on the way in,
  // so the fixed point starts from the reads and works backwards to a stop.
  let changed = true;
  while (changed) {
    changed = false;
    for (let at = ordered.length - 1; at >= 0; at -= 1) {
      const node = ordered[at] as Node;
      const out = new Set<string>();
      for (const successor of node.successors) for (const name of successor.liveIn) out.add(name);
      const written = defines.get(node) as Set<string>;
      const read = uses.get(node) as Set<string>;
      const into = new Set<string>(read);
      for (const name of out) if (!written.has(name)) into.add(name);
      if (!same(node.liveOut, out) || !same(node.liveIn, into)) {
        node.liveOut = out;
        node.liveIn = into;
        changed = true;
      }
    }
  }

  // The places of the body, numbered as they are written: every event of a node
  // takes one index, and the nodes run in the order control reaches them.
  const base = new Map<Node, number>();
  let next = 0;
  for (const node of ordered) {
    base.set(node, next);
    next += node.events.length;
  }

  const live = new Map<string, Set<number>>();
  const across = new Map<string, boolean>();
  const note = (name: string, at: number): void => {
    const found = live.get(name);
    if (found === undefined) live.set(name, new Set([at]));
    else found.add(at);
  };

  for (const node of ordered) {
    const at = base.get(node) as number;
    const written = defines.get(node) as Set<string>;
    // Carried backwards from where control goes, which is what says whether a
    // name is still wanted after this node has run.
    let out = new Set(node.liveOut);
    for (let index = node.events.length - 1; index >= 0; index -= 1) {
      const event = node.events[index] as Event;
      if (event.k === "call") {
        for (const name of out) if (across.get(name) !== true) across.set(name, true);
      } else if (event.k === "read") {
        note(event.name, at + index);
      }
      if (event.k === "def") out.delete(event.name);
      if (event.k === "read") out.add(event.name);
    }
    // A name the node is live for on the way in is live at every event of it:
    // the scan above cannot see a value that arrives already wanted and is
    // wanted again at the end, because the two ends of the node are joined by
    // the graph and not by the list.
    for (const name of node.liveIn) note(name, at);
    for (const name of written) note(name, at);
  }
  // A parameter holds its value before the body starts, so it is live from the
  // first instruction of it — which is where the prologue writes the register
  // it is given.
  for (const name of parameters) {
    const found = live.get(name);
    if (found === undefined) live.set(name, new Set([0]));
    else if (found.size > 0) found.add(0);
  }

  const result = new Map<string, NameLiveness>();
  for (const [name, points] of live) {
    const sorted = [...points].sort((left, right) => left - right);
    const first = sorted[0] as number;
    const last = sorted[sorted.length - 1] as number;
    // One run from the first place the name is written to the last it is read,
    // and not a run per place it is touched.
    //
    // This backend gives a name one register for the whole of its life and
    // never reloads it: the register is written at each write and read at each
    // read, so between the first write and the last read it is carrying the
    // value and nothing else may be put there. A name touched at two places
    // with a call between them is live across every instruction in between for
    // exactly that reason, and reading the places it is touched as if they
    // were separate runs would let another name take the register over the
    // stretch between them.
    result.set(name, { live: [[first, last + 1]], acrossCall: across.get(name) === true });
  }
  return result;
}

function same(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const name of left) if (!right.has(name)) return false;
  return true;
}

/** Whether two runs of places meet, which is what says two names want one register. */
export function overlaps(
  left: readonly (readonly [number, number])[],
  right: readonly (readonly [number, number])[],
): boolean {
  for (const [from, until] of left) {
    for (const [other, ends] of right) if (from < ends && other < until) return true;
  }
  return false;
}
