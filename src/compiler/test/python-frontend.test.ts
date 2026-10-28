/**
 * The Python frontend: what it reads, what it refuses, and what it contracts.
 *
 * A frontend is a parser and an analysis, so what is tested here is what a
 * Python file is read as: the functions it declares, the types it gives them,
 * the contract each function carries, and the constructs that are outside the
 * subset and are refused with the line they were written on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnostic, phaseOf } from "./phase.ts";
import { pythonFrontend } from "../semantics/python.ts";
import { parsePython, Diagnostics, mapPythonType, type PyFunction } from "../semantics/python.ts";
import { generateHarness } from "../toolchain/linker.ts";

/** The contract of a one file Python module. */
function contractOf(source: string, name = "f"): {
  ensures: string[];
  requires: string[];
  params: { name: string; type: string }[];
  returns: string;
} {
  const phase = phaseOf("python", { "main.py": source }, "main.py");
  const contract = phase.program.files[0].functions[name];
  assert.ok(contract !== undefined, `the module declares ${name}`);
  return {
    ensures: contract.ensures,
    requires: contract.requires,
    params: contract.function.params,
    returns: contract.function.returns,
  };
}

test("a function of a Python module is contracted with the reduction its loop states", () => {
  const source = [
    "def dot(a: list[float], b: list[float], n: int) -> float:",
    "    total: float = 0.0",
    "    for i in range(n):",
    "        total += a[i] * b[i]",
    "    return total",
    "",
  ].join("\n");
  const contract = contractOf(source, "dot");
  assert.deepEqual(contract.ensures, ["result == sum(i = 0..<n, (a[i] * b[i]))"]);
  assert.deepEqual(contract.params, [
    { name: "a", type: "slice<f64>" },
    { name: "b", type: "slice<f64>" },
    { name: "n", type: "i64" },
  ]);
  assert.equal(contract.returns, "f64");
});

test("the length of a list a function was given is carried with it", () => {
  // A list now carries its length beside it, so a function may read it
  // directly instead of taking the length as a parameter of its own.
  const phase = phaseOf(
    "python",
    { "main.py": "def dot(a: list[float], b: list[float]) -> float:\n    total: float = 0.0\n    for i in range(len(a)):\n        total += a[i] * b[i]\n    return total\n" },
    "main.py",
  );
  assert.ok(phase.program.files[0].functions["dot"] !== undefined);
});

test("the types of Python are the types of the contract", () => {
  assert.deepEqual(mapPythonType("int", "here"), { kind: "primitive", name: "i64" });
  assert.deepEqual(mapPythonType("float", "here"), { kind: "primitive", name: "f64" });
  assert.deepEqual(mapPythonType("bool", "here"), { kind: "primitive", name: "bool" });
  assert.deepEqual(mapPythonType("str", "here"), { kind: "text" });
  assert.deepEqual(mapPythonType("list[float]", "here"), { kind: "slice", of: { kind: "primitive", name: "f64" } });
  assert.deepEqual(mapPythonType("list[int]", "here"), { kind: "slice", of: { kind: "primitive", name: "i64" } });
  assert.deepEqual(mapPythonType("None", "here"), { kind: "void" });
});

test("a type the subset does not have is refused with the types it has", () => {
  const refused = diagnostic(() => mapPythonType("complex", "line 3 of main.py"));
  assert.match(refused, /unsupported Python type "complex"/);
  assert.match(refused, /int, float, bool, str/);
});

test("an annotation is required on every parameter and on the result", () => {
  const noParameter = diagnostic(() =>
    phaseOf("python", { "main.py": "def f(a) -> int:\n    return a\n" }, "main.py"),
  );
  assert.match(noParameter, /every parameter declares its type/);
  const noResult = diagnostic(() =>
    phaseOf("python", { "main.py": "def f(a: int):\n    return a\n" }, "main.py"),
  );
  assert.match(noResult, /every function declares what it returns/);
});

