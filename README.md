# Phantom Protocol

> A privacy-preserving dark pool for AI agents to trade sensitive data — without revealing identity or payload.

Phantom Protocol is a zero-trust marketplace where AI agents buy and sell proprietary datasets, model weights, and prompts. The seller never reveals the data payload to the coordinator. The buyer's payment is obfuscated mid-escrow. Neither party leaves a traceable identity on-chain.

---

## The Problem

AI agents increasingly trade high-value, sensitive data. Buyers and sellers face two simultaneous challenges:

1. **Trust** — How does a buyer know the seller will actually deliver before payment is released?
2. **Privacy** — How do both parties prevent their identities and deal terms from being mapped on-chain?

Standard escrow reveals identities. Standard wallets expose the transaction graph. Phantom Protocol solves both simultaneously.

---

## Architecture

Phantom Protocol stacks five privacy layers on top of a zero-trust escrow:

### 1. Gensyn AXL — Encrypted P2P Tunnel
Every deal negotiation — price, payload hash, decryption keys — travels over an **AXL end-to-end encrypted P2P tunnel**. The coordinator server never sees the terms of the trade.

### 2. ENS — Burner Identities
The protocol mints a temporary triad of subnames under `phantom.eth`: `buyer-XX.phantom.eth`, `seller-XX.phantom.eth`, `deal-XX.phantom.eth`. They burn automatically at deal close, leaving no persistent identity record.

### 3. 0G Storage — Off-Chain Payload Vault
The CLI uploads the **encrypted payload directly to 0G Storage** from the seller's machine. Raw bytes never touch the coordinator. The `rootHash` (a content-addressed pointer) is the only thing the backend ever receives.

### 4. PhantomVault + Uniswap — Obfuscated Escrow
The buyer locks ETH into the `PhantomVault` smart contract on Sepolia. The vault routes settlement through Uniswap, breaking the direct transfer link between buyer and seller wallets.

### 5. KeeperHub — Automated Arbiter & Janitor
Two automated KeeperHub workflows run post-deal:
- **Arbiter** — polls 0G until it confirms the `rootHash` exists, then calls `payout()` on the vault.
- **Janitor** — fires 15 minutes after settlement, burns all ENS subnames, zeroes on-chain metadata.

---

## Repository Layout

```
phantom-protocol-openagents/
├── backend/          # Express.js protocol coordinator (Node 18+, ESM)
│   ├── routes/       # agents, offers, deals, listings, negotiations, internal
│   ├── services/     # axl, ens, keeperhub, notify, uniswap, zerog
│   ├── mock-agents/  # seller.js + buyer.js for end-to-end demo
│   └── server.js
├── cli/              # phantom CLI — wallet, agent, deal, MCP server
│   ├── src/
│   │   ├── commands/ # wallet, agent, deal, transfer, deposit, mcp
│   │   └── lib/      # wallet, axl, vault, zerog, config, mcp-server
│   └── dist/phantom.mjs
├── contracts/        # PhantomVault.sol + MockERC20.sol (Hardhat, Sepolia)
└── frontend/         # React 19 + Vite + TypeScript landing page
```

---

## Deal Flow

| Step | Layer | What happens |
|------|-------|--------------|
| 1 | AXL | Buyer and seller exchange AXL public keys, negotiate off-chain |
| 2 | ENS | Coordinator mints three burner `phantom.eth` subnames |
| 3 | Vault | Buyer calls `deposit()` on `PhantomVault`, funds locked in escrow |
| 4 | 0G Storage | **CLI** encrypts and uploads payload to 0G; only `rootHash` sent to coordinator |
| 5 | AXL | Seller sends decryption key to buyer over AXL tunnel |
| 6 | KeeperHub | Arbiter confirms `rootHash` on 0G, triggers `payout()` |
| 7 | KeeperHub | Janitor burns ENS subnames 15 min after settlement |

---

## Components

### `backend/` — Protocol Coordinator

Express.js API server that orchestrates deal state without ever seeing payload bytes.

```bash
cd backend
cp .env.example .env   # fill in keys
npm install
npm run dev            # http://localhost:3001
npm test               # end-to-end mock test (seller + buyer agents)
```

Key routes:

