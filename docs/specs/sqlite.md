# SQLite in a Blaze program

## What it is

A Blaze program is a TypeScript program that the compiler builds into a native
binary. The program may use the facilities the compiler provides — `http`,
`fs`, `crypto`, `JSON`, `Math`, `process` — and the compiler lowers those calls
into calls into a runtime that the program is linked beside.

This document is what it takes for such a program to use SQLite: the API a
program writes against, the runtime boundary that answers it, the library that
is linked beside the binary, the changes in the compiler that make the calls
possible, and the rules the API has to live within.

The scope is the first version: a synchronous API over one SQLite connection at
a time, over the SQLite C library. Not in scope: an object mapper, a query
builder, schema migrations, blobs, and WebAssembly — a wasm module links no
library at all, so a program that uses SQLite is a native program.

**This version is done.** What follows is the shape of it, and the decisions
that were taken on the way, with the reasons. The last section says what is not
done.

## The parts

| Part | Where it goes | What it is |
|---|---|---|
| The API | `semantics/builtins.ts` | the `sqlite.*` calls a program may write, and what each one takes and answers |
| The boundary | `runtime/sqlite.ts` | the table of the entry points, the header it writes, the allowlist it gives the sandboxes |
| The adapter | `runtime/sqlite-build.ts` | the C that answers the entry points, over the SQLite library, and the build of the object |
| The library | `deps/sqlite3` | the SQLite amalgamation, vendored the way facil.io is vendored |
| The lowering | `toolchain/driver.ts` | how a program body's `sqlite.*` call is written as C |
| The oracle | `toolchain/verify-program.ts` | the prelude that gives the source a `sqlite` to call, so the build can check the binary against it |

## The shape of the program

The API is a namespace `sqlite` that the compiler knows, in the manner of
`http`: the source names it as a global, and the compiler reads the calls out
of it.

```ts
const db = sqlite.open("notes.db");
sqlite.exec(db, "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");

const insert = sqlite.prepare(db, "INSERT INTO notes (body) VALUES (?)");
sqlite.bindText(insert, 1, "the first note");
sqlite.step(insert);
sqlite.finalize(insert);

const read = sqlite.prepare(db, "SELECT id, body FROM notes ORDER BY id");
while (sqlite.step(read) > 0) {
	console.log(sqlite.columnNumber(read, 0), sqlite.columnText(read, 1));
}
sqlite.finalize(read);
sqlite.close(db);
```

| Call | What it does |
|---|---|
| `sqlite.open(path)` | opens the database at `path`, creating it when it is not there; `":memory:"` is a database in memory |
| `sqlite.close(db)` | closes the connection |
| `sqlite.exec(db, sql)` | runs the statements of `sql` that answer no rows |
| `sqlite.prepare(db, sql)` | compiles one statement and answers a handle for it |
| `sqlite.bindText(stmt, index, text)` | binds a parameter to text; the index is 1-based, as SQLite counts them |
| `sqlite.bindNumber(stmt, index, number)` | binds a parameter to a number |
| `sqlite.bindNull(stmt, index)` | binds a parameter to null |
| `sqlite.step(stmt)` | runs the statement one row at a time: `1` while there is a row, `0` when there is none |
| `sqlite.columnCount(stmt)` | how many columns the row has |
| `sqlite.columnType(stmt, index)` | the kind of the column: `0` null, `1` integer, `2` float, `3` text, `4` blob |
| `sqlite.columnNumber(stmt, index)` | the column as a number |
| `sqlite.columnText(stmt, index)` | the column as text |
| `sqlite.finalize(stmt)` | releases the statement |
| `sqlite.changes(db)` | how many rows the last statement changed |
| `sqlite.lastInsertRowid(db)` | the rowid of the last row inserted |
| `sqlite.error(db)` | the message of the last failure of the connection |

The index of a **column** is 0-based and the index of a **parameter** is
1-based. The two are counted the way SQLite counts them, and a program that
writes them the other way round gets the wrong column.

The API is a *facility*, not a module: there is no `import` of it and no
`require` of it, exactly as there is no import of `http`. The compiler knows
the name `sqlite` and the calls under it.

