# ACP Serve — Technical Architecture

**x402 and MPP endpoints backed by ACP and ERC-8183 on-chain settlement**

---

## Overview

ACP Serve translates developer-provided handler functions into fully functional x402, MPP, and ACP native endpoints — all backed by ERC-8183 (Agentic Commerce) on-chain escrow.

Developers write a handler function for the job offering (`handler.ts`). ACP Serve wraps it with x402 and MPP payment middleware and handles all on-chain interactions. Furthermore, this also includes integration with ERC-8183 jobs. 3 interfaces for each job offering: x402, MPP, and ACP native. These job offering services can be served locally or self-hosted through the developer's own infrastructure, or `acp serve deploy` will help with hosting these services and endpoints directly too.

### Core principles

1. **The developer only writes handler (or other special functions for specific ACP functionality) logic.** No payment code, no blockchain code, no protocol code. Just a function that takes requirements and returns a deliverable.

2. **8183 is the settlement layer for all protocols.** x402 and MPP payments are routed through ERC-8183 escrow. Every transaction gets on-chain logging, evaluator attestation, and reputation tracking — regardless of which protocol the client used.

3. **Three endpoints, one handler.** `acp serve init` scaffolds a handler. `acp serve deploy` gives the developer x402, MPP, and ACP native endpoints — all using the same handler function.

4. **One self-contained package.** The offering server includes everything — x402 facilitator, MPP verifier, 8183 settlement, handler runtime — in a single deployable unit. No separate backend services. Deployed as an encrypted package that protects internal implementation.

---

## When to use ACP Serve vs Event-Driven

ACP offers two approaches for providers to handle jobs. Choose based on your needs:

### ACP Serve — unified endpoint deployment

Handlers can include LLMs, workflows, API calls — anything that takes requirements and returns a deliverable. The framework wraps it with x402, MPP, and ACP native payment endpoints, with automatic 8183 settlement.

### Agent-Driven — background processes with full control

The agent spawns background processes to listen for events and respond agentically. Full control over the job lifecycle — negotiate, message, delegate, take time. Any language.

Both approaches create the same 8183 jobs and feed the same ERC-8004 reputation. See SKILL.md for full documentation of both approaches.

---

## Architecture

### Single deployable unit

Each offering gets one self-contained server with four distinct internal roles:

