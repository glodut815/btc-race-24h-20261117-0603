// TrendBounce v3: a long-only 1-minute cbBTC trend bot for the make.fun btc-race-24h
// (instance btc-race-24h-20261117-0603).
//
// Carried over from TrendBounce v2 (race 20261115-0828): dev net PnL +$11.44 on
// its frozen window, but the live race finished #382/1,086 at -$1.01 — the dev
// window rewarded one lucky bounce and the live window did not repeat it. So v3
// keeps the same two entry modes but retunes on THIS race's frozen dev window
// and prefers parameters that are good across the whole window, not one peak.
//
// Lesson from v1 (dev net PnL -$40 on 40 trades, 10% win rate): 1-minute noise is
// ~12 bps per bar, so a 0.6-0.8% stop sits INSIDE the noise band and every entry
// gets stopped out by randomness. v2 trades far less often, with stops outside the
// noise: hard stop -1.5%, trailing stop max(1.2%, 2x ATR), take-profit +2.5%.
//
// Two entry modes, either may fire (60% of equity, one position at a time):
//   A) Trend: EMA(8) over EMA(21), close over EMA(21), the last 30 minutes up at
//      least +0.9%, RSI(14) 55-78, ATR(14) at least 8 bps, and the last 60 minutes
//      no worse than -0.3% (never buy into a bigger downtrend).
//   B) Bounce: after a washout (last 60 minutes under -1.2%), the last 15 minutes
//      snap back over +0.7% and the close reclaims EMA(8) with RSI over 40.
// Exits, first hit wins: trailing stop, hard stop, take-profit, EMA trend break,
// or a 240-bar time stop under +0.3%. After any exit the bot waits 20 bars.
//
// Costs shape everything: a full-size round trip pays ~43 bps here (4 fee + 2
// slippage + ~16 impact at the pool's ~$640k depth), so entries are sized at 60%
// of equity and a trade must catch a move well over ~30 bps to pay.
// Determinism: pure float64 arithmetic on the bars, no clock, no environment, no
// randomness. The same bars always produce the same orders, run after run.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 8;
const SLOW_SPAN = 21;
const RSI_SPAN = 14;
const ATR_SPAN = 14;
const TREND_PUSH_BARS = 30;
const TREND_PUSH_MIN = 0.009; // +0.9% over 30 minutes
const TREND_RSI_LO = 55;
const TREND_RSI_HI = 78;
const TREND_60MIN_MIN = -0.003; // 60-minute return no worse than -0.3%
const MIN_ATR_BPS = 8;
const WASHOUT_BARS = 60;
const WASHOUT_MAX = -0.012; // 60-minute return under -1.2%
const BOUNCE_BARS = 15;
const BOUNCE_MIN = 0.007; // +0.7% over 15 minutes
const BOUNCE_RSI_MIN = 40;
const STAKE_BPS = 6000; // 60% of equity per entry
const TRAIL_MIN = 0.012; // 1.2% minimum trailing distance
const TRAIL_ATR = 2.0; // trailing distance in ATRs
const HARD_STOP = 0.985; // sell under 98.5% of cost
const TAKE_PROFIT = 1.025; // sell over 102.5% of cost
const TIME_STOP_BARS = 240;
const TIME_STOP_MIN = 1.003; // sell after 240 bars under +0.3%
const COOLDOWN_BARS = 20;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

/** Wilder RSI: gains and losses smoothed over RSI_SPAN closes. */
interface Rsi {
  warm: number[];
  prev: number | null;
  gain: number | null;
  loss: number | null;
  value: number | null;
  /** Seed-period losses, alongside the gains in warm. */
  lossSeed: number[];
}

function rsiStep(r: Rsi, close: number): void {
  if (r.prev === null) {
    r.prev = close;
    return;
  }
  const up = Math.max(0, close - r.prev);
  const down = Math.max(0, r.prev - close);
  r.prev = close;
  if (r.gain === null) {
    r.warm.push(up);
    r.lossSeed.push(down);
    if (r.warm.length === RSI_SPAN) {
      r.gain = r.warm.reduce((a, x) => a + x, 0) / RSI_SPAN;
      r.loss = r.lossSeed.reduce((a, x) => a + x, 0) / RSI_SPAN;
      r.value = r.loss === 0 ? 100 : 100 - 100 / (1 + r.gain / (r.loss as number));
    }
    return;
  }
  r.gain = (r.gain * (RSI_SPAN - 1) + up) / RSI_SPAN;
  r.loss = ((r.loss as number) * (RSI_SPAN - 1) + down) / RSI_SPAN;
  r.value = r.loss === 0 ? 100 : 100 - 100 / (1 + r.gain / (r.loss as number));
}

/** Wilder ATR on true range (high-low, |high-prev close|, |low-prev close|). */
interface Atr {
  warm: number[];
  prevClose: number | null;
  value: number | null;
}

function atrStep(a: Atr, bar: Bar): void {
  const h = Number(bar.h);
  const l = Number(bar.l);
  const c = Number(bar.c);
  let tr = h - l;
  if (a.prevClose !== null) {
    tr = Math.max(tr, Math.abs(h - (a.prevClose as number)), Math.abs(l - (a.prevClose as number)));
  }
  a.prevClose = c;
  if (a.value !== null) {
    a.value = (a.value * (ATR_SPAN - 1) + tr) / ATR_SPAN;
    return;
  }
  a.warm.push(tr);
  if (a.warm.length === ATR_SPAN) {
    a.value = a.warm.reduce((x, y) => x + y, 0) / ATR_SPAN;
  }
}

