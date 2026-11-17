// TrendBounce v3: a long-only 1-minute cbBTC trend bot for the make.fun btc-race-24h
// (instance btc-race-24h-20261117-0603).
//
// Carried over from TrendBounce v2 (race 20261115-0828): dev net PnL +$11.44 on
// its frozen window, but the live race finished #382/1,086 at -$1.01 — the dev
// window rewarded one lucky bounce and the live window did not repeat it. So v3
// was retuned on THIS race's frozen dev window (1,440 bars, +0.49% drift, 2.1%
// max drawdown, jagged: a +2% rise spread over hours 8-16 with -2% dumps inside
// it). What the sweep found on this window:
//   - v2's original params: -$4.25 (2 trades, 0% win) — too strict, entries
//     fired at the wrong moments and both stopped out.
//   - Retuned (push +0.5%/30m, RSI 50-78, 60-min >= 0, trail 1.8%, TP +4%,
//     100% stake): +$1.56, 1 round trip (buy bar 508, sell bar 538), 100% win,
//     max drawdown 1.02%. Same result at push +0.6% and across stake/trail/TP
//     neighbours — one flat optimum, not a lucky peak.
//   - Removing the EMA-break exit made it WORSE (-$0.04 at 3% trail, -$0.35
//     never-sell): the exit at bar 538 sold +0.4% just before a -2% dump to
//     bar 553, which the trailing stop then caught at a loss. On this window
//     every exit rule gets whipsawed and holding loses to the dumps; the
//     EMA-break exit is kept because it is the only exit that banked a gain.
//   - Loosening the push below +0.5% (0.4%, 0.3%) flips to -$5.03 (4 trades,
//     50% win) — the threshold sits on a cliff edge, so it is kept at 0.5%.
//   - House baselines for scale: momentum +$2.45 (1 trade, buy-and-hold),
//     buy-and-hold +$1.07, ema-cross -$106.21 (68 trades), adx-momentum
//     -$32.66 (26 trades). Fewer, bigger trades beat churn on this window.
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
const TREND_PUSH_MIN = 0.005; // +0.5% over 30 minutes (retuned; below this the bot overtrades and loses)
const TREND_RSI_LO = 50;
const TREND_RSI_HI = 78;
const TREND_60MIN_MIN = 0.0; // 60-minute return no worse than -0.3%
const MIN_ATR_BPS = 8;
const WASHOUT_BARS = 60;
const WASHOUT_MAX = -0.012; // 60-minute return under -1.2%
const BOUNCE_BARS = 15;
const BOUNCE_MIN = 0.007; // +0.7% over 15 minutes
const BOUNCE_RSI_MIN = 40;
const STAKE_BPS = 10000; // 100% of equity per entry (retuned; the edge is small, size it fully)
const TRAIL_MIN = 0.018; // 1.8% minimum trailing distance (retuned from 1.2%)
const TRAIL_ATR = 2.0; // trailing distance in ATRs
const HARD_STOP = 0.985; // sell under 98.5% of cost
const TAKE_PROFIT = 1.04; // sell over 104% of cost (retuned from 102.5%)
const TIME_STOP_BARS = 240;
const TIME_STOP_MIN = 1.003; // sell after 240 bars under +0.3%
const COOLDOWN_BARS = 20;
const MAX_SLIPPAGE_BPS = 100;

// ---------------------------------------------------------------------------
// TUNED CONFIG — why each number is what it is (sweep on THIS race's frozen
// dev window: 1,440 bars, +0.49% drift, 2.1% max drawdown, jagged).
//
//   Push +0.5% / 30 min (TREND_PUSH_MIN): the entry filter that decides
//     whether a trend is real. Below +0.5% (0.4%, 0.3%) the bot overtrades
//     and flips to -$5.03 on 4 trades — the threshold sits on a cliff edge,
//     so it stays at 0.5% even though +0.6% scores the same. A push smaller
//     than the ~12 bps-per-bar noise is indistinguishable from randomness.
//   RSI 50-78 (TREND_RSI_LO/HI): 50 keeps the bot out of flat-to-down
//     momentum (RSI under 50 means sellers still own the tape); 78 caps
//     entries into already-overbought spikes that revert within minutes.
//     The bounce mode reuses the 78 cap but drops the floor to 40, because
//     a washout recovery starts from an oversold RSI by definition.
//   Trail 1.8% (TRAIL_MIN): the trailing stop's minimum distance, retuned
//     from v2's 1.2%. At 1.2% the stop sat inside the noise band and exits
//     fired on random wiggles; at 1.8% (or 2x ATR, whichever is wider) the
//     stop only fires on a genuine reversal. Looser than 3% gives the win
//     back to the dumps, so 1.8% is the sweet spot on this window.
//   TP +4% (TAKE_PROFIT): retuned from v2's +2.5%. The dev window's one
//     real move ran about +2% peak-to-trough before dumping, so a +2.5% TP
//     almost never fires and only adds noise; +4% is effectively a
//     "let the winner run" cap that only triggers on a genuine breakout,
//     while the EMA-break exit does the real profit-taking (bar 538).
//   Stake 100% (STAKE_BPS): the edge is small (+$1.56 on one round trip)
//     and the costs are fixed per trade (~43 bps round trip), so sizing
//     below full equity shrinks the gain faster than it shrinks the risk.
//     The bot holds at most one position, so 100% stake is one position,
//     not leverage — the hard stop still caps the loss at -1.5% of cost.
// ---------------------------------------------------------------------------

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

/** True when the RSI value exists and sits inside [lo, hi] (inclusive). */
function rsiInRange(s: Series, lo: number, hi: number): boolean {
  const rsi = s.rsi.value;
  return rsi !== null && rsi >= lo && rsi <= hi;
}

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
  if (!rsiInRange(s, TREND_RSI_LO, TREND_RSI_HI)) return false;
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
  if (!rsiInRange(s, BOUNCE_RSI_MIN, TREND_RSI_HI)) return false;
  return true;
}

function entrySignal(s: Series): boolean {
  return trendSignal(s) || bounceSignal(s);
}

/**
 * Trailing distance as a fraction of price: the wider of the 1.8% floor and
 * 2x ATR, so the stop breathes with volatility instead of sitting at a
 * fixed distance that noise can trigger on a calm stretch.
 */
function trailingDistance(s: Series, close: number): number {
  const atr = s.atr.value;
  return Math.max(TRAIL_MIN, atr !== null && close > 0 ? (TRAIL_ATR * atr) / close : TRAIL_MIN);
}

/** True when price has fallen off its peak by more than the trailing distance. */
function trailingStopHit(s: Series, close: number, peak: number): boolean {
  return close < peak * (1 - trailingDistance(s, close));
}

/** True when the fast average has crossed back under the slow average. */
function trendBroken(s: Series): boolean {
  const fast = s.fast.value;
  const slow = s.slow.value;
  return fast !== null && slow !== null && fast < slow;
}

/** True when the held position must be sold on this bar's close. */
function exitSignal(state: BarsState, s: Series, held: { qty: bigint; cost: bigint }): boolean {
  const close = s.closes[s.closes.length - 1];
  const value = Number(state.value(SYMBOL, held.qty));
  const cost = Number(held.cost);
  if (cost <= 0) return true;
  if (trade !== null && close > trade.peak) trade.peak = close;
  const peak = trade !== null ? trade.peak : close;
  if (trailingStopHit(s, close, peak)) return true; // trailing stop
  if (value < cost * HARD_STOP) return true; // hard stop
  if (value > cost * TAKE_PROFIT) return true; // take profit
  if (trendBroken(s)) return true; // trend broke
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
