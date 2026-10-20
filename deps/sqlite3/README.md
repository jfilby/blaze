# SQLite

The SQLite amalgamation, vendored the way facil.io is vendored at
`deps/facil.io`.

| | |
|---|---|
| Version | 3.54.1 |
| Source | <https://sqlite.org/2026/sqlite-amalgamation-3540100.zip> |
| SHA3-256 | `92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30` |

The amalgamation is the whole library as one translation unit: `sqlite3.c` is
the library and `sqlite3.h` is the header it declares. There is nothing to
build here — the compiler compiles `sqlite3.c` itself, beside the adapter
that answers the `sqlite.*` calls of a program, and the two are bundled into
one relocatable object the program links beside its runtime.

SQLite is public domain. Nothing in it is a licence the project has to answer
for.

To update the vendored copy, download the amalgamation of the version wanted,
check the SHA3-256 against the one the download page publishes, and replace
`sqlite3.c` and `sqlite3.h` with the ones it carries.
