/**
 * What the instruction encoder writes is the instruction the compiler meant.
 *
 * A `machine` build lowers a function's IR through this encoder and links the
 * object beside a runtime, so a byte that names the wrong register, the wrong
 * field or the wrong precision produces a program that assembles, links and
 * runs and answers something else. The assembler is the authority on what an
 * encoding means, so every case below is written out as bytes and read back
 * through it rather than against a second copy of the same expectations.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../core/process.ts";
import {
  Encoder,
  RAX,
  RCX,
  RDX,
  RSP,
  RBP,
  RSI,
  RDI,
  RBX,
  R8,
  R9,
  R10,
  R11,
  R12,
  R13,
  R14,
  R15,
  XMM0,
  XMM1,
  XMM8,
  XMM10,
  XMM15,
  frame,
} from "../toolchain/x86.ts";
import { scratch } from "./scratch.ts";

/** One encoding, and the last instruction the assembler must read back. */
interface Case {
  readonly name: string;
  readonly build: (encoder: Encoder) => void;
  readonly want: string;
}

/**
 * The registers above seven. Each is named by exactly one bit of the extension
 * prefix, and that bit belongs to the field the register is written in, so an
 * encoder that takes it from the wrong field writes a different register
 * entirely — `rsp` where `r12` was meant, most of the time.
 */
const HIGH: readonly number[] = [R8, R9, R12, R13, R14, R15, RBX, RSI, RDI, RBP, RDX, RCX];

/** The registers the three low bits of a field cannot name. */
const EXTENDED: readonly number[] = [R8, R9, R10, R11, R12, R13, R14, R15];

/**
 * How the assembler spells a register at each width. The eight below eight
 * have a name of their own at every width; every register above seven has one
 * name for all of them, which is the set the extension prefix reaches.
 */
const SPELLED: Record<number, { R: string; D: string; B: string; W: string }> = {
  [RAX]: { R: "%rax", D: "%eax", B: "%al", W: "%ax" },
  [RCX]: { R: "%rcx", D: "%ecx", B: "%cl", W: "%cx" },
  [RDX]: { R: "%rdx", D: "%edx", B: "%dl", W: "%dx" },
  [RSP]: { R: "%rsp", D: "%esp", B: "%spl", W: "%sp" },
  [RBP]: { R: "%rbp", D: "%ebp", B: "%bpl", W: "%bp" },
  [RBX]: { R: "%rbx", D: "%ebx", B: "%bl", W: "%bx" },
  [RSI]: { R: "%rsi", D: "%esi", B: "%sil", W: "%si" },
  [RDI]: { R: "%rdi", D: "%edi", B: "%dil", W: "%di" },
  [R8]: { R: "%r8", D: "%r8d", B: "%r8b", W: "%r8w" },
  [R9]: { R: "%r9", D: "%r9d", B: "%r9b", W: "%r9w" },
  [R12]: { R: "%r12", D: "%r12d", B: "%r12b", W: "%r12w" },
  [R13]: { R: "%r13", D: "%r13d", B: "%r13b", W: "%r13w" },
  [R14]: { R: "%r14", D: "%r14d", B: "%r14b", W: "%r14w" },
  [R15]: { R: "%r15", D: "%r15d", B: "%r15b", W: "%r15w" },
};

