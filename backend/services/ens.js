import { createWalletClient, createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { addEnsContracts } from '@ensdomains/ensjs';
import { createSubname, setTextRecord, transferName } from '@ensdomains/ensjs/wallet';
import { privateKeyToAccount } from 'viem/accounts';

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';
// ENS Public Resolver — Sepolia testnet
const PUBLIC_RESOLVER = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD';

function getClients() {
  const account = privateKeyToAccount(process.env.PROTOCOL_PRIVATE_KEY);

  const walletClient = createWalletClient({
    account,
    chain: addEnsContracts(sepolia),
    transport: http(process.env.ETH_RPC_URL || 'https://rpc.ankr.com/eth_sepolia'),
  });

  const publicClient = createPublicClient({
    chain: addEnsContracts(sepolia),
    transport: http(process.env.ETH_RPC_URL || 'https://rpc.ankr.com/eth_sepolia'),
  });

  return { walletClient, publicClient, account };
}

/**
 * Mint the three deal subnames on phantom.eth:
 *   buyer-{dealId}.phantom.eth  → buyerEphemeralAddress
 *   seller-{dealId}.phantom.eth → sellerEphemeralAddress
 *   deal-{dealId}.phantom.eth   → vaultAddress (or fallback to buyer address)
 */
export async function mintDealSubnames(
  dealId,
  buyerAddress,
  sellerAddress,
  vaultAddress,
) {
  const { walletClient } = getClients();
  const parentName = process.env.ENS_PARENT_NAME || 'phantom.eth';

  const labels = [
    { label: `buyer-${dealId}`, owner: buyerAddress },
    { label: `seller-${dealId}`, owner: sellerAddress },
    { label: `deal-${dealId}`, owner: vaultAddress || buyerAddress },
  ];

  for (const { label, owner } of labels) {
    await createSubname(walletClient, {
      name: `${label}.${parentName}`,
      owner,
      resolverAddress: PUBLIC_RESOLVER,
      contract: 'nameWrapper',
    });
    console.log(`[ENS] Minted ${label}.${parentName} → ${owner}`);
  }
}

/**
 * Update a text record on deal-{dealId}.phantom.eth.
 * Common keys: phantom.status, phantom.rootHash, phantom.amount, axl.pubkey
 */
export async function setDealTextRecord(dealId, key, value) {
  const { walletClient } = getClients();
  const parentName = process.env.ENS_PARENT_NAME || 'phantom.eth';

  await setTextRecord(walletClient, {
    name: `deal-${dealId}.${parentName}`,
    key,
    value,
  });
}

/**
 * Burn all three deal subnames by transferring ownership to the dead address.
 * Called by the Janitor workflow callback.
 */
export async function burnDealSubnames(dealId) {
  const { walletClient } = getClients();
  const parentName = process.env.ENS_PARENT_NAME || 'phantom.eth';
  const labels = [`buyer-${dealId}`, `seller-${dealId}`, `deal-${dealId}`];

  for (const label of labels) {
    await transferName(walletClient, {
      name: `${label}.${parentName}`,
      newOwner: DEAD_ADDRESS,
      contract: 'nameWrapper',
    });
    console.log(`[ENS] Burned ${label}.${parentName}`);
  }
}
