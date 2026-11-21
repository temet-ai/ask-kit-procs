export const meta = {
  purpose: "What started a process and what it started: its parents up to the top and its children, each with pid, name, age and command. The answer to 'what launched this', 'which terminal or agent does it belong to', 'what will stop if I stop it'.",
  params: { pid: "the process id, or 'self' for the process answering" },
  returns: "{verdict, process, parents:[nearest first], children:[{depth, pid, name, age, command}]}",
  example: 'await scripts.run("tree", { pid: 4242 })',
};

export default async function ({ procs }, { pid } = {}) {
  if (pid == null || pid === "") throw new Error("tree needs `pid`");
  const t = await procs.tree(pid);
  if (!t.process) return { verdict: `no process ${pid} (it may have ended)`, process: null, parents: [], children: [] };
  const slim = ({ rssBytes, state, user, started, cpuSeconds, ...p }) => ({ ...p, command: p.command.slice(0, 200) });
  const chain = t.parents.filter((p) => p.pid !== 1).map((p) => p.name);
  return {
    verdict: `${t.process.name} (pid ${t.process.pid}) was started by ${chain.length ? chain.join(", started by ") : "nothing still running"}; it has ${t.children.length} ${t.children.length === 1 ? "child" : "children"}`,
    process: slim(t.process),
    parents: t.parents.map(slim),
    children: t.children.map(slim),
    ...(t.childrenLeftOut ? { childrenLeftOut: t.childrenLeftOut } : {}),
  };
}
