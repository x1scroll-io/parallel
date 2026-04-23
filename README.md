# @x1scroll/parallel

**Parallel execution optimizer for X1 — the first SDK that maximizes X1's 16-thread banking stage.**

X1 can process up to 64 non-conflicting transactions in parallel per ledger entry. Most developers waste this capacity by sending transactions naively. This SDK fixes that.

---

## What It Does

1. **Analyzes** your transaction bundle for account conflicts
2. **Groups** transactions into parallel-safe batches
3. **Submits** each group simultaneously for maximum parallel execution
4. **Result:** faster confirmation, higher throughput — impossible on Solana

---

## Install

```bash
npm install @x1scroll/parallel @solana/web3.js
```

---

## Usage

### Analyze first (no cost)

```javascript
const { analyze } = require('@x1scroll/parallel');

const report = analyze([tx1, tx2, tx3, tx4, tx5]);
console.log(report);
// {
//   input: { transactions: 5 },
//   output: {
//     parallelGroups: 2,
//     estimatedSpeedup: '2.5x',
//     estimatedTimeMs: 800,
//     naiveTimeMs: 2000,
//   },
//   fee: { totalXNT: '0.00000075', burned: 150 }
// }
```

### Optimize and send

```javascript
const { optimizeAndSend } = require('@x1scroll/parallel');
const { Connection } = require('@solana/web3.js');

const connection = new Connection('https://rpc.mainnet.x1.xyz', 'confirmed');

const result = await optimizeAndSend({
  transactions: [tx1, tx2, tx3, tx4, tx5],
  connection,
  payer: wallet,
  signers: [wallet],
});

console.log(`Sent ${result.totalTransactions} txs in ${result.parallelGroups} parallel groups`);
console.log(`${result.speedup} faster than sequential`);
console.log(`Completed in ${result.timeMs}ms`);
```

### Dry run (preview only)

```javascript
const result = await optimizeAndSend({
  transactions: myBundle,
  connection,
  payer: wallet,
  signers: [wallet],
  dryRun: true,  // no transactions sent, no fee charged
});
```

---

## How X1 Parallel Execution Works

X1's banking stage uses up to 16 threads on 16-core hardware. Non-conflicting transactions are packed into ledger entries of 64 and executed in parallel. Conflicting transactions (same writable accounts) are sequenced.

**The problem:** Most developers send transactions without thinking about conflicts. Wallets, DApps, and protocols naively submit bundles that accidentally conflict — forcing sequential execution and wasting X1's capacity.

**The solution:** This SDK detects conflicts before submission using a greedy graph coloring algorithm, groups transactions optimally, and submits parallel groups simultaneously.

---

## Fee Structure

Every optimized bundle pays a small fee:

| Component | Amount | Destination |
|-----------|--------|-------------|
| Base fee | 500 lamports | Split below |
| Per-tx fee | 50 lamports/tx | Split below |
| Treasury | 70% of total | x1scroll treasury |
| Burned | 30% of total | 🔥 Removed from supply |

A 10-transaction bundle costs **1,000 lamports = 0.000001 XNT** total.

The fee is collected on-chain — works whether x1scroll is online or not.

---

## Why This Matters

- **Solana can't do this** — one thread, no parallel execution optimization possible
- **X1 exclusive** — built specifically for X1's multi-thread architecture
- **First mover** — no competing SDK exists
- **Deflationary** — every bundle burns XNT, reducing supply

---

## Program ID

`ParA111111111111111111111111111111111111111` ← deploying soon

Fee collection is on-chain and immutable once deployed.

---

Built by [x1scroll.io](https://x1scroll.io) | @ArnettX1
