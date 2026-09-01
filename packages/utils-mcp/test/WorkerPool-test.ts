import type { Worker } from 'node:cluster';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import {
  CPU_SAMPLE_WINDOW,
  exitOnDisconnect,
  HEARTBEAT_INTERVAL,
  MESSAGE_HEARTBEAT,
  MESSAGE_RECYCLE,
  requestRecycle,
  requestRecycleIfRunaway,
  startHeartbeat,
  WorkerPool,
} from '../lib/WorkerPool';

class FakeWorker extends EventEmitter {
  public readonly process = { pid: 0, kill: jest.fn() };
  public readonly disconnect = jest.fn();

  public constructor(public readonly id: number) {
    super();
    this.process.pid = 1_000 + id;
  }
}

class FakeCluster extends EventEmitter {
  public workers: Record<number, Worker | undefined> | undefined = {};
  public forked: FakeWorker[] = [];
  private nextId = 1;

  public fork(): Worker {
    const worker = new FakeWorker(this.nextId++);
    this.forked.push(worker);
    this.workers![worker.id] = <any> worker;
    return <any> worker;
  }

  public exitWorker(worker: FakeWorker, code = 0, signal: string | null = null): void {
    // Node removes workers from the cluster before emitting their exit
    delete this.workers![worker.id];
    this.emit('exit', worker, code, signal);
  }

  public disconnectWorker(worker: FakeWorker): void {
    // Node removes disconnected workers from the cluster
    delete this.workers![worker.id];
  }
}

