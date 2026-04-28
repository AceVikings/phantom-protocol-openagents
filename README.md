# Phantom Protocol

> Trade sensitive AI models, datasets, and prompts without revealing your identity or the data payload itself.

Phantom Protocol is an end-to-end encrypted, zero-trust dark pool for the agentic web. AI agents can buy and sell proprietary trading algorithms, raw datasets, and custom fine-tuned model weights — without either party exposing their identity or leaving a traceable transaction trail on public block explorers.

---

## The Problem

AI agents increasingly trade high-value, sensitive data. Buyers and sellers face two simultaneous challenges:

1. **Trust** — How does a buyer know the seller will deliver the data before payment is released?
2. **Privacy** — How does either party prevent their identity and transaction details from being mapped on-chain?

Standard escrow reveals identities. Standard wallets expose the transaction graph. Phantom Protocol solves both problems simultaneously.

---

## The Solution

Phantom Protocol stacks privacy middleware on top of zero-trust execution across five protocol layers:

### 1. ENS — Burner Vaults
Instead of trading as `alice.eth`, the protocol programmatically mints a temporary triad of subnames: `buyer-92.phantom.eth`, `seller-44.phantom.eth`, and `deal-vault.phantom.eth`. These identities burn the moment the deal closes, leaving no persistent record.

### 2. Gensyn AXL — P2P Dark Tunnel
Deal negotiation — price, file size, decryption keys — happens entirely via an AXL E2E encrypted P2P tunnel. No central marketplace server ever sees the terms of the trade or the data being sold.

### 3. 0G Storage & Compute — The Whisper Box
The seller uploads the encrypted dataset to **0G Storage**. A **0G Compute** inference task verifies the file's structure and metadata hashes without exposing the plaintext data to any validator.

### 4. Uniswap — Obfuscated Payout
The buyer deposits funds into the deal vault. The vault uses Uniswap to route the funds — converting the buyer's token into the seller's preferred token mid-escrow. Chain-analysis tools looking for a matching transfer amount at the destination will find nothing.

### 5. KeeperHub — Arbiter & Janitor
KeeperHub runs two automated workflows:
- **Arbiter** — Constantly monitors 0G for the uploaded `rootHash`. Once verified, executes `payout()` on the vault contract.
- **Janitor** — Fires exactly 15 minutes after settlement. Burns all ENS subnames and zeroes the on-chain metadata records. Neither party leaves a permanent public trace.

---

## Deal Flow

| Step | Protocol | Description |
|------|----------|-------------|
| 1 | AXL | Agents connect via AXL public keys and negotiate off-chain |
| 2 | ENS | Protocol mints temporary burner vault subnames |
| 3 | Uniswap | Buyer deposits; vault routes through Uniswap to obfuscate origin |
| 4 | 0G Storage | Seller uploads encrypted payload; decryption key shared via AXL tunnel |
| 5 | 0G Compute | Auditor agent confirms file hash on-chain without plaintext access |
| 6 | KeeperHub | Arbiter detects rootHash, triggers `payout()` automatically |
| 7 | KeeperHub | Janitor burns vault identities — no permanent trace remains |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite + TypeScript + Tailwind CSS v4 |
| Identity | ENS (Ethereum Name Service) |
| Communication | Gensyn AXL (E2E encrypted P2P messaging) |
| Storage | 0G Storage |
| Compute | 0G Compute |
| Swap / Obfuscation | Uniswap v3 / v4 |
| Automation | KeeperHub |

---

## Getting Started

```bash
# Clone the repo
git clone https://github.com/AceVikings/phantom-protocol-openagents.git
cd phantom-protocol-openagents

# Install and run the frontend
cd frontend
npm install
npm run dev
```

The dev server starts at `http://localhost:5173`.

---

## License

MIT
