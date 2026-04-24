/**
 * Adaptive Fee Gate — x1scroll.io
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time congestion detection + dynamic fee adjustment for X1.
 * Sits between transaction ingestion and the 16-thread banking stage.
 *
 * Design principles:
 *   1. Per-slot detection (~400ms windows) — not epoch-level
 *   2. Parallelism-preserving — fee gate filters INPUT, not thread execution
 *   3. Burst detection — same fee payer, high volume, tight window → flag + reprice
 *   4. Thread-local fee queues — one priority queue per thread group, no serialization
 *
 * Three congestion signals:
 *   - Queue depth:       pending tx count vs baseline
 *   - Account contention: % of txs fighting over same writable accounts
 *   - Burst detection:   same fee payer sending N+ txs per slot
 *
 * Author: x1scroll.io | @ArnettX1 | 2026-04-24
 */

'use strict';

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const SLOT_MS = 400;                    // X1 slot time
const X1_THREADS = 16;                  // banking threads

// Congestion thresholds
const THRESHOLDS = {
  QUEUE_DEPTH_WARN:     500,    // pending txs — start watching
  QUEUE_DEPTH_ALERT:   2000,    // pending txs — apply multiplier
  QUEUE_DEPTH_CRITICAL: 5000,   // pending txs — max multiplier
  CONTENTION_WARN:      0.20,   // 20% of txs share writable accounts
  CONTENTION_ALERT:     0.40,   // 40% contention
  BURST_TX_PER_SLOT:    50,     // same fee payer, per slot = burst
  BURST_TX_WINDOW_MS:   400,    // burst detection window = 1 slot
};

// Fee multipliers (applied to base fee)
const FEE_MULTIPLIERS = {
  NOMINAL:   1.0,
  WARN:      2.0,    // 2x base fee
  ALERT:     5.0,    // 5x base fee
  CRITICAL:  20.0,   // 20x base fee — spam becomes very expensive
  BURST:     50.0,   // 50x for detected burst senders
};

// Base fee in lamports (X1 current)
const BASE_FEE_LAMPORTS = 5000;

// ── STATE ─────────────────────────────────────────────────────────────────────
class AdaptiveFeeGate {
  constructor(rpcUrl = 'https://rpc.mainnet.x1.xyz', options = {}) {
    this.rpcUrl = rpcUrl;
    this.options = {
      slotMs: options.slotMs || SLOT_MS,
      verbose: options.verbose || false,
      ...options,
    };

    // Current fee state
    this.currentMultiplier = FEE_MULTIPLIERS.NOMINAL;
    this.congestionLevel = 'NOMINAL';
    this.lastSlot = 0;

    // Slot history for trend detection
    this.slotHistory = [];
    this.maxHistory = 10;

    // Burst tracker: feePayer → [timestamps]
    this.burstTracker = new Map();

    // Per-thread fee queues (16 threads)
    this.threadQueues = Array.from({ length: X1_THREADS }, () => []);

    // Metrics
    this.metrics = {
      slotsProcessed: 0,
      txsGated: 0,
      txsBlocked: 0,
      burstSendersDetected: 0,
      totalFeesCollected: 0,
      lastUpdate: null,
    };
  }

