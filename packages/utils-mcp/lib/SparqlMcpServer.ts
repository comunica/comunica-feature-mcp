/* eslint-disable import/no-nodejs-modules */
import type { Writable } from 'node:stream';
import type { QueryEngineBase } from '@comunica/actor-init-query';
import type { IQuerySourceSerialized, IQuerySourceUnidentifiedExpanded, QueryStringContext } from '@comunica/types';
import type { Context, FastMCPSessionAuth } from 'fastmcp';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

/**
 * An MCP server for querying over one or more Knowledge Graphs using SPARQL queries.
 */
export class SparqlMcpServer {
  private readonly server: FastMCP;
  private readonly stderr: Writable;
  private readonly defaultSources?: IQuerySourceUnidentifiedExpanded[];
  private queryId = 0;

  public constructor(
    private readonly mode: 'stdio' | 'http',
    private readonly port: number,
    private readonly queryEngine: QueryEngineBase,
    version: string,
    stderr: Writable,
    defaultSources?: string[],
  ) {
    this.stderr = stderr;
    this.server = new FastMCP({
      name: 'sparql-mcp',
      version: <any> version,
    });

    // Parse default sources if provided
    if (defaultSources && defaultSources.length > 0) {
      this.defaultSources = defaultSources.map(source => this.parseSourceString(source));
    }

    this.registerTools();
  }

  /**
   * Start the MCP server in the configured mode (stdio or HTTP stream).
   */
  public async start(): Promise<void> {
    if (this.mode === 'stdio') {
      await this.server.start({
        transportType: 'stdio',
      });
      this.stderr.write(`SPARQL MCP Server running in stdio mode\n`);
      if (this.defaultSources) {
        this.stderr.write(`Default sources: ${this.defaultSources.map(s => s.value).join(', ')}\n`);
      }
    } else {
      await this.server.start({
        transportType: 'httpStream',
        httpStream: {
          port: this.port,
          stateless: true,
        },
      });
      this.stderr.write(`SPARQL MCP Server listening on port ${this.port}\n`);
      if (this.defaultSources) {
        this.stderr.write(`Default sources: ${this.defaultSources.map(s => s.value).join(', ')}\n`);
      }
    }
  }

  /**
   * Parse a source string that may contain a type prefix (e.g., 'sparql@https://example.org/sparql').
   * This follows the same syntax as the Comunica CLI for forcing source types.
   * @param sourceString A source URL that may be prefixed with a type annotation.
   * @returns An object with 'value' and optionally 'type' properties.
   */
  protected parseSourceString(sourceString: string): IQuerySourceUnidentifiedExpanded {
    const source: IQuerySourceUnidentifiedExpanded = { value: '' };
    const typeRegex = /^([^:]*)@/u;
    const typeMatches = typeRegex.exec(sourceString);
    if (typeMatches) {
      source.type = typeMatches[1];
      sourceString = sourceString.slice((source.type.length) + 1);
    }
    source.value = sourceString;
    return source;
  }

  /**
   * Build a query context from optional parameters.
   * @param options Optional parameters for the query context
   * @param options.queryFormatLanguage The query language (e.g., 'sparql')
   * @param options.queryFormatVersion The query language version (e.g., '1.1')
   * @param options.baseIRI Base IRI for resolving relative IRIs
   * @param options.httpProxy HTTP proxy URL
   * @param options.httpAuth HTTP basic authentication credentials
   * @param options.httpTimeout HTTP request timeout in milliseconds
   * @param options.httpRetryCount Number of HTTP request retries
   * @returns A partial query context object
   */
  protected buildQueryContext(options: {
    queryFormatLanguage?: string;
    queryFormatVersion?: string;
    baseIRI?: string;
    httpProxy?: string;
    httpAuth?: string;
    httpTimeout?: number;
    httpRetryCount?: number;
  }): Partial<QueryStringContext> {
    const context: Partial<QueryStringContext> = {};

    if (options.queryFormatLanguage !== undefined || options.queryFormatVersion !== undefined) {
      context.queryFormat = {
        language: options.queryFormatLanguage ?? 'sparql',
        version: options.queryFormatVersion ?? '1.1',
      };
    }
    if (options.baseIRI) {
      context.baseIRI = options.baseIRI;
    }
    if (options.httpProxy) {
      const proxyUrl = options.httpProxy;
      context.httpProxyHandler = {
        getProxy: async(request): Promise<any> => ({
          input: proxyUrl,
          init: request.init,
        }),
      };
    }
    if (options.httpAuth) {
      context.httpAuth = options.httpAuth;
    }
    if (options.httpTimeout !== undefined) {
      context.httpTimeout = options.httpTimeout;
    }
    if (options.httpRetryCount !== undefined) {
      context.httpRetryCount = options.httpRetryCount;
    }

    return context;
  }

