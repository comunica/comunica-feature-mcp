/* eslint-disable import/no-nodejs-modules,unicorn/no-process-exit */
import type { Cluster, Worker } from 'node:cluster';
import type { Writable } from 'node:stream';

// The cluster module only has a default export, which can not be imported
// as such within this CommonJS package, so it is required instead.
// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires
const nodeCluster: Cluster = require('node:cluster');

/**
 * The message workers periodically send to the primary process to indicate that their event loop is responsive.
 */
export const MESSAGE_HEARTBEAT = 'comunica-mcp:heartbeat';

/**
 * The message workers send to the primary process to ask to be replaced by a fresh worker.
 */
export const MESSAGE_RECYCLE = 'comunica-mcp:recycle';

/**
 * The interval in milliseconds at which workers send a heartbeat to the primary process.
 */
export const HEARTBEAT_INTERVAL = 1_000;

/**
 * The lower bound in milliseconds on the time a worker may block its event loop before it is considered stuck.
 * Workers are never killed faster than this, so that slow startups are not mistaken for hangs.
 */
export const MIN_UNRESPONSIVE_TIMEOUT = 30_000;

export interface IWorkerPoolArgs {
  /**
   * The number of workers that must be kept alive at all times.
   */
  workers: number;
  /**
   * The time in milliseconds a worker may block its event loop before it is killed and restarted.
   * A value of 0 disables this watchdog.
   */
  unresponsiveTimeout: number;
  /**
   * The stream to write log messages to.
   */
  stderr: Writable;
  /**
   * The cluster instance to manage workers with. Defaults to the Node.js cluster module.
   */
  cluster?: Cluster;
  /**
   * The interval in milliseconds at which worker liveness is checked. Defaults to {@link HEARTBEAT_INTERVAL}.
   */
  checkInterval?: number;
  /**
   * The time in milliseconds a worker must stay alive before its startup is considered successful.
   */
  healthyUptime?: number;
  /**
   * The number of consecutive failed startups after which the primary process gives up.
   */
  maxRapidRestarts?: number;
  /**
   * The time in milliseconds workers are given to shut down gracefully before they are killed.
   */
  shutdownGrace?: number;
  /**
   * Invoked when the primary process must terminate with the given exit code.
   */
  exit?: (code: number) => void;
}

/**
 * The state that the primary process keeps for each of its workers.
 */
interface IWorkerState {
  /**
   * The time at which the worker was forked.
   */
  startedAt: number;
  /**
   * The last time at which the worker was known to be responsive.
   */
  lastSeen: number;
  /**
   * If a replacement for this worker was already forked, so that its exit must not trigger another fork.
   */
  replaced: boolean;
  /**
   * If this worker was terminated on purpose.
   */
  terminated: boolean;
}

/**
 * Maintains a pool of worker processes that each run an MCP server, and replaces them when needed.
 *
 * Workers are needed because SPARQL queries can not always be cancelled from within the process that runs them:
 * * Queries that block the event loop make any timeout inside that worker unable to fire in the first place.
 *   Such workers stop sending {@link MESSAGE_HEARTBEAT} messages, upon which they are killed and replaced.
 * * Queries that did time out keep consuming CPU and memory in the background, as Comunica offers no way to
 *   abort an ongoing query. Workers therefore ask to be replaced via {@link MESSAGE_RECYCLE} after a timeout,
 *   which lets them finish their pending responses while a fresh worker takes over.
 */
export class WorkerPool {
  private readonly workers: number;
  private readonly unresponsiveTimeout: number;
  private readonly stderr: Writable;
  private readonly cluster: Cluster;
  private readonly checkInterval: number;
  private readonly healthyUptime: number;
  private readonly maxRapidRestarts: number;
  private readonly shutdownGrace: number;
  private readonly exit: (code: number) => void;

  private readonly states: Record<number, IWorkerState> = {};
  private rapidRestarts = 0;
  private checkTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  public constructor(args: IWorkerPoolArgs) {
    this.workers = args.workers;
    this.unresponsiveTimeout = args.unresponsiveTimeout;
    this.stderr = args.stderr;
    this.cluster = args.cluster ?? nodeCluster;
    this.checkInterval = args.checkInterval ?? HEARTBEAT_INTERVAL;
    this.healthyUptime = args.healthyUptime ?? 5_000;
    this.maxRapidRestarts = args.maxRapidRestarts ?? 5;
    this.shutdownGrace = args.shutdownGrace ?? 10_000;
    this.exit = args.exit ?? (code => process.exit(code));
  }

  /**
   * Fork the configured number of workers, and start monitoring them.
   */
  public start(): void {
    this.stderr.write(`Primary ${process.pid} started, spawning ${this.workers} worker(s)\n`);

    this.cluster.on('exit', (worker, code, signal) => this.onWorkerExit(worker, code, signal));
    this.cluster.on('message', (worker, message) => this.onWorkerMessage(worker, message));

    for (let i = 0; i < this.workers; i++) {
      this.fork();
    }

    if (this.unresponsiveTimeout > 0) {
      this.checkTimer = setInterval(() => this.checkWorkers(), this.checkInterval);
    }
  }

  /**
   * Terminate all workers, and exit as soon as they are all gone.
   * @param signal The signal to send to the workers.
   */
  public stop(signal: NodeJS.Signals): void {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    clearInterval(this.checkTimer);

    const workers = this.getWorkers();
    for (const worker of workers) {
      worker.process.kill(signal);
    }
    if (workers.length === 0) {
      this.exit(0);
      return;
    }

    // Make sure we never hang on workers that refuse to shut down
    this.killLater(workers, () => this.exit(0));
  }

