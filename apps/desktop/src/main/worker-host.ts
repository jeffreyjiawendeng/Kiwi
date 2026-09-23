import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { Logger } from "@kiwi/diagnostics";
import {
  DEFAULT_POLICY,
  decideRestart,
  pruneCrashTimes,
  type SupervisedState,
  type SupervisorPolicy,
} from "./supervisor.js";

export interface WorkerHost {
  start(): void;
  stop(): Promise<void>;
  state(): SupervisedState;
  restartCount(): number;
}

export interface WorkerHostOptions {
  entry: string;
  logger: Logger;
  policy?: SupervisorPolicy;
  env?: NodeJS.ProcessEnv;
}

/**
 * Supervises the utility worker. A worker crash is contained here: it never propagates
 * to the main process or the renderer, and canonical state is untouched because the
 * worker holds none.
 */
export function createWorkerHost(options: WorkerHostOptions): WorkerHost {
  const policy = options.policy ?? DEFAULT_POLICY;
  const { logger, entry } = options;

  let worker: Worker | null = null;
  let state: SupervisedState = "stopped";
  let crashTimes: number[] = [];
  let restarts = 0;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;

  function spawn(): void {
    state = "starting";
    const child = new Worker(entry, { env: options.env ?? process.env });
    worker = child;

    child.on("online", () => {
      state = "running";
      logger.info("worker.started", { restarts });
    });

    child.on("error", (error) => {
      logger.error("worker.error", { cause_name: error.name });
    });

    child.on("exit", (code) => {
      worker = null;
      if (stopping) {
        state = "stopped";
        return;
      }
      if (code === 0) {
        state = "stopped";
        logger.info("worker.exited", { exit_code: code });
        return;
      }

      const now = Date.now();
      crashTimes = [...pruneCrashTimes(crashTimes, now, policy), now];
      const decision = decideRestart(crashTimes, now, policy);

      logger.warn("worker.crashed", {
        exit_code: code,
        recent_crashes: crashTimes.length,
        will_restart: decision.restart,
      });

      if (!decision.restart) {
        state = "failed";
        logger.error("worker.given_up", { reason: decision.reason });
        return;
      }

      state = "restarting";
      restarts += 1;
      timer = setTimeout(spawn, decision.delayMs);
    });
  }

  return {
    start() {
      if (worker !== null) return;
      stopping = false;
      spawn();
    },

    async stop() {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const child = worker;
      worker = null;
      state = "stopped";
      if (child !== null) await child.terminate();
    },

    state() {
      return state;
    },

    restartCount() {
      return restarts;
    },
  };
}

export function workerEntry(distRoot: string): string {
  return join(distRoot, "worker-bootstrap", "index.js");
}
