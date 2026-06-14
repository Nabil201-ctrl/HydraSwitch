# HydraSwitch: Resilient Payment Gateway

## Overview

HydraSwitch is a high-availability Payment Orchestration Service designed to decouple business logic from specific payment processors (PSPs). It acts as an intelligent traffic controller that routes transactions to multiple providers (Stripe, Adyen, PayPal, etc.) based on cost, availability, and geographic performance.

The primary objective is Zero Downtime Payments. If one provider becomes unavailable, the system detects the failure in milliseconds and automatically reroutes traffic to a healthy backup provider.

## Core Requirements and Functionality

- **Smart Routing**: A rule-based engine to select the optimal provider (e.g., "Use Adyen for EU transactions, Stripe for US").
- **Dynamic Failover**: Automatic rerouting of failed authorization attempts to a secondary gateway.
- **Provider Abstraction**: A unified API that translates internal requests into provider-specific payloads.
- **Vault Integration**: A secure environment for handling sensitive Primary Account Number (PAN) data.

## Architectural Concepts

### 1. The Circuit Breaker Pattern
This prevents the system from hanging or crashing by "tripping" a switch when a downstream provider is slow or error-prone.
- **Closed State**: Requests flow normally.
- **Open State**: After a defined number of failures, the system immediately returns an error or switches to a backup without calling the failing provider.
- **Half-Open**: Periodically allows a "test" request through to determine if the provider has recovered.

### 2. Payment State Machines
Payments are asynchronous and complex. A state machine ensures a payment cannot move into an invalid state (e.g., moving from REFUNDED back to CAPTURED). The system uses a strictly defined schema to manage transitions:
- `INITIATED` -> `PENDING` -> `AUTHORIZED` -> `CAPTURED` -> `SETTLED`
- Handles edge states such as `VOIDED`, `DECLINED`, or `EXPIRED`.

### 3. Tokenization and PCI-DSS Scoping
To reduce the PCI Audit Surface, the main application logic never sees or stores raw credit card numbers.
- **Transparent Proxy**: Intercepts card data before it hits the backend and swaps it for a non-sensitive token.
- **Vaulting**: Stores the mapping of Token to PAN in a highly encrypted, isolated database with restricted network access.

### 4. Messaging Standards (ISO 8583 / 20022)
The system aligns with banking communication standards. ISO 8583 is the legacy bitmapped standard for card transactions, while ISO 20022 is the modern XML/JSON-based standard. Internal JSON fields are mapped to standardized fields (e.g., MTI - Message Type Indicator) to ensure compatibility with traditional financial institutions.

## Data Schema Strategy

### Payment Intents (`payment_intents`)

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | UUID | Primary Key |
| `amount` | BigInt | Amount in smallest unit |
| `state` | Enum | Current state (e.g., AUTHORIZED) |
| `active_provider` | String | The PSP currently handling this request |
| `vault_token` | String | Reference to the secure card token |
| `retry_count` | Integer | Number of failover attempts made |

### Provider Health (`provider_health`)

| Column | Type | Description |
| :--- | :--- | :--- |
| `provider_id` | String | Stripe, Adyen, etc. |
| `status` | Enum | UP, DOWN, DEGRADED |
| `failure_rate` | Float | Percentage of errors in last 5 mins |
| `circuit_state` | Enum | CLOSED, OPEN, HALF_OPEN |

## Execution Flow

1. **Ingest**: Accept payment request with an Idempotency Key.
2. **Tokenize**: Swap raw card data for a vault token via the Secure Proxy.
3. **Route**: Check `provider_health` and select the highest-priority "UP" provider.
4. **Execute**: Attempt `AUTHORIZE` via the selected PSP.
5. **Handle Failure**:
    - If a "Hard Decline" occurs (e.g., Insufficient Funds): Stop.
    - If a "Soft Failure" occurs (e.g., Timeout/500): Trigger failover to the next provider.
6. **Finalize**: Move State Machine to `CAPTURED` upon success.

## Security and Compliance

- **HMAC Signatures**: All webhooks from providers must be verified to prevent spoofing.
- **Mutual TLS (mTLS)**: Enforced encrypted tunnels for communication between the Switch and the Vault.
- **Audit Logging**: Every state transition and routing decision is recorded for financial auditors.