The API is deliberately small and row-at-a-time. It is small because the
compiler's value model is small — a number, text, an array, an object — and a
facility that answers rows as JSON would need the program to parse JSON to use
it, which a function of a program cannot do (`JSON.parse` is lowered by the
driver, not by the backends). It is row-at-a-time because a statement that
answers rows one at a time is the shape SQLite itself has, and because a
program that reads a row and prints it does not have to hold the whole table
in memory to do it.

## Where in a source a SQLite call may appear

This decides where the compiler has to lower the calls, so it comes before the
runtime.

Blaze reads TypeScript in two subsets, and which of them reads a function is
decided by where the function is written:

- `semantics/typescript.ts` is the **module subset**. It reads the functions a
  file declares *before* the file's first statement. Its functions have typed
  parameters and a declared return type, and a call in one has to name a
  function the project declares — its own, or one it imports — or `Math.*`. A
  call of anything else is refused by the frontend: *"only a named function is
  called"* (`semantics/typescript.ts:1376`).
- `semantics/typescript-program.ts` is the **program subset**. It reads
  everything from a file's first statement on: the statements, and the
  functions declared among them. Its functions have untyped parameters, and
  they may call the facilities — `fs.readFileSync`, `JSON.parse`,
  `http.createServer` and the rest.

The two are written out differently. The program body — the statements and the
functions among them — is written as C by the driver
(`toolchain/program-emit.ts`, `toolchain/driver.ts`). The functions of a
module are compiled by the backend (machine or C) into objects that are linked
beside the driver (`compiler.ts:881`, `compiler.ts:1694`).

So there are two answers to "where may a SQLite call appear":

1. **In the program body, or in a function of the program body.** This is
   lowered by the driver's builtin switch (`toolchain/driver.ts:760`). This is
   where the first version of the facility has to be lowered, and it is enough
   for a program to use SQLite.
2. **In a function of a module.** This needs two things the compiler does not
   have today: the module subset has to admit the call, and the backend has to
   lower it (`toolchain/ir-machine.ts:7697` for the machine backend,
   `toolchain/ir-c.ts:164` for the C one). Until both are done, a module
   function cannot use SQLite, and a program that wants its database logic in
   an imported module cannot have it.

The distinction is worth stating plainly, because it is the shape of what a
Blaze program is today: the same is true of the HTTP facility, whose whole API
is available to a program body and to the functions of a program body.

## The runtime boundary

The runtime boundary is one table, and everything else is generated from it:
the C header, the symbol allowlist, the implementation. That is the shape of
`runtime/abi.ts` (the core runtime) and of `runtime/http.ts` (the HTTP
facility), and it is the shape a SQLite facility has to have, so that the two
sides of it cannot drift.

A new file, `src/compiler/runtime/sqlite.ts`, holds:

| What | What it is |
|---|---|
| `SQLITE_ABI` | the entry points, each with its symbol, its C types, a summary and an ownership note — the shape of `HTTP_ABI` (`runtime/http.ts:34`) |
| `sqliteHeaderSource()` | the `blaze_sqlite.h` header, written from the table |
| `SQLITE_SYMBOLS` / `isSqliteSymbol(symbol)` | the allowlist of the symbols the table names |
| `usesSqliteSource(source)` | whether a source uses the facility, which is the word `sqlite` in it |

And `isRuntimeSymbol` (`runtime/abi.ts:539`) has to answer true for the
SQLite symbols, because that predicate is the sandbox every backend checks a
call against:

- the C backend refuses a candidate that calls outside the runtime ABI
  (`toolchain/csource.ts:176`);
- the machine backend refuses a function that refers to a symbol that is
  neither the runtime, nor the C library, nor a function of the program
  (`toolchain/ir-machine.ts:1152`).

The entry points the table names:

