export const meta = {
  purpose:
    "What is using the machine right now: the processes using the most CPU at this moment (two readings a second apart) and the most memory, with the machine's load and free memory. The answer to 'why is my machine slow', 'what is eating CPU', 'what is using all the memory'.",
  params: { n: "how many of each, default 8", seconds: "time between the two CPU readings, default 1" },
  returns: "{verdict, cores, load:[1, 5, 15 min], memory:{total, available, used, usedPercent}, cpu:[{pid, name, cpuPercent, memory, age, cwd?, command}], mem:[{pid, name, memory, cpuSeconds, age, cwd?, command}]}",
  example: 'await scripts.run("top")',
};

export default async function ({ procs }, { n = 8, seconds = 1 } = {}) {
  const busy = await procs.busy({ seconds: Number(seconds), limit: Number(n) });
  const mem = await procs.list({ sort: "memory", limit: Number(n) });
  const memory = procs.memory();
  const top = busy.processes[0];
  const big = mem.processes[0];
  const loaded = busy.load[0] > busy.cores;
  const verdict =
    `${top && top.cpuPercent >= 50 ? `${top.name} (pid ${top.pid}) is using ${top.cpuPercent}% of a core` : "no process is using much CPU right now"}; ` +
    `load ${busy.load[0]} on ${busy.cores} cores${loaded ? " (more work than cores)" : ""}; ` +
    `memory ${memory.usedPercent}% used${big ? `, the most by ${big.name} (pid ${big.pid}, ${big.memory})` : ""}`;
  return { verdict, cores: busy.cores, load: busy.load, memory, cpu: busy.processes, mem: mem.processes.map(({ rssBytes, ppid, state, user, started, ...p }) => ({ ...p, command: p.command.slice(0, 200) })) };
}
