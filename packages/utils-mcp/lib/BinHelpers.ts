/* eslint-disable unicorn/no-process-exit */
import type { QueryEngineBase } from '@comunica/actor-init-query';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { SparqlMcpServer } from './SparqlMcpServer';

export function runCli(queryEngine: QueryEngineBase, version: string): void {
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
      .example([
        [ '$0 --mode stdio', 'Start MCP server in stdio mode without default sources' ],
        [ '$0 --mode http --port 3000', 'Start MCP server in HTTP mode on port 3000' ],
        [ '$0 --mode stdio https://dbpedia.org/sparql', 'Start with a default SPARQL endpoint' ],
        [ '$0 --mode stdio https://example.org/data.ttl file@/path/to/local.ttl', 'Start with multiple default sources' ],
      ])
      .parse();

    // Extract positional arguments as default sources
    const defaultSources: string[] | undefined = argv._.length > 0 ? argv._.map(String) : undefined;

    const server = new SparqlMcpServer(
      <'stdio' | 'http'> argv.mode,
      argv.port,
      queryEngine,
      version,
      process.stderr,
      defaultSources,
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
