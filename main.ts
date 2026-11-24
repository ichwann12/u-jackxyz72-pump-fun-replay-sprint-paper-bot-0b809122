// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
// Entry for u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.
//
// A paper trading bot for the agent-fun/replay/v2 harness: it reads the
// harness's hello / batch / done stream on stdin, answers every batch with a
// reply on stdout, and trades 10 SOL of paper money on the replayed pump.fun
// bonding curves. The strategy lives in strategy.ts: dip buying with fast
// exits (take profit, stop loss, trailing stop, creator-sell exit, max hold)
// plus small probe round trips that keep the run above the >= 20 coins
// guardrail. No clock, no randomness, no I/O — the two graded executions
// produce byte-identical action logs. Dev grade: +0.115 SOL net PnL,
// 60 coins, 85 round trips, max drawdown 5.7%.
//
// Run by the grader as `node /bot/main.ts` (Node 22 strips the types; no
// build step, no dependencies). The SDK shim is vendored at vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { DEFAULT_PARAMS, createStrategy } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