test("a file with a statement of its own is a program, and a file without is a library", () => {
  const program = phaseOf("python", { "main.py": "x = 1\n" }, "main.py");
  assert.equal(program.body?.statements.length, 1);
  const library = phaseOf("python", { "main.py": "def f(a: int) -> int:\n    return a\n" }, "main.py");
  assert.equal(library.body, undefined);
});

test("the guard that names the entry module runs nowhere else", () => {
  const source = ['if __name__ == "__main__":', "    f()", ""].join("\n");
  const analysis = pythonFrontend.analyze(source, "helpers.py");
  assert.equal(analysis.entryGuard, true);
  // A module the program merely imports runs nothing: the guard names the
  // entry module, and a file that holds nothing else is a library of
  // functions.
  const phase = phaseOf(
    "python",
    {
      "main.py": "from helpers import f\n\ndef g(a: int) -> int:\n    return a\n",
      "helpers.py": "def f(a: int) -> int:\n    return a\n\n" + source,
    },
    "main.py",
  );
  assert.equal(phase.body, undefined);
  // The entry module itself runs its statements, the guard among them.
  const entry = phaseOf("python", { "main.py": source }, "main.py");
  assert.equal(entry.body?.statements.length, 1);
});

test("a module imports the functions of another file of the project", () => {
  const phase = phaseOf(
    "python",
    {
      "main.py": "from helpers import dot\n\ndef f(a: int) -> int:\n    return a\n",
      "helpers.py": "def dot(a: int) -> int:\n    return a\n",
    },
    "main.py",
  );
  assert.deepEqual(phase.program.edges, [
    { from: "main.py", to: "helpers.py", symbols: ["dot"] },
  ]);
});

test("an import of a module that is not a file of the project is refused", () => {
  const dotted = diagnostic(() => pythonFrontend.resolveImport("os.path"));
  assert.match(dotted, /a module of the project is a file beside the entry file/);
  const relative = diagnostic(() => pythonFrontend.resolveImport("./helpers"));
  assert.match(relative, /a module of the project is a file beside the entry file/);
  assert.deepEqual(pythonFrontend.resolveImport("helpers"), ["helpers.py"]);
});

test("the modules of the standard library the compiler knows are read", () => {
  // `math` is where the roundings and the root the compiler has are written,
  // `sys` is where the command line is, and `triton` with `triton.language`
  // are the modules a kernel is written with: the ones a Python file may
  // import.
  const phase = phaseOf(
    "python",
    { "main.py": "import math\nimport sys\n\ndef f(a: int) -> int:\n    return a\n" },
    "main.py",
  );
  assert.equal(phase.body, undefined);
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "import os\nprint(1)\n" }, "main.py"),
  );
  assert.match(refused, /"os" is not a module the compiler knows/);
  assert.match(refused, /math, sys, triton, triton\.language/);
});

test("a call of a name the compiler does not know is refused", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "print(missing(1))\n" }, "main.py"),
  );
  assert.match(refused, /"missing" is not a function this file may call/);
  // The name is looked for in every statement of a body, and not only in the
  // first one.
  const later = diagnostic(() =>
    phaseOf("python", { "main.py": "x = 1\nfor i in range(3):\n    print(missing(i))\n" }, "main.py"),
  );
  assert.match(later, /"missing" is not a function this file may call/);
  // A name the file declares is a name it may call.
  const declared = phaseOf(
    "python",
    { "main.py": "def f(a: int) -> int:\n    return a\n\nprint(f(1))\n" },
    "main.py",
  );
  assert.equal(declared.body?.statements.length, 1);
});

test("a conversion is not part of a module, and a module says so", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "def f(a: float) -> int:\n    return int(a)\n" }, "main.py"),
  );
  assert.match(refused, /"int" is not part of a module/);
});

