# opencode-openmemory

[![CI](https://github.com/djbunting/opencode-openmemory/actions/workflows/ci.yml/badge.svg)](https://github.com/djbunting/opencode-openmemory/actions/workflows/ci.yml)
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
                    │ MCP — stdio (spawned) or HTTP (remote)
                    v
┌───────────────────────────────────────────────────────────────┐
│                     OpenMemory Server                          │
│  - Store: raw notes / facts / events / snippets                │
│  - Index: embeddings + metadata (scope/recency/type)           │
│  - Retrieval: hybrid scoring (similarity + salience + decay)   │
│  - Local:  npx -y openmemory-js mcp                            │
│  - Remote: mcpUrl -> http://host:8800/mcp                      │
└───────────────────────────────────────────────────────────────┘
```

The plugin talks to OpenMemory over **MCP**, not the REST API. This matters:
OpenMemory's REST API (v1.2+) derives identity from the API key and rejects any
request supplying its own `user_id`, so it cannot separate project memory from
user memory under a single key. MCP can — over stdio it accepts both
identifiers, and over HTTP it still honours `project_id`.

By default it spawns a local server. Set `mcpUrl` to use one you already run,
which keeps memories on your own server *and* preserves per-project scoping.
See [Choosing a deployment](#choosing-a-deployment) for the tradeoffs.

## Requirements

- **OpenCode** with plugin API `1.18` or newer (this plugin uses the native
  `experimental.session.compacting` hook)
- **Bun** — to build from source
- **`npx` on your PATH** — only for the default local backend, which downloads
  and runs `openmemory-js` on first use. Not needed if you set `mcpUrl` to point
  at a server you already run.
- An **embeddings provider** is optional; OpenMemory falls back to a local
  synthetic embedder if you don't configure one.

## Installation

> **This fork is not published to npm.** Install from source using Option A
> below. Option B is for after you publish it under your own scope.

### Option A — from source (current)

```bash
git clone https://github.com/djbunting/opencode-openmemory.git
cd opencode-openmemory
bun install
bun run build
```

Then drop the built plugin into OpenCode's global plugin directory. Every
file in that directory is loaded automatically — no `opencode.json` entry
is needed.

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/opencode-openmemory.js
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"
Copy-Item dist\index.js "$env:USERPROFILE\.config\opencode\plugins\opencode-openmemory.js"
```

The build is a self-contained ES module, so it needs no `node_modules`
beside it. For a single project instead of every project, use that
project's `.opencode/plugins/` directory.

To also get the `/openmemory-init` slash command and a starter config file,
run the bundled installer from the clone:

```bash
node dist/cli.js install
```

It writes `~/.config/opencode/command/openmemory-init.md` and
`~/.config/opencode/openmemory.jsonc`. It will *also* add an npm plugin
entry to your `opencode.json` — remove that line while installing from
source, or OpenCode will fail trying to resolve an unpublished package.

### Option B — from npm (once published)

```bash
bunx @djbunting/opencode-openmemory@latest install
```

Or add it manually to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["@djbunting/opencode-openmemory@latest"]
}
```

### Restart OpenCode

Plugins are loaded at startup, so restart before testing.

## Configuration

Configuration is optional — the defaults work with no config file at all.
To change anything, create `~/.config/opencode/openmemory.jsonc`:

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

### Options reference

| Option | Default | Description |
|---|---|---|
| `backend` | `"mcp"`\* | `"mcp"` uses the MCP protocol; `"rest"` uses the REST API |
| `mcpUrl` | — | HTTP MCP endpoint of a running server (e.g. `http://host:8800/mcp`). Set this to use a remote server instead of spawning a local one |
| `mcpHeaders` | derived | Headers for `mcpUrl`. Defaults to `Authorization: Bearer <apiKey>` when `apiKey` is set |
| `mcpCommand` | `"npx"` | Executable used to spawn a local server (ignored when `mcpUrl` is set) |
| `mcpArgs` | `["-y","openmemory-js","mcp"]` | Arguments passed to `mcpCommand` |
| `mcpEnv` | — | Extra env vars for the spawned server, merged over the parent environment |
| `mcpTimeout` | `30000` | Timeout (ms) for one MCP tool call |
| `mcpConnectTimeout` | `60000` | Timeout (ms) for spawn + handshake |
| `apiUrl` | `http://localhost:8080` | REST server URL (`backend: "rest"` only) |
| `apiKey` | — | REST API key (`backend: "rest"` only); also read from `OPENMEMORY_API_KEY` |
| `maxMemories` | `5` | Relevant user memories injected per session |
| `maxProjectMemories` | `10` | Project memories injected per session |
| `maxProfileItems` | `5` | Profile facts injected per session |
| `minSalience` | `0.3` | Salience floor for automatic injection (explicit searches ignore it) |
| `injectProfile` | `true` | Whether to inject the user profile at all |
| `scopePrefix` | `"opencode"` | Namespace prefix for memory scope keys |
| `projectId` | derived | Pins the project scope to a fixed name. Best set per project — see [Sharing a scope](#sharing-a-scope-with-other-openmemory-clients) |

\* Backend resolution, in order: an explicit `backend` wins; then `mcpUrl`
implies `"mcp"`; then `apiUrl`/`apiKey` imply `"rest"`; otherwise `"mcp"`. The
`apiUrl`/`apiKey` rule exists because configs predating the `backend` option
were pointing at a REST server, and silently moving them to a local store would
make every existing memory look like it had vanished.

Environment variables `OPENMEMORY_BACKEND`, `OPENMEMORY_MCP_URL`,
`OPENMEMORY_API_URL` and `OPENMEMORY_API_KEY` are honoured when the
corresponding file option is absent.

### Choosing a deployment

There are three shapes, and they differ in where memories live and whether
projects stay isolated from one another.

| | Storage | Project isolation | Notes |
|---|---|---|---|
| **Local MCP** (default) | On this machine | Yes | Spawns `openmemory-js mcp`. Nothing to run yourself. |
| **Remote MCP** (`mcpUrl`) | Your server | Yes | Best of both: shared server, real per-project scoping. |
| **REST** (`apiUrl`) | Your server | **No** | One flat scope per API key. |

Isolation differs because of how OpenMemory handles identity. A local stdio
server has no request carrying an API key, so it trusts the `user_id` we send.
A remote server derives the user from the API key and rejects a supplied
`user_id` outright — but it still honours a client-supplied `project_id`, which
is what keeps project scoping working over MCP. The REST API offers no
equivalent, so everything there shares one scope.

### Connecting to a remote OpenMemory server

Point `mcpUrl` at the server's `/mcp` endpoint. Setting it is enough to select
the MCP backend:

```jsonc
{
  "mcpUrl": "http://192.168.1.170:8800/mcp",
  "apiKey": "your-server-api-key",

  "maxMemories": 5,
  "maxProjectMemories": 10,
  "injectProfile": true
}
```

`apiKey` is promoted to `Authorization: Bearer …` automatically; use
`mcpHeaders` instead if your server expects something else. Project memories
are filed under a `project_id` derived from OpenCode's project identity, and
cross-project ("user" scope) memories go to OpenMemory's shared
`system_global` bucket, so they stay visible from every project.

The plugin detects at connect time whether the server supports `project_id`.
Older servers — including the current `openmemory-js` on npm — don't, and it
transparently falls back to folding the project into the `user_id` instead.
That fallback cannot work against a remote server, which pins `user_id` to the
API key; in that combination you get one flat scope, same as REST.

### Sharing a scope with other OpenMemory clients

By default the project scope is derived from OpenCode's own project identity,
which is stable but opaque. Other OpenMemory clients — the MCP server wired
directly into `opencode.json`, an IDE extension, your own scripts — typically
use a readable name like `handheldlive`. Those are different scopes, so the
plugin would not see memories written under the readable name.

To share one scope, pin it per project in `<project>/.opencode/openmemory.jsonc`:

```jsonc
{
  "projectId": "handheldlive"
}
```

Now the plugin reads and writes the same `project_id` as everything else
pointing at that name. Resolution order is: this file, then a global
`projectId`, then OpenCode's project id, then a hash of the worktree path.

Only `projectId` is read from the project-local file; every other option stays
per-machine in `~/.config/opencode/openmemory.jsonc`.

### Using an embeddings provider

The spawned MCP server reads its own configuration from the environment, so
pass provider settings through `mcpEnv`:

```jsonc
{
  "mcpEnv": {
    "OM_EMBEDDINGS": "openai",
    "OPENAI_API_KEY": "sk-...",
    "OM_TIER": "hybrid"
  }
}
```

Keep real keys out of version control — set them in your environment and
they will be inherited by the spawned server without appearing in this file.

### REST backend requires an API key

OpenMemory's REST API derives tenant identity from the API key and returns
`503` when the server has no key configured, so `backend: "rest"` is useless
without an `apiKey`. If you set `"backend": "rest"` and don't supply one
(either `apiKey` in this file or the `OPENMEMORY_API_KEY` environment
variable), the plugin **disables itself** and silently does nothing rather
than firing failing requests on every session. The default `"mcp"` backend
needs no key — only a runnable `mcpCommand` (defaults to `npx`).

REST mode also has no user-vs-project scope split, because that API refuses
client-supplied scope identifiers. Everything lands in one flat scope per key.

## Verify it's working

After restarting OpenCode, ask the agent:

```
Use the openmemory tool with mode "help"
```

A usage guide means the plugin is loaded. Then try a round trip:

```
Remember that this project builds with `bun run build`
```

Start a **new** session in the same directory and ask what it remembers
about building the project — the memory should come back. Memories are
scoped per project, so a different project deliberately won't see it.

## Troubleshooting

The plugin logs everything to `~/.opencode-openmemory.log`. Check it first.

**Nothing is injected and the log is empty** — the plugin isn't loaded.
Confirm the file is in `~/.config/opencode/plugins/` and that you restarted
OpenCode.

**`Plugin disabled - OpenMemory not configured`** — you set
`backend: "rest"` without an API key. Supply `apiKey`, or switch back to
`"mcp"`.

**First message is slow** — a cold `npx -y openmemory-js mcp` downloads the
package, measured at roughly 26 seconds. The plugin pre-warms the backend at
startup and caps first-message injection at 10 seconds, so it degrades to
"no memory this turn" rather than blocking you; it retries on the next
message. Subsequent runs are fast.

**`MCP server connect timed out`** — `npx` can't fetch `openmemory-js`.
Verify network access and that `npx -y openmemory-js mcp` runs by hand.
Point `mcpCommand`/`mcpArgs` at a local install if you'd rather pin it.

**Leftover `openmemory-js` processes** — the plugin runs one MCP server per
session and shuts it down on exit, including on Ctrl+C. A server can only be
left behind if OpenCode is killed outright (`SIGKILL` / `Stop-Process -Force`),
since no cleanup can run in that case. Find any strays with
`ps aux | grep openmemory-js` (or `Get-Process node` on Windows).

**Memories from an older version disappeared** — project scope identity
changed to use OpenCode's stable project id instead of a hash of the
directory path. The old scheme produced different ids for `C:\p`, `C:/p` and
`c:\p`, so memories were already fragmented. There is no migration.

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
| `list` | List recent memories | `scope?`, `sector?`, `limit?` |
| `forget` | Remove a memory | `memoryId`, `scope?` |
| `reinforce` | Boost a memory's salience | `memoryId`, `boost?` |
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

# Type check (covers src and test)
bun run typecheck

# Run tests
bun test

# Build
bun run build

# Development (watch mode)
bun run dev
```

To iterate against a real OpenCode session, symlink the build into the
global plugin directory once, then just rebuild and restart:

```bash
# macOS / Linux
ln -sf "$PWD/dist/index.js" ~/.config/opencode/plugins/opencode-openmemory.js
```

```powershell
# Windows (PowerShell, needs an elevated shell or Developer Mode)
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.config\opencode\plugins\opencode-openmemory.js" `
  -Target "$PWD\dist\index.js"
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
