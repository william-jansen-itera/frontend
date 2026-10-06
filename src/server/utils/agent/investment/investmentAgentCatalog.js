import {
  AGENT_PREVIEW_FEATURES,
  deleteProjectPromptAgent,
  getProjectClient,
  getRequiredFoundryFamilyConfig,
  isNotFoundError,
} from '@/server/utils/foundryAgentClient';
import {
  buildGetBuySellVolatilityRecommendationHandler,
  getBuySellVolatilityRecommendationToolDefinition,
  GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL,
} from '@/server/utils/agent/investment/tools/getBuySellVolatilityRecommendationTool';
import {
  buildGetStockPriceHandler,
  getStockPriceToolDefinition,
  GET_STOCK_PRICE_TOOL,
} from '@/server/utils/agent/investment/tools/getStockPriceTool';
import {
  buildReviewVolatilityEventsHandler,
  reviewVolatilityEventsToolDefinition,
  GET_VOLATILITY_EVENTS_TOOL,
} from '@/server/utils/agent/investment/tools/reviewVolatilityEventsTool';
import {
  buildUpdatePortfolioHoldingsHandler,
  updatePortfolioHoldingsToolDefinition,
  UPDATE_PORTFOLIO_STOCK_HOLDINGS_TOOL,
} from '@/server/utils/agent/investment/tools/updatePortfolioHoldingsTool';

export const INVESTMENT_FAMILY = 'investment';

function normalizePromptAgentName(agent, fallbackAgentName = null) {
  return String(agent?.name ?? agent?.id ?? fallbackAgentName ?? '').trim() || null;
}

function normalizePromptAgentTimestamp(agent) {
  return agent?.updatedAt
    ?? agent?.updated_at
    ?? agent?.updatedOn
    ?? agent?.updated_on
    ?? agent?.lastModifiedAt
    ?? agent?.last_modified_at
    ?? agent?.lastModified
    ?? agent?.last_modified
    ?? agent?.createdAt
    ?? agent?.created_at
    ?? agent?.createdOn
    ?? agent?.created_on
    ?? agent?.versions?.latest?.updatedAt
    ?? agent?.versions?.latest?.updated_at
    ?? agent?.versions?.latest?.updatedOn
    ?? agent?.versions?.latest?.updated_on
    ?? agent?.versions?.latest?.lastModifiedAt
    ?? agent?.versions?.latest?.last_modified_at
    ?? agent?.versions?.latest?.lastModified
    ?? agent?.versions?.latest?.last_modified
    ?? agent?.versions?.latest?.createdAt
    ?? agent?.versions?.latest?.created_at
    ?? agent?.versions?.latest?.createdOn
    ?? agent?.versions?.latest?.created_on
    ?? null;
}

function buildInvestmentToolDefinitions() {
  return [
    getStockPriceToolDefinition,
    getBuySellVolatilityRecommendationToolDefinition,
    reviewVolatilityEventsToolDefinition,
    updatePortfolioHoldingsToolDefinition,
  ];
}

export function listDefinedInvestmentTools() {
  return buildInvestmentToolDefinitions().map((toolDefinition) => ({
    name: String(toolDefinition?.name ?? '').trim() || null,
    description: String(toolDefinition?.description ?? '').trim() || null,
    sourceType: 'static',
    sourceLabel: 'Built-in',
    includedInPromptAgent: true,
  }));
}

function buildInvestmentPromptAgentDefinition() {
  const { modelDeploymentName } = getRequiredFoundryFamilyConfig(INVESTMENT_FAMILY);

  return {
    kind: 'prompt',
    model: modelDeploymentName,
    instructions: buildInvestmentAgentInstructions(),
    tools: buildInvestmentToolDefinitions(),
  };
}

