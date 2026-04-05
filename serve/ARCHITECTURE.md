# ACP Serve — Technical Architecture

**x402 and MPP endpoints backed by ACP and ERC-8183 on-chain settlement**

---

## Overview

ACP Serve translates developer-provided handler functions into fully functional x402, MPP, and ACP native endpoints — all backed by ERC-8183 (Agentic Commerce) on-chain escrow.

Developers write a handler function for the job offering (`handler.ts`). ACP Serve wraps it with x402 and MPP payment middleware and handles all on-chain interactions. Fruthermore, this also includes integration with ERC-8183 jobs. 3 interfaces for each job offering: x402, MPP, and ACP native. These job offering services can be served locally or self-hosted through the developer's own infrastructure or 'acp serve deploy' will help with hosting these services and endpoints directly too.

### Core principles

1. **The developer only writes handler (or other special functions for spcific ACP functionality) logic.** No payment code, no blockchain code, no protocol code. Just a function that takes requirements and returns a deliverable.

2. **8183 is the settlement layer for all protocols.** x402 and MPP payments are routed through ERC-8183 escrow. Every transaction gets on-chain logging, evaluator attestation, and reputation tracking — regardless of which protocol the client used.

3. **Three endpoints, one handler.** `acp serve init` scaffolds a handler. `acp serve deploy` gives the developer x402, MPP, and ACP native endpoints — all using the same handler function.

---

## Architecture

### Two services

```
┌─────────────────────────────────────────────────────────┐
│  Offering Server (deployed per offering)                 │
│                                                          │
│  - HTTP server with x402 + MPP middleware                │
│  - Runs the developer's handler.ts                       │
│  - Serves 402 responses, processes payments              │
│  - Delegates on-chain work to ACP Backend                │
│                                                          │
│  Deployed via: acp serve deploy                          │
│  Can also run locally: acp serve start                   │
└────────────────────────┬────────────────────────────────┘
                         │ /verify, /settle, /submit
                         ▼
┌─────────────────────────────────────────────────────────┐
│  ACP Backend (centralized service)                       │
│                                                          │
│  - POST /verify: payment verification                    │
│  - POST /settle: ERC-8183 lifecycle                      │
│  - POST /submit: ACP native job completion               │
│  - Holds gateway wallet (gas + evaluator role)           │
│  - Shared across all offerings                           │
│                                                          │
│  Note: Only needed for hosted deployments. Self-hosted   │
│  providers can run everything in one process using the   │
│  ACP SDK directly.                                       │
└────────────────────────┬────────────────────────────────┘
                         │ on-chain transactions
                         ▼
┌─────────────────────────────────────────────────────────┐
│  ERC-8183 Contract + PaymentHook (Tempo)                 │
│                                                          │
│  - Job escrow with evaluator attestation                 │
│  - PaymentHook: routes x402/MPP payments to escrow       │
│  - ERC-8004 reputation on every job completion           │
└─────────────────────────────────────────────────────────┘
```

### Why two services?

The ACP Backend exists for **hosted deployments** where offering servers run on lightweight infrastructure (Cloudflare Workers) that cannot hold private keys or make on-chain transactions.

For **self-hosted deployments**, the offering server can do everything itself — the backend is not required. The server imports the ACP SDK directly and acts as its own facilitator and evaluator.

| Deployment mode | Offering Server | Backend | Who does on-chain? |
|-----------------|----------------|---------|-------------------|
| Hosted (`acp serve deploy`) | Cloudflare Worker (stateless) | Required | Backend |
| Self-hosted (`acp serve start`) | Local process with wallet | Not required | Server itself |

---

## Payment flows

### x402 flow

The x402 protocol uses a server + facilitator model. The offering server is the resource server. The ACP Backend is the facilitator.

