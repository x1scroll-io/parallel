# XIP-001: Mempool-Level Spam Filter for X1 Tachyon Client
**X1 Improvement Proposal**
**Author:** Arnett Esters (@ArnettX1) — x1scroll.io
**Date:** 2026-04-24
**Status:** Draft
**Category:** Client Upgrade (No Hard Fork Required)
**Requires:** Tachyon validator client update only

---

## Abstract

This proposal describes a mempool-level spam filter for the X1 tachyon validator client that prevents low-cost transaction flooding from degrading network performance. The filter operates at the transaction acceptance layer — each validator independently decides whether to forward or drop transactions based on burst patterns and fee thresholds. No consensus change or hard fork is required.

---

## Motivation

### The Ep 217-219 Event

Between Epochs 217 and 219, X1 experienced a cascading network degradation triggered by a load test that spammed the network with near-zero cost transactions:

| Epoch | Network Skip Rate | Validators Failed |
|-------|------------------|-------------------|
| 216   | ~0% (baseline)   | 0                 |
| 217   | 8.68%            | degradation begins |
| 218   | 18.38%           | 167 fully failed  |
| 219   | ~26%+            | 465 fully failed  |
| 220   | 2.35% (recovery) | 1,523 delegation removed |

**Root cause:** X1 currently has zero priority fees. Any address can flood the network at minimal cost. Validators on resource-constrained hosting (Interserver) were overwhelmed processing the flood instead of casting votes.

**The fix does not require a hard fork.** The mempool acceptance layer is local to each validator. Changes there are opt-in client upgrades — validators adopt at their own pace, and spam resistance improves proportionally with adoption.

---

## Specification

### Three-Signal Burst Detection

The filter runs in tachyon's transaction ingestion path, before transactions enter the banking stage queue.

**Signal 1 — Per-payer burst rate:**
```
if txs_from_fee_payer_in_last_slot >= BURST_THRESHOLD:
    apply BURST_MULTIPLIER to required fee
    OR drop if fee < BURST_MIN_FEE
```

**Signal 2 — Global queue depth:**
```
if pending_tx_queue > QUEUE_ALERT_THRESHOLD:
    require fee >= BASE_FEE * CONGESTION_MULTIPLIER
```

**Signal 3 — Account contention:**
```
if pct_txs_with_shared_writable_accounts > CONTENTION_THRESHOLD:
    prioritize low-contention txs
    require higher fee for high-contention txs
```

### Recommended Default Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `BURST_THRESHOLD` | 50 txs/slot per fee payer | 50+ txs in 400ms = clear spam pattern |
| `BURST_MIN_FEE` | 250,000 lamports | 50x base fee — makes burst economically painful |
| `QUEUE_ALERT_THRESHOLD` | 2,000 tx/slot | Based on Ep 217 queue depth at degradation onset |
| `QUEUE_CRITICAL_THRESHOLD` | 5,000 tx/slot | Ep 218 collapse level |
| `CONGESTION_MULTIPLIER_WARN` | 2x | Mild pressure |
| `CONGESTION_MULTIPLIER_ALERT` | 5x | Ep 217 level |
| `CONGESTION_MULTIPLIER_CRITICAL` | 20x | Ep 218 level |
| `CONTENTION_THRESHOLD` | 0.40 | 40% of txs sharing writable accounts |

All parameters should be tunable via validator config file — no recompile required.

### Thread-Safe Implementation

X1's 16-thread banking stage must not be serialized by fee sorting. The filter operates **before** thread assignment:

```
ingest_transaction(tx):
    fee_payer = tx.message.accountKeys[0]
    
    // Check burst
    if burst_tracker[fee_payer].count_last_slot() >= BURST_THRESHOLD:
        if tx.fee < BURST_MIN_FEE:
            drop(tx, reason="burst_below_min_fee")
            return
    
    // Check queue depth
    required_fee = BASE_FEE * current_congestion_multiplier()
    if tx.fee < required_fee:
        drop(tx, reason="fee_below_congestion_threshold")
        return
    
    // Pass to thread scheduler (unchanged)
    schedule_to_thread(tx)
```

Thread queues remain independent. Fee filtering happens at ingestion — the banking stage sees a pre-filtered queue and maintains full parallelism.

---

## Reference Implementation

A working JavaScript implementation demonstrating all three signals is available at:

**GitHub:** https://github.com/x1scroll-io/parallel/blob/main/src/adaptive-fee-gate.js

### On-Chain Proof of Concept

Three real transactions were submitted to X1 mainnet demonstrating fee tier enforcement:

| Test | Fee Paid | Multiplier | Status | Signature |
|------|----------|------------|--------|-----------|
| Baseline (WARN) | 10,000 lamports | 2x | ✅ Confirmed | `58bgAUGH...` |
| Alert Level | 25,000 lamports | 5x | ✅ Confirmed | `43ngVenD...` |
| Burst Level | 250,000 lamports | 50x | ✅ Confirmed | `5Wtryyxy...` |

**Explorer:** https://explorer.x1.xyz
**Total cost of proof:** 0.000011 XNT

---

## Expected Impact

### If 30% of validators adopt:
- Burst spammers filtered on 30% of the network
- Meaningful degradation resistance even at partial adoption
- Legitimate transactions unaffected (normal users don't send 50+ txs/slot)

### If 70%+ of validators adopt:
- Spam floods become economically irrational — attacker pays 50x per transaction
- Ep 217-219 style cascade becomes extremely unlikely
- Network skip rate during attack conditions stays near baseline

### What this does NOT do:
- Does not prevent a well-funded attacker willing to pay 50x fees
- Does not address validator hardware/hosting resource limits
- True prevention of unlimited-budget attacks requires protocol-level dynamic base fees (future hard fork)

---

## Backwards Compatibility

- No consensus changes
- No changes to transaction format
- Validators not running the upgrade are unaffected
- Adopting validators become more spam-resistant immediately
- No coordination required between validators

---

## Upgrade Path

1. x1scroll.io ships reference implementation (done — see GitHub above)
2. Jack's team reviews + integrates into tachyon client codebase
3. Ship as opt-in config flag in next tachyon release: `--enable-mempool-spam-filter`
4. Validators enable at next maintenance window
5. Monitor skip rate improvement via skip-monitor: https://github.com/x1scroll-io/skip-monitor
6. Make default-on once adoption > 50%

---

## Related Work

| Tool | Layer | Relationship |
|------|-------|--------------|
| Adaptive Fee Gate (this repo) | Application | Reference implementation for client-side fee logic |
| Validator Shield | Node | Helps validators survive degradation — complementary |
| Skip Monitor | Observability | Detects when spam filter should activate |
| Shred Muncher | Cleanup | Post-event debris removal — complementary |

---

## Conclusion

The Ep 217-219 event exposed a real vulnerability: X1 has no economic disincentive for spam. This proposal fixes that at the client level — no hard fork, no governance vote, immediate opt-in improvement.

The reference implementation is live, tested on mainnet, and ready for integration review.

**Ask:** Jack's team reviews the adaptive-fee-gate implementation and considers integrating burst detection + fee threshold enforcement into the tachyon mempool acceptance layer as a configurable opt-in feature.

---

*Built by x1scroll.io | @ArnettX1*
*Reference implementation: https://github.com/x1scroll-io/parallel*
*Skip monitor: https://github.com/x1scroll-io/skip-monitor*
