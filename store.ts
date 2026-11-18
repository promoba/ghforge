// The forge's in-memory state: one object store, repositories with refs,
// labels, issues and pull requests (one shared number sequence, as on
// GitHub), plus the tree/diff/merge helpers every surface builds on.
//
// Every timestamp comes from a logical clock (a fixed epoch plus a counter),
// never the wall clock: identical request sequences produce identical bytes.

import {
  ObjectStore,
  buildCommit,
  buildTree,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** 2025-01-01T00:00:00Z: the logical clock's epoch. */
export const CLOCK_EPOCH_SEC = 1735689600;

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Item {
  kind: 'issue' | 'pull';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedSeq: number;
  mergeCommitSha: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  items: Map<number, Item>;
  nextNumber: number;
  comments: Map<number, CommentRec[]>;
  createdSeq: number;
}

export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private itemSeq = 0;
  private commentSeq = 0;
  private clock = 0;
  private requestSeq = 0;

  /** The next logical timestamp, in epoch seconds. */
  tick(): number {
    this.clock += 1;
    return CLOCK_EPOCH_SEC + this.clock;
  }

  /** ISO-8601 for a logical timestamp produced by `tick`. */
  iso(seq: number): string {
    return new Date(seq * 1000).toISOString();
  }

  /** A git identity line for a logical timestamp: `Name <email> sec +0000`. */
  identity(seq: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${seq} +0000`;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean }): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      comments: new Map(),
      createdSeq: this.tick(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  newItem(repo: Repo, fields: Partial<Item> & { kind: 'issue' | 'pull'; title: string }): Item {
    this.itemSeq += 1;
    const item: Item = {
      kind: fields.kind,
      number: repo.nextNumber,
      id: this.itemSeq,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels: fields.labels ?? [],
      createdSeq: this.tick(),
      headRef: fields.headRef ?? '',
      baseRef: fields.baseRef ?? '',
      headSha: fields.headSha ?? '',
      baseSha: fields.baseSha ?? '',
      merged: false,
      mergedSeq: 0,
      mergeCommitSha: '',
    };
    repo.nextNumber += 1;
    repo.items.set(item.number, item);
    return item;
  }

  newComment(repo: Repo, number: number, body: string): CommentRec {
    this.commentSeq += 1;
    const comment: CommentRec = { id: this.commentSeq, body, createdSeq: this.tick() };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }
}

// ---------------------------------------------------------------------------
// history walks
// ---------------------------------------------------------------------------

/** Every commit reachable from `tip`, mapped to its generation (tip = 0). */
export function commitGenerations(store: ObjectStore, tip: string): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [{ oid: tip, gen: 0 }];
  while (queue.length) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const known = generations.get(oid);
    if (known !== undefined && known <= gen) continue;
    generations.set(oid, gen);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return generations;
}

/** True when `ancestor` is `descendant` itself or reachable from it by parents. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** A best common ancestor of two commits (lowest total generation), if any. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | undefined {
  if (a === b) return a;
  const fromA = commitGenerations(store, a);
  const fromB = commitGenerations(store, b);
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, genA] of fromA) {
    const genB = fromB.get(oid);
    if (genB === undefined) continue;
    const score = genA + genB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** The commit at a ref-ish: a branch name, a full ref, or a raw object id. */
export function resolveRefish(repo: Repo, store: ObjectStore, refish: string): string | undefined {
  if (!refish) return undefined;
  const byRef = repo.refs.get(refish);
  if (byRef) return byRef;
  const byHead = repo.refs.get(`refs/heads/${refish}`);
  if (byHead) return byHead;
  const byTag = repo.refs.get(`refs/tags/${refish}`);
  if (byTag) return byTag;
  if (/^[0-9a-f]{40}$/.test(refish) && store.has(refish)) return refish;
  return undefined;
}

/** A ref's commit: tags peel to the commit they ultimately name. */
export function refCommit(repo: Repo, store: ObjectStore, ref: string): string | undefined {
  const oid = repo.refs.get(ref);
  if (!oid) return undefined;
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (!object) return undefined;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return undefined;
    current = parseTag(object.data).object;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// trees: flatten, rebuild, set/delete a path
// ---------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Every file (blob or gitlink) under a tree, keyed by its full path. */
export function flattenTree(store: ObjectStore, treeOid: string | undefined): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid) walk(treeOid, '');
  return out;
}

/** Rebuild nested trees from a flattened path map; returns the root tree id. */
export function treeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let next = node.dirs.get(part);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** A tree with `path` set to a blob (or removed when `blobOid` is null). */
export function setTreePath(
  store: ObjectStore,
  treeOid: string | undefined,
  path: string,
  blobOid: string | null,
  mode = '100644',
): string {
  const flat = flattenTree(store, treeOid);
  if (blobOid === null) flat.delete(path);
  else flat.set(path, { oid: blobOid, mode });
  return treeFromFlat(store, flat);
}

/** The blob id at `path` in a tree, or undefined. */
export function treePath(store: ObjectStore, treeOid: string | undefined, path: string): FlatEntry | undefined {
  return flattenTree(store, treeOid).get(path);
}

/** A tree's entries listed as the contents API shows a directory. */
export function treeEntries(store: ObjectStore, treeOid: string | undefined): TreeEntry[] {
  if (!treeOid) return [];
  const object = store.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

// ---------------------------------------------------------------------------
// diff and merge
// ---------------------------------------------------------------------------

function textLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Additions/deletions between two blob bodies, by a line LCS. */
export function lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = textLines(before);
  const b = textLines(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) return { additions: b.length, deletions: a.length };
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j] as number;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(above, dp[j - 1] as number);
      diagonal = above;
    }
  }
  const common = dp[b.length] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** File-level diff between two trees (either may be undefined = empty). */
export function diffTrees(
  store: ObjectStore,
  fromTree: string | undefined,
  toTree: string | undefined,
): FileChange[] {
  const before = flattenTree(store, fromTree);
  const after = flattenTree(store, toTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && !newEntry) {
      const blob = store.get(oldEntry.oid);
      const deletions = blob ? textLines(blob.data).length : 0;
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!oldEntry && newEntry) {
      const blob = store.get(newEntry.oid);
      const additions = blob ? textLines(blob.data).length : 0;
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      const oldBlob = store.get(oldEntry.oid);
      const newBlob = store.get(newEntry.oid);
      const { additions, deletions } = lineDiff(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/**
 * A three-way file-level merge: `ours` and `theirs` both descend from `base`.
 * Returns the merged tree id, or null when a path changed both ways.
 */
export function mergeTrees(
  store: ObjectStore,
  baseTree: string | undefined,
  oursTree: string | undefined,
  theirsTree: string | undefined,
): string | null {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, oursTree);
  const theirs = flattenTree(store, theirsTree);
  const merged = new Map<string, FlatEntry>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
      x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode;
    let winner: FlatEntry | undefined;
    if (same(o, t)) winner = o;
    else if (same(b, o)) winner = t;
    else if (same(b, t)) winner = o;
    else return null;
    if (winner) merged.set(path, winner);
  }
  return treeFromFlat(store, merged);
}

/** Create a commit object over a tree and return its id (not stored as a ref). */
export function makeCommit(
  forge: Forge,
  fields: { tree: string; parents: readonly string[]; message: string },
): string {
  const seq = forge.tick();
  const identity = forge.identity(seq);
  const data = buildCommit({
    tree: fields.tree,
    parents: fields.parents,
    author: identity,
    committer: identity,
    message: fields.message,
  });
  return forge.store.put('commit', data);
}

/** The tree id of a commit (undefined when the object is missing/not a commit). */
export function commitTree(store: ObjectStore, commitOid: string | undefined): string | undefined {
  if (!commitOid) return undefined;
  const object = store.get(commitOid);
  if (!object || object.type !== 'commit') return undefined;
  return parseCommit(object.data).tree;
}

export type { GitObject, ObjType };
