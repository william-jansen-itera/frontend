const MODE_NEUTRAL = 'NEUTRAL';
const MODE_VOLATILITY = 'VOLATILITY';

function logEvent(state, message) {
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    return;
  }

  if (Array.isArray(state.currentStepEvents)) {
    state.currentStepEvents.push(normalizedMessage);
    return;
  }

  state.events.push(normalizedMessage);
}

function beginStepEventCollection(state) {
  state.currentStepEvents = [];
}

function flushStepEventCollection(state, eventEntry) {
  const normalizedEventEntry = eventEntry && typeof eventEntry === 'object' ? eventEntry : null;
  const stepEvents = Array.isArray(state.currentStepEvents) ? state.currentStepEvents.filter(Boolean) : [];

  state.currentStepEvents = null;

  if (!normalizedEventEntry && stepEvents.length === 0) {
    return;
  }

  state.events.push({
    date: normalizedEventEntry?.date ?? null,
    close: Number.isFinite(normalizedEventEntry?.close) ? normalizedEventEntry.close : null,
    mode: normalizedEventEntry?.mode ?? null,
    rotationsUsed: Number.isInteger(normalizedEventEntry?.rotationsUsed) ? normalizedEventEntry.rotationsUsed : 0,
    shares: Number.isInteger(normalizedEventEntry?.shares) ? normalizedEventEntry.shares : 0,
    movingAverage: Number.isFinite(normalizedEventEntry?.movingAverage) ? normalizedEventEntry.movingAverage : null,
    details: stepEvents,
    eventType: normalizedEventEntry?.eventType ?? 'none',
  });
}

function pctChange(prevClose, close) {
  if (!Number.isFinite(prevClose) || prevClose === 0 || !Number.isFinite(close)) {
    return 0;
  }

  return (close - prevClose) / prevClose;
}

export function normalizePriceHistory(priceHistory) {
  if (!Array.isArray(priceHistory)) {
    return [];
  }

  return priceHistory
    .map((entry, index) => {
      const close = Number(entry?.close);
      const rawDate = String(entry?.date ?? '').trim();
      const parsedDate = rawDate ? new Date(rawDate) : null;

      if (!Number.isFinite(close)) {
        return null;
      }

      return {
        close,
        date: rawDate,
        parsedDate: parsedDate instanceof Date && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
        index,
      };
    })
    .filter(Boolean)
    .sort((leftEntry, rightEntry) => {
      if (leftEntry.parsedDate && rightEntry.parsedDate) {
        return leftEntry.parsedDate.getTime() - rightEntry.parsedDate.getTime();
      }

      return leftEntry.index - rightEntry.index;
    });
}

export function trimPriceHistoryByLookback(priceHistory, maxHistoryDays) {
  const normalizedHistory = normalizePriceHistory(priceHistory);

  if (normalizedHistory.length <= 1) {
    return normalizedHistory;
  }

  const normalizedLookback = Number.parseInt(maxHistoryDays, 10);

  if (!Number.isInteger(normalizedLookback) || normalizedLookback <= 0) {
    return normalizedHistory;
  }

  const mostRecentDatedEntry = [...normalizedHistory].reverse().find((entry) => entry.parsedDate);

  if (mostRecentDatedEntry?.parsedDate) {
    const cutoffTime = mostRecentDatedEntry.parsedDate.getTime() - (normalizedLookback * 24 * 60 * 60 * 1000);

    return normalizedHistory.filter((entry) => {
      if (!entry.parsedDate) {
        return true;
      }

      return entry.parsedDate.getTime() >= cutoffTime;
    });
  }

  return normalizedHistory.slice(-normalizedLookback);
}

function buildInitialState(startShareCount) {
  return {
    mode: MODE_NEUTRAL,
    events: [],
    lastAction: null,
    currentShareCount: startShareCount,
    currentProfit: 0,
    currentMa: null,
    currentStepEvents: null,
    maInsufficientLogged: false,
    maPeriodWarningLogged: false,
    volatility: {
      crashPeak: null,
      episodeLow: null,
      syntheticBase: null,
      rotationsUsed: 0,
      rerotationThreshold: null,
      rotationBlockValue: 0,
      rotationShares: [],
      rotationPrices: [],
    },
  };
}

