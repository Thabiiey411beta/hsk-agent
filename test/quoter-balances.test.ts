// getBalances must read the t-pool tokens (tUSDT/tWHSK), not the old
// synthetic USDT/WHSK pair — the old USDT balance is 0 while the wallet
// really holds 1,000 tUSDT / 10,000 tWHSK (verified live 2026-11-23).
// Offline: a stub JSON-RPC server answers eth_getBalance / eth_call with
// a different balance per token address, so reading the wrong token fails.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { JsonRpcProvider } from 'ethers';
import { getBalances } from '../src/quoter.js';
import { ADDR, TEST_TOKENS } from '../src/config.js';

function encU256(v: bigint): string {
  return '0x' + v.toString(16).padStart(64, '0');
}

const HSK_WEI = 88680220529960031n; // 0.0887 HSK, live wallet value at fix time
const TUSDT_RAW = 1_000_000_000n; // 1,000 tUSDT (6 dec)
const TWHSK_RAW = 10_000n * 10n ** 18n; // 10,000 tWHSK (18 dec)

let server: Server;
let url: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          // ethers v6 batches requests into a JSON array; answer in kind.
          const batch = Array.isArray(parsed) ? parsed : [parsed];
          const out = batch.map((rpc) => {
            const { method, params, id } = rpc;
            let result: string;
            if (method === 'eth_chainId') result = '0x85'; // 133
            else if (method === 'net_version') result = '133';
            else if (method === 'eth_blockNumber') result = '0x1';
            else if (method === 'eth_getBalance') result = encU256(HSK_WEI);
            else if (method === 'eth_call') {
              const to = String(params[0].to).toLowerCase();
              if (to === TEST_TOKENS.tUsdt.toLowerCase()) result = encU256(TUSDT_RAW);
              else if (to === TEST_TOKENS.tWhsk.toLowerCase()) result = encU256(TWHSK_RAW);
              else result = encU256(0n); // old USDT/WHSK (and anything else): 0
            } else throw new Error(`unexpected RPC method ${method}`);
            return { jsonrpc: '2.0', id, result };
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        if (typeof a !== 'object' || !a) throw new Error('stub server failed to bind');
        url = `http://127.0.0.1:${a.port}`;
        resolve();
      });
    }),
);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('getBalances reads the t-pool tokens', () => {
  it('returns HSK + tUSDT + tWHSK raw balances (not the old pair)', async () => {
    const provider = new JsonRpcProvider(url);
    const bal = await getBalances(provider, '0xF5bDFE902718Bd75d2d6A6070dcdC6FBF9D781DA');
    expect(bal.hsk).toBe(HSK_WEI);
    expect(bal.tUsdt).toBe(TUSDT_RAW);
    expect(bal.tWhsk).toBe(TWHSK_RAW);
    // Sanity: the old addresses would have returned 0 in this stub.
    expect(ADDR.usdt.toLowerCase()).not.toBe(TEST_TOKENS.tUsdt.toLowerCase());
    expect(ADDR.whsk.toLowerCase()).not.toBe(TEST_TOKENS.tWhsk.toLowerCase());
  });
});
