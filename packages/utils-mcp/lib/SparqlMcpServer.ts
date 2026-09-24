/* eslint-disable import/no-nodejs-modules */
import type { Readable, Writable } from 'node:stream';
import type { QueryEngineBase } from '@comunica/actor-init-query';
import type { IQuerySourceSerialized, IQuerySourceUnidentifiedExpanded, QueryStringContext } from '@comunica/types';
import type { Context, FastMCPSessionAuth } from 'fastmcp';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

/**
 * The maximum number of characters of an error message that is reported back to the client.
 */
export const MAX_ERROR_LENGTH = 1_000;

/**
 * The maximum number of causes that are unwrapped from an error.
 */
export const MAX_ERROR_CAUSES = 5;

export interface ISparqlMcpServerOptions {
  /**
   * The maximum time in milliseconds a query may take before it is aborted. A value of 0 disables the timeout.
   *
   * Pending HTTP requests are aborted when this fires, but Comunica offers no way to abort the query itself,
   * so a query that is busy computing keeps consuming CPU in the background until the process is replaced.
   */
  queryTimeout?: number;
  /**
   * The maximum number of characters of results that are returned. A value of 0 disables this limit.
   *
   * Without a limit, a single unselective query can return results that no longer fit
   * in the context of the agent that asked for them.
   */
  maxResultBytes?: number;
  /**
   * Invoked when a query exceeded {@link ISparqlMcpServerOptions.queryTimeout}.
   */
  onQueryTimeout?: () => void;
}

/**
 * An MCP server for querying over one or more Knowledge Graphs using SPARQL queries.
 */
export class SparqlMcpServer {
  private readonly server: FastMCP;
  private readonly stderr: Writable;
  private readonly defaultSources?: IQuerySourceUnidentifiedExpanded[];
  private readonly customContext?: Partial<QueryStringContext>;
  private queryId = 0;

