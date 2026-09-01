#!/usr/bin/env node
import { QueryEngine } from '@comunica/query-sparql-file';
import { runCli } from '@comunica/utils-mcp';

runCli(
  () => new QueryEngine(),
  // eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
  require('../package.json').version,
  undefined,
  ` This server can also query local RDF files, by passing their path, optionally prefixed with 'file@'.`,
);
