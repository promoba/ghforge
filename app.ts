// The HTTP server: one process serving the git smart-HTTP routes, the REST
// v3 API, the GraphQL endpoint and the MCP endpoint, all over the forge's
// single in-memory store. Authentication is the one bearer token the
// harness hands the process in MAKEFUN_SHOP_TOKEN; /healthz is the only
// unauthenticated route.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { infoRefs, receivePack, uploadPack, type HttpResult } from './githttp.ts';
import { handleRest, type RestResponse } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = forge.nextRequestId();
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  // Git smart HTTP.
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch) {
    if (!authorized(req)) {
      sendBuffer(res, 401, 'text/plain; charset=utf-8', Buffer.from('authentication required\n'), requestId);
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const repo = forge.getRepo(owner, name);
    if (!repo) {
      sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found\n'), requestId);
      return;
    }
    const endpoint = gitMatch[3] as string;
    let result: HttpResult;
    if (endpoint === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service\n'), requestId);
        return;
      }
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      result = infoRefs(forge, repo, service, version2);
    } else if (endpoint === 'git-upload-pack' && method === 'POST') {
      result = uploadPack(forge, repo, await readBody(req));
    } else if (endpoint === 'git-receive-pack' && method === 'POST') {
      result = receivePack(forge, repo, await readBody(req));
    } else {
      sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'), requestId);
      return;
    }
    sendBuffer(res, result.status, result.contentType, result.body, requestId);
    return;
  }

  // The MCP endpoint parses its own body (a parse failure is a JSON-RPC error).
  if (path === '/mcp' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Authentication required' }, requestId);
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    const reply = handleMcp(forge, raw);
    if (reply.body === undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': requestId });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, requestId);
    return;
  }

  // The GraphQL endpoint.
  if (path === '/api/graphql' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Authentication required' }, requestId);
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] }, requestId);
      return;
    }
    const reply = handleGraphQL(forge, parsed);
    sendJson(res, reply.status, reply.body, requestId);
    return;
  }

  // The REST v3 API.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Authentication required' }, requestId);
      return;
    }
    const raw = await readBody(req);
    let body: Record<string, unknown> | undefined;
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as unknown;
        body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, { message: 'Malformed JSON body' }, requestId);
        return;
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const reply: RestResponse = handleRest(forge, { method, segments, query: url.searchParams, body, origin });
    sendJson(res, reply.status, reply.body, requestId, reply.headers ?? {});
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req, res) => {
    route(forge, req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, forge.nextRequestId());
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
}
