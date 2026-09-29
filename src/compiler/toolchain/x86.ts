/**
 * An x86-64 instruction encoder.
 *
 * This is the layer under `ir-machine.ts`: it turns an instruction into the
 * bytes a processor reads, and it knows nothing about what an instruction
 * computes. Every encoding is written out rather than driven from a table of
 * every encoding the processor has, because the set a backend needs is small
 * and fixed, and a table that covered the rest would be a second document to
 * keep true.
 *
 * Two things are not bytes and are left to the object writer: a jump to a
 * label the code has not reached yet, and the displacement of an address no
 * object knows until the linker places it. The first is a fixup this file
 * settles in `finish`, the second is a relocation handed on.
 */

import { CompilerError } from "../core/errors.ts";

/* -------------------------------------------------------------------------- */
/* Registers                                                                    */
/* -------------------------------------------------------------------------- */

/** A general purpose register, numbered as the encoding numbers them. */
export const RAX = 0;
export const RCX = 1;
export const RDX = 2;
export const RSP = 4;
export const RBP = 5;
export const RSI = 6;
export const RDI = 7;
export const R8 = 8;
export const R9 = 9;

/** An SSE register, numbered as the encoding numbers them. */
export const XMM0 = 0;
export const XMM1 = 1;
export const XMM2 = 2;
export const XMM3 = 3;
export const XMM4 = 4;
export const XMM5 = 5;
export const XMM6 = 6;
export const XMM7 = 7;

/** The integer argument registers of the System V AMD64 convention, in order. */
export const INTEGER_ARGUMENTS: readonly number[] = [RDI, RSI, RDX, RCX, R8, R9];

/** The floating point argument registers of the convention, in order. */
export const SSE_ARGUMENTS: readonly number[] = [XMM0, XMM1, XMM2, XMM3, XMM4, XMM5, XMM6, XMM7];

/** The width an operand is read and written at. */
export type Width = 1 | 2 | 4 | 8;

/** The conditions a jump or a comparison may be written for. */
export type Condition =
  | "e"
  | "ne"
  | "l"
  | "le"
  | "g"
  | "ge"
  | "b"
  | "be"
  | "a"
  | "ae"
  | "s"
  | "p"
  | "np";

/** The arithmetic and logic the encoder writes, by the name the IR gives them. */
export type Binary = "add" | "sub" | "and" | "or" | "xor" | "cmp";

/** The shifts the encoder writes. */
export type Shift = "shl" | "shr" | "sar";

/** The floating point arithmetic the encoder writes, at either precision. */
export type Float = "add" | "sub" | "mul" | "div";

/* -------------------------------------------------------------------------- */
/* Memory                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * An address as the encoder writes one: a base register, an index scaled by a
 * power of two, and a displacement. A null register is the one that is not part
 * of the address, and a displacement of zero is left out wherever the encoding
 * allows it.
 */
export interface Memory {
  readonly base: number | null;
  readonly index: number | null;
  readonly scale: 1 | 2 | 4 | 8;
  readonly disp: number;
}

/** `[base + disp]`. */
export function mem(base: number, disp = 0): Memory {
  return { base, index: null, scale: 1, disp };
}

/** `[base + index * scale + disp]`. */
export function indexed(base: number, index: number, scale: 1 | 2 | 4 | 8, disp = 0): Memory {
  return { base, index, scale, disp };
}

/** What a slot in the frame is addressed as. */
export function frame(disp: number): Memory {
  return mem(RBP, disp);
}

/* -------------------------------------------------------------------------- */
/* Relocations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One address the linker has to fill in: a call reaches a symbol another object
 * defines, and a literal in the read-only data sits at an address no object
 * knows until they are placed together.
 */
export interface Relocation {
  /** Where the displacement field starts. */
  readonly offset: number;
  /** The symbol the address is of. */
  readonly symbol: string;
  readonly kind: "call" | "address";
}

interface Fixup {
  readonly at: number;
  readonly label: string;
}

/* -------------------------------------------------------------------------- */
/* Opcode tables                                                                */
/* -------------------------------------------------------------------------- */

const CONDITION: Record<Condition, number> = {
  e: 0x4,
  ne: 0x5,
  l: 0xc,
  le: 0xe,
  g: 0xf,
  ge: 0xd,
  b: 0x2,
  be: 0x6,
  a: 0x7,
  ae: 0x3,
  s: 0x8,
  p: 0xa,
  np: 0xb,
};