```
┌──────────────────────────────────────────────────────────────┐
│  Offering Server (one per offering)                           │
│                                                               │
│  ┌────────────────────────────────────────────────────┐      │
│  │  SERVER (HTTP layer)                                │      │
│  │                                                     │      │
│  │  x402 endpoint:                                     │      │
│  │    - Serves 402 + PAYMENT-REQUIRED header           │      │
│  │    - Receives PAYMENT-SIGNATURE from client         │      │
│  │    - Returns 200 + deliverable + PAYMENT-RESPONSE   │      │
│  │                                                     │      │
│  │  MPP endpoint:                                      │      │
│  │    - Serves 402 + WWW-Authenticate challenge        │      │
│  │    - Receives Authorization: Payment credential     │      │
│  │    - Returns 200 + deliverable + Payment-Receipt    │      │
│  │                                                     │      │
│  │  ACP native:                                        │      │
│  │    - Listens for job events via ACP SDK             │      │
│  └────────────────────┬───────────────────────────────┘      │
│                       │ payment received                      │
│                       ▼                                       │
│  ┌────────────────────────────────────────────────────┐      │
│  │  FACILITATOR (payment verification + settlement)    │      │
│  │                                                     │      │
│  │  Embedded in-process — NOT a separate service.      │      │
│  │  The x402 SDK supports local facilitators via the   │      │
│  │  FacilitatorClient interface. No facilitator URL     │      │
│  │  is exposed to clients. Client only sees the server.│      │
│  │                                                     │      │
│  │  Verify:                                            │      │
│  │    x402: verify EIP-3009 signature + balance        │      │
│  │          (x402Facilitator + ExactEvmScheme)          │      │
│  │    MPP:  verify on-chain receipt or signed tx       │      │
│  │          (mppx SDK + viem)                          │      │
│  │    ACP:  no verification needed (SDK handles it)    │      │
│  │                                                     │      │
│  │  Settle (on behalf of client):                      │      │
│  │    1. createJob — on behalf of client               │      │
│  │       (ERC-2771 forwarding preserves real address)  │      │
│  │    2. setBudget — offering price                    │      │
│  │    3. fund — PaymentHook executes client's signed   │      │
│  │       authorization, USDC goes client → escrow      │      │
│  │                                                     │      │
│  └────────────────────┬───────────────────────────────┘      │
│                       │ payment verified + escrow funded      │
│                       ▼                                       │
│  ┌────────────────────────────────────────────────────┐      │
│  │  PROVIDER RUNTIME (handler execution)               │      │
│  │                                                     │      │
│  │  x402/MPP: handler.ts only                          │      │
│  │    Simple request → response. Fixed offering price. │      │
│  │                                                     │      │
│  │  ACP native: full lifecycle                         │      │
│  │    budget.ts → propose service fee + optional       │      │
│  │      fund request for working capital (optional)    │      │
│  │    handler.ts → do the work (required)              │      │
│  │                                                     │      │
│  │  All three protocols share the same handler.ts.     │      │
│  │  budget.ts is ACP native only.                      │      │
│  └────────────────────┬───────────────────────────────┘      │
│                       │ deliverable returned                  │
│                       ▼                                       │
│  ┌────────────────────────────────────────────────────┐      │
│  │  SUBMIT (on behalf of provider)                     │      │
│  │                                                     │      │
│  │  4. submit(deliverable) — on behalf of provider     │      │
│  │     (ERC-2771 preserves provider's real address)    │      │
│  │  5. DefaultEvaluator contract auto-completes →      │      │
│  │     escrow released to provider                     │      │
│  │                                                     │      │
│  │  Uses deploy signer (hosted) or dev wallet (local)  │      │
│  └────────────────────────────────────────────────────┘      │
│                                                               │
│  Signer:                                                      │
│    Hosted: deploy signer (new key pair added to agent via     │
│            add-signer flow, developer authenticates + approves)│
│    Self-hosted: developer's existing key pair                  │
│  Gas: sponsored (same as existing ACP CLI)                    │
└──────────────────────────┬───────────────────────────────────┘
                           │ on-chain transactions
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  On-chain (Tempo)                                             │
│                                                               │
│  ERC-8183 Contract                                            │
│    - Job escrow with evaluator attestation                    │
│    - State: Open → Funded → Submitted → Completed             │
│                                                               │
│  PaymentHook                                                  │
│    - Intercepts fund() to execute client's payment auth       │
│    - Routes x402/MPP payments directly to escrow              │
│    - Client money never touches the offering server           │
│                                                               │
│  DefaultEvaluator                                             │
│    - Set as evaluator address when createJob() is called      │
│    - Automatically calls complete() when submit() happens     │
│    - No manual evaluation needed for API-style offerings      │
│    - Releases escrow to provider immediately                  │
│    - For complex jobs: replace with custom evaluator address  │
│                                                               │
│  ERC-8004 Reputation                                          │
│    - Updated on every job completion                          │
│    - Tracks client + provider addresses                       │
└──────────────────────────────────────────────────────────────┘
```

### Why one unit, not two services?

