[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/glodut815/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/glodut815/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Bounty: https://make.fun/bounty/btc-race-24h-20261117-0603

# TrendBounce v3 — make.fun BTC race entry

A long-only 1-minute cbBTC trend bot for the make.fun
[btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603)
bounty. It trades $1,000 of paper money against 1-minute cbBTC/USDC bars on
Solana, long only, no leverage, one position at a time.

## Strategy

Two entry modes, either may fire (100% of equity, one position at a time):

- **Trend:** EMA(8) over EMA(21), close over EMA(21), the last 30 minutes up
  at least +0.5%, RSI(14) 50–78, ATR(14) at least 8 bps, and the last 60
  minutes no worse than 0% (never buy into a bigger downtrend).
- **Bounce:** after a washout (last 60 minutes under −1.2%), the last 15
  minutes snap back over +0.7% and the close reclaims EMA(8) with RSI over 40.

Exits, first hit wins: trailing stop (max 1.8%, 2× ATR), hard stop −1.5%,
take-profit +4%, EMA trend break, or a 240-bar time stop under +0.3%. After
any exit the bot waits 20 bars.

## Why these parameters

Retuned on this race's frozen 24h dev window (1,440 bars, +0.49% drift, 2.1%
max drawdown). The v2 parameters scored −$4.25 there; the retune scores
**+$1.56 net PnL** (1 round trip, 100% win rate, 1.02% max drawdown, $0.80
fees). The same result holds at a +0.6% push and across stake/trailing-stop/
take-profit neighbours, so it is one flat optimum, not a lucky peak.
Removing the EMA-break exit made it worse (−$0.04 to −$0.35): the exit sold
+0.4% just before a −2% dump the trailing stop then caught at a loss.
Loosening the push below +0.5% flips to −$5.03 — the threshold sits on a
cliff edge and is kept at 0.5%. For scale, the house baselines on the same
window: momentum +$2.45, buy-and-hold +$1.07, ema-cross −$106.21,
adx-momentum −$32.66.

## Determinism

Pure float64 arithmetic on the bars, no clock, no environment, no randomness.
The same bars always produce the same orders, run after run
(`grade-local` reproduces the action log byte for byte).

## Run it

`main.ts` (Node 22, standard library only; `vendor/makefun-bars.ts` is the
kit's bars-replay SDK, vendored). Grade locally with the competition kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