/** The opcode extension of each operation when it writes a memory operand. */
const BINARY: Record<Binary, number> = { add: 0, or: 1, and: 4, sub: 5, xor: 6, cmp: 7 };

/** The opcode of each operation when it writes a register from an operand. */
const BINARY_TO_REGISTER: Record<Binary, number> = { add: 0x03, or: 0x0b, and: 0x23, sub: 0x2b, xor: 0x33, cmp: 0x3b };

/** The opcode extension of each shift, which all three take the count in `cl`. */
/** The opcode of each operation when both of its operands are bytes. */
const BYTE_BINARY: Record<Binary, number> = { add: 0x00, or: 0x08, and: 0x20, sub: 0x28, xor: 0x30, cmp: 0x38 };

const SHIFT: Record<Shift, number> = { shl: 4, shr: 5, sar: 7 };

const FLOAT: Record<Float, number> = { add: 0x58, sub: 0x5c, mul: 0x59, div: 0x5e };

const DIVIDE: Record<"idiv" | "div", number> = { idiv: 7, div: 6 };

/* -------------------------------------------------------------------------- */
/* The encoder                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One function's instructions, as bytes.
 *
 * The state is the code written so far, the labels it binds and the jumps
 * waiting on one, and there is nothing else. A caller that wants its labels not
 * to collide with anything passes names the compiler generated, which is what
 * `ir-machine.ts` does.
 */
export class Encoder {
  /** The code written so far. */
  readonly code: number[] = [];
  /** Every address the object writer has to fill in. */
  readonly relocations: Relocation[] = [];

  private readonly labels = new Map<string, number>();
  private readonly fixups: Fixup[] = [];
  private serial = 0;

  /** A label name no other label holds, built from the one a caller passed. */
  label(prefix: string): string {
    this.serial += 1;
    return `.L${prefix}${this.serial}`;
  }

  /** Binds a name to the place the code has reached. */
  bind(name: string): void {
    this.labels.set(name, this.code.length);
  }

  /** The bytes, once every jump has been given the distance it names. */
  finish(): Uint8Array {
    for (const fixup of this.fixups) {
      const target = this.labels.get(fixup.label);
      if (target === undefined) {
        throw new CompilerError({
          category: "AssemblyError",
          stage: "assemble",
          message: `the machine code jumps to ${fixup.label}, which is never bound`,
        });
      }
      // A displacement is measured from the end of the field it is written in.
      const distance = target - (fixup.at + 4);
      this.code[fixup.at] = distance & 0xff;
      this.code[fixup.at + 1] = (distance >> 8) & 0xff;
      this.code[fixup.at + 2] = (distance >> 16) & 0xff;
      this.code[fixup.at + 3] = (distance >> 24) & 0xff;
    }
    return Uint8Array.from(this.code);
  }

  /* ---------------------------------------------------------------------- */
  /* Fields                                                                 */
  /* ---------------------------------------------------------------------- */

  private byte(value: number): void {
    this.code.push(value & 0xff);
  }

  private word(value: number): void {
    this.byte(value);
    this.byte(value >> 8);
    this.byte(value >> 16);
    this.byte(value >> 24);
  }

  private rex(w: boolean, reg: number, rm: number | { base: number | null; index: number | null }): void {
    const memory = typeof rm === "number" ? null : rm;
    const base = typeof rm === "number" ? rm : (rm.base ?? 0);
    const bits =
      (w ? 0b1000 : 0) |
      (reg >= 8 ? 0b100 : 0) |
      ((memory?.index ?? 0) >= 8 ? 0b10 : 0) |
      (base >= 8 ? 0b1 : 0);
    if (bits !== 0) this.byte(0x40 | bits);
  }

  /** The modrm byte, and the SIB byte an indexed address needs. */
  private modrm(rm: number | Memory, reg: number): void {
    if (typeof rm === "number") {
      this.byte(0xc0 | ((reg & 7) << 3) | (rm & 7));
      return;
    }
    const needsSib = rm.index !== null || (rm.base !== null && (rm.base & 7) === RSP);
    const low = rm.base ?? 0;
    let mod = 0;
    if (rm.disp !== 0 || (rm.base !== null && (rm.base & 7) === RBP)) {
      mod = rm.disp >= -128 && rm.disp <= 127 ? 1 : 2;
    }
    this.byte((mod << 6) | ((reg & 7) << 3) | (needsSib ? 4 : low & 7));
    if (needsSib) {
      const scale = rm.scale === 1 ? 0 : rm.scale === 2 ? 1 : rm.scale === 4 ? 2 : 3;
      this.byte((scale << 6) | ((rm.index ?? 0) & 7) | (low & 7));
    }
    if (mod === 1) this.byte(rm.disp & 0xff);
    if (mod === 2) this.word(rm.disp);
  }

