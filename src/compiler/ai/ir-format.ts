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

/** How a function is written in the IR: the header, then the body. */
export const IR_SYNTAX: readonly string[] = [
  "A function is a header and a body. Indent two spaces per level and write one",
  "declaration, one statement, one block head or one terminator per line. A block is",
  "entered by falling into it and left by the terminator on its last line.",
  "",
  "The header, written and read in this order:",
  "  function <name> as <symbol>(<name>: <type>, ...) -> <type>",
  "  requires \"<condition>\"     one per condition, or `requires none`",
  "  ensures \"<condition>\"      one per condition, or `ensures none`",
  "  allocates|prints|reads_argv yes|no",
  "  effects <name>, ...         or `effects none`",
  "  object <name> size <bytes> align <bytes>",
  "    field <name>: <type> at <offset>",
  "  call <callee>               one per function the body calls",
  "  param <slot>                one per parameter",
  "",
  "Every header line is read back out of the contract rather than out of the text, so",
  "a line that disagrees with the contract is an error that names itself.",
  "",
  "A slot says what a name holds and whether the body may change it:",
  "  value[<type>] <name> mutable|immutable",
  "  text <name> mutable|immutable",
  "  buffer <name> mutable|immutable element[<type>] <length>",
  "  object[<type>] <name> mutable|immutable",
  "",
  "A type is i32, i64, u32, u64, usize, f32, f64, bool, text, void, []T, [T; n], T*,",
  "or ref<Name> for an object of a named layout.",
  "",
  "A value is the operation, the type it has in brackets, and its operands. An",
  "operation made of other values is written in brackets around the whole of it, and a",
  "value that is a name and a type alone is written without them:",
  "  const[f64] 1.5             bool[bool] true            nothing[ref Node]",
  "  local[f64] sum             argv[usize]",
  "  [length[usize] local[[]f64] values]",
  "  [element[f64] local[[]f64] values local[f64] i]",
  "  [buffer[[i32; 4]] element[i32] 4 const[i32] 1 const[i32] 2]",
  "  [new_object[ref Node] Node left local[ref Node] n right nothing[ref Node]]",
  "  [load_field[ref<any>] local[ref<any>] node Node left]",
  "  [to_text local[f64] i]",
  '  [text "done: " [to_text local[f64] i]]',
  "  [add[f64] local[f64] sum const[f64] 1]   [min[f64] a b]   [max[f64] a b]",
  "  [sub[i32] a b]  [mul[f64] a b]  [div[f64] a b]  [mod[i32] a b]  [pow[f64] a b]",
  "  [shl[i64] a b]  [shr[i64] a b]  [and[i32] a b]  [or[i32] a b]  [xor[i32] a b]",
  "  [concat[text] a b]",
  "  [lt[bool] f64 a b]  [le[bool] f64 a b]  [gt[bool] f64 a b]  [ge[bool] f64 a b]",
  "  [eq[bool] f64 a b]  [ne[bool] f64 a b]",
  "  [logical_and[f64] a b]  [logical_or[f64] a b]  [coalesce[f64] a b]",
  "  [select[f64] a b c]  [unary neg[f64] a]  [unary not[bool] a]  [unary bitNot[i32] a]",
  "  [is_null[bool] a]  [is_not_null[bool] a]",
  "  [call[f64] dot [arg[[]f64] a arg[[]f64] b arg[f64] n] ownership=owned retain=no]",
  "",
  "A statement is one line, and the blocks it owns are written under it. `@n` at the",
  "end of a line is the line of the source it was written on:",
  "  let <slot> = <value>",
  "  set <name> <op> <value>                        op is =, +=, *=, -=, /= or %=",
  "  set_element <buffer> <index> <op> <value>",
  "  step <name> ++|-- pre|post",
  "  if <condition>",
  "  else",
  "  while <condition> header <id> exit <id>",
  "  do_while <condition> header <id> exit <id>",
  "  for <type> <variable> from <value> to <value> inclusive|exclusive up|down step <value|default> header <id> exit <id>",
  "  for_of <type> <element> of <name> index <name> length <value> header <id> exit <id>",
  "  print_text <value>",
  "  print_number <value>",
  "  print_newline",
  "  retain <value>",
  "  call <type> <callee> [arg[<type>] <value> ...] ownership=<none|borrowed|owned> retain=<yes|no>",
  "  raise <value>",
  "  store_field <value> <layout> <field> <value>",
  "",
  "A block head names the block and what it owns, and a block ends on one line of its",
  "own. A statement that is a block of its own is written as a block head, and a `return`",
  "with no value ends the function:",
  "  block b2: releases[t1]",
  "  return [local[f64] t1]",
  "  jump b3 [t1]",
  "",
  "A loop names the two blocks a `break` and a `continue` leave for: `exit` is where a",
  "break jumps to and `header` is where a continue jumps to, so a body that ends by",
  "falling out of itself jumps to the header it runs again from.",
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