  public constructor(
    private readonly mode: 'stdio' | 'http',
    private readonly port: number,
    private readonly queryEngine: QueryEngineBase,
    version: string,
    stderr: Writable,
    defaultSources?: string[],
    customContext?: Partial<QueryStringContext>,
    additionalSourcesDescription?: string,
    private readonly options: ISparqlMcpServerOptions = {},
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

    // Store custom context to be merged with query context
    this.customContext = customContext;

    this.registerTools(additionalSourcesDescription);
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

  protected registerTools(additionalSourcesDescription?: string): void {
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
      querySparqlParams.sources = z.array(z.string()).describe(`List of SPARQL endpoint URLs, TPF interface URLs, or Linked Data (RDF) document URLs. Just pass the plain URL: the type of each source is detected automatically from its hypermedia controls, which covers SPARQL endpoints, Triple Pattern Fragments and Quad Pattern Fragments interfaces, and plain RDF documents alike. Optionally, if the type is already known, it can be forced by prefixing the URL with 'sparql@', 'qpf@' or 'file@' (e.g. 'sparql@https://example.org/sparql'), which skips detection. Only use an annotation you are sure about, as an incorrect one makes the query fail.${additionalSourcesDescription ?? ''}`);
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
   * Count the number of newlines within the given string.
   * @param value The string to count newlines in.
   * @returns The number of newlines.
   */
  protected countNewlines(value: string): number {
    let count = 0;
    for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) {
      count++;
    }
    return count;
  }

  /**
   * Describe a query source in a way that is safe to send back to the client.
   * Sources that carry their data inline are only described by their type,
   * as echoing a whole dataset back would needlessly consume the context of an agent.
   * @param source The source to describe.
   * @returns A short description of the source.
   */
  protected describeSource(source: IQuerySourceUnidentifiedExpanded): string {
    if (source.type === 'serialized') {
      return `serialized (${(<IQuerySourceSerialized> source).mediaType})`;
    }
    const value = String(source.value);
    return source.type ? `${source.type}@${value}` : value;
  }

  /**
   * Cut off results that exceeded the maximum result size at their last complete line.
   * @param results The serialized results, of which the last line can be incomplete.
   * @param resultType The type of the query result.
   * @returns The results up to their last complete line.
   */
  protected truncateResults(results: string, resultType: string): string {
    const lastNewline = results.lastIndexOf('\n');
    let trimmed = lastNewline === -1 ? '' : results.slice(0, lastNewline);

    if (resultType !== 'bindings') {
      return trimmed;
    }

    // The bindings serializer wraps its results in a JSON array, which must still be closed here,
    // without the comma that separated the last kept result from the one that was dropped
    if (trimmed.endsWith(',')) {
      trimmed = trimmed.slice(0, -1);
    }
    return `${trimmed === '' ? '[' : trimmed}\n]\n`;
  }

  /**
   * Describe an error in a way that is useful to an agent.
   *
   * Query errors can carry the full HTML error page of a source, or wrap the only useful part
   * inside a chain of causes, neither of which an agent can do anything with as-is.
   * @param error The error that was thrown.
   * @returns A single-line description of the error.
   */
  protected describeError(error: any): string {
    // Unwrap the causes, as those carry the actual reason of failures such as 'fetch failed'
    const messages: string[] = [];
    let current: any = error;
    for (let depth = 0; current && depth < MAX_ERROR_CAUSES; depth++) {
      const message = String(current.message ?? current);
      if (message && !messages.includes(message)) {
        messages.push(message);
      }
      current = current.cause;
    }
    let combined = messages.join(': ');

    // Unavailable sources tend to answer with a full HTML error page, which is of no use to an agent
    const html = /<!DOCTYPE html|<html[\s>]/iu.exec(combined);
    if (html) {
      combined = `${combined.slice(0, html.index).trim()} (HTML error page omitted)`;
    }

    if (combined.length > MAX_ERROR_LENGTH) {
      combined = `${combined.slice(0, MAX_ERROR_LENGTH)}… (truncated)`;
    }
    return combined;
  }

  /**
   * Summarize a query result, so that agents can tell an empty result apart from a failed query,
   * and know which sources the results actually came from.
   * @param args The result to describe.
   * @param args.sources The sources the query was executed over.
   * @param args.resultType The type of the query result.
   * @param args.bytes The number of characters of the serialized results.
   * @param args.newlines The number of newlines within the serialized results, used to count bindings.
   * @param args.truncated If the results were cut off because they exceeded the maximum result size.
   * @param args.elapsed The query execution time in milliseconds.
   * @returns A single line describing the results.
   */
  protected describeResults(args: {
    sources: IQuerySourceUnidentifiedExpanded[];
    resultType: string;
    bytes: number;
    newlines: number;
    truncated: boolean;
    elapsed: number;
  }): string {
    const summary: Record<string, any> = { resultType: args.resultType };

    // The bindings serializer emits one line per result, wrapped in a JSON array.
    // Quads are deliberately not counted: the TriG serializer groups all objects of a subject
    // onto a single line, so counting lines would report fewer quads than were actually returned.
    // Truncated results are not counted either, as their wrapping lines were never emitted.
    if (args.resultType === 'bindings' && !args.truncated) {
      summary.results = Math.max(args.newlines - 2, 0);
    }
    if (args.truncated) {
      summary.truncated = true;
      summary.bytes = args.bytes;
      // Results are kept per complete line, so without any line nothing survived the truncation
      summary.empty = args.newlines === 0;
    } else {
      summary.empty = summary.results === undefined ? args.bytes === 0 : summary.results === 0;
    }
    summary.elapsedMs = args.elapsed;
    summary.sources = args.sources.map(source => this.describeSource(source));

    const truncationNote = args.truncated ?
      ' The results were cut off because they became too large, so they are incomplete; ' +
      'use LIMIT and OFFSET to read them in smaller parts.' :
      '';
    return `Query metadata: ${JSON.stringify(summary)}. Note that results can be incomplete without an error \
when one of multiple sources is unavailable.${truncationNote}`;
  }

  /**
   * Reject the given promise if it does not settle within the configured query timeout.
   *
   * Note that this can only interrupt queries that leave the event loop free.
   * Queries that block the event loop are handled by the primary process,
   * which kills and restarts unresponsive workers.
   * @param promise The promise wrapping the query execution.
   * @param queryId The query ID for logging.
   * @returns The value of the given promise.
   */
  protected async withQueryTimeout<T>(promise: Promise<T>, queryId: number): Promise<T> {
    const queryTimeout = this.options.queryTimeout ?? 0;
    if (queryTimeout <= 0) {
      return promise;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((resolve, reject) => {
      timer = setTimeout(() => {
        this.stderr.write(`[Query ${queryId}] Timed out after ${queryTimeout}ms\n`);
        reject(new Error(`Query timed out after ${queryTimeout}ms. \
Consider making the query more selective, restricting it to fewer sources, \
or increasing the timeout of the MCP server.`));
        this.options.onQueryTimeout?.();
      }, queryTimeout);
    });

    try {
      return await Promise.race([ promise, timeout ]);
    } finally {
      clearTimeout(timer);
    }
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
    // Kept outside of the query execution, so that a timed out query can be cancelled
    let resultStream: Readable | undefined;
    let resultType = 'unknown';
    let newlines = 0;
    let truncated = false;
    const startTime = Date.now();
    const maxResultBytes = this.options.maxResultBytes ?? 0;
    // Lets us stop the HTTP requests of a query that timed out or failed
    const abortController = new AbortController();

    try {
      const executeInner = async(): Promise<string> => {
        const chunks: string[] = [];
        let bytes = 0;
        // Chained instead of collected, so that memory does not grow with the number of chunks
        let streamed: Promise<any> = Promise.resolve();
        // Merge custom context with provided query context
        const mergedContext = {
          sources,
          httpAbortSignal: abortController.signal,
          ...this.customContext,
          ...queryContext,
        };
        const queryResult = await this.queryEngine.query(query, mergedContext);
        resultType = queryResult.resultType ?? resultType;
        const { data } = await this.queryEngine.resultToString(queryResult);
        resultStream = <Readable> data;
        data.on('data', (chunk: string) => {
          if (truncated) {
            return;
          }
          const text = chunk.toString();
          chunks.push(text);
          bytes += text.length;
          newlines += this.countNewlines(text);
          streamed = streamed.then(() => context.streamContent({ type: 'text', text }));

          // Stop as soon as the results no longer fit, as an agent can not act on more than this anyway
          if (maxResultBytes > 0 && bytes >= maxResultBytes) {
            truncated = true;
            this.stderr.write(`[Query ${queryId}] Truncated after ${bytes} characters\n`);
            (<Readable> data).destroy();
          }
        });
        await new Promise<void>((resolve, reject) => {
          // Destroying the stream ends it without an 'end' event, and may surface as an error
          data.on('error', error => (truncated ? resolve() : reject(error)));
          data.on('end', resolve);
          data.on('close', resolve);
        });
        await streamed;

        const results = chunks.join('');
        return truncated ? this.truncateResults(results, resultType) : results;
      };
      const results = await this.withQueryTimeout(executeInner(), queryId);

      // Log successful completion
      this.stderr.write(`[Query ${queryId}] Successfully completed\n`);

      return {
        content: [
          { type: 'text', text: results },
          {
            type: 'text',
            text: this.describeResults({
              sources,
              resultType,
              bytes: results.length,
              newlines,
              truncated,
              elapsed: Date.now() - startTime,
            }),
          },
        ],
      };
    } catch (error: any) {
      // Make sure that a timed out or failed query stops consuming resources
      abortController.abort();
      resultStream?.destroy();

      // Log query failure
      this.stderr.write(`[Query ${queryId}] Failed: ${error.stack}\n`);

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Query failed: ${this.describeError(error)}`,
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