/** The whole-number encodings, for one register at a time. */
function wholeNumberCases(register: number): Case[] {
  const names = SPELLED[register];
  const { R, D, B, W } = names;
  return [
    // The operand field holds the register, so the extension's B bit is the
    // only thing that names it.
    { name: `add one to ${R}`, build: (e) => e.aluImm("add", register, 1, true), want: `add $0x1,${R}` },
    { name: `take 4096 off ${R}`, build: (e) => e.aluImm("sub", register, 4096, true), want: `sub $0x1000,${R}` },
    { name: `compare ${R} with 10 at half width`, build: (e) => e.aluImm("cmp", register, 10, false), want: `cmp $0xa,${D}` },
    { name: `exclusive or ${R} with itself`, build: (e) => e.alu("xor", register, register, false), want: `xor ${D},${D}` },
    { name: `add rax into ${R}`, build: (e) => e.alu("add", register, RAX, true), want: `add %rax,${R}` },
    { name: `and al into ${B}`, build: (e) => e.alu8("and", register, RAX), want: `and %al,${B}` },
    { name: `divide by ${R}`, build: (e) => e.divide("idiv", register, true), want: `idiv ${R}` },
    { name: `divide unsigned by ${D}`, build: (e) => e.divide("div", register, false), want: `div ${D}` },
    { name: `multiply ${R} by rax`, build: (e) => e.imul(register, RAX, true), want: `imul %rax,${R}` },
    { name: `multiply ${R} by seven`, build: (e) => e.imulImm(register, 7, true), want: `imul $0x7,${R},${R}` },
    { name: `shift ${R} right`, build: (e) => e.shift("shr", register, true), want: `shr %cl,${R}` },
    { name: `shift ${R} left by three`, build: (e) => e.shiftImm("shl", register, 3, true), want: `shl $0x3,${R}` },
    { name: `negate ${R}`, build: (e) => e.neg(register, true), want: `neg ${R}` },
    { name: `complement ${D}`, build: (e) => e.not(register, false), want: `not ${D}` },
    { name: `test ${R}`, build: (e) => e.test(register, true), want: `test ${R},${R}` },
    { name: `write a condition into ${B}`, build: (e) => e.setcc("e", register), want: `sete ${B}` },
    { name: `widen al into ${D}`, build: (e) => e.movzxReg8(register, RAX), want: `movzbl %al,${D}` },
    { name: `move eax into ${D}`, build: (e) => e.movRegReg32(register, RAX), want: `mov %eax,${D}` },
    { name: `move rax into ${R}`, build: (e) => e.movRegReg(register, RAX), want: `mov %rax,${R}` },
    { name: `read ${R} out of the frame`, build: (e) => e.movRegMem(register, frame(8)), want: `mov 0x8(%rsp),${R}` },
    { name: `write ${R} into the frame`, build: (e) => e.movMemReg(frame(8), register), want: `mov ${R},0x8(%rsp)` },
    { name: `address of the frame into ${R}`, build: (e) => e.lea(register, frame(16)), want: `lea 0x10(%rsp),${R}` },
    { name: `add the frame into ${R}`, build: (e) => e.aluRegMem("add", register, frame(16), true), want: `add 0x10(%rsp),${R}` },
    { name: `move over ${R} unless equal`, build: (e) => e.cmov("ne", register, RAX, true), want: `cmovne %rax,${R}` },
    { name: `zero ${D} by immediate`, build: (e) => e.movRegImm(register, 0n), want: `xor ${D},${D}` },
    { name: `set ${D} to five by immediate`, build: (e) => e.movRegImm(register, 5n), want: `mov $0x5,${D}` },
    { name: `set ${R} to a whole word`, build: (e) => e.movRegImm(register, 0x1_0000_0000n), want: `movabs $0x100000000,${R}` },
    { name: `set ${R} to a negative whole word`, build: (e) => e.movRegImm(register, -5_000_000_000n), want: `movabs $0xfffffffed5fa0e00,${R}` },
    // A widening form without the extension's W bit names a 32 bit destination,
    // which clears the upper half of the register instead of filling it with
    // the sign of the narrow value it read.
    { name: `read a signed half word into ${R}`, build: (e) => e.movRegMemSized(register, frame(8), 4, true), want: `movslq 0x8(%rsp),${R}` },
    { name: `read an unsigned half word into ${D}`, build: (e) => e.movRegMemSized(register, frame(8), 4, false), want: `mov 0x8(%rsp),${D}` },
    { name: `read a signed byte into ${D}`, build: (e) => e.movRegMemSized(register, frame(8), 1, true), want: `movsbl 0x8(%rsp),${D}` },
    { name: `read an unsigned word into ${D}`, build: (e) => e.movRegMemSized(register, frame(8), 2, false), want: `movzwl 0x8(%rsp),${D}` },
    { name: `narrow eax to a signed ${R}`, build: (e) => e.narrow(register, RAX, 4, true), want: `movslq %eax,${R}` },
    { name: `narrow eax to an unsigned ${D}`, build: (e) => e.narrow(register, RAX, 4, false), want: `mov %eax,${D}` },
    { name: `narrow al to a signed ${D}`, build: (e) => e.narrow(register, RAX, 1, true), want: `movsbl %al,${D}` },
    { name: `move rax into ${R} at full width`, build: (e) => e.narrow(register, RAX, 8, true), want: `mov %rax,${R}` },
    // The operand size prefix is a legacy prefix and the extension is not, so
    // an extension written before it leaves the 0x66 to be read as the opcode.
    { name: `write a word of ${W} into the frame`, build: (e) => e.movMemRegSized(frame(8), register, 2), want: `mov ${W},0x8(%rsp)` },
    { name: `write a byte of ${B} into the frame`, build: (e) => e.movMemRegSized(frame(8), register, 1), want: `mov ${B},0x8(%rsp)` },
    { name: `write a full word of ${R} into the frame`, build: (e) => e.movMemRegSized(frame(8), register, 8), want: `mov ${R},0x8(%rsp)` },
  ];
}

