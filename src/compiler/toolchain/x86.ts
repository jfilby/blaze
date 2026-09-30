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
export const R10 = 10;
export const R11 = 11;
export const RBX = 3;
export const R12 = 12;
export const R13 = 13;
export const R14 = 14;
export const R15 = 15;

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
  | "ns"
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
  /**
   * Where the displacement field starts. It is written against the optimistic
   * layout and moved to where the field really is by the relaxation sweep, so
   * a widening jump before it carries it along.
   */
  offset: number;
  /** The symbol the address is of. */
  readonly symbol: string;
  readonly kind: "call" | "address";
}

interface Fixup {
  /** Where the jump is written, which is the byte its opcode is at. */
  readonly at: number;
  readonly label: string;
  /** The condition of a conditional jump, or null for an unconditional one. */
  readonly condition: Condition | null;
  /** Whether the displacement has been widened out of its short form. */
  wide: boolean;
}

/** A word the code is written with a placeholder for and given later. */
interface Patch {
  readonly at: number;
  readonly value: number;
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
  ns: 0x9,
  p: 0xa,
  np: 0xb,
};

/** The opcode extension of each operation when it writes a memory operand. */
const BINARY: Record<Binary, number> = { add: 0, or: 1, and: 4, sub: 5, xor: 6, cmp: 7 };

/** The opcode of each operation when it writes a register from an operand. */
const BINARY_TO_REGISTER: Record<Binary, number> = { add: 0x03, or: 0x0b, and: 0x23, sub: 0x2b, xor: 0x33, cmp: 0x3b };

/** The opcode of each operation when both of its operands are bytes. */
const BYTE_BINARY: Record<Binary, number> = { add: 0x00, or: 0x08, and: 0x20, sub: 0x28, xor: 0x30, cmp: 0x38 };