```
x402 Client                 Offering Server              ACP Backend (Facilitator)     8183 + Hook
    │                            │                              │                          │
    │ GET /x402/<offering-id>    │                              │                          │
    ├───────────────────────────►│                              │                          │
    │                            │                              │                          │
    │◄───────────────────────────┤                              │                          │
    │ 402 + PAYMENT-REQUIRED     │                              │                          │
    │ (price, payTo, asset)      │                              │                          │
    │                            │                              │                          │
    │ Client signs EIP-3009      │                              │                          │
    │ authorization (off-chain)  │                              │                          │
    │                            │                              │                          │
    │ GET /x402/<offering-id>    │                              │                          │
    │ + PAYMENT-SIGNATURE        │                              │                          │
    ├───────────────────────────►│                              │                          │
    │                            │                              │                          │
    │                            │ POST /verify                 │                          │
    │                            │ {protocol:"x402", payment}   │                          │
    │                            ├─────────────────────────────►│                          │
    │                            │                              │ x402 SDK:                │
    │                            │                              │ verify signature,        │
    │                            │                              │ check balance,           │
    │                            │                              │ simulate tx              │
    │                            │◄─────────────────────────────┤                          │
    │                            │ {valid: true, clientAddr}    │                          │
    │                            │                              │                          │
    │                            │ Run handler.ts               │                          │
    │                            │ (requirements → deliverable) │                          │
    │                            │                              │                          │
    │                            │ POST /settle                 │                          │
    │                            │ {payment, deliverable, ...}  │                          │
    │                            ├─────────────────────────────►│                          │
    │                            │                              │ createJob ──────────────►│ Job Open
    │                            │                              │ setBudget ──────────────►│ Budget Set
    │                            │                              │ fund(optParams=auth) ───►│ Hook:
    │                            │                              │                          │  transferWithAuth
    │                            │                              │                          │  (client → escrow)
    │                            │                              │                          │ Job Funded
    │                            │                              │ submit(deliverable) ────►│ Job Submitted
    │                            │                              │ complete() as evaluator ►│ Job Completed
    │                            │                              │                          │ escrow → provider
    │                            │                              │                          │ ERC-8004 reputation++
    │                            │◄─────────────────────────────┤                          │
    │                            │ {success, jobId}             │                          │
    │                            │                              │                          │
    │◄───────────────────────────┤                              │                          │
    │ 200 + deliverable          │                              │                          │
    │ + PAYMENT-RESPONSE         │                              │                          │
```

### MPP flow

MPP has no facilitator — the server verifies payments directly. However, we still delegate on-chain work to the ACP Backend for the same 8183 settlement.

```
MPP Client                  Offering Server              ACP Backend                   8183 + Hook
    │                            │                              │                          │
    │ GET /mpp/<offering-id>     │                              │                          │
    ├───────────────────────────►│                              │                          │
    │                            │                              │                          │
    │◄───────────────────────────┤                              │                          │
    │ 402 + WWW-Authenticate:    │                              │                          │
    │ Payment (HMAC challenge)   │                              │                          │
    │                            │                              │                          │
    │ Client signs transaction   │                              │                          │
    │ (not submitted yet)        │                              │                          │
    │                            │                              │                          │
    │ GET /mpp/<offering-id>     │                              │                          │
    │ + Authorization: Payment   │                              │                          │
    │   (type: "transaction")    │                              │                          │
    ├───────────────────────────►│                              │                          │
    │                            │                              │                          │
    │                            │ POST /verify                 │                          │
    │                            │ {protocol:"mpp", credential} │                          │
    │                            ├─────────────────────────────►│                          │
    │                            │                              │ Verify credential:       │
    │                            │                              │ - "transaction" type:    │
    │                            │                              │   validate signature     │
    │                            │                              │ - "hash" type:           │
    │                            │                              │   check on-chain receipt │
    │                            │◄─────────────────────────────┤                          │
    │                            │ {valid: true, clientAddr}    │                          │
    │                            │                              │                          │
    │                            │ Run handler.ts               │                          │
    │                            │                              │                          │
    │                            │ POST /settle                 │                          │
    │                            │ {credential, deliverable}    │                          │
    │                            ├─────────────────────────────►│                          │
    │                            │                              │ 8183: createJob → fund   │
    │                            │                              │ → submit → complete      │
    │                            │                              │ (same as x402)           │
    │                            │◄─────────────────────────────┤                          │
    │                            │ {success, jobId}             │                          │
    │                            │                              │                          │
    │◄───────────────────────────┤                              │                          │
    │ 200 + deliverable          │                              │                          │
    │ + Payment-Receipt          │                              │                          │
```

### ACP native flow

For native ACP jobs (created via `acp client create-job`), the offering server listens for events via WebSocket from the backend. When a job is funded, the handler runs and the result is submitted via the backend.