/** The float encodings, whose prefixes name the precision being read. */
const FLOAT_CASES: readonly Case[] = [
  // `F3 0F 5A` widens a single and `F2 0F 5A` narrows a double, so the prefix
  // has to describe the value that is read rather than the one written.
  { name: "read a double at single precision", build: (e) => e.cvtFloatPrecision(XMM0, XMM0, false), want: "cvtsd2ss %xmm0,%xmm0" },
  { name: "read a single at double precision", build: (e) => e.cvtFloatPrecision(XMM0, XMM0, true), want: "cvtss2sd %xmm0,%xmm0" },
  { name: "read rax as a single into xmm8", build: (e) => e.cvtIntToFloat(XMM8, RAX, true), want: "cvtsi2ss %rax,%xmm8" },
  { name: "read xmm15 as a double into rax", build: (e) => e.cvtFloatToInt(RAX, XMM15, false, true), want: "cvttsd2si %xmm15,%rax" },
  // A register-to-register float move has the destination in the register field
  // and the source in the operand field, so the extension bits follow those.
  { name: "move xmm0 into xmm8", build: (e) => e.movsMove(XMM8, XMM0, false), want: "movsd %xmm0,%xmm8" },
  { name: "move xmm10 into xmm0", build: (e) => e.movsMove(XMM0, XMM10, true), want: "movss %xmm10,%xmm0" },
  { name: "move xmm15 into xmm0", build: (e) => e.movsMove(XMM0, XMM15, false), want: "movsd %xmm15,%xmm0" },
  { name: "move xmm0 into xmm15", build: (e) => e.movsMove(XMM15, XMM0, false), want: "movsd %xmm0,%xmm15" },
  { name: "add xmm0 into xmm8", build: (e) => e.sse("add", XMM8, XMM0, false), want: "addsd %xmm0,%xmm8" },
  { name: "multiply xmm0 into xmm15", build: (e) => e.sse("mul", XMM15, XMM0, false), want: "mulsd %xmm0,%xmm15" },
  { name: "compare xmm8 with xmm0", build: (e) => e.sseCompare(XMM8, XMM0, false, true), want: "ucomisd %xmm0,%xmm8" },
  { name: "turn the sign of xmm0 into xmm8", build: (e) => e.xorFloat(XMM8, XMM0), want: "xorpd %xmm0,%xmm8" },
  { name: "move rax into xmm8", build: (e) => e.movdXmm(XMM8, RAX), want: "movq %rax,%xmm8" },
  { name: "read a double out of the frame into xmm8", build: (e) => e.movsLoad(XMM8, frame(8), false), want: "movsd 0x8(%rsp),%xmm8" },
  { name: "write a single of xmm15 into the frame", build: (e) => e.movsStore(frame(8), XMM15, true), want: "movss %xmm15,0x8(%rsp)" },
  { name: "read a float literal into xmm10", build: (e) => e.movsLoadLabel(XMM10, "Lblaze", false), want: "movsd 0x0(%rip),%xmm10" },
  { name: "add a float literal into xmm15", build: (e) => e.sseMemLabel("add", XMM15, "Lblaze", false), want: "addsd 0x0(%rip),%xmm15" },
  { name: "take the address of a literal into r12", build: (e) => e.leaLabel(R12, "Lblaze"), want: "lea 0x0(%rip),%r12" },
  { name: "move xmm1 into xmm0", build: (e) => e.movsMove(XMM0, XMM1, false), want: "movsd %xmm1,%xmm0" },
];

/** The registers below eight must keep naming themselves. */
const LOW: readonly Case[] = [
  { name: "add one to rsp", build: (e) => e.aluImm("add", RSP, 1, true), want: "add $0x1,%rsp" },
  { name: "zero eax by exclusive or", build: (e) => e.movRegImm(RAX, 0n), want: "xor %eax,%eax" },
  { name: "move rcx into rbx", build: (e) => e.movRegReg(RBX, RCX), want: "mov %rcx,%rbx" },
  { name: "read rbp out of the frame", build: (e) => e.movRegMem(RBP, frame(8)), want: "mov 0x8(%rsp),%rbp" },
  { name: "write rdx into the frame", build: (e) => e.movMemReg(frame(8), RDX), want: "mov %rdx,0x8(%rsp)" },
  { name: "read a signed byte into rax", build: (e) => e.movRegMemSized(RAX, frame(8), 1, true), want: "movsbl 0x8(%rsp),%eax" },
  { name: "write a word of rsi into the frame", build: (e) => e.movMemRegSized(frame(8), RSI, 2), want: "mov %si,0x8(%rsp)" },
];

