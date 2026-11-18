// The GraphQL v4 surface: a small parser and executor for the document
// shapes `gh` and the GitHub MCP server send — viewer, repository, issues,
// pull requests, node(id:) lookups, the introspection probes gh feature-
// detects with, and the issue/pull-request/comment mutations. It resolves
// against the same forge store as REST, so both views always agree.

import {
  VIEWER,
  commitTree,
  diffTrees,
  mergeBase,
  mergeTrees,
  type Forge,
  type Item,
  type Repo,
} from './store.ts';
import { mergePullCore } from './rest.ts';

// ---------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------

export function globalId(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

export function decodeGlobalId(gid: string): { type: string; id: string } | null {
  try {
    const text = Buffer.from(gid, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), id: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function findRepoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findItemById(forge: Forge, id: number): { repo: Repo; item: Item } | undefined {
  for (const repo of forge.repos.values()) {
    for (const item of repo.items.values()) if (item.id === id) return { repo, item };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | undefined;
  name: string;
  args: Map<string, Value>;
  selectionSet: SelectionNode[] | undefined;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | undefined;
  varDefaults: Map<string, Value>;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class ParseError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new ParseError('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseError('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: undefined, varDefaults: new Map(), selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        const varDefaults = new Map<string, Value>();
        if (this.peek() === '(') this.parseVariableDefinitions(varDefaults);
        this.skipDirectives();
        operations.push({
          type: head === 'mutation' ? 'mutation' : 'query',
          name,
          varDefaults,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new ParseError(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, Value>): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.next();
      this.expect(':');
      this.parseType();
      if (this.peek() === '=') {
        this.next();
        defaults.set(name, this.parseValue());
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.peek() === '(' ? this.parseArguments() : new Map<string, Value>();
      this.skipDirectives();
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>, defaults: Map<string, Value>): unknown {
  switch (value.kind) {
    case 'var': {
      const given = variables[value.name];
      if (given !== undefined) return given;
      const fallback = defaults.get(value.name);
      return fallback ? resolveValue(fallback, variables, defaults) : undefined;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables, defaults);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface GNode {
  type: string;
  ref: unknown;
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  defaults: Map<string, Value>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

const node = (type: string, ref: unknown): GNode => ({ type, ref });

function argOf(ctx: ExecContext, field: FieldNode, name: string): unknown {
  const value = field.args.get(name);
  return value === undefined ? undefined : resolveValue(value, ctx.variables, ctx.defaults);
}

function argString(ctx: ExecContext, field: FieldNode, name: string): string {
  const value = argOf(ctx, field, name);
  return typeof value === 'string' ? value : '';
}

function argInt(ctx: ExecContext, field: FieldNode, name: string): number | undefined {
  const value = argOf(ctx, field, name);
  return typeof value === 'number' ? value : undefined;
}

interface Connection {
  nodes: GNode[];
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function connect(items: GNode[], field: FieldNode, ctx: ExecContext): Connection {
  const first = argInt(ctx, field, 'first');
  const after = argOf(ctx, field, 'after');
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) start = Number.parseInt(match[1] as string, 10) + 1;
    } catch {
      start = 0;
    }
  }
  const limit = first === undefined ? items.length : Math.max(0, first);
  const slice = items.slice(start, start + limit);
  const lastIndex = start + slice.length - 1;
  return {
    nodes: slice,
    total: items.length,
    hasNextPage: start + slice.length < items.length,
    endCursor: slice.length ? cursorOf(lastIndex) : null,
  };
}

function connectionNode(type: string, connection: Connection): GNode {
  return node(type, connection);
}

function issueState(item: Item): string {
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(item: Item): string {
  if (item.merged) return 'MERGED';
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(forge: Forge, repo: Repo, item: Item): string {
  if (item.state !== 'open' || item.merged) return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${item.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${item.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const base = mergeBase(forge.store, baseTip, headTip);
  if (!base) return 'CONFLICTING';
  const merged = mergeTrees(
    forge.store,
    commitTree(forge.store, base),
    commitTree(forge.store, baseTip),
    commitTree(forge.store, headTip),
  );
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'locked'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'url', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'stargazerCount', 'forkCount'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'createdAt'],
  Organization: ['id', 'databaseId', 'login', 'name', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'committedDate'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'PULL_REQUEST'];

type Resolver = (ctx: ExecContext, source: GNode, field: FieldNode) => unknown;

const resolvers: Record<string, Resolver> = {
  Query: (ctx, _source, field) => {
    const { forge } = ctx;
    switch (field.name) {
      case 'viewer':
        return node('User', { login: VIEWER.login });
      case 'repository': {
        const repo = forge.getRepo(argString(ctx, field, 'owner'), argString(ctx, field, 'name'));
        return repo ? node('Repository', repo) : null;
      }
      case 'node': {
        const decoded = decodeGlobalId(argString(ctx, field, 'id'));
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoById(forge, Number.parseInt(decoded.id, 10));
          return repo ? node('Repository', repo) : null;
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const found = findItemById(forge, Number.parseInt(decoded.id, 10));
          if (!found) return null;
          return node(found.item.kind === 'issue' ? 'Issue' : 'PullRequest', { repo: found.repo, item: found.item });
        }
        if (decoded.type === 'User') return node('User', { login: VIEWER.login });
        return null;
      }
      case '__type': {
        const name = argString(ctx, field, 'name');
        if (TYPE_FIELDS[name] || name === 'SearchType') return node('__Type', { name });
        return null;
      }
      case '__schema':
        return node('__Schema', {});
      default:
        return undefined;
    }
  },

  Mutation: (ctx, _source, field) => {
    const { forge } = ctx;
    const input = (argOf(ctx, field, 'input') ?? {}) as Record<string, unknown>;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    switch (field.name) {
      case 'createIssue': {
        const decoded = decodeGlobalId(str(input.repositoryId));
        const repo = decoded ? findRepoById(forge, Number.parseInt(decoded.id, 10)) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve the repository' });
          return null;
        }
        const item = forge.newItem(repo, { kind: 'issue', title: str(input.title), body: str(input.body) });
        return node('CreateIssuePayload', { repo, item });
      }
      case 'closeIssue':
      case 'reopenIssue': {
        const decoded = decodeGlobalId(str(input.issueId));
        const found = decoded ? findItemById(forge, Number.parseInt(decoded.id, 10)) : undefined;
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve the issue' });
          return null;
        }
        found.item.state = field.name === 'closeIssue' ? 'closed' : 'open';
        return node('CloseIssuePayload', { repo: found.repo, item: found.item });
      }
      case 'createPullRequest': {
        const decoded = decodeGlobalId(str(input.repositoryId));
        const repo = decoded ? findRepoById(forge, Number.parseInt(decoded.id, 10)) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve the repository' });
          return null;
        }
        const head = str(input.headRefName);
        const base = str(input.baseRefName);
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: 'Head or base branch does not exist' });
          return null;
        }
        const item = forge.newItem(repo, {
          kind: 'pull',
          title: str(input.title),
          body: str(input.body),
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
        });
        return node('CreatePullRequestPayload', { repo, item });
      }
      case 'mergePullRequest': {
        const decoded = decodeGlobalId(str(input.pullRequestId));
        const found = decoded ? findItemById(forge, Number.parseInt(decoded.id, 10)) : undefined;
        if (!found || found.item.kind !== 'pull') {
          ctx.errors.push({ message: 'Could not resolve the pull request' });
          return null;
        }
        const method = (str(input.mergeMethod) || 'SQUASH').toLowerCase();
        const result = mergePullCore(forge, found.repo, found.item, method);
        if (result === 'conflict') {
          ctx.errors.push({ message: 'Merge conflict' });
          return null;
        }
        if (result === 'not-mergeable') {
          ctx.errors.push({ message: 'Pull Request is not mergeable' });
          return null;
        }
        return node('MergePullRequestPayload', { repo: found.repo, item: found.item });
      }
      case 'addComment': {
        const decoded = decodeGlobalId(str(input.subjectId));
        const found = decoded ? findItemById(forge, Number.parseInt(decoded.id, 10)) : undefined;
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve the comment subject' });
          return null;
        }
        const comment = forge.newComment(found.repo, found.item.number, str(input.body));
        return node('AddCommentPayload', { repo: found.repo, item: found.item, comment });
      }
      default:
        return undefined;
    }
  },

  User: (_ctx, source, field) => {
    const user = source.ref as { login: string };
    switch (field.name) {
      case 'login':
        return user.login;
      case 'id':
        return globalId('User', VIEWER.id);
      case 'databaseId':
        return VIEWER.id;
      case 'name':
        return user.login === VIEWER.login ? VIEWER.name : user.login;
      case 'email':
        return user.login === VIEWER.login ? VIEWER.email : '';
      default:
        return undefined;
    }
  },

  Repository: (ctx, source, field) => {
    const { forge } = ctx;
    const repo = source.ref as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'isFork':
        return false;
      case 'owner':
        return node('User', { login: repo.owner });
      case 'defaultBranchRef':
        return node('Ref', { name: repo.defaultBranch, repo });
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'hasWikiEnabled':
        return true;
      case 'createdAt':
      case 'updatedAt':
        return forge.iso(repo.createdSeq);
      case 'issue': {
        const number = argInt(ctx, field, 'number');
        const item = number === undefined ? undefined : repo.items.get(number);
        return item && item.kind === 'issue' ? node('Issue', { repo, item }) : null;
      }
      case 'issues': {
        const states = argOf(ctx, field, 'states');
        const wanted = Array.isArray(states) ? states.map(String) : null;
        const orderBy = argOf(ctx, field, 'orderBy') as { direction?: string } | undefined;
        let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
        if (wanted) items = items.filter((item) => wanted.includes(issueState(item)));
        const descending = orderBy?.direction === 'DESC';
        items.sort((a, b) =>
          descending ? b.createdSeq - a.createdSeq || b.number - a.number : a.createdSeq - b.createdSeq || a.number - b.number,
        );
        return connectionNode('IssueConnection', connect(items.map((item) => node('Issue', { repo, item })), field, ctx));
      }
      case 'pullRequest': {
        const number = argInt(ctx, field, 'number');
        const item = number === undefined ? undefined : repo.items.get(number);
        return item && item.kind === 'pull' ? node('PullRequest', { repo, item }) : null;
      }
      case 'pullRequests': {
        const states = argOf(ctx, field, 'states');
        const wanted = Array.isArray(states) ? states.map(String) : ['OPEN'];
        let items = [...repo.items.values()].filter((item) => item.kind === 'pull');
        items = items.filter((item) => wanted.includes(pullState(item)));
        items.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
        return connectionNode('PullRequestConnection', connect(items.map((item) => node('PullRequest', { repo, item })), field, ctx));
      }
      default:
        return undefined;
    }
  },

  Issue: (ctx, source, field) => {
    const { repo, item } = source.ref as { repo: Repo; item: Item };
    switch (field.name) {
      case 'id':
        return globalId('Issue', item.id);
      case 'databaseId':
        return item.id;
      case 'number':
        return item.number;
      case 'title':
        return item.title;
      case 'body':
        return item.body;
      case 'state':
        return issueState(item);
      case 'author':
        return node('User', { login: repo.owner });
      case 'repository':
        return node('Repository', repo);
      case 'createdAt':
      case 'updatedAt':
        return ctx.forge.iso(item.createdSeq);
      case 'closedAt':
        return item.state === 'closed' ? ctx.forge.iso(item.createdSeq) : null;
      case 'labels': {
        const labels = item.labels.map((name) => node('Label', { repo, name }));
        return connectionNode('LabelConnection', connect(labels, field, ctx));
      }
      case 'comments': {
        const comments = (repo.comments.get(item.number) ?? []).map((comment) => node('IssueComment', { repo, item, comment }));
        return connectionNode('IssueCommentConnection', connect(comments, field, ctx));
      }
      default:
        return undefined;
    }
  },

  PullRequest: (ctx, source, field) => {
    const { repo, item } = source.ref as { repo: Repo; item: Item };
    const { forge } = ctx;
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', item.id);
      case 'databaseId':
        return item.id;
      case 'number':
        return item.number;
      case 'title':
        return item.title;
      case 'body':
        return item.body;
      case 'state':
        return pullState(item);
      case 'merged':
        return item.merged;
      case 'mergeable':
        return pullMergeable(forge, repo, item);
      case 'headRefName':
        return item.headRef;
      case 'baseRefName':
        return item.baseRef;
      case 'headRefOid':
        return repo.refs.get(`refs/heads/${item.headRef}`) ?? item.headSha;
      case 'baseRefOid':
        return repo.refs.get(`refs/heads/${item.baseRef}`) ?? item.baseSha;
      case 'author':
        return node('User', { login: repo.owner });
      case 'repository':
        return node('Repository', repo);
      case 'createdAt':
      case 'updatedAt':
        return forge.iso(item.createdSeq);
      case 'mergedAt':
        return item.merged ? forge.iso(item.mergedSeq) : null;
      case 'closedAt':
        return item.state === 'closed' ? forge.iso(item.createdSeq) : null;
      case 'mergeCommit':
        return item.merged ? node('Commit', { oid: item.mergeCommitSha }) : null;
      case 'files': {
        const headCommit = repo.refs.get(`refs/heads/${item.headRef}`);
        const baseCommit = repo.refs.get(`refs/heads/${item.baseRef}`);
        let files: GNode[] = [];
        if (headCommit && baseCommit) {
          const base = mergeBase(forge.store, baseCommit, headCommit);
          const changes = diffTrees(forge.store, commitTree(forge.store, base), commitTree(forge.store, headCommit));
          files = changes.map((change) =>
            node('PullRequestFile', {
              path: change.filename,
              additions: change.additions,
              deletions: change.deletions,
              changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
            }),
          );
        }
        return connectionNode('PullRequestFileConnection', connect(files, field, ctx));
      }
      default:
        return undefined;
    }
  },

  PullRequestFile: (_ctx, source, field) => {
    const file = source.ref as { path: string; additions: number; deletions: number; changeType: string };
    switch (field.name) {
      case 'path':
        return file.path;
      case 'additions':
        return file.additions;
      case 'deletions':
        return file.deletions;
      case 'changeType':
        return file.changeType;
      default:
        return undefined;
    }
  },

  Label: (_ctx, source, field) => {
    const { repo, name } = source.ref as { repo: Repo; name: string };
    switch (field.name) {
      case 'id':
        return globalId('Label', `${repo.id}:${name}`);
      case 'name':
        return name;
      case 'color':
        return repo.labels.get(name)?.color ?? 'ededed';
      case 'description':
        return repo.labels.get(name)?.description ?? '';
      default:
        return undefined;
    }
  },

  IssueComment: (ctx, source, field) => {
    const { repo, comment } = source.ref as { repo: Repo; item: Item; comment: { id: number; body: string; createdSeq: number } };
    switch (field.name) {
      case 'id':
        return globalId('IssueComment', comment.id);
      case 'databaseId':
        return comment.id;
      case 'body':
        return comment.body;
      case 'author':
        return node('User', { login: repo.owner });
      case 'createdAt':
      case 'updatedAt':
        return ctx.forge.iso(comment.createdSeq);
      default:
        return undefined;
    }
  },

  Ref: (_ctx, source, field) => {
    const ref = source.ref as { name: string; repo: Repo };
    switch (field.name) {
      case 'name':
        return ref.name;
      case 'prefix':
        return 'refs/heads/';
      case 'id':
        return globalId('Ref', `${ref.repo.id}:${ref.name}`);
      case 'repository':
        return node('Repository', ref.repo);
      case 'target':
        return node('Commit', { oid: ref.repo.refs.get(`refs/heads/${ref.name}`) ?? '' });
      default:
        return undefined;
    }
  },

  Commit: (_ctx, source, field) => {
    const commit = source.ref as { oid: string };
    switch (field.name) {
      case 'oid':
        return commit.oid;
      case 'id':
        return globalId('Commit', commit.oid);
      default:
        return undefined;
    }
  },

  __Type: (_ctx, source, field) => {
    const type = source.ref as { name: string };
    switch (field.name) {
      case 'name':
        return type.name;
      case 'kind':
        return type.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      case 'fields': {
        const fields = TYPE_FIELDS[type.name];
        if (!fields) return null;
        return fields.map((name) => node('__Field', { name }));
      }
      case 'enumValues': {
        if (type.name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((name) => node('__EnumValue', { name }));
      }
      case 'possibleTypes':
        return null;
      case 'description':
        return null;
      default:
        return undefined;
    }
  },

  __Field: (_ctx, source, field) => {
    const entry = source.ref as { name: string };
    return field.name === 'name' ? entry.name : undefined;
  },

  __EnumValue: (_ctx, source, field) => {
    const entry = source.ref as { name: string };
    return field.name === 'name' ? entry.name : undefined;
  },

  __Schema: (_ctx, _source, field) => {
    if (field.name === 'queryType') return node('__Type', { name: 'Query' });
    if (field.name === 'mutationType') return node('__Type', { name: 'Mutation' });
    return undefined;
  },
};

// Payload wrappers: expose the wrapped object under its field name.
const payloadFields: Record<string, string> = {
  CreateIssuePayload: 'issue',
  CloseIssuePayload: 'issue',
  CreatePullRequestPayload: 'pullRequest',
  MergePullRequestPayload: 'pullRequest',
};

function executeSelectionSet(ctx: ExecContext, source: GNode, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === source.type) {
        Object.assign(out, executeSelectionSet(ctx, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && fragment.typeCondition === source.type) {
        Object.assign(out, executeSelectionSet(ctx, source, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(ctx, source, selection);
  }
  return out;
}

function executeField(ctx: ExecContext, source: GNode, field: FieldNode): unknown {
  if (field.name === '__typename') return source.type;

  // Connection objects share one shape regardless of their element type.
  if (source.type.endsWith('Connection')) {
    const connection = source.ref as Connection;
    if (field.name === 'nodes') return connection.nodes.map((entry) => completeValue(ctx, entry, field));
    if (field.name === 'pageInfo') {
      return executeSelectionSet(
        ctx,
        node('PageInfo', connection),
        field.selectionSet ?? [],
      );
    }
    if (field.name === 'totalCount') return connection.total;
    if (field.name === 'edges') {
      return connection.nodes.map((entry) => executeSelectionSet(ctx, node('GenericEdge', entry), field.selectionSet ?? []));
    }
  }
  if (source.type === 'GenericEdge') {
    if (field.name === 'node') return completeValue(ctx, source.ref as GNode, field);
    if (field.name === 'cursor') return cursorOf(0);
  }
  if (source.type === 'PageInfo') {
    const connection = source.ref as Connection;
    if (field.name === 'hasNextPage') return connection.hasNextPage;
    if (field.name === 'endCursor') return connection.endCursor;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return connection.endCursor;
  }
  const payloadKey = payloadFields[source.type];
  if (payloadKey !== undefined) {
    const inner = source.ref as { repo: Repo; item: Item };
    if (field.name === payloadKey) {
      const type = inner.item.kind === 'issue' ? 'Issue' : 'PullRequest';
      return completeValue(ctx, node(type, inner), field);
    }
    if (field.name === 'clientMutationId') return null;
  }
  if (source.type === 'AddCommentPayload') {
    const inner = source.ref as { repo: Repo; item: Item; comment: { id: number; body: string; createdSeq: number } };
    if (field.name === 'commentEdge') {
      return executeSelectionSet(ctx, node('CommentEdge', inner), field.selectionSet ?? []);
    }
    if (field.name === 'clientMutationId') return null;
  }
  if (source.type === 'CommentEdge') {
    const inner = source.ref as { repo: Repo; item: Item; comment: { id: number; body: string; createdSeq: number } };
    if (field.name === 'node') return completeValue(ctx, node('IssueComment', inner), field);
    if (field.name === 'cursor') return cursorOf(0);
  }

  const resolver = resolvers[source.type];
  const value = resolver ? resolver(ctx, source, field) : undefined;
  if (value === undefined) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${source.type}'` });
    return null;
  }
  return completeValue(ctx, value, field);
}

/** Turn a resolver result into response JSON, descending into selection sets. */
function completeValue(ctx: ExecContext, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, field));
  if (typeof value === 'object' && 'type' in value && 'ref' in value) {
    const gnode = value as GNode;
    if (!field.selectionSet) return null;
    return executeSelectionSet(ctx, gnode, field.selectionSet);
  }
  return value;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function runOperation(forge: Forge, query: string, variables: Record<string, unknown>, operationName: string | undefined): Record<string, unknown> {
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    operationName !== undefined
      ? document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]
      : document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation found' }] };
  const ctx: ExecContext = {
    forge,
    variables,
    defaults: operation.varDefaults,
    fragments: document.fragments,
    errors: [],
  };
  const root = node(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(ctx, root, operation.selectionSet);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length) envelope.errors = ctx.errors;
  return envelope;
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(forge: Forge, body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    const replies = body.map((entry) => {
      const operation = (entry ?? {}) as Record<string, unknown>;
      return runOperation(
        forge,
        typeof operation.query === 'string' ? operation.query : '',
        (operation.variables ?? {}) as Record<string, unknown>,
        typeof operation.operationName === 'string' ? operation.operationName : undefined,
      );
    });
    return { status: 200, body: replies };
  }
  const operation = (body ?? {}) as Record<string, unknown>;
  const reply = runOperation(
    forge,
    typeof operation.query === 'string' ? operation.query : '',
    (operation.variables ?? {}) as Record<string, unknown>,
    typeof operation.operationName === 'string' ? operation.operationName : undefined,
  );
  return { status: 200, body: reply };
}
