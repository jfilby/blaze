/**
 * The syntax of the semantic IR, for a candidate whose answer is the IR.
 *
 * A candidate that answers in the IR is read back by one parser, so it has to
 * be told what the text is. The form itself is the compiler's
 * (`semantics/ir-text.ts` is both ends of it), and what is stated here is the
 * form and none of any function in it: the compiler's own instance of the IR
 * for the function being written is the answer, and a prompt that carried it
 * would be carrying the answer with it.
 */

/**
 * Where in a function a line of the syntax is written, which is what tells the
 * parser what a line is expected to be. A form is a line, and a line is only a
 * program in the place it is written: `return` is the last line of a block and
 * a statement is not.
 */
export type IrFormKind = "type" | "value" | "statement" | "block" | "terminator";

/**
 * A line of the syntax, held apart from the prose around it so that a test can
 * hold every one of them to the parser that reads an answer back. The text of a
 * form is a line the compiler reads, written with the values a body is made of
 * and never with a placeholder: a form spelled `a` where the parser wants a
 * value teaches the one thing that gets an answer refused.
 */
export interface IrForm {
  /** The place a line of this kind is written. */
  readonly form: IrFormKind;
  /** The line, as the prompt shows it and the parser reads it. */
  readonly text: string;
}

/** How a function is written in the IR: the header, then the body. */
export const IR_SYNTAX: readonly (string | IrForm)[] = [
  "A function is a header and a body. Indent two spaces per level and write one",
  "declaration, one statement, one block head or one terminator per line. A block is",
  "entered by falling into it and left by the terminator on its last line.",
  "",
  "The header, written and read in this order:",
  "  function <name> as <symbol>(<name>: <type>, ...) -> <type>",
  "  requires \"<condition>\"     one per condition, or `requires none`",
  "  ensures \"<condition>\"      one per condition, or `ensures none`",
  "  allocates|prints|reads_argv yes|no",
  "  effects <name> ...           or `effects none`",
  "  object <name> size <bytes> align <bytes>",
  "    field <name>: <type> at <offset>",
  "  call <callee>               one per function the body calls",
  "  param <slot>                one per parameter",
  "",
  "Every header line is read back out of the contract rather than out of the text, so",
  "a line that disagrees with the contract is an error that names itself.",
  "",
  "A name is written bare: `sum` is a name and `\"sum\"` is a string. The text of a",
  "string is the only thing in the IR that is written in quotes.",
  "",
  "A slot says what a name holds and whether the body may change it, and a `let`",
  "writes one:",
  { form: "statement", text: "let value[f64] total immutable = const[f64] 0" },
  { form: "statement", text: "let text message mutable = [text \"done\"]" },
  { form: "statement", text: "let buffer values mutable element[f64] 4 = [buffer[[]f64] element[f64] 4 const[f64] 1 const[f64] 2 const[f64] 3 const[f64] 4]" },
  { form: "statement", text: "let object[ref<Object1>] node mutable = nothing[ref<Object1>]" },
  "",
  "A type is one of:",
  { form: "type", text: "f64" },
  { form: "type", text: "i64" },
  { form: "type", text: "usize" },
  { form: "type", text: "bool" },
  { form: "type", text: "text" },
  { form: "type", text: "void" },
  { form: "type", text: "[]f64" },
  { form: "type", text: "[f64; 4]" },
  { form: "type", text: "f64*" },
  { form: "type", text: "ref<any>" },
  { form: "type", text: "ref<Object1>" },
  "",
  "A value is the operation, the type it has in brackets, and its operands. An",
  "operation made of other values is written in brackets around the whole of it, and a",
  "value that is a type and a name is written without them. Every operand is a value of",
  "its own, so an operand is never a bare name:",
  { form: "value", text: "const[f64] 1.5" },
  { form: "value", text: "bool[bool] true" },
  { form: "value", text: "nothing[ref<Object1>]" },
  { form: "value", text: "local[f64] sum" },
  { form: "value", text: "argv[usize]" },
  { form: "value", text: "[length[usize] local[[]f64] values]" },
  { form: "value", text: "[element[f64] local[[]f64] values local[f64] i]" },
  { form: "value", text: "[buffer[[]f64] element[f64] 4 const[f64] 1 const[f64] 2 const[f64] 3 const[f64] 4]" },
  { form: "value", text: "[new_object[ref<Object1>] Object1 left local[ref<Object1>] node right nothing[ref<Object1>]]" },
  { form: "value", text: "[load_field[ref<any>] local[ref<Object1>] node Object1 left]" },
  { form: "value", text: "[to_text local[f64] i]" },
  { form: "value", text: "[text \"done: \" [to_text local[f64] i]]" },
  { form: "value", text: "[add[f64] local[f64] sum const[f64] 1]" },
  { form: "value", text: "[sub[i32] local[i32] i const[i32] 1]" },
  { form: "value", text: "[mul[f64] local[f64] x local[f64] y]" },
  { form: "value", text: "[div[f64] local[f64] x local[f64] y]" },
  { form: "value", text: "[mod[i32] local[i32] x local[i32] y]" },
  { form: "value", text: "[pow[f64] local[f64] x const[f64] 2.0]" },
  { form: "value", text: "[min[f64] local[f64] x local[f64] y]" },
  { form: "value", text: "[max[f64] local[f64] x local[f64] y]" },
  { form: "value", text: "[shl[i64] local[i64] bits local[i64] n]" },
  { form: "value", text: "[shr[i64] local[i64] bits local[i64] n]" },
  { form: "value", text: "[and[i32] local[i32] x local[i32] y]" },
  { form: "value", text: "[or[i32] local[i32] x local[i32] y]" },
  { form: "value", text: "[xor[i32] local[i32] x local[i32] y]" },
  { form: "value", text: "[concat[text] local[text] a local[text] b]" },
  { form: "value", text: "[lt[bool] f64 local[f64] x local[f64] y]" },
  { form: "value", text: "[le[bool] f64 local[f64] x local[f64] y]" },
  { form: "value", text: "[gt[bool] f64 local[f64] x local[f64] y]" },
  { form: "value", text: "[ge[bool] f64 local[f64] x local[f64] y]" },
  { form: "value", text: "[eq[bool] f64 local[f64] x local[f64] y]" },
  { form: "value", text: "[ne[bool] f64 local[f64] x local[f64] y]" },
  { form: "value", text: "[logical_and[bool] local[bool] a local[bool] b]" },
  { form: "value", text: "[logical_or[bool] local[bool] a local[bool] b]" },
  { form: "value", text: "[coalesce[ref<Object1>] local[ref<Object1>] node nothing[ref<Object1>]]" },
  { form: "value", text: "[select[f64] local[bool] c local[f64] x local[f64] y]" },
  { form: "value", text: "[unary neg[f64] local[f64] x]" },
  { form: "value", text: "[unary pos[f64] local[f64] x]" },
  { form: "value", text: "[unary not[bool] local[bool] c]" },
  { form: "value", text: "[unary bitNot[i32] local[i32] bits]" },
  { form: "value", text: "[is_null[bool] local[ref<Object1>] node]" },
  { form: "value", text: "[is_not_null[bool] local[ref<Object1>] node]" },
  { form: "value", text: "[call[f64] scale [arg[f64] local[f64] n] ownership=borrowed retain=no]" },
  "",
  "A statement is one line, and the blocks it owns are written under it. A line may",
  "end with `@n`, the line of the source the statement was written on, which only names",
  "it in a diagnostic and may be left out:",
  { form: "statement", text: "set total += const[f64] 1" },
  { form: "statement", text: "set_element values local[f64] i = const[f64] 1" },
  { form: "statement", text: "step i ++ post" },
  { form: "statement", text: "print_text [text \"done: \" [to_text local[f64] i]]" },
  { form: "statement", text: "print_number local[f64] x" },
  { form: "statement", text: "print_newline" },
  { form: "statement", text: "retain local[ref<Object1>] node" },
  { form: "statement", text: "call[f64] scale [arg[f64] local[f64] n] ownership=borrowed retain=no" },
  { form: "statement", text: "raise [text \"no\"]" },
  { form: "statement", text: "store_field local[ref<Object1>] node Object1 left local[ref<Object1>] child" },
  "The op of a `set` or a `set_element` is one of =, +=, *=, -=, /= or %=, and the op of",
  "a `step` is ++ or --, which the line says pre or post for.",
  "",
  "A statement that owns a block writes the block under it, and a `while`, a",
  "`do_while`, a `for` and a `for_of` name the two blocks a `break` and a `continue`",
  "leave for: `exit` is where a break jumps to and `header` is where a continue jumps",
  "to, so a body that ends by falling out of itself jumps to the header it runs again",
  "from:",
  { form: "statement", text: "if [lt[bool] f64 local[f64] x local[f64] lo] @2\n  block b1: releases[]\n  return local[f64] lo\nelse\n  block b2: releases[]\n  return local[f64] x" },
  { form: "statement", text: "while [lt[bool] f64 local[f64] x local[f64] lo] header b1 exit entry\n  block b2: releases[]\n  jump b1" },
  { form: "statement", text: "do_while [lt[bool] f64 local[f64] x local[f64] lo] header b1 exit entry\n  block b2: releases[]\n  jump b1" },
  { form: "statement", text: "for[f64] i from const[f64] 0 to const[f64] 2 exclusive up step default header b1 exit entry\n  block b2: releases[]\n  jump b1" },
  { form: "statement", text: "for_of[f64] e of values index i length [length[usize] local[[]f64] values] header b1 exit entry\n  block b2: releases[]\n  jump b1" },
  "",
  "A block head names the block and what it owns, and the block ends on a terminator",
  "of its own:",
  { form: "block", text: "block b2: releases[total]" },
  { form: "terminator", text: "return local[f64] total" },
  { form: "terminator", text: "return" },
  { form: "terminator", text: "jump b1" },
  { form: "terminator", text: "jump b1 [total]" },
  "",
  "A terminator is the last line of a block, written at the same indentation as the",
  "block head, and a `jump` names a block the text declares and a `return` with no",
  "value ends the function. Every block a body names is written down; a name no block",
  "carries is not one to jump to.",
];

/**
 * A whole function in that form, which is what an answer looks like. The build
 * holds this to the parser that reads an answer back, so the syntax above and
 * the text below cannot drift apart without a test failing.
 */
export const IR_EXAMPLE = `function clamp(x: f64, lo: f64, hi: f64) -> f64
  requires none
  ensures none
  allocates no
  prints yes
  reads_argv no
  effects io
  param value[f64] x mutable
  param value[f64] lo mutable
  param value[f64] hi mutable
  block entry: releases[]
    if [lt[bool] f64 local[f64] x local[f64] lo] @2
      block b1: releases[]
      return local[f64] lo
    let value[f64] t1 immutable = local[f64] hi @3
    if [gt[bool] f64 local[f64] x local[f64] t1] @4
      block b2: releases[]
      return local[f64] t1
    for[f64] i from const[f64] 0 to const[f64] 2 exclusive up step default header b3 exit entry @5
      block b4: releases[]
        print_number local[f64] x @6
      jump b3
  return local[f64] x
`;