  // ── RPC ──────────────────────────────────────────────────────────────────────
  async _rpc(method, params = []) {
    const https = require('https');
    const http = require('http');
    const url = new URL(this.rpcUrl);
    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 8000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data).result); }
          catch (e) { reject(new Error(`RPC parse error: ${data.slice(0, 80)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('RPC timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ── CONGESTION SIGNALS ────────────────────────────────────────────────────────

  /**
   * Signal 1: Queue depth
   * Reads recent performance samples to estimate pending tx pressure.
   */
  async _readQueueDepth() {
    try {
      const perf = await this._rpc('getRecentPerformanceSamples', [5]);
      if (!perf || !perf.length) return 0;
      const latest = perf[0];
      // numTransactions / numSlots = avg txs per slot
      const txPerSlot = latest.numSlots > 0
        ? latest.numTransactions / latest.numSlots
        : 0;
      // Estimate queue depth: if throughput is high, queue is building
      return Math.round(txPerSlot);
    } catch {
      return 0;
    }
  }

  /**
   * Signal 2: Account contention
   * Given a set of pending transactions, what % share writable accounts?
   * @param {Array} transactions - array of parsed transaction objects
   * @returns {number} contention ratio 0.0 - 1.0
   */
  _measureContention(transactions) {
    if (!transactions || transactions.length < 2) return 0;

    const writableByAccount = new Map();

    for (const tx of transactions) {
      const accounts = this._extractWritableAccounts(tx);
      for (const acc of accounts) {
        writableByAccount.set(acc, (writableByAccount.get(acc) || 0) + 1);
      }
    }

    // Count txs that share at least one writable account with another tx
    let contested = 0;
    for (const tx of transactions) {
      const accounts = this._extractWritableAccounts(tx);
      const isContested = accounts.some(acc => writableByAccount.get(acc) > 1);
      if (isContested) contested++;
    }

    return contested / transactions.length;
  }

  _extractWritableAccounts(tx) {
    const accounts = [];
    try {
      if (tx?.message?.accountKeys) {
        const numSig = tx.message.header?.numRequiredSignatures || 0;
        tx.message.accountKeys.forEach((key, idx) => {
          if (idx < numSig) {
            accounts.push(key.toBase58 ? key.toBase58() : key.toString());
          }
        });
      }
    } catch { /* ignore malformed */ }
    return accounts;
  }

  /**
   * Signal 3: Burst detection
   * Tracks fee payers. If same payer sends >= BURST_TX_PER_SLOT in one slot window,
   * flag them as a burst sender and apply BURST multiplier to their transactions.
   */
  _detectBurst(transactions) {
    const now = Date.now();
    const windowStart = now - THRESHOLDS.BURST_TX_WINDOW_MS;
    const burstSenders = new Set();

    for (const tx of transactions) {
      const feePayer = this._getFeePayer(tx);
      if (!feePayer) continue;

      if (!this.burstTracker.has(feePayer)) {
        this.burstTracker.set(feePayer, []);
      }

      const timestamps = this.burstTracker.get(feePayer);
      timestamps.push(now);

      // Prune old timestamps outside window
      const recent = timestamps.filter(t => t >= windowStart);
      this.burstTracker.set(feePayer, recent);

      if (recent.length >= THRESHOLDS.BURST_TX_PER_SLOT) {
        burstSenders.add(feePayer);
        if (this.options.verbose) {
          console.log(`[FeeGate] 🚨 Burst detected: ${feePayer.slice(0, 8)}... — ${recent.length} txs in ${THRESHOLDS.BURST_TX_WINDOW_MS}ms`);
        }
      }
    }

    // Cleanup stale entries
    if (this.burstTracker.size > 10000) {
      for (const [payer, times] of this.burstTracker.entries()) {
        if (times.every(t => t < windowStart)) {
          this.burstTracker.delete(payer);
        }
      }
    }

    return burstSenders;
  }

  _getFeePayer(tx) {
    try {
      if (tx?.message?.accountKeys?.length > 0) {
        const key = tx.message.accountKeys[0];
        return key.toBase58 ? key.toBase58() : key.toString();
      }
    } catch { /* ignore */ }
    return null;
  }

  // ── FEE MULTIPLIER COMPUTATION ────────────────────────────────────────────────

  /**
   * Compute the current fee multiplier based on all three signals.
   * Called once per slot.
   */
  async _computeMultiplier(transactions = []) {
    const queueDepth = await this._readQueueDepth();
    const contention = this._measureContention(transactions);
    const burstSenders = this._detectBurst(transactions);

    // Determine congestion level from queue depth
    let queueLevel = 'NOMINAL';
    if (queueDepth >= THRESHOLDS.QUEUE_DEPTH_CRITICAL) queueLevel = 'CRITICAL';
    else if (queueDepth >= THRESHOLDS.QUEUE_DEPTH_ALERT)    queueLevel = 'ALERT';
    else if (queueDepth >= THRESHOLDS.QUEUE_DEPTH_WARN)     queueLevel = 'WARN';

    // Contention can escalate the level
    let contentionLevel = 'NOMINAL';
    if (contention >= THRESHOLDS.CONTENTION_ALERT)   contentionLevel = 'ALERT';
    else if (contention >= THRESHOLDS.CONTENTION_WARN) contentionLevel = 'WARN';

    // Take worst of both signals
    const levels = ['NOMINAL', 'WARN', 'ALERT', 'CRITICAL'];
    const combinedIdx = Math.max(levels.indexOf(queueLevel), levels.indexOf(contentionLevel));
    const combinedLevel = levels[combinedIdx];

    const multiplier = FEE_MULTIPLIERS[combinedLevel];

    // Update state
    this.currentMultiplier = multiplier;
    this.congestionLevel = combinedLevel;

    // Record history
    this.slotHistory.push({
      ts: Date.now(),
      queueDepth,
      contention: parseFloat(contention.toFixed(3)),
      level: combinedLevel,
      multiplier,
      burstSenders: burstSenders.size,
    });
    if (this.slotHistory.length > this.maxHistory) {
      this.slotHistory.shift();
    }

    this.metrics.slotsProcessed++;
    this.metrics.burstSendersDetected += burstSenders.size;
    this.metrics.lastUpdate = new Date().toISOString();

    if (this.options.verbose && combinedLevel !== 'NOMINAL') {
      console.log(`[FeeGate] ${combinedLevel} — queue=${queueDepth} contention=${(contention*100).toFixed(1)}% multiplier=${multiplier}x`);
    }

    return { level: combinedLevel, multiplier, queueDepth, contention, burstSenders };
  }

  // ── THREAD-AWARE QUEUE DISTRIBUTION ──────────────────────────────────────────

  /**
   * Distribute transactions across 16 thread queues.
   * Transactions that share writable accounts go to the same thread.
   * Fee sorting happens WITHIN each thread queue — not across all threads.
   * This preserves parallelism while enforcing fee priority.
   *
   * @param {Array} transactions - array of {tx, feeLamports, feePayer}
   * @param {Set} burstSenders - fee payers flagged as burst senders
   * @returns {Array[]} 16 sorted thread queues
   */
  _distributeToThreads(transactions, burstSenders = new Set()) {
    // Reset thread queues
    const queues = Array.from({ length: X1_THREADS }, () => []);

    // Account → thread assignment (deterministic, based on account hash)
    const accountThreadMap = new Map();

    const getThread = (account) => {
      if (!accountThreadMap.has(account)) {
        // Simple hash — distribute accounts evenly across threads
        let hash = 0;
        for (let i = 0; i < account.length; i++) {
          hash = ((hash << 5) - hash) + account.charCodeAt(i);
          hash |= 0;
        }
        accountThreadMap.set(account, Math.abs(hash) % X1_THREADS);
      }
      return accountThreadMap.get(account);
    };

    for (const item of transactions) {
      const { tx, feeLamports, feePayer } = item;
      const writableAccounts = this._extractWritableAccounts(tx);

      // Assign to thread based on first writable account
      const threadIdx = writableAccounts.length > 0
        ? getThread(writableAccounts[0])
        : Math.floor(Math.random() * X1_THREADS);

      // Apply burst multiplier if sender is flagged
      const effectiveFee = burstSenders.has(feePayer)
        ? feeLamports * FEE_MULTIPLIERS.BURST
        : feeLamports;

      queues[threadIdx].push({ tx, feeLamports: effectiveFee, feePayer, threadIdx });
    }

    // Sort each thread queue by fee descending (highest fee = first executed)
    for (const queue of queues) {
      queue.sort((a, b) => b.feeLamports - a.feeLamports);
    }

    return queues;
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────────

  /**
   * Process a batch of transactions through the fee gate.
   * Returns the adjusted fee and thread assignment for each transaction.
   *
   * @param {Array} transactions - raw transaction objects
   * @returns {Object} { queues, congestion, metrics }
   */
  async process(transactions = []) {
    const { level, multiplier, queueDepth, contention, burstSenders } =
      await this._computeMultiplier(transactions);

    // Wrap transactions with fee metadata
    const wrapped = transactions.map(tx => {
      const feePayer = this._getFeePayer(tx);
      const baseFee = tx._estimatedFee || BASE_FEE_LAMPORTS;
      const adjustedFee = Math.ceil(baseFee * multiplier);

      this.metrics.txsGated++;
      this.metrics.totalFeesCollected += adjustedFee;

      return { tx, feeLamports: adjustedFee, feePayer };
    });

    // Distribute across thread queues with per-thread fee sorting
    const queues = this._distributeToThreads(wrapped, burstSenders);

    this.metrics.burstSendersDetected += burstSenders.size;

    return {
      queues,
      congestion: {
        level,
        multiplier,
        queueDepth,
        contention: parseFloat((contention * 100).toFixed(1)),
        burstSenders: burstSenders.size,
        effectiveFee: Math.ceil(BASE_FEE_LAMPORTS * multiplier),
      },
      metrics: { ...this.metrics },
    };
  }

  /**
   * Get current fee state without processing transactions.
   * Useful for UI / monitoring.
   */
  async status() {
    const queueDepth = await this._readQueueDepth();
    return {
      congestionLevel: this.congestionLevel,
      currentMultiplier: this.currentMultiplier,
      effectiveFee: Math.ceil(BASE_FEE_LAMPORTS * this.currentMultiplier),
      queueDepth,
      history: this.slotHistory.slice(-5),
      metrics: { ...this.metrics },
    };
  }

  /**
   * Get recommended fee for a single transaction right now.
   * Use this before submitting — pay this fee to get priority.
   */
  async getRecommendedFee(tx = null) {
    const queueDepth = await this._readQueueDepth();

    let level = 'NOMINAL';
    if (queueDepth >= THRESHOLDS.QUEUE_DEPTH_CRITICAL) level = 'CRITICAL';
    else if (queueDepth >= THRESHOLDS.QUEUE_DEPTH_ALERT)    level = 'ALERT';
    else if (queueDepth >= THRESHOLDS.QUEUE_DEPTH_WARN)     level = 'WARN';

    const multiplier = FEE_MULTIPLIERS[level];
    const fee = Math.ceil(BASE_FEE_LAMPORTS * multiplier);

    return {
      baseFee: BASE_FEE_LAMPORTS,
      multiplier,
      recommendedFee: fee,
      congestionLevel: level,
      queueDepth,
    };
  }
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
module.exports = {
  AdaptiveFeeGate,
  THRESHOLDS,
  FEE_MULTIPLIERS,
  BASE_FEE_LAMPORTS,
};
