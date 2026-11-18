// Git smart HTTP: ref advertisement (protocol v0 and v2), ls-refs, fetch
// (v2 sections and the v0 want/have exchange, with shallow/deepen support)
// and receive-pack with report-status. Everything runs against the forge's
// in-memory object store; no git binary is involved on either side.

import {
  PKT_DELIM,
  PKT_FLUSH,
  PktReader,
  ZERO_OID,
  isOid,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  sidebandWrap,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { commitGenerations, type Forge, type Repo } from './store.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'ghforge/1.0';

function textResult(status: number, text: string): HttpResult {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

/** Refs in advertisement order: lexicographic by name. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function headOid(repo: Repo): string {
  return repo.refs.get(headRef(repo)) ?? ZERO_OID;
}

/** Peel an object id through tag objects; returns the chain (tags first). */
function peelChain(forge: Forge, oid: string): string[] {
  const chain: string[] = [];
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = forge.store.get(current);
    if (!object) break;
    chain.push(current);
    if (object.type !== 'tag') break;
    current = parseTag(object.data).object;
  }
  return chain;
}

function peeledOid(forge: Forge, oid: string): string | undefined {
  const chain = peelChain(forge, oid);
  if (chain.length < 2) return undefined;
  return chain[chain.length - 1];
}

// ---------------------------------------------------------------------------
// advertisement
// ---------------------------------------------------------------------------

export function infoRefs(forge: Forge, repo: Repo, service: string, version2: boolean): HttpResult {
  if (service === 'git-upload-pack' && version2) {
    const lines = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:${headRef(repo)}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headLine = `${headOid(repo)} HEAD`;
    parts.push(pktLine(first ? `${headLine}\0${caps}\n` : `${headLine}\n`));
    first = false;
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peeledOid(forge, oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------------------
// upload-pack: ls-refs and fetch
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
  deepenSince: number | undefined;
  deepenNot: string[];
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    deepen: undefined,
    deepenSince: undefined,
    deepenNot: [],
    done: false,
  };
  for (const line of lines) {
    // A v0 want line carries the negotiated capabilities after its object id.
    if (line.startsWith('want ')) args.wants.push((line.slice(5).trim().split(' ')[0] as string));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number.parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** Objects the client provably holds: closure of its haves, not past its shallow boundary. */
function heldClosure(forge: Forge, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const object = forge.store.get(oid);
    held.add(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!shallow.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeSafe(forge, oid)) stack.push(entry);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return held;
}

function parseTreeSafe(forge: Forge, oid: string): string[] {
  const object = forge.store.get(oid);
  if (!object || object.type !== 'tree') return [];
  const out: string[] = [];
  let offset = 0;
  const data = object.data;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    if (mode !== '160000') out.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return out;
}

interface FetchPlan {
  send: GitObject[];
  newShallow: string[];
  unshallow: string[];
  acks: string[];
  hasHaves: boolean;
}

/** Decide the object set and shallow bookkeeping for one fetch request. */
function planFetch(forge: Forge, args: FetchArgs): FetchPlan {
  const store = forge.store;
  const clientShallow = new Set(args.shallow.filter(isOid));
  const held = heldClosure(forge, args.haves.filter(isOid), clientShallow);

  // Commits excluded by deepen-not: everything reachable from those tips.
  const notCommits = new Set<string>();
  for (const tip of args.deepenNot) {
    const chain = peelChain(forge, tip);
    const target = chain[chain.length - 1];
    if (target && store.get(target)?.type === 'commit') {
      for (const oid of commitGenerations(store, target).keys()) notCommits.add(oid);
    }
  }

  // Phase A: which commits are in scope, with generations from the wants.
  const commitGen = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  const looseRoots: string[] = [];
  for (const want of args.wants) {
    if (!isOid(want)) continue;
    const object = store.get(want);
    if (!object) continue;
    if (object.type === 'commit') queue.push({ oid: want, gen: 0 });
    else looseRoots.push(want);
  }
  const commitTime = (oid: string): number => {
    const object = store.get(oid);
    if (!object || object.type !== 'commit') return 0;
    const match = / (\d+) [+-]\d{4}$/.exec(parseCommit(object.data).committer);
    return match ? Number.parseInt(match[1] as string, 10) : 0;
  };
  while (queue.length) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const known = commitGen.get(oid);
    if (known !== undefined && known <= gen) continue;
    if (notCommits.has(oid)) continue;
    if (args.deepen !== undefined && gen >= args.deepen) {
      // In scope as the boundary generation only when gen == deepen - 1 was
      // recorded by the parent step; a commit first seen too deep is skipped.
      if (gen > 0) continue;
    }
    if (args.deepenSince !== undefined && gen > 0 && commitTime(oid) < args.deepenSince) continue;
    commitGen.set(oid, gen);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (args.deepen !== undefined && gen + 1 >= args.deepen) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  // Phase B: full object closure over the in-scope commits and loose roots.
  const included = new Set<string>();
  const stack: string[] = [...looseRoots];
  for (const oid of commitGen.keys()) stack.push(oid);
  for (const want of args.wants) {
    // Tag objects naming an in-scope commit ride along with the fetch.
    const chain = peelChain(forge, want);
    if (chain.length > 1 && commitGen.has(chain[chain.length - 1] as string)) stack.push(want);
  }
  while (stack.length) {
    const oid = stack.pop() as string;
    if (included.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    included.add(oid);
    if (object.type === 'commit') {
      if (!commitGen.has(oid)) continue;
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) if (commitGen.has(parent)) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const child of parseTreeSafe(forge, oid)) stack.push(child);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = store.get(target);
      if (targetObject?.type === 'commit' && !commitGen.has(target)) continue;
      stack.push(target);
    }
  }

  // Phase C: subtract what the client holds; work out the shallow bookkeeping.
  const available = new Set<string>([...held, ...included]);
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of included) {
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (held.has(oid)) continue;
    if (parents.length > 0 && parents.some((parent) => !available.has(parent))) newShallow.push(oid);
  }
  for (const oid of clientShallow) {
    if (!available.has(oid) || held.has(oid) === false && !included.has(oid)) {
      // Only commits the client still holds can stop being shallow.
      if (!available.has(oid)) continue;
    }
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => available.has(parent))) unshallow.push(oid);
  }

  const send: GitObject[] = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const object = store.get(oid);
    if (object) send.push(object);
  }
  const acks: string[] = [];
  for (const have of args.haves) {
    const object = store.get(have);
    if (object && object.type === 'commit') acks.push(have);
  }
  return {
    send,
    newShallow: newShallow.sort(),
    unshallow: unshallow.sort(),
    acks,
    hasHaves: args.haves.length > 0,
  };
}

