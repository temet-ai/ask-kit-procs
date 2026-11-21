# ask-kit-procs

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about the processes on your machine. A cheap model reads the process table and
the listening ports outside your agent's context and answers with the pid, the folder and the
command. On Linux it reads `/proc`, on macOS it uses `ps` and `lsof`, on Windows PowerShell.

Questions it is for:

- What is using port 3000? (answered by a script, with no model)
- Why is my machine slow: what is using the CPU and the memory?
- What dev servers are still running, and which did the last session leave behind?
- Is the worker running, since when, and what started it?
- Stop whatever holds port 5173.

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) 0.3 or later. Nothing else on
Linux. On macOS it uses `ps` and `lsof`, which are part of the system.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-procs
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-procs        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-procs --yes  # installs and enables it
```

Restart your agents so `ask` lists `procs`. The kit has no settings.

## What it can change

When asked, it stops a process, by pid or by the port it holds: SIGTERM first, then SIGKILL
after five seconds if the process is still there, optionally with its children. It runs as you,
so it can stop only your own processes.

`procs.mjs` holds two rules:

- It never stops the process answering the question, any of its parents (the agent that asked,
  the terminal it runs in) or pid 1.
- It never reads a process's environment, and passwords, tokens and keys in command lines
  (`--password x`, `API_KEY=x`, `-u user:pass`, `postgres://user:pass@`, `Authorization:`
  headers, strings shaped like known keys) are shown as `<redacted>`. The redaction is by
  pattern: a secret passed in an unusual way can get through.

## How well it works

`bench/questions.json` holds eight checks that run with no model on the machine as it is (a
port nothing listens on, the kit's own process tree, the CPU and memory reading).
`ask-kit kit test procs` on 2026-11-20 on Linux: 8/8, all answered with no model. Stopping was
proved by hand on throwaway processes: a tree of children, a process that ignores SIGTERM, a
process that had already ended, and the refusals for the session's own parents.

No model run has been made yet: the bench has no questions from real sessions. The `ps` reader
macOS uses was run on Linux, where `ps` takes the same options, but not on a Mac; the listener
lookup was run through `lsof` and through `/proc`, not through `ss`; Windows is written and
not run.

## What is in it

`procs.mjs` reads processes and listeners and holds the rules above. Its scripts are `port`
(who holds a port, or every listener), `top` (CPU now, memory, load), `running` (what was
started by hand or by an agent and is still there, with folders and ports), `find` (is a
program running), `tree` (what started a process and what it started) and `stop`.
[RECIPE.md](RECIPE.md) says what it reads and runs, and how to rebuild it.

MIT licence.
