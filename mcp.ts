// The MCP endpoint: Streamable HTTP JSON-RPC speaking the modern
// server/discover era (2026-07-28) with the legacy initialize handshake
// kept as a fallback. The six tools work on the same forge store as the
// REST and GraphQL surfaces, so an object made by one is the same object
// in all three.

import { VIEWER, type Forge, type Repo } from './store.ts';
import { issueJson, mergePullCore, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'ghforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });

/** The tool list is a frozen constant: two tools/list calls are byte-identical. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the given user (the token owner by default).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The login of the repository owner'),
        name: str('The repository name'),
        description: str('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The login of the repository owner'),
        repo: str('The repository name'),
      },
      required: ['repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The login of the repository owner'),
        repo: str('The repository name'),
        title: str('The issue title'),
        body: str('The issue body'),
      },
      required: ['repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The login of the repository owner'),
        repo: str('The repository name'),
        state: str('The state filter: open, closed or all'),
      },
      required: ['repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The login of the repository owner'),
        repo: str('The repository name'),
        title: str('The pull request title'),
        body: str('The pull request body'),
        head: str('The head branch name'),
        base: str('The base branch name'),
      },
      required: ['repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The login of the repository owner'),
        repo: str('The repository name'),
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['repo', 'pull_number'],
    },
  },
]);

export interface McpReply {
  status: number;
  body?: unknown;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value) ?? 'null';
  const out: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.structuredContent = value;
  return out;
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function lookupRepo(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  const owner = argString(args, 'owner') || VIEWER.login;
  const repo = argString(args, 'repo');
  return forge.getRepo(owner, repo);
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): McpReply | null {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return null;
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return rpcError(null, -32602, `Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const owner = argString(args, 'owner') || VIEWER.login;
      const repoName = argString(args, 'name');
      const existing = forge.getRepo(owner, repoName);
      if (existing) return rpcResult(null, toolResult(repoJson(forge, existing)));
      const repo = forge.createRepo(owner, repoName, {
        description: argString(args, 'description'),
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return rpcResult(null, toolResult(repoJson(forge, repo)));
    }
    case 'get_repo': {
      const repo = lookupRepo(forge, args);
      if (!repo) return rpcResult(null, toolFailure('Repository not found'));
      return rpcResult(null, toolResult(repoJson(forge, repo)));
    }
    case 'create_issue': {
      const repo = lookupRepo(forge, args);
      if (!repo) return rpcResult(null, toolFailure('Repository not found'));
      const item = forge.newItem(repo, { kind: 'issue', title: argString(args, 'title'), body: argString(args, 'body') });
      return rpcResult(null, toolResult(issueJson(forge, repo, item)));
    }
    case 'list_issues': {
      const repo = lookupRepo(forge, args);
      if (!repo) return rpcResult(null, toolFailure('Repository not found'));
      const state = argString(args, 'state') || 'open';
      const items = [...repo.items.values()]
        .filter((item) => item.kind === 'issue')
        .filter((item) => state === 'all' || item.state === state)
        .sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
      return rpcResult(null, toolResult(items.map((item) => issueJson(forge, repo, item))));
    }
    case 'create_pull_request': {
      const repo = lookupRepo(forge, args);
      if (!repo) return rpcResult(null, toolFailure('Repository not found'));
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return rpcResult(null, toolFailure('Head or base branch does not exist'));
      const item = forge.newItem(repo, {
        kind: 'pull',
        title: argString(args, 'title'),
        body: argString(args, 'body'),
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return rpcResult(null, toolResult(pullJson(forge, repo, item)));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(forge, args);
      if (!repo) return rpcResult(null, toolFailure('Repository not found'));
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(argString(args, 'pull_number'), 10);
      const item = Number.isFinite(number) ? repo.items.get(number) : undefined;
      if (!item || item.kind !== 'pull') return rpcResult(null, toolFailure('Pull request not found'));
      const result = mergePullCore(forge, repo, item, 'squash');
      if (typeof result !== 'object' || result === null) return rpcResult(null, toolFailure('Pull request is not mergeable'));
      return rpcResult(null, toolResult(pullJson(forge, repo, item)));
    }
    default:
      return null;
  }
}

/** Handle one JSON-RPC message; `id` is threaded back onto the reply. */
function handleMessage(forge: Forge, message: Record<string, unknown>): McpReply {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const reply = callTool(forge, name, args);
      if (reply === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
      // Thread the caller's id onto the tool reply.
      const body = reply.body as Record<string, unknown>;
      return { status: 200, body: { ...body, id: id ?? null } };
    }
    default:
      if (isNotification) return { status: 202 };
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp body (raw text, so a parse failure is a -32700). */
export function handleMcp(forge: Forge, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      if (entry !== null && typeof entry === 'object') {
        const reply = handleMessage(forge, entry as Record<string, unknown>);
        if (reply.body !== undefined) replies.push(reply.body);
      }
    }
    return { status: 200, body: replies };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
    };
  }
  const message = parsed as Record<string, unknown>;
  if (message.id === undefined && typeof message.method === 'string') {
    // A notification: accept it and answer with no body.
    handleMessage(forge, message);
    return { status: 202 };
  }
  return handleMessage(forge, message);
}