describe('WorkerPool', () => {
  let cluster: FakeCluster;
  let stderr: Writable;
  let stderrWrites: string[];
  let exit: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    cluster = new FakeCluster();
    stderrWrites = [];
    stderr = new Writable({
      write(chunk: any, encoding: any, callback: any) {
        stderrWrites.push(chunk.toString());
        callback();
      },
    });
    exit = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createPool(args: Record<string, any> = {}): WorkerPool {
    return new WorkerPool(<any> {
      workers: 1,
      unresponsiveTimeout: 30_000,
      stderr,
      cluster: <any> <unknown> cluster,
      exit,
      ...args,
    });
  }

  describe('start', () => {
    it('should fork the requested number of workers', () => {
      createPool({ workers: 3 }).start();

      expect(cluster.forked).toHaveLength(3);
      expect(stderrWrites.join('')).toContain('spawning 3 worker(s)');
    });

    it('should not monitor workers when the watchdog is disabled', () => {
      createPool({ unresponsiveTimeout: 0 }).start();

      jest.advanceTimersByTime(600_000);

      expect(cluster.forked[0].process.kill).not.toHaveBeenCalled();
    });
  });

  describe('unresponsive workers', () => {
    it('should kill and replace workers that stop sending heartbeats', () => {
      createPool().start();
      const worker = cluster.forked[0];

      jest.advanceTimersByTime(31_000);

      expect(worker.process.kill).toHaveBeenCalledWith('SIGKILL');
      expect(stderrWrites.join('')).toContain('was unresponsive for more than 30000ms');

      cluster.exitWorker(worker, 0, 'SIGKILL');
      expect(cluster.forked).toHaveLength(2);
    });

    it('should only kill an unresponsive worker once', () => {
      createPool().start();
      const worker = cluster.forked[0];

      jest.advanceTimersByTime(90_000);

      expect(worker.process.kill).toHaveBeenCalledTimes(1);
    });

    it('should keep workers that send heartbeats alive', () => {
      createPool().start();
      const worker = cluster.forked[0];

      for (let i = 0; i < 60; i++) {
        jest.advanceTimersByTime(HEARTBEAT_INTERVAL);
        cluster.emit('message', worker, MESSAGE_HEARTBEAT);
      }

      expect(worker.process.kill).not.toHaveBeenCalled();
    });

    it('should ignore messages of unknown workers', () => {
      createPool().start();

      cluster.emit('message', new FakeWorker(404), MESSAGE_HEARTBEAT);
      jest.advanceTimersByTime(31_000);

      expect(cluster.forked[0].process.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should ignore unknown messages', () => {
      createPool().start();
      const worker = cluster.forked[0];

      jest.advanceTimersByTime(29_000);
      cluster.emit('message', worker, 'something-else');
      jest.advanceTimersByTime(2_000);

      expect(worker.process.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should ignore workers that are absent from the cluster', () => {
      createPool().start();
      cluster.workers![99] = undefined;

      expect(() => jest.advanceTimersByTime(31_000)).not.toThrow();
    });

    it('should handle a cluster without workers', () => {
      const pool = createPool();
      pool.start();
      cluster.workers = undefined;

      expect(() => jest.advanceTimersByTime(31_000)).not.toThrow();
    });
  });

  describe('recycling workers', () => {
    it('should replace a worker that requests to be recycled', () => {
      createPool().start();
      const worker = cluster.forked[0];

      cluster.emit('message', worker, MESSAGE_RECYCLE);

      expect(stderrWrites.join('')).toContain('requested to be replaced');
      expect(cluster.forked).toHaveLength(2);
      expect(worker.disconnect).toHaveBeenCalledTimes(1);
      expect(worker.process.kill).not.toHaveBeenCalled();
    });

    it('should kill a recycled worker after the shutdown grace period', () => {
      createPool({ shutdownGrace: 1_000 }).start();
      const worker = cluster.forked[0];

      cluster.emit('message', worker, MESSAGE_RECYCLE);
      cluster.disconnectWorker(worker);
      jest.advanceTimersByTime(1_000);

      expect(worker.process.kill).toHaveBeenCalledWith('SIGKILL');
      // The replacement worker must not be killed
      expect(cluster.forked[1].process.kill).not.toHaveBeenCalled();
    });

    it('should not fork another worker when a replaced worker exits', () => {
      createPool().start();
      const worker = cluster.forked[0];

      cluster.emit('message', worker, MESSAGE_RECYCLE);
      cluster.exitWorker(worker, 0, 'SIGKILL');

      expect(cluster.forked).toHaveLength(2);
      expect(stderrWrites.join('')).toContain('Replaced worker 1001 exited (SIGKILL)');
    });

    it('should report the exit code of a replaced worker that exited by itself', () => {
      createPool().start();
      const worker = cluster.forked[0];

      cluster.emit('message', worker, MESSAGE_RECYCLE);
      cluster.exitWorker(worker, 15, null);

      expect(stderrWrites.join('')).toContain('Replaced worker 1001 exited (15)');
    });

    it('should only replace a worker once', () => {
      createPool().start();
      const worker = cluster.forked[0];

      cluster.emit('message', worker, MESSAGE_RECYCLE);
      cluster.emit('message', worker, MESSAGE_RECYCLE);

      expect(cluster.forked).toHaveLength(2);
    });

    it('should not replace workers while shutting down', () => {
      const pool = createPool();
      pool.start();
      const worker = cluster.forked[0];

      pool.stop('SIGTERM');
      cluster.emit('message', worker, MESSAGE_RECYCLE);

      expect(cluster.forked).toHaveLength(1);
    });
  });

  describe('restarting workers', () => {
    it('should restart workers that die after a healthy uptime', () => {
      createPool().start();

      jest.advanceTimersByTime(10_000);
      cluster.exitWorker(cluster.forked[0], 1, null);

      expect(cluster.forked).toHaveLength(2);
      expect(stderrWrites.join('')).toContain('Worker 1001 died (1). Restarting...');
    });

    it('should give up when workers keep failing to start', () => {
      createPool({ maxRapidRestarts: 3 }).start();

      cluster.exitWorker(cluster.forked[0], 1, null);
      cluster.exitWorker(cluster.forked[1], 1, null);
      cluster.exitWorker(cluster.forked[2], 1, null);

      expect(exit).toHaveBeenCalledWith(1);
      expect(cluster.forked).toHaveLength(3);
      expect(stderrWrites.join('')).toContain('3 times in a row. Giving up.');
    });

    it('should reset the failure counter after a healthy uptime', () => {
      createPool({ maxRapidRestarts: 2 }).start();

      cluster.exitWorker(cluster.forked[0], 1, null);
      jest.advanceTimersByTime(10_000);
      cluster.exitWorker(cluster.forked[1], 1, null);
      jest.advanceTimersByTime(10_000);
      cluster.exitWorker(cluster.forked[2], 1, null);

      expect(exit).not.toHaveBeenCalled();
      expect(cluster.forked).toHaveLength(4);
    });

    it('should restart workers that were killed by the watchdog without counting a failure', () => {
      createPool({ maxRapidRestarts: 2 }).start();

      jest.advanceTimersByTime(31_000);
      cluster.exitWorker(cluster.forked[0], 0, 'SIGKILL');
      jest.advanceTimersByTime(31_000);
      cluster.exitWorker(cluster.forked[1], 0, 'SIGKILL');

      expect(exit).not.toHaveBeenCalled();
      expect(cluster.forked).toHaveLength(3);
    });

    it('should restart workers without a known state', () => {
      createPool().start();

      cluster.exitWorker(new FakeWorker(404), 1, null);

      expect(cluster.forked).toHaveLength(2);
    });
  });

  describe('stop', () => {
    it('should signal all workers and exit once they are gone', () => {
      const pool = createPool({ workers: 2 });
      pool.start();

      pool.stop('SIGTERM');

      expect(cluster.forked[0].process.kill).toHaveBeenCalledWith('SIGTERM');
      expect(cluster.forked[1].process.kill).toHaveBeenCalledWith('SIGTERM');

      cluster.exitWorker(cluster.forked[0], 0, 'SIGTERM');
      expect(exit).not.toHaveBeenCalled();
      cluster.exitWorker(cluster.forked[1], 0, 'SIGTERM');
      expect(exit).toHaveBeenCalledWith(0);
      // Workers must not be restarted while shutting down
      expect(cluster.forked).toHaveLength(2);
    });

    it('should kill workers that refuse to shut down', () => {
      const pool = createPool({ shutdownGrace: 1_000 });
      pool.start();

      pool.stop('SIGTERM');
      jest.advanceTimersByTime(1_000);

      expect(cluster.forked[0].process.kill).toHaveBeenCalledWith('SIGKILL');
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('should exit immediately when there are no workers left', () => {
      const pool = createPool();
      pool.start();
      cluster.exitWorker(cluster.forked[0], 1, null);
      delete cluster.workers![cluster.forked[1].id];

      pool.stop('SIGTERM');

      expect(exit).toHaveBeenCalledWith(0);
    });

    it('should only stop once', () => {
      const pool = createPool();
      pool.start();

      pool.stop('SIGINT');
      pool.stop('SIGTERM');

      expect(cluster.forked[0].process.kill).toHaveBeenCalledTimes(1);
    });

    it('should stop the watchdog', () => {
      const pool = createPool();
      pool.start();

      pool.stop('SIGTERM');
      jest.advanceTimersByTime(60_000);

      expect(stderrWrites.join('')).not.toContain('unresponsive');
    });
  });

  describe('with default arguments', () => {
    it('should use the Node.js cluster and process defaults', () => {
      const pool = new WorkerPool({ workers: 1, unresponsiveTimeout: 0, stderr });
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(<any> jest.fn());

      // Stopping without any worker exits the process
      pool.stop('SIGTERM');

      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });
  });
});

describe('startHeartbeat', () => {
  let send: jest.Mock;
  const originalSend = process.send;
  const originalConnected = process.connected;

  beforeEach(() => {
    jest.useFakeTimers();
    send = jest.fn().mockReturnValue(true);
    process.send = <any> send;
    Object.defineProperty(process, 'connected', { value: true, configurable: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    process.send = originalSend;
    Object.defineProperty(process, 'connected', { value: originalConnected, configurable: true });
  });

  it('should periodically send heartbeats', () => {
    const timer = startHeartbeat(100);

    jest.advanceTimersByTime(250);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(MESSAGE_HEARTBEAT, undefined, undefined, expect.any(Function));
    // Errors on a closing IPC channel must be swallowed
    expect(() => send.mock.calls[0][3](new Error('Channel closed'))).not.toThrow();
    clearInterval(timer);
  });

  it('should not send heartbeats after being disconnected', () => {
    const timer = startHeartbeat(100);
    Object.defineProperty(process, 'connected', { value: false, configurable: true });

    jest.advanceTimersByTime(250);

    expect(send).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  it('should do nothing outside of a cluster worker', () => {
    process.send = undefined;

    expect(startHeartbeat(100)).toBeUndefined();

    jest.advanceTimersByTime(250);
    expect(send).not.toHaveBeenCalled();
  });

  it('should use a default interval', () => {
    const timer = startHeartbeat();

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL);

    expect(send).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });
});

describe('requestRecycle', () => {
  const originalSend = process.send;
  const originalConnected = process.connected;

  afterEach(() => {
    process.send = originalSend;
    Object.defineProperty(process, 'connected', { value: originalConnected, configurable: true });
  });

  it('should ask the primary process for a replacement', () => {
    const send = jest.fn().mockReturnValue(true);
    process.send = <any> send;
    Object.defineProperty(process, 'connected', { value: true, configurable: true });

    expect(requestRecycle()).toBe(true);
    expect(send).toHaveBeenCalledWith(MESSAGE_RECYCLE, undefined, undefined, expect.any(Function));
  });

  it('should do nothing outside of a cluster worker', () => {
    process.send = undefined;

    expect(requestRecycle()).toBe(false);
  });

  it('should do nothing when disconnected from the primary process', () => {
    const send = jest.fn().mockReturnValue(true);
    process.send = <any> send;
    Object.defineProperty(process, 'connected', { value: false, configurable: true });

    expect(requestRecycle()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('exitOnDisconnect', () => {
  let stderr: Writable;
  let writes: string[];
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    writes = [];
    stderr = new Writable({
      write(chunk: any, encoding: any, callback: any) {
        writes.push(chunk.toString());
        callback();
      },
    });
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(<any> jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
    exitSpy.mockRestore();
    process.removeAllListeners('disconnect');
  });

  it('should terminate the worker after the grace period', () => {
    exitOnDisconnect(stderr, 1_000);

    process.emit('disconnect');
    expect(writes.join('')).toContain('was disconnected, shutting down within 1000ms');
    expect(exitSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_000);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should do nothing until the worker is disconnected', () => {
    exitOnDisconnect(stderr, 1_000);

    jest.advanceTimersByTime(60_000);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should use a default grace period', () => {
    exitOnDisconnect(stderr);

    process.emit('disconnect');
    jest.advanceTimersByTime(10_000);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('requestRecycleIfRunaway', () => {
  const originalSend = process.send;
  const originalConnected = process.connected;
  let stderr: Writable;
  let writes: string[];
  let send: jest.Mock;
  let cpuSpy: jest.SpyInstance;

  beforeEach(() => {
    writes = [];
    stderr = new Writable({
      write(chunk: any, encoding: any, callback: any) {
        writes.push(chunk.toString());
        callback();
      },
    });
    send = jest.fn().mockReturnValue(true);
    process.send = <any> send;
    Object.defineProperty(process, 'connected', { value: true, configurable: true });
  });

  afterEach(() => {
    cpuSpy?.mockRestore();
    process.send = originalSend;
    Object.defineProperty(process, 'connected', { value: originalConnected, configurable: true });
  });

  /**
   * Make the worker report the given fraction of a CPU core over the sample window.
   * @param fraction The fraction of a CPU core to report.
   */
  function mockCpuUsage(fraction: number): void {
    cpuSpy = jest.spyOn(process, 'cpuUsage').mockImplementation(<any> ((previous?: any) => {
      if (previous) {
        // Microseconds of CPU time over the 10ms sample window used within these tests
        return { user: Math.round(10 * 1_000 * fraction), system: 0 };
      }
      return { user: 0, system: 0 };
    }));
  }

  it('should ask for a replacement when the worker is still busy', async() => {
    mockCpuUsage(1);

    await expect(requestRecycleIfRunaway(stderr, 10)).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(MESSAGE_RECYCLE, undefined, undefined, expect.any(Function));
    expect(writes.join('')).toContain('is still busy after the timeout');
  });

  it('should keep an idle worker', async() => {
    mockCpuUsage(0);

    await expect(requestRecycleIfRunaway(stderr, 10)).resolves.toBe(false);

    expect(send).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('is idle again after the timeout');
  });

  it('should keep a worker that is below the threshold', async() => {
    mockCpuUsage(0.1);

    await expect(requestRecycleIfRunaway(stderr, 10, 0.5)).resolves.toBe(false);

    expect(send).not.toHaveBeenCalled();
  });

  it('should do nothing outside of a cluster worker', async() => {
    process.send = undefined;

    await expect(requestRecycleIfRunaway(stderr, 10)).resolves.toBe(false);

    expect(writes).toEqual([]);
  });

  it('should sample over a default window', async() => {
    mockCpuUsage(0);
    jest.useFakeTimers();

    const promise = requestRecycleIfRunaway(stderr);
    await jest.advanceTimersByTimeAsync(CPU_SAMPLE_WINDOW);

    await expect(promise).resolves.toBe(false);
    jest.useRealTimers();
  });
});
