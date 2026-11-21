// Processes and ports for ask-kit: what runs on this machine, which process holds a port, what
// uses the CPU and memory, what a session left running, and stopping it when asked. Linux reads
// /proc; macOS and the BSDs use ps and lsof; Windows uses PowerShell.
//
// Two rules. Answers go to a cloud model, so a process's environment is never read and passwords
// and tokens in command lines are redacted. And the calls that stop a process exist only when the
// caller asked for a change (act); they never stop this process, its parents (the agent that
// asked) or pid 1.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLATFORM = process.platform;
const HOME = os.homedir();

const sh = (bin, args, { timeoutMs = 10_000 } = {}) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 << 20, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") resolve({ code: 127, out: "", err: `${bin} is not installed` });
      else resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout ?? "", err: stderr ?? "" });
    });
  });

// ---- redaction: command lines carry credentials ----
const CRED = "(?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|auth|credential|bearer|session[-_]?key|client[-_]?secret)";
const RULES = [
  [new RegExp(`(--?[\\w-]*${CRED}[\\w-]*)(=|\\s+)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), "$1$2<redacted>"],
  [new RegExp(`\\b([A-Za-z0-9_]*${CRED}[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), "$1=<redacted>"],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, "$1:<redacted>@"],
  [/((?:authorization|x-api-key|cookie)\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s"']+/gi, "$1<redacted>"],
  [/(^|\s)(-u\s*|--user[= ])([^\s:]+):[^\s]+/g, "$1$2$3:<redacted>"],
  [/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g, "<redacted>"],
];
export const redact = (s) => RULES.reduce((t, [re, to]) => t.replace(re, to), String(s ?? ""));

const tilde = (p) => (p && (p === HOME || p.startsWith(HOME + path.sep)) ? `~${p.slice(HOME.length)}` : p);
const human = (bytes) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : bytes >= 2 ** 20 ? `${Math.round(bytes / 2 ** 20)} MB` : `${Math.round(bytes / 1024)} KB`);
export const age = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 129_600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86_400)} days`;
};

// ---- Linux: /proc ----
let users = null;
const userOf = (uid) => {
  if (!users) {
    users = new Map();
    try {
      for (const l of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
        const [name, , id] = l.split(":");
        if (id != null) users.set(Number(id), name);
      }
    } catch {}
  }
  return users.get(uid) ?? String(uid);
};
const TICK = 100; // USER_HZ, the unit of /proc's times; 100 on every Linux in use
let boot = null;
const bootTime = () => (boot ??= Number(/^btime (\d+)/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1] ?? 0));

function linuxOne(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const f = stat.slice(close + 2).split(" "); // f[0] is the state, field 3
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    let cwd = null;
    let exe = null;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
    } catch {}
    let uid = null;
    try {
      uid = Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
    } catch {}
    const started = bootTime() + Number(f[19]) / TICK;
    return { pid, ppid: Number(f[1]), state: f[0], name: comm.length === 15 && exe && path.basename(exe).startsWith(comm) ? path.basename(exe) : comm, user: uid == null ? null : userOf(uid), cpuSeconds: (Number(f[11]) + Number(f[12])) / TICK, rss: Number(f[21]) * 4096, threads: Number(f[17]), started, command: cmdline.length ? cmdline.join(" ") : `[${comm}]`, kernel: !cmdline.length && !exe, cwd, exe };
  } catch {
    return null; // it ended, or it is not ours to read
  }
}
const linuxAll = () =>
  fs
    .readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .map((d) => linuxOne(Number(d)))
    .filter(Boolean);

// ---- macOS, BSD (and Linux as a cross-check): ps ----
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const cpuTime = (t) => {
  // [dd-]hh:mm:ss or mm:ss.cc
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  return m ? Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0;
};
export function parsePs(out) {
  const rows = [];
  for (const line of out.split("\n")) {
    // pid ppid user state rss(KB) cputime lstart(5 words) command
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const started = new Date(Number(m[12]), MONTHS[m[7]] ?? 0, Number(m[8]), Number(m[9]), Number(m[10]), Number(m[11])).getTime() / 1000;
    const command = m[13];
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), user: m[3], state: m[4][0], rss: Number(m[5]) * 1024, cpuSeconds: cpuTime(m[6]), started, name: path.basename(command.split(" ")[0].replace(/^-/, "")), command, kernel: /^\[.*\]$/.test(command), cwd: null, exe: null });
  }
  return rows;
}
async function psAll() {
  const r = await sh("ps", ["-axo", "pid=,ppid=,user=,state=,rss=,time=,lstart=,command="], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`ps: ${(r.err || r.out).trim().slice(0, 200)}`);
  return parsePs(r.out);
}
// Working folders through lsof, for the pids asked about: {pid: cwd}.
async function lsofCwds(pids) {
  if (!pids.length) return {};
  const r = await sh("lsof", ["-a", "-d", "cwd", "-p", pids.slice(0, 200).join(","), "-Fpn"]);
  const out = {};
  let pid = null;
  for (const l of r.out.split("\n")) {
    if (l[0] === "p") pid = Number(l.slice(1));
    else if (l[0] === "n" && pid != null) out[pid] = l.slice(1);
  }
  return out;
}

// ---- Windows: PowerShell ----
async function winAll() {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,WorkingSetSize,KernelModeTime,UserModeTime,@{n='Started';e={[int64](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds)}} | ConvertTo-Json -Compress";
  const r = await sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`powershell: ${(r.err || r.out).trim().slice(0, 200)}`);
  const rows = JSON.parse(r.out || "[]");
  return [].concat(rows).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, user: null, state: "R", rss: Number(p.WorkingSetSize ?? 0), cpuSeconds: (Number(p.KernelModeTime ?? 0) + Number(p.UserModeTime ?? 0)) / 1e7, started: Number(p.Started ?? 0), name: p.Name, command: p.CommandLine || p.Name, kernel: false, cwd: null, exe: p.ExecutablePath ?? null }));
}

// ---- listeners ----
const splitAddr = (a) => {
  const i = a.lastIndexOf(":");
  return { address: a.slice(0, i).replace(/^\[|\]$/g, "").replace(/%.*$/, "") || "*", port: Number(a.slice(i + 1)) };
};
async function listenersSs() {
  const r = await sh("ss", ["-H", "-ltnp"]);
  if (r.code !== 0) return null;
  const out = [];
  for (const l of r.out.split("\n")) {
    const c = l.trim().split(/\s+/);
    if (c.length < 4) continue;
    const { address, port } = splitAddr(c[3]);
    const pids = [...l.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    out.push({ proto: "tcp", address, port, pids });
  }
  return { by: "ss", rows: out };
}
async function listenersLsof() {
  const r = await sh("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
  if (r.code === 127) return null;
  const out = [];
  let pid = null;
  for (const l of r.out.split("\n")) {
    if (l[0] === "p") pid = Number(l.slice(1));
    else if (l[0] === "n" && pid != null) out.push({ proto: "tcp", ...splitAddr(l.slice(1)), pids: [pid] });
  }
  return { by: "lsof", rows: out };
}
// Without ss or lsof: listening sockets from /proc/net/tcp, matched to processes by socket inode.
export function listenersProc() {
  const socks = new Map(); // inode -> {address, port}
  for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]]) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const l of text.split("\n").slice(1)) {
      const c = l.trim().split(/\s+/);
      if (c[3] !== "0A") continue; // LISTEN
      const [hex, port] = c[1].split(":");
      const address = v6 ? (/^0+$/.test(hex) ? "*" : /^0+1000000$|^0{24}01000000$/.test(hex) ? "::1" : "ipv6") : hex.match(/../g).reverse().map((b) => parseInt(b, 16)).join(".");
      socks.set(c[9], { proto: "tcp", address: address === "0.0.0.0" ? "*" : address, port: parseInt(port, 16), pids: [] });
    }
  }
  let unreadable = 0;
  for (const d of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${d}/fd`);
    } catch {
      unreadable++;
      continue;
    }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${d}/fd/${fd}`));
        if (m && socks.has(m[1])) socks.get(m[1]).pids.push(Number(d));
      } catch {}
    }
  }
  return { by: "/proc", rows: [...socks.values()], ...(unreadable ? { note: `${unreadable} processes of other users could not be read; their ports show no process` } : {}) };
}
async function listenersWin() {
  const r = await sh("netstat", ["-ano", "-p", "TCP"]);
  if (r.code !== 0) return null;
  const out = [];
  for (const l of r.out.split("\n")) {
    const c = l.trim().split(/\s+/);
    if (c[0] === "TCP" && c[3] === "LISTENING") out.push({ proto: "tcp", ...splitAddr(c[1]), pids: [Number(c[4])] });
  }
  return { by: "netstat", rows: out };
}

export function make({ push = () => {}, act = false, settings = {} } = {}) {
  const forcePs = settings.PROCS_USE_PS === "1"; // tests: the ps path on Linux
  const note = (detail, started, size) => push({ kind: "procs", detail, ms: Date.now() - started, code: 0, size });

  // Every process, with the fields each platform can give. Command lines are redacted here, once.
  const all = async ({ cwd = false } = {}) => {
    const started = Date.now();
    let rows;
    let by;
    if (PLATFORM === "linux" && !forcePs) (rows = linuxAll()), (by = "/proc");
    else if (PLATFORM === "win32") (rows = await winAll()), (by = "powershell");
    else (rows = await psAll()), (by = "ps");
    if (cwd && by === "ps") {
      const mine = rows.filter((r) => !r.kernel).map((r) => r.pid);
      const cw = await lsofCwds(mine);
      for (const r of rows) r.cwd = cw[r.pid] ?? null;
    }
    const now = Date.now() / 1000;
    for (const r of rows) {
      r.command = redact(r.command).slice(0, 600);
      r.age = Math.max(0, now - r.started);
    }
    note(`list processes (${by})`, started, rows.length);
    return rows;
  };

  const view = (r) => ({ pid: r.pid, ppid: r.ppid, name: r.name, user: r.user, state: r.state, memory: human(r.rss), rssBytes: r.rss, cpuSeconds: Math.round(r.cpuSeconds * 10) / 10, started: new Date(r.started * 1000).toISOString(), age: age(r.age), ...(r.cwd ? { cwd: tilde(r.cwd) } : {}), command: r.command });

  const self = process.pid;
  const protectedPids = async () => {
    const rows = await all();
    const by = new Map(rows.map((r) => [r.pid, r]));
    const out = new Set([1, self]);
    for (let p = by.get(self)?.ppid; p && p > 1 && !out.has(p); p = by.get(p)?.ppid) out.add(p);
    return out;
  };

  const api = {
    /** The pids that are never stopped: this process, its parents (the agent that asked) and pid 1. */
    protected: async () => [...(await protectedPids())],

    /** Which platform reader is in use, and this process's own pid (the ask-kit server; its parents are the agent that asked). */
    info: () => ({ platform: PLATFORM, self, reader: PLATFORM === "linux" && !forcePs ? "/proc" : PLATFORM === "win32" ? "powershell" : "ps" }),

    /**
     * Processes, kernel threads left out. o.match: words that must all be in the name, command or folder (any case), or a /regex/;
     * o.user; o.sort: "memory" (default), "cpu" (CPU time used so far), "age" (oldest first) or "new"; o.limit default 30.
     * Each: {pid, ppid, name, user, state, memory, rssBytes, cpuSeconds, started, age, cwd?, command}. Command lines have credentials redacted.
     */
    async list(o = {}) {
      const rows = (await all({ cwd: true })).filter((r) => !r.kernel);
      const rx = o.match && /^\/(.+)\/([a-z]*)$/.exec(String(o.match));
      const words = o.match && !rx ? String(o.match).toLowerCase().split(/\s+/).filter(Boolean) : [];
      const hay = (r) => `${r.name} ${r.command} ${r.cwd ?? ""}`;
      let kept = rows.filter((r) => (!o.user || r.user === o.user) && (rx ? new RegExp(rx[1], "i").test(hay(r)) : words.every((w) => hay(r).toLowerCase().includes(w))));
      const key = { memory: (r) => -r.rss, cpu: (r) => -r.cpuSeconds, age: (r) => r.started, new: (r) => -r.started }[o.sort ?? "memory"] ?? ((r) => -r.rss);
      kept = kept.sort((a, b) => key(a) - key(b));
      const limit = o.limit ?? 30;
      return { total: kept.length, processes: kept.slice(0, limit).map(view), ...(kept.length > limit ? { leftOut: kept.length - limit } : {}) };
    },

    /** One process by pid ("self" is this one): its row, or null when no such process. */
    async get(pid) {
      const want = pid === "self" ? self : Number(pid);
      const r = (await all({ cwd: true })).find((x) => x.pid === want);
      return r ? view(r) : null;
    },

    /** A process's parents (nearest first, up to pid 1) and its children, as rows: {process, parents:[...], children:[...]}. */
    async tree(pid) {
      const want = pid === "self" ? self : Number(pid);
      const rows = await all({ cwd: true });
      const by = new Map(rows.map((r) => [r.pid, r]));
      const me = by.get(want);
      if (!me) return { process: null, parents: [], children: [] };
      const parents = [];
      for (let p = by.get(me.ppid); p && parents.length < 20; p = by.get(p.ppid)) parents.push(view(p));
      const kids = [];
      const walk = (id, depth) => {
        for (const r of rows.filter((x) => x.ppid === id && x.pid !== id)) {
          kids.push({ depth, ...view(r) });
          if (kids.length < 200) walk(r.pid, depth + 1);
        }
      };
      walk(want, 1);
      return { process: view(me), parents, children: kids.slice(0, 60), ...(kids.length > 60 ? { childrenLeftOut: kids.length - 60 } : {}) };
    },

    /**
     * TCP listeners with the process that holds each: [{port, address, proto, pid, name, command, cwd?, age}]. o.port keeps one port.
     * `by` says what found them (ss, lsof, /proc or netstat); `note` says when processes of other users could not be read.
     */
    async ports(o = {}) {
      const started = Date.now();
      const found = PLATFORM === "win32" ? await listenersWin() : (await listenersSs()) ?? (await listenersLsof()) ?? (PLATFORM === "linux" ? listenersProc() : null);
      if (!found) return { by: null, listeners: [], note: "no way to list listeners here: ss, lsof and netstat are all missing" };
      const rows = await all({ cwd: true });
      const by = new Map(rows.map((r) => [r.pid, r]));
      const seen = new Set();
      const out = [];
      for (const l of found.rows) {
        if (o.port != null && l.port !== Number(o.port)) continue;
        for (const pid of l.pids.length ? l.pids : [null]) {
          const k = `${l.port}|${l.address}|${pid}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const p = pid == null ? null : by.get(pid);
          out.push({ port: l.port, address: l.address, proto: l.proto, pid, ...(p ? { name: p.name, user: p.user, age: age(p.age), ...(p.cwd ? { cwd: tilde(p.cwd) } : {}), command: p.command } : { name: null, note: "the process could not be read (another user's, or it ended)" }) });
        }
      }
      note(`list listeners (${found.by})`, started, out.length);
      return { by: found.by, listeners: out.sort((a, b) => a.port - b.port), ...(found.note ? { note: found.note } : {}) };
    },

    /**
     * What is using the CPU now: two readings `seconds` apart (default 1), so the share is of this moment, not of the
     * process's whole life. {seconds, cores, processes:[{pid, name, cpuPercent (100 = one core), memory, command, cwd?}]}.
     */
    async busy(o = {}) {
      const seconds = Math.min(Math.max(Number(o.seconds ?? 1), 0.2), 10);
      const a = await all();
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const b = await all({ cwd: true });
      const before = new Map(a.map((r) => [r.pid, r]));
      const rows = b
        .filter((r) => !r.kernel && before.has(r.pid) && before.get(r.pid).started === r.started)
        .map((r) => ({ r, pct: ((r.cpuSeconds - before.get(r.pid).cpuSeconds) / seconds) * 100 }))
        .filter((x) => x.pct >= (o.min ?? 0.5))
        .sort((x, y) => y.pct - x.pct)
        .slice(0, o.limit ?? 10);
      return { seconds, cores: os.cpus().length, load: os.loadavg().map((n) => Math.round(n * 100) / 100), processes: rows.map(({ r, pct }) => ({ pid: r.pid, name: r.name, cpuPercent: Math.round(pct), memory: human(r.rss), age: age(r.age), ...(r.cwd ? { cwd: tilde(r.cwd) } : {}), command: r.command.slice(0, 200) })) };
    },

    /** Memory of the machine: {total, free, used, usedPercent} in bytes and text. */
    memory() {
      const total = os.totalmem();
      let free = os.freemem();
      try {
        const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
        if (m) free = Number(m[1]) * 1024; // what can be given to a program, caches included
      } catch {}
      return { total: human(total), available: human(free), used: human(total - free), usedPercent: Math.round(((total - free) / total) * 100) };
    },
  };

  /**
   * Stop a process: SIGTERM, then SIGKILL after o.wait seconds (default 5) when it is still there and o.force is not false.
   * o.tree also stops its children, children first. Refused for this process, its parents (the agent that asked) and pid 1.
   * Returns {pid, name, stopped, signal, waited, children?}. Only when the caller asked for a change (act: true).
   */
  api.kill = async (pid, o = {}) => {
    if (!act) throw new Error("not in this ask: procs.kill stops a process, which changes things, and the caller did not ask for a change (act: true)");
    const want = Number(pid);
    if (!Number.isInteger(want) || want <= 0) throw new Error("kill needs a pid");
    const guard = await protectedPids();
    if (guard.has(want)) throw new Error(`not allowed: pid ${want} is ${want === 1 ? "the init process" : want === self ? "the process answering this question" : "a parent of the process answering this question (the agent that asked)"}; stopping it would end the session`);
    const rows = await all();
    const me = rows.find((r) => r.pid === want);
    if (!me) return { pid: want, stopped: false, note: "no such process (it may have ended already)" };
    const targets = [];
    if (o.tree) {
      const walk = (id) => {
        for (const r of rows.filter((x) => x.ppid === id && x.pid !== id)) (walk(r.pid), targets.push(r));
      };
      walk(want);
    }
    targets.push(me);
    // A zombie (ended, not yet collected by its parent) still answers signal 0: it counts as stopped.
    const alive = (p) => {
      try {
        process.kill(p, 0);
      } catch (e) {
        return e.code === "EPERM";
      }
      if (PLATFORM !== "linux") return true;
      try {
        const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
      } catch {
        return false;
      }
    };
    const started = Date.now();
    const sent = [];
    for (const t of targets) {
      if (guard.has(t.pid)) continue;
      try {
        process.kill(t.pid, o.signal ?? "SIGTERM");
        sent.push(t.pid);
      } catch (e) {
        if (t.pid === want) return { pid: want, name: me.name, stopped: false, error: e.code === "EPERM" ? "not permitted: the process belongs to another user" : e.message };
      }
    }
    const wait = Math.min(Math.max(Number(o.wait ?? 5), 0), 30) * 1000;
    while (Date.now() - started < wait && sent.some(alive)) await new Promise((r) => setTimeout(r, 100));
    let signal = o.signal ?? "SIGTERM";
    if (sent.some(alive) && o.force !== false && signal !== "SIGKILL") {
      for (const p of sent.filter(alive)) {
        try {
          process.kill(p, "SIGKILL");
        } catch {}
      }
      signal = "SIGTERM, then SIGKILL";
      await new Promise((r) => setTimeout(r, 300));
    }
    push({ kind: "procs", detail: `kill ${want} (${me.name})${o.tree ? " and its children" : ""}`, ms: Date.now() - started, code: 0, size: sent.length });
    return { pid: want, name: me.name, command: me.command.slice(0, 200), stopped: !alive(want), signal, waited: `${Math.round((Date.now() - started) / 100) / 10}s`, ...(o.tree ? { children: sent.filter((p) => p !== want).length } : {}) };
  };
  return api;
}
