/* eslint-disable unicorn/no-process-exit,import/no-nodejs-modules */
import type { Cluster } from 'node:cluster';
import type { QueryEngineBase } from '@comunica/actor-init-query';
import type { QueryStringContext } from '@comunica/types';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { SparqlMcpServer } from './SparqlMcpServer';
import {
  exitOnDisconnect,
  MIN_UNRESPONSIVE_TIMEOUT,
  requestRecycleIfRunaway,
  startHeartbeat,
  WorkerPool,
} from './WorkerPool';

// The cluster module only has a default export, which can not be imported
// as such within this CommonJS package, so it is required instead.
// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires
const cluster: Cluster = require('node:cluster');

/**
 * Run the CLI of an MCP server.
 * @param queryEngine The query engine to expose, or a factory creating it.
 *                    A factory is preferred, as it avoids initializing an engine inside the primary process.
 * @param version The version of the MCP server.
 * @param customContext An optional query context to apply to all queries.
 * @param additionalSourcesDescription An optional addition to the description of the sources parameter,
 *                                     for engines that accept more source types than the default ones.
 */
export function runCli(
  queryEngine: QueryEngineBase | (() => QueryEngineBase),
  version: string,
  customContext?: Partial<QueryStringContext>,
  additionalSourcesDescription?: string,
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
        description: 'Number of worker processes to run queries in (only for http mode)',
      })
      .option('timeout', {
        alias: 't',
        type: 'number',
        default: 60_000,
        description: 'Maximum query execution time in milliseconds (0 to disable)',
      })
      .example([
        [ '$0 --mode stdio', 'Start MCP server in stdio mode without default sources' ],
        [ '$0 --mode http --port 3000', 'Start MCP server in HTTP mode on port 3000' ],
        [ '$0 --mode http --port 3000 --workers 4', 'Start MCP server with 4 worker processes' ],
        [ '$0 --mode http --port 3000 --timeout 300000', 'Start with a query timeout of 5 minutes' ],
        [ '$0 --mode stdio https://dbpedia.org/sparql', 'Start with a default SPARQL endpoint' ],
        [ '$0 --mode stdio https://example.org/data.ttl file@/path/to/local.ttl', 'Start with multiple default sources' ],
      ])
      .parse();

    // In http mode, queries are executed inside worker processes that are supervised by this primary process.
    // Queries that block the event loop can not be aborted by the worker they run in,
    // as no timeout inside that worker would be able to fire anymore.
    // The primary process detects such workers, and kills and replaces them.
    // In stdio mode, the server is not clustered, as workers can not share a single stdin stream,
    // and restarting a worker would invalidate the MCP session of the connected client.
    if (argv.mode === 'http' && cluster.isPrimary) {
      const workerPool = new WorkerPool({
        workers: Math.max(1, argv.workers),
        unresponsiveTimeout: argv.timeout > 0 ? Math.max(argv.timeout, MIN_UNRESPONSIVE_TIMEOUT) : 0,
        stderr: process.stderr,
      });
      workerPool.start();
      for (const signal of <NodeJS.Signals[]> [ 'SIGINT', 'SIGTERM' ]) {
        process.on(signal, () => workerPool.stop(signal));
      }
      return;
    }

    // Let the primary process know that this worker is still responsive,
    // and make sure this worker never outlives the primary process that manages it.
    // Both are a no-op in stdio mode, where there is no primary process.
    startHeartbeat();
    exitOnDisconnect(process.stderr);

    // Extract positional arguments as default sources
    const defaultSources: string[] | undefined = argv._.length > 0 ? argv._.map(String) : undefined;

    const server = new SparqlMcpServer(
      <'stdio' | 'http'> argv.mode,
      argv.port,
      typeof queryEngine === 'function' ? queryEngine() : queryEngine,
      version,
      process.stderr,
      defaultSources,
      customContext,
      additionalSourcesDescription,
      {
        queryTimeout: argv.timeout,
        // Comunica can not abort a running query, so the only way to reclaim the resources of a query
        // that keeps running after its timeout is to let the primary process replace this worker.
        // Queries that timed out while waiting on a slow source leave nothing behind,
        // so those must not disrupt the connections of other clients.
        onQueryTimeout: () => {
          requestRecycleIfRunaway(process.stderr).catch((error: Error) => {
            process.stderr.write(`Could not request a replacement worker: ${error.message}\n`);
          });
        },
      },
    );
    server.start().catch((error) => {
      process.stderr.write(`Server error: ${error.message}\n`);
      if (error.stack) {
        process.stderr.write(`${error.stack}\n`);
      }
      process.exit(1);
    });
  })().catch((error) => {
    process.stderr.write(`Initialization error: ${error.message}\n`);
    if (error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exit(1);
  });
}