  /**
   * Get all workers that are currently registered within the cluster.
   */
  protected getWorkers(): Worker[] {
    const workers: Worker[] = [];
    for (const worker of Object.values(this.cluster.workers ?? {})) {
      if (worker) {
        workers.push(worker);
      }
    }
    return workers;
  }

  /**
   * Start a new worker process.
   */
  protected fork(): void {
    const worker = this.cluster.fork();
    const now = Date.now();
    this.states[worker.id] = { startedAt: now, lastSeen: now, replaced: false, terminated: false };
  }

  /**
   * Handle a message that was sent by a worker.
   * @param worker The worker that sent the message.
   * @param message The message that was sent.
   */
  protected onWorkerMessage(worker: Worker, message: unknown): void {
    const state = this.states[worker.id];
    if (!state) {
      return;
    }
    if (message === MESSAGE_HEARTBEAT) {
      state.lastSeen = Date.now();
    } else if (message === MESSAGE_RECYCLE) {
      this.recycleWorker(worker);
    }
  }

  /**
   * Replace a worker by a fresh one, and let the old worker finish its pending responses in the meantime.
   * @param worker The worker to replace.
   */
  protected recycleWorker(worker: Worker): void {
    const state = this.states[worker.id];
    if (state.replaced || this.shuttingDown) {
      return;
    }
    this.stderr.write(`Worker ${worker.process.pid} requested to be replaced. Spawning a fresh worker...\n`);

    // Fork the replacement before stopping the old worker, so that requests keep being handled
    state.replaced = true;
    state.terminated = true;
    this.fork();

    // Stop the old worker from accepting new connections, and kill it once its pending responses were sent.
    // Disconnected workers are removed from the cluster, so they must be killed by reference.
    worker.disconnect();
    this.killLater([ worker ]);
  }

  /**
   * Restart a worker that died, unless workers keep dying immediately after startup.
   * @param worker The worker that died.
   * @param code The exit code of the worker.
   * @param signal The signal that terminated the worker.
   */
  protected onWorkerExit(worker: Worker, code: number, signal: string | null): void {
    const state = this.states[worker.id];
    delete this.states[worker.id];

    if (this.shuttingDown) {
      if (this.getWorkers().length === 0) {
        this.exit(0);
      }
      return;
    }

    // A replacement for this worker was already forked
    if (state?.replaced) {
      this.stderr.write(`Replaced worker ${worker.process.pid} exited (${signal ?? code})\n`);
      return;
    }

    // Workers that die before they could ever become healthy indicate a startup failure,
    // such as a port that is already in use, in which case restarting in a loop is pointless.
    if (state && !state.terminated && Date.now() - state.startedAt < this.healthyUptime) {
      this.rapidRestarts++;
      if (this.rapidRestarts >= this.maxRapidRestarts) {
        this.stderr.write(`Worker ${worker.process.pid} died (${signal ?? code}) during startup, ${this.rapidRestarts} times in a row. Giving up.\n`);
        this.shuttingDown = true;
        clearInterval(this.checkTimer);
        this.exit(1);
        return;
      }
    } else {
      this.rapidRestarts = 0;
    }

    this.stderr.write(`Worker ${worker.process.pid} died (${signal ?? code}). Restarting...\n`);
    this.fork();
  }

  /**
   * Kill all workers of which the event loop has been blocked for too long.
   */
  protected checkWorkers(): void {
    const now = Date.now();
    for (const worker of this.getWorkers()) {
      const state = this.states[worker.id];
      if (state && !state.terminated && now - state.lastSeen > this.unresponsiveTimeout) {
        this.stderr.write(`Worker ${worker.process.pid} was unresponsive for more than ${this.unresponsiveTimeout}ms. Killing it...\n`);
        state.terminated = true;
        worker.process.kill('SIGKILL');
      }
    }
  }

  /**
   * Forcefully kill the given workers if they are still alive after the shutdown grace period.
   * @param workers The workers to kill.
   * @param callback An optional callback to invoke afterwards.
   */
  protected killLater(workers: Worker[], callback?: () => void): void {
    setTimeout(() => {
      for (const worker of workers) {
        worker.process.kill('SIGKILL');
      }
      callback?.();
    }, this.shutdownGrace).unref();
  }
}

/**
 * Periodically inform the primary process that the event loop of this worker is not blocked.
 * This is a no-op when the current process is not a cluster worker.
 * @param interval The interval in milliseconds at which heartbeats are sent.
 * @returns The heartbeat timer, or undefined if the current process is not a cluster worker.
 */
export function startHeartbeat(interval = HEARTBEAT_INTERVAL): NodeJS.Timeout | undefined {
  if (!process.send) {
    return;
  }
  const timer = setInterval(() => sendToPrimary(MESSAGE_HEARTBEAT), interval);
  // The heartbeat must never keep the worker process alive by itself
  timer.unref();
  return timer;
}

/**
 * Ask the primary process to replace this worker by a fresh one.
 * This is a no-op when the current process is not a cluster worker.
 * @returns If the request was sent.
 */
export function requestRecycle(): boolean {
  return sendToPrimary(MESSAGE_RECYCLE);
}

/**
 * Send a message to the primary process, if this process is a cluster worker that is still connected to it.
 *
 * Workers stay alive for a while after being disconnected, so that they can finish their pending responses.
 * Any message sent during that period would make the worker crash on an unhandled error event,
 * which is why the connection is checked, and remaining errors are swallowed by passing a callback.
 * @param message The message to send.
 * @returns If the message was sent.
 */
function sendToPrimary(message: string): boolean {
  if (!process.send || !process.connected) {
    return false;
  }
  return process.send(message, undefined, undefined, () => {
    // Ignore errors that occur when the IPC channel closes while sending
  });
}
