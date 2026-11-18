// The GitHub REST v3 surface: repositories, branches and refs, the contents
// API, labels, issues and comments, and pull requests with file diffs and
// squash merges. Everything reads and writes the one forge store, so a file
// committed here is visible to git fetches, GraphQL and MCP at once.

import { parseCommit, parseTag, parseTree } from './gitobj.ts';
import {
  VIEWER,
  commitGenerations,
  commitTree,
  diffTrees,
  flattenTree,
  makeCommit,
  mergeBase,
  mergeTrees,
  refCommit,
  resolveRefish,
  setTreePath,
  treePath,
  type Forge,
  type Item,
  type Repo,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments after `/api/v3` (empty for the API root). */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  /** The request's own origin, for absolute Link headers. */
  origin: string;
}

export interface RestResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResponse => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestResponse => ({ status: 422, body: { message } });

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.iso(repo.createdSeq),
    updated_at: forge.iso(repo.createdSeq),
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
}

function issueJson(forge: Forge, repo: Repo, item: Item): Record<string, unknown> {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => labelJson(repo, name)),
    user: { login: repo.owner, id: VIEWER.id },
    comments: (repo.comments.get(item.number) ?? []).length,
    created_at: forge.iso(item.createdSeq),
    updated_at: forge.iso(item.createdSeq),
  };
}

