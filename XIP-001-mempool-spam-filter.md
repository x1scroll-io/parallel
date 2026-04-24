# XIP-001: Mempool-Level Spam Filter for X1 Tachyon Client
**X1 Improvement Proposal**
**Author:** Arnett Esters (@ArnettX1) — x1scroll.io
**Date:** 2026-04-24
**Status:** Draft — Implementation In Progress
**Category:** Tachyon Client Patch (No Hard Fork Required)
**Requires:** Tachyon validator client update only

---

## Abstract

This proposal describes a mempool-level spam filter for the X1 tachyon validator client that prevents low-cost transaction flooding from degrading network performance. The filter operates at the `recv_transaction()` layer — each validator independently decides whether to forward or drop transactions based on burst patterns, fee floors, and account rate limits.

**Current status:**
- ✅ Application-layer proof of concept (JavaScript) — live on X1 mainnet, receipts available
- ✅ Burst detection logic validated against live network data
- ✅ Skip rate data from Ep 217-219 event
- 🔧 Tachyon Rust implementation — **in progress** (see Section 6)

---

## 1. Motivation

### The Ep 217-219 Event

Between Epochs 217 and 219, X1 experienced a cascading network degradation triggered by a load test that spammed the network with near-zero cost transactions:

| Epoch | Network Skip Rate | Validators Failed |
|-------|------------------|-------------------|
| 216   | ~0% (baseline)   | 0                 |
| 217   | 8.68%            | degradation begins |
| 218   | 18.38%           | 167 fully failed  |
| 219   | ~26%+            | 465 fully failed  |
| 220   | 2.35% (recovery) | 1,523 delegation removed |

**Root cause:** X1 currently has near-zero transaction fees. Any address can flood the network at minimal cost. Validators on resource-constrained hosting were overwhelmed processing the flood instead of casting votes on time.

### Why a Multiplier Alone Doesn't Work

A naive fee multiplier (e.g., "50x during congestion") fails because 50 × near-zero = still near-zero. The fix requires an **absolute fee floor**, not just a relative multiplier:

```
// Wrong: multiplier on near-zero base
required_fee = current_fee * 50  // 50 * 0.000005 XNT = 0.00025 XNT — spammer doesn't care

// Right: absolute floor that scales with congestion
required_fee = max(ABSOLUTE_FLOOR, current_fee * multiplier)
// ABSOLUTE_FLOOR = 0.01 XNT during ALERT — makes 10,000 tx attack cost 100 XNT
```

---

## 2. Design Goals

1. **No hard fork** — mempool acceptance is a local validator decision
2. **Account rotation resistance** — can't bypass by rotating fee payers every 49 txs
3. **Absolute fee floors** — multipliers alone don't work; floors make spam expensive
4. **Validator incentive alignment** — validators that filter earn *better* fees, not less
5. **Griefing protection** — legitimate high-volume apps (DEXs, aggregators) must not be censored

---

## 3. Specification

### 3.1 Three-Signal Detection

**Signal 1 — Per-payer burst rate (with rotation resistance):**

Simple per-payer tracking is bypassable by rotating accounts every 49 txs. The fix: track at multiple levels simultaneously.

```rust
struct BurstTracker {
    per_payer: HashMap<Pubkey, SlotBucket>,      // per fee payer
    per_ip: HashMap<IpAddr, SlotBucket>,          // per source IP (rotation-resistant)
    per_program: HashMap<Pubkey, SlotBucket>,     // per program called
}

// Burst = ANY of these exceed threshold in one slot window
fn is_burst(tracker: &BurstTracker, tx: &Transaction, source_ip: IpAddr) -> bool {
    tracker.per_payer.get(&fee_payer(tx)).map_or(false, |b| b.count() >= BURST_PAYER_THRESHOLD)
    || tracker.per_ip.get(&source_ip).map_or(false, |b| b.count() >= BURST_IP_THRESHOLD)
}
```

