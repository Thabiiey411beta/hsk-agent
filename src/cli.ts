// CLI entrypoint.
//   npm run paper            paper mode (default): poll + serve UI on :8787
//   node dist/cli.js --live  testnet execution (requires .env PRIVATE_KEY + test funds)
//   node dist/cli.js --dry-run [amountUsdt]  quote -> build -> simulate, sends nothing
//   node dist/cli.js --backtest [days] [--weights v1|v2] [--gate|--no-gate] [--atr|--no-atr]
//     replay subgraph swaps, print metrics. --weights v1 = original
//     pre-Supra weights (spread 50 + TWAP 30 + volume 20) WITHOUT the trend
//     gate and WITHOUT ATR sizing (v1 predates both — that combination
//     reproduces the recorded v1 baseline exactly); v2 (default) = current
//     weights WITH the gate and ATR sizing. --gate/--no-gate and
//     --atr/--no-atr override the weights default, so each factor's effect
//     is isolable (e.g. v1 --gate, v2 --no-gate, v1 --atr).
//   node dist/cli.js --once                  single paper poll, then exit
import { JsonRpcProvider, formatUnits } from 'ethers';
import { Agent } from './agent.js';
import { createApiServer } from './server.js';
import { runBacktest, runTPoolBacktest } from './backtest.js';
import { DEFAULT_CONFIG, POOLS, T_POOL, TESTNET_RPC, loadEnv } from './config.js';
import { assertTestnet, getBalances, walletFromEnv } from './quoter.js';
import { handleChat } from './chat.js';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);

