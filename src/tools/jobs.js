import { spawn } from 'node:child_process';

/**
 * Background shell jobs: long-running commands (dev servers, watchers) that
 * keep running after the tool call returns. Output is kept in a capped ring
 * (newest survives) so `shell_jobs` can read it later.
 */

export const LOG_CAP = 100_000; // chars of retained output per job
export const MAX_JOBS = 20;

const jobs = new Map();
let seq = 0;

function trimLog(job) {
  if (job.log.length > LOG_CAP) {
    const dropped = job.log.length - LOG_CAP;
    job.log = job.log.slice(dropped);
    job.logBase += dropped;
  }
}

function killGroup(job, signal) {
  try {
    process.kill(-job.child.pid, signal);
    return true;
  } catch {
    try {
      job.child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** Start a background job; resolves immediately with { id, pid }. */
export function startJob({ workspace, command }) {
  if (jobs.size >= MAX_JOBS) {
    return { ok: false, content: `Error: ${MAX_JOBS} background jobs already running; stop one with kill_shell first.` };
  }
  let child;
  try {
    child = spawn('/bin/bash', ['-c', command], {
      cwd: workspace,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORGE: '1', FORGE_BG: '1' },
    });
  } catch (err) {
    return { ok: false, content: `Error: failed to start background command: ${err.message}` };
  }
  const id = `bg${++seq}`;
  const job = {
    id,
    command,
    child,
    status: 'running', // running | exited | killed | error
    exitCode: null,
    exitSignal: null,
    startedAt: Date.now(),
    endedAt: null,
    log: '',
    logBase: 0,
    total: 0,
    read: 0,
    errMsg: null,
  };
  child.stdout.on('data', (d) => {
    job.log += d.toString('utf8');
    job.total += d.length;
    trimLog(job);
  });
  child.stderr.on('data', (d) => {
    job.log += d.toString('utf8');
    job.total += d.length;
    trimLog(job);
  });
  child.on('error', (err) => {
    job.status = 'error';
    job.errMsg = err.message;
    job.endedAt = Date.now();
  });
  child.on('close', (code, sig) => {
    job.exitCode = code;
    job.exitSignal = sig;
    if (job.status === 'running') job.status = sig && job.killRequested ? 'killed' : 'exited';
    job.endedAt = Date.now();
  });
  jobs.set(id, job);
  return { ok: true, id, pid: child.pid };
}

/** Consume output appended since the previous read for one job. */
function newOutput(job) {
  const from = Math.max(job.read, job.logBase);
  const text = job.log.slice(from - job.logBase);
  job.read = job.total;
  return text;
}

function jobSummary(job, { withOutput = false } = {}) {
  const dur = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  const lines = [
    `${job.id}  ${job.status}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ''}${job.exitSignal ? ` signal ${job.exitSignal}` : ''}  ${dur}s  $ ${job.command}`,
  ];
  if (job.errMsg) lines.push(`  spawn error: ${job.errMsg}`);
  if (withOutput) {
    const out = newOutput(job);
    if (out.trim()) lines.push(out.replace(/\n$/, ''));
    else lines.push('(no new output)');
    if (job.logBase > 0) lines.push(`[older output trimmed; kept last ${job.log.length} chars]`);
  } else {
    lines.push(`  ${Math.max(0, job.total - job.read)} chars of new output; call with this job_id to read it`);
  }
  return lines.join('\n');
}

/** shell_jobs tool: list all jobs, or details + new output for one job. */
export function shellJobs({ workspace }, args = {}) {
  if (jobs.size === 0) return { ok: true, content: 'No background jobs. Start one with run_shell { background: true }.' };
  if (args.job_id) {
    const job = jobs.get(String(args.job_id));
    if (!job) {
      const known = [...jobs.keys()].join(', ') || 'none';
      return { ok: false, content: `Error: no such job "${args.job_id}". Known jobs: ${known}.` };
    }
    return { ok: true, content: jobSummary(job, { withOutput: true }) };
  }
  const list = [...jobs.values()].map((j) => jobSummary(j));
  return { ok: true, content: list.join('\n') };
}

/** kill_shell tool: SIGTERM the whole process group, SIGKILL after a grace period. */
export async function killShell({ workspace }, args = {}) {
  const id = String(args.job_id ?? '');
  const job = jobs.get(id);
  if (!job) {
    const known = [...jobs.keys()].join(', ') || 'none';
    return { ok: false, content: `Error: no such job "${id}". Known jobs: ${known}.` };
  }
  if (job.status !== 'running') {
    return { ok: true, content: `Job ${id} already ${job.status}; nothing to kill.` };
  }
  job.killRequested = true;
  killGroup(job, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (job.status === 'running') {
    killGroup(job, 'SIGKILL');
    const hard = Date.now() + 2000;
    while (job.status === 'running' && Date.now() < hard) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const out = newOutput(job);
  return {
    ok: true,
    content: `Killed job ${id} ($ ${job.command}) — status: ${job.status}${job.exitSignal ? ` (${job.exitSignal})` : ''}.${out.trim() ? `\nFinal output:\n${out.replace(/\n$/, '')}` : ''}`,
  };
}

/** Kill every background job (server shutdown). */
export function killAllJobs() {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.killRequested = true;
      killGroup(job, 'SIGKILL');
    }
  }
}

/** Test helper: forget all jobs (processes already reaped by killAllJobs). */
export function clearJobs() {
  jobs.clear();
}

export function jobCount() {
  return jobs.size;
}