function pullJson(forge: Forge, repo: Repo, item: Item): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${item.headRef}`) ?? item.headSha;
  const baseSha = repo.refs.get(`refs/heads/${item.baseRef}`) ?? item.baseSha;
  return {
    id: item.id,
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    merged: item.merged,
    merged_at: item.merged ? forge.iso(item.mergedSeq) : null,
    merge_commit_sha: item.merged ? item.mergeCommitSha : null,
    head: { ref: item.headRef, sha: headSha, label: `${repo.owner}:${item.headRef}` },
    base: { ref: item.baseRef, sha: baseSha, label: `${repo.owner}:${item.baseRef}` },
    user: { login: repo.owner, id: VIEWER.id },
    created_at: forge.iso(item.createdSeq),
    updated_at: forge.iso(item.createdSeq),
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1,
  };
}

function paginate<T>(items: readonly T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

function linkHeader(origin: string, path: string, page: Page, total: number): string | undefined {
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  if (lastPage <= 1) return undefined;
  const url = (p: number): string => `${origin}${path}?per_page=${page.perPage}&page=${p}`;
  const parts: string[] = [];
  if (page.page < lastPage) parts.push(`<${url(page.page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  if (page.page > 1) parts.push(`<${url(page.page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// contents helpers
// ---------------------------------------------------------------------------

/** The tree id at a directory path ('' is the root); undefined when absent. */
function subtreeOid(forge: Forge, rootTree: string | undefined, path: string): string | undefined {
  if (!rootTree) return undefined;
  if (path === '') return rootTree;
  let current: string | undefined = rootTree;
  for (const part of path.split('/')) {
    if (!current) return undefined;
    const object = forge.store.get(current);
    if (!object || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === part);
    if (!entry || entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return current;
}

/** Peel a ref-ish (branch, tag or raw id) down to its commit id. */
function commitForRefish(forge: Forge, repo: Repo, refish: string): string | undefined {
  let oid = resolveRefish(repo, forge.store, refish);
  for (let depth = 0; depth < 16 && oid; depth += 1) {
    const object = forge.store.get(oid);
    if (!object) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type !== 'tag') return undefined;
    oid = parseTag(object.data).object;
  }
  return undefined;
}

function decodeBase64(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

function createRepo(forge: Forge, body: Record<string, unknown> | undefined): RestResponse {
  const name = asString(body?.name);
  if (!name) return unprocessable('Repository creation failed: name is required');
  if (forge.getRepo(VIEWER.login, name)) {
    return unprocessable(`Repository creation failed: name already exists on this account`);
  }
  const repo = forge.createRepo(VIEWER.login, name, {
    description: asString(body?.description),
    isPrivate: asBool(body?.private) ?? false,
  });
  return { status: 201, body: repoJson(forge, repo) };
}

function getRepo(forge: Forge, repo: Repo): RestResponse {
  return { status: 200, body: repoJson(forge, repo) };
}

function patchRepo(forge: Forge, repo: Repo, body: Record<string, unknown> | undefined): RestResponse {
  if (body) {
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    if (typeof body.name === 'string' && body.name !== repo.name) {
      const oldKey = `${repo.owner}/${repo.name}`.toLowerCase();
      forge.repos.delete(oldKey);
      repo.name = body.name;
      forge.repos.set(`${repo.owner}/${repo.name}`.toLowerCase(), repo);
    }
    if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
      repo.defaultBranch = body.default_branch;
    }
  }
  return { status: 200, body: repoJson(forge, repo) };
}

function listUserRepos(forge: Forge, req: RestRequest): RestResponse {
  const page = pageOf(req.query);
  const all = forge.listRepos(VIEWER.login);
  const items = paginate(all, page).map((repo) => repoJson(forge, repo));
  const link = linkHeader(req.origin, '/api/v3/user/repos', page, all.length);
  return { status: 200, body: items, headers: link ? { link } : {} };
}

function listBranches(forge: Forge, repo: Repo): RestResponse {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { status: 200, body: branches };
}

function getBranch(forge: Forge, repo: Repo, branch: string): RestResponse {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) return notFound();
  return { status: 200, body: { name: branch, commit: { sha: oid } } };
}

function createRef(forge: Forge, repo: Repo, body: Record<string, unknown> | undefined): RestResponse {
  const ref = asString(body?.ref);
  const sha = asString(body?.sha);
  if (!ref.startsWith('refs/') || !forge.store.has(sha)) {
    return unprocessable('Invalid ref or object id');
  }
  if (repo.refs.has(ref)) return unprocessable(`Reference already exists: ${ref}`);
  repo.refs.set(ref, sha);
  return { status: 201, body: { ref, object: { sha, type: forge.store.get(sha)?.type ?? 'commit' } } };
}

function getRef(forge: Forge, repo: Repo, ref: string): RestResponse {
  const oid = repo.refs.get(ref);
  if (!oid) return notFound();
  return { status: 200, body: { ref, object: { sha: oid, type: forge.store.get(oid)?.type ?? 'commit' } } };
}

function listCommits(forge: Forge, repo: Repo, query: URLSearchParams): RestResponse {
  const refish = query.get('sha') ?? repo.defaultBranch;
  const start = commitForRefish(forge, repo, refish);
  if (!start) return { status: 200, body: [] };
  const generations = commitGenerations(forge.store, start);
  const ordered = [...generations.entries()].sort((a, b) => a[1] - b[1]).slice(0, 500);
  const body = ordered.map(([oid]) => {
    const object = forge.store.get(oid);
    const view = object && object.type === 'commit' ? parseCommit(object.data) : null;
    return {
      sha: oid,
      commit: {
        message: view?.message ?? '',
        author: { name: VIEWER.name, email: VIEWER.email, date: forge.iso(repo.createdSeq) },
        committer: { name: VIEWER.name, email: VIEWER.email, date: forge.iso(repo.createdSeq) },
      },
      parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
    };
  });
  return { status: 200, body };
}

// -------------------------------------------------------------- contents API

interface BranchTarget {
  refName: string;
  tip: string | undefined;
  tree: string | undefined;
}

/** Resolve the branch a contents write lands on, creating it when asked. */
function writeTarget(forge: Forge, repo: Repo, branch: string): BranchTarget {
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (!tip && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  return { refName, tip, tree: tip ? commitTree(forge.store, tip) : undefined };
}

function putContent(forge: Forge, repo: Repo, path: string, body: Record<string, unknown> | undefined): RestResponse {
  const content = asString(body?.content);
  const message = asString(body?.message);
  const branch = asString(body?.branch) || repo.defaultBranch;
  const target = writeTarget(forge, repo, branch);
  const existing = treePath(forge.store, target.tree, path);
  const givenSha = asString(body?.sha);
  if (existing && givenSha && givenSha !== existing.oid) {
    return { status: 409, body: { message: 'The blob sha does not match the current content' } };
  }
  if (!existing && givenSha) {
    return unprocessable('Invalid request: sha must not be supplied when creating a file');
  }
  const bytes = decodeBase64(content);
  const blobOid = forge.store.put('blob', bytes);
  const newTree = setTreePath(forge.store, target.tree, path, blobOid, existing?.mode ?? '100644');
  const commit = makeCommit(forge, {
    tree: newTree,
    parents: target.tip ? [target.tip] : [],
    message,
  });
  repo.refs.set(target.refName, commit);
  const name = path.split('/').pop() ?? path;
  return {
    status: existing ? 200 : 201,
    body: {
      content: { name, path, sha: blobOid, size: bytes.length, encoding: 'base64', type: 'file' },
      commit: { sha: commit, message },
    },
  };
}

function getContent(forge: Forge, repo: Repo, path: string, query: URLSearchParams): RestResponse {
  const refish = query.get('ref') ?? repo.defaultBranch;
  const tree = commitTree(forge.store, commitForRefish(forge, repo, refish));
  if (path !== '') {
    const entry = treePath(forge.store, tree, path);
    if (entry) {
      const blob = forge.store.get(entry.oid);
      if (!blob) return notFound();
      const name = path.split('/').pop() ?? path;
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          name,
          path,
          sha: entry.oid,
          size: blob.data.length,
          content: blob.data.toString('base64'),
        },
      };
    }
  }
  const dir = subtreeOid(forge, tree, path);
  if (!dir) return notFound();
  const object = forge.store.get(dir);
  if (!object || object.type !== 'tree') return notFound();
  const entries = parseTree(object.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path ? `${path}/${entry.name}` : entry.name,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (forge.store.get(entry.oid)?.data.length ?? 0),
    mode: entry.mode,
  }));
  return { status: 200, body: entries };
}

function deleteContent(forge: Forge, repo: Repo, path: string, body: Record<string, unknown> | undefined): RestResponse {
  const message = asString(body?.message);
  const branch = asString(body?.branch) || repo.defaultBranch;
  const target = writeTarget(forge, repo, branch);
  const existing = treePath(forge.store, target.tree, path);
  if (!existing) return notFound();
  const givenSha = asString(body?.sha);
  if (givenSha && givenSha !== existing.oid) {
    return { status: 409, body: { message: 'The blob sha does not match the current content' } };
  }
  const newTree = setTreePath(forge.store, target.tree, path, null);
  const commit = makeCommit(forge, {
    tree: newTree,
    parents: target.tip ? [target.tip] : [],
    message,
  });
  repo.refs.set(target.refName, commit);
  return { status: 200, body: { content: null, commit: { sha: commit, message } } };
}

// ------------------------------------------------------------------- issues

function createLabel(repo: Repo, body: Record<string, unknown> | undefined): RestResponse {
  const name = asString(body?.name);
  if (!name) return unprocessable('Validation failed: name is required');
  if (repo.labels.has(name)) return unprocessable('Validation failed: name already exists');
  const label = { name, color: asString(body?.color) || 'ededed', description: asString(body?.description) };
  repo.labels.set(name, label);
  return { status: 201, body: { id: repo.labels.size, name: label.name, color: label.color, description: label.description, default: false } };
}

function validateLabels(repo: Repo, labels: unknown): string | null {
  if (!Array.isArray(labels)) return null;
  for (const entry of labels) {
    const name = typeof entry === 'string' ? entry : asString((entry as Record<string, unknown>)?.name);
    if (name && !repo.labels.has(name)) return `Unknown label: ${name}`;
  }
  return null;
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') out.push(entry);
    else {
      const name = asString((entry as Record<string, unknown>)?.name);
      if (name) out.push(name);
    }
  }
  return out;
}

function createIssue(forge: Forge, repo: Repo, body: Record<string, unknown> | undefined): RestResponse {
  const problem = validateLabels(repo, body?.labels);
  if (problem) return unprocessable(problem);
  const item = forge.newItem(repo, {
    kind: 'issue',
    title: asString(body?.title),
    body: asString(body?.body),
    labels: labelNames(body?.labels),
  });
  return { status: 201, body: issueJson(forge, repo, item) };
}

function listIssues(forge: Forge, repo: Repo, query: URLSearchParams): RestResponse {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
  if (state === 'open') items = items.filter((item) => item.state === 'open');
  else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
  items.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
  const page = pageOf(query);
  return { status: 200, body: paginate(items, page).map((item) => issueJson(forge, repo, item)) };
}

function getIssue(forge: Forge, repo: Repo, number: number): RestResponse {
  const item = repo.items.get(number);
  if (!item || item.kind !== 'issue') return notFound();
  return { status: 200, body: issueJson(forge, repo, item) };
}

function patchIssue(forge: Forge, repo: Repo, number: number, body: Record<string, unknown> | undefined): RestResponse {
  const item = repo.items.get(number);
  if (!item || item.kind !== 'issue') return notFound();
  if (body) {
    if (typeof body.title === 'string') item.title = body.title;
    if (typeof body.body === 'string') item.body = body.body;
    if (body.state === 'open' || body.state === 'closed') item.state = body.state;
    if (body.labels !== undefined) {
      const problem = validateLabels(repo, body.labels);
      if (problem) return unprocessable(problem);
      item.labels = labelNames(body.labels);
    }
  }
  return { status: 200, body: issueJson(forge, repo, item) };
}

function createComment(forge: Forge, repo: Repo, number: number, body: Record<string, unknown> | undefined): RestResponse {
  const item = repo.items.get(number);
  if (!item) return notFound();
  const comment = forge.newComment(repo, number, asString(body?.body));
  return {
    status: 201,
    body: { id: comment.id, body: comment.body, user: { login: repo.owner, id: VIEWER.id }, created_at: forge.iso(comment.createdSeq), updated_at: forge.iso(comment.createdSeq) },
  };
}

function listComments(forge: Forge, repo: Repo, number: number): RestResponse {
  const item = repo.items.get(number);
  if (!item) return notFound();
  const comments = repo.comments.get(number) ?? [];
  return {
    status: 200,
    body: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: repo.owner, id: VIEWER.id },
      created_at: forge.iso(comment.createdSeq),
      updated_at: forge.iso(comment.createdSeq),
    })),
  };
}

// -------------------------------------------------------------------- pulls

function createPull(forge: Forge, repo: Repo, body: Record<string, unknown> | undefined): RestResponse {
  const head = asString(body?.head);
  const base = asString(body?.base);
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return unprocessable('Validation failed: head or base branch does not exist');
  if (head === base) return unprocessable('Validation failed: head and base must differ');
  for (const item of repo.items.values()) {
    if (item.kind === 'pull' && item.state === 'open' && item.headRef === head && item.baseRef === base) {
      return unprocessable(`A pull request already exists for ${head} into ${base}`);
    }
  }
  const item = forge.newItem(repo, {
    kind: 'pull',
    title: asString(body?.title),
    body: asString(body?.body),
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
  });
  return { status: 201, body: pullJson(forge, repo, item) };
}

function getPull(forge: Forge, repo: Repo, number: number): RestResponse {
  const item = repo.items.get(number);
  if (!item || item.kind !== 'pull') return notFound();
  return { status: 200, body: pullJson(forge, repo, item) };
}

function listPulls(forge: Forge, repo: Repo, query: URLSearchParams): RestResponse {
  const state = query.get('state') ?? 'open';
  let items = [...repo.items.values()].filter((item) => item.kind === 'pull');
  if (state === 'open') items = items.filter((item) => item.state === 'open');
  else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
  items.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  const page = pageOf(query);
  return { status: 200, body: paginate(items, page).map((item) => pullJson(forge, repo, item)) };
}

/** The diff base for a pull: merge-base tree versus the current head tree. */
function pullDiff(forge: Forge, repo: Repo, item: Item): ReturnType<typeof diffTrees> {
  const headCommit = refCommit(repo, forge.store, `refs/heads/${item.headRef}`);
  const baseCommit = refCommit(repo, forge.store, `refs/heads/${item.baseRef}`);
  if (!headCommit || !baseCommit) return [];
  const base = mergeBase(forge.store, baseCommit, headCommit);
  return diffTrees(forge.store, commitTree(forge.store, base), commitTree(forge.store, headCommit));
}

function pullFiles(forge: Forge, repo: Repo, number: number): RestResponse {
  const item = repo.items.get(number);
  if (!item || item.kind !== 'pull') return notFound();
  const changes = pullDiff(forge, repo, item);
  return {
    status: 200,
    body: changes.map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      sha: '',
    })),
  };
}

/** The merge itself, shared by the REST endpoint and the GraphQL mutation. */
export function mergePullCore(
  forge: Forge,
  repo: Repo,
  item: Item,
  method: string,
): { sha: string } | 'conflict' | 'not-mergeable' {
  if (item.merged || item.state !== 'open') return 'not-mergeable';
  const baseTip = repo.refs.get(`refs/heads/${item.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${item.headRef}`);
  if (!baseTip || !headTip) return 'not-mergeable';
  const base = mergeBase(forge.store, baseTip, headTip);
  if (!base) return 'conflict';
  const mergedTree = mergeTrees(
    forge.store,
    commitTree(forge.store, base),
    commitTree(forge.store, baseTip),
    commitTree(forge.store, headTip),
  );
  if (mergedTree === null) return 'conflict';
  const commit = makeCommit(forge, {
    tree: mergedTree,
    parents: method === 'merge' ? [baseTip, headTip] : [baseTip],
    message: `${item.title} (#${item.number})`,
  });
  repo.refs.set(`refs/heads/${item.baseRef}`, commit);
  item.state = 'closed';
  item.merged = true;
  item.mergedSeq = forge.tick();
  item.mergeCommitSha = commit;
  return { sha: commit };
}

function mergePull(forge: Forge, repo: Repo, number: number, body: Record<string, unknown> | undefined): RestResponse {
  const item = repo.items.get(number);
  if (!item || item.kind !== 'pull') return notFound();
  const method = asString(body?.merge_method) || 'squash';
  if (method === 'rebase') return { status: 405, body: { message: 'Rebase merges are not supported' } };
  const result = mergePullCore(forge, repo, item, method);
  if (result === 'conflict') return { status: 405, body: { message: 'Merge conflict' } };
  if (result === 'not-mergeable') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// -------------------------------------------------------------------- router

export function handleRest(forge: Forge, req: RestRequest): RestResponse {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: `${req.origin}/api/v3/user`,
        repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${req.origin}/api/v3/rate_limit`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org, write:issues' },
    };
  }
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    return {
      status: 200,
      body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' },
    };
  }
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') return createRepo(forge, req.body);
    if (method === 'GET') return listUserRepos(forge, req);
    return notFound();
  }

  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1] as string;
  const name = seg[2] as string;
  const repo = forge.getRepo(owner, name);
  if (!repo) return notFound();
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return getRepo(forge, repo);
    if (method === 'PATCH') return patchRepo(forge, repo, req.body);
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') return listBranches(forge, repo);
    if (rest.length >= 2 && method === 'GET') return getBranch(forge, repo, rest.slice(1).join('/'));
    return notFound();
  }
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    return listCommits(forge, repo, req.query);
  }
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') return createRef(forge, repo, req.body);
    if (rest.length >= 3 && method === 'GET') return getRef(forge, repo, rest.join('/'));
    return notFound();
  }
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') return putContent(forge, repo, path, req.body);
    if (method === 'GET') return getContent(forge, repo, path, req.query);
    if (method === 'DELETE') return deleteContent(forge, repo, path, req.body);
    return notFound();
  }
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    return createLabel(repo, req.body);
  }
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssue(forge, repo, req.body);
      if (method === 'GET') return listIssues(forge, repo, req.query);
      return notFound();
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isFinite(number)) return notFound();
    if (rest.length === 2) {
      if (method === 'GET') return getIssue(forge, repo, number);
      if (method === 'PATCH') return patchIssue(forge, repo, number, req.body);
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') return createComment(forge, repo, number, req.body);
      if (method === 'GET') return listComments(forge, repo, number);
      return notFound();
    }
    return notFound();
  }
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPull(forge, repo, req.body);
      if (method === 'GET') return listPulls(forge, repo, req.query);
      return notFound();
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isFinite(number)) return notFound();
    if (rest.length === 2 && method === 'GET') return getPull(forge, repo, number);
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return pullFiles(forge, repo, number);
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePull(forge, repo, number, req.body);
    return notFound();
  }
  return notFound();
}

// Re-exported for the GraphQL and MCP surfaces, which share these shapes.
export { issueJson, pullJson, repoJson };
