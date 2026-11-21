interface Proc {
  pid: number; ppid: number; name: string; user: string | null;
  state: string;                 // R running, S sleeping, Z ended but not collected (zombie), T stopped
  memory: string; rssBytes: number;
  cpuSeconds: number;            // CPU time used since it started, not its share now: busy() gives the share now
  started: string; age: string;  // age as text: "34 min", "2.1 h", "3 days"
  cwd?: string;                  // its working folder, with ~ for the home folder; missing when it cannot be read
  command: string;               // the command line, with passwords and tokens shown as <redacted>
}

declare const procs: {
  // The platform reader in use (/proc on Linux, ps on macOS, powershell on Windows) and this process's own pid.
  info(): { platform: string; self: number; reader: string };

  // Processes, kernel threads left out. match: words that must all be in the name, the command line or the folder
  // (any case), or a /regex/. sort: "memory" (default), "cpu" (CPU time so far), "age" (oldest first), "new".
  // limit default 30. A process's environment is never read.
  list(o?: { match?: string; user?: string; sort?: "memory" | "cpu" | "age" | "new"; limit?: number }): Promise<{ total: number; processes: Proc[]; leftOut?: number }>;

  // One process by pid, or "self" for the process answering. null when there is none.
  get(pid: number | "self"): Promise<Proc | null>;

  // What started a process and what it started: parents nearest first, up to pid 1; children with their depth.
  tree(pid: number | "self"): Promise<{ process: Proc | null; parents: Proc[]; children: (Proc & { depth: number })[]; childrenLeftOut?: number }>;

  // TCP listeners with the process holding each. port keeps one port. `by` is what listed them (ss, lsof, /proc,
  // netstat). A listener of another user's process may have pid null and a note: it is in use, by whom is not known.
  // address "*" means every interface; 127.0.0.1 and ::1 mean this machine only.
  ports(o?: { port?: number }): Promise<{ by: string | null; listeners: { port: number; address: string; proto: string; pid: number | null; name: string | null; user?: string; age?: string; cwd?: string; command?: string; note?: string }[]; note?: string }>;

  // What uses the CPU at this moment: two readings `seconds` apart (default 1). cpuPercent 100 is one whole core.
  // load is the 1, 5 and 15 minute load average; above `cores` there is more work than cores.
  busy(o?: { seconds?: number; limit?: number; min?: number }): Promise<{ seconds: number; cores: number; load: number[]; processes: { pid: number; name: string; cpuPercent: number; memory: string; age: string; cwd?: string; command: string }[] }>;

  // The machine's memory. available counts what can be given to a program (caches included).
  memory(): { total: string; available: string; used: string; usedPercent: number };

  // The pids that are never stopped: this process, its parents (the agent that asked) and pid 1.
  protected(): Promise<number[]>;

  // Stop a process: SIGTERM, then SIGKILL after `wait` seconds (default 5) if it is still there and force is not false.
  // tree also stops its children, children first. Only when the caller asked for a change (act: true); otherwise it
  // throws "not in this ask". Always refused ("not allowed") for the pids in protected(). A process that is gone
  // returns stopped: false with a note; another user's process returns stopped: false with an error.
  kill(pid: number, o?: { tree?: boolean; wait?: number; force?: boolean; signal?: string }): Promise<{ pid: number; name?: string; command?: string; stopped: boolean; signal?: string; waited?: string; children?: number; note?: string; error?: string }>;
};
