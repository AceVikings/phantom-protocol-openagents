/**
 * PhantomVault interaction — lock ETH in escrow for a deal.
 */
import { ethers } from 'ethers'
import { getVaultAddress, getRpcUrl } from './config.js'

const VAULT_ABI = [
  'function deposit(bytes32 dealKey, address seller, uint256 lockDuration) external payable',
  'function deals(bytes32) external view returns (address buyer, address seller, uint256 amount, uint8 status, uint256 lockedAt, uint256 expiresAt)',
] as const

export async function lockFundsInVault(args: {
  dealId:        string
  sellerAddress: string
  amountEth:     number
  privateKey:    string
  rpcUrl?:       string
  vaultAddress?: string
}): Promise<{ txHash: string }> {
  const rpcUrl    = args.rpcUrl       ?? getRpcUrl()
  const vaultAddr = args.vaultAddress ?? getVaultAddress()

  if (!vaultAddr) {
    throw new Error(
      'VAULT_CONTRACT_ADDRESS not configured. ' +
      'Set it in ~/.phantom/.env after deploying the contract.',
    )
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const signer   = new ethers.Wallet(args.privateKey, provider)
  const vault    = new ethers.Contract(vaultAddr, VAULT_ABI, signer)

  const amount   = ethers.parseEther(String(args.amountEth))
  const dealKey  = ethers.keccak256(ethers.toUtf8Bytes(args.dealId))

  const LOCK_DURATION = 3600 // 1 hour
  const tx      = await vault.deposit(dealKey, args.sellerAddress, LOCK_DURATION, { value: amount })
  const receipt = await tx.wait()
  if (!receipt) throw new Error('Transaction receipt is null — chain may be congested')
  return { txHash: receipt.hash }
}

export async function transferEth(args: {
  to:         string
  amountEth:  string
  privateKey: string
  rpcUrl?:    string
}): Promise<{ txHash: string }> {
  const provider = new ethers.JsonRpcProvider(args.rpcUrl ?? getRpcUrl())
  const signer   = new ethers.Wallet(args.privateKey, provider)
  const tx       = await signer.sendTransaction({
    to:    args.to,
    value: ethers.parseEther(args.amountEth),
  })
  const receipt = await tx.wait()
  if (!receipt) throw new Error('No receipt')
  return { txHash: receipt.hash }
}