---

## Simple UI for Non-Technical People

The easiest way to explore the system is with the built-in web UI.

**How to open it:**
1. `npm install`
2. `npm run dev`
3. Open your browser to **http://localhost:3000**

The UI lets anyone:
- Create payments by filling a simple form (amount, currency, description)
- See **exactly when** `pending_at`, `completed_at`, and `success_at` get recorded
- Click **"Process as SUCCESS"** to drive the full happy path and watch all success timestamps appear live
- Click **"Decline"** to see the failure path (only `declined_at` is set)
- Run an **"Idempotency Test"** button that proves sending the same `Idempotency-Key` twice returns the original payment (with visual proof)
- View a list of all previous test payments and load any of them
- Press **"Reset Demo Data"** to start fresh

Everything is self-explanatory with helpful labels and a live timeline of state changes + precise timestamps.

---

## Current Implementation (Core Features)

A working TypeScript/Fastify prototype has been implemented focusing on:

### Idempotency Keys
- All payment intent creation **requires** the `Idempotency-Key` header.
- Same key + same logical request returns the **existing** PaymentIntent with HTTP 200 + `Idempotency-Replay: true` header.
- Different keys always create new intents.
- The mapping is durably stored (JSON files under `data/`).

### Time Processed (State Timestamps)
On every state transition the exact time is recorded:

| Timestamp field | Set when state becomes...          | Notes |
|-----------------|------------------------------------|-------|
| `pending_at`    | `PENDING`                          | Set at ingest (first real processing step) |
| `completed_at`  | `CAPTURED` or `SETTLED`            | Marks "completed" processing |
| `success_at`    | `CAPTURED` or `SETTLED`            | Final successful outcome |
| `authorized_at`, `captured_at`, `settled_at`, `declined_at`... | respective states | Full audit trail also in `state_history[]` |

Declined / voided paths correctly populate only their failure timestamp and **never** set `completed_at` / `success_at`.

### State Machine
Strict transitions (see `src/stateMachine.ts`):
`INITIATED → PENDING → AUTHORIZED → CAPTURED → SETTLED` (happy path)
Hard terminals: `DECLINED`, `VOIDED`, `EXPIRED`.

### Endpoints
- `POST /v1/payment-intents` (Idempotency-Key header **required**)
- `GET  /v1/payment-intents/:id`
- `GET  /v1/payment-intents`
- `POST /v1/payment-intents/:id/process` — drives the full success path (populates completed + success times)
- `POST /v1/payment-intents/:id/transition` — manual state moves for testing
- `POST /v1/payment-intents/:id/decline`
- `GET  /v1/payment-intents/:id/allowed-transitions`
- `GET  /v1/providers/health` (stub)

### Quick Start
```bash
npm install
npm run dev
```

Then open **http://localhost:3000** in your browser.

The UI is specifically designed so non-technical team members can safely play with idempotency keys and see the exact timestamps recorded when payments move through `PENDING` → success states.

You can still use curl / API if you prefer:
```bash
# Example API call (note the required header)
curl -X POST http://localhost:3000/v1/payment-intents \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123456789" \
  -d '{"amount": 1999, "currency": "USD", "description": "Order #42"}'

# Drive the happy path (this is what the big green button does in the UI)
curl -X POST http://localhost:3000/v1/payment-intents/<ID>/process
```

Run the automated verification (good for developers):
```bash
npm run verify
```

Data (intents + idempotency records) is persisted to `data/*.json` between restarts.

### Next (Roadmap items from original spec)
- Real tokenization / Vault proxy
- Smart routing + provider health + circuit breaker
- Actual PSP adapters (Stripe, Adyen, etc.)
- Webhook verification + ISO 8583/20022 mapping
- Persistent DB (Postgres/SQLite via Prisma) + proper migrations
- Distributed idempotency (Redis) with TTL for keys

## Data Model Additions (beyond initial spec)
- `idempotency_key` on every `payment_intent`
- Full set of `*_at` timestamps for each meaningful state change (pending/completed/success emphasized)
- `state_history: [{state, at}, ...]` for complete audit