  /* ---------------------------------------------------------------------- */
  /* The frame                                                               */
  /* ---------------------------------------------------------------------- */

  push(register: number): void {
    this.byte(0x50 + (register & 7));
  }

  pop(register: number): void {
    this.byte(0x58 + (register & 7));
  }

  /**
   * The start of a function: a frame pointer, so every slot in the frame is at
   * a fixed distance from a register that survives every call the body makes.
   */
  prologue(): void {
    this.push(RBP);
    this.movRegReg(RBP, RSP);
  }

  /** The end of a function, which leaves the frame and the caller as it was. */
  epilogue(): void {
    this.movRegReg(RSP, RBP);
    this.pop(RBP);
    this.ret();
  }

  /* ---------------------------------------------------------------------- */
  /* Moves                                                                   */
  /* ---------------------------------------------------------------------- */

  /** A value written down, as wide as the value is. */
  movRegImm(register: number, value: bigint): void {
    if (value >= -0x8000_0000n && value <= 0x7fff_ffffn) {
      this.rex(true, 0, { base: null, index: null });
      this.byte(0xc7);
      this.modrm(register, 0);
      this.word(Number(value));
      return;
    }
    this.rex(true, 0, { base: null, index: null });
    this.byte(0xb8 + (register & 7));
    for (let index = 0; index < 8; index += 1) this.byte(Number((value >> BigInt(index * 8)) & 0xffn));
  }

  /**
   * Room taken from the stack by a number that is not known when the
   * instruction is written: a frame is reserved before the body that fills it
   * has been read, so the field is left for `patchWord` to fill in.
   */
  subRegImmLater(register: number): number {
    this.rex(true, 0, { base: null, index: null });
    this.byte(0x81);
    this.modrm(register, BINARY.sub);
    const at = this.code.length;
    this.word(0);
    return at;
  }

  /** The number a field left for later is given. */
  patchWord(at: number, value: number): void {
    this.code[at] = value & 0xff;
    this.code[at + 1] = (value >> 8) & 0xff;
    this.code[at + 2] = (value >> 16) & 0xff;
    this.code[at + 3] = (value >> 24) & 0xff;
  }

  movRegReg(destination: number, source: number): void {
    this.rex(true, source, { base: null, index: null });
    this.byte(0x89);
    this.modrm(destination, source);
  }

  /** A move at half the width, which reads as clearing the whole register. */
  movRegReg32(destination: number, source: number): void {
    this.rex(false, source, { base: null, index: null });
    this.byte(0x89);
    this.modrm(destination, source);
  }

  movRegMem(register: number, address: Memory | number): void {
    this.rex(true, register, address);
    this.byte(0x8b);
    this.modrm(address, register);
  }

  movMemReg(address: Memory, register: number): void {
    this.rex(true, register, address);
    this.byte(0x89);
    this.modrm(address, register);
  }

  /**
   * A value read at its own width and widened to fill the register: a signed
   * one is sign extended and an unsigned one is zero extended, so a register
   * always holds the value its type names rather than the bits of something
   * wider.
   */
  movRegMemSized(register: number, address: Memory | number, width: Width, signed: boolean): void {
    this.rex(width === 8, register, address);
    if (width === 8) {
      this.byte(0x8b);
    } else if (width === 4) {
      // The wide form is the one that sign extends; the narrow one already
      // clears the upper half of the register.
      this.byte(signed ? 0x63 : 0x8b);
    } else {
      this.byte(0x0f);
      this.byte(signed ? (width === 1 ? 0xbe : 0xbf) : width === 1 ? 0xb6 : 0xb7);
    }
    this.modrm(address, register);
  }

  movMemRegSized(address: Memory, register: number, width: Width): void {
    this.rex(width === 8, register, address);
    if (width === 1) {
      this.byte(0x88);
      this.modrm(address, register);
      return;
    }
    if (width === 2) this.byte(0x66);
    this.byte(0x89);
    this.modrm(address, register);
  }

  /** The address itself, which is what a reference in the machine is. */
  lea(register: number, address: Memory): void {
    this.rex(true, register, address);
    this.byte(0x8d);
    this.modrm(address, register);
  }

