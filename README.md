# Petrol Pump Fintech — RFID Fuel Wallet

Aldrees-style prepaid consumer fuel-payment platform. An RFID tag on a vehicle is read by the pump nozzle; the system authorizes against the owner's prepaid wallet, fuel is dispensed, and funds are captured on settle.

## Stack

- **Node.js + TypeScript** (strict mode)
- **PostgreSQL** via **Prisma**
- **Fastify** (HTTP) + **Zod** (validation)
- **Vitest** (tests, real Postgres)
- **docker-compose** (local Postgres)

## Prerequisites

- Docker + docker-compose
- Node.js ≥ 18
- `psql` client (for creating the test DB)

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy env file
cp .env.example .env

# 3. Start Postgres
docker-compose up -d

# 4. Generate Prisma client & run migrations
npm run db:generate
npm run db:migrate

# 5. Seed the database
npm run db:seed

# 6. Start the dev server
npm run dev
```

---

## Running tests

```bash
# Start Postgres (if not already running)
docker-compose up -d

# Run tests (against fuel_wallet_test DB — created automatically)
npm test
```

Tests run against a separate `fuel_wallet_test` database. The setup file creates it automatically and runs migrations before the suite.

---

## Seed data

After running `npm run db:seed`, the database contains:

| Resource | Value |
|---|---|
| User | Ahmed Al-Harbi |
| Wallet balance | 500 SAR (50 000 halalas) |
| Virtual IBAN | `SA0380000000608010167519` |
| Vehicle 1 | Plate `ABC-1234`, grade `GASOLINE_95`, tag `WAIE-04F3A19C` |
| Vehicle 2 | Plate `XYZ-5678`, grade `DIESEL`, tag `WAIE-0D1C2B3A` |
| Station | Code `RUH-014` — Aldrees Riyadh North |
| Prices | 91: 125 h/L · 95: 150 h/L · Diesel: 65 h/L |

---

## API reference

### POST /v1/fuel/authorize

Authorize a fuel fill. Locks funds in the wallet.

```bash
curl -X POST http://localhost:3000/v1/fuel/authorize \
  -H 'Content-Type: application/json' \
  -d '{"tag_uid":"WAIE-04F3A19C","station_code":"RUH-014","grade":"GASOLINE_95"}'
```

Response:
```json
{
  "authorization_id": "uuid",
  "max_millilitres": 100000,
  "max_litres": "100.000",
  "price_per_litre_halalas": "150",
  "expires_at": "2024-01-01T00:05:00.000Z"
}
```

---

### POST /v1/fuel/settle

Settle a completed fill. Captures actual amount and releases the difference.

```bash
curl -X POST http://localhost:3000/v1/fuel/settle \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: settle-001' \
  -d '{"authorization_id":"<uuid>","millilitres_dispensed":45000}'
```

Response:
```json
{
  "transaction_id": "uuid",
  "authorization_id": "uuid",
  "millilitres_dispensed": 45000,
  "litres_dispensed": "45.000",
  "captured_halalas": "6750",
  "released_halalas": "8250",
  "grade": "GASOLINE_95",
  "created_at": "2024-01-01T00:03:12.000Z"
}
```

---

### POST /v1/wallet/topups/app

Top up a wallet via Apple Pay or card.

```bash
curl -X POST http://localhost:3000/v1/wallet/topups/app \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: topup-001' \
  -d '{"wallet_id":"<uuid>","amount_halalas":10000,"method":"CARD"}'
```

---

### POST /v1/wallet/topups/bank-webhook

BaaS virtual-IBAN credit webhook (HMAC-signed).

```bash
# Generate signature: HMAC-SHA256(BANK_WEBHOOK_SECRET, raw-body)
BODY='{"bank_reference":"BNK-REF-001","virtual_iban":"SA0380000000608010167519","amount_halalas":10000}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "test_secret" | awk '{print $2}')

curl -X POST http://localhost:3000/v1/wallet/topups/bank-webhook \
  -H 'Content-Type: application/json' \
  -H "X-Bank-Signature: $SIG" \
  -d "$BODY"
```

---

### GET /v1/wallets/:id

```bash
curl http://localhost:3000/v1/wallets/<wallet-id>
```

Response:
```json
{
  "id": "uuid",
  "balance_halalas": "50000",
  "held_halalas": "0",
  "available_halalas": "50000",
  "currency": "SAR"
}
```

---

### GET /v1/wallets/:id/transactions

```bash
curl http://localhost:3000/v1/wallets/<wallet-id>/transactions
```

---

## Money rules

- All amounts are in **integer halalas** (1 SAR = 100 halalas). No floats anywhere.
- All volumes are in **integer millilitres** (1 L = 1 000 mL). No floats anywhere.
- Rounding: `roundHalfUp(price_per_litre_halalas × millilitres / 1000)` — see `src/lib/money.ts`.