| Symbol | C signature | What it does |
|---|---|---|
| `blaze_sqlite_open` | `double (const char* path)` | opens the database; answers a handle |
| `blaze_sqlite_close` | `void (double db)` | closes the connection and finalizes the statements it holds |
| `blaze_sqlite_exec` | `double (double db, const char* sql)` | runs the statements that answer no rows; answers `1` when they ran |
| `blaze_sqlite_prepare` | `double (double db, const char* sql)` | compiles one statement; answers a handle |
| `blaze_sqlite_bind_text` | `void (double stmt, double index, const char* value)` | binds a parameter to text |
| `blaze_sqlite_bind_number` | `void (double stmt, double index, double value)` | binds a parameter to a number |
| `blaze_sqlite_bind_null` | `void (double stmt, double index)` | binds a parameter to null |
| `blaze_sqlite_step` | `double (double stmt)` | runs the statement one row at a time: `1` while there is a row, `0` when there is none |
| `blaze_sqlite_column_count` | `double (double stmt)` | how many columns the row has |
| `blaze_sqlite_column_type` | `double (double stmt, double index)` | the kind of the column |
| `blaze_sqlite_column_number` | `double (double stmt, double index)` | the column as a number |
| `blaze_sqlite_column_text` | `const char* (double stmt, double index)` | the column as text |
| `blaze_sqlite_finalize` | `void (double stmt)` | releases the statement |
| `blaze_sqlite_changes` | `double (double db)` | how many rows the last statement changed |
| `blaze_sqlite_last_insert_rowid` | `double (double db)` | the rowid of the last row inserted |
| `blaze_sqlite_error` | `const char* (double db)` | the message of the last failure |

### What owns what

The ownership rules are part of the ABI, not an afterthought of it, and they
are stated in the table the way `RUNTIME_ABI` states them:

- **Text a column answers is copied.** `sqlite3_column_text` answers a pointer
  into the statement's own memory, which the next `sqlite3_step` overwrites
  and `sqlite3_finalize` frees. The adapter copies it into the runtime's text
  (`blaze_rt_string_new`), so the text a program holds is still there after
  the statement is stepped again. The copy is not released: the runtime's
  strings live until the program ends, so a program that reads a million rows
  holds a million texts. That is the runtime's model and not the adapter's
  to change.
- **A handle is a number.** The handle is the slot the handle is held in, and
  the adapter holds the pointer. A number the program holds is rendered as a
  number, which is what a handle has to be: the runtime renders a value it
  does not hold and that is above 4096 as if it were a string pointer, so a
  handle that was a pointer would be printed as the bytes of a struct. The
  slots are not reused, so the number a handle is does not depend on what the
  program did before it — which is what lets the source of a program and the
  program the compiler built print the same handle.
- **A statement that is not finalized is a leak.** The adapter keeps the
  statements of a connection, and closing the connection finalizes them.

### What a failure is

The API says what a call answers, and a failure is one of three things:

| Call | On a failure |
|---|---|
| `sqlite.exec` | answers `0`; the message is kept by the connection and `sqlite.error` answers it |
| `sqlite.prepare` | raises the runtime's error with SQLite's own message; the program stops |
| `sqlite.step` | raises the runtime's error with SQLite's own message; the program stops |
| every other call | a handle that is not a handle raises; `close` and `finalize` ignore it |

A statement that does not compile and a row that cannot be read both stop the
program, which is what "an error is an error" means in a language whose
program bodies cannot catch: the try block of a program body is read past
(`semantics/typescript-program.ts:43`). The one failure that does not stop the
program is `exec`, because it is the call that runs a batch of statements and
answers whether they ran; a program that wants to know why reads
`sqlite.error`.

The oracle throws on every failure, because `node:sqlite` throws on every
failure. The prelude therefore catches the failure of an `exec` and answers
`0`, and lets the others through.

## The library

SQLite is vendored, not linked from the system, in the way facil.io is
vendored at `deps/facil.io`:

- `deps/sqlite3` holds the **amalgamation** — `sqlite3.c` and `sqlite3.h`,
  the whole library as one translation unit, at version 3.54.1. SQLite is
  public domain, so nothing in it is a licence the project has to answer
  for, and the amalgamation is what makes the library a single file to
  compile. `deps/sqlite3/README.md` says which version it is and what its
  SHA3-256 is.