  /** The address of a label in the read-only data, which the linker places. */
  leaLabel(register: number, label: string): void {
    this.relocations.push({ offset: this.code.length + 3, symbol: label, kind: "address" });
    this.rex(true, register, { base: null, index: null });
    this.byte(0x8d);
    // `mod = 00, rm = 101` is the one address that is relative to the
    // instruction rather than to a register.
    this.byte(((register & 7) << 3) | 5);
    this.word(0);
  }

  /* ---------------------------------------------------------------------- */
  /* Jumps and calls                                                         */
  /* ---------------------------------------------------------------------- */

  private displacement(label: string): void {
    this.fixups.push({ at: this.code.length, label });
    this.word(0);
  }

  jmp(label: string): void {
    this.byte(0xe9);
    this.displacement(label);
  }

  jcc(condition: Condition, label: string): void {
    this.byte(0x0f);
    this.byte(0x80 + CONDITION[condition]);
    this.displacement(label);
  }

  /** A call to a symbol, which is whatever object the linker puts it beside. */
  call(symbol: string): void {
    this.relocations.push({ offset: this.code.length + 1, symbol, kind: "call" });
    this.byte(0xe8);
    this.word(0);
  }

  ret(): void {
    this.byte(0xc3);
  }

  /* ---------------------------------------------------------------------- */
  /* Whole numbers                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * An operation of a register into a register. The opcode is the one that
   * writes the register, so the destination is the field the encoding calls the
   * register and the source the one it calls the operand.
   */
  alu(operation: Binary, destination: number, source: number, wide = true): void {
    this.rex(wide, destination, { base: null, index: null });
    this.byte(BINARY_TO_REGISTER[operation]);
    this.modrm(source, destination);
  }

  /** An operation of a byte register into a byte register. */
  alu8(operation: Binary, destination: number, source: number): void {
    this.byte(BYTE_BINARY[operation]);
    this.modrm(destination, source);
  }

  /**
   * A value read at a narrower width and widened to fill the register, which
   * is how a whole number comes back to the width its type names.
   */
  narrow(destination: number, source: number, width: Width, signed: boolean): void {
    this.rex(false, destination, source);
    if (width === 8) {
      this.byte(0x89);
    } else if (width === 4) {
      this.byte(signed ? 0x63 : 0x8b);
    } else {
      this.byte(0x0f);
      this.byte(signed ? (width === 1 ? 0xbe : 0xbf) : width === 1 ? 0xb6 : 0xb7);
    }
    this.modrm(source, destination);
  }

  /** An operation of memory into a register. */
  aluRegMem(operation: Binary, register: number, address: Memory, wide = true): void {
    this.rex(wide, register, address);
    this.byte(BINARY_TO_REGISTER[operation]);
    this.modrm(address, register);
  }

  /** An operation against a number written into the instruction. */
  aluImm(operation: Binary, register: number, value: number, wide = true): void {
    this.rex(wide, 0, { base: null, index: null });
    if (value >= -128 && value <= 127) {
      this.byte(0x83);
      this.modrm(register, BINARY[operation]);
      this.byte(value & 0xff);
      return;
    }
    this.byte(0x81);
    this.modrm(register, BINARY[operation]);
    this.word(value);
  }

  imul(destination: number, source: number, wide = true): void {
    this.rex(wide, destination, { base: null, index: null });
    this.byte(0x0f);
    this.byte(0xaf);
    this.modrm(source, destination);
  }

  /** A division of the accumulator by a register, signed or not. */
  divide(kind: "idiv" | "div", source: number, wide = true): void {
    this.rex(wide, 0, { base: null, index: null });
    this.byte(0xf7);
    this.modrm(source, DIVIDE[kind]);
  }

  /** The high half of the dividend, from the sign of the low one. */
  signExtend(wide: boolean): void {
    if (wide) this.byte(0x48);
    this.byte(0x99);
  }

  shift(operation: Shift, register: number, wide = true): void {
    this.rex(wide, 0, { base: null, index: null });
    this.byte(0xd3);
    this.modrm(register, SHIFT[operation]);
  }

  /** A shift by a number written into the instruction. */
  shiftImm(operation: Shift, register: number, amount: number, wide = true): void {
    this.rex(wide, 0, { base: null, index: null });
    this.byte(0xc1);
    this.modrm(register, SHIFT[operation]);
    this.byte(amount & 0xff);
  }

  neg(register: number, wide = true): void {
    this.rex(wide, 0, { base: null, index: null });
    this.byte(0xf7);
    this.modrm(register, 3);
  }

