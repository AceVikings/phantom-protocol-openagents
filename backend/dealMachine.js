export const DealStatus = {
  MATCHMAKING: 'MATCHMAKING',
  MINTING: 'MINTING',
  LOCKING: 'LOCKING',
  UPLOADING: 'UPLOADING',
  VERIFYING: 'VERIFYING',
  EXECUTING: 'EXECUTING',
  BURNING: 'BURNING',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
  REFUNDING: 'REFUNDING',
};

const validTransitions = {
  MATCHMAKING: ['MINTING', 'FAILED'],
  MINTING:     ['LOCKING', 'FAILED'],
  LOCKING:     ['UPLOADING', 'FAILED'],
  UPLOADING:   ['VERIFYING', 'FAILED'],
  VERIFYING:   ['EXECUTING', 'FAILED', 'REFUNDING'],
  EXECUTING:   ['BURNING', 'FAILED'],
  BURNING:     ['COMPLETE'],
  FAILED:      ['REFUNDING'],
  REFUNDING:   ['COMPLETE'],
  COMPLETE:    [],
};

export function canTransition(from, to) {
  return validTransitions[from]?.includes(to) ?? false;
}

export function transition(deal, newStatus) {
  if (!canTransition(deal.status, newStatus)) {
    throw new Error(`Invalid deal transition: ${deal.status} → ${newStatus}`);
  }
  deal.status = newStatus;
  deal.updatedAt = Date.now();
  return deal;
}
