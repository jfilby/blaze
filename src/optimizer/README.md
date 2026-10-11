# blazeopt

`blazeopt` improves the blaze compiler by giving a coding agent what it needs
to read it and asking it to make the compiler better, then keeping the changes
that survive the compiler's own test suite and a measurement of it.
`blazeopt-report` reads what a run of it did.

Both are commands of this package, installed with `npm link`:

```
npm link
blazeopt [project] [options]
blazeopt-report [options]
```

## What a run does

One turn of the loop is a **run**: it gathers context, hands that context to
the coding agent, reads back what the agent wrote, runs the compiler's test
suite, measures the compiler with the change and without it, and commits what
survived. One invocation of `blazeopt` is a **session**, which is the runs it
got through.

A run is one of three **methods**, which is how it gathers its context:

| method | what it gathers before handing the run over |
|---|---|
| `research` | an online search for optimization research |
| `build-feedback` | the reviewer prompts and answers of a real `blaze build` |
| `code-review` | nothing |

The changes themselves are written by the agent, not proposed as text and
applied: it reads the compiler source, decides what to change and edits it.

A run records itself whether it got anywhere or not, and so does a session
that was refused before it ran anything: `.blazeopt/runs` holds one record
per run and `.blazeopt/sessions` holds one per session, at the head of the
repository. A run record stands on its own — it carries the context of the
session it belonged to — so a report never has to join two files to say what
one run did.

## Where the agent works

The agent is started at the **base of the repository**, not in the compiler
directory. Two things follow from that, and both of them are wanted:

- The repository's own `AGENTS.md` is at the head of it, and a coding agent
  reads its instructions from wherever it starts. That file is how anyone
  works in this repository, so it is what the agent works under.
- The file is handed to the agent by name as well (`--append-system-prompt`),
  so a run does not depend on the agent's own discovery finding it.

The agent may write only in the compiler package, and never in its tests: the
tests are the gate a change is judged by, so an agent that rewrote one would
be judging itself. An edit anywhere else is taken back out before the run is
judged, and recorded as a refusal naming the reason.

## Watching the agent

```
blazeopt --show-ai-coding
```

The agent is asked in print mode, which writes its answer at the end of its
work and nothing at all on the way — so a run nobody is watching has nothing
to show. With this flag it is asked in the event mode instead, which carries
every tool it calls as it calls it, and each one is printed as it happens:

```
Handing the run to pi, the coding agent at the base of the repository...
pi: tool read path=src/compiler/codegen.ts
pi: tool bash command=npm run typecheck
pi: tool bash failed: exitCode=2 stdout=error TS2322
pi: I hoisted the invariant out of the inner loop.
```

A tool is shown with what it was given, and with what it answered when it
went wrong: what it answered when it went well is a file or a build log, and
none of that is what it did. The change is still read out of the tree rather
than out of this, and it is judged by the same three gates.

## blazeopt-report

```
blazeopt-report
blazeopt-report --method research          # one method only
blazeopt-report --since 7                  # the last week
blazeopt-report --limit 20 --list          # the last 20 runs, one line each
blazeopt-report --json                     # machine-readable
```

It reads those records and reports on them: how often a run gets to a
commit, which method earns it, what has been refusing the runs, which files
the kept changes were written in, and what the measurements have been doing
to the compiler.

## How a change is judged

Three gates, all of them the compiler's own:

1. The compiler's test suite must pass before any run starts, so that a
   failure a change causes is a failure the change caused.
2. After a change is written the suite must pass, or the change is reverted.
3. The compiler must not measure slower. A difference smaller than the two
   measurements' own spread is noise, not a change, and is kept.

Every file the agent writes is reverted and committed on its own — never the
whole working tree, which is the user's repository.

Because the change is already in the tree by the time there is anything to
measure, a run takes it back out to measure the compiler without it and puts
it straight back. The two measurements are then of the same compiler minutes
apart rather than a run apart.

## Environment

| variable | what it is for |
|---|---|
| `AI_MODEL` | `provider/model`, e.g. `anthropic/claude-sonnet-4-5`. With a project, its `blaze.toml` is read instead when this is not set |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | provider keys |
| `TAVILY_API_KEY` | the `research` method's searches |

`pi`, the coding agent, must be installed and on `PATH`, and the repository
must carry its `AGENTS.md` at the head. A run with no model configured is
refused, and a `research` run with no Tavily key fails; either way the run
records that it happened.

## Tests

```
npm test           # node --test test/*.test.ts
npm run typecheck
```

The suite covers where the coding agent is started and what it is handed,
what is read back out of the tree it worked in and what is taken back out of
it, what the commands do to a repository, and what the records add up to in
a report. It needs no API key and no network, and it takes a couple of
seconds.

A run asks one model, and it is the model a build of the project asks: the
environment's, or the project's own when the environment names none. Which
model is resolved, and how a provider is constructed, are the compiler's own
code — `ai/model.ts` and `ai/backend.ts` — so a project that compiles with a
model is a project the optimizer asks. The agent is told that model in the
form the compiler names it, `provider/model`, which is the form it takes.