test("a power is read as a power, and a power is right-associative", () => {
  const phase = phaseOf("python", { "main.py": "print(2 ** 3)\n" }, "main.py");
  const statement = phase.body?.statements[0];
  assert.ok(statement !== undefined && statement.kind === "print");
  const power = statement.values[0];
  assert.equal(power.k, "binary");
  assert.equal(power.op, "**");
  assert.deepEqual(power.left, { k: "whole", text: "2" });
  assert.deepEqual(power.right, { k: "whole", text: "3" });

  // `a ** b ** c` is `a ** (b ** c)`: the exponent is itself a power.
  const nested = phaseOf("python", { "main.py": "print(2 ** 3 ** 2)\n" }, "main.py");
  const nestedStatement = nested.body?.statements[0];
  assert.ok(nestedStatement !== undefined && nestedStatement.kind === "print");
  const nestedPower = nestedStatement.values[0];
  assert.equal(nestedPower.k, "binary");
  assert.equal(nestedPower.op, "**");
  assert.deepEqual(nestedPower.left, { k: "whole", text: "2" });
  const exponent = nestedPower.right;
  assert.equal(exponent.k, "binary");
  assert.equal(exponent.op, "**");
  assert.deepEqual(exponent.left, { k: "whole", text: "3" });
  assert.deepEqual(exponent.right, { k: "whole", text: "2" });
});

test("a decorator is read above a function and carried on it", () => {
  const diagnostics = new Diagnostics();
  const parsed = parsePython(
    "@triton.jit\ndef add_kernel(x_ptr: int, y_ptr: int, output_ptr: int, n_elements: int, BLOCK_SIZE: int) -> None:\n    pass\n",
    "main.py",
    diagnostics,
  );
  const kernel = parsed.functions.find((f) => f.name === "add_kernel");
  assert.ok(kernel !== undefined, "the function is declared");
  assert.deepEqual(kernel.decorators, ["triton.jit"]);
});

test("several decorators are read above a function", () => {
  const diagnostics = new Diagnostics();
  const parsed = parsePython(
    "@a.b\n@c\ndef f(a: int) -> int:\n    return a\n",
    "main.py",
    diagnostics,
  );
  const f = parsed.functions.find((fn) => fn.name === "f");
  assert.ok(f !== undefined, "the function is declared");
  assert.deepEqual(f.decorators, ["a.b", "c"]);
});

test("the modules a kernel is written with are the ones the compiler knows", () => {
  const analysis = pythonFrontend.analyze(
    "import triton\nimport triton.language as tl\n",
    "kernel.py",
  );
  assert.equal(analysis.functions.length, 0);
  // A rename the kernel is not written with is refused, as every other one is.
  const refused = diagnostic(() =>
    pythonFrontend.analyze("import triton.language as language\n", "kernel.py"),
  );
  assert.match(refused, /renaming an import is not supported/);
});

test("renaming an imported function is refused where it is written", () => {
  // A name imported under another name binds a name the compiler does not
  // read, and it is refused as the rename it is. The alias used to be left
  // where it was written, so the refusal was a statement diagnostic about
  // "as" instead of the rename the source wrote.
  const refused = diagnostic(() => pythonFrontend.analyze("from helpers import dot as cross\n", "kernel.py"));
  assert.match(refused, /renaming an import is not supported/);
});

test("a kernel the subset carries is read with its decorator, its constant and its calls", () => {
  const source = [
    "import triton",
    "import triton.language as tl",
    "",
    "@triton.jit",
    "def select_kernel(x: float, y: float, flag: bool, BLOCK: tl.constexpr) -> float:",
    "    chosen = tl.where(flag, x, y)",
    "    signed = tl.abs(chosen)",
    "    return tl.sqrt(signed + BLOCK)",
    "",
  ].join("\n");
  const analysis = pythonFrontend.analyze(source, "kernel.py");
  assert.equal(analysis.functions.length, 1);
  const kernel = analysis.functions[0].handle as PyFunction;
  assert.ok(kernel !== undefined);
  assert.deepEqual(kernel.decorators, ["triton.jit"]);
  assert.deepEqual(kernel.params.map((param) => param.type), [
    { kind: "primitive", name: "f64" },
    { kind: "primitive", name: "f64" },
    { kind: "primitive", name: "bool" },
    { kind: "primitive", name: "i64" },
  ]);
});

