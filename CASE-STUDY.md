# Thobii — Product Case Study

**An open-loop RFID fuel wallet for Saudi Arabia — from market research to a live demo.**

Live demo: deployed on Vercel (in-browser demo mode, no signup). Backend: Fastify + Prisma + PostgreSQL with an append-only ledger, hold/capture authorization, and 99 automated tests.

---

## The Problem

Saudi fuel stations are full-service by regulation — a trained attendant pumps every fill ([Saudi Gazette](https://saudigazette.com.sa/article/638933)). Payment is the slowest, most error-prone step of that lane: cash handling, terminals, misfuelled tanks, and fleets with no control over driver spending.

Aldrees proved the fix works. Its RFID fueling system, **WAIE**, reads a tag mounted at the vehicle's filler, verifies the fuel grade at the nozzle, and settles cashlessly — running on **629 stations and 623,000+ vehicles** ([Aldrees WAIE](https://aldrees.com/english/waie), [annual report](https://www.aldrees.com/english/fileUpload/351065_1679988883.pdf)).

## The Insight

WAIE is not a payments business — **it's a lock-in machine.** ~97% of Aldrees revenue is fuel retail/wholesale; WAIE's job is to attract fleets and keep them fueling only at Aldrees ([annual report](https://www.aldrees.com/english/fileUpload/153277_1643091393.pdf), [Argaam](https://www.argaam.com/en/article/articledetail/id/1575581)). One brand's tag, one brand's stations: a closed loop.

**The incumbent cannot open the loop without breaking its own lock-in.** That is a structural gap, not a feature gap.

## The Wedge — an open-loop wallet

One wallet, one tag, **any station brand**. Thobii monetizes like a payments company, not a fuel retailer:

**Primary: per-fill merchant fee** — stations pay for the fleet volume Thobii routes to them.

| Illustrative unit economics | |
|---|---|
| Average fill (40 L Gasoline 95 @ SAR 2.33/L) | ≈ SAR 93 |
| Per-fill fee to station (~1%) | ≈ SAR 0.90 |
| Fleet vehicle × 8 fills/month | ≈ SAR 7.20 / vehicle / month |
| At 100k vehicles (16% of WAIE's base) | ≈ SAR 8.6M / year |

Honest tension: fuel retail margins are thin, so the fee only clears if it pays for itself — incremental routed volume, less cash handling, less fraud. Go-to-market therefore starts with **challenger station networks** hungry for fleet volume, not the market leader. Secondary lines: float on prepaid balances, fleet SaaS for controls and reporting.

## Key Product Decisions

1. **Hold → capture, not a single charge.** The pump can't know the final amount before fueling. Authorize places a hold for the maximum affordable volume; settle captures the metered amount and releases the rest. The same model card networks use at pumps. Tradeoff: expiry/release logic to build and test.
2. **Research corrected the product model.** V1 let the user "choose litres." Studying WAIE showed litres come from the pump's **flow meter** — the attendant pumps; the driver never types a number. The simulator was relabelled to match reality ("Pump meter — litres dispensed").
3. **Misfuel prevention at authorize.** Vehicles are locked to a grade; the wrong nozzle is refused before fuel flows — mirroring WAIE's nozzle-reader verification.
4. **Weekly litre caps revealed the buyer.** Volume caps, velocity limits, and one-active-fill-per-vehicle are fleet-manager features. The B2B fleet is the wedge customer; the consumer wallet rides on the same rails.
5. **Money that can't lie.** Append-only ledger, integer halalas (no floating point), idempotency keys on every money endpoint, daily reconciliation reports. 99 automated tests against a real PostgreSQL.
6. **Market-accurate pricing.** Government-capped Saudi pump prices per grade: 91 = SAR 2.18, 95 = SAR 2.33, Diesel = SAR 1.79 ([GlobalPetrolPrices](https://www.globalpetrolprices.com/Saudi-Arabia/gasoline_prices/), [KSA Expats](https://ksaexpats.com/saudi-arabia-fuel-prices/)).
7. **Distribution through the demo.** The deployed app runs a full in-browser mock of the API — anyone can authorize, fill, and read a receipt without signing up or touching a database.

## Regulation

A stored-value wallet in Saudi Arabia is regulated e-money. Launch path: the **SAMA Regulatory Sandbox**, or partnering with a licensed EMI, with mada / Apple Pay rails for top-ups. Licensing is treated as a launch dependency, not an afterthought.

## Success Metrics

- **North star:** monthly settled fills per active wallet — habit, routed volume, and fee revenue in one number.
- **Guardrails:** authorization failure rate · reversal rate · top-up → first-fill conversion · dormant balance share (float that signals churn, not profit).

## Roadmap

1. Pilot with one challenger station network — prove the open loop.
2. Fleet dashboard: multi-vehicle caps, consumption reports, VAT invoices.
3. SAMA sandbox application / EMI partnership.
4. Pump integration spec: flow-meter settle over webhook, replacing the simulator.

---

*Built end-to-end — market research, product decisions, ledger backend, UI, and deployment — using AI-assisted development. The product is the demo; this document is the reasoning.*
