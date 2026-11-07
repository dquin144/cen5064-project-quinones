// Data tier (external API client): the only file that calls the Claude API.
// Turns the advisor brief (built by the Domain tier, advice.buildAdvisorBrief) into a
// written summary and a short list of specific, actionable recommendations. Only
// used when ANTHROPIC_API_KEY is set; the default model is Claude Haiku 5.5, the
// cheapest current Claude model (about $0.001 per answer at this size).
//
// Each answer is cached for 6 hours per brief, and a request for a brief that's
// already being answered waits for that answer, so reloading the page never pays
// for the same answer twice.

const Anthropic = require('@anthropic-ai/sdk');
const { betaJSONSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/json-schema');

const CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 60 * 1000;

// Models that support server-side refusal fallbacks (fallbacks: "default").
// Claude Haiku 5.5 has none, and sending the parameter to it doesn't help.
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5']);

const SYSTEM_PROMPT = `You write the Recommendations tab of Folio, a web app that helps beginner and intermediate investors decide what to do with the stocks and funds they own.

You will get a JSON brief that Folio computed from the user's holdings: each holding with its shares, value, average cost, price, gain or loss and how long it has been held; a diversification score; Folio's findings, each with an id and already-calculated amounts (shares to sell, dollars to add, gains or losses a sale would realize, tax treatment); and recent headlines that name the holdings.

Write two things:

1. summary: 2-4 sentences, written to the user ("you"). Say what the portfolio is built around, how it's doing, and the one or two moves that matter most right now.

2. recommendations: 3-6 specific moves the user could make, most important first. Specific means a reader knows exactly what to do: which holding, roughly how many shares or dollars, and what it achieves, using Folio's amounts. Where findings point at the same holding or the same goal, combine them into one recommendation and say which option does both (for example, one sale that both takes back the original money and brings a stock under 25%). Each recommendation has:
   - title: the move in one line, with the key amount (under 15 words)
   - why: 1-2 sentences on what it achieves and the facts behind it, including a relevant headline if one explains the situation
   - steps: 1-3 concrete things to do, such as checking whether the account is taxable before selling, which option to prefer and when, or what to look for in the news
   - ticker: the main holding it's about, or an empty string if it's about the whole portfolio
   - priority: high, medium or low
   - basedOn: the ids of the findings it uses

Use only numbers that appear in the brief, exactly as written there. Don't calculate new amounts, totals, monthly splits or percentages: Folio checks every number and removes recommendations with numbers it didn't provide. Don't invent events or tickers, and don't name specific funds or stocks to buy (a type of fund, like a total-market index fund, is fine). Write recommendations as moves to consider ("Consider selling about..."), not orders: this is educational, and the user decides. Explain any investing term in a few words. If nothing needs doing, say so in the summary and recommend routine upkeep, such as a yearly rebalancing check.`;

const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          ticker: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          basedOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'why', 'steps', 'ticker', 'priority', 'basedOn'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'recommendations'],
  additionalProperties: false,
};

// Why Claude couldn't answer, in words the page can show.
class AdvisorError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

let client = null;
let model = null;
const cache = new Map(); // brief JSON -> { advice, model, generatedAt, fetchedAt }
const inFlight = new Map(); // brief JSON -> Promise

// Called once at startup (service.configure) or by a test.
function configure(config) {
  model = config.anthropic?.model ?? null;
  const apiKey = config.anthropic?.apiKey;
  client = apiKey ? new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 }) : null;
}

const isConfigured = () => client !== null;

function setClientForTests(fake, fakeModel = 'claude-haiku-5-5') {
  client = fake;
  model = fakeModel;
}

function clearCacheForTests() {
  cache.clear();
  inFlight.clear();
}

function toAdvisorError(err) {
  if (err instanceof AdvisorError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AdvisorError('The Claude API key was rejected. Check ANTHROPIC_API_KEY in .env.', 'auth');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AdvisorError('Claude is busy right now (rate limited). Try again in a minute.', 'rate_limit');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AdvisorError("Couldn't reach Claude. Check your internet connection.", 'connection');
  }
  if (err instanceof Anthropic.APIError) {
    return new AdvisorError(`Claude returned an error (${err.status ?? 'unknown'}).`, 'api');
  }
  return null; // a bug, not an API problem: let it surface
}

async function requestAdvice(brief) {
  const params = {
    model,
    max_tokens: 16000,
    // Rewording and combining facts that are already computed: low effort is plenty.
    output_config: { effort: 'low', format: betaJSONSchemaOutputFormat(ADVICE_SCHEMA) },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Here is the brief:\n\n${JSON.stringify(brief, null, 2)}` }],
  };
  if (SERVER_FALLBACK_MODELS.has(model)) {
    // If a safety classifier declines, retry on Anthropic's recommended fallback model.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const response = await client.beta.messages.parse(params);
  if (response.stop_reason === 'refusal') {
    throw new AdvisorError('Claude declined to write recommendations for this portfolio.', 'refusal');
  }
  if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
    throw new AdvisorError("Claude's answer was cut off or unreadable.", 'invalid');
  }
  return { advice: response.parsed_output, model: response.model ?? model };
}

// Returns { advice: { summary, recommendations }, model, generatedAt } as Claude
// wrote it (the Domain tier checks it). Throws AdvisorError when Claude can't answer.
// fresh: true ignores the cache (the "Regenerate" button).
async function generateAdvice(brief, { fresh = false } = {}) {
  if (!client) throw new AdvisorError('Claude is not set up. Add ANTHROPIC_API_KEY to .env.', 'not_configured');
  const key = JSON.stringify(brief);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit;
  if (inFlight.has(key)) return inFlight.get(key);

  const pending = requestAdvice(brief)
    .then(({ advice, model: usedModel }) => {
      const entry = { advice, model: usedModel, generatedAt: new Date().toISOString(), fetchedAt: Date.now() };
      cache.set(key, entry);
      return entry;
    })
    .catch((err) => {
      throw toAdvisorError(err) ?? err;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

module.exports = { configure, isConfigured, generateAdvice, AdvisorError, setClientForTests, clearCacheForTests, SYSTEM_PROMPT };