  not(register: number, wide = true): void {
    this.rex(wide, 0, { base: null, index: null });
    this.byte(0xf7);
    this.modrm(register, 2);
  }

  test(register: number, wide = true): void {
    this.rex(wide, register, { base: null, index: null });
    this.byte(0x85);
    this.modrm(register, register);
  }

  testImm(register: number, value: number, wide = true): void {
    this.rex(wide, 0, { base: null, index: null });
    if (value >= -128 && value <= 127) {
      this.byte(0xf6);
      this.modrm(register, 0);
      this.byte(value & 0xff);
      return;
    }
    this.byte(0xf7);
    this.modrm(register, 0);
    this.word(value);
  }

  /* ---------------------------------------------------------------------- */
  /* Floating point                                                          */
  /* ---------------------------------------------------------------------- */

  private precision(single: boolean): void {
    this.byte(single ? 0xf3 : 0xf2);
  }

  /** A floating point operation of two registers, at one precision. */
  sse(operation: Float, destination: number, source: number, single: boolean): void {
    this.precision(single);
    this.byte(0x0f);
    this.byte(FLOAT[operation]);
    this.modrm(source, destination);
  }

  /**
   * A comparison that leaves the condition codes the way `cmp` leaves them. An
   * ordered one raises the parity bit on operands that are not numbers, which
   * is what keeps every comparison of a NaN false.
   */
  sseCompare(destination: number, source: number, single: boolean, ordered: boolean): void {
    // The comparison of two doubles is the one that takes the operand size
    // prefix; the comparison of two single precision values is the one that
    // does not.
    if (!single) this.byte(0x66);
    this.byte(0x0f);
    this.byte(ordered ? 0x2e : 0x2f);
    this.modrm(source, destination);
  }

  /** A whole number read as a float, which is a signed conversion. */
  cvtIntToFloat(destination: number, source: number, single: boolean): void {
    this.precision(single);
    this.rex(true, destination, { base: null, index: null });
    this.byte(0x0f);
    this.byte(0x2a);
    this.modrm(source, destination);
  }

  /** A float read as a whole number, at the width it is read at. */
  cvtFloatToInt(destination: number, source: number, single: boolean, wide: boolean): void {
    this.precision(single);
    this.rex(wide, destination, { base: null, index: null });
    this.byte(0x0f);
    this.byte(0x2c);
    this.modrm(source, destination);
  }

  /** A float read at the other precision. */
  cvtFloatPrecision(destination: number, source: number, single: boolean): void {
    this.precision(single);
    this.byte(0x0f);
    this.byte(0x5a);
    this.modrm(source, destination);
  }

  /** A float read out of memory into a register. */
  movsLoad(register: number, address: Memory | number, single: boolean): void {
    this.precision(single);
    this.rex(false, register, address);
    this.byte(0x0f);
    this.byte(0x10);
    this.modrm(address, register);
  }

  /** A float written from a register into memory. */
  movsStore(address: Memory, register: number, single: boolean): void {
    this.precision(single);
    this.rex(false, register, address);
    this.byte(0x0f);
    this.byte(0x11);
    this.modrm(address, register);
  }

  /** A float kept in a register, which is a move of the whole register. */
  movsMove(destination: number, source: number, single: boolean): void {
    this.precision(single);
    this.rex(false, source, { base: null, index: null });
    this.byte(0x0f);
    this.byte(0x10);
    this.modrm(source, destination);
  }

  /** A whole number moved into a float register, which is how a bit is turned. */
  movdXmm(destination: number, source: number): void {
    this.byte(0x66);
    this.rex(true, destination, { base: null, index: null });
    this.byte(0x0f);
    this.byte(0x6e);
    this.modrm(source, destination);
  }

  /** A sign bit turned over, which is a negation of a float. */
  xorFloat(destination: number, source: number): void {
    this.byte(0x66);
    this.byte(0x0f);
    this.byte(0x57);
    this.modrm(source, destination);
  }

  /* ---------------------------------------------------------------------- */
  /* Conditions                                                              */
  /* ---------------------------------------------------------------------- */

  /** A condition written into one of the low byte registers. */
  setcc(condition: Condition, register: number): void {
    this.byte(0x0f);
    this.byte(0x90 + CONDITION[condition]);
    this.modrm(register, 0);
  }

  /** A byte register widened into a whole one, so a condition is a number. */
  movzxReg8(destination: number, source: number): void {
    this.rex(false, destination, { base: null, index: null });
    this.byte(0x0f);
    this.byte(0xb6);
    this.modrm(source, destination);
  }
}
