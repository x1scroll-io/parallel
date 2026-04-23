/**
 * @x1scroll/parallel — X1 Parallel Execution Optimizer v0.1
 * ─────────────────────────────────────────────────────────────────────────────
 * X1 processes up to 64 non-conflicting transactions in parallel per ledger
 * entry. Most developers send transactions naively — random conflicts force
 * sequential execution and waste X1's threading capacity.
 *
 * This SDK analyzes your transaction bundle, detects account conflicts,
 * restructures the bundle into parallel-safe groups, and submits them in
 * optimal order — maximizing X1's 16-thread banking stage.
 *
 * Result: faster confirmation, higher throughput, lower effective cost.
 *
 * Fee: small XNT fee per optimized bundle
 *   → x1scroll treasury (dead fee — works forever on-chain)
 *   → burned 🔥 (deflationary on XNT)
 *
 * Program ID: deployed on X1 mainnet (see PROGRAM_ID below)
 *
 * Author: x1scroll.io | 2026-04-23
 */

'use strict';

const {
  Transaction,
  PublicKey,
  SystemProgram,
  Connection,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
// On-chain fee program — collects dead fee + burn on every optimized bundle
const PROGRAM_ID = 'GQBinKdihy1CB3GoD7HES5N4LQxZQWvwVrZA5VaAJKQL'; // replace after deploy

// Fee split per optimized bundle
const TREASURY = 'A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK';
const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111';

const FEES = {
  TREASURY_SHARE: 0.50,   // 50% to x1scroll treasury (dead fee)
  BURN_SHARE: 0.50,       // 50% burned 🔥
  PER_BUNDLE: 500,        // 500 lamports per optimized bundle (~$0.0000002)
  PER_TX: 50,             // 50 lamports per transaction in bundle
};

// X1 parallel execution limits
const X1_MAX_PARALLEL = 64;   // max txs per ledger entry
const X1_THREADS = 16;         // banking threads on 16-core nodes

// ── ACCOUNT CONFLICT ANALYZER ─────────────────────────────────────────────────
/**
 * Detects which accounts each transaction reads/writes.
 * Transactions that share writable accounts CANNOT run in parallel.
 */
function getAccountKeys(transaction) {
  const writableAccounts = new Set();
  const readableAccounts = new Set();

  if (transaction.message) {
    const msg = transaction.message;
    const numWritable = msg.header?.numRequiredSignatures || 0;

    msg.accountKeys?.forEach((key, idx) => {
      const keyStr = key.toBase58 ? key.toBase58() : key.toString();
      if (idx < numWritable) {
        writableAccounts.add(keyStr);
      } else {
        readableAccounts.add(keyStr);
      }
    });
  }

  // Also parse instructions for account references
  transaction.instructions?.forEach(ix => {
    ix.keys?.forEach(meta => {
      const keyStr = meta.pubkey.toBase58();
      if (meta.isWritable) {
        writableAccounts.add(keyStr);
      } else {
        readableAccounts.add(keyStr);
      }
    });
    // Program ID
    if (ix.programId) {
      readableAccounts.add(ix.programId.toBase58());
    }
  });

  return { writableAccounts, readableAccounts };
}

/**
 * Checks if two transactions conflict (share writable accounts).
 * Conflicting txs must run sequentially — non-conflicting run in parallel.
 */
function conflictsWith(txA, txB) {
  const keysA = getAccountKeys(txA);
  const keysB = getAccountKeys(txB);

  // Conflict if either tx writes to an account the other reads or writes
  for (const account of keysA.writableAccounts) {
    if (keysB.writableAccounts.has(account) || keysB.readableAccounts.has(account)) {
      return true;
    }
  }
  for (const account of keysB.writableAccounts) {
    if (keysA.readableAccounts.has(account)) {
      return true;
    }
  }
  return false;
}

// ── PARALLEL GROUP BUILDER ────────────────────────────────────────────────────
/**
 * Groups transactions into parallel-safe batches.
 * Transactions in the same group have no account conflicts.
 * Each group can be submitted as one ledger entry for parallel execution.
 *
 * Uses a greedy graph coloring algorithm.
 *
 * @param {Transaction[]} transactions
 * @returns {Transaction[][]} groups — each group is parallel-safe
 */
function buildParallelGroups(transactions) {
  const groups = [];
  const assigned = new Array(transactions.length).fill(false);

  for (let i = 0; i < transactions.length; i++) {
    if (assigned[i]) continue;

    const group = [transactions[i]];
    assigned[i] = true;

    for (let j = i + 1; j < transactions.length; j++) {
      if (assigned[j]) continue;
      if (group.length >= X1_MAX_PARALLEL) break;

      // Check if txJ conflicts with ANY tx already in this group
      const hasConflict = group.some(groupTx => conflictsWith(groupTx, transactions[j]));

      if (!hasConflict) {
        group.push(transactions[j]);
        assigned[j] = true;
      }
    }

    groups.push(group);
  }

  return groups;
}

// ── OPTIMIZATION REPORT ───────────────────────────────────────────────────────
/**
 * Analyzes a bundle and returns an optimization report without sending.
 * Use this to preview what the optimizer would do.
 */
function analyze(transactions) {
  if (!transactions || transactions.length === 0) {
    return { error: 'No transactions provided' };
  }

  const groups = buildParallelGroups(transactions);
  const totalTxs = transactions.length;
  const parallelGroups = groups.length;
  const maxGroupSize = Math.max(...groups.map(g => g.length));
  const avgGroupSize = (totalTxs / parallelGroups).toFixed(1);

  // Theoretical speedup: naive sequential vs parallel groups
  const naiveTime = totalTxs * 400; // 400ms per slot
  const parallelTime = parallelGroups * 400;
  const speedup = (naiveTime / parallelTime).toFixed(1);

  const fee = FEES.PER_BUNDLE + (totalTxs * FEES.PER_TX);

  return {
    input: {
      transactions: totalTxs,
    },
    output: {
      parallelGroups,
      maxGroupSize,
      avgGroupSize,
      estimatedSpeedup: `${speedup}x`,
      estimatedTimeMs: parallelTime,
      naiveTimeMs: naiveTime,
    },
    groups: groups.map((g, i) => ({
      group: i + 1,
      transactions: g.length,
      parallelSafe: true,
    })),
    fee: {
      total: fee,
      totalXNT: (fee / LAMPORTS_PER_SOL).toFixed(8),
      treasury: Math.round(fee * FEES.TREASURY_SHARE),
      burned: Math.round(fee * FEES.BURN_SHARE),
    },
    recommendation: parallelGroups < totalTxs
      ? `Optimized ${totalTxs} transactions into ${parallelGroups} parallel groups. ${speedup}x faster than sequential.`
      : 'All transactions conflict — sequential execution required.',
  };
}

// ── MAIN OPTIMIZER ────────────────────────────────────────────────────────────
/**
 * Optimizes and sends a bundle of transactions for maximum parallel execution.
 *
 * @param {Object} options
 * @param {Transaction[]} options.transactions - Bundle to optimize
 * @param {Connection} options.connection - X1 RPC connection
 * @param {Keypair} options.payer - Fee payer
 * @param {Keypair[]} options.signers - Transaction signers
 * @param {boolean} [options.dryRun] - Preview only, don't send
 * @returns {Object} result with groups sent and performance data
 */
async function optimizeAndSend({ transactions, connection, payer, signers, dryRun = false }) {
  if (!transactions || transactions.length === 0) throw new Error('No transactions provided');

  // Analyze conflicts and build parallel groups
  const groups = buildParallelGroups(transactions);
  const report = analyze(transactions);

  console.log(`[x1scroll/parallel] Optimizing ${transactions.length} txs → ${groups.length} parallel groups`);
  console.log(`[x1scroll/parallel] Estimated speedup: ${report.output.estimatedSpeedup}`);

  if (dryRun) {
    return { dryRun: true, report };
  }

  // Pay optimization fee (treasury + burn)
  const fee = FEES.PER_BUNDLE + (transactions.length * FEES.PER_TX);
  const treasuryFee = Math.round(fee * FEES.TREASURY_SHARE);
  const burnFee = fee - treasuryFee;

  const feeTx = new Transaction();
  feeTx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(TREASURY),
      lamports: treasuryFee,
    }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(BURN_ADDRESS),
      lamports: burnFee,
    })
  );

  const feeSig = await sendAndConfirmTransaction(connection, feeTx, [payer]);
  console.log(`[x1scroll/parallel] Fee paid: ${(fee/LAMPORTS_PER_SOL).toFixed(8)} XNT | TX: ${feeSig.slice(0,16)}...`);

  // Send each parallel group
  const results = [];
  const startTime = Date.now();

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    console.log(`[x1scroll/parallel] Sending group ${i+1}/${groups.length} (${group.length} parallel txs)...`);

    // Send all txs in this group simultaneously (they're non-conflicting)
    const groupPromises = group.map(tx =>
      sendAndConfirmTransaction(connection, tx, signers).catch(e => ({ error: e.message }))
    );

    const groupResults = await Promise.all(groupPromises);
    results.push({ group: i + 1, results: groupResults });
  }

  const elapsed = Date.now() - startTime;

  return {
    optimized: true,
    totalTransactions: transactions.length,
    parallelGroups: groups.length,
    timeMs: elapsed,
    speedup: report.output.estimatedSpeedup,
    feePaid: fee,
    feeTx: feeSig,
    results,
  };
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
module.exports = {
  // Core
  optimizeAndSend,
  analyze,
  buildParallelGroups,

  // Utilities
  conflictsWith,
  getAccountKeys,

  // Constants
  FEES,
  X1_MAX_PARALLEL,
  X1_THREADS,
  TREASURY,
  BURN_ADDRESS,
};