test("a tl.where is the choice the compiler writes", () => {
  const phase = phaseOf("python", { "main.py": "print(tl.where(1 > 0, 2.0, 3.0))\n" }, "main.py");
  const statement = phase.body?.statements[0];
  assert.ok(statement !== undefined && statement.kind === "print");
  const where = statement.values[0];
  assert.equal(where.k, "conditional");
  assert.equal(where.then.k, "number");
  assert.equal(where.otherwise.k, "number");
  assert.equal(where.condition.k, "binary");
  assert.equal(where.condition.op, ">");
});

test("the tl.* calls a real kernel uses are accepted by the frontend", () => {
  const source = [
    "import triton.language as tl",
    "",
    "@triton.jit",
    "def add_kernel(x_ptr: int, y_ptr: int, out_ptr: int, n: int, BLOCK: tl.constexpr) -> None:",
    "    pid = tl.program_id(axis=0)",
    "    offsets = pid * BLOCK + tl.arange(0, BLOCK)",
    "    mask = offsets < n",
    "    x = tl.load(x_ptr + offsets, mask=mask)",
    "    tl.store(out_ptr + offsets, x, mask=mask)",
    "",
  ].join("\n");
  const analysis = pythonFrontend.analyze(source, "kernel.py");
  assert.equal(analysis.functions.length, 1);
});

test("a named argument names the call it was written on", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": 'print(1, sep=", ")\n' }, "main.py"),
  );
  assert.match(refused, /a named argument is not part of the subset/);
  assert.match(refused, /print is called with its arguments in order/);
});

test("a function of a module reads no command line", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "def f() -> int:\n    x = 1\n    return len(sys.argv) + x\n" }, "main.py"),
  );
  assert.match(refused, /reads the command line, which a module may not/);
});

test("a docstring says nothing, and a string of three quotes is read", () => {
  const source = ["'''one", "two'''", "def f(a: int) -> int:", '    """the doc"""', "    return a", ""].join("\n");
  const phase = phaseOf("python", { "main.py": source }, "main.py");
  // The docstring is a statement of nothing: the function it documents is the
  // one the module declares.
  assert.equal(phase.program.files[0].functions["f"] !== undefined, true);
});

test("the constructs outside the subset are refused with what to write instead", () => {
  const cases: [string, RegExp][] = [

    ["def f() -> int:\n    yield 1\n", /a value the function hands back with return/],
    ["def f(x: float) -> float:\n    return round(x)\n", /it rounds half to even/],
  ];
  for (const [source, expected] of cases) {
    const refused = diagnostic(() => phaseOf("python", { "main.py": source }, "main.py"));
    assert.match(refused, expected, `the refusal of ${JSON.stringify(source)}`);
  }
});

test("every construct outside the subset of one file is reported at once", () => {
  const source = ["yield 1", "", "def f() -> int:", "    yield 1", ""].join("\n");
  const refused = diagnostic(() => phaseOf("python", { "main.py": source }, "main.py"));
  assert.match(refused, /constructs of main\.py are outside the subset/);
  assert.match(refused, /line 1:/);
  assert.match(refused, /line 4:/);
});

test("a loop walks a range, and a list is walked by its own index", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "def f(a: list[int]) -> int:\n    for x in a:\n        pass\n    return 0\n" }, "main.py"),
  );
  assert.match(refused, /a loop walks a range/);
});

test("a slice used internally keeps a function contractable", () => {
  const phase = phaseOf("python", { "main.py": "def f(a: list[int]) -> int:\n    b = a[0:2]\n    return b[0] + b[1]\n" }, "main.py");
  const contract = phase.program.files[0].functions["f"];
  assert.deepEqual(contract.ensures, ["result == (a[0:2][0] + a[0:2][1])"]);
});

test("a function returning a slice is uncontractable", () => {
  const slice = diagnostic(() =>
    phaseOf("python", { "main.py": "def f(a: list[int]) -> list[int]:\n    return a[1:3]\n" }, "main.py"),
  );
  assert.match(slice, /contract states no postcondition/);
});

test("a slice in a program body reads the elements of a list", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3, 4, 5]\nb = a[1:3]\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "buffer");
  assert.equal(declaration.value.element, "i64");
  assert.equal(declaration.value.values.length, 2);
  assert.equal(declaration.value.values[0].k, "whole");
  assert.equal(declaration.value.values[0].text, "2");
  assert.equal(declaration.value.values[1].k, "whole");
  assert.equal(declaration.value.values[1].text, "3");
});

