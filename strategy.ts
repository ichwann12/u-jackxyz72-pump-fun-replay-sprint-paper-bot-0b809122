// Pump.fun replay bot — dip buying with fast exits + coverage pacing.
//
// Idea, in one paragraph: a curve that ran up and then dropped sharply from its
// recent high, while buyers are still stepping in, tends to bounce part of the
// way back. So this bot buys into that dip in small tranches, takes profit on
// a partial rebound, cuts losers fast, and never holds a trade stale. It never
// chases a coin that already ran far, never bets more than 0.20 SOL on one
// coin, never holds more than 5 coins, and prefers cash to a forced trade. A
// separate pacing rule keeps the run above the guardrail (round trips of
// >= 0.01 SOL on >= 20 coins): when filled orders / coins lag the pace of
// the 24 h window, it opens one tiny probe round trip on a liquid coin and
// sells it as soon as the buy lands.
//
// Pure function of the batches the harness sends: no clock, no randomness, no
// I/O, no environment reads — the two graded executions produce byte-identical
// action logs. All iteration is over insertion-ordered maps fed by the batch
// stream (held positions are visited sorted by mint), so order is deterministic.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
const LAMPORTS_BIG = 1_000_000_000n;
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30 bps, charged on every curve trade
const BPS = 10_000n;

export interface Params {
  // Entry: a dip buy. Tape over the last `windowTrades` trades on the curve.
  windowTrades: number;
  ddMin: number; // buy when price is at least this far below its recent high
  ddMax: number; // ...and not further than this (a collapse, not a dip)
  minBuys: number; // buy trades among the last 6 trades
  minNetSol: number; // net SOL bought minus sold over the last 6 trades
  minBuyers: number; // distinct buying wallets over the window
  minRqSol: number; // real SOL reserve at entry, lower bound
  maxRqSol: number; // real SOL reserve at entry, upper bound
  minAgeSlots: number; // slots since CreateEvent before an entry is allowed
  // Sizing (SOL).
  initialSol: number; // first buy of a position
  addSol: number; // each pyramid add
  maxStakeSol: number; // most SOL into one coin in total
  minBuySol: number; // smallest buy worth paying the tx fee for
  maxExposureSol: number; // most SOL at cost across all positions at once
  // Exits.
  takeProfit: number; // sell when liquidation value >= cost * (1 + takeProfit)
  stopLoss: number; // sell when liquidation value <= cost * (1 - stopLoss)
  trailArm: number; // trailing stop arms once peak value >= cost * (1 + trailArm)
  trail: number; // sell when value falls this far below its peak
  maxHoldSlots: number; // sell after holding this long, whatever the price
  fadeTrades: number; // exit when net SOL over the last fadeTrades trades < -fadeNetSol
  fadeNetSol: number;
  exitOnDevSell: boolean; // exit the moment the creator sells while held
  // Re-entry.
  cooldownSlots: number; // slots to wait after an exit before buying the coin again
  maxEntries: number; // most entries per coin over the run
  // Pyramid adds.
  addStep: number; // add only once price is this far above the last buy's price
  addNetSol: number; // add only while net SOL over the entry window >= this
  // Slippage.
  buySlipBps: number;
  sellSlipBps: number;
  // Coverage pacing (the >= 20 coins / >= 0.01 SOL round-trip guardrail).
  targetCoins: number;
  targetFills: number;
  paceSecs: number; // block-time window the pace is prorated over
  probeSol: number; // one probe buy; sold whole as soon as it lands
  maxProbes: number; // probes open at once
}

export const DEFAULT_PARAMS: Params = {
  windowTrades: 15,
  ddMin: 0.2,
  ddMax: 0.45,
  minBuys: 3,
  minNetSol: 0,
  minBuyers: 4,
  minRqSol: 3,
  maxRqSol: 80,
  minAgeSlots: 120,
  initialSol: 0.1,
  addSol: 0.1,
  maxStakeSol: 0.2,
  minBuySol: 0.01,
  maxExposureSol: 6,
  takeProfit: 0.2,
  stopLoss: 0.1,
  trailArm: 0.08,
  trail: 0.15,
  maxHoldSlots: 600,
  fadeTrades: 10,
  fadeNetSol: 0, // 0 = fade exit off; positions exit on TP / SL / trail / dev-sell / max hold
  exitOnDevSell: true,
  cooldownSlots: 200,
  maxEntries: 2,
  addStep: 0.05,
  addNetSol: 0.1,
  buySlipBps: 1500,
  sellSlipBps: 10_000,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number; // SOL
  user: string;
  price: number; // virtual SOL per virtual token
}

interface Tape {
  createdSlot: number | null;
  creator: string | null;
  trades: Trade[];
  entries: number;
  lastExitSlot: number;
  devSold: boolean;
}

interface Held {
  openedSlot: number;
  peakValueSol: number; // best liquidation value seen, SOL
  investedSol: number; // SOL sent in buys for this position
  lastBuyPrice: number;
  exiting: boolean;
  filled: boolean;
}