function startVolatilityEpisode(state, prevClose, close, rotationSize) {
  state.mode = MODE_VOLATILITY;
  state.volatility.crashPeak = prevClose;
  state.volatility.episodeLow = close;
  state.volatility.syntheticBase = prevClose;

  const blockValue = rotationSize * state.volatility.syntheticBase * state.currentShareCount;
  state.volatility.rotationBlockValue = blockValue;

  const blockShares = Math.trunc(blockValue / close);
  state.volatility.rotationShares.push(blockShares);
  state.volatility.rotationPrices.push(close);
  state.currentShareCount += blockShares;
  state.volatility.rotationsUsed = 1;

  state.volatility.rerotationThreshold = close + (0.5 * (prevClose - close));
  logEvent(
    state,
    [
      'Rotation #1 triggered',
      `crash peak=${prevClose}`,
      `episode low=${close}`,
      `synthetic base=${state.volatility.syntheticBase}`,
      `rotation block value=${blockValue} (rotation_size=${rotationSize}, synthetic_base=${state.volatility.syntheticBase}, shares=${state.currentShareCount - blockShares})`,
      `added shares=${blockShares}`,
      `total shares=${state.currentShareCount}`,
      `rerotation threshold=${state.volatility.rerotationThreshold}`,
    ].join(' | '),
  );
}

function maybeTriggerVolatility(state, prevClose, close, closes, config) {
  const triggerContext = {
    maGateBlocked: false,
    movingAverage: Number.isFinite(state.currentMa) ? state.currentMa : null,
  };

  if (config.useMaGate) {
    if (!Number.isInteger(config.maPeriod) || config.maPeriod < 1) {
      if (!state.maPeriodWarningLogged) {
        logEvent(state, 'WARNING - use_ma_gate is enabled but ma_period is missing or invalid.');
        state.maPeriodWarningLogged = true;
      }
    } else if (!Array.isArray(closes) || closes.length < config.maPeriod) {
      state.currentMa = null;
      triggerContext.movingAverage = null;

      if (!state.maInsufficientLogged) {
        logEvent(state, `MA gate skipped - insufficient data (${Array.isArray(closes) ? closes.length : 0} closes available)`);
        state.maInsufficientLogged = true;
      }
    } else {
      const currentMa = closes.slice(-config.maPeriod).reduce((sum, value) => sum + value, 0) / config.maPeriod;
      state.currentMa = currentMa;
      triggerContext.movingAverage = currentMa;

      if (close <= currentMa) {
        logEvent(state, `Blocked by MA gate (close ${close} <= ${config.maPeriod}-day MA ${currentMa.toFixed(2)})`);
        triggerContext.maGateBlocked = true;
        return triggerContext;
      }
    }
  }

  const change = pctChange(prevClose, close);

  if (change > -config.volatilityThreshold) {
    return triggerContext;
  }

  if (state.mode === MODE_NEUTRAL) {
    startVolatilityEpisode(state, prevClose, close, config.rotationSize);
    return triggerContext;
  }

  if (state.mode !== MODE_VOLATILITY) {
    return triggerContext;
  }

  if (close < state.volatility.episodeLow) {
    state.volatility.episodeLow = close;
    logEvent(state, `episode low updated to ${close}`);
  }

  if (state.volatility.rotationsUsed >= config.maxRotations) {
    return triggerContext;
  }

  const blockValue = state.volatility.rotationBlockValue;
  const blockShares = Math.trunc(blockValue / close);
  state.volatility.rotationShares.push(blockShares);
  state.volatility.rotationPrices.push(close);
  state.currentShareCount += blockShares;
  state.volatility.rotationsUsed += 1;
  logEvent(
    state,
    `Rotation #${state.volatility.rotationsUsed} triggered at close=${close}, added ${blockShares} shares -> total ${state.currentShareCount}`,
  );

  return triggerContext;
}