  protected registerTools(): void {
    // Common query format parameters shared between tools
    const queryFormatParams = {
      queryFormatLanguage: z.string().optional()
        .describe(
          'Query language (e.g., sparql, graphql). ' +
          'Allows you to specify alternative query languages supported by Comunica',
        ),
      queryFormatVersion: z.string().optional()
        .describe(
          'Query language version (e.g., 1.0, 1.1, 1.2). ' +
          'Specifies the version of the query language to use',
        ),
    };

    // Build description for query_sparql tool
    let querySparqlDescription = `Execute a SPARQL query over one or more sources. When sending a SELECT query, results are serialized as 'application/sparql-results+json', CONSTRUCT and DESCRIBE results are in 'application/trig', and ASK queries return true or false. Update queries (INSERT/DELETE) can also be passed, which in most cases will only work on private Knowledge Graphs or by passing authentication.`;

    if (this.defaultSources) {
      // If default sources are provided, mention them in the description
      const sourceList = this.defaultSources.map(s => s.value).join(', ');
      querySparqlDescription += ` Default sources: ${sourceList}`;
    }

    // Build parameters for query_sparql tool
    const querySparqlParams: any = {
      query: z.string().describe('SPARQL query string'),
    };

    // Only add sources parameter if no default sources are provided
    if (!this.defaultSources) {
      querySparqlParams.sources = z.array(z.string()).describe(`List of SPARQL endpoint URLs, TPF interface URLs, or Linked Data (RDF) file paths. You can optionally force a source type by prefixing the URL with a type annotation (e.g., 'sparql@https://example.org/sparql', 'file@/path/to/file.ttl', 'hypermedia@https://example.org/'). This is useful when the source type is already known to avoid auto-detection overhead.`);
    }

    // Add common parameters
    Object.assign(querySparqlParams, {
      ...queryFormatParams,
      baseIRI: z.string().optional().describe('Base IRI for resolving relative IRIs in the query'),
      httpProxy: z.string().optional().describe('HTTP proxy URL (e.g., http://proxy.example.com:8080)'),
      httpAuth: z.string().optional().describe('HTTP basic authentication in the format username:password'),
      httpTimeout: z.number().optional().describe('HTTP request timeout in milliseconds'),
      httpRetryCount: z.number().optional().describe('Number of HTTP request retries on failure'),
    });

    this.server.addTool({
      name: 'query_sparql',
      description: querySparqlDescription,
      parameters: z.object(querySparqlParams),
      annotations: {
        // Signals this tool uses streaming
        streamingHint: true,
        readOnlyHint: true,
      },
      // Type assertion is needed because we dynamically construct the parameters object
      // based on whether default sources are provided. The runtime behavior is type-safe.
      execute: (args, context) => this.executeQuerySparql(<any>args, context),
    });

    this.server.addTool({
      name: 'query_sparql_rdf',
      description: `Execute a SPARQL query over a serialized RDF dataset provided as a string. This is useful for querying RDF data that is already available as a string (e.g., Turtle, N-Triples, etc.). When sending a SELECT query, results are serialized as 'application/sparql-results+json', CONSTRUCT and DESCRIBE results are in 'application/trig', and ASK queries return true or false.`,
      parameters: z.object({
        query: z.string().describe('SPARQL query string'),
        value: z.string().describe('Serialized RDF dataset as a string'),
        mediaType: z.string().describe(`Media type of the serialized RDF dataset (e.g., 'text/turtle', 'application/n-triples', 'application/ld+json', 'application/rdf+xml', 'application/n-quads', 'application/trig')`),
        fileBaseIRI: z.string().optional().describe('Base IRI for resolving relative IRIs in the RDF dataset'),
        baseIRI: z.string().optional().describe('Base IRI for resolving relative IRIs in the query'),
        ...queryFormatParams,
      }),
      annotations: {
        // Signals this tool uses streaming
        streamingHint: true,
        readOnlyHint: true,
      },
      execute: (args, context) => this.executeQuerySparqlRdf(args, context),
    });
  }

