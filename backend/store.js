// In-memory store — replace with Redis in production

// Map<agentId, AgentRecord>
export const agents = new Map();

// Map<hashedApiKey, agentId>
export const apiKeys = new Map();

// Map<offerId, Offer>
export const offers = new Map();

// Map<dealId, Deal>
export const deals = new Map();