function maybeRerotate(state, close) {
  if (state.mode !== MODE_VOLATILITY) {
    return;
  }

  const threshold = state.volatility.rerotationThreshold;

  if (!Number.isFinite(threshold) || close < threshold) {
    return;
  }

  const blockValue = state.volatility.rotationBlockValue;
  const episodeRotatedValue = state.volatility.rotationsUsed * blockValue;
  const episodeAddedShares = state.volatility.rotationShares.reduce((sum, value) => sum + value, 0);
  const episodeSharesReturned = Math.trunc(episodeRotatedValue / close);
  const netAddedShares = episodeAddedShares - episodeSharesReturned;
  state.currentShareCount -= episodeSharesReturned;

  const episodeRotationCost = state.volatility.rotationShares.reduce((sum, shares, index) => {
    return sum + (shares * state.volatility.rotationPrices[index]);
  }, 0);
  const episodeRotationValue = episodeAddedShares * close;
  const profit = episodeRotationValue - episodeRotationCost;
  state.currentProfit += profit;
  logEvent(
    state,
    [
      'Re-rotation triggered',
      `close=${close}`,
      `threshold=${threshold}`,
      `rotation added_shares=${episodeAddedShares}`,
      `re-rotation shares returned=${episodeSharesReturned}`,
      `net added shares=${netAddedShares}`,
      `profit=${profit}`,
      `cumulative_profit=${state.currentProfit}`,
      `total_shares=${state.currentShareCount}`,
    ].join(' | '),
  );

  state.mode = MODE_NEUTRAL;
  state.volatility = {
    crashPeak: null,
    episodeLow: null,
    syntheticBase: null,
    rotationsUsed: 0,
    rerotationThreshold: null,
    rotationBlockValue: 0,
    rotationShares: [],
    rotationPrices: [],
  };
}

function buildFinalStepDecision(state, config, analyzedHistory) {
  if (analyzedHistory.length < 2) {
    return null;
  }

  const latestEntry = analyzedHistory[analyzedHistory.length - 1];
  const previousEntry = analyzedHistory[analyzedHistory.length - 2];
  const change = pctChange(previousEntry.close, latestEntry.close);

  return {
    date: latestEntry.date || null,
    close: latestEntry.close,
    previousClose: previousEntry.close,
    change,
    thresholdDropMet: change <= -config.volatilityThreshold,
    rerotationThreshold: Number.isFinite(state.volatility.rerotationThreshold)
      ? state.volatility.rerotationThreshold
      : null,
  };
}

function buildRecommendationSummary(state, config, analyzedHistory, lastAction) {
  if (analyzedHistory.length < 2) {
    return {
      signal: 'hold',
      rationale: 'Not enough closing-price history remained after applying the configured lookback window.',
    };
  }

  if (lastAction?.triggeredRotation) {
    return {
      signal: 'buy',
      rationale: `The last close on ${lastAction.date ?? 'the most recent day'} dropped ${(Math.abs(lastAction.change) * 100).toFixed(2)}%, meeting the ${(config.volatilityThreshold * 100).toFixed(2)}% volatility threshold and triggering a rotation within the configured maximum of ${config.maxRotations} rotation(s).`,
    };
  }

  if (lastAction?.triggeredRerotation) {
    return {
      signal: 'sell',
      rationale: `The last close on ${lastAction.date ?? 'the most recent day'} reached or exceeded the rerotation threshold (${lastAction.close} >= ${lastAction.rerotationThreshold}), so the episode rerotated back to neutral.`,
    };
  }

  return {
    signal: 'hold',
    rationale: lastAction?.maGateBlocked
      ? `The last close on ${lastAction?.date ?? 'the most recent day'} met the ${(config.volatilityThreshold * 100).toFixed(2)}% drop trigger, but the moving-average gate was enabled and blocked a rotation because ${lastAction?.close} was at or below the ${config.maPeriod}-day moving average (${lastAction?.movingAverage?.toFixed(2)}).`
      : lastAction?.maxRotationsReached
      ? `The last close on ${lastAction?.date ?? 'the most recent day'} met the ${(config.volatilityThreshold * 100).toFixed(2)}% drop trigger, but the active volatility episode had already reached the configured maximum of ${config.maxRotations} rotation(s).`
      : state.mode === MODE_VOLATILITY
      ? `The last close on ${lastAction?.date ?? 'the most recent day'} stayed below the rerotation threshold (${lastAction?.close} < ${lastAction?.rerotationThreshold}), so the active volatility episode remains open without a new trigger on the latest day.`
      : `The last close on ${lastAction?.date ?? 'the most recent day'} did not drop enough to trigger a new rotation within the configured ${config.maxHistoryDays}-day window.`,
  };
}

