#!/usr/bin/env node
import { QueryEngine } from '@comunica/query-sparql-solid';
import { runCliSolid } from '../lib/BinHelpersSolid';

// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
runCliSolid(new QueryEngine(), require('../package.json').version);
