// Tiny HTTP server (Node built-in only): serves the web UI + JSON API.
// GET  /            web UI
// GET  /api/state   agent state (positions, P&L, last signal, config)
// GET  /api/journal?limit=50  recent journal entries
// POST /api/chat    { message } -> { reply }  (conversational interface)
// POST /api/poll    trigger one poll cycle now
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { handleChat } from './chat.js';
import type { Agent } from './agent.js';

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function createApiServer(agent: Agent, port = 8787) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const s = agent.state;
        sendJson(res, 200, {
          mode: s.mode,
          equity: s.equity,
          dailyPnl: s.dailyPnl,
          positions: s.positions,
          lastSignal: s.lastSignal,
          lastPrices: s.lastPrices,
          lastTPool: s.lastTPool,
          lastSupra: s.lastSupra,
          lastVaultCaps: s.lastVaultCaps,
          effectiveCaps: s.effectiveCaps,
          lastTrendGate: s.lastTrendGate,
          lastAtr: s.lastAtr,
          polls: s.polls,
          trades: s.trades,
          liveTrades: s.liveTrades,
          halted: s.halted,
          haltReason: s.haltReason,
          config: s.config,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/journal') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 500);
        sendJson(res, 200, agent.journal.tail(limit));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = JSON.parse(await readBody(req)) as { message?: string };
        const result = handleChat(agent, body.message ?? '');
        agent.journal.append({ type: 'chat', message: body.message ?? '', reply: result.reply });
        sendJson(res, 200, result);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/poll') {
        const out = await agent.poll();
        sendJson(res, 200, out);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  });
  server.listen(port, () => {
    console.log(`HSK agent UI: http://localhost:${port} (mode=${agent.state.mode})`);
  });
  return server;
}