interface Series {
  fast: Ema;
  slow: Ema;
  rsi: Rsi;
  atr: Atr;
  closes: number[];
}

function newSeries(): Series {
  return {
    fast: { span: FAST_SPAN, warm: [], value: null },
    slow: { span: SLOW_SPAN, warm: [], value: null },
    rsi: { warm: [], prev: null, gain: null, loss: null, value: null, lossSeed: [] },
    atr: { warm: [], prevClose: null, value: null },
    closes: [],
  };
}

function pushBar(s: Series, bar: Bar): void {
  const c = Number(bar.c);
  emaStep(s.fast, c);
  emaStep(s.slow, c);
  rsiStep(s.rsi, c);
  atrStep(s.atr, bar);
  s.closes.push(c);
  if (s.closes.length > 120) s.closes.shift();
}

function retOver(s: Series, bars: number): number | null {
  const n = s.closes.length;
  if (n <= bars) return null;
  const now = s.closes[n - 1];
  const then = s.closes[n - 1 - bars];
  if (then === 0) return null;
  return now / then - 1;
}

interface Trade {
  peak: number; // highest close since entry, raw price units
  barsHeld: number;
}

const series = newSeries();
let trade: Trade | null = null;
let cooldown = 0;

/** Trend entry: a confirmed uptrend with a real 30-minute push behind it. */
function trendSignal(s: Series): boolean {
  const fast = s.fast.value;
  const slow = s.slow.value;
  const rsi = s.rsi.value;
  const atr = s.atr.value;
  const close = s.closes[s.closes.length - 1];
  if (fast === null || slow === null || rsi === null || atr === null || close === undefined) return false;
  if (!(fast > slow && close > slow)) return false;
  const push = retOver(s, TREND_PUSH_BARS);
  if (push === null || push < TREND_PUSH_MIN) return false;
  const hour = retOver(s, WASHOUT_BARS);
  if (hour === null || hour < TREND_60MIN_MIN) return false;
  if (rsi < TREND_RSI_LO || rsi > TREND_RSI_HI) return false;
  if (atr / close < MIN_ATR_BPS / 10000) return false;
  return true;
}

/** Bounce entry: a sharp snap-back right after a washout hour. */
function bounceSignal(s: Series): boolean {
  const fast = s.fast.value;
  const rsi = s.rsi.value;
  const close = s.closes[s.closes.length - 1];
  if (fast === null || rsi === null || close === undefined) return false;
  const hour = retOver(s, WASHOUT_BARS);
  if (hour === null || hour > WASHOUT_MAX) return false;
  const snap = retOver(s, BOUNCE_BARS);
  if (snap === null || snap < BOUNCE_MIN) return false;
  if (!(close > fast)) return false; // price reclaimed the fast average
  if (rsi < BOUNCE_RSI_MIN || rsi > TREND_RSI_HI) return false;
  return true;
}

function entrySignal(s: Series): boolean {
  return trendSignal(s) || bounceSignal(s);
}

/** True when the held position must be sold on this bar's close. */
function exitSignal(state: BarsState, s: Series, held: { qty: bigint; cost: bigint }): boolean {
  const close = s.closes[s.closes.length - 1];
  const value = Number(state.value(SYMBOL, held.qty));
  const cost = Number(held.cost);
  if (cost <= 0) return true;
  if (trade !== null && close > trade.peak) trade.peak = close;
  const peak = trade !== null ? trade.peak : close;
  const atr = s.atr.value;
  const trail = Math.max(TRAIL_MIN, atr !== null && close > 0 ? (TRAIL_ATR * atr) / close : TRAIL_MIN);
  if (close < peak * (1 - trail)) return true; // trailing stop
  if (value < cost * HARD_STOP) return true; // hard stop
  if (value > cost * TAKE_PROFIT) return true; // take profit
  const fast = s.fast.value;
  const slow = s.slow.value;
  if (fast !== null && slow !== null && fast < slow) return true; // trend broke
  if (trade !== null && trade.barsHeld > TIME_STOP_BARS && value < cost * TIME_STOP_MIN) return true; // time stop
  return false;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushBar(series, bar);
    }
    if (trade !== null) trade.barsHeld += 1;
    if (cooldown > 0) cooldown -= 1;
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (exitSignal(state, series, held)) {
        trade = null;
        cooldown = COOLDOWN_BARS;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    trade = null;
    if (cooldown > 0 || !entrySignal(series)) return [];
    const stake = (state.equity * BigInt(STAKE_BPS)) / BigInt(BPS);
    const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BigInt(BPS);
    let slice = stake < byWeight ? stake : byWeight;
    if (slice > state.cash) slice = state.cash;
    if (slice <= 0n || slice < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const close = series.closes[series.closes.length - 1];
    trade = { peak: close, barsHeld: 0 };
    const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS };
    const orders: (BuyInput | SellInput)[] = [order];
    return orders;
  },
});
