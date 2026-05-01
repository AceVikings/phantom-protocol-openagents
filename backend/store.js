// In-memory store — replace with Redis in production

// Map<agentId, AgentRecord>
export const agents = new Map();

// Map<hashedApiKey, agentId>
export const apiKeys = new Map();

// Map<offerId, Offer>
export const offers = new Map();

// Map<dealId, Deal>
export const deals = new Map();

// Map<listingId, Listing>  — public capability registry (sellerAgentId kept private)
export const listings = new Map();

// Map<negotiationId, Negotiation>  — blind relay price negotiation sessions
export const negotiations = new Map();
