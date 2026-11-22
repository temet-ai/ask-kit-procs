export const meta = {
  purpose:
    "Who holds a port: the process listening on it, its folder, how long it has run, what started it, and how to stop it. The answer to 'what is using port 3000', 'why is the port already in use' (EADDRINUSE). Without a port: every listening port and its process.",
  params: { port: "the port number; leave out for all listeners" },
  returns: "{verdict, port?, by, listeners:[{port, address, pid, name, user, age, cwd?, command, startedBy?}], note?}",
  example: 'await scripts.run("port", { port: 3000 })',
};

export default async function ({ procs }, { port } = {}) {
  const r = await procs.ports(port != null && port !== "" ? { port: Number(port) } : {});
  const listeners = await Promise.all(r.listeners.map(async (l) => {
    let startedBy;
    if (l.pid != null && port != null) {
      const t = await procs.tree(l.pid);
      const p = t.parents[0];
      startedBy = !p || p.pid === 1 ? "its parent has gone (it runs on its own now)" : `${p.name} (pid ${p.pid})${t.parents[1] && t.parents[1].pid !== 1 ? `, under ${t.parents[1].name}` : ""}`;
    }
    return { ...l, ...(startedBy ? { startedBy } : {}) };
  }));
  const verdict = !r.by
    ? r.note
    : port != null && port !== ""
      ? listeners.length
        ? [...new Set(listeners.map((l) => (l.pid == null ? `port ${port} is in use by a process that could not be read` : `port ${port} is held by ${l.name} (pid ${l.pid})${l.cwd ? ` in ${l.cwd}` : ""}, running for ${l.age}`)))].join("; ")
        : `nothing is listening on port ${port}`
      : `${new Set(listeners.map((l) => l.port)).size} ports have a listener`;
  return { verdict, ...(port != null && port !== "" ? { port: Number(port) } : {}), by: r.by, listeners, ...(r.note && r.by ? { note: r.note } : {}) };
}
