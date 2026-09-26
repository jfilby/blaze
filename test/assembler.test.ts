import assert from "node:assert/strict";
import { test } from "node:test";
import { readAssemblyStructure, validateAssembly } from "../src/compiler/toolchain/assembler.ts";
import { CompilerError } from "../src/compiler/core/errors.ts";
import { parseContract } from "../src/compiler/semantics/contract.ts";
import type { FunctionContract } from "../src/compiler/core/types.ts";

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
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
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