/** SOL a sale of `tokens` against (vq, vt) would pay, curve fees deducted. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  const net = q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return Number(net) / LAMPORTS;
}

/** Price (virtual SOL per virtual token) from reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, creator: null, trades: [], entries: 0, lastExitSlot: -1e12, devSold: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net SOL (buys minus sells) over the last `n` trades of a tape. */
  const flow = (t: Tape, n: number): number => {
    let net = 0;
    const start = Math.max(0, t.trades.length - n);
    for (let i = start; i < t.trades.length; i++) {
      const tr = t.trades[i]!;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`: a dip buy. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.createdSlot === null || now - t.createdSlot < p.minAgeSlots) return false;
    if (t.devSold) return false;
    if (t.trades.length < p.windowTrades) return false;
    // Recent high over the tape (up to 40 trades back).
    const win = t.trades.slice(Math.max(0, t.trades.length - 40));
    let high = 0;
    for (const tr of win) if (tr.price > high) high = tr.price;
    const last = t.trades[t.trades.length - 1]!;
    if (high <= 0 || last.price <= 0) return false;
    // Buy the dip, not the collapse: 20-45% below the recent high.
    const dd = 1 - last.price / high;
    if (dd < p.ddMin || dd > p.ddMax) return false;
    // Buyers still stepping in: the last trade is a buy, most of the last few are buys.
    if (!last.buy) return false;
    const recent = t.trades.slice(Math.max(0, t.trades.length - 6));
    let buys = 0;
    let net = 0;
    for (const tr of recent) {
      if (tr.buy) buys++;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    if (buys < p.minBuys || net < p.minNetSol) return false;
    // Distinct buyers over the window: not a one-wallet show.
    const byUser = new Set<string>();
    for (const tr of win) if (tr.buy) byUser.add(tr.user);
    if (byUser.size < p.minBuyers) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.createdSlot = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          if (t.trades.length > 60) t.trades.splice(0, t.trades.length - 60);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.devSold = true;
          traded.add(e.mint);
        } else {
          // CompleteEvent: the curve is done; positions in it are closed by the harness.
          tapeOf(e.mint).devSold = true;
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const rec = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') rec.buy = true;
        else rec.sell = true;
        pendingByMint.set(po.order.mint, rec);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Value of a held position at the latest known reserves, SOL, tx fee deducted.
      const positionValue = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        if (pos === undefined) return 0;
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve?.virtual_quote_reserves ?? 0n;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve?.virtual_token_reserves ?? 0n;
        return sellValueSol(pos.token_amount, vq, vt) - txSol;
      };

      // 1. Exits first (held positions, sorted by mint so the order is deterministic).
      for (const mint of [...state.positions.keys()].sort()) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const pend = pendingByMint.get(mint);
        if (pend?.sell) continue;
        const h = held.get(mint);
        if (h === undefined) continue; // position we did not open (should not happen); leave it
        if (h.exiting) continue;
        const t = tapeOf(mint);
        const value = positionValue(mint);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValueSol) h.peakValueSol = value;
        h.filled = true;
        let exit = false;
        if (cost > 0 && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && cost > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValueSol >= cost * (1 + p.trailArm) && value <= h.peakValueSol * (1 - p.trail)) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold) exit = true;
        if (!exit && p.fadeNetSol > 0 && flow(t, p.fadeTrades) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.openedSlot >= p.maxHoldSlots) exit = true;
        if (!exit) continue;
        h.exiting = true;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // 2. Probe exits: sell a probe whole as soon as its buy has landed.
      for (const mint of [...probes]) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // 3. Clean up held records for positions that are gone with nothing pending.
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !pendingByMint.has(mint)) {
          const h = held.get(mint)!;
          if (h.filled) tapeOf(mint).lastExitSlot = now;
          held.delete(mint);
        }
      }

      // 4. Entries and pyramid adds on coins that traded this batch.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposureSol = 0;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        exposureSol += Math.max(h.investedSol, pos ? Number(pos.cost_lamports) / LAMPORTS : 0);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        // Per-reply buy cap with a small margin: the harness checks it against reserves
        // shifted by our own flow, which can sit a little below the recorded ones.
        const capSol = (Number(state.maxBuyLamports(mint)) * 97) / 100 / LAMPORTS;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExitSlot < p.cooldownSlots) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          let amount = Math.min(p.initialSol, p.maxStakeSol, capSol, p.maxExposureSol - exposureSol);
          if (amount > freeSol - txSol) amount = freeSol - txSol;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          held.set(mint, { openedSlot: now, peakValueSol: 0, investedSol: amount, lastBuyPrice: price, exiting: false, filled: false });
          t.entries++;
          freeSol -= amount + txSol;
          exposureSol += amount;
          slotsLeft--;
        } else {
          // Add a second tranche while the dip still holds near the first entry
          // price and buyers are still stepping in.
          if (h.exiting || !h.filled || h.investedSol >= p.maxStakeSol - p.minBuySol) continue;
          if (Math.abs(price / h.lastBuyPrice - 1) > p.addStep) continue;
          if (flow(t, p.windowTrades) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          let amount = Math.min(p.addSol, p.maxStakeSol - h.investedSol, capSol, p.maxExposureSol - exposureSol);
          if (amount > freeSol - txSol) amount = freeSol - txSol;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          h.investedSol += amount;
          h.lastBuyPrice = price;
          freeSol -= amount + txSol;
          exposureSol += amount;
        }
      }

      // 5. Coverage pacing: open one tiny probe when fills or coins lag the pace.
      // A probe is a 0.02 SOL buy on a liquid coin, sold whole as soon as it lands —
      // a cheap round trip that keeps the run above the >= 20 coins guardrail.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // Liquid enough that a 0.02 SOL buy fits the 1%-of-real-reserve cap with room.
            if (Number(curve.real_quote_reserves) / LAMPORTS < p.probeSol * 150) continue;
            if (freeSol < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.add(mint);
            freeSol -= p.probeSol + txSol;
          }
        }
      }

      return orders;
    },

    onDone(state, done) {
      const cashSol = Number(state.cash) / LAMPORTS;
      console.error(
        `[bot] done: batches=${state.seq} cash=${cashSol.toFixed(4)} SOL fills=${myFills} coins=${myCoins.size} open=${state.positions.size}`,
      );
    },
  };
}