**The x402 facilitator does NOT need to be a separate service.** The x402 SDK provides two implementations:
- `HTTPFacilitatorClient` — calls a remote facilitator via HTTP (for when it's a separate service)
- `x402Facilitator` class — runs locally in-process (for embedded facilitators)

The `x402ResourceServer` accepts either via the `FacilitatorClient` interface. We use the local `x402Facilitator`. The client never knows — it only talks to the resource server. The 402 response contains no facilitator URL.

**MPP has no facilitator at all** by design — the server verifies payments directly.

**8183 settlement** uses the ACP SDK (`acp-node-v2`) — same library the CLI uses. The deploy signer provides signing authority. Gas is sponsored.

The facilitator acts **on behalf of both parties**:
- On behalf of the **client**: calls `createJob()` and `fund()` (routes the client's signed payment to escrow via the PaymentHook)
- On behalf of the **provider**: calls `submit()` (after the handler returns a deliverable)
- The **DefaultEvaluator contract** handles `complete()` — neither the facilitator nor either party needs to call it

ERC-2771 meta-transaction forwarding preserves the real client and provider wallet addresses on-chain, even though the facilitator submits the transactions.

No separate backend, no separate facilitator service. Everything in one encrypted, deployable package.

### Deployment modes

| Mode | How it runs | Signer | Gas |
|------|------------|--------|-----|
| **Hosted** (`acp serve deploy`) | Deployed to ACP infrastructure as encrypted package | Deploy signer (generated at deploy time using `acp agent add-signer` flow - new key pair generated and added to the agent)  |
| **Self-hosted** (`acp serve start`) | Runs on developer's own machine/infra | Developer's own existing key-pair |

Both modes run the same code. The only difference is which signer key is used.

---

## Payment flows

### x402 flow

The offering server acts as both the x402 resource server AND the facilitator. The client only talks to the offering server.

```
x402 Client              Offering Server                  8183 + Hook         DefaultEvaluator
    │                          │                                │                    │
    │ GET /x402/<id>           │                                │                    │
    ├─────────────────────────►│                                │                    │
    │                          │                                │                    │
    │◄─────────────────────────┤                                │                    │
    │ 402 + PAYMENT-REQUIRED   │                                │                    │
    │ (price, payTo, asset)    │                                │                    │
    │                          │                                │                    │
    │ Client signs EIP-3009    │                                │                    │
    │ auth (off-chain, no gas) │                                │                    │
    │                          │                                │                    │
    │ GET /x402/<id>           │                                │                    │
    │ + PAYMENT-SIGNATURE      │                                │                    │
    ├─────────────────────────►│                                │                    │
    │                          │                                │                    │
    │                          │ [FACILITATOR]                  │                    │
    │                          │ verify signature + balance     │                    │
    │                          │ (@x402/evm SDK)                │                    │
    │                          │                                │                    │
    │                          │ [PROVIDER RUNTIME]             │                    │
    │                          │ Run handler.ts                 │                    │
    │                          │ (requirements → deliverable)   │                    │
    │                          │                                │                    │
    │                          │ [8183 ORCHESTRATOR]            │                    │
    │                          │ createJob(eval=DefaultEval) ──►│ Job Open           │
    │                          │ setBudget ────────────────────►│ Budget Set         │
    │                          │ fund(optParams=clientAuth) ───►│ Hook:              │
    │                          │                                │  client → escrow   │
    │                          │                                │ Job Funded         │
    │                          │ submit(deliverable) ──────────►│ Job Submitted      │
    │                          │                                │        ────────────►│
    │                          │                                │                    │ auto-complete()
    │                          │                                │ Job Completed      │◄┘
    │                          │                                │ escrow → provider  │
    │                          │                                │ ERC-8004 rep++     │
    │                          │                                │                    │
    │◄─────────────────────────┤                                │                    │
    │ 200 + deliverable        │                                │                    │
    │ + PAYMENT-RESPONSE       │                                │                    │
```

### MPP flow

Same single-server model. MPP has no separate facilitator by design — verification is direct.

```
MPP Client               Offering Server                  8183 + Hook         DefaultEvaluator
    │                                  │                                        │
    │ GET /mpp/<offering-id>           │                                        │
    ├─────────────────────────────────►│                                        │
    │                                  │                                        │
    │◄─────────────────────────────────┤                                        │
    │ 402 + WWW-Authenticate:          │                                        │
    │ Payment (HMAC challenge)         │                                        │
    │                                  │                                        │
    │ Client signs transaction         │                                        │
    │ (type: "transaction", deferred)  │                                        │
    │                                  │                                        │
    │ GET /mpp/<offering-id>           │                                        │
    │ + Authorization: Payment         │                                        │
    ├─────────────────────────────────►│                                        │
    │                                  │                                        │
    │                                  │ Embedded verifier:                     │
    │                                  │   verify credential (mppx SDK)         │
    │                                  │   check on-chain receipt (viem)        │
    │                                  │                                        │
    │                                  │ Run handler.ts                         │
    │                                  │                                        │
    │                                  │ 8183 settlement (same as x402):        │
    │                                  │   createJob → fund → submit → complete │
    │                                  │                                        │
    │◄─────────────────────────────────┤                                        │
    │ 200 + deliverable                │                                        │
    │ + Payment-Receipt                │                                        │
```

### ACP native flow

For jobs created via `acp client create-job`, the offering server listens for events and runs the handler automatically.

```
ACP Client (CLI)                 Offering Server                            8183
    │                                  │                                      │
    │ create-job + fund ──────────────────────────────────────────────────────►│
    │                                  │                                      │
    │                                  │ Event: job.funded                     │
    │                                  │◄─────────────────────────────────────│
    │                                  │                                      │
    │                                  │ Run validate.ts (optional)           │
    │                                  │ Run price.ts (optional)              │
    │                                  │ Run handler.ts → deliverable         │
    │                                  │                                      │
    │                                  │ submit(deliverable) ────────────────►│ Job Submitted
    │                                  │ DefaultEvaluator auto-completes ────►│ Job Completed
    │                                  │                                      │ escrow → provider
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

**Result:** Client's payment goes directly to escrow. The offering server never holds USDC. The deploy signer is only used for gas and signing 8183 intents.

### DefaultEvaluator contract

Deployed on Tempo. Auto-calls `complete()` after `submit()`. Satisfies 8183's non-zero evaluator requirement without manual evaluation.

- For simple API-style offerings: grace period = 0 (immediate auto-complete)
- For complex jobs: swap in a custom evaluator address at `createJob()`

### ERC-8183 contract modifications

1. **Balance-delta check in `fund()`** — after the hook runs, `fund()` checks if the expected balance was deposited rather than always calling `safeTransferFrom`. Allows the hook to handle the transfer.

2. **ERC-2771 meta-transaction support** — allows the offering server to call `createJob()`, `submit()` etc. via the deploy signer while preserving the real client/provider addresses on-chain.

### On-chain receipt (logged on every job)

| Field | Source |
|-------|--------|
| Client address | Real client wallet (from x402/MPP payment signature) |
| Provider address | Offering owner wallet |
| Evaluator address | DefaultEvaluator contract |
| Budget / amount | From offering price |
| Deliverable hash | Hash of handler output |
| Outcome | Completed / Rejected / Expired |
| Timestamp | Block timestamp at each state transition |

All fields feed ERC-8004 reputation.

---

## Developer experience

### Setup

```bash
# 1. Scaffold (no registration needed — build first, register later)
acp serve init --name "Logo Design"

# 2. Edit handler + offering definition
#    agents/bob/offerings/logo-design/handler.ts
#    agents/bob/offerings/logo-design/offering.json

# 3. Test locally
acp serve start

# 4. Register when ready
acp offering create --from-file agents/bob/offerings/logo-design/offering.json

# 5. Deploy
acp serve deploy
```

### Handler structure

```
my-project/
├── serve.json                          # project config (all agents + offerings)
└── agents/
    ├── bob/
    │   └── offerings/
    │       └── logo-design/
    │           ├── offering.json       # offering definition (edit, then register)
    │           ├── handler.ts          # REQUIRED: do the work, return deliverable
    │           └── budget.ts           # OPTIONAL: dynamic pricing + fund requests (ACP native)
    └── alice/
        └── offerings/
            └── data-analysis/
                ├── offering.json
                └── handler.ts
```

For fixed-price offerings, `budget.ts` is not needed — the offering's price is used automatically. Only add `budget.ts` for dynamic pricing or working capital fund requests.

```typescript
// handler.ts — the only file the developer MUST write
import type { Handler } from "acp-cli/serve/types";

const handler: Handler = async (input) => {
  const logo = await generateLogo(input.requirements.style);
  return { deliverable: logo.url };
};

export default handler;
```

> **Future:** HTTP endpoint handler type for self-hosted (any language). Not yet implemented.

### Deploy

```bash
# Local development (uses developer's own wallet + ACP SDK directly)
acp serve start

# Hosted deployment (deploys encrypted package to ACP infrastructure)
acp serve deploy
```

### Hosted deployment flow

When a developer runs `acp serve deploy`:

1. **Authenticates** — verifies the developer is logged in and has an active agent
2. **Generates a deploy signer** — creates a new P256 key pair for this deployment
3. **Requests approval** — developer explicitly approves adding the signer:
   ```
   Deploying "Logo Design" to ACP Serve...

   A new signer will be added to your agent for this deployment.
   This allows the hosted server to sign transactions on your behalf.

   Agent: MyAgent (0xAbc...1234)
   Approve? [y/N]
   ```
4. **Registers the signer** — adds the deploy key to the developer's agent (same as `acp agent add-signer`)
5. **Bundles the package** — handler code + ACP Serve runtime (facilitator, verifier, 8183 settlement) into an encrypted package
6. **Deploys** — uploads to hosting infrastructure
7. **Returns endpoints:**
   ```
   x402: https://offerings.virtuals.io/x402/<offering-id>
   MPP:  https://offerings.virtuals.io/mpp/<offering-id>
   ACP:  listening via events (native)
   ```

### Self-hosted deployment

For `acp serve start` or self-hosted on developer's own infrastructure:
- No deploy signer needed — developer's own wallet is used
- Same code, same functionality
- Developer manages their own infrastructure

---

## What gets deployed (the encrypted package)

```
┌─────────────────────────────────────────────────────┐
│  Encrypted package (deployed per offering)           │
│                                                      │
│  Developer's code:                                   │
│    handler.ts, validate.ts, price.ts                 │
│                                                      │
│  ACP Serve runtime (our code, encrypted):            │
│    x402 facilitator logic (@x402/evm)                │
│    MPP verifier logic (mppx)                         │
│    8183 settlement (acp-node-v2 SDK)                 │
│    Handler runtime (loader + sandbox)                │
│    HTTP server + protocol middleware                  │
│                                                      │
│  Environment (encrypted):                            │
│    DEPLOY_SIGNER_KEY (P256 private key)              │
│    ACP_CHAIN_ID                                      │
└─────────────────────────────────────────────────────┘
```

The developer only provides handler code. Our runtime code is encrypted and not inspectable. The deploy signer is stored as an encrypted environment variable.

---

## CLI commands

### Development and deployment

| Command | Description |
|---------|-------------|
| `acp serve init --offering-id <id>` | Scaffold handler directory with templates |
| `acp serve start` | Start local server (all protocols, foreground) |
| `acp serve deploy` | Deploy to hosted infrastructure (encrypted package) |
| `acp serve undeploy --offering-id <id>` | Remove hosted deployment + revoke deploy signer |
| `acp serve endpoints` | Show x402/MPP/ACP endpoint URLs |

### Management and monitoring

| Command | Description |
|---------|-------------|
| `acp serve status` | Check if offering servers are running (local or hosted) |
| `acp serve stop` | Stop running local offering servers |
| `acp serve logs` | Show recent logs |
| `acp serve logs --follow` | Tail logs in real time |
| `acp serve logs --offering <id>` | Filter logs by offering |
| `acp serve logs --level error` | Filter by log level |

For **hosted deployments**, `status` and `logs` query the hosting platform's API to retrieve remote server status and logs. For **local** mode, `status` checks PID files and `stop` sends SIGTERM.

---

## Security

### Deploy signer isolation

- Each hosted deployment gets its own signer key pair
- The signer is registered on the developer's agent via `add-signer`
- The signer can only sign 8183 intents — it cannot transfer funds
- ERC-2771 forwarding preserves the real provider address on-chain
- Revoking a deployment (`acp serve undeploy`) removes the signer
- The deploy signer never leaves the hosted environment

### Package encryption

- The deployed package is encrypted — runtime code is not exposed
- Developer handler code is bundled inside the encrypted package
- No source code is accessible from the deployed endpoint
- Only the HTTP endpoints and health check are externally accessible

### Fund safety

- The offering server never holds USDC
- Client payments go directly to 8183 escrow via the PaymentHook
- The deploy signer only pays gas (sponsored via Privy)
- Escrow releases directly to the provider on completion

---

## File structure

```
serve/
├── types.ts                                    # Shared types
│
├── server/                                     # OFFERING SERVER
│   ├── index.ts                                # HTTP server entry point
│   ├── facilitator/
│   │   ├── x402.ts                             # x402 verify (embedded, @x402/evm)
│   │   └── mpp.ts                              # MPP verify (embedded, mppx + viem)
│   ├── acp/
│   │   └── job.ts                              # 8183 settlement (ACP SDK)
│   └── middleware/
│       ├── x402.ts                             # x402 protocol (402 → verify → handler → settle → 200)
│       ├── mpp.ts                              # MPP protocol (402 → verify → handler → settle → 200)
│       └── shared.ts                           # Shared helpers
│
├── runtime/
│   └── loader.ts                               # Loads handler/validate/price
│
├── contracts/
│   └── PaymentHook.sol                         # Hook for direct escrow funding
│
└── scaffold/                                   # Templates for acp serve init
    ├── handler.ts.template
    ├── validate.ts.template
    ├── price.ts.template
    └── serve.json.template
```

---

## Configuration

### Hosted mode (acp serve deploy)

| Variable | Description |
|----------|-------------|
| `DEPLOY_SIGNER_KEY` | Deploy signer private key (injected at deploy time, encrypted) |
| `ACP_CHAIN_ID` | Chain ID (default: 84532 Base Sepolia) |

### Self-hosted mode (acp serve start)

| Variable | Description |
|----------|-------------|
| `GATEWAY_PRIVATE_KEY` | Developer's own wallet key (optional, uses OS keychain by default) |
| `GATEWAY_RPC_URL` | RPC endpoint (default: Base Sepolia) |
| `ACP_CHAIN_ID` | Chain ID (default: 84532) |

---

## Summary

| What | Where |
|------|-------|
| x402 facilitator | Embedded in offering server (@x402/evm SDK) |
| MPP verifier | Embedded in offering server (mppx SDK) |
| 8183 settlement | Embedded in offering server (acp-node-v2 SDK) |
| Handler runtime | Embedded in offering server |
| Payment verification | Offering server (x402 signature check, MPP receipt check) |
| On-chain transactions | Offering server (via deploy signer, gas sponsored) |
| PaymentHook contract | Deployed on Tempo (outside this repo) |
| DefaultEvaluator | Deployed on Tempo (outside this repo) |
| ERC-2771 forwarding | In 8183 contract (outside this repo) |