const CASES: readonly Case[] = [
  ...HIGH.flatMap((register) => wholeNumberCases(register)),
  ...FLOAT_CASES,
  ...LOW,
];

/**
 * Writes every case out as bytes, assembles them and reads back what each one
 * means. A case whose last instruction is not the one the compiler meant is an
 * encoding bug, whatever it happens to assemble to.
 */
async function meaningOf(cases: readonly Case[]): Promise<string[]> {
  let assembly = ".text\n.section .rodata\nLblaze: .quad 0\n.text\n";
  cases.forEach((entry, at) => {
    const encoder = new Encoder();
    entry.build(encoder);
    assembly += `.globl case_${at}\ncase_${at}:\n  .byte ${Array.from(encoder.finish()).join(",")}\n`;
  });
  const directory = await scratch("blaze-encoder-");
  const source = join(directory, "encodings.s");
  const object = join(directory, "encodings.o");
  await writeFile(source, assembly, "utf8");
  const assembled = run("as", ["--64", "-o", object, source], { timeoutMs: 60_000 });
  assert.equal(assembled.code, 0, `the assembler refused what the encoder wrote:\n${assembled.stderr}`);
  const listing = run("objdump", ["-d", "--no-show-raw-insn", object], { timeoutMs: 60_000 });

  const meaning = new Map<string, string[]>();
  let current = "";
  for (const line of listing.stdout.split("\n")) {
    const header = /^([0-9a-f]+) <(.+)>:$/.exec(line);
    if (header !== null) {
      current = header[2];
      meaning.set(current, []);
      continue;
    }
    if (current !== "" && /^\s+[0-9a-f]+:\s+\S/.test(line)) {
      meaning.get(current)?.push(line.trim().replace(/^[0-9a-f]+:\s*/, "").split("#")[0].trim());
    }
  }
  return cases.map((_entry, at) => {
    const lines = meaning.get(`case_${at}`) ?? [];
    // Every case is one instruction except the push and pop pair, whose
    // subject is the push.
    return (lines.length > 1 && lines.at(-1)?.startsWith("pop") === true ? lines[0] : lines.at(-1) ?? "")
      // A prefix that carries no bits is still a prefix, and the assembler
      // names it so a reader can see it was written on purpose.
      .replace(/\s+/g, " ")
      .replace(/^rex /, "")
      .trim();
  });
}

test("every encoding is the instruction the compiler meant", async () => {
  const read = await meaningOf(CASES);
  const wrong = CASES.flatMap((entry, at) =>
    read[at] === entry.want
      ? []
      : [`${entry.name}\n    want  ${entry.want}\n    got   ${read[at]}`],
  );
  assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
});

test("a register above seven is named by the extension bit of the field it is written in", () => {
  // The property behind the table above, checked directly so an encoding added
  // later that forgets the extension fails here rather than in a built program:
  // the low three bits of a modrm operand name one of eight registers, and the
  // extension prefix is the only thing that lifts the other eight out of reach.
  // Only the registers the three low bits cannot name: the eight below eight
  // are reached without any prefix at all, and asserting one of them would
  // be asserting that the encoder pads.
  for (const register of EXTENDED) {
    const encoder = new Encoder();
    encoder.aluImm("add", register, 1, true);
    const [extension] = Array.from(encoder.finish());
    assert.ok(extension !== undefined && extension >= 0x40 && extension <= 0x4f, `r${register} needs an extension prefix`);
    assert.equal(extension & 0b1, 1, `r${register} is written in the operand field, so the extension's B bit is what names it`);
  }

  // The same register written into the other field is named by the other bit.
  for (const register of EXTENDED) {
    const encoder = new Encoder();
    encoder.alu("add", register, RAX, true);
    const [extension] = Array.from(encoder.finish());
    assert.equal(extension !== undefined && extension & 0b100, 4, `r${register} is written in the register field here, so the extension's R bit is what names it`);
  }
});

