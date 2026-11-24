#!/usr/bin/env node
import { Ballroom } from './ballroom.js';
import { createHttpServer } from './http.js';
import { randomToken } from './util.js';

const port = Number(process.env['PORT'] ?? 8787);
const dbFile = process.env['BALLROOM_DB'] ?? './data/ballroom.sqlite';
const roomName = process.env['BALLROOM_ROOM'] ?? 'main';
const keeperEvery = Number(process.env['BALLROOM_KEEPER_MS'] ?? 5000);
const dailyBudget = Number(process.env['BALLROOM_DAILY_BUDGET_TOKENS'] ?? 5_000_000);
const unattended = process.env['BALLROOM_UNATTENDED'] === '1';
const autodispatch = process.env['BALLROOM_AUTODISPATCH'] !== '0';

const ballroom = new Ballroom({ dbFile, ownerId: process.env['BALLROOM_OWNER'] ?? 'owner' });

let ownerToken = process.env['BALLROOM_OWNER_TOKEN'];
if (!ownerToken) {
  if (ballroom.hasOwnerToken()) {
    console.error(
      'BALLROOM_OWNER_TOKEN is not set and this database already has one. Set the original token, or delete the DB to start fresh.',
    );
    process.exit(1);
  }
  ownerToken = randomToken(24);
  ballroom.setOwnerToken(ownerToken);
  console.log(`owner token (shown once, store it now): ${ownerToken}`);
}

if (!ballroom.listRooms().some((room) => room.room === roomName)) {
  const room = ballroom.createRoom({
    room: roomName,
    unattended,
    autodispatch,
    daily_budget_tokens: dailyBudget,
  });
  console.log(`created room "${room.room}" (daily budget ${room.daily_budget_tokens} tokens)`);
}

const server = createHttpServer(ballroom, { ownerToken });

server.listen(port, () => {
  console.log(`ballroomd listening on http://localhost:${port}`);
  console.log(`  board   http://localhost:${port}/?room=${encodeURIComponent(roomName)}`);
  console.log(`  docs    http://localhost:${port}/v1/docs`);
  console.log(`  sqlite  ${dbFile}`);
  console.log(`  keeper  every ${keeperEvery}ms`);
});

const timer = setInterval(() => {
  try {
    const report = ballroom.keeper();
    const actions =
      report.dispatched.length + report.woke.length + report.leasesExpired.length + report.unassigned.length;
    if (actions > 0) {
      console.log(
        `keeper: dispatched=${report.dispatched.length} woke=${report.woke.length} lease_expired=${report.leasesExpired.length} unassigned=${report.unassigned.length} blocked=${report.blocked.length}`,
      );
    }
  } catch (error) {
    console.error('keeper failed:', error);
  }
}, keeperEvery);

function shutdown(signal: string): void {
  console.log(`${signal} received, closing`);
  clearInterval(timer);
  server.close(() => {
    ballroom.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
