# Architecture — RFID Fuel Wallet

## Hold → Capture (two-phase commit for payments)

When a vehicle presents its RFID tag at a pump, we don't know yet how many litres will be dispensed. We only know the maximum possible charge (the full tank). This requires a two-phase approach:

**Phase 1 — Authorize (HOLD)**
1. Compute `max_millilitres = floor(available_balance × 1000 / price_per_litre)`, capped at `MAX_SINGLE_FILL_ML` (120 L).
2. Reserve `reserved_halalas = roundHalfUp(price × max_ml / 1000)` by incrementing `wallet.held_halalas`.
3. Write a `HOLD` ledger entry (negative, representing funds that are no longer available to spend).
4. `available = balance − held` — the wallet's spendable amount drops immediately.

**Phase 2 — Settle (CAPTURE)**
1. The pump reports actual litres dispensed.
2. `captured = roundHalfUp(price × actual_ml / 1000)`.
3. Decrement `balance` by `captured`; decrement `held` by `reserved`.
4. Write a `CAPTURE` entry (negative, the real debit) and a `RELEASE` entry (positive, the unused hold amount).

The net effect: the ledger sum of HOLD + CAPTURE + RELEASE equals exactly −captured, which matches the change in `balance`. This invariant is tested in `authorize-settle.test.ts`.

---

## Append-only Ledger

Every money movement writes an immutable `LedgerEntry` row. The `wallet.balance_halalas` column is a denormalized cache for performance. A wallet can be fully reconstructed from its ledger:

```
balance = SUM(amountHalalas) for TOPUP_CREDIT, CAPTURE(negative), RELEASE entries
held    = SUM(-amountHalalas) for unreleased HOLD entries
```

Entry types and their signs:

| Type | Sign | Meaning |
|---|---|---|
| TOPUP_CREDIT | + | Funds added to balance |
| HOLD | − | Funds reserved (moved to held) |
| CAPTURE | − | Funds actually spent |
| RELEASE | + | Unused hold returned to available |
| REVERSAL | + | Hold released on expiry |

---

## Concurrency Control — SELECT FOR UPDATE

The critical invariant is `held ≤ balance`. Without a lock, two concurrent authorize requests could both read the same `available` amount and both reserve it, doubling the hold.

Every balance-changing operation acquires a row-level lock on the wallet before any arithmetic:

```sql
SELECT id, balance_halalas, held_halalas
FROM wallets
WHERE id = $1
FOR UPDATE
```

This is wrapped in a Prisma `$transaction` (serializable-equivalent for the rows we touch). The lock is held until the transaction commits, serializing concurrent authorizations on the same wallet. The implementation is in `src/lib/db.ts:lockWallet`.

**Why not optimistic locking?** Optimistic locking would require retries on conflict, complicating the client. FOR UPDATE is simpler, correctness is guaranteed at the DB level, and wallet contention per vehicle is low in practice.

---

## Idempotency

Settle, app top-up, and the bank webhook are all at-least-once delivery surfaces (network retry, pump retry, BaaS retry). Without idempotency, a retry would charge the customer twice.

Every modifying endpoint requires an `Idempotency-Key` header (a client-generated UUID). Before executing, we check `idempotency_keys` for the key+scope pair. If found, we return the stored response immediately without touching the wallet. If not found, we execute and store `(key, scope, request_hash, response_json)`.

The bank webhook uses the `bank_reference` field (supplied by the bank) as its deduplication key, stored in `processed_bank_transfers`.

---

## Authorization State Machine

```
              authorize()
                  │
                  ▼
            AUTHORIZED  ──── expiresAt reached ──▶  EXPIRED
                  │                                      │
              settle()                          expiry worker                
                  │                             releases hold
                  ▼
             SETTLED
```

Valid transitions:
- `AUTHORIZED → SETTLED` (via settle)
- `AUTHORIZED → EXPIRED` (via expiry worker, Phase 2)
- `AUTHORIZED → REVERSED` (manual reversal, Phase 2)

Illegal transitions are rejected in `src/modules/settlement.ts` — any attempt to settle a non-AUTHORIZED authorization throws immediately.

---

## Pricing — Server-owned

The pump never sends a price. The `FuelPrice` table stores `(grade, price_per_litre_halalas, effective_from)`. The current price for a grade is the row with the latest `effective_from ≤ now()`. This prevents price tampering at the pump level and makes price changes atomic — insert a new row, and all future authorizations see the new price.

The snapshotted price is stored on the `Authorization` row so settle calculations always use the price that was in effect at authorize time, not the current price.

---

## Source Layout

```
src/
  lib/
    money.ts       — roundHalfUp, toSar, toLitres
    db.ts          — PrismaClient singleton + lockWallet()
    idempotency.ts — check/store idempotency keys
    hmac.ts        — HMAC-SHA256 sign/verify (timing-safe)
  schemas/
    authorize.ts   — Zod schema for POST /v1/fuel/authorize
    settle.ts      — Zod schema for POST /v1/fuel/settle
    topup.ts       — Zod schemas for topup endpoints
  modules/
    pricing.ts     — getCurrentPrice()
    authorization.ts — authorize()
    settlement.ts  — settle()
    topup.ts       — appTopup(), bankWebhookTopup()
    wallet.ts      — getWalletById(), getWalletTransactions()
  routes/
    fuel.ts        — POST /v1/fuel/{authorize,settle}
    wallet.ts      — POST /v1/wallet/topups/*, GET /v1/wallets/*
  server.ts        — Fastify app factory
```