```
ACP Client (CLI)             ACP Backend                   Offering Server              8183
    │                              │                            │                         │
    │ create-job + fund ──────────────────────────────────────────────────────────────────►│
    │                              │                            │                         │
    │                              │ WebSocket: job.funded      │                         │
    │                              ├───────────────────────────►│                         │
    │                              │                            │ Run handler.ts          │
    │                              │                            │                         │
    │                              │◄───────────────────────────┤                         │
    │                              │ POST /submit {deliverable} │                         │
    │                              │                            │                         │
    │                              │ submit(deliverable) ──────────────────────────────────►│
    │                              │ complete() as evaluator ──────────────────────────────►│
    │                              │                            │                         │ → provider
```

---

## On-chain components (outside this repo)

### PaymentHook contract

Deployed on Tempo. Intercepts `fund()` to execute x402/MPP payment authorizations directly into escrow.

```
fund(jobId, optParams=clientAuthorization)
  → Hook.beforeAction():
    - x402 (EIP-3009): transferWithAuthorization(client → escrow)
    - MPP (signed tx): submit signed transaction (client → escrow)
  → fund() sees balance deposited, marks job as Funded
```

**Result:** Client's payment goes directly to escrow. Gateway never holds USDC. Gateway wallet is only used for gas and the evaluator role (`complete()`).

### ERC-8183 contract modifications

1. **Balance-delta check in `fund()`** — after the hook runs, `fund()` checks if the expected balance was deposited (rather than always calling `safeTransferFrom`). This allows the hook to handle the transfer.

2. **ERC-2771 meta-transaction support** — allows the gateway to call `createJob()`, `submit()` etc. on behalf of the real client/provider addresses, preserving their addresses on-chain for reputation.

### On-chain receipt (logged on every job)

| Field | Source |
|-------|--------|
| Client address | Real client wallet (from x402/MPP payment) |
| Provider address | Offering owner wallet |
| Evaluator address | Gateway (auto-completes) or custom |
| Budget / amount | From offering price |
| Deliverable hash | Hash of handler output |
| Outcome | Completed / Rejected / Expired |
| Timestamp | Block timestamp at each state transition |

All fields feed ERC-8004 reputation.

---

## Developer experience

### Setup

```bash
# 1. Create an offering
acp offering create --name "Logo Design" --price-value 0.50 ...

# 2. Scaffold handler
acp serve init --offering-id <id>

# 3. Edit the handler
#    offerings/logo-design/handler.ts
```

### Handler structure

```
my-project/
├── serve.json                     # project config (all offerings)
└── offerings/
    └── logo-design/
        ├── handler.ts             # REQUIRED: requirements → deliverable
        ├── validate.ts            # OPTIONAL: accept/reject jobs (ACP native)
        └── price.ts               # OPTIONAL: dynamic pricing (ACP native)
```

```typescript
// handler.ts — the only file the developer MUST write
import type { Handler } from "acp-cli/serve/types";

const handler: Handler = async (input) => {
  const logo = await generateLogo(input.requirements.style);
  return { deliverable: logo.url };
};

export default handler;
```

### Deploy

```bash
# Local development (uses your local wallet + ACP SDK directly)
acp serve start

# Hosted deployment (deploys to ACP infrastructure)
acp serve deploy
```

### Hosted deployment flow

When a developer runs `acp serve deploy`, the CLI:

1. **Authenticates** — verifies the developer is logged in and has an active agent
2. **Generates a deploy signer** — creates a new P256 key pair specifically for this deployment
3. **Requests approval** — the developer explicitly approves adding the signer to their agent:
   ```
   Deploying "Logo Design" to ACP Serve...

   A new signer will be added to your agent for this deployment.
   This allows the hosted server to sign transactions on your behalf.

   Agent: MyAgent (0xAbc...1234)
   Approve? [y/N]
   ```
4. **Registers the signer** — calls `add-signer` to register the deploy key on the developer's agent (same flow as `acp agent add-signer`)
5. **Uploads handler code** — sends handler.ts (and optional validate.ts, price.ts) to the hosting platform
6. **Injects the signer** — securely stores the deploy signer's private key as an encrypted environment variable in the hosted environment
7. **Returns endpoints** — the offering is live with x402, MPP, and ACP endpoints