test("a slice with a negative bound in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3, 4, 5]\nb = a[-2:]\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "buffer");
  assert.equal(declaration.value.values.length, 2);
  assert.equal(declaration.value.values[0].text, "4");
  assert.equal(declaration.value.values[1].text, "5");
});

test("a slice with a step in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3, 4, 5]\nb = a[::2]\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "buffer");
  assert.equal(declaration.value.values.length, 3);
  assert.equal(declaration.value.values[0].text, "1");
  assert.equal(declaration.value.values[1].text, "3");
  assert.equal(declaration.value.values[2].text, "5");
});

test("a slice with a negative step in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3, 4, 5]\nb = a[::-1]\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "buffer");
  assert.equal(declaration.value.values.length, 5);
  assert.equal(declaration.value.values[0].text, "5");
  assert.equal(declaration.value.values[4].text, "1");
});

test("a string slice in a program body", () => {
  const phase = phaseOf("python", { "main.py": 's = "hello"\na = s[1:3]\n' }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "text");
  assert.equal(declaration.value.parts[0].value, "el");
});

test("a string slice with a negative bound in a program body", () => {
  const phase = phaseOf("python", { "main.py": 's = "hello"\na = s[-2:]\n' }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "text");
  assert.equal(declaration.value.parts[0].value, "lo");
});

test("a string slice with a step in a program body", () => {
  const phase = phaseOf("python", { "main.py": 's = "hello"\na = s[::2]\n' }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "text");
  assert.equal(declaration.value.parts[0].value, "hlo");
});

test("a string slice with a negative step in a program body", () => {
  const phase = phaseOf("python", { "main.py": 's = "hello"\na = s[::-1]\n' }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "text");
  assert.equal(declaration.value.parts[0].value, "olleh");
});

test("an element assignment in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3]\na[1] = 10\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  assert.equal(statements[1].kind, "elementAssign");
  assert.equal((statements[1] as any).buffer, "a");
  assert.equal((statements[1] as any).index.k, "whole");
  assert.equal((statements[1] as any).index.text, "1");
});

test("a slice assignment in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3, 4, 5]\na[1:3] = [10, 20]\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  assert.equal(statements[1].kind, "block");
  assert.equal((statements[1] as any).body.length, 2);
  assert.equal((statements[1] as any).body[0].kind, "elementAssign");
  assert.equal((statements[1] as any).body[0].index.text, "1");
  assert.equal((statements[1] as any).body[1].index.text, "2");
});

test("a slice assignment with a variable RHS in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3, 4, 5]\nb = [10, 20]\na[1:3] = b\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  assert.equal(statements[2].kind, "for");
  assert.equal((statements[2] as any).variable, "_i");
});

test("a chained slice in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3, 4, 5]\nb = a[1:4][1]\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "whole");
  assert.equal(declaration.value.text, "3");
});

test("a chained slice with a negative index in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3, 4, 5]\nb = a[1:4][-1]\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[1] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "whole");
  assert.equal(declaration.value.text, "4");
});

test("an f-string slice in a program body", () => {
  const phase = phaseOf("python", { "main.py": 'x = 42\ns = f"hello {x}"\na = s[0:5]\n' }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[2] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "text");
  assert.equal(declaration.value.parts[0].value, "hello");
});

test("an f-string slice with a step in a program body", () => {
  const phase = phaseOf("python", { "main.py": 'x = 42\ns = f"hello {x}"\na = s[::2]\n' }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[2] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "text");
  assert.equal(declaration.value.parts[0].value, "hlo4");
});

test("an f-string slice with a negative step in a program body", () => {
  const phase = phaseOf("python", { "main.py": 'x = 42\ns = f"hello {x}"\na = s[::-1]\n' }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[2] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "text");
  assert.equal(declaration.value.parts[0].value, "24 olleh");
});