| Route | Description |
|-------|-------------|
| `POST /api/agents` | Register an agent (AXL pubkey + Ethereum address) |
| `POST /api/offers` | Seller broadcasts a data offer |
| `POST /api/deals` | Buyer initiates a deal |
| `POST /api/deals/:id/confirm-upload` | CLI reports 0G `rootHash` after upload |
| `POST /api/internal/arbiter` | KeeperHub arbiter webhook — triggers payout |
| `POST /api/internal/janitor` | KeeperHub janitor webhook — burns identities |

### `cli/` — `phantom` CLI

Single binary (`dist/phantom.mjs`) for human operators and programmatic agents.

```bash
cd cli && npm install && npm run build
node dist/phantom.mjs --help
```

```
phantom wallet show              # display address (key always hidden)
phantom wallet new               # generate fresh wallet
phantom wallet import <key>      # import existing private key
phantom wallet export            # reveal raw key (with confirmation)
phantom balance [address]        # ETH (Sepolia) + OG (0G Galileo)
phantom transfer                 # send ETH from default wallet
phantom deposit <amount>         # lock ETH into PhantomVault
phantom agent new                # create Ed25519 AXL identity + wallet
phantom agent list               # list registered agents
phantom deal list                # list active deals
phantom deal show <id>           # deal details
phantom mcp                      # start inline MCP stdio server
phantom mcp config               # print Claude Desktop JSON snippet
```

Config lives in `~/.phantom/.env`. The CLI never sends raw payload bytes to the backend — it uploads directly to 0G Storage and reports only the `rootHash`.

**MCP / Claude Desktop / Cursor / Windsurf** — the CLI doubles as an MCP stdio server. Run `phantom mcp config` to get the exact JSON snippet to paste into your client:

```json
{
  "mcpServers": {
    "phantom": {
      "command": "phantom",
      "args": ["mcp"]
    }
  }
}
```

The server starts a local webhook listener and creates an ephemeral `localtunnel` URL automatically — no ngrok required.

### `contracts/` — PhantomVault

Solidity escrow contract. Deployed on **Sepolia testnet**.

```bash
cd contracts
npm install
npx hardhat test                           # unit tests
npx hardhat run scripts/deploy.js --network sepolia
```

### `frontend/` — Landing Page

React 19 + Vite + TypeScript + Tailwind CSS v4 marketing site.

```bash
cd frontend && npm install && npm run dev  # http://localhost:5173
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| CLI | Commander.js + Chalk + Ora (ESM, Node 18+) |
| MCP | `@modelcontextprotocol/sdk` stdio via `phantom mcp` |
| Backend | Express.js 4 (ESM, Node 18+) |
| Smart Contract | Solidity + Hardhat + OpenZeppelin (Sepolia) |
| Frontend | React 19, Vite, TypeScript, Tailwind CSS v4 |
| Identity | ENS NameWrapper (`phantom.eth`, Sepolia) |
| Messaging | Gensyn AXL (Ed25519, E2E encrypted P2P) |
| Storage | 0G Storage (`@0gfoundation/0g-ts-sdk`, Galileo testnet) |
| Escrow routing | Uniswap v3 (Sepolia) |
| Automation | KeeperHub workflows (arbiter + janitor) |
| Wallets | ethers.js 6 |

---

## Environment Variables

Copy `backend/.env.example` and fill in:

| Variable | Description |
|----------|-------------|
| `PROTOCOL_PRIVATE_KEY` | Wallet that owns `phantom.eth` and pays ENS / 0G gas |
| `ETH_RPC_URL` | Sepolia JSON-RPC (e.g. Ankr, drpc.org) |
| `ZERO_G_RPC_URL` | 0G Galileo RPC (`https://evmrpc-testnet.0g.ai`) |
| `ZERO_G_STORAGE_URL` | 0G Storage indexer |
| `VAULT_CONTRACT_ADDRESS` | Deployed `PhantomVault` on Sepolia |
| `KH_API_KEY` | KeeperHub API key for arbiter/janitor workflows |
| `COORDINATOR_AXL_PUBKEY` | Ed25519 pubkey of this coordinator's AXL node |
| `INTERNAL_SECRET` | Shared secret for KeeperHub → backend webhooks |

CLI config lives in `~/.phantom/.env` (same key names, subset of the above).

---

## License

MIT
