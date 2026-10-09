import { spawn } from 'node:child_process';
import { startJob } from './jobs.js';

export const OUTPUT_CAP = 64_000; // chars captured per stream
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;

/**
 * Run a shell command inside the workspace.
 * - runs through `bash -c` in the workspace directory
 * - killed (whole process group) on timeout or when ctx.signal aborts
 * - returns exit code, stdout, stderr; huge output is truncated
 * - `background: true` → start a job that keeps running; returns its job id
 */
export function runShell({ workspace, signal }, args = {}) {
  return new Promise((resolve) => {
    if (typeof args.command !== 'string' || args.command.length === 0) {
      resolve({ ok: false, content: 'Error: command must be a non-empty string.' });
      return;
    }
    if (args.background === true) {
      const r = startJob({ workspace, command: args.command });
      if (!r.ok) {
        resolve(r);
        return;
      }
      resolve({
        ok: true,
        content: `Started background job ${r.id} (pid ${r.pid}). It keeps running after this turn. Read output later with shell_jobs { job_id: "${r.id}" }, stop it with kill_shell { job_id: "${r.id}" }.`,
        jobId: r.id,
      });
      return;
    }
    const timeout = Math.min(Math.max(Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    let child;
    try {
      child = spawn('/bin/bash', ['-c', args.command], {
        cwd: workspace,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORGE: '1' },
      });
    } catch (err) {
      resolve({ ok: false, content: `Error: failed to start command: ${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (chunk, current, cap) => {
      const s = chunk.toString('utf8');
      if (current.length >= cap) return { text: current, trunc: true };
      const room = cap - current.length;
      return { text: current + s.slice(0, room), trunc: s.length > room };
    };

    child.stdout.on('data', (d) => {
      const r = append(d, stdout, OUTPUT_CAP);
      stdout = r.text;
      outTrunc ||= r.trunc;
    });
    child.stderr.on('data', (d) => {
      const r = append(d, stderr, OUTPUT_CAP);
      stderr = r.text;
      errTrunc ||= r.trunc;
    });

    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeout);

    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, content: `Error: ${err.message}` });
    });

    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const head = [
        `exit code: ${code}`,
        sig ? `signal: ${sig}` : null,
        timedOut ? `TIMED OUT after ${timeout}ms (process tree killed)` : null,
        aborted ? 'STOPPED by user' : null,
      ]
        .filter(Boolean)
        .join('\n');
      const body = [
        `--- stdout${outTrunc ? ` (truncated at ${OUTPUT_CAP} chars)` : ''} ---`,
        stdout,
        `--- stderr${errTrunc ? ` (truncated at ${OUTPUT_CAP} chars)` : ''} ---`,
        stderr,
      ].join('\n');
      resolve({
        ok: !timedOut && !aborted && code === 0,
        content: `${head}\n${body}`,
        exitCode: code,
        timedOut,
        aborted,
      });
    });
  });
}