**Signal 2 — Absolute fee floor (congestion-scaled):**

```rust
fn required_fee(congestion_level: CongestionLevel) -> u64 {
    match congestion_level {
        CongestionLevel::Nominal  => 5_000,          // 0.000005 XNT  (base)
        CongestionLevel::Warn     => 50_000,         // 0.00005 XNT   (10x floor)
        CongestionLevel::Alert    => 500_000,        // 0.0005 XNT    (100x floor)
        CongestionLevel::Critical => 5_000_000,      // 0.005 XNT     (1000x floor)
        CongestionLevel::Burst    => 50_000_000,     // 0.05 XNT      (10000x floor)
    }
}
// At ALERT: flooding 10,000 txs costs 5 XNT — economically meaningful
// At BURST: flooding 10,000 txs costs 500 XNT — attack becomes expensive
```

**Signal 3 — Griefing-safe high-volume whitelist:**

Legitimate high-volume applications (DEX aggregators, arbitrage bots) must not be falsely flagged.

```rust
struct MempoolConfig {
    // Validators can whitelist known high-volume legitimate programs
    high_volume_whitelist: Vec<Pubkey>,  // e.g., xDEX program, lending liquidators
    
    // Burst threshold is higher for whitelisted programs
    burst_threshold_normal: u32,   // 50 txs/slot
    burst_threshold_whitelist: u32, // 500 txs/slot
}
```

### 3.2 Validator Incentive Alignment

Validators earn fees from transactions they include. Dropping low-fee txs reduces revenue if there's nothing else to include. The incentive aligns correctly because:

1. **During spam attacks:** The mempool is full of near-zero fee spam. Filtering it allows higher-fee legitimate transactions to get through — validators earn *more* per slot.
2. **During normal operation:** Fee floors are low (5,000 lamports) — no legitimate transactions are dropped.
3. **Revenue argument:** A validator that accepts spam earns dust fees and misses votes (losing delegation). A validator that filters earns better fees and keeps delegation.

### 3.3 Congestion Level Computation

```rust
fn compute_congestion_level(
    pending_queue_depth: usize,
    network_skip_rate_bps: u64,  // from getVoteAccounts
) -> CongestionLevel {
    // Ep 217-219 calibrated thresholds
    match (pending_queue_depth, network_skip_rate_bps) {
        (_, s) if s >= 2500 => CongestionLevel::Critical,  // 25%+ skip
        (_, s) if s >= 1000 => CongestionLevel::Alert,     // 10%+ skip (Ep 217)
        (q, _) if q >= 5000 => CongestionLevel::Alert,
        (_, s) if s >= 500  => CongestionLevel::Warn,      // 5%+ skip
        (q, _) if q >= 2000 => CongestionLevel::Warn,
        _                   => CongestionLevel::Nominal,
    }
}
```

---

## 4. What Exists Today vs. What Needs Building

| Component | Status | Location |
|-----------|--------|----------|
| Burst detection logic | ✅ Proven | adaptive-fee-gate.js |
| Congestion level computation | ✅ Proven | adaptive-fee-gate.js |
| Absolute fee floor design | ✅ Specified above | This XIP |
| On-chain proof of fee tiers | ✅ 3/3 mainnet txs | See Section 5 |
| Rust implementation in tachyon | 🔧 In progress | tachyon fork (see Section 6) |
| IP-level burst tracking | 🔧 In progress | tachyon fork |
| Griefing whitelist | 🔧 In progress | tachyon fork |
| Local validator testing | 📋 Planned | After Rust implementation |

---

## 5. Proof of Concept

### Application-Layer Reference Implementation
**GitHub:** https://github.com/x1scroll-io/parallel/blob/main/src/adaptive-fee-gate.js

### On-Chain Receipts (X1 Mainnet)

Three real transactions demonstrating fee tier enforcement, submitted 2026-04-24:

