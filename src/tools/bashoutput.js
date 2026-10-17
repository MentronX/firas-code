// BashOutput and KillShell: read from and stop the background jobs started by Bash.
import { t } from "../i18n/index.js";
import { ok, fail, headTail, CHAR_CAP } from "./common.js";
import { cleanOutput } from "./runner.js";

const idOf = input => String(input?.job_id ?? input?.bash_id ?? input?.shell_id ?? "").trim();

function statusLine(job) {
  const secs = (((job.endedAt || Date.now()) - job.startedAt) / 1000).toFixed(1);
  switch (job.status) {
    case "running": return `running for ${secs} s`;
    case "killed": return `stopped by request after ${secs} s`;
    case "failed": return `failed to run: ${job.error || "unknown error"}`;
    default: return job.code === null && job.signal ? `ended by signal ${job.signal} after ${secs} s` : `finished with exit code ${job.code} after ${secs} s`;
  }
}

function unreadOutput(job) {
  const { text, dropped } = job.ring.readNew();
  const body = cleanOutput(text).replace(/\s+$/, "");
  const lost = dropped ? `[${dropped} characters of older output were discarded]\n` : "";
  return body ? lost + headTail(body, CHAR_CAP) : lost + "(no new output)";
}

const idSchema = {
  type: "object",
  properties: { job_id: { type: "string", description: "The job id returned by Bash with run_in_background, for example \"bg1\"." } },
  required: ["job_id"],
  additionalProperties: false,
};

export function createBashOutputTool({ jobs }) {
  return {
    name: "BashOutput",
    description: "Returns the output a background job (started with Bash and run_in_background) has produced since you last asked, plus whether it is still running or how it ended. Call it again later for more. Do not use it for commands that were not started in the background.",
    input_schema: idSchema,
    readOnly: true,
    concurrencySafe: true,
    summarize(input) { return idOf(input); },
    validate(input) { return idOf(input) ? null : "job_id is required."; },
    permission() { return { decision: "allow", risk: "low", category: "read", title: t("tools.perm.jobRead") }; },
    async run(input) {
      const job = jobs.get(idOf(input));
      if (!job) {
        const known = jobs.list().map(j => j.id).join(", ");
        return fail("noJob", `No background job named "${idOf(input)}".${known ? ` Known jobs: ${known}.` : " No job has been started."}`, { id: idOf(input) });
      }
      const output = unreadOutput(job);
      return ok(`[job ${job.id}: ${statusLine(job)}]\n${output}`, { summary: t(`tools.job.${job.status}`, { id: job.id }), body: output });
    },
  };
}

export function createKillShellTool({ jobs }) {
  return {
    name: "KillShell",
    description: "Stops a background job started with Bash and run_in_background, together with every process it started, and returns the output it had not yet delivered. Use it to end servers and watchers when they are no longer needed. Do not use it on a job you still depend on.",
    input_schema: idSchema,
    readOnly: false,
    concurrencySafe: false,
    summarize(input) { return idOf(input); },
    validate(input) { return idOf(input) ? null : "job_id is required."; },
    permission() { return { decision: "allow", risk: "low", category: "exec", title: t("tools.perm.jobKill") }; },
    async run(input) {
      const wasRunning = jobs.get(idOf(input))?.status === "running";
      const job = await jobs.kill(idOf(input));
      if (!job) return fail("noJob", `No background job named "${idOf(input)}".`, { id: idOf(input) });
      const output = unreadOutput(job);
      return ok(`[job ${job.id}: ${wasRunning ? "stopped" : statusLine(job)}]\n${output}`, { summary: t("tools.job.killed", { id: job.id }) });
    },
  };
}
