# Pump.fun Replay Sprint — Paper Bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ichwann12/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ichwann12/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24 h replay of pump.fun bonding-curve activity. Best net PnL wins; a placement needs net PnL above 0 after every fee.

## Strategy

Early momentum with fast exits — most pump.fun curves die fast, a few run hard in their first minutes:

- **Entry.** A curve becomes a buy only once its tape already shows real, broad buying: net SOL flowing in over its last 15 trades, at least 8 buys from at least 5 distinct wallets, price up ≥ 4% across the window and holding within 5% of the window high, no single wallet dominating the buys, creator not selling, curve at least 120 slots old, and real SOL reserve between 1 and 80 SOL.
- **Sizing.** First buy 0.08 SOL, pyramid adds of 0.08 SOL only while the price keeps stepping up and flow stays positive, at most 0.24 SOL per coin, at most 5 coins open, at most 6 SOL at cost across all positions. Every buy is capped at 97% of the harness's 1%-of-real-reserve per-reply limit. Cash is preferred over a forced trade.
- **Exits.** Sell the whole position on the first of: +25% take profit, −15% stop loss, −20% trailing stop once the position peaked +10%, creator sells, net flow over the last 10 trades turns below −0.3 SOL, or 1200 slots held.
- **Coverage pacing.** The guardrail needs round trips of ≥ 0.01 SOL on at least 20 coins. When filled orders or coins lag the pace of the 24 h window, the bot opens one tiny 0.02 SOL probe round trip on a liquid coin and sells it as soon as the buy lands.

## Determinism

Pure function of the batches the harness sends: no clock, no randomness, no I/O, no environment reads — the two graded executions produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the strategy (entry signal, sizing, exits, pacing).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte-identical.

## Local grade

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
