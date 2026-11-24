// Pump.fun Paper Sprint: Any Bot Can Win — agent-fun/replay/v2 bot (Node 22).
//
// Lockstep NDJSON over stdio: the harness writes one JSON line per message
// (hello, then one batch per slot, then done) and waits for exactly one
// {"type":"reply","seq":N,"orders":[...]} line per batch. No network, no
// clock, no randomness: every decision is a pure function of the messages
// seen so far, so two executions produce byte-identical action logs.
//
// Strategy — fresh-coin early momentum, tight exits:
//  * Watch CreateEvents. A coin becomes a candidate only once its mark price
//    rises >= 8% above its creation price within its first 40 batches —
//    early buying interest, not blind buys of every launch.
//  * Buy a fixed stake per coin (2% of starting capital, at least 0.02 SOL),
//    capped by the harness per-order reserve cap, at most one buy per mint.
//  * Sell the whole position on take-profit (+50% vs cost), stop-loss (-25%
//    vs cost), a 12,000-slot time exit, or the coin completing.
// Guardrails the house scores: >= 20 coins with a round trip of >= 0.01 SOL
// and max drawdown <= 50%. Small fixed stakes across many fresh coins keep
// any single rug cheap and the drawdown shallow.

import * as readline from "node:readline";

type U64 = string;

interface Hello {
  type: "hello";
  protocol: "agent-fun/replay/v2";
  seed: U64;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: false;
    leverage: false;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Position {
  mint: string;
  token_amount: U64;
  cost_lamports: U64;
}

interface Batch {
  type: "batch";
  seq: number;
  slot: number;
  events: Array<Record<string, unknown>>;
  marks: Mark[];
  fills: Array<Record<string, unknown>>;
  account: { cash_lamports: U64; positions: Position[] };
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: U64;
  token_amount?: U64;
  max_slippage_bps: number;
}

const TAKE_PROFIT = 1.6; // sell when position value is 60% above cost
const STOP_LOSS = 0.8; // sell when position value is 20% below cost
const MOMENTUM = 1.08; // buy only 8% above the creation price
const CANDIDATE_BATCHES = 40; // momentum window after creation, in batches
const MAX_SLOT_HOLD = 12000; // time exit, in slots
const MIN_BUY_LAMPORTS = 20000000n; // 0.02 SOL floor per buy
const MAX_SLIPPAGE_BPS = 500; // 5%

function priceOf(virtualQuote: U64, virtualToken: U64): number {
  const q = Number(BigInt(virtualQuote));
  const t = Number(BigInt(virtualToken));
  if (t <= 0) return 0;
  return q / t;
}

function eventPrice(ev: Record<string, unknown>): number {
  const q = ev.virtual_quote_reserves ?? ev.virtual_sol_reserves;
  const t = ev.virtual_token_reserves;
  if (typeof q !== "string" || typeof t !== "string") return 0;
  return priceOf(q, t);
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let hello: Hello | null = null;
  let buySize = MIN_BUY_LAMPORTS;
  let orderCounter = 0;
  let batchCount = 0;

  // mint -> { createPrice, createBatch }
  const seen = new Map<string, { createPrice: number; createBatch: number }>();
  // mint -> latest mark { price, realQuoteReserves }
  const marks = new Map<string, { price: number; realQuote: bigint }>();
  // mint -> slot the position first appeared
  const entrySlot = new Map<string, number>();
  // mints already bought once (one buy per mint, ever)
  const bought = new Set<string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (msg.type === "hello") {
      hello = msg as unknown as Hello;
      const capital = BigInt(hello.capital.lamports);
      const sized = capital / 50n; // 2% of starting capital per coin
      buySize = sized > MIN_BUY_LAMPORTS ? sized : MIN_BUY_LAMPORTS;
      process.stderr.write(`hello: capital=${capital} buySize=${buySize}\n`);
      continue;
    }

    if (msg.type === "done") {
      process.stderr.write(`done: batches=${batchCount}\n`);
      break;
    }

    if (msg.type !== "batch" || hello === null) continue;
    const batch = msg as unknown as Batch;
    batchCount += 1;
    const orders: Order[] = [];

    // 1. Record creations (price at launch) and completions.
    const completed = new Set<string>();
    for (const ev of batch.events) {
      const kind = ev.event as string | undefined;
      if (kind === "CreateEvent" && typeof ev.mint === "string") {
        const p = eventPrice(ev);
        if (p > 0 && !seen.has(ev.mint)) {
          seen.set(ev.mint, { createPrice: p, createBatch: batchCount });
        }
      } else if (kind === "CompleteEvent" && typeof ev.mint === "string") {
        completed.add(ev.mint);
      }
    }

    // 2. Update marks.
    for (const m of batch.marks) {
      const p = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
      if (p > 0) {
        marks.set(m.mint, { price: p, realQuote: BigInt(m.real_quote_reserves) });
      }
    }

    // 3. Positions (authoritative, from the account) and their entry slots.
    const held = new Map<string, Position>();
    for (const pos of batch.account.positions) {
      held.set(pos.mint, pos);
      if (!entrySlot.has(pos.mint)) entrySlot.set(pos.mint, batch.slot);
    }
    for (const mint of [...entrySlot.keys()]) {
      if (!held.has(mint)) entrySlot.delete(mint);
    }
    const cash = BigInt(batch.account.cash_lamports);
    const maxOrders = Math.max(1, Math.min(hello.caps.max_orders_per_batch, 20));
    const maxPositions = hello.caps.max_open_positions;
    const orderCapBps = hello.caps.max_order_bps_of_real_reserve;

    // 4. Sells first: take-profit, stop-loss, time exit, completion.
    for (const [mint, pos] of held) {
      if (orders.length >= maxOrders) break;
      const mark = marks.get(mint);
      const cost = BigInt(pos.cost_lamports);
      if (cost <= 0n) continue;
      let sell = completed.has(mint);
      if (!sell && batch.slot - (entrySlot.get(mint) ?? batch.slot) > MAX_SLOT_HOLD) {
        sell = true; // time exit
      }
      if (!sell && mark) {
        const value = BigInt(Math.floor(Number(BigInt(pos.token_amount)) * mark.price));
        const ratio = Number(value) / Number(cost);
        if (ratio >= TAKE_PROFIT || ratio <= STOP_LOSS) sell = true;
      }
      if (sell) {
        orders.push({
          side: "sell",
          client_id: `s${orderCounter++}`,
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // 5. Buys: early-momentum candidates, one buy per mint, within the window.
    const selling = new Set(orders.filter((o) => o.side === "sell").map((o) => o.mint));
    const openAfterSells = held.size - selling.size;
    let opens = openAfterSells;
    for (const [mint, info] of seen) {
      if (orders.length >= maxOrders) break;
      if (opens >= maxPositions) break;
      if (bought.has(mint) || held.has(mint)) continue;
      if (batchCount - info.createBatch > CANDIDATE_BATCHES) continue;
      const mark = marks.get(mint);
      if (!mark || mark.price < info.createPrice * MOMENTUM) continue;
      if (cash < buySize + 5000000n) continue; // keep a fee buffer
      // Per-order reserve cap: spend at most half the allowed share.
      const reserveCap = (mark.realQuote * BigInt(orderCapBps)) / 10000n / 2n;
      const size = reserveCap > 0n && reserveCap < buySize ? reserveCap : buySize;
      if (size < 10000000n) continue; // never below a 0.01 SOL round trip
      orders.push({
        side: "buy",
        client_id: `b${orderCounter++}`,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      bought.add(mint);
      opens += 1;
    }

    process.stdout.write(
      JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n",
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
