export const meta = {
  purpose:
    "Stop a process, by pid or by the port it holds: asks it to end (SIGTERM), waits, and kills it (SIGKILL) only if it is still there. Says what was stopped and checks that the port is free. Changes things: works only when the caller asked for it. Never stops the session asking or its parents.",
  params: { pid: "the process id", port: "or the port whose holder to stop", tree: "also stop its children, default true", wait: "seconds to wait before killing, default 5", force: "false to never send SIGKILL" },
  returns: "{verdict, stopped:[{pid, name, command, stopped, signal, waited, children?}], port?, portFree?}",
  example: 'await scripts.run("stop", { port: 3000 })',
};

export default async function ({ procs }, { pid, port, tree = true, wait = 5, force = true } = {}) {
  if (pid == null && port == null) throw new Error("stop needs `pid` or `port`");
  let pids = pid != null ? [Number(pid)] : [];
  if (port != null) {
    const r = await procs.ports({ port: Number(port) });
    pids = [...new Set(r.listeners.map((l) => l.pid).filter((p) => p != null))];
    if (!pids.length) return { verdict: r.listeners.length ? `port ${port} is held by a process that could not be read, so nothing was stopped` : `nothing is listening on port ${port}; nothing was stopped`, stopped: [], port: Number(port), portFree: !r.listeners.length };
  }
  const stopped = [];
  for (const p of pids) stopped.push(await procs.kill(p, { tree, wait: Number(wait), force }));
  const out = { stopped };
  if (port != null) {
    const after = await procs.ports({ port: Number(port) });
    out.port = Number(port);
    out.portFree = !after.listeners.length;
  }
  const ok = stopped.filter((s) => s.stopped);
  out.verdict = `${ok.length ? `stopped ${ok.map((s) => `${s.name} (pid ${s.pid}, ${s.signal})`).join(", ")}` : "nothing was stopped"}${stopped.length > ok.length ? `; not stopped: ${stopped.filter((s) => !s.stopped).map((s) => `pid ${s.pid} (${s.error ?? s.note ?? "still running"})`).join(", ")}` : ""}${port != null ? `; port ${port} is ${out.portFree ? "free" : "still in use"}` : ""}`;
  return { verdict: out.verdict, stopped: out.stopped, ...(port != null ? { port: out.port, portFree: out.portFree } : {}) };
}
