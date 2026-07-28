# opencode-openmemory

[![npm version](https://badge.fury.io/js/@djbunting%2Fopencode-openmemory.svg)](https://www.npmjs.com/package/@djbunting%2Fopencode-openmemory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Local-first, privacy-focused persistent memory for OpenCode agents** using [OpenMemory](https://github.com/CaviraOSS/OpenMemory).

A fork of [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory), redesigned to work with OpenMemory - an open-source, self-hosted cognitive memory engine that keeps your data on your machine.

## Features

- **Local-first**: All memories stored on your machine via OpenMemory
- **Privacy-focused**: No data sent to external services
- **Automatic context injection**: User profile, project memory, and relevant memories injected into conversations
- **Explicit & implicit memory capture**: Save memories with "remember this" or let the agent extract knowledge automatically
- **Scope separation**: User-level (cross-project) vs project-level memories
- **Context compaction**: Smart summarization when context window fills up

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                   OpenCode (Plugin)                           │
│  - Injection Policy (format, token budget, priority)          │
│  - Memory Capture Policy (explicit "remember", implicit)      │
│  - Scope Router (user_id, project_id)                         │
└───────────────────┬───────────────────────────────────────────┘
                    │ MCP (stdio, spawned on demand)
                    v
┌───────────────────────────────────────────────────────────────┐
│              OpenMemory MCP Server (local process)             │
│  - Store: raw notes / facts / events / snippets                │
│  - Index: embeddings + metadata (scope/recency/type)           │
│  - Retrieval: hybrid scoring (similarity + salience + decay)   │
│  - Spawned via: npx -y openmemory-js mcp                       │
└───────────────────────────────────────────────────────────────┘
```

By default the plugin talks to OpenMemory over **MCP** (spawning
`openmemory-js mcp` as a local child process), not the REST API. This
matters: OpenMemory's REST API (v1.2+) derives tenant identity from the
API key itself and rejects any request that tries to set its own
`user_id`, so it has no way to separate "project" memory from "user"
memory under a single key. The MCP stdio transport has no such
restriction, so it's what makes this plugin's project/user scope split
actually work. See [Configuration](#configuration) if you want to point
at a hosted/shared REST server instead (with the tradeoff that all
memories share one flat scope).

## Installation

### 1. Install the plugin

```bash
bunx @djbunting/opencode-openmemory@latest install
```

Or manually add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["@djbunting/opencode-openmemory@latest"]
}
```

### 2. Make sure OpenMemory is runnable

The default (MCP) backend spawns `npx -y openmemory-js mcp` on first use —
no separate server process to manage, as long as `npx` can reach the
package (first run will download it). Set an embedding provider via
`mcpEnv` in your config if you're not using the synthetic/local default
(see [Configuration](#configuration)).

If you'd rather run a persistent shared server, see the
[OpenMemory documentation](https://github.com/CaviraOSS/OpenMemory) for
Docker/manual setup, then switch `backend` to `"rest"` below.

### 3. Restart OpenCode

## Configuration

Create `~/.config/opencode/openmemory.jsonc`:

```jsonc
{
  // "mcp" (default): spawns a local OpenMemory MCP server on demand.
  //   Supports real user-vs-project memory scoping.
  // "rest": talks to a hosted/shared OpenMemory REST server. That API
  //   scopes everything to the API key, so there's no user/project split.
  "backend": "mcp",

  // MCP backend settings (only used when backend is "mcp")
  "mcpCommand": "npx",
  "mcpArgs": ["-y", "openmemory-js", "mcp"],
  "mcpEnv": {
    // "OM_EMBEDDINGS": "openai",
    // "OPENAI_API_KEY": "..."
  },
  // Timeout (ms) for a single MCP tool call
  "mcpTimeout": 30000,
  // Timeout (ms) for the initial spawn + handshake. Higher than mcpTimeout
  // because a cold `npx -y openmemory-js mcp` downloads the package first
  // (a measured cold start took ~26s).
  "mcpConnectTimeout": 60000,

  // REST backend settings (only used when backend is "rest")
  // "apiUrl": "http://localhost:8080",
  // "apiKey": "your-api-key",

  // Search settings
  "maxMemories": 5,
  "maxProjectMemories": 10,
  "maxProfileItems": 5,
  "minSalience": 0.3,
  
  // Context injection
  "injectProfile": true,
  
  // Scope prefix for organizing memories
  "scopePrefix": "opencode"
}
```

### REST backend requires an API key

OpenMemory's REST API derives tenant identity from the API key and returns
`503` when the server has no key configured, so `backend: "rest"` is useless
without an `apiKey`. If you set `"backend": "rest"` and don't supply one
(either `apiKey` in this file or the `OPENMEMORY_API_KEY` environment
variable), the plugin **disables itself** and silently does nothing rather
than firing failing requests on every session. The default `"mcp"` backend
needs no key — only a runnable `mcpCommand` (defaults to `npx`).

## Usage

### Automatic Context Injection

On the first message of each session, the plugin automatically injects:

1. **User Profile**: Cross-project preferences and patterns
2. **Project Knowledge**: Project-specific memories from the current directory
3. **Relevant Memories**: Semantically similar memories to the current query

### Explicit Memory Saving

Use trigger phrases to save memories:

```
"Remember that we use Prettier with single quotes"
"Save this: always run tests before committing"
"Keep in mind that the auth service is in /src/lib/auth"
```

### Tool Commands

The `openmemory` tool is available with these modes:

| Mode | Description | Arguments |
|------|-------------|-----------|
| `add` | Store a new memory | `content`, `type?`, `scope?` |
| `search` | Search memories | `query`, `scope?`, `limit?` |
| `profile` | View user profile | `query?` |
| `list` | List recent memories | `scope?`, `limit?` |
| `forget` | Remove a memory | `memoryId`, `scope?` |
| `help` | Show usage guide | - |

**Scopes:**
- `user`: Cross-project preferences and knowledge
- `project`: Project-specific knowledge (default)

**Memory Types:**
- `project-config`: Tech stack, commands, tooling
- `architecture`: Codebase structure, components, data flow
- `learned-pattern`: Conventions specific to this codebase
- `error-solution`: Known issues and their fixes
- `preference`: Coding style preferences
- `conversation`: Session summaries

### Initialize Memory

Run the `/openmemory-init` command to deeply research your codebase and populate memory:

```
/openmemory-init
```

## Context Compaction

OpenCode decides when to compact and drives the summarization itself. This
plugin hooks into that process rather than replacing it:

1. On `experimental.session.compacting`, it appends project knowledge from
   OpenMemory plus a structured outline (original requests, final goal, work
   completed, remaining tasks, hard constraints) to the compaction prompt
2. OpenCode summarizes and auto-continues the conversation natively
3. When the summary lands, the plugin saves it as a `conversation` memory so
   it survives into future sessions

Earlier versions detected the threshold, triggered summarization, and
re-prompted the session themselves by writing synthetic messages into
OpenCode's on-disk storage. That approach broke when OpenCode moved its
message store, and is no longer used.

## Usage with Oh My OpenCode

If you're using [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode)
and see compaction happening twice, disable its context-recovery hook so
OpenCode's native compaction is the only thing driving it:

Add to `~/.config/opencode/oh-my-opencode.json`:

```json
{
  "disabled_hooks": ["anthropic-context-window-limit-recovery"]
}
```

## Development

```bash
# Clone
git clone https://github.com/djbunting/opencode-openmemory.git
cd opencode-openmemory

# Install dependencies
bun install

# Type check
bun run typecheck

# Build
bun run build

# Development (watch mode)
bun run dev

# Local testing with OpenCode
bun run build && opencode --plugin ./dist/index.js
```

## Comparison with opencode-supermemory

| Feature | opencode-supermemory | @djbunting/opencode-openmemory |
|---------|---------------------|-------------------------------------|
| Backend | Supermemory Cloud | OpenMemory (local) |
| Data Location | Cloud | Your machine |
| Privacy | Requires API key | Fully local |
| Cost | API usage fees | Free (self-hosted) |

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Credits

- Originally created by [@happycastle114](https://github.com/happycastle114) as
  [happycastle114/opencode-openmemory](https://github.com/happycastle114/opencode-openmemory);
  this is a fork maintained by [@djbunting](https://github.com/djbunting)
- Based on [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory) by Supermemory
- Uses [OpenMemory](https://github.com/CaviraOSS/OpenMemory) by CaviraOSS

## Special Thanks

- [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode) - This plugin was developed using Oh My OpenCode's powerful agent orchestration capabilities