  /**
   * Execute a SPARQL query and stream the results back to the client.
   * This method contains the common logic for executing queries and handling results.
   * @param query The SPARQL query string
   * @param sources Array of query sources
   * @param queryId The query ID for logging
   * @param context The MCP context for streaming results
   * @param queryContext Optional query context parameters
   * @returns The query results as a string or an error object
   */
  protected async executeQuery(
    query: string,
    sources: IQuerySourceUnidentifiedExpanded[],
    queryId: number,
    context: Context<FastMCPSessionAuth>,
    queryContext: Partial<QueryStringContext> = {},
  ): Promise<any> {
    await context.streamContent({ type: 'text', text: `Streaming SPARQL query results hereafter:` });

    try {
      const promises: Promise<any>[] = [];
      const chunks: string[] = [];
      const queryResult = await this.queryEngine.query(query, { sources, ...queryContext });
      const { data } = await this.queryEngine.resultToString(queryResult);
      data.on('data', (chunk: string) => {
        chunks.push(chunk);
        promises.push(context.streamContent({ type: 'text', text: chunk.toString() }));
      });
      await new Promise((resolve, reject) => {
        data.on('error', reject);
        data.on('end', resolve);
      });
      await Promise.all(promises);

      // Log successful completion
      this.stderr.write(`[Query ${queryId}] Successfully completed\n`);

      return chunks.join('');
    } catch (error: any) {
      // Log query failure
      this.stderr.write(`[Query ${queryId}] Failed: ${error.stack}\n`);

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Query failed: ${error.message}`,
          },
        ],
      };
    }
  }

  protected async executeQuerySparql(
    args: {
      query: string;
      sources?: string[];
      queryFormatLanguage?: string;
      queryFormatVersion?: string;
      baseIRI?: string;
      httpProxy?: string;
      httpAuth?: string;
      httpTimeout?: number;
      httpRetryCount?: number;
    },
    context: Context<FastMCPSessionAuth>,
  ): Promise<any> {
    const currentQueryId = this.queryId++;

    // Use default sources if provided, otherwise use sources from args
    let parsedSources: IQuerySourceUnidentifiedExpanded[];
    if (this.defaultSources) {
      parsedSources = this.defaultSources;
    } else if (args.sources) {
      parsedSources = args.sources.map(sourceString => this.parseSourceString(sourceString));
    } else {
      throw new Error('No sources provided and no default sources configured');
    }

    // Build query context from optional parameters
    const queryContext = this.buildQueryContext(args);

    // Log query start
    this.stderr.write(`[Query ${currentQueryId}] Starting SPARQL query\n`);
    this.stderr.write(`[Query ${currentQueryId}] Sources: ${parsedSources.map(s => s.value).join(', ')}\n`);
    this.stderr.write(`[Query ${currentQueryId}] Query: ${args.query}\n`);

    return this.executeQuery(args.query, parsedSources, currentQueryId, context, queryContext);
  }

  protected async executeQuerySparqlRdf(
    args: {
      query: string;
      value: string;
      mediaType: string;
      fileBaseIRI?: string;
      baseIRI?: string;
      queryFormatLanguage?: string;
      queryFormatVersion?: string;
    },
    context: Context<FastMCPSessionAuth>,
  ): Promise<any> {
    const currentQueryId = this.queryId++;

    // Create a serialized source
    const source: IQuerySourceSerialized = {
      type: 'serialized',
      value: args.value,
      mediaType: args.mediaType,
      ...(args.fileBaseIRI && { baseIRI: args.fileBaseIRI }),
    };

    // Build query context from optional parameters
    const queryContext = this.buildQueryContext(args);

    // Log query start
    this.stderr.write(`[Query ${currentQueryId}] Starting SPARQL query on serialized RDF (media type: ${args.mediaType})\n`);
    this.stderr.write(`[Query ${currentQueryId}] Query: ${args.query}\n`);

    return this.executeQuery(args.query, [ source ], currentQueryId, context, queryContext);
  }
}
