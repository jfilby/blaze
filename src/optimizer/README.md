# blazeopt

`blazeopt` improves the blaze compiler by reading it, proposing changes to
it, and keeping the ones that survive the compiler's own test suite and a
measurement of it. `blazeopt-report` reads what a run of it did.

Both are commands of this package, installed with `npm link`:

```
npm link
blazeopt [project] [options]
blazeopt-report [options]
```

## What a run does

One turn of the loop is a **run**: it gathers context, asks a model for
changes, applies them, runs the compiler's test suite, measures the compiler
before and after, and commits what survived. One invocation of `blazeopt` is
a **session**, which is the runs it got through.

A run is one of three **methods**:

| method | what it reads before proposing |
|---|---|
| `research` | an online search for optimization research, plus the compiler source |
| `build-feedback` | the reviewer prompts and answers of a real `blaze build`, plus the source |
| `code-review` | the compiler source alone |

A run records itself whether it got anywhere or not, and so does a session
that was refused before it ran anything: `.blazeopt/runs` holds one record
per run and `.blazeopt/sessions` holds one per session, at the head of the
repository. A run record stands on its own — it carries the context of the
session it belonged to — so a report never has to join two files to say what
one run did.

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
   failure a proposal causes is a failure the proposal caused.
2. After a change is applied the suite must pass, or the change is reverted.
3. The compiler must not measure slower. A difference smaller than the two
   measurements' own spread is noise, not a change, and is kept.

Every file a run writes is reverted and committed on its own — never the
whole working tree, which is the user's repository.

## Environment

| variable | what it is for |
|---|---|
| `AI_MODEL` | `provider/model`, e.g. `anthropic/claude-sonnet-4-5` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | provider keys |
| `TAVILY_API_KEY` | the `research` method's searches |

A run with no model configured proposes nothing, and a `research` run with
no Tavily key fails; either way the run records that it happened.

## Tests

```
npm test           # node --test test/*.test.ts
npm run typecheck
```

The suite covers what a proposal is allowed to do to a file, what is read
back out of what a model wrote, what the commands do to a repository, and
what the records add up to in a report. It needs no API key and no network,
and it takes a couple of seconds.
