# Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/WuYuanJie-211/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/WuYuanJie-211/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for pump.fun (agent-fun/replay/v2): it buys fresh coins
only after early momentum (+8% over the creation price), stakes 2% of capital
per coin, and exits at +60% take-profit, -20% stop-loss, a 12,000-slot time
exit, or curve completion. Deterministic — no clock, no randomness — so two
executions produce byte-identical action logs.

Tested locally against a synthetic replay harness (600 batches, 48 coins):
23–24 distinct coins round-tripped at >= 0.01 SOL, no open positions left,
+0.15 SOL paper profit, 0% drawdown, replies byte-identical across runs.