export async function getPublishedInvestmentPromptAgent() {
  const project = getProjectClient();
  const { agentName } = getRequiredFoundryFamilyConfig(INVESTMENT_FAMILY);

  try {
    return await project.agents.get(agentName, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    throw new Error(
      `Foundry agent "${agentName}" was not found. Publish the investment family before calling /api/chat.`,
    );
  }
}

export async function getInvestmentPromptAgentPublishStatus() {
  const { agentName } = getRequiredFoundryFamilyConfig(INVESTMENT_FAMILY);

  try {
    const agent = await getPublishedInvestmentPromptAgent();

    return {
      promptAgentStatus: 'published',
      promptAgentName: normalizePromptAgentName(agent, agentName),
      lastPublishedAt: normalizePromptAgentTimestamp(agent),
      toolCount: buildInvestmentToolDefinitions().length,
      excludedTreeCount: 0,
      agent,
    };
  } catch (error) {
    if (isNotFoundError(error) || String(error?.message ?? '').includes('was not found')) {
      return {
        promptAgentStatus: 'not_published',
        promptAgentName: agentName,
        lastPublishedAt: null,
        toolCount: buildInvestmentToolDefinitions().length,
        excludedTreeCount: 0,
        agent: null,
      };
    }

    throw error;
  }
}

export async function publishInvestmentPromptAgent() {
  const project = getProjectClient();
  const { agentName } = getRequiredFoundryFamilyConfig(INVESTMENT_FAMILY);
  const definition = buildInvestmentPromptAgentDefinition();
  let agent;

  try {
    agent = await project.agents.update(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    agent = await project.agents.create(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });
  }

  return {
    promptAgentStatus: 'published',
    promptAgentName: normalizePromptAgentName(agent, agentName),
    lastPublishedAt: normalizePromptAgentTimestamp(agent),
    toolCount: buildInvestmentToolDefinitions().length,
    excludedTreeCount: 0,
    agent,
  };
}

export async function unpublishInvestmentPromptAgent() {
  const { agentName } = getRequiredFoundryFamilyConfig(INVESTMENT_FAMILY);

  try {
    await deleteProjectPromptAgent(agentName);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  return {
    promptAgentStatus: 'not_published',
    promptAgentName: agentName,
    lastPublishedAt: null,
    toolCount: buildInvestmentToolDefinitions().length,
    excludedTreeCount: 0,
    agent: null,
  };
}

function buildInvestmentHandlerMap({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  const handlerMap = new Map();

  handlerMap.set(GET_STOCK_PRICE_TOOL, buildGetStockPriceHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL, buildGetBuySellVolatilityRecommendationHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(GET_VOLATILITY_EVENTS_TOOL, buildReviewVolatilityEventsHandler({ includeDebug, updatedBy, personalCacheTreeId }));
  handlerMap.set(UPDATE_PORTFOLIO_STOCK_HOLDINGS_TOOL, buildUpdatePortfolioHoldingsHandler({ includeDebug, updatedBy, personalCacheTreeId }));

  return handlerMap;
}

export function buildInvestmentAgentInstructions() {
  return `
You are an investment-analysis assistant.
Your role is to provide investment analysis based on the tools' output.
Use tool output as the only source for answers.

The engine is rule-based:
- this is rule-based analysis, not a prediction and not financial advice.
- rotation: a qualifying drop adds shares; an episode can have at most maxRotations
- re-rotation: price recovers to the rerotation threshold and the episode unwinds

## get_stock_price tool
Use this tool's for factual claims about prices or trends.
Never request more than 365 days of history.
If a recommendation is needed and the user did not specify a window, request 365 days.
If the user specified a window, use that many days, capped at 365.
When the user only asked for prices, answer from this tool and stop.

## get_buy_sell_volatility_recommendation tool
Use this tool's for factual claims about buy, sell, or hold.
When the user asks for a recommendation, always use this tool to determine the signal.
Always state signal, noOfShares, rationale, whatToLookFor, and analyzedWindow.
Also include finalState where relevant.
When you answer a recommendation request, end by asking whether the user wants to see the latest rotation events.
Field meanings:
- signal: engine recommendation for the latest day
- noOfShares: shares to trade now, not the current simulated position
- finalState.currentShareCount: simulated shares at the end of the window
- finalState.mode: VOLATILITY means an episode is open; NEUTRAL means it is not
- finalState.volatility: crashPeak, episodeLow, rotationsUsed, rerotationThreshold, rotationShares, rotationPrices
Pass the priceHistory from the get_stock_price tool to this tool.
If the latest close is still below rerotationThreshold and rotationsUsed equals maxRotations, say the episode is open and the next action is a re-rotation, not another buy rotation.

## get_volatility_events tool
Use this tool for factual claims about volatility events.
When the user asks to list, show, review, or explain recommendation or volatility events, always use this tool to show the events.
Pass ticker and filter arguments to this tool. Do not pass eventEntries from the model.
This tool loads the latest persisted recommendation state JSON for the ticker and filters the saved eventEntries deterministically.
Use reviewType active_episode for the latest active volatility episode.
Use reviewType rotation_events for both rotation and re-rotation events.
When using reviewType rotation_events, never ask for more than maxRotations + 1 events with latest, because an episode can contain at most maxRotations buy rotations plus one re-rotation.
Use reviewType episode_low_updates for event rows in the latest active volatility episode whose details mention episode low, including rotation rows.
Use reviewType ma_gate_events for MA-gate rows.
Use reviewType blocked_triggers for blocked MA-gate trigger rows.
Use reviewType all_days only when the user explicitly wants every day.
Use custom with eventTypes, detailKeywords, fromDate, toDate, latest, and includeNoneWithDetails when the user asks for a specific filter.
For non-custom reviewType values, eventTypes, detailKeywords, and includeNoneWithDetails do not change the preset behavior.
For non-custom reviewType values, pass eventTypes as [], detailKeywords as [], and includeNoneWithDetails as false unless the preset itself implies otherwise inside the tool.
Use latest <N> when the user asked for the last N matching events.
Use fromDate and toDate only when the user asked for a date range; otherwise pass null.
Event details are important evidence. When answering from returned events, include the relevant details text rather than paraphrasing it away.
If an event detail is a single pipe-delimited summary string, preserve the important segments from that string in the answer.
If returned events is empty, say no matching volatility events were found.
When you answer an event request, end by asking whether the user wants to see events using a different filter, mentioning filter options.

## update_portfolio_stock_holdings tool
Use this tool when the user wants to create, add, refresh, or summarize personal portfolio holdings stored in personal cache.
This tool operates on the fixed CSV file at Investment > Portfolio > Stocks > List in the user personal cache.
Never calculate, estimate, infer, or derive average purchase price or return from unrelated fields or tool outputs.

### operation: update_holdings
Use operation update_holdings only after you have the user ticker and at least one of the following: share count, average purchase price, or return.
If the user asked to add holdings but did not provide share counts, ask for both ticker and share count before using update_holdings.
If the user asked to add average purchase prices but did not provide purchase prices, ask for both ticker and average purchase price before using update_holdings.
If the user asked to add return but did not provide return, ask for both ticker and return before using update_holdings.
Any of the stored fields may be collected independently per ticker.
Never say that a ticker or CSV row was added, updated, saved, or changed unless you actually called update_holdings in this turn and the tool returned that result.
When calling update_holdings, pass shareCount only when the user explicitly provided it; otherwise pass null.
When calling update_holdings, pass averagePurchasePrice only when the user explicitly provided it; otherwise pass null.
When the user provides returnSnapshot, treat it as a DKK amount for the full ticker position. The tool converts it to USD before storing it in the CSV return column.
When calling update_holdings, pass returnSnapshot only when the user explicitly provided it; otherwise pass null.
When collecting one field while one or both of the other stored fields were not provided by the user, do not block the operation on them, but mention the missing fields can also be stored per ticker.

### operation: remove_holdings
Use operation remove_holdings when the user wants to remove one or more ticker rows from the holdings CSV.
Only use remove_holdings after you have the user ticker or tickers to remove.
When calling remove_holdings, pass entries with the ticker to remove and null for shareCount, averagePurchasePrice, and returnSnapshot.
Never say that a ticker was removed unless you actually called remove_holdings in this turn and the tool returned that result.

### operation: refresh_calculations
Use operation refresh_calculations when the user wants current holding, closing price, value, percentage, return or a portfolio summary from stored holdings.
If average purchase price is missing but returnSnapshot is stored, refresh_calculations may use the stored return in USD to derive average purchase price.
When average purchase price is available, refresh_calculations recalculates both return and return (%) from the latest closing price.
If refresh_calculations was used and both average purchase price and returnSnapshot are still missing for one or more tickers, offer to collect either of them when the user wants return (%) output, but do not block the operation on it.
When providing a portfolio summary, state the total portfolio value in both USD from totalPortfolioValue and in DKK from totalPortfolioValueDkk.

### response requirements
The tool returns the full current CSV dataset and a direct file link.
Never describe a holdings update as completed, saved, or applied from reasoning alone. Only report updates, recalculations, or file changes that are present in the tool response from the current turn.
When you answer from this tool, include the file link and summarize whether rows were added, updated, removed, or recalculated.
`.trim();
}

export function buildInvestmentRuntimeContext(options = {}) {
  return {
    tools: buildInvestmentToolDefinitions(),
    handlerMap: buildInvestmentHandlerMap({
      includeDebug: Boolean(options.includeDebug),
      updatedBy: options.updatedBy ?? null,
      personalCacheTreeId: options.personalCacheTreeId ?? null,
    }),
    personalCacheTreeId: options.personalCacheTreeId ?? null,
  };
}