function handleLsRefs(forge: Forge, repo: Repo, argLines: string[]): HttpResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headRef(repo);
  const targetOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (targetOid) {
      parts.push(pktLine(`${targetOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${target}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOid(forge, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV2(forge: Forge, argLines: string[]): HttpResult {
  const args = parseFetchArgs(argLines);
  const plan = planFetch(forge, args);
  const pack = writePack(plan.send);
  const parts: Buffer[] = [];
  if (plan.hasHaves) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length) for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    else parts.push(pktLine('NAK\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.newShallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV0(forge: Forge, lines: string[]): HttpResult {
  const args = parseFetchArgs(lines);
  const plan = planFetch(forge, args);
  const pack = writePack(plan.send);
  const parts: Buffer[] = [];
  if (plan.acks.length) for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of plan.newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** POST git-upload-pack: a v2 command request or a v0 want/have exchange. */
export function uploadPack(forge: Forge, repo: Repo, body: Buffer): HttpResult {
  let reader: PktReader;
  try {
    reader = new PktReader(body);
  } catch {
    return textResult(400, 'bad request\n');
  }
  const firstLines: string[] = [];
  try {
    // Command/capability lines run to the first delim (v2) or flush (v0).
    for (;;) {
      const packet = reader.next();
      if (packet === null) break;
      if (packet.kind === 'delim') break;
      if (packet.kind === 'flush') {
        // v0: the want block ended; the have block follows.
        const rest: string[] = [];
        for (;;) {
          const next = reader.next();
          if (next === null || next.kind === 'flush') break;
          if (next.kind === 'data') rest.push(next.payload.toString('utf8').replace(/\n$/, ''));
        }
        return handleFetchV0(forge, [...firstLines, ...rest]);
      }
      firstLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  } catch {
    return textResult(400, 'bad pkt-line stream\n');
  }
  const command = firstLines[0] ?? '';
  const argLines: string[] = [];
  try {
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind === 'data') argLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  } catch {
    return textResult(400, 'bad pkt-line stream\n');
  }
  if (command === 'command=ls-refs') return handleLsRefs(forge, repo, argLines);
  if (command === 'command=fetch') return handleFetchV2(forge, argLines);
  return textResult(400, 'unknown command\n');
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, repo: Repo, body: Buffer): HttpResult {
  let reader: PktReader;
  const commands: PushCommand[] = [];
  let capabilities = '';
  try {
    reader = new PktReader(body);
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
        return textResult(400, 'bad push command\n');
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch {
    return textResult(400, 'bad pkt-line stream\n');
  }
  const packBytes = reader.rest();

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => forge.store.get(oid));
      for (const [oid, object] of objects) forge.store.putKnown(oid, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail(command.oldOid === ZERO_OID ? 'reference already exists' : 'stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const object = forge.store.get(command.newOid);
    if (!object) {
      fail('bad object');
      continue;
    }
    if (current !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      const newCommit = peelChain(forge, command.newOid).pop() as string;
      const oldCommit = peelChain(forge, current).pop() as string;
      if (newCommit !== oldCommit && !isAncestorOf(forge, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportParts: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  const bodyOut = wantsSideband ? Buffer.concat([sidebandWrap(report), PKT_FLUSH]) : report;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}

/** True when `ancestor` is reachable from `descendant` by parent links. */
function isAncestorOf(forge: Forge, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = forge.store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}
