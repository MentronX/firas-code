// Background shell jobs started by Bash with run_in_background, read by BashOutput, stopped by KillShell.
import { startProcess, RingBuffer } from "./runner.js";

export function createJobs({ platform = process.platform, maxRunning = 8 } = {}) {
  const table = new Map();
  let seq = 0;

  const running = () => [...table.values()].filter(job => job.status === "running");

  return {
    /** Starts a job. Returns the job, or { error } when too many are already running. */
    start({ info, command, cwd, env }) {
      if (running().length >= maxRunning) return { error: `Too many background jobs are running (${maxRunning}). Stop one with KillShell first.` };
      const id = `bg${++seq}`;
      const ring = new RingBuffer();
      const controller = new AbortController();
      const proc = startProcess({ info, command, cwd, env, signal: controller.signal, onChunk: text => ring.push(text), platform, track: true });
      const job = { id, command, pid: proc.pid, status: "running", code: null, signal: null, error: null, startedAt: Date.now(), endedAt: null, ring, controller, killedByUser: false };
      job.finished = proc.done.then(result => {
        job.status = job.killedByUser ? "killed" : result.error ? "failed" : "exited";
        job.code = result.code;
        job.signal = result.signal;
        job.error = result.error ? String(result.error.message || result.error) : null;
        job.endedAt = Date.now();
      });
      table.set(id, job);
      return job;
    },

    get: id => table.get(String(id ?? "").trim()),

    list: () => [...table.values()],

    runningCount: () => running().length,

    /** Stops a job and everything it started; resolves when it is gone (or after a short wait). */
    async kill(id) {
      const job = table.get(String(id ?? "").trim());
      if (!job) return null;
      if (job.status === "running") {
        job.killedByUser = true;
        job.controller.abort();
        await Promise.race([job.finished, new Promise(resolve => setTimeout(resolve, 4000))]);
      }
      return job;
    },

    async killAll() {
      await Promise.all(running().map(job => this.kill(job.id)));
    },
  };
}