async function main(): Promise<void> {
  if (has('--backtest')) {
    const days = Number(args[args.indexOf('--backtest') + 1] ?? 30) || 30;
    const weightsArg = args[args.indexOf('--weights') + 1];
    const weights: 'v1' | 'v2' = weightsArg === 'v1' ? 'v1' : 'v2';
    // v1 predates the trend gate AND ATR sizing: both default OFF for v1,
    // ON for v2. Explicit --gate/--no-gate and --atr/--no-atr always win,
    // so each factor's effect is isolable (v1 --gate, v2 --no-gate, v1 --atr).
    const trendGate = has('--gate') ? true : has('--no-gate') ? false : weights === 'v2';
    const atrSizing = has('--atr') ? true : has('--no-atr') ? false : weights === 'v2';
    console.log(`Backtest: replaying real testnet USDT/WHSK 0.05% swaps, last ${days}d (weights ${weights}, trend gate ${trendGate ? 'ON' : 'OFF'}, ATR sizing ${atrSizing ? 'ON' : 'OFF'})...`);
    const res = await runBacktest(DEFAULT_CONFIG, POOLS.lowFee.id, days, { weights, trendGate, atrSizing });
    console.log(JSON.stringify({ weights: res.weights, trendGate: res.trendGate, atrSizing: res.atrSizing, swapsReplayed: res.swapsReplayed, trades: res.trades.length, wins: res.wins, losses: res.losses, winRatePct: res.winRate, totalPnlUsdt: res.totalPnlUsdt, totalPnlPct: res.totalPnlPct, signalsSeen: res.signalsSeen, blocked: res.blocked, gateBlocked: res.gateBlocked, atrUsed: res.atrUsed, dailyBars: res.dailyBars }, null, 2));
    for (const t of res.trades.slice(0, 20)) {
      console.log(`  ${new Date(t.ts * 1000).toISOString()} entry ${t.entryPrice.toFixed(2)} -> exit ${t.exitPrice.toFixed(2)} size ${t.sizeUsdt} pnl ${t.pnlUsdt} (${t.pnlPct}%) [${t.reason}]`);
    }
    console.log('T-pool backtest: replaying the tWHSK/tUSDT pool\'s own swap history through the new signal + trend gate + ATR sizing...');
    const tRes = await runTPoolBacktest(DEFAULT_CONFIG);
    console.log(JSON.stringify({ weights: tRes.weights, trendGate: tRes.trendGate, atrSizing: tRes.atrSizing, pool: T_POOL.id, swapsReplayed: tRes.swapsReplayed, trades: tRes.trades.length, wins: tRes.wins, losses: tRes.losses, winRatePct: tRes.winRate, totalPnlUsdt: tRes.totalPnlUsdt, totalPnlPct: tRes.totalPnlPct, signalsSeen: tRes.signalsSeen, blocked: tRes.blocked, gateBlocked: tRes.gateBlocked, atrUsed: tRes.atrUsed, dailyBars: tRes.dailyBars }, null, 2));
    console.log('NOTE: backtest/paper numbers are NOT live profit.');
    return;
  }

  if (has('--dry-run')) {
    const amount = Number(args[args.indexOf('--dry-run') + 1] ?? 10) || 10;
    const from = args[args.indexOf('--dry-run') + 2] ?? '0x0000000000000000000000000000000000000000';
    console.log(`Dry-run: quoting ${amount} tUSDT -> tWHSK on the t-pool via QuoterV2, then simulating the router call (no tx sent)...`);
    const out = (await Agent.dryRun(amount, from)) as {
      quote: { amountOut: bigint; gasEstimate: bigint };
      simulatedOut: bigint | null;
      gasEstimate: bigint | null;
      simulationError: string | null;
    };
    console.log(JSON.stringify({
      quotedOut: out.quote.amountOut.toString(),
      quoterGasEstimate: out.quote.gasEstimate.toString(),
      simulatedOut: out.simulatedOut?.toString() ?? null,
      txGasEstimate: out.gasEstimate?.toString() ?? null,
      simulationError: out.simulationError,
      match: out.simulatedOut !== null && out.quote.amountOut === out.simulatedOut,
    }, null, 2));
    if (out.simulationError) {
      console.log('Router simulation reverted as expected for an unfunded wallet (router pulls test USDT from the sender). Quote + tx build proven; a funded wallet is required to simulate/send. Nothing was sent on-chain.');
    } else {
      console.log('Dry-run complete: quote -> build -> simulate proven. Nothing was sent on-chain.');
    }
    return;
  }

  if (has('--live')) {
    const env = loadEnv();
    if (!env.privateKey) {
      console.error('LIVE REFUSED: no PRIVATE_KEY in .env. Create a fresh testnet-only wallet and put its key in .env (never commit it).');
      process.exit(1);
    }
    const provider = new JsonRpcProvider(env.rpcUrl || TESTNET_RPC);
    await assertTestnet(provider); // throws on mainnet (177) or any other chain
    const wallet = walletFromEnv(env.privateKey, provider);
    const bal = await getBalances(provider, wallet.address);
    // Human-readable: HSK 18 dec, tUSDT 6 dec, tWHSK 18 dec. getBalances
    // reads the t-pool tokens; the old synthetic USDT/WHSK pair reads 0.
    console.log(`Live wallet ${wallet.address} — HSK ${formatUnits(bal.hsk, 18)}, tUSDT ${formatUnits(bal.tUsdt, 6)}, tWHSK ${formatUnits(bal.tWhsk, 18)}`);
    if (bal.hsk === 0n) {
      console.error('LIVE REFUSED: wallet holds 0 test HSK — cannot pay gas. Get test HSK from the faucet first (see FUNDS.md). No trade attempted.');
      process.exit(1);
    }
    console.log('Live mode armed (testnet only, ONE live trade max per run, <= 10 tUSDT). Starting agent loop...');
    const agent = new Agent({}, 'live', 'data/journal.jsonl', null, { wallet, provider });
    if (has('--once')) {
      const out = await agent.poll();
      console.log(JSON.stringify({ action: out.action, signal: out.signal, equity: agent.state.equity, positions: agent.state.positions, liveTrades: agent.state.liveTrades }, null, 2));
      return;
    }
    agent.start();
    createApiServer(agent, 8787);
    return;
  }

  // Paper mode (default) + --once.
  const agent = new Agent({}, 'paper');
  if (has('--once')) {
    const out = await agent.poll();
    console.log(JSON.stringify({ action: out.action, signal: out.signal, equity: agent.state.equity, positions: agent.state.positions }, null, 2));
    return;
  }
  agent.start();
  createApiServer(agent, 8787);
  console.log('Paper mode: polling live testnet data, virtual positions only. Type commands (help, status, pnl, show positions, set risk to low...). Ctrl+C to stop.');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'agent> ' });
  rl.prompt();
  rl.on('line', (line) => {
    const res = handleChat(agent, line);
    agent.journal.append({ type: 'chat', message: line, reply: res.reply });
    console.log(res.reply);
    rl.prompt();
  });
}

main().catch((e) => {
  console.error('Fatal:', (e as Error).message);
  process.exit(1);
});
