import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../src/http.js';
import type { Ballroom } from '../src/ballroom.js';

export interface RunningServer {
  server: Server;
  base: string;
  close: () => Promise<void>;
}

/** A real ballroomd on an ephemeral loopback port, for tests. */
export async function startServer(ballroom: Ballroom, ownerToken?: string): Promise<RunningServer> {
  const server = createHttpServer(ballroom, { ...(ownerToken ? { ownerToken } : {}) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
