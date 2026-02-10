# Comunica MCP SPARQL Solid

[![npm version](https://badge.fury.io/js/%40comunica%2Fmcp-sparql-solid.svg)](https://www.npmjs.com/package/@comunica/mcp-sparql-solid)

Comunica MCP SPARQL Solid is an [MCP server](https://modelcontextprotocol.io/) for allowing AI agents to execute SPARQL queries over [Solid](https://solidproject.org/) data pods with authentication support.

Solid (Social Linked Data) is a specification for decentralized data storage and personal data management. This MCP server enables authenticated access to private Solid pods.

It's main distinguishing features are the following:

* Improves the accuracy of your AI agent's answers by leveraging the power of SPARQL and Knowledge Graphs.
* Execute [SPARQL 1.2](https://www.w3.org/TR/sparql12-query/) queries over Solid data pods.
* Interactive authentication with Solid identity providers.
* Access both public and private Solid resources.
* Query over federated Solid pods with single sign-on.

**[Learn more about Comunica on our website](https://comunica.dev/).**

_Internally, this is a [Comunica module](https://comunica.dev/) that is configured with modules to execute SPARQL queries over Solid pods through MCP._

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
your agent can SPARQL query Solid data pods, including private resources.

For example, use it to ask:

> Use Comunica SPARQL Solid to query my personal Solid pod and find all my contacts.

### Prompt suggestions

If you want your agent to always use SPARQL for higher accuracy in answers, you can tell it the following:

> When looking up data from Solid pods, always prefer using SPARQL queries as this is more precise.
> Solid pods may contain private data that requires authentication, so make sure to use the authenticated query engine.
> Since SPARQL queries can take a while to execute, start producing an approximate answer yourself and show it to me if the SPARQL query takes more than 1 second, but then make the answer more concrete based on the SPARQL query once it finalized, as it will be more accurate.

## Installation

Comunica requires [Node.JS](http://nodejs.org/) 14.0 or higher and is tested on OSX and Linux.

The easiest way to install the client is by installing it from NPM as follows:

```bash
$ [sudo] npm install -g @comunica/mcp-sparql-solid
```

Alternatively, you can install from the latest GitHub sources.
For this, please refer to the README of the [Comunica monorepo](https://github.com/comunica/comunica).
If you do so, the following examples require replacing `comunica-mcp-sparql-solid` with `node engines/mcp-sparql-solid/bin/mcp.js`.

## Important: HTTP Mode Only

**Note:** Due to the interactive nature of Solid authentication, this MCP server only supports HTTP mode. Stdio mode is not available as it cannot handle the interactive login flow required for Solid authentication.

## Connect this MCP server to your agent

Below, a non-exhaustive list of examples is given to connect this MCP server to your agent.

### Claude Desktop

After installing, you need to run the MCP server in HTTP mode:

#### HTTP Mode with Authentication

First, start the server manually:

```bash
$ comunica-mcp-sparql-solid --mode http --port 3123
```

This will prompt you to authenticate with your Solid identity provider. Follow the interactive login instructions in your terminal.

Then, add the following entry to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "comunica-sparql-solid": {
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

> Using Comunica SPARQL Solid, can you show me information about myself based on my profile?

#### Custom Identity Provider

You can specify a custom Solid identity provider using the `--idp` flag:

```bash
$ comunica-mcp-sparql-solid --mode http --port 3123 --idp https://login.inrupt.com/
```

#### Disable Authentication

If you only need to query public Solid resources, you can disable authentication:

```bash
$ comunica-mcp-sparql-solid --mode http --port 3123 --idp void
```

#### Default Sources

You can optionally configure default Solid pod URLs when starting the MCP server:

```bash
$ comunica-mcp-sparql-solid --mode http --port 3123 https://example.solidcommunity.net/profile/card
```

### Claude Code

#### HTTP Mode

Run the MCP server in HTTP mode, which requires starting the server manually first:

```bash
$ comunica-mcp-sparql-solid --mode http --port 3123
```

Then add it to Claude Code:

```bash
claude mcp add --transport http sparql-solid http://localhost:3123/mcp
```

Learn more in the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

### ChatGPT

At the time of writing, ChatGPT only supports HTTP-based MCP servers.
So you'll need to run this tool under HTTP mode and expose it to the public Web,
possibly combined with a reverse proxy and/or OAuth layer.

```bash
$ comunica-mcp-sparql-solid --mode http --port 3123
```

## Available Tools

This MCP server provides the following tools:

### query_sparql

Execute SPARQL queries over one or more Solid pods or SPARQL endpoints, which also includes update queries.

**Parameters:**
- `query` (required): SPARQL query string
- `sources` (required, unless default sources are configured): List of Solid pod URLs or SPARQL endpoint URLs
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

## Authentication Flow

When you start the MCP server with authentication enabled (default), you will be prompted to:

1. Visit a URL in your web browser
2. Log in to your Solid identity provider
3. Authorize the application
4. The server will automatically receive the authentication token

Once authenticated, all queries will be executed with your Solid credentials, allowing access to private resources.

## Learn more

This README just shows the tip of the iceberg!
Learn more about Comunica's functionalities in the following guides:

* _[*Full documentation*](https://comunica.dev/docs/)_
* _[*Solid documentation*](https://solidproject.org/)_
