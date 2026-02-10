#!/usr/bin/env node
import { runCliSolid } from '@comunica/mcp-sparql-solid';
import { QueryEngine } from '@comunica/query-sparql-link-traversal-solid';

// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
runCliSolid(new QueryEngine(), require('../package.json').version);
