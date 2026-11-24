import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { Ballroom } from '../src/ballroom.js';
import { createHttpServer } from '../src/http.js';
import { sha256 } from '../src/util.js';

interface Node {
  b: Ballroom;
  server: Server;
  base: string;
}

const started: Node[] = [];

async function start(): Promise<Node> {
  const b = new Ballroom({ dbFile: ':memory:', ownerToken: 'owner-token' });
  b.createRoom({ room: 'http', daily_budget_tokens: 500_000 });
  const server = createHttpServer(b, { ownerToken: 'owner-token' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const node = { b, server, base: `http://127.0.0.1:${port}` };
  started.push(node);
  return node;
}

afterEach(async () => {
  for (const node of started.splice(0)) {
    await new Promise<void>((resolve) => node.server.close(() => resolve()));
    node.b.close();
  }
});

async function call(
  node: Node,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${node.base}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // html or markdown
  }
  return { status: response.status, body: parsed };
}

async function signupAndConfirm(node: Node, name: string): Promise<string> {
  const signup = await call(node, 'POST', '/v1/signup', {
    body: { name, kind: 'cli', room: 'http' },
  });
  expect(signup.status).toBe(201);
  const confirm = await call(node, 'POST', `/v1/agents/${name}/confirm`, {
    body: { confirm_token: signup.body.confirm_token },
  });
  expect(confirm.status).toBe(200);
  return signup.body.key as string;
}

describe('HTTP surface', () => {
  test('the board needs the owner token', async () => {
    const node = await start();
    expect((await call(node, 'GET', '/v1/rooms/http/board')).status).toBe(401);
    const ok = await call(node, 'GET', '/v1/rooms/http/board', { token: 'owner-token' });
    expect(ok.status).toBe(200);
    expect(ok.body.room.room).toBe('http');
    expect(ok.body.stats.total).toBe(0);
  });

  test('a signup key does nothing until the owner confirms it', async () => {
    const node = await start();
    const signup = await call(node, 'POST', '/v1/signup', {
      body: { name: 'claude', kind: 'cli', room: 'http' },
    });
    expect(signup.status).toBe(201);
    expect(signup.body.key).toMatch(/^br_claude_/);
    const pending = await call(node, 'GET', '/v1/inbox?after=0', { token: signup.body.key });
    expect(pending.status).toBe(401);
    expect(pending.body.error.code).toBe('unauthenticated');

    const confirm = await call(node, 'POST', '/v1/agents/claude/confirm', {
      body: { confirm_token: signup.body.confirm_token },
    });
    expect(confirm.status).toBe(200);
    const inbox = await call(node, 'GET', '/v1/inbox?after=0', { token: signup.body.key });
    expect(inbox.status).toBe(200);
    expect(inbox.body.items).toEqual([]);
    expect(inbox.body.cursor).toBeGreaterThan(0);
  });

  test('long polling returns as soon as a message for the agent arrives', async () => {
    const node = await start();
    const a1 = await signupAndConfirm(node, 'a1');
    const a2 = await signupAndConfirm(node, 'a2');
    const cursor = (await call(node, 'GET', '/v1/inbox?after=0', { token: a2 })).body.cursor as number;

    const pending = call(node, 'GET', `/v1/inbox?after=${cursor}&wait=5`, { token: a2 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const posted = await call(node, 'POST', '/v1/rooms/http/messages', {
      token: a1,
      body: { content: 'look at this @a2', to: 'a2', idem_key: 'http-msg-1' },
    });
    expect(posted.status).toBe(200);
    expect(posted.body.mentions).toEqual(['a2']);

    const awaited = await pending;
    expect(awaited.body.items.length).toBeGreaterThan(0);
    expect(awaited.body.items.at(-1).payload.content).toContain('look at this');
  });

  test('the board UI is served', async () => {
    const node = await start();
    const response = await fetch(`${node.base}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('ballroom');
    expect(html).toContain('/v1/rooms/');
  });

  test('a task goes create → claim → gate 428 → approve → complete over HTTP', async () => {
    const node = await start();
    const key = await signupAndConfirm(node, 'worker');

    const created = await call(node, 'POST', '/v1/rooms/http/tasks', {
      token: 'owner-token',
      body: {
        title: 'ship it',
        kind: 'cli',
        risk: 'irreversible',
        assignee: 'worker',
        check: { kind: 'command', target: 'npm test' },
        idem_key: 'task-http-1',
      },
    });
    expect(created.status).toBe(201);
    const task = created.body.task;

    const claim = await call(node, 'POST', `/v1/tasks/${task.id}/claim`, {
      token: key,
      body: { version: task.version, lease_minutes: 10 },
    });
    expect(claim.status).toBe(200);
    expect(claim.body.task.status).toBe('running');

    await call(node, 'GET', '/v1/inbox?after=0', { token: key });

    const gate = await call(node, 'POST', '/v1/gate/check', {
      token: key,
      body: {
        task: task.id,
        action_hash: sha256('git push origin main --force'),
        command: 'git push origin main --force',
        risk: 'irreversible',
      },
    });
    expect(gate.status).toBe(428);
    expect(gate.body.allow).toBe(false);
    const approvalId = gate.body.approval_id;

    const decision = await call(node, 'POST', `/v1/approvals/${approvalId}/decision`, {
      token: 'owner-token',
      body: { decision: 'approve' },
    });
    expect(decision.status).toBe(200);
    expect(decision.body.grant.kind).toBe('normalized');

    await call(node, 'GET', '/v1/inbox?after=0', { token: key });
    const allowed = await call(node, 'POST', '/v1/gate/check', {
      token: key,
      body: {
        task: task.id,
        action_hash: sha256('git push --force origin main'),
        command: 'git push --force origin main',
        risk: 'irreversible',
      },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.allow).toBe(true);

    const fresh = (await call(node, 'GET', `/v1/tasks/${task.id}`, { token: key })).body.task;
    const complete = await call(node, 'POST', `/v1/tasks/${task.id}/complete`, {
      token: key,
      body: { version: fresh.version, read_seq: fresh.last_seq, proof: { pushed: true } },
    });
    expect(complete.status).toBe(200);
    expect(complete.body.task.status).toBe('review');

    const verified = await call(node, 'POST', `/v1/tasks/${task.id}/verify`, {
      token: 'owner-token',
      body: { result: 'passed', evidence: 'npm test exit 0' },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.task.status).toBe('done');

    const board = await call(node, 'GET', '/v1/rooms/http/board', { token: 'owner-token' });
    expect(board.body.stats.done).toBe(1);
  });

  test('an agent from another room is refused', async () => {
    const node = await start();
    node.b.createRoom({ room: 'second', daily_budget_tokens: 1000 });
    const signup = await call(node, 'POST', '/v1/signup', {
      body: { name: 'outsider', kind: 'cli', room: 'second' },
    });
    await call(node, 'POST', '/v1/agents/outsider/confirm', {
      body: { confirm_token: signup.body.confirm_token },
    });
    const board = await call(node, 'GET', '/v1/rooms/http/board', { token: signup.body.key });
    expect(board.status).toBe(403);
  });

  test('an unknown key is 401 and a malformed body is 400', async () => {
    const node = await start();
    const unknown = await call(node, 'GET', '/v1/inbox?after=0', { token: 'br_nope' });
    expect(unknown.status).toBe(401);

    const key = await signupAndConfirm(node, 'worker');
    const bad = await fetch(`${node.base}/v1/rooms/http/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);
  });
});
