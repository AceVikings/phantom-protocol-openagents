# Phantom Protocol: The Anonymized Zero-Trust Agent Marketplace

_(A combination of SecurAgent & GhostWriter)_

**Tagline:** Trade sensitive AI models, datasets, and prompts without revealing your identity or the data payload itself. An end-to-end encrypted, zero-trust dark pool for the agentic web.

---

### The Vision

Combining **SecurAgent (Zero-Trust Escrow)** with **GhostWriter (Anonymized Privacy Middleware)** creates the ultimate B2B (Bot-to-Bot) marketplace.

Agents frequently trade highly sensitive data—like proprietary trading algorithms, raw user datasets, or custom fine-tuned weights. Buyers and sellers don't trust each other to deliver, nor do they want public block explorers mapping their financial identity to the data they bought. **Phantom Protocol** solves both problems simultaneously: ensuring the data is delivered before payment is released, while wiping the identities of both parties the moment the deal closes.

---

### The "Double-Dip" Sponsor Architecture

This combination perfectly hits the highest-value prize categories of all 5 sponsors by stacking privacy features on top of execution features.

#### 1. ENS: The "Burner Vaults" (Track 1 & 2 Winner)

- **The Idea:** Instead of interacting via `alice.eth` and `bob.eth`, the protocol programmatically spins up a temporary triad of names: `buyer-92.phantom.eth`, `seller-44.phantom.eth`, and `deal-vault.phantom.eth`.
- **Why it Wins:** ENS specifically asked for "uses beyond standard name resolution" and "auto-rotating addresses" in their Most Creative Use category. This literal "burner address" identity hits that perfectly.

#### 2. Gensyn AXL: The P2P Dark Tunnel (Privacy-Preserving Swarm Winner)

- **The Idea:** The negotiation (price, file size, decryption keys) happens negotiated via an AXL E2E encrypted P2P tunnel. No central marketplace server ever sees the data being sold or the terms of the deal.
- **Why it Wins:** AXL's core mission is secure, trustless agent communication. This makes AXL the backbone of the entire trade negotiation.

#### 3. 0G Storage & Compute: The "Whisper Box"

- **The Idea:** The seller uploads the encrypted dataset to **0G Storage**. But here's the twist: it's not meant to be permanent. A **0G Compute** inference task verifies the file structure/metadata hashes without exposing the plaintext data to validators.
- **Why it Wins:** It leverages both halves of 0G (Compute for verification, Storage for the encrypted payload delivery).

#### 4. Uniswap: The Obfuscated Payout

- **The Idea:** A buyer deposits 1,000 USDC into the `deal-vault.phantom.eth`. But the seller requested ETH. Rather than doing a simple transfer, the vault uses Uniswap's Swap API to convert the funds inside the escrow contract.
- **Why it Wins:** This obscures the transaction trail. Chain-analysis tools looking for a "1,000 USDC transfer" won't find a corresponding 1,000 USDC receipt for the seller, adding a layer of financial privacy.

#### 5. KeeperHub: The Arbiter & The Janitor (Best Use Winner)

- **The Idea:** KeeperHub runs a two-part workflow:
  1.  **The Arbiter:** It constantly monitors 0G for the uploaded `rootHash`. Once verified, it executes the smart contract `payout()`.
  2.  **The Janitor:** Exactly 15 minutes after the deal settles, KeeperHub triggers the "Self-Destruct Sequence"—wiping the metadata pointers from 0G and burning the temporary ENS subnames.
- **Why it Wins:** KeeperHub acts as the reliable execution engine for both the financial settlement (escrow) and the privacy cleanup (cron job).

---

### Step-by-Step User Flow

1.  **The Matchmaking (AXL):** Agent A wants to buy an AI prompt database from Agent B. They connect directly via their AXL public keys, completely off-chain.
2.  **The Masking (ENS):** The Phantom Protocol mints `buyer-xyz.phantom.eth` and `deal-vault.phantom.eth`.
3.  **The Lock (Uniswap):** Agent A deposits funds into the deal vault. The vault executes a Uniswap route to obfuscate the origin token into the destination token (e.g., MATIC to WETH).
4.  **The Delivery (0G):** Agent B encrypts the database and uploads it to 0G Storage, sharing the decryption key exclusively over the AXL tunnel.
5.  **The Verification (0G Compute):** (Optional) An auditor agent runs inference on 0G to confirm the uploaded file matches the byte-size/hash criteria agreed upon.
6.  **The Settlement (KeeperHub Arbiter):** KeeperHub detects the 0G `rootHash` on-chain and triggers the payout script on the vault contract.
7.  **The Vanishing (KeeperHub Janitor):** 15 minutes later, KeeperHub automatically runs a cleanup transaction: it burns the ENS subnames and zeroes out the on-chain metadata records. Neither party leaves a permanent public trace of the transaction.
