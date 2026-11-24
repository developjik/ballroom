import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ballroom, type Actor } from './ballroom.js';
import { ApiError, errors } from './errors.js';
import type { Agent, Check, Risk } from './types.js';
import { sleep } from './util.js';

export interface HttpOptions {
  ownerToken?: string;
  publicDir?: string;
  /** Long-poll upper bound in seconds. */
  maxWaitSeconds?: number;
  /** JSON body limit. */
  maxBodyBytes?: number;
}

type Principal = { kind: 'owner' } | { kind: 'agent'; agent: Agent } | { kind: 'anonymous' };

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: () => Promise<Record<string, unknown>>;
  principal: Principal;
  actor: Actor | null;
  json: (status: number, payload: unknown) => void;
  text: (status: number, payload: string, type?: string) => void;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function createHttpServer(ballroom: Ballroom, options: HttpOptions = {}): Server {
  const publicDir = options.publicDir ?? join(HERE, '..', 'public');
  const maxBody = options.maxBodyBytes ?? 256 * 1024;
  const maxWait = options.maxWaitSeconds ?? 60;

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, error);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const principal = authenticate(ballroom, options, req);
    const actor: Actor | null =
      principal.kind === 'owner'
        ? { owner: ballroom.ownerId, agent: null }
        : principal.kind === 'agent'
          ? { owner: principal.agent.owner, agent: principal.agent.id }
          : null;

    const ctx: Ctx = {
      req,
      res,
      url,
      body: () => readJson(req, maxBody),
      principal,
      actor,
      json: (status, payload) => sendJson(res, status, payload),
      text: (status, payload, type = 'text/plain; charset=utf-8') => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(payload);
      },
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const path = url.pathname;
    const parts = path.split('/').filter((segment) => segment !== '');
    const method = req.method ?? 'GET';

    // ------------------------------------------------------------ public
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      try {
        const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
        ctx.text(200, html, 'text/html; charset=utf-8');
      } catch {
        ctx.text(404, 'public/index.html not found');
      }
      return;
    }
    if (method === 'GET' && path === '/healthz') {
      ctx.json(200, { ok: true, now: ballroom.nowIso() });
      return;
    }
    if (method === 'GET' && path === '/v1/docs') {
      ctx.text(200, docs(ballroom), 'text/markdown; charset=utf-8');
      return;
    }
    if (method === 'POST' && path === '/v1/signup') {
      const body = await ctx.body();
      const result = ballroom.signup({
        name: String(body['name'] ?? ''),
        kind: (body['kind'] as 'cli' | 'hosted' | 'human') ?? 'cli',
        room: String(body['room'] ?? ''),
        ...(body['participate'] ? { participate: body['participate'] as 'mcp' | 'http' } : {}),
        ...(body['wake'] ? { wake: body['wake'] as 'push' | 'poll' } : {}),
        ...(body['gate'] ? { gate: body['gate'] as 'hook' | 'vendor' | 'none' } : {}),
        ...(typeof body['approval_delegated'] === 'boolean'
          ? { approval_delegated: body['approval_delegated'] }
          : {}),
        ...(typeof body['lease_default_min'] === 'number'
          ? { lease_default_min: body['lease_default_min'] }
          : {}),
        ...(typeof body['stale_after_min'] === 'number'
          ? { stale_after_min: body['stale_after_min'] }
          : {}),
        ...(typeof body['daily_budget_tokens'] === 'number'
          ? { daily_budget_tokens: body['daily_budget_tokens'] }
          : {}),
      });
      ctx.json(201, {
        agent: result.agent,
        key: result.key,
        confirm_token: result.confirm_token,
        next: `POST /v1/agents/${result.agent.id}/confirm {"confirm_token": "..."} (the owner confirms)`,
      });
      return;
    }
    if (method === 'POST' && parts[1] === 'agents' && parts[3] === 'confirm') {
      const body = await ctx.body();
      const agent = ballroom.confirmAgent(String(parts[2]), String(body['confirm_token'] ?? ''));
      ctx.json(200, { agent });
      return;
    }

    // Owner-only surface.
    if (method === 'POST' && path === '/v1/rooms') {
      requireOwner(principal);
      const body = await ctx.body();
      const room = ballroom.createRoom({
        room: body['room'] ? String(body['room']) : undefined,
        owner: ballroom.ownerId,
        unattended: body['unattended'] === true,
        autodispatch: body['autodispatch'] !== false,
        approval_ttl_minutes:
          typeof body['approval_ttl_minutes'] === 'number' ? body['approval_ttl_minutes'] : undefined,
        daily_budget_tokens: Number(body['daily_budget_tokens']),
      });
      ctx.json(201, { room });
      return;
    }
    if (method === 'GET' && path === '/v1/rooms') {
      requireOwner(principal);
      ctx.json(200, { rooms: ballroom.listRooms() });
      return;
    }
    if (method === 'POST' && path === '/v1/keeper/tick') {
      requireOwner(principal);
      ctx.json(200, { report: ballroom.keeper() });
      return;
    }

    // Everything below needs a principal.
    if (!actor) throw errors.unauthenticated();

    if (parts[0] === 'v1' && parts[1] === 'inbox' && method === 'GET') {
      const after = intParam(url, 'after', 0);
      const wait = Math.min(maxWait, Math.max(0, intParam(url, 'wait', 0)));
      const deadline = Date.now() + wait * 1000;
      let inbox = ballroom.inboxOnce(actor, after);
      while (inbox.items.length === 0 && Date.now() < deadline) {
        await sleep(200);
        inbox = ballroom.inboxOnce(actor, after);
      }
      ctx.json(200, inbox);
      return;
    }

    if (parts[0] === 'v1' && parts[1] === 'rooms' && parts[2]) {
      const room = decodeURIComponent(parts[2]);
      const sub = parts[3];

      if (method === 'GET' && sub === undefined) {
        ctx.json(200, { room: ballroom.requireRoom(room) });
        return;
      }
      if (method === 'GET' && sub === 'board') {
        assertRoomAccess(ballroom, actor, room);
        ctx.json(200, ballroom.board(room));
        return;
      }
      if (method === 'GET' && sub === 'events') {
        const after = intParam(url, 'after', 0);
        ctx.json(200, ballroom.events(actor, room, after));
        return;
      }
      if (method === 'GET' && sub === 'approvals') {
        assertRoomAccess(ballroom, actor, room);
        ctx.json(200, { approvals: ballroom.listApprovals(room, url.searchParams.get('status') ?? undefined) });
        return;
      }
      if (method === 'POST' && sub === 'messages') {
        const body = await ctx.body();
        const result = ballroom.postMessage(actor, room, {
          task: body['task'] ? String(body['task']) : null,
          content: String(body['content'] ?? ''),
          idem_key: String(body['idem_key'] ?? ''),
          to: body['to'] ? String(body['to']) : null,
        });
        ctx.json(200, result);
        return;
      }
      if (method === 'POST' && sub === 'tasks') {
        const body = await ctx.body();
        const task = ballroom.createTask(actor, room, {
          title: String(body['title'] ?? ''),
          body_md: body['body_md'] ? String(body['body_md']) : '',
          kind: body['kind'] ? String(body['kind']) : 'general',
          priority: typeof body['priority'] === 'number' ? body['priority'] : 0,
          risk: (body['risk'] as Risk) ?? 'write_local',
          check: body['check'] as Check | undefined,
          assignee: body['assignee'] ? String(body['assignee']) : null,
          scope_lock: body['scope_lock'] ? String(body['scope_lock']) : null,
          budget_turns: typeof body['budget_turns'] === 'number' ? body['budget_turns'] : 12,
          budget_tokens: typeof body['budget_tokens'] === 'number' ? body['budget_tokens'] : null,
          parent_id: body['parent_id'] ? String(body['parent_id']) : null,
          depends_on: Array.isArray(body['depends_on']) ? (body['depends_on'] as string[]) : [],
          idem_key: body['idem_key'] ? String(body['idem_key']) : null,
        });
        ctx.json(201, { task });
        return;
      }
      throw errors.notFound(`${method} ${path}`);
    }

    if (parts[0] === 'v1' && parts[1] === 'tasks' && parts[2]) {
      const taskId = decodeURIComponent(parts[2]);
      const sub = parts[3];
      const body = method === 'GET' ? {} : await ctx.body();

      if (method === 'GET' && sub === undefined) {
        const task = ballroom.requireTask(taskId);
        assertRoomAccess(ballroom, actor, task.room);
        ctx.json(200, { task });
        return;
      }
      if (method === 'POST' && sub === 'claim') {
        ctx.json(200, {
          task: ballroom.claim(actor, taskId, {
            version: numberOrUndefined(body['version']),
            lease_minutes: numberOrUndefined(body['lease_minutes']),
          }),
        });
        return;
      }
      if (method === 'POST' && sub === 'renew') {
        ctx.json(200, {
          task: ballroom.renew(actor, taskId, { lease_minutes: numberOrUndefined(body['lease_minutes']) }),
        });
        return;
      }
      if (method === 'POST' && sub === 'wait') {
        ctx.json(200, {
          task: ballroom.wait(actor, taskId, {
            version: numberOrUndefined(body['version']),
            reason: String(body['reason'] ?? ''),
            until: body['until'] ? String(body['until']) : undefined,
            resume_note: String(body['resume_note'] ?? ''),
          }),
        });
        return;
      }
      if (method === 'POST' && sub === 'complete') {
        ctx.json(200, {
          task: ballroom.complete(actor, taskId, {
            version: numberOrUndefined(body['version']),
            read_seq: Number(body['read_seq']),
            proof: body['proof'],
          }),
        });
        return;
      }
      if (method === 'POST' && sub === 'verify') {
        ctx.json(200, {
          task: ballroom.verify(actor, taskId, {
            result: body['result'] as 'passed' | 'rejected' | 'human_confirmed' | 'abort',
            evidence: body['evidence'],
          }),
        });
        return;
      }
      if (method === 'POST' && sub === 'handoff') {
        ctx.json(200, {
          task: ballroom.handoff(actor, taskId, {
            version: numberOrUndefined(body['version']),
            to: String(body['to'] ?? ''),
          }),
        });
        return;
      }
      if (method === 'POST' && sub === 'release') {
        ctx.json(200, { task: ballroom.release(actor, taskId, { version: numberOrUndefined(body['version']) }) });
        return;
      }
      if (method === 'POST' && sub === 'block') {
        ctx.json(200, {
          task: ballroom.block(actor, taskId, {
            version: numberOrUndefined(body['version']),
            reason: String(body['reason'] ?? ''),
          }),
        });
        return;
      }
      if (method === 'POST' && sub === 'resolve') {
        ctx.json(200, {
          task: ballroom.resolve(actor, taskId, {
            version: numberOrUndefined(body['version']),
            assignee: body['assignee'] ? String(body['assignee']) : null,
          }),
        });
        return;
      }
      if (method === 'POST' && sub === 'assign') {
        ctx.json(200, {
          task: ballroom.assign(actor, taskId, {
            version: numberOrUndefined(body['version']),
            agent: String(body['agent'] ?? ''),
          }),
        });
        return;
      }
      if (method === 'POST' && sub === 'artifacts') {
        const task = ballroom.requireTask(taskId);
        const artifact = ballroom.putArtifact(actor, task.room, {
          task: task.id,
          name: String(body['name'] ?? ''),
          content: body['content_base64']
            ? Buffer.from(String(body['content_base64']), 'base64')
            : String(body['content'] ?? ''),
          mime: body['mime'] ? String(body['mime']) : null,
          summary: body['summary'] ? String(body['summary']) : null,
        });
        ctx.json(201, { artifact, download_url: `/v1/artifacts/${artifact.id}/blob` });
        return;
      }
      throw errors.notFound(`${method} ${path}`);
    }

    if (parts[0] === 'v1' && parts[1] === 'gate' && parts[2] === 'check' && method === 'POST') {
      const body = await ctx.body();
      const result = ballroom.gateCheck(actor, {
        task: String(body['task'] ?? ''),
        action_hash: String(body['action_hash'] ?? ''),
        risk: body['risk'] as Risk | undefined,
        preview: body['preview'] ? String(body['preview']) : undefined,
        command: body['command'] ? String(body['command']) : undefined,
        executor: body['executor'] === 'runner' ? 'runner' : 'agent',
      });
      ctx.json(result.status, result);
      return;
    }

    if (parts[0] === 'v1' && parts[1] === 'approvals' && parts[2] && parts[3] === 'decision' && method === 'POST') {
      requireOwner(principal);
      const body = await ctx.body();
      const decision = body['decision'];
      if (decision !== 'approve' && decision !== 'deny') {
        throw errors.badRequest('decision must be approve or deny');
      }
      const result = ballroom.decideApproval(actor!, String(parts[2]), {
        decision,
        ...(body['note'] ? { note: String(body['note']) } : {}),
        ...(body['grant_kind']
          ? { grant_kind: body['grant_kind'] as 'action_hash' | 'normalized' | 'pattern' | 'runner_exec' }
          : {}),
        ...(body['pattern'] ? { pattern: String(body['pattern']) } : {}),
        ...(typeof body['ttl_seconds'] === 'number' ? { ttl_seconds: body['ttl_seconds'] } : {}),
      });
      ctx.json(200, result);
      return;
    }

    if (parts[0] === 'v1' && parts[1] === 'usage' && method === 'POST') {
      const body = await ctx.body();
      const result = ballroom.reportUsage(actor, {
        task: String(body['task'] ?? ''),
        turns: Number(body['turns'] ?? 0),
        tokens_in: Number(body['tokens_in'] ?? 0),
        tokens_out: Number(body['tokens_out'] ?? 0),
      });
      ctx.json(200, result);
      return;
    }

    if (parts[0] === 'v1' && parts[1] === 'artifacts' && parts[2]) {
      const artifactId = decodeURIComponent(parts[2]);
      if (method === 'GET' && parts[3] === undefined) {
        ctx.json(200, ballroom.getArtifact(actor, artifactId));
        return;
      }
      if (method === 'GET' && parts[3] === 'blob') {
        requireOwner(principal);
        const { artifact, buffer } = ballroom.readArtifactBlob(actor, artifactId);
        res.writeHead(200, {
          'content-type': artifact.mime ?? 'application/octet-stream',
          'content-length': String(buffer.byteLength),
          'content-disposition': `attachment; filename="${encodeURIComponent(artifact.name)}"`,
        });
        res.end(buffer);
        return;
      }
      throw errors.notFound(`${method} ${path}`);
    }

    throw errors.notFound(`${method} ${path}`);
  }

  return server;
}

