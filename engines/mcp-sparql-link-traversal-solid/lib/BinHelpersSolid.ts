/* eslint-disable unicorn/no-process-exit */
import type { QueryEngineBase } from '@comunica/actor-init-query';
import type { Session } from '@rubensworks/solid-client-authn-isomorphic';
import { SparqlMcpServer } from '@comunica/utils-mcp';
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
      .example([
        [ '$0 --mode http --port 3000', 'Start MCP server in HTTP mode on port 3000 with default IDP' ],
        [ '$0 --mode http --idp https://solidcommunity.net/', 'Start with a specific identity provider' ],
        [ '$0 --mode http --idp void', 'Start without authentication' ],
        [ '$0 --mode http https://example.org/person/alice', 'Start with a default starting point for link traversal' ],
      ])
      .parse();

    // Extract positional arguments as default sources
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

    // Add session to query engine context if authenticated
    if (session) {
      const originalQuery = queryEngine.query.bind(queryEngine);
      queryEngine.query = function(query: string, context?: any): any {
        const contextWithAuth = {
          ...context,
          '@comunica/actor-http-inrupt-solid-client-authn:session': session,
        };
        return originalQuery(query, contextWithAuth);
      };

      const originalQueryBindings = queryEngine.queryBindings.bind(queryEngine);
      queryEngine.queryBindings = function(query: string, context?: any): any {
        const contextWithAuth = {
          ...context,
          '@comunica/actor-http-inrupt-solid-client-authn:session': session,
        };
        return originalQueryBindings(query, contextWithAuth);
      };

      const originalQueryQuads = queryEngine.queryQuads.bind(queryEngine);
      queryEngine.queryQuads = function(query: string, context?: any): any {
        const contextWithAuth = {
          ...context,
          '@comunica/actor-http-inrupt-solid-client-authn:session': session,
        };
        return originalQueryQuads(query, contextWithAuth);
      };

      const originalQueryBoolean = queryEngine.queryBoolean.bind(queryEngine);
      queryEngine.queryBoolean = function(query: string, context?: any): any {
        const contextWithAuth = {
          ...context,
          '@comunica/actor-http-inrupt-solid-client-authn:session': session,
        };
        return originalQueryBoolean(query, contextWithAuth);
      };

      const originalQueryVoid = queryEngine.queryVoid.bind(queryEngine);
      queryEngine.queryVoid = function(query: string, context?: any): any {
        const contextWithAuth = {
          ...context,
          '@comunica/actor-http-inrupt-solid-client-authn:session': session,
        };
        return originalQueryVoid(query, contextWithAuth);
      };
    }

    const server = new SparqlMcpServer(
      'http',
      argv.port,
      queryEngine,
      version,
      process.stderr,
      defaultSources,
    );

    // Handle graceful shutdown
    const cleanup = async() => {
      if (session) {
        try {
          await session.logout();
          process.stderr.write('Logged out from Solid pod\n');
        } catch (error: any) {
          process.stderr.write(`Logout error: ${error.message}\n`);
        }
      }
    };

    process.on('SIGINT', async() => {
      await cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async() => {
      await cleanup();
      process.exit(0);
    });

    server.start().catch((error) => {
      process.stderr.write(`Server error: ${error.message}\n`);
      if (error.stack) {
        process.stderr.write(`${error.stack}\n`);
      }
      cleanup().finally(() => process.exit(1));
    });
  })().catch((error) => {
    process.stderr.write(`Initialization error: ${error.message}\n`);
    if (error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exit(1);
  });
}