export function runVolatilityHarvestAnalysis(priceHistory, config) {
  const trimmedHistory = trimPriceHistoryByLookback(priceHistory, config.maxHistoryDays);
  const state = buildInitialState(config.startShareCount);

  if (trimmedHistory.length < 2) {
    const recommendation = buildRecommendationSummary(state, config, trimmedHistory);

    return {
      recommendation,
      state,
      trimmedHistory,
    };
  }

  for (let index = 1; index < trimmedHistory.length; index += 1) {
    const prevClose = trimmedHistory[index - 1].close;
    const close = trimmedHistory[index].close;
    const change = pctChange(prevClose, close);
    const closes = trimmedHistory.slice(0, index + 1).map((entry) => entry.close);
    const modeBeforeStep = state.mode;
    const rotationsBeforeStep = state.volatility.rotationsUsed;

    beginStepEventCollection(state);
    const triggerContext = maybeTriggerVolatility(state, prevClose, close, closes, config);
    const rerotationThresholdBeforeRerotate = Number.isFinite(state.volatility.rerotationThreshold)
      ? state.volatility.rerotationThreshold
      : null;
    const rotationSharesBeforeRerotate = [...state.volatility.rotationShares];
    maybeRerotate(state, close);

    const triggeredRotation = state.volatility.rotationsUsed > rotationsBeforeStep;
    const triggeredRerotation = modeBeforeStep === MODE_VOLATILITY
      && Number.isFinite(rerotationThresholdBeforeRerotate)
      && close >= rerotationThresholdBeforeRerotate
      && state.mode === MODE_NEUTRAL;
    const maxRotationsReached = modeBeforeStep === MODE_VOLATILITY
      && change <= -config.volatilityThreshold
      && rotationsBeforeStep >= config.maxRotations
      && !triggeredRotation;
    const noOfShares = triggeredRerotation
      ? rotationSharesBeforeRerotate.reduce((sum, value) => sum + value, 0)
      : triggeredRotation
        ? Number(state.volatility.rotationShares[state.volatility.rotationShares.length - 1] ?? 0)
        : 0;
    state.lastAction = {
      ...buildFinalStepDecision(state, config, trimmedHistory.slice(0, index + 1)),
      modeBeforeStep,
      triggeredRotation,
      triggeredRerotation,
      maxRotationsReached,
      maGateBlocked: Boolean(config.useMaGate && triggerContext?.maGateBlocked),
      movingAverage: Number.isFinite(triggerContext?.movingAverage) ? triggerContext.movingAverage : null,
      noOfShares,
      rerotationThreshold: rerotationThresholdBeforeRerotate,
    };

    flushStepEventCollection(
      state,
      {
        date: trimmedHistory[index].date || null,
        close,
        mode: state.mode,
        rotationsUsed: state.volatility.rotationsUsed,
        shares: state.currentShareCount,
        movingAverage: Number.isFinite(state.currentMa) ? state.currentMa : null,
        eventType: triggeredRerotation ? 're-rotation' : triggeredRotation ? 'rotation' : 'none',
      },
    );
  }

  const lastAction = state.lastAction ?? buildFinalStepDecision(state, config, trimmedHistory);

  return {
    recommendation: buildRecommendationSummary(state, config, trimmedHistory, lastAction),
    state,
    trimmedHistory,
  };
}