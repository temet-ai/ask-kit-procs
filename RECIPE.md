# Recipe: the procs kit

## What it answers

Which process holds a port, what uses the CPU and memory now, whether a program is running and
since when, what was left running, what started a process. It also acts: stops a process by
pid or by port.

## What it needs

- ask-kit 0.3 or later (`min_ask_kit = "0.3.0"`). No settings, no tokens.
- Linux: nothing (`/proc`); `ss` or `lsof` when present, for listeners of other users.
- macOS: `ps` and `lsof`. Windows: `powershell.exe` and `netstat`.

## What it reads and runs

Linux: `/proc/<pid>/stat`, `cmdline`, `status`, the `cwd` and `exe` links, `/proc/stat` for the
boot time, `/etc/passwd` for user names, `/proc/meminfo`. Listeners: `ss -H -ltnp`, else
`lsof -nP -iTCP -sTCP:LISTEN -Fpn`, else `/proc/net/tcp` and `tcp6` matched to processes through
the socket links in `/proc/<pid>/fd`. macOS: `ps -axo pid=,ppid=,user=,state=,rss=,time=,lstart=,command=`
and `lsof -a -d cwd -p <pids> -Fpn` for folders. Windows: `Get-CimInstance Win32_Process` and
`netstat -ano -p TCP`. Never `/proc/<pid>/environ`.

It sends signals with `process.kill` only when asked for a change.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.procs`, name `procs`, `says`, `keywords`,
`route_hint`, `cite`, `acts = ["procs.kill"]`, one `[[sources]]` of kind `module`, name `procs`,
module `procs.mjs`, api `api.d.ts`, and two `[[actions]]`: `port` for "what is using port N" and
`top` for "what is using the CPU") and `instructions = "instructions.md"`.

`procs.mjs` exports `make({push, act})` returning the `procs` global. One reader per platform
gives rows of `{pid, ppid, name, user, state, rss, cpuSeconds, started, command, cwd, exe}`;
command lines pass through `redact` once, there. On it: `list({match, user, sort, limit})`,
`get(pid)`, `tree(pid)` (parents to pid 1, children with depth), `ports({port})`,
`busy({seconds})` (two readings; the CPU time gained between them over the interval, 100 being
one core), `memory()`, `protected()` (this process, its parents, pid 1) and `kill(pid, {tree,
wait, force})`, which throws the "not in this ask" sentence without `act`, refuses the protected
pids, sends SIGTERM, waits, sends SIGKILL to what is left, and counts a zombie as stopped.

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and
`export default async function ({procs}, params)`), each returning a `verdict` first: `port`,
`top`, `running` (processes that are a runtime or tool a person starts, or hold a port, outside
the system folders, grouped under their topmost process, with ports, folder, age and whether
their parent has gone; the session asking is left out), `find`, `tree`, `stop` (by pid or by a
port's holders; reads the port back).

`instructions.md` has the docker kit's structure: how to work (scripts first; CPU is about now;
a port is decided by a listener and its address; never guess a pid; the environment is off
limits; stop exactly what was named and read the state back; a managed service comes back) and
the answer format.

## Bench

`ask-kit kit test procs`. All eight questions are shots (`do`) against the machine as it is,
chosen so they hold anywhere: port 1 has no listener, the kit's own process has parents, a
made-up name matches nothing. They call no model. Questions for a model (`q`) are still to be
added from real sessions: the times an agent ran `lsof -i`, `ps aux | grep` or `kill` by hand.
`ask` with the sessions kit can list them.

## Results

ask-kit `kit test` on 2026-11-20 (Linux): 8/8, all answered with no model. No model run yet.