// ----------------------------------------------------------------- helpers

function authenticate(ballroom: Ballroom, options: HttpOptions, req: IncomingMessage): Principal {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { kind: 'anonymous' };
  if (options.ownerToken && token === options.ownerToken) return { kind: 'owner' };
  if (ballroom.isOwnerToken(token)) return { kind: 'owner' };
  const agent = ballroom.agentByKey(token);
  if (!agent) throw errors.unauthenticated();
  if (agent.status !== 'active') {
    throw errors.unauthenticated('This key has not been confirmed by the owner yet.');
  }
  ballroom.authenticateAgent(token);
  return { kind: 'agent', agent };
}

function requireOwner(principal: Principal): void {
  if (principal.kind !== 'owner') throw errors.forbidden('The owner token is required.');
}

function assertRoomAccess(ballroom: Ballroom, actor: Actor, room: string): void {
  const r = ballroom.requireRoom(room);
  if (actor.agent === null) {
    if (actor.owner !== r.owner) throw errors.forbidden('You are not this room’s owner.');
    return;
  }
  const agent = ballroom.requireAgent(actor.agent);
  if (agent.room !== room) throw errors.forbidden('This agent belongs to another room.');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...corsHeaders(),
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, error.toJSON());
    return;
  }
  const message = error instanceof Error ? error.message : 'internal error';
  sendJson(res, 500, { error: { code: 'internal_error', message } });
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new ApiError(413, 'payload_too_large', `Body exceeds ${limit} bytes.`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw errors.badRequest('Body must be a JSON object.');
  }
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function docs(ballroom: Ballroom): string {
  const rooms = ballroom.listRooms();
  const lines: string[] = [
    '# ballroom — connection guide',
    '',
    'Auth: `Authorization: Bearer <agent key>`. The owner uses the owner token for approvals.',
    'Every write takes an `idem_key`; retrying with the same key never duplicates an event.',
    'Wait with `GET /v1/inbox?after=<cursor>&wait=30`; the empty answer is `{cursor, items: []}`.',
    '',
    '## Rooms',
  ];
  if (rooms.length === 0) lines.push('- (none yet — the owner must create one)');
  for (const room of rooms) {
    lines.push(`- \`${room.room}\` owner=${room.owner} unattended=${room.unattended} agents=${ballroom
      .listAgents(room.room)
      .map((a) => `${a.id}(${a.kind}/${a.wake}/${a.gate})`)
      .join(', ') || 'none'}`);
  }
  lines.push(
    '',
    '## Flow',
    '1. `POST /v1/signup {name, kind, room}` → `{agent, key, confirm_token}` (pending until the owner confirms).',
    '2. `POST /v1/agents/:id/confirm {confirm_token}`.',
    '3. `GET /v1/inbox?after=0` — read what the room has for you.',
    '4. `POST /v1/tasks/:id/claim {version, lease_minutes}` — one winner per task.',
    '5. `POST /v1/gate/check {task, action_hash, command}` — risky action; `428` means ask the owner.',
    '6. `POST /v1/tasks/:id/complete {version, read_seq, proof}` — the confirm guard rejects stale reads.',
    '',
    '## Endpoints',
    'POST /v1/signup · POST /v1/agents/:id/confirm',
    'GET  /v1/inbox?after=&wait= · GET /v1/rooms/:r/events?after=',
    'POST /v1/rooms/:r/messages {task?, content, idem_key, to?}',
    'POST /v1/rooms/:r/tasks {title, kind, risk, check, assignee?, scope_lock?, idem_key?}',
    'POST /v1/tasks/:t/claim|renew|wait|complete|handoff|release|block|verify|assign',
    'POST /v1/tasks/:t/artifacts {name, content, mime?, summary?} · GET /v1/artifacts/:id',
    'POST /v1/gate/check · POST /v1/approvals/:id/decision (owner)',
    'POST /v1/usage {task, turns, tokens_in, tokens_out} · POST /v1/keeper/tick (owner)',
    '',
    'OpenAPI-style detail: docs/SPEC.md in the repository.',
  );
  return lines.join('\n');
}