- The amalgamation is compiled with `gcc` into one object, with the flags that
  make it a library rather than a program:
  `-DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_DQS=0
  -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_OMIT_DEPRECATED`. The extension
  loading is off because a program that loads an extension loads code, and
  the double-quoted string literals are off because SQLite accepts them as
  identifiers and a program that writes one is a program with a name nobody
  can be sure of.
- The library is compiled **without** link-time optimization, whatever the
  mode of the build is. The program is linked with `-flto`, and an object that
  carries the compiler's intermediate form is rebuilt at that link — which for
  the amalgamation is a build of the whole of SQLite again, at the end of
  every build.
- The object is kept in the work directory under a name that says what it was
  built from — the flags it was compiled with and the source it was compiled
  from — so that a build that follows another one does not pay the minute it
  costs to compile the amalgamation again.
- The adapter — the `blaze_sqlite_*` entry points — is a second translation
  unit, compiled the same way, and the two are bundled into one relocatable
  object with `ld -r`, exactly as the facil runtime bundles itself
  (`runtime/facil.ts:1432`).

The result is one object, `blaze_sqlite.o`, that the program is linked beside
its runtime.

The adapter and the table cannot drift: the build compares the entry points
the table names with the ones the adapter defines and refuses to write an
adapter that implements a different set (`runtime/sqlite-build.ts`).

## How the object is linked

The compiler links **one** runtime object today, in two places:

- a *candidate* is linked with it, so that a candidate which calls the runtime
  can be run and measured (`toolchain/linker.ts:659`);
- the *program* is linked with it, beside the objects of its functions
  (`toolchain/driver.ts:1560`).

A SQLite program needs the SQLite object in both links, and needs it only when
the program uses SQLite. So:

- **SQLite is not a host runtime.** The runtime kinds are `"none"`, `"nim"`
  and `"facil"` (`core/types.ts:388`), and they say which host the program
  runs on. SQLite is a library the program links beside that host, and the
  compiler has no notion of a library yet — so one is needed. A *prepared
  library* beside the *prepared runtime* is the smallest thing that fits: the
  preparer in `codegen.ts:490` builds it when the program needs one, and the
  two links take it beside the runtime object.
- **A program asks for it by naming it.** The HTTP facility is recognized by
  the word `http` in the source (`compiler.ts:1065`, `verify-program.ts:149`),
  and the same rule is the right one here: the verification decides from the
  source whether to inject the prelude, so the rule has to be one the source
  can be asked about. `blaze.toml` has no key for a library today
  (`core/types.ts:440`), and none was added: the source-word rule is enough
  on its own and is what the HTTP facility uses.
- **A wasm program cannot use SQLite.** A wasm module imports nothing but the
  host's memory and `pow` (`toolchain/ir-wasm.ts:2868`), so the build refuses
  a program that uses SQLite rather than fail later at the link.
- **A program hosted by Nim cannot use SQLite either.** The Nim host is
  written by the host's own emitter, which knows no library, and the runtime
  it links is the only object beside it. The build refuses the program and
  says so.

## What the compiler has to change

| File | What changes |
|---|---|
| `semantics/builtins.ts` | the `sqlite.*` entries in `BUILTINS`: the arity of each call, the type of each argument, what it answers, and the effects it has |
| `semantics/typescript-program.ts` | `"sqlite"` in the two namespace sets (`:753` and `:946`), so that `sqlite.exec(...)` is a call of the facility and not a call of a member |
| `runtime/sqlite.ts` | **new**: the ABI table, the header it generates, the symbol allowlist |
| `runtime/abi.ts` | `isRuntimeSymbol` answers true for the SQLite symbols, so the sandbox of every backend admits them |
| `runtime/sqlite-build.ts` | **new**: builds `blaze_sqlite.o` from the vendored amalgamation and the adapter |
| `codegen.ts` | the preparer builds the SQLite object when the program needs one, and hands it to the links beside the runtime object |
| `toolchain/linker.ts` | the candidate link takes the SQLite object beside the runtime object |
| `toolchain/driver.ts` | the program link takes the SQLite object; the driver includes `"blaze_sqlite.h"`; the builtin switch lowers the `sqlite.*` calls |
| `toolchain/ir-machine.ts`, `toolchain/ir-c.ts` | the lowering of the `sqlite.*` calls in a function of a module — needed only once the module subset admits them |
| `toolchain/verify-program.ts` | the SQLite prelude, so that the source runs (see below) |
| `core/types.ts` | the kind of a library a program links beside its runtime |
| `semantics/optimize-ir.ts` | a loop condition that reads the world is not hoisted out of the loop (see below) |