| Test | Fee Paid | Multiplier | Status | Signature |
|------|----------|------------|--------|-----------|
| Baseline (WARN) | 10,000 lamports | 2x | ✅ Confirmed | `58bgAUGHjbDg5hgqP3pTe9DLqiyPG92y28gNu2aePA7sfou2PUkW9CVKzk2P5Z1d5CzBCp3ema1w2Ahfy3WwpUDi` |
| Alert Level | 25,000 lamports | 5x | ✅ Confirmed | `43ngVenDtcn7t7CRoJDPzJUysmLxmTEvSVbX4XUq42C3jTdKS4n2f5ogSjJf9JpHkiVPjPbKorGyzAjwxJTcxWUK` |
| Burst Level | 250,000 lamports | 50x | ✅ Confirmed | `5WtryyxQ6nmtwZaG7coJwBiGNeL6ccs6bhcnGYyj2vVDvjTGSwZNCUbXbJDr7Y1aZUj2bqJZHUDa4NWxCGAKRZ8k` |

*Note: These demonstrate application-layer fee enforcement. The tachyon implementation enforces the same logic at the validator ingestion layer, making it mandatory for all transactions regardless of client.*

---

## 6. Tachyon Implementation (In Progress)

The production implementation requires changes to the tachyon validator client in Rust.

### Target File
```
tachyon/validator/src/banking_stage/
├── transaction_scheduler.rs   // ADD: fee floor check before scheduling
├── unprocessed_packet_batches.rs  // ADD: burst tracker state
└── consume_worker.rs          // MODIFY: drop below-floor txs
```

### Key Changes Required
```rust
// In unprocessed_packet_batches.rs — add burst tracker
pub struct UnprocessedTransactionStorage {
    // existing fields...
    burst_tracker: Arc<Mutex<BurstTracker>>,
    mempool_config: MempoolConfig,
}

// In transaction_scheduler.rs — add fee floor check
fn should_accept_transaction(
    tx: &SanitizedTransaction,
    burst_tracker: &BurstTracker,
    congestion: CongestionLevel,
    source_ip: IpAddr,
) -> bool {
    let fee = tx.message().fee_payer_effective_fee();
    let floor = required_fee(congestion);
    
    if fee < floor { return false; }
    if is_burst(burst_tracker, tx, source_ip) && fee < required_fee(CongestionLevel::Burst) {
        return false;
    }
    true
}
```

**Tachyon fork:** https://github.com/x1scroll-io/tachyon *(in progress)*

---

## 7. Rollout Plan

1. ✅ Application-layer proof of concept (done)
2. 🔧 Tachyon fork with Rust implementation (in progress)
3. 📋 Local validator testing (single node)
4. 📋 Testnet validation
5. 📋 Submit PR to tachyon mainline for Jack's team review
6. 📋 Ship as opt-in: `--enable-mempool-spam-filter` flag in tachyon config
7. 📋 Monitor via skip-monitor: https://github.com/x1scroll-io/skip-monitor
8. 📋 Make default-on once adoption > 50% of stake-weighted validators

---

## 8. Open Questions for Jack's Team

1. Does tachyon expose source IP in the gossip receive path, or is IP-level tracking infeasible?
2. Is there an existing congestion signal in the banking stage we can hook into, or do we need to compute it independently?
3. What's the preferred mechanism for the high-volume whitelist — config file, on-chain program, or governance parameter?
4. Are there existing tests in tachyon's banking stage we should extend?

---

## 9. Related Work

| Tool | Layer | Status |
|------|-------|--------|
| Adaptive Fee Gate | Application | ✅ Live |
| Validator Shield | Node survival | ✅ Built |
| Skip Monitor | Observability | ✅ Live |
| Shred Muncher | Post-event cleanup | ✅ Built |
| Tachyon mempool patch | Validator client | 🔧 In progress |

---

*Built by x1scroll.io | @ArnettX1*
*Reference implementation: https://github.com/x1scroll-io/parallel*
*Skip monitor: https://github.com/x1scroll-io/skip-monitor*
