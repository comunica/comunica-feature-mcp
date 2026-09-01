/* eslint-disable unicorn/no-process-exit,import/no-nodejs-modules */
import cluster from 'node:cluster';
import type { QueryEngineBase } from '@comunica/actor-init-query';
import { SparqlMcpServer } from '@comunica/utils-mcp';
import type { Session } from '@rubensworks/solid-client-authn-isomorphic';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires
const { interactiveLogin } = require('solid-node-interactive-auth');

export function runCliSolid(queryEngine: QueryEngineBase, version: string): void {
  (async() => {
    const argv = await yargs(hideBin(process.argv))
      .usage('Usage: $0 [options] [sources...]')
      .option('mode', {
        alias: 'm',
        type: 'string',
        choices: [ 'http' ],
        demandOption: true,
        description: 'Transport mode for the MCP server (only http mode supported for Solid)',
      })
      .option('port', {
        alias: 'p',
        type: 'number',
        default: 3123,
        description: 'Port to run the MCP server on',
      })
      .option('idp', {
        type: 'string',
        description: 'Solid identity provider to authenticate with (set to \'void\' to disable auth)',
        default: 'https://solidcommunity.net/',
      })
      .option('timeout', {
        alias: 't',
        type: 'number',
        default: 60_000,
        description: 'Timeout in milliseconds after which the worker process is killed and restarted (0 to disable)',
      })
      .example([
        [ '$0 --mode http --port 3000', 'Start MCP server in HTTP mode on port 3000 with default IDP' ],
        [ '$0 --mode http --idp https://solidcommunity.net/', 'Start with a specific identity provider' ],
        [ '$0 --mode http --idp void', 'Start without authentication' ],
        [ '$0 --mode http --timeout 0', 'Start with worker timeout disabled' ],
        [ '$0 --mode http https://example.org/data/', 'Start with a default Solid pod URL' ],
      ])
      .parse();

    if (cluster.isPrimary) {
      // Primary process: spawn a single worker.
      // Solid mode is limited to one worker because each worker must perform an
      // independent interactive login; running multiple concurrent browser-based
      // authentication flows is not practical.
      process.stderr.write(`Primary ${process.pid} started, spawning 1 worker\n`);
      cluster.fork();

      cluster.on('exit', (worker, code, signal) => {
        process.stderr.write(`Worker ${worker.process.pid} died (${signal ?? code}). Restarting...\n`);
        cluster.fork();
      });
    } else {
      // Worker process: authenticate with Solid and run the MCP server.
      const defaultSources: string[] | undefined = argv._.length > 0 ? argv._.map(String) : undefined;

      // Handle Solid authentication
      let session: Session | undefined;
      if (argv.idp !== 'void') {
        try {
          process.stderr.write(`Authenticating with identity provider: ${argv.idp}\n`);
          session = await interactiveLogin({
            oidcIssuer: argv.idp,
          });
          process.stderr.write('Authentication successful!\n');
        } catch (error: any) {
          process.stderr.write(`Authentication error: ${error.message}\n`);
          if (error.stack) {
            process.stderr.write(`${error.stack}\n`);
          }
          process.exit(1);
        }
      }

      // Prepare custom context with Solid session if authenticated
      const customContext = session ?
          { '@comunica/actor-http-inrupt-solid-client-authn:session': session } :
        undefined;

      const server = new SparqlMcpServer(
        'http',
        argv.port,
        queryEngine,
        version,
        process.stderr,
        defaultSources,
        customContext,
        ` If you want to query the WebID or pod of the user, you can pass the URL ${session?.info.webId}.`,
      );

      // Schedule worker self-termination so the primary can restart it with a
      // fresh process and a renewed authentication session.
      const timeout = argv.timeout;
      if (timeout > 0) {
        setTimeout(() => {
          process.stderr.write(`Worker ${process.pid} timeout after ${timeout}ms. Shutting down.\n`);
          process.exit(0);
        }, timeout).unref();
      }

      // Handle graceful shutdown
      const cleanup = async(): Promise<void> => {
        if (session) {
          try {
            await session.logout();
            process.stderr.write('Logged out from Solid pod\n');
          } catch (error: any) {
            process.stderr.write(`Logout error: ${error.message}\n`);
          }
        }
      };

      process.on('SIGINT', () => {
        cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
      });

      process.on('SIGTERM', () => {
        cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
      });

      await server.start().catch((error) => {
        process.stderr.write(`Server error: ${error.message}\n`);
        if (error.stack) {
          process.stderr.write(`${error.stack}\n`);
        }
        return cleanup().finally(() => process.exit(1));
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