### The effects of the calls

The `sqlite.*` calls state the effects `filesystem` and `io`. Without them the
optimizer may copy a call out of a loop, because a call with no effects is a
value it may compute twice (`semantics/repair.ts:409`), and a loop that writes
rows may be marked parallel (`semantics/parallel.ts:358`).

The effects of a builtin are stated in the table of the builtins
(`semantics/builtins.ts:57`) and the resolver hands them to the call
(`semantics/ir-resolve.ts`), so the rule is the compiler's and not the
adapter's.

One rewrite had to be taught the rule as well: the hoist that binds the
condition of a loop above the loop (`semantics/optimize-ir.ts:1157`). It holds
a value to be the same on every turn, and a call that reads the world is not
the same on every turn. A program that read rows with
`while (sqlite.step(stmt) > 0)` had its condition hoisted, read one row, and
looped on it forever.

## The rules the API lives within

These are the compiler's rules, and the API is written to them. They are here
because they are the shape of what a Blaze program can be.

- **A number is a number.** A handle is a number the program holds, and a
  number the program holds is rendered as a number. The runtime renders any
  value it does not hold that is above 4096 as if it were a string pointer,
  so a handle is a number of its own and not a pointer.
- **An integer is a double.** A number in a Blaze program is a double, so an
  `INTEGER` column comes back as a double and an id above 2^53 is not the id
  it was. `sqlite.columnText` is the way to read a whole number exactly, and
  the API says so.
- **Text is text.** A column of text is UTF-8, and the runtime's text is
  NUL-terminated, so a value with a NUL in it is refused rather than cut.
- **Null is null.** `sqlite.columnType` says `0` for a null column.
  `sqlite.columnText` answers `""` and `sqlite.columnNumber` answers `0` for
  it, so a program that does not ask the type reads a null as an empty value.
  The `0` is the API's own numbering: SQLite counts a null as five, because
  its four kinds are the ones a value can be, and the API counts it as none of
  them.
- **A function of a program is given a number or a buffer, and hands one
  back.** A name a function of a program captures is a number or a buffer: a
  string is written inside the function rather than read out of it
  (`semantics/ir-resolve.ts:1639`). And a function of a program that hands
  back a string is refused — the value comes back as a buffer, and a buffer
  has no printed form. So `sqlite.columnText` is a value a program body reads
  locally — it can be printed, compared, concatenated — and not one a program
  function hands back.
- **A call that reads the world is not a value.** See the effects above.
- **An error is an error.** See what a failure is, above.
- **A connection belongs to a thread.** SQLite is compiled in serialized mode,
  so a connection may be used from another thread — but not while another
  thread is using it. The HTTP runtime serves the handlers of a server on its
  own threads, so a program that serves HTTP and writes to one database for
  all of it opens a connection per thread, or guards the one connection it has.

## Checking the program

The build runs the source on its own toolchain and the delivered binary, and
compares what the two print (`toolchain/verify-program.ts:288`). The source is
the specification. Two things follow from that.

**The source has to run.** Node has no `sqlite` global, so the source is run
with a prelude that provides one — the same way an HTTP source is run with a
prelude that provides `http` (`toolchain/verify-program.ts:40`). The prelude
is a JavaScript implementation of the same API, over `node:sqlite` (Node 22.5
and later have it): `open` is a `DatabaseSync`, `step` is a turn of
`stmt.iterate()`, `columnText` is the value of the row the iterator is on.
That prelude is the second implementation of the API and the C adapter is the
first, and the two have to agree: a program that prints what one says and not
the other fails its own verification, which is the compiler telling the truth.

