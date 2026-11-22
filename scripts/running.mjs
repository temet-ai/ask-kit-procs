export const meta = {
  purpose:
    "What was started by hand or by an agent and is still running: dev servers, watchers, builds, scripts and databases, each with its folder, its ports, how long it has run and whether what started it has gone. System services and the session asking are left out. The answer to 'what dev servers are running', 'what did the last session leave running', 'is the app still up'.",
  params: { under: "keep only processes whose folder is under this path, optional", match: "words that must be in the name, command or folder, optional", all: "true to include system processes too" },
  returns: "{verdict, processes:[{pid, name, age, cwd, ports:[...], startedBy, orphan, memory, command}], leftOut?}",
  example: 'await scripts.run("running", { under: "~/projects/watch" })',
};

// Runtimes and tools a person or an agent starts; anything holding a port outside the system folders counts too.
const TOOLS = /^(node|bun|deno|npm|pnpm|yarn|npx|tsx|ts-node|vite|next|nuxt|webpack|esbuild|rollup|turbo|nodemon|python\d*(\.\d+)?|uv|uvicorn|gunicorn|flask|django|celery|jupyter\S*|ruby|rails|puma|bundle|php|java|gradle\S*|mvn|cargo|rustc|go|air|dotnet|mix|elixir|beam\.smp|make|just|tail|watch|ssh|kubectl|docker|docker-compose|postgres|mysqld|redis-server|mongod|ngrok|cloudflared|caddy|nginx|hugo|jekyll|mkdocs|pytest|jest|vitest|playwright|chrome|chromium\S*|sleep)$/i;
const SYSTEM_DIR = /^(\/$|\/(usr|bin|sbin|lib|opt|var|etc|run|proc|sys|System|Library)(\/|$))/;

export default async function ({ procs }, { under, match, all = false } = {}) {
  const [prot, { processes }, ports] = await Promise.all([procs.protected(), procs.list({ ...(match ? { match } : {}), sort: "age", limit: 5000 }), procs.ports()]);
  const guard = new Set(prot);
  const portsOf = new Map();
  for (const l of ports.listeners) if (l.pid != null) portsOf.set(l.pid, [...new Set([...(portsOf.get(l.pid) ?? []), l.port])]);
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const home = (p) => p?.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "~");
  const want = under ? home(String(under)).replace(/\/+$/, "") : null;
  const kept = processes.filter((p) => {
    if (guard.has(p.pid)) return false;
    const cwd = home(p.cwd);
    if (want && !(cwd === want || cwd?.startsWith(want + "/"))) return false;
    if (all || match) return true;
    const interesting = TOOLS.test(p.name) || portsOf.has(p.pid);
    return interesting && !(cwd && SYSTEM_DIR.test(cwd) && !portsOf.has(p.pid)) && p.name !== "sleep" ? true : interesting && p.name === "sleep" && !!cwd && !SYSTEM_DIR.test(cwd);
  });
  // A child of a kept process is part of it: show the top of each group, with its children counted.
  const keptPids = new Set(kept.map((p) => p.pid));
  const tops = kept.filter((p) => !keptPids.has(p.ppid));
  const kids = (pid) => kept.filter((p) => p.ppid === pid).flatMap((p) => [p, ...kids(p.pid)]);
  const rows = tops.map((p) => {
    const group = [p, ...kids(p.pid)];
    const parent = byPid.get(p.ppid);
    const orphan = p.ppid === 1 || !parent;
    return {
      pid: p.pid,
      name: p.name,
      age: p.age,
      ...(p.cwd ? { cwd: p.cwd } : {}),
      ports: [...new Set(group.flatMap((g) => portsOf.get(g.pid) ?? []))].sort((a, b) => a - b),
      startedBy: orphan ? "gone: what started it has ended" : guard.has(p.ppid) ? "this session" : `${parent.name} (pid ${parent.pid})`,
      orphan,
      memory: p.memory,
      ...(group.length > 1 ? { children: group.length - 1 } : {}),
      command: p.command.slice(0, 220),
    };
  });
  const max = 40;
  const orphans = rows.filter((r) => r.orphan).length;
  const withPorts = rows.filter((r) => r.ports.length).length;
  return {
    verdict: rows.length ? `${rows.length} running${want ? ` under ${under}` : ""}: ${withPorts} holding a port, ${orphans} whose starter has gone` : `nothing started by hand is running${want ? ` under ${under}` : ""}`,
    processes: rows.slice(0, max),
    ...(rows.length > max ? { leftOut: rows.length - max } : {}),
    ...(ports.note ? { note: ports.note } : {}),
  };
}
