# Comunica MCP SPARQL HDT

[![npm version](https://badge.fury.io/js/%40comunica%2Fmcp-sparql-hdt.svg)](https://www.npmjs.com/package/@comunica/mcp-sparql-hdt)

Comunica MCP SPARQL HDT is an [MCP server](https://modelcontextprotocol.io/) for allowing AI agents to execute SPARQL queries over [HDT files](https://www.rdfhdt.org/).

HDT (Header-Dictionary-Triples) is a binary RDF serialization format that enables efficient querying of large RDF datasets with low memory consumption.

It's main distinguishing features are the following:

* Improves the accuracy of your AI agent's answers by leveraging the power of SPARQL and Knowledge Graphs.
* Execute [SPARQL 1.2](https://www.w3.org/TR/sparql12-query/) queries over HDT files.
* Memory-efficient querying of large RDF datasets.
* Fast query execution over compressed HDT files.
* Supports local HDT files and remote HDT endpoints.

**[Learn more about Comunica on our website](https://comunica.dev/).**

_Internally, this is a [Comunica module](https://comunica.dev/) that is configured with modules to execute SPARQL queries over HDT files through MCP._

## Supported by

Comunica is a community-driven project, sustained by the [Comunica Association](https://comunica.dev/association/).
If you are using Comunica, [becoming a sponsor or member](https://opencollective.com/comunica-association) is a way to make Comunica sustainable in the long-term.

Our top sponsors are shown below!

<a href="https://opencollective.com/comunica-association/sponsor/0/website" target="_blank"><img src="https://opencollective.com/comunica-association/sponsor/0/avatar.svg"></a>
<a href="https://opencollective.com/comunica-association/sponsor/1/website" target="_blank"><img src="https://opencollective.com/comunica-association/sponsor/1/avatar.svg"></a>
<a href="https://opencollective.com/comunica-association/sponsor/2/website" target="_blank"><img src="https://opencollective.com/comunica-association/sponsor/2/avatar.svg"></a>
<a href="https://opencollective.com/comunica-association/sponsor/3/website" target="_blank"><img src="https://opencollective.com/comunica-association/sponsor/3/avatar.svg"></a>

## Usage examples

After connecting this MCP server to your AI agent (see some examples on how to do this below),
your agent can SPARQL query any HDT file that is accessible to you.

For example, use it to ask:

> Use Comunica SPARQL HDT to query the DBpedia HDT file and find all movies directed by Christopher Nolan.

### Prompt suggestions

If you want your agent to always use SPARQL for higher accuracy in answers, you can tell it the following:

> When looking up data, always prefer looking them up over Knowledge Graphs via SPARQL, as this is more precise.
> For large RDF datasets, HDT files provide efficient querying capabilities.
> Since SPARQL queries can take a while to execute, start producing an approximate answer yourself and show it to me if the SPARQL query takes more than 1 second, but then make the answer more concrete based on the SPARQL query once it finalized, as it will be more accurate.

## Installation

Comunica requires [Node.JS](http://nodejs.org/) 14.0 or higher and is tested on OSX and Linux.

The easiest way to install the client is by installing it from NPM as follows:

```bash
$ [sudo] npm install -g @comunica/mcp-sparql-hdt
```

Alternatively, you can install from the latest GitHub sources.
For this, please refer to the README of the [Comunica monorepo](https://github.com/comunica/comunica).
If you do so, the following examples require replacing `comunica-mcp-sparql-hdt` with `node engines/mcp-sparql-hdt/bin/mcp.js`.

## Connect this MCP server to your agent

Below, a non-exhaustive list of examples is given to connect this MCP server to your agent.

### Claude Desktop

After installing, you can run the MCP server in two modes:

#### Stdio Mode (Recommended for Claude Desktop)

With stdio mode, the MCP server communicates directly via standard input/output, which is simpler and doesn't require a network port.

Add the following entry to your `claude_desktop_config.json` file (can be found via Settings / Developer / Edit Config):

```json
{
  "mcpServers": {
    "comunica-sparql-hdt": {
      "command": "npx",
      "args": [
        "-y",
        "@comunica/mcp-sparql-hdt",
        "--mode",
        "stdio"
      ]
    }
  }
}
```

#### HTTP Mode

Alternatively, you can run the MCP server in HTTP mode, which requires starting the server manually first:

```bash
$ comunica-mcp-sparql-hdt --mode http --port 3123
```

Then, add the following entry to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "comunica-sparql-hdt": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:3123/mcp",
        "--allow-http"
      ]
    }
  }
}
```

Then, you can ask Claude something like the following:

> Use Comunica SPARQL HDT to query the DBpedia HDT file at /path/to/dbpedia.hdt and find all movies directed by Christopher Nolan.

#### Default Sources

You can optionally configure default HDT sources when starting the MCP server. When default sources are provided, the `sources` parameter is hidden from the tools, and all queries automatically use the configured sources.

This is useful when you want to restrict queries to specific HDT files.

**Stdio Mode with Default Sources:**

```json
{
  "mcpServers": {
    "comunica-sparql-hdt": {
      "command": "npx",
      "args": [
        "-y",
        "@comunica/mcp-sparql-hdt",
        "--mode",
        "stdio",
        "/path/to/dbpedia.hdt"
      ]
    }
  }
}
```

**HTTP Mode with Default Sources:**

```bash
$ comunica-mcp-sparql-hdt --mode http --port 3123 /path/to/dbpedia.hdt
```

### Claude Code

#### Stdio Mode (Recommended for Claude Code)

With stdio mode, the MCP server communicates directly via standard input/output, which is simpler and doesn't require a network port.

```bash
claude mcp add --transport stdio sparql-hdt -- npx -y @comunica/mcp-sparql-hdt --mode stdio
```

Learn more in the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp),
such as for running this on Windows.

#### HTTP Mode

Alternatively, you can run the MCP server in HTTP mode, which requires starting the server manually first:

```bash
$ comunica-mcp-sparql-hdt --mode http --port 3123
```

```bash
claude mcp add --transport http sparql-hdt http://localhost:3123/mcp
```

### ChatGPT

At the time of writing, ChatGPT only supports HTTP-based MCP servers.
So you'll need to run this tool under HTTP mode and expose it to the public Web,
possibly combined with a reverse proxy and/or OAuth layer.

```bash
$ comunica-mcp-sparql-hdt --mode http --port 3123
```

## Available Tools

This MCP server provides the following tools:

### query_sparql

Execute SPARQL queries over one or more HDT files or remote HDT endpoints, which also includes update queries.

**Parameters:**
- `query` (required): SPARQL query string
- `sources` (required, unless default sources are configured): List of HDT file paths or HDT endpoint URLs
- `queryFormatLanguage` (optional): Query language (e.g., `sparql`, `graphql`). Allows you to specify alternative query languages supported by Comunica
- `queryFormatVersion` (optional): Query language version (e.g., `1.0`, `1.1`, `1.2`). Specifies the version of the query language to use
- `baseIRI` (optional): Base IRI for resolving relative IRIs in the query
- `httpProxy` (optional): HTTP proxy URL (e.g., `http://proxy.example.com:8080`)
- `httpAuth` (optional): HTTP basic authentication in the format `username:password`
- `httpTimeout` (optional): HTTP request timeout in milliseconds
- `httpRetryCount` (optional): Number of HTTP request retries on failure

**Note:** When the MCP server is started with default sources, the `sources` parameter is not available, and all queries automatically use the configured default sources.

### query_sparql_rdf

Execute SPARQL queries over a serialized RDF dataset provided as a string (useful for querying Turtle, N-Triples, or other RDF formats directly).

**Parameters:**
- `query` (required): SPARQL query string
- `value` (required): Serialized RDF dataset as a string
- `mediaType` (required): Media type of the serialized RDF dataset (e.g., `text/turtle`, `application/n-triples`, `application/ld+json`)
- `fileBaseIRI` (optional): Base IRI for resolving relative IRIs in the RDF dataset
- `baseIRI` (optional): Base IRI for resolving relative IRIs in the query
- `queryFormatLanguage` (optional): Query language (e.g., `sparql`, `graphql`). Allows you to specify alternative query languages supported by Comunica
- `queryFormatVersion` (optional): Query language version (e.g., `1.0`, `1.1`, `1.2`). Specifies the version of the query language to use

## Learn more

This README just shows the tip of the iceberg!
Learn more about Comunica's functionalities in the following guides:

* _[*Full documentation*](https://comunica.dev/docs/)_