/** The opcode extension of each shift, which all three take the count in `cl`. */

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
  /** The words `patchWord` was given, applied once the layout has settled. */
  private readonly patches: Patch[] = [];
  private serial = 0;

  /** A label name no other label holds, built from the one a caller passed. */
  label(prefix: string): string {
    this.serial += 1;
    return `.L${prefix}${this.serial}`;
  }

  /**
   * The label of the jump the code ends with, or null when it ends with
   * anything else. `bind` reads it to take out a jump that lands where it
   * already is, which is the one jump no reader of the code expects to find.
   */
  private pendingJump: string | null = null;

  /** Binds a name to the place the code has reached. */
  bind(name: string): void {
    // A jump to the address this binds is a jump to the instruction after it:
    // it moves control to where control already is, so it is taken back out
    // rather than written. This is what ends every function whose last block
    // returns — the jump to the epilogue lands on the epilogue — and any arm
    // that leaves for a block bound straight after it.
    if (this.pendingJump === name) {
      this.pendingJump = null;
      this.fixups.pop();
      this.code.length -= 2;
    }
    this.labels.set(name, this.code.length);
  }

  /**
   * The jump the code ends with is one a block ended with rather than one this
   * lowering laid out to reach the next thing written. Its label is elsewhere
   * in the function, so taking it out would let the block fall out of the end
   * of itself into whatever happened to be written next.
   */
  sealJump(): void {
    this.pendingJump = null;
  }

  /**
   * The bytes, once every jump has been given the distance it names.
   *
   * A jump is written short — a one byte displacement — and widened here if
   * the label it names is further away than a signed byte reaches. Widening
   * makes the jump three bytes longer, which moves everything after it and so
   * can push a later jump out of range in turn, so the decision is made by
   * repeating the sweep until nothing more has to widen. That terminates
   * because a jump only ever widens once, and the code is far shorter than the
   * two gigabytes a four byte displacement reaches.
   *
   * The code is therefore not written where it was written. Everything that
   * names a place in it — a label, a patch, a relocation — is carried across
   * by the same map the sweep builds, which is why they are all recorded
   * against the optimistic layout and resolved here.
   */
  finish(): Uint8Array {
    for (const fixup of this.fixups) {
      if (!this.labels.has(fixup.label)) {
        throw new CompilerError({
          category: "AssemblyError",
          stage: "assemble",
          message: `the machine code jumps to ${fixup.label}, which is never bound`,
        });
      }
    }
    // Widening one jump moves everything after it, which can put a later jump
    // out of reach in turn, so the decision is repeated until a sweep changes
    // nothing. It ends because a jump only ever widens once.
    for (;;) {
      const shift = this.layout();
      let widened = false;
      for (const fixup of this.fixups) {
        if (fixup.wide) continue;
        const target = this.labels.get(fixup.label) as number;
        const distance = shift.at(target) - (shift.at(fixup.at) + 1);
        if (distance < -128 || distance > 127) {
          fixup.wide = true;
          widened = true;
        }
      }
      if (!widened) break;
    }
    const shift = this.layout();
    const code = new Uint8Array(shift.length);
    for (let at = 0; at < this.code.length; at += 1) code[shift.at(at)] = this.code[at];
    for (const fixup of this.fixups) {
      const at = shift.at(fixup.at);
      // The wide form of a conditional jump carries an extra opcode byte, so
      // its displacement field starts one byte later than a plain jump's.
      const field = fixup.wide ? at + (fixup.condition === null ? 0 : 1) : at;
      if (fixup.wide) {
        // The short opcode and its one byte field become the long opcode and
        // a four byte field, which is where the extra bytes came from.
        if (fixup.condition === null) code[at - 1] = 0xe9;
        else {
          code[at - 1] = 0x0f;
          code[at] = 0x80 + CONDITION[fixup.condition];
        }
      }
      // A displacement is measured from the end of the field it is written in.
      const distance = shift.at(this.labels.get(fixup.label) as number) - (field + (fixup.wide ? 4 : 1));
      for (let index = 0; index < (fixup.wide ? 4 : 1); index += 1) {
        code[field + index] = (distance >> (index * 8)) & 0xff;
      }
    }
    for (const patch of this.patches) {
      const at = shift.at(patch.at);
      for (let index = 0; index < 4; index += 1) code[at + index] = (patch.value >> (index * 8)) & 0xff;
    }
    for (const relocation of this.relocations) {
      relocation.offset = shift.at(relocation.offset);
    }
    return code;
  }


  /**
   * Where every byte of the optimistic code ends up once the jumps that have
   * widened have taken their extra bytes.
   *
   * A widened jump replaces its opcode and its one byte field with a longer
   * instruction, so every byte from the second field onwards moves by the
   * bytes that were added: three for a jump, four for a conditional one,
   * which is the extra opcode byte `0F` that comes with the four byte form.
   */
  private layout(): { at: (offset: number) => number; length: number } {
    const widened = this.fixups
      .filter((fixup) => fixup.wide)
      .map((fixup) => ({ at: fixup.at, extra: fixup.condition === null ? 3 : 4 }))
      .sort((a, b) => a.at - b.at);
    const extra = new Int32Array(this.code.length + 1);
    let running = 0;
    let next = 0;
    for (let at = 0; at <= this.code.length; at += 1) {
      while (next < widened.length && widened[next].at + 1 <= at) {
        running += widened[next].extra;
        next += 1;
      }
      extra[at] = running;
    }
    const length = this.code.length + widened.reduce((total, entry) => total + entry.extra, 0);
    return { at: (offset: number) => offset + extra[offset], length };
  }

  /* ---------------------------------------------------------------------- */
  /* Fields                                                                 */
  /* ---------------------------------------------------------------------- */

  private byte(value: number): void {
    // Anything written at all means the last instruction has ended, so a jump
    // is no longer the last thing in the code.
    this.pendingJump = null;
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
      // The scale is in the highest two bits, the index register in the three
      // below them and the base register in the lowest three. The index was
      // written into the base's field, which is invisible for every address
      // whose index is `rax` — the register number zero — and reads the other
      // way round for every one whose index is not.
      this.byte((scale << 6) | (((rm.index ?? 0) & 7) << 3) | (low & 7));
    }
    if (mod === 1) this.byte(rm.disp & 0xff);
    if (mod === 2) this.word(rm.disp);
  }

  /* ---------------------------------------------------------------------- */
  /* The frame                                                               */
  /* ---------------------------------------------------------------------- */

  push(register: number): void {
    // The opcode carries the low three bits of the register, so a register above
    // seven needs the extension prefix to say which one of those eight it is.
    this.rex(false, 0, { base: register, index: null });
    this.byte(0x50 + (register & 7));
  }

  pop(register: number): void {
    this.rex(false, 0, { base: register, index: null });
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
  /**
   * The end of a function, which leaves the frame and the caller as it was.
   *
   * `pinned` are the registers the prologue pushed, oldest first, which sit
   * below the frame pointer at one eight byte step each. They are read back
   * from there rather than popped: the prologue pushed them after the frame
   * pointer was taken, so a pop taken once the stack is back at the frame
   * pointer would read the frame pointer's own slot — the caller's return
   * address — and put that into the register.
   */
  epilogue(pinned: readonly number[] = []): void {
    for (let index = 0; index < pinned.length; index += 1) {
      this.movRegMem(pinned[index], frame(-8 * (index + 1)));
    }
    this.movRegReg(RSP, RBP);
    this.pop(RBP);
    this.ret();
  }

  /* ---------------------------------------------------------------------- */
  /* Moves                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * A value written down, as wide as the value is.
   *
   * Three forms answer it and the shortest one that holds the value is the one
   * written. A zero is an exclusive-or of a register with itself, which is two
   * bytes against the seven the immediate form spends, and every function that
   * zeroes a counter or a total writes one. A value that fits a 32 bit unsigned
   * register is the `B8` form, which is five bytes against the seven the
   * sign-extended immediate spends.
   */
  movRegImm(register: number, value: bigint): void {
    if (value === 0n) {
      this.alu("xor", register, register, false);
      return;
    }
    if (value >= 0n && value <= 0xffff_ffffn) {
      this.rex(false, 0, { base: null, index: null });
      this.byte(0xb8 + (register & 7));
      this.word(Number(value));
      return;
    }
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

  /**
   * The number a field left for later is given. It is held rather than written
   * straight in, because a widening jump earlier in the code moves the field
   * this one is in; the relaxation sweep carries it to where it ends up.
   */
  patchWord(at: number, value: number): void {
    this.patches.push({ at, value });
  }

  /**
   * A whole register moved into another: the first is where the value ends up
   * and the second is what it is copied from, which is the other way round from
   * what the two names say — the instruction's register field carries the
   * source and its base field carries the destination.
   */
  movRegReg(destination: number, source: number): void {
    // The two extension bits follow the two fields, and a register above seven
    // is only named by the bit beside its field: the register field is the
    // source, so the source is what the extension's R bit says, and the base
    // field is the destination, so the destination is what its B bit says.
    this.rex(true, source, { base: destination, index: null });
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

  /**
   * A jump written short: a one byte displacement, which is the form almost
   * every jump in a function takes. `finish` rewrites the ones that reach
   * further than a signed byte goes.
   */
  private displacement(label: string, condition: Condition | null): void {
    this.fixups.push({ at: this.code.length, label, condition, wide: false });
    this.byte(0);
  }

  jmp(label: string): void {
    this.byte(0xeb);
    this.displacement(label, null);
    this.pendingJump = label;
  }

  jcc(condition: Condition, label: string): void {
    this.byte(0x70 + CONDITION[condition]);
    this.displacement(label, condition);
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

  /**
   * A multiplication by a number written into the instruction, which is what a
   * literal the program multiplied by becomes. The form above needs the other
   * operand in a register, and a literal is not one.
   */
  imulImm(destination: number, value: number, wide = true): void {
    this.rex(wide, destination, { base: null, index: null });
    if (value >= -128 && value <= 127) {
      this.byte(0x6b);
      this.modrm(destination, destination);
      this.byte(value & 0xff);
      return;
    }
    this.byte(0x69);
    this.modrm(destination, destination);
    this.word(value);
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

  /**
   * A floating point operation whose other side is a literal in the
   * read-only data, which the instruction reaches without a register being
   * given up to hold it. A float the program added or multiplied by is the
   * same float at every use, so it is read once from the object and the
   * operation that consumes it is a single instruction.
   */
  sseMemLabel(operation: Float, destination: number, label: string, single: boolean): void {
    this.precision(single);
    this.byte(0x0f);
    this.byte(FLOAT[operation]);
    // `mod = 00, rm = 101` is the one address that is relative to the
    // instruction rather than to a register, which is how a literal in
    // another section is reached.
    this.byte(((destination & 7) << 3) | 5);
    this.relocations.push({ offset: this.code.length, symbol: label, kind: "address" });
    this.word(0);
  }

  /**
   * A float read out of the read-only data, at an address no object knows
   * until the linker places them together.
   *
   * A float the program wrote out is the same float every time it is written,
   * so it is laid down once beside the code and read from there, the way a
   * string is. Building one in a register costs two instructions and a
   * crossing from one register file to the other, and a function that writes
   * the same constant in a loop pays both on every turn.
   */
  movsLoadLabel(register: number, label: string, single: boolean): void {
    this.precision(single);
    this.byte(0x0f);
    this.byte(0x10);
    // `mod = 00, rm = 101` is the one address that is relative to the
    // instruction rather than to a register, which is what a literal in
    // another section is reached through.
    this.byte(((register & 7) << 3) | 5);
    this.relocations.push({ offset: this.code.length, symbol: label, kind: "address" });
    this.word(0);
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

  /**
   * A conditional move: the destination takes the value of the source when
   * the condition holds and keeps what it had when it does not. This is a
   * choice made without a branch, so nothing is guessed and nothing is paid
   * for guessing wrong.
   */
  cmov(condition: Condition, destination: number, source: number | Memory, wide = true): void {
    this.rex(wide, destination, source);
    this.byte(0x0f);
    this.byte(0x40 + CONDITION[condition]);
    this.modrm(source, destination);
  }

}