test("list concatenation in a program body", () => {
  const phase = phaseOf("python", { "main.py": "a = [1, 2, 3]\nb = [4, 5, 6]\nc = a + b\n" }, "main.py");
  const statements = phase.body?.statements;
  assert.ok(statements !== undefined);
  const declaration = statements[2] as { kind: "declare"; name: string; value: any };
  assert.equal(declaration.kind, "declare");
  assert.equal(declaration.value.k, "buffer");
  assert.equal(declaration.value.values.length, 6);
  assert.equal(declaration.value.values[0].text, "1");
  assert.equal(declaration.value.values[3].text, "4");
  assert.equal(declaration.value.values[5].text, "6");
});

test("list concatenation in a function is uncontractable", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "def f(a: list[int], b: list[int]) -> list[int]:\n    return a + b\n" }, "main.py"),
  );
  assert.match(refused, /contract states no postcondition/);
});

test("list concatenation of constants in a function is uncontractable", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "def f() -> int:\n    c = [1, 2, 3] + [4, 5, 6]\n    return c[0] + c[5]\n" }, "main.py"),
  );
  assert.match(refused, /contract states no postcondition/);
});

test("a function whose result the contract language cannot state is contracted by what it does", () => {
  // The contract language states `+ - * /` and the comparisons, and Python's
  // floor division, power and remainder are not among them. Writing one into
  // the postcondition would refuse the parser, so the body is contracted by
  // what it does instead of by an expression.
  const phase = phaseOf(
    "python",
    {
      "main.py": [
        "def identity(x: int) -> int:",
        "    return x",
        "",
        "def floor(x: int, y: int) -> int:",
        "    return x // y",
        "",
        "def power(x: float, y: float) -> float:",
        "    return x ** y",
        "",
      ].join("\n"),
    },
    "main.py",
  );
  const functions = phase.program.files[0].functions;
  assert.deepEqual(functions.floor.ensures, []);
  assert.deepEqual(functions.power.ensures, []);
});

test("a chained slice in a function body", () => {
  const phase = phaseOf("python", { "main.py": "def f(a: list[int]) -> int:\n    return a[1:3][0]\n" }, "main.py");
  const contract = phase.program.files[0].functions["f"];
  assert.deepEqual(contract.ensures, ["result == a[1:3][0]"]);
});

test("a parameter of a function of a module is read only, and the range it reads is stated", () => {
  const source = [
    "def first(a: list[float]) -> float:",
    "    return a[0]",
    "",
  ].join("\n");
  const contract = contractOf(source, "first");
  assert.deepEqual(contract.requires, ["a != null", "len(a) >= (0 + 1)"]);
});

test("a print of a program is written with a space between its values", () => {
  const phase = phaseOf("python", { "main.py": 'print("a", 1)\n' }, "main.py");
  const statement = phase.body?.statements[0];
  assert.ok(statement !== undefined);
  assert.equal(statement.kind, "print");
});

test("printing a list or a dict is refused, because the two styles do not cover one", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "print([1, 2])\n" }, "main.py"),
  );
  assert.match(refused, /a list or a dict is not written the way Python writes it/);
});

test("the harness of a function build sets the style of the text it writes", () => {
  const phase = phaseOf("python", { "main.py": "def twice(x: int) -> int:\n    return x * 2\n" }, "main.py");
  const contract = phase.program.files[0].functions["twice"];
  assert.ok(contract !== undefined);
  const harness = generateHarness(contract, "", "python");
  assert.match(harness, /blaze_rt_set_text_style\(1\)/);
});

test("the name of the module a program runs is the one the guard reads", () => {
  const phase = phaseOf("python", { "main.py": 'if __name__ == "__main__":\n    f()\n' }, "main.py");
  const statement = phase.body?.statements[0];
  assert.ok(statement !== undefined && statement.kind === "if");
  const condition = statement.condition;
  assert.equal(condition.k, "binary");
  assert.equal(condition.op, "==");
  assert.deepEqual(condition.left, { k: "text", parts: [{ k: "text", value: "__main__" }] });
  assert.deepEqual(condition.right, { k: "text", parts: [{ k: "text", value: "__main__" }] });
});
