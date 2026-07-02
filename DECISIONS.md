# Design Decisions

## Why holds instead of direct debit?

We hold (reserve) funds at authorize time rather than charging the wallet immediately because the dispense quantity is unknown until the pump stops. A direct debit at authorize would require debiting the maximum possible charge and issuing a refund after — refunds are slower, more complex, and worse UX. The hold pattern is standard in card-present fuel payments (Visa/Mastercard use the same mechanic at petrol stations).

The hold also protects the customer: if the pump fails mid-fill and never sends a settle, the hold expires and funds are released automatically (Phase 2 expiry worker).

---

## Why integer halalas (not SAR floats or decimal)?

Floating-point arithmetic is non-deterministic across platforms and languages. `0.1 + 0.2 ≠ 0.3` in IEEE-754. For money, every rounding difference is a real gain or loss. Using integer halalas (the smallest currency unit, like pence or cents) makes all arithmetic exact. BigInt is used throughout to avoid JS's 53-bit integer limit for large balances.

Rounding is centralized in one function (`roundHalfUp` in `src/lib/money.ts`) so it can be tested exhaustively and changed in one place.

---

## Why server-owned pricing?

The pump could lie. If the pump sends `price_per_litre = 0.01`, the customer fuels for essentially free. Keeping prices in a server-side `FuelPrice` table and ignoring any price claim from the pump means a compromised or malfunctioning pump cannot influence the charge. Price changes are managed via the table — insert a new row with a future `effective_from`, and the switchover is instantaneous and auditable.

---

## Why snapshot the price on the Authorization row?

Fuel prices can change between authorize and settle (a price update could land mid-fill). We snapshot the price at authorize time on the `Authorization` row so settle always charges the price the customer was shown, not a price that changed while they were fuelling. This matches the legal obligation in Saudi Arabia's retail pricing rules.

---

## SAMA Stored-Value Licensing Note

In Saudi Arabia, a consumer-facing prepaid wallet that stores monetary value requires a stored-value facility (SVF) licence from the Saudi Central Bank (SAMA) under the Payment Services Regulations 2020. This system implements the wallet mechanics but **does not include the regulatory compliance layer** (KYC/AML, float segregation, SAMA reporting). Any production deployment must be licensed or operated in partnership with a licensed payment institution.

---

## What is simulated vs real?

| Component | Status | Notes |
|---|---|---|
| RFID tag resolution | Real (DB lookup) | In production: pump communicates tag UID via TCP/TLS |
| Wallet ledger & hold/capture | Real | Full double-entry implementation |
| Price lookup | Real | Server-side, versioned |
| App top-up (Apple Pay / Card) | **Simulated** | No payment gateway integration; charge is assumed successful |
| Bank webhook top-up | **Simulated** | HMAC verification is real; BaaS provider integration is mocked |
| SAMA reporting | **Not implemented** | Required for production |
| Hold expiry worker | Not implemented (Phase 2) | Background job to expire stale authorizations |
| Fraud / velocity controls | Not implemented (Phase 2) | Daily/weekly limits, velocity rules |

---

## Why Fastify over Express?

Fastify has lower overhead, built-in schema validation hooks, and better TypeScript support. For a high-throughput pump-facing API (hundreds of authorizations per minute at a busy station), the performance margin matters.

---

## Why Prisma over raw SQL or Knex?

Prisma's type generation eliminates an entire class of schema/query mismatch bugs. The migration system keeps schema changes auditable. `$queryRaw` is used only where raw SQL is necessary (the `SELECT FOR UPDATE` lock), and the rest of the code uses typed Prisma queries. Knex or Drizzle are valid alternatives with more control; Prisma was chosen for developer velocity and type safety.