The two implementations disagree in two places, and the prelude is written to
answer as the adapter does:

- **A row is an object, not an array.** `node:sqlite` answers a row as an
  object keyed by the name of the column, so the prelude reads a column by the
  name `stmt.columns()` gives it. A query that names the same column twice
  answers one value for both of them in the prelude and two in the adapter,
  because the object holds one key for the name.
- **The kind of a column is read off the value.** `node:sqlite` does not say
  whether a number is an integer or a float, so the prelude reads the declared
  type of the column where there is one and the value itself where there is
  not.

**The two runs must not share a database.** The source runs first and the
binary second, both in the project's own directory
(`toolchain/verify-program.ts:154` and `:178`). A program that writes rows and
then reads them back writes them in the source run and finds them again in
the binary run — so the two runs compare a program that inserted two rows
against one that inserted one. The two runs have to be given a database each:
the harness copies the project into a directory of its own for each run, or the
database path of the program is rewritten per run. A program that opens
`":memory:"` has no such problem, which is why the first version of the test
suite uses it, and why a program that keeps its data in a file is a program
whose verification needs the harness to change.

## Tests

- `test/sqlite-abi.test.ts` — the ABI table, the header it generates, the
  allowlist, that `isRuntimeSymbol` admits the SQLite symbols, and that the
  adapter implements exactly the entry points the table names.
- `test/sqlite-program.test.ts` — an end-to-end build of a program that opens
  a database, creates a table, inserts a row, reads it back and prints it.
  The build's own verification against the source is the assertion, so the
  test asserts that the build succeeded and that the binary printed what the
  source prints. The machine backend is built and run as well.
- `test/sqlite-facility.test.ts` — a program body that calls each of the
  `sqlite.*` calls, built and run, so that every entry of the table is
  exercised by a program and not only by a unit test, and the lowering of each
  call to the entry point of the ABI.

The suite runs each file as its own section (`test/run.ts`), so a new file is
a new section and needs nothing else.

## What is not done

- **A module function cannot use SQLite.** The module subset admits a call of
  a function the project declares and of `Math.*`, so the facility is
  available to a program body and to the functions of a program body. Widening
  the module subset is a change to the frontend that has to be made for
  itself, not for SQLite.
- **There is no query builder and no object mapper.** A program writes SQL.
- **There are no blobs.** A blob column reads as text and the bytes of a blob
  are not a text.
- **There are no migrations and no schema.** A program creates its own tables
  with `sqlite.exec`.
- **A wasm program cannot use SQLite.** A wasm module links no library.
- **A program hosted by Nim cannot use SQLite.** The Nim host links the
  runtime and no library.
- **A connection is not shared between threads.** A program that serves HTTP
  and writes to a database opens a connection per thread.
- **The text of a column is not released.** It lives in the runtime's text
  until the program ends, so a program that reads a great many rows holds a
  great many texts.

### Open questions

- **Should `runtime` become a list?** `runtime` names one host
  (`core/types.ts:388`) and one runtime object is linked beside the program.
  A program that serves HTTP *and* uses SQLite needs two objects beside it.
  The library concept above keeps them apart, so the answer is no — but the
  question should be answered rather than assumed.
- **Should the API answer rows as JSON?** `sqlite.all(db, sql)` answering the
  rows as JSON would be easier to consume, and impossible to consume in a
  function of a module, because `JSON.parse` is lowered by the driver and not
  by the backends. The row-at-a-time API is the one that works everywhere the
  compiler reads a function.
- **Should the module subset admit the facility calls?** It has to, for a
  program whose database logic lives in an imported module. The frontend
  change is `Math.*`-shaped: a call of a name the compiler knows is a call of
  a facility, and the backend has to lower it.
- **Should the handle be a pointer the runtime holds?** It was, and it is a
  number of the adapter's own instead: a handle that is a boxed pointer is
  numbered by the runtime's registry, and the number the source of a program
  holds is then one the oracle cannot know. A handle that is a slot of the
  adapter's is the same number in both implementations, which is what lets a
  program print one and be verified.
