/* eslint-disable unicorn/no-process-exit,import/no-nodejs-modules */
import cluster from 'node:cluster';
import type { QueryEngineBase } from '@comunica/actor-init-query';
import type { QueryStringContext } from '@comunica/types';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { SparqlMcpServer } from './SparqlMcpServer';

export function runCli(
  queryEngine: QueryEngineBase,
  version: string,
  customContext?: Partial<QueryStringContext>,
): void {
  (async() => {
    const argv = await yargs(hideBin(process.argv))
      .usage('Usage: $0 [options] [sources...]')
      .option('mode', {
        alias: 'm',
        type: 'string',
        choices: [ 'stdio', 'http' ],
        demandOption: true,
        description: 'Transport mode for the MCP server',
      })
      .option('port', {
        alias: 'p',
        type: 'number',
        default: 3123,
        description: 'Port to run the MCP server on (only for http mode)',
      })
      .option('workers', {
        alias: 'w',
        type: 'number',
        default: 1,
        description: 'Number of worker processes to spawn (only for http mode; stdio always uses a single worker)',
      })
      .option('timeout', {
        alias: 't',
        type: 'number',
        default: 60_000,
        description: 'Timeout in milliseconds after which a worker process is killed and restarted (0 to disable)',
      })
      .example([
        [ '$0 --mode stdio', 'Start MCP server in stdio mode without default sources' ],
        [ '$0 --mode http --port 3000', 'Start MCP server in HTTP mode on port 3000' ],
        [ '$0 --mode http --port 3000 --workers 4', 'Start MCP server with 4 worker processes' ],
        [ '$0 --mode http --port 3000 --timeout 300000', 'Start with a 5-minute worker timeout' ],
        [ '$0 --mode stdio https://dbpedia.org/sparql', 'Start with a default SPARQL endpoint' ],
        [ '$0 --mode stdio https://example.org/data.ttl file@/path/to/local.ttl', 'Start with multiple default sources' ],
      ])
      .parse();

    if (cluster.isPrimary) {
      // Primary process: spawn workers and manage their lifecycle.
      // stdio mode must always use exactly one worker because multiple processes
      // cannot safely read from the same stdin stream simultaneously.
      const numWorkers = argv.mode === 'stdio' ? 1 : argv.workers;
      process.stderr.write(`Primary ${process.pid} started, spawning ${numWorkers} worker(s)\n`);

      for (let i = 0; i < numWorkers; i++) {
        cluster.fork();
      }

      cluster.on('exit', (worker, code, signal) => {
        process.stderr.write(`Worker ${worker.process.pid} died (${signal ?? code}). Restarting...\n`);
        cluster.fork();
      });
    } else {
      // Worker process: run the actual MCP server with the query engine.
      // Extract positional arguments as default sources
      const defaultSources: string[] | undefined = argv._.length > 0 ? argv._.map(String) : undefined;

      const server = new SparqlMcpServer(
        <'stdio' | 'http'> argv.mode,
        argv.port,
        queryEngine,
        version,
        process.stderr,
        defaultSources,
        customContext,
      );

      // Schedule worker self-termination so the primary can restart it with a
      // fresh process, preventing unbounded memory growth over time.
      const timeout = argv.timeout;
      if (timeout > 0) {
        setTimeout(() => {
          process.stderr.write(`Worker ${process.pid} timeout after ${timeout}ms. Shutting down.\n`);
          process.exit(0);
        }, timeout).unref();
      }

      server.start().catch((error) => {
        process.stderr.write(`Server error: ${error.message}\n`);
        if (error.stack) {
          process.stderr.write(`${error.stack}\n`);
        }
        process.exit(1);
      });
    }
  })().catch((error) => {
    process.stderr.write(`Initialization error: ${error.message}\n`);
    if (error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exit(1);
  });
}
