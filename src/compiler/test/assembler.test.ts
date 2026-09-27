import assert from "node:assert/strict";
import { test } from "node:test";
import { readAssemblyStructure, validateAssembly } from "../toolchain/assembler.ts";
import { CompilerError } from "../core/errors.ts";
import { parseContract } from "../semantics/contract.ts";
import type { FunctionContract } from "../core/types.ts";

const REFERENCE = `	.globl	dotProduct
	.type	dotProduct, @function
dotProduct:
	movq	%rdi, %r8
	movq	%rsi, %r9
	vxorps	%xmm0, %xmm0, %xmm0
	movq	%rdx, %rax
	shrq	$2, %rax
	je	.Ltail
.Lloop4:
	vmovups	(%r8), %ymm2
	addq	$16, %r8
	subq	$1, %rax
	jne	.Lloop4
	vaddss	%xmm2, %xmm0, %xmm0
.Ltail:
	ret
	.size	dotProduct, .-dotProduct
`;

function contract(): FunctionContract {
  return {
    version: "1",
    function: {
      name: "dotProduct",
      symbol: "dotProduct",
      params: [
        { name: "a", type: "ptr<f32>" },
        { name: "b", type: "ptr<f32>" },
        { name: "n", type: "usize" },
      ],
      returns: "f32",
    },
    requires: ["a != null", "len(a) >= n"],
    ensures: ["result == sum(i = 0..<n, a[i] * b[i])"],
    memory: { reads: ["a[0:n]"], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
      optimize: { primary: "throughput" },
  };
}

/** The reason a candidate is rejected is the diagnostic the model is shown. */
function rejection(assembly: string, pattern: RegExp): void {
  let detail: string | undefined;
  try {
    validateAssembly(assembly, contract(), "c1");
  } catch (error) {
    detail = error instanceof CompilerError ? `${error.message}\n${error.detail ?? ""}` : String(error);
  }
  assert.ok(detail !== undefined, `expected the candidate to be rejected:\n${assembly}`);
  assert.match(detail, pattern);
}

test("a well formed candidate passes validation", () => {
  validateAssembly(REFERENCE, contract(), "c1");
});

test("registers, immediates and displacements are not mistaken for symbols", () => {
  const structure = readAssemblyStructure(REFERENCE);
  assert.deepEqual([...new Set(structure.referencedSymbols)].sort(), [".Lloop4", ".Ltail"]);
  assert.ok(structure.definedLabels.has(".Lloop4"));
  assert.ok(structure.definedLabels.has("dotProduct"));
});

test("a label may share its line with the instruction it introduces", () => {
  const structure = readAssemblyStructure("\t.globl dotProduct\ndotProduct:\ttest %rdx, %rdx\n1:\tret\n");
  assert.deepEqual(
    structure.instructions.map((instruction) => instruction.mnemonic),
    ["test", "ret"],
  );
  assert.deepEqual(structure.referencedSymbols, []);
  assert.ok(structure.definedLabels.has("dotProduct"));
  assert.ok(structure.definedLabels.has("1"));
  validateAssembly(
    "\t.globl dotProduct\ndotProduct:\ttest %rdx, %rdx\n1:\tret\n",
    contract(),
    "c1",
  );
});

test("a rip relative operand counts as a symbol reference", () => {
  const structure = readAssemblyStructure("\tmovl\ttable(%rip), %eax\n");
  assert.deepEqual(structure.referencedSymbols, ["table"]);
});

test("comments are stripped before the structure is read", () => {
  const structure = readAssemblyStructure("# a comment\n\tmovq %rdi, %r8 /* inline */ # trailing\n");
  assert.equal(structure.instructions.length, 1);
  assert.deepEqual(structure.referencedSymbols, []);
});

test("a candidate that changes the architecture is rejected", () => {
  rejection(".arch znver1\n\t.globl dotProduct\ndotProduct:\n\tret\n", /directive "\.arch" is not allowed/);
  rejection("\t.include \"other.s\"\n\t.globl dotProduct\ndotProduct:\n\tret\n", /directive "\.include" is not allowed/);
  rejection("\t.section .note.GNU-stack\n\t.globl dotProduct\ndotProduct:\n\tret\n", /only the \.text section/);
});

test("a candidate that reaches outside the contract is rejected", () => {
  rejection("\t.globl dotProduct\ndotProduct:\n\tsyscall\n\tret\n", /"syscall" is not allowed/);
  rejection("\t.globl dotProduct\ndotProduct:\n\tint $0x80\n\tret\n", /"int" is not allowed/);
  rejection("\t.globl dotProduct\ndotProduct:\n\tcall helper\n\tret\n", /"helper" is referenced but not defined/);
  rejection("\t.globl dotProduct\ndotProduct:\n\tjmp memcpy\n\tret\n", /"memcpy" is referenced but not defined/);
});

test("a candidate may not define or export anything else", () => {
  rejection("\t.globl dotProduct\n\t.globl helper\ndotProduct:\n\tret\nhelper:\n\tret\n", /only "dotProduct" may be exported/);
  rejection("\t.globl dotProduct\ndotProduct:\n\tret\nhelper:\n\tret\n", /"helper" is defined but the contract only allows/);
});


test("a candidate that calls with the stack off a boundary is rejected", () => {
  // A candidate arrives with the return address on the stack, so it is 8 past
  // a 16-byte boundary already. Allocating a multiple of 16 leaves it there,
  // and the first movaps inside the C runtime it calls faults on it, so the
  // delivered program dies before it prints anything. The candidate that
  // shipped for binarytrees main was exactly this.
  rejection(
    "\t.globl dotProduct\ndotProduct:\n\tsubq\t$128, %rsp\n\tcall\tblaze_rt_print_newline\n\taddq\t$128, %rsp\n\tret\n",
    /line 4: "call blaze_rt_print_newline" is made with rsp 8 byte\(s\) off a 16-byte boundary/,
  );
  // The same shape with the frame it takes the eight bytes back.
  validateAssembly(
    "\t.globl dotProduct\ndotProduct:\n\tsubq\t$136, %rsp\n\tcall\tblaze_rt_print_newline\n\taddq\t$136, %rsp\n\tret\n",
    contract(),
    "c1",
  );
  // A frame a push built is the other way of getting back onto a boundary.
  validateAssembly(
    "\t.globl dotProduct\ndotProduct:\n\tpushq\t%rbp\n\tcall\tblaze_rt_print_newline\n\tpopq\t%rbp\n\tret\n",
    contract(),
    "c1",
  );
  // Realigning outright is the third, and it says so.
  validateAssembly(
    "\t.globl dotProduct\ndotProduct:\n\tandq\t$-16, %rsp\n\tcall\tblaze_rt_print_newline\n\tret\n",
    contract(),
    "c1",
  );
  // A call made from the frame it is in needs the eight bytes put back first.
  rejection(
    "\t.globl dotProduct\ndotProduct:\n\tcall\tblaze_rt_print_newline\n\tret\n",
    /line 3: "call blaze_rt_print_newline" is made with rsp 8 byte\(s\) off a 16-byte boundary/,
  );
  // One turn of a loop is not the whole of a loop: a frame the second turn
  // round moves is a frame the call in it was made from too, whichever order
  // the two turns are walked in.
  rejection(
    [
      "\t.globl dotProduct",
      "dotProduct:",
      "\tsubq\t$136, %rsp",
      ".Lloop:",
      "\tcall\tblaze_rt_print_newline",
      "\taddq\t$8, %rsp",
      "\tdecq\t%rax",
      "\tjne\t.Lloop",
      "\tret",
      "",
    ].join("\n"),
    /line 5: "call blaze_rt_print_newline" is made with rsp 8 byte\(s\) off a 16-byte boundary/,
  );
  // The same holds for two branches that build their frame differently, where
  // only one of the two gets it right.
  rejection(
    [
      "\t.globl dotProduct",
      "dotProduct:",
      "\ttest\t%rdi, %rdi",
      "\tje\t.Lodd",
      "\tsubq\t$136, %rsp",
      "\tjmp\t.Lcall",
      ".Lodd:",
      "\tsubq\t$144, %rsp",
      ".Lcall:",
      "\tcall\tblaze_rt_print_newline",
      "\tleave",
      "\tret",
      "",
    ].join("\n"),
    /line 10: "call blaze_rt_print_newline" is made with rsp 8 byte\(s\) off a 16-byte boundary/,
  );
});

test("a candidate the walk cannot follow is not turned away over its alignment", () => {
  // rsp moved by something the walk does not read leaves nothing to judge.
  validateAssembly(
    "\t.globl dotProduct\ndotProduct:\n\tsubq\t%rdi, %rsp\n\tcall\tblaze_rt_print_newline\n\tret\n",
    contract(),
    "c1",
  );
  // Nor is one whose frame is put back from a register, or recomputed from a
  // frame pointer, because neither is an offset the walk can read.
  validateAssembly(
    "\t.globl dotProduct\ndotProduct:\n\tmovq\t%rbp, %rsp\n\tcall\tblaze_rt_print_newline\n\tret\n",
    contract(),
    "c1",
  );
  validateAssembly(
    "\t.globl dotProduct\ndotProduct:\n\tleaq\t-8(%rbp), %rsp\n\tcall\tblaze_rt_print_newline\n\tret\n",
    contract(),
    "c1",
  );
  // A loop the walk loses the stack in on the first turn is lost in on the
  // second as well, so it is not a fault it can point at.
  validateAssembly(
    [
      "\t.globl dotProduct",
      "dotProduct:",
      ".Lloop:",
      "\tmovq\t%rbp, %rsp",
      "\tcall\tblaze_rt_print_newline",
      "\tdecq\t%rax",
      "\tjne\t.Lloop",
      "\tret",
      "",
    ].join("\n"),
    contract(),
    "c1",
  );
  // A frame the candidate never calls out of is its own business.
  validateAssembly(
    "\t.globl dotProduct\ndotProduct:\n\tsubq\t$128, %rsp\n\tmovq\t%rax, 8(%rsp)\n\taddq\t$128, %rsp\n\tret\n",
    contract(),
    "c1",
  );
});
test("the contracted function must be global and present", () => {
  rejection("dotProduct:\n\tret\n", /must declare "dotProduct" global/);
  rejection("\t.globl dotProduct\n\tret\n", /never defined/);
  rejection("\t.globl other\nother:\n\tret\n", /not part of the contract/);
});

test("a candidate with nothing but comments is rejected", () => {
  rejection("   \n# nothing here\n", /contains no instructions/);
  assert.throws(() => validateAssembly("   \n", contract(), "c1"), /contains no assembly/);
});

test("the contract used by the tests is itself valid", () => {
  parseContract(contract());
});
