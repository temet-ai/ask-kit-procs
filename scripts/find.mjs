export const meta = {
  purpose: "Processes matching some words (in the name, the command line or the folder), with pid, age, memory, folder and command. The answer to 'is X running', 'what is the pid of X', 'how long has X been running'.",
  params: { match: "words that must all be there (any case), or a /regex/", sort: "memory (default), cpu, age (oldest first) or new", limit: "default 20" },
  returns: "{verdict, total, processes:[{pid, ppid, name, user, state, memory, cpuSeconds, started, age, cwd?, command}], leftOut?}",
  example: 'await scripts.run("find", { match: "vite" })',
};

export default async function ({ procs }, { match, sort = "memory", limit = 20 } = {}) {
  if (!match) throw new Error("find needs `match`: words from the process's name, command or folder");
  const [prot, r] = await Promise.all([procs.protected(), procs.list({ match, sort, limit: 5000 })]);
  const guard = new Set(prot);
  // The processes answering this very question hold the words in their own arguments: they are not what was asked about.
  const kept = r.processes.filter((p) => !guard.has(p.pid)).map(({ rssBytes, ...p }) => p);
  const n = Number(limit);
  return { verdict: kept.length ? `${kept.length} running: ${kept.slice(0, 4).map((p) => `${p.name} (pid ${p.pid}, ${p.age})`).join(", ")}${kept.length > 4 ? " and more" : ""}` : `no running process matches "${match}"`, total: kept.length, processes: kept.slice(0, n), ...(kept.length > n ? { leftOut: kept.length - n } : {}) };
}
