import assert from "node:assert/strict";
import { test } from "node:test";
import { parseContract } from "../semantics/contract.ts";
import { planProbe } from "../toolchain/probe.ts";
import { generateProbeHarness } from "../toolchain/linker.ts";
import type { FunctionContract, FunctionParam, ObjectLayout } from "../core/types.ts";

const NODE: ObjectLayout = {
  name: "Object1",
  size: 16,
  align: 8,
  fields: [
    { name: "left", type: "ref<any>", offset: 0 },
    { name: "right", type: "ref<any>", offset: 8 },
  ],
};

/** Parameters written the way a source signature reads, as the other tests here write them. */
function paramList(text: string): FunctionParam[] {
  if (text === "") return [];
  return text.split(",").map((entry) => {
    const [name, type] = entry.split(":").map((part) => part.trim());
    return { name, type };
  });
}

/** A function that states no postcondition, so the program it is part of is the only thing that can check it. */
function definition(overrides: Partial<FunctionContract> = {}, params = "n: f64"): FunctionContract {
  return {
    version: "1",
    function: { name: "measure", symbol: "measure", params: paramList(params), returns: "f64" },
    requires: [],
    ensures: [],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "throughput" },
    definition: {
      statements: [{ kind: "result", value: { k: "binary", op: "+", left: { k: "ident", name: "n" }, right: { k: "literal", text: "0" } }, line: 1 }],
      objects: {},
      allocates: false,
      prints: false,
      readsArgv: false,
      calls: [],
    },
    ...overrides,
  };
}

test("a contract that states a result is verified against its own vectors, not probed", () => {
  // The function has a body here as it does everywhere: what stops the probe
  // is the postcondition beside it, not the presence of a body.
  const contract = definition({ ensures: ["result == n * 2.0"] });
  const plan = planProbe(contract, parseContract(contract));
  assert.equal(plan.kind, "skip");
  assert.match(plan.kind === "skip" ? plan.reason : "", /states what the function returns/);
});

test("an input the contract's own preconditions reject is never run", () => {
  const contract = definition({ requires: ["n > 100.0"] });
  const plan = planProbe(contract, parseContract(contract));
  assert.equal(plan.kind, "skip");
  // The zero the probe would pass is not inside the domain the contract states,
  // so a candidate is not turned away for whatever it does with it.
  assert.match(plan.kind === "skip" ? plan.reason : "", /outside the domain it states: n > 100.0/);
});

test("a reference the contract does not lay out is not passed as null", () => {
  // An `any` the front end never narrowed has no shape, and a null one would be
  // the compiler asserting that null is a legal argument. A candidate that
  // reads through it is then faulted for believing the compiler.
  const contract = definition({}, "node: ref<any>");
  const plan = planProbe(contract, parseContract(contract));
  assert.equal(plan.kind, "skip");
  assert.match(
    plan.kind === "skip" ? plan.reason : "",
    /"node" is a reference to an object the contract does not lay out/,
  );
});

test("a reference the contract lays out is built, and the call is made once", () => {
  const contract = definition({}, "node: ref<Object1>");
  contract.definition = { ...contract.definition!, objects: { Object1: NODE } };
  const plan = planProbe(contract, parseContract(contract));

  assert.equal(plan.kind, "call");
  if (plan.kind !== "call") return;
  assert.deepEqual(plan.callArguments, ["node_probe"]);
  // The object goes through the runtime, so the payload lands where the
  // contract says its fields are, and its fields default to null.
  const built = plan.statements.join("\n");
  assert.match(built, /blaze_rt_object_new\(16, 8\)/);
  assert.match(built, /node_probe->left = \(void\*\)\(NULL\);/);
  assert.match(built, /node_probe->right = \(void\*\)\(NULL\);/);

  const harness = generateProbeHarness(contract, plan);
  assert.match(harness, /extern double measure\(struct Object1\* node\);/);
  assert.match(harness, /volatile double probe_result = measure\(node_probe\);/);
  // The result is held and dropped. Nothing is printed and nothing is compared,
  // so a candidate that returns the wrong answer passes this.
  assert.doesNotMatch(harness, /RESULT/);
});

test("a buffer argument is a buffer the call may use, not a null pointer", () => {
  // The preconditions are read against a buffer that is there, so the call
  // has to be given one: `a != null` was just accepted and then a null
  // pointer was handed over, which faults a candidate for the fault rather
  // than for the arithmetic. The count is the one the contract states, so a
  // precondition that needs elements to be there still refuses the call.
  const contract = definition({ requires: ["values != null"] }, "values: slice<f64>, n: f64");
  const plan = planProbe(contract, parseContract(contract));
  assert.equal(plan.kind, "call");
  if (plan.kind !== "call") return;
  assert.match(plan.statements.join("\n"), /blaze_rt_array_new\(0, sizeof\(double\)\)/);
  assert.match(plan.callArguments[0] ?? "", /\(double\*\)values_probe_buffer/);
});

test("a contract that needs elements of a buffer has no input the probe can build", () => {
  // The probe is only run on an input the contract says is inside its domain.
  // An empty buffer is outside a domain that asks for two elements, so nothing
  // is run rather than a buffer short of what the contract promised.
  const contract = definition({ requires: ["values != null", "len(values) >= 2"] }, "values: slice<f64>, n: f64");
  const plan = planProbe(contract, parseContract(contract));
  assert.equal(plan.kind, "skip");
  assert.match(plan.kind === "skip" ? plan.reason : "", /outside the domain it states: len\(values\) >= 2/);
});

test("a layout that reaches itself is built to a fixed depth", () => {
  const contract = definition({}, "node: ref<Object1>");
  contract.definition = {
    ...contract.definition!,
    objects: {
      Object1: { ...NODE, fields: [{ name: "next", type: "ref<Object2>", offset: 0 }, { name: "pad", type: "f64", offset: 8 }] },
      Object2: { name: "Object2", size: 8, align: 8, fields: [{ name: "next", type: "ref<Object2>", offset: 0 }] },
    },
  };
  const plan = planProbe(contract, parseContract(contract));
  assert.equal(plan.kind, "call");
  // The chain stops at a null rather than following Object2 back into itself.
  const built = plan.kind === "call" ? plan.statements.join("\n") : "";
  assert.match(built, /node_next_next_next_probe->next = \(struct Object2\*\)\(NULL\);/);
  assert.doesNotMatch(built, /node_next_next_next_next/);
});

test("a function of no parameters that returns nothing is called, and holds nothing", () => {
  const contract = definition({ function: { name: "report", symbol: "report", params: [], returns: "void" } }, "");
  const plan = planProbe(contract, parseContract(contract));
  assert.equal(plan.kind, "call");
  if (plan.kind !== "call") return;
  assert.deepEqual(plan.callArguments, []);
  // A function that returns nothing has nothing to hold, and a variable of type
  // void is not C.
  const harness = generateProbeHarness(contract, plan);
  assert.match(harness, /extern void report\(void\);/);
  assert.match(harness, /\n {2}report\(\);\n/);
  assert.doesNotMatch(harness, /probe_result/);
});

test("a number is zero and a flag is false", () => {
  const contract = definition({}, "n: f64, ok: bool, count: usize");
  const plan = planProbe(contract, parseContract(contract));
  assert.equal(plan.kind, "call");
  if (plan.kind !== "call") return;
  assert.deepEqual(plan.callArguments, ["0", "false", "0"]);
});