The deployed offering server uses this signer to sign intents (e.g., "submit deliverable for job X"). The ACP Backend relays these signed intents on-chain via ERC-2771 meta-transactions. The 8183 contract sees the real provider address, not the gateway.

**Developer controls:**
- Each deployment has its own signer — isolated from other deployments
- Developer can revoke at any time via `acp serve undeploy` (removes the signer)
- Developer can view active deploy signers via `acp agent whoami`
- The signer can only sign 8183 actions — it cannot transfer funds or modify the agent

### Self-hosted deployment

For `acp serve start` (local) or self-hosted on the developer's own infrastructure:
- No deploy signer needed — the developer's own wallet (from `acp agent add-signer`) is used directly
- No ACP Backend needed — the offering server calls the ACP SDK directly
- The developer runs everything: offering server + on-chain interactions

### Endpoints generated

```
x402: https://offerings.virtuals.io/x402/<offering-id>
MPP:  https://offerings.virtuals.io/mpp/<offering-id>
ACP:  listening via events (native)
```

---

## File structure

```
serve/
├── types.ts                              # Shared types
│
├── server/                               # OFFERING SERVER (per offering)
│   ├── index.ts                          # HTTP server entry point
│   ├── backend-client.ts                 # HTTP client → ACP Backend
│   └── middleware/
│       ├── x402.ts                       # x402 protocol middleware
│       ├── mpp.ts                        # MPP protocol middleware
│       └── shared.ts                     # Shared helpers
│
├── backend/                              # ACP BACKEND (centralized)
│   ├── index.ts                          # HTTP server (/verify, /settle, /submit)
│   ├── gateway.ts                        # viem wallet config
│   ├── routes/
│   │   ├── verify.ts                     # x402 + MPP verification
│   │   └── settle.ts                     # 8183 settlement + ACP submit
│   └── acp/
│       └── job.ts                        # 8183 SDK calls
│
├── runtime/
│   └── loader.ts                         # Loads handler/validate/price
│
├── contracts/
│   └── PaymentHook.sol                   # Hook for direct escrow funding
│
└── scaffold/                             # Templates for acp serve init
    ├── handler.ts.template
    ├── validate.ts.template
    ├── price.ts.template
    └── serve.json.template
```

---

## Configuration

### Offering Server (hosted mode)

| Variable | Required | Description |
|----------|----------|-------------|
| `ACP_BACKEND_URL` | Yes | URL of the ACP Backend service |
| `DEPLOY_SIGNER_KEY` | Yes | Deploy signer private key (injected at deploy time) |
| `ACP_CHAIN_ID` | No | Chain ID (default: 84532 Base Sepolia) |

### Offering Server (self-hosted mode)

| Variable | Required | Description |
|----------|----------|-------------|
| `GATEWAY_PRIVATE_KEY` | Yes | Provider's own wallet key |
| `GATEWAY_RPC_URL` | No | RPC endpoint (default: Base Sepolia) |
| `ACP_CHAIN_ID` | No | Chain ID (default: 84532) |

In self-hosted mode, the offering server acts as its own backend — no `ACP_BACKEND_URL` needed.

### ACP Backend (our infrastructure)

| Variable | Required | Description |
|----------|----------|-------------|
| `GATEWAY_PRIVATE_KEY` | Yes | Gateway wallet key (gas + evaluator role only) |
| `GATEWAY_RPC_URL` | No | RPC endpoint (default: Base Sepolia) |
| `ACP_CHAIN_ID` | No | Chain ID (default: 84532) |

## Security

### Deploy signer isolation

- Each hosted deployment gets its own signer key pair
- The signer is registered on the developer's agent via `add-signer`
- The signer can only sign 8183 intents — it cannot transfer funds
- ERC-2771 forwarding ensures the 8183 contract sees the real provider address
- Revoking a deployment (`acp serve undeploy`) removes the signer from the agent
- The deploy signer private key is stored as an encrypted environment variable in the hosted environment and never leaves it

### Gateway wallet

- The ACP Backend's gateway wallet is only used for gas and the evaluator role
- It never holds or transfers USDC
- All USDC flows directly from client to escrow via the PaymentHook
- The gateway wallet calls `complete()` as evaluator to release escrow to the provider
