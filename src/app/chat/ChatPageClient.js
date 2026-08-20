"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

const TURN_TYPE_NO_RESULT_OFFER = "no_result_offer";
const TURN_TYPE_BROADER_ANSWER = "broader_answer";

function buildHistoryFromTurns(turns) {
  return turns.flatMap((turn) => {
    const messages = [];
    const turnType = String(turn?.turnType ?? "default").trim();

    if (turnType === TURN_TYPE_NO_RESULT_OFFER) {
      return messages;
    }

    const userHistoryText = turnType === TURN_TYPE_BROADER_ANSWER
      ? String(turn?.originalQuestion ?? turn?.question ?? "").trim()
      : String(turn?.question ?? "").trim();

    const assistantHistoryText = String(turn?.answer ?? "").trim();

    if (userHistoryText) {
      messages.push({ role: "user", content: userHistoryText });
    }

    if (assistantHistoryText) {
      messages.push({ role: "assistant", content: assistantHistoryText });
    }

    return messages;
  });
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatJson(value) {
  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value, null, 2);
}

function getCitationBreadcrumbParts(citation) {
  const breadcrumb = String(citation?.breadcrumb || "").trim();

  if (!breadcrumb) {
    return [citation?.treeDisplayName || `Tree ${citation?.treeId ?? ""}`.trim() || "Node"];
  }

  if (breadcrumb.includes(" / ")) {
    return breadcrumb.split(" / ").map((part) => part.trim()).filter(Boolean);
  }

  if (breadcrumb.includes(" > ")) {
    return breadcrumb.split(" > ").map((part) => part.trim()).filter(Boolean);
  }

  return [breadcrumb];
}

function getCitationBreadcrumbItems(citation) {
  const breadcrumbParts = getCitationBreadcrumbParts(citation);
  const nodeHref = `/notes?treeId=${encodeURIComponent(citation.treeId)}&nodeId=${encodeURIComponent(citation.nodeId)}`;
  const nodeIdPath = String(citation?.nodeIdPath || "").trim();
  const pathNodeIds = nodeIdPath
    ? nodeIdPath.split("/").map((part) => part.trim()).filter(Boolean)
    : [];

  return breadcrumbParts.map((part, index) => ({
    label: part,
    href: pathNodeIds.length === breadcrumbParts.length
      ? `/notes?treeId=${encodeURIComponent(citation.treeId)}&nodeId=${encodeURIComponent(pathNodeIds[index])}`
      : nodeHref,
    isLeaf: index === breadcrumbParts.length - 1,
  }));
}

function CitationBreadcrumbs({ citations }) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return null;
  }

  return (
    <div className={styles.citationSection}>
      <p className={styles.citationEyebrow}>Grounding nodes</p>
      <div className={styles.citationList}>
        {citations.map((citation, index) => {
          const breadcrumbItems = getCitationBreadcrumbItems(citation);
          const key = `${citation.treeId}-${citation.nodeId}-${index}`;

          return (
            <div key={key} className={styles.citationCard}>
              <div className={styles.resultBreadcrumbTrail}>
                <span className={styles.resultTreeLabel}>Node: {citation.treeDisplayName || citation.treeId}</span>
                {breadcrumbItems.map((item, itemIndex) => (
                  <span key={`${key}-crumb-${itemIndex}`} className={styles.resultBreadcrumbItem}>
                    <span className={styles.resultBreadcrumbSeparator}>/</span>
                    <Link href={item.href} className={styles.resultBreadcrumbLink}>
                      <span className={item.isLeaf ? styles.resultBreadcrumbLeaf : styles.resultBreadcrumbPart}>
                        {item.label}
                      </span>
                    </Link>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getTurnToolBadgeState(turn) {
  const toolInvocations = Array.isArray(turn?.toolInvocations) ? turn.toolInvocations : [];
  const invokedTools = Array.from(new Set(
    toolInvocations
      .map((invocation) => String(invocation?.toolName ?? "").trim())
      .filter(Boolean),
  ));
  const toolsWithResults = Array.from(new Set(
    toolInvocations
      .filter((invocation) => Number(invocation?.resultCount ?? 0) > 0)
      .map((invocation) => String(invocation?.toolName ?? "").trim())
      .filter(Boolean),
  ));
  const isBroaderAnswerTurn = turn?.turnType === TURN_TYPE_BROADER_ANSWER;

  if (invokedTools.length > 0) {
    const hasToolResults = toolsWithResults.length > 0;
    const shouldHighlightAddTarget = isBroaderAnswerTurn && !hasToolResults;

    return {
      toolLabels: isBroaderAnswerTurn ? [] : invokedTools.map((toolName) => `TOOL: ${toolName}`),
      addTargets: shouldHighlightAddTarget ? invokedTools.map((toolName) => ({
        toolName,
        label: `Add to: ${toolName}`,
      })) : [],
      statusLabel: hasToolResults || isBroaderAnswerTurn ? null : "NO TOOL RESULT",
    };
  }

  return {
    toolLabels: [],
    addTargets: [],
    statusLabel: "NO TOOL FOUND",
  };
}

function TurnDebugPanel({ turn }) {
  if (!turn) {
    return (
      <div className={styles.debugEmptyState}>
        <h2>Select a turn</h2>
        <p>Send a message to inspect the query, tool activity, curated agent input, and final model output.</p>
      </div>
    );
  }

  if (!turn.debug) {
    return (
      <div className={styles.debugEmptyState}>
        <h2>Debug unavailable</h2>
        <p>This response did not include debug data. Check the server-side debug setting if you want this panel populated.</p>
      </div>
    );
  }

  const toolCalls = Array.isArray(turn.debug.toolCalls) ? turn.debug.toolCalls : [];

  return (
    <div className={styles.debugSections}>
      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className={styles.sectionEyebrow}>1. User Query</p>
          <h2 className={styles.sectionTitle}>Conversation input</h2>
        </div>
        <pre className={styles.jsonBlock}>{formatJson(turn.debug.userQuery)}</pre>
      </section>

      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className={styles.sectionEyebrow}>2. Tool Calls</p>
          <h2 className={styles.sectionTitle}>{toolCalls.length} invocation{toolCalls.length === 1 ? "" : "s"}</h2>
        </div>
        {toolCalls.length === 0 ? (
          <p className={styles.sectionEmpty}>No tool calls were recorded for this turn.</p>
        ) : (
          <div className={styles.toolCallList}>
            {toolCalls.map((toolCall) => (
              <article key={toolCall.callId || `${toolCall.round}-${toolCall.toolName}`} className={styles.toolCard}>
                <div className={styles.toolHeader}>
                  <div>
                    <p className={styles.toolLabel}>Round {toolCall.round}</p>
                    <h3 className={styles.toolName}>{toolCall.toolName || "Tool call"}</h3>
                  </div>
                  {toolCall.error ? <span className={styles.toolErrorBadge}>Error</span> : null}
                </div>

                <details className={styles.debugDetail} open>
                  <summary>Parsed arguments</summary>
                  <pre className={styles.jsonBlock}>{formatJson(toolCall.parsedArguments)}</pre>
                </details>

                <details className={styles.debugDetail}>
                  <summary>Actual search results</summary>
                  <pre className={styles.jsonBlock}>{formatJson(toolCall.searchResult)}</pre>
                </details>

                <details className={styles.debugDetail}>
                  <summary>Tool output</summary>
                  <pre className={styles.jsonBlock}>{formatJson(toolCall.toolOutput)}</pre>
                </details>

                {toolCall.error ? (
                  <details className={styles.debugDetail} open>
                    <summary>Tool error</summary>
                    <pre className={styles.jsonBlock}>{formatJson(toolCall.error)}</pre>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className={styles.sectionEyebrow}>3. Curated Agent Input</p>
          <h2 className={styles.sectionTitle}>Messages passed back to the model</h2>
        </div>
        <pre className={styles.jsonBlock}>{formatJson(turn.debug.curatedAgentInput)}</pre>
      </section>

      <section className={styles.debugSection}>
        <div className={styles.sectionHeader}>
          <p className={styles.sectionEyebrow}>4. Agent Output</p>
          <h2 className={styles.sectionTitle}>Model response and answer</h2>
        </div>
        <pre className={styles.jsonBlock}>{formatJson(turn.debug.agentOutput)}</pre>
      </section>
    </div>
  );
}

function getLatestNoResultOfferTurn(turns, dismissedTurnId) {
  const latestTurn = turns.at(-1) ?? null;

  if (!latestTurn || latestTurn.id === dismissedTurnId) {
    return null;
  }

  if (latestTurn.isPending || latestTurn.error) {
    return null;
  }

  if (latestTurn.turnType !== TURN_TYPE_NO_RESULT_OFFER) {
    return null;
  }

  if (!Array.isArray(latestTurn.followUpOptions) || latestTurn.followUpOptions.length === 0) {
    return null;
  }

  return latestTurn;
}

export default function ChatPageClient({ includeDebug }) {
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState([]);
  const [selectedTurnId, setSelectedTurnId] = useState(null);
  const [dismissedFollowUpTurnId, setDismissedFollowUpTurnId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestError, setRequestError] = useState(null);
  const [addActionState, setAddActionState] = useState(null);
  const chatFeedRef = useRef(null);

  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId) ?? turns.at(-1) ?? null;
  const displayedTurns = [...turns].reverse();
  const activeNoResultOfferTurn = getLatestNoResultOfferTurn(turns, dismissedFollowUpTurnId);
  const isPromptInOptionMode = Boolean(activeNoResultOfferTurn);
  const isInitialPendingState = turns.length === 1 && Boolean(turns[0]?.isPending) && !turns[0]?.error;

  async function submitTurn({ question, message, followUpSelection = null }) {
    const turnId = `${Date.now()}`;
    const history = buildHistoryFromTurns(turns);

    setIsSubmitting(true);
    setRequestError(null);
    setSelectedTurnId(turnId);
    setTurns((currentTurns) => ([
      ...currentTurns,
      {
        id: turnId,
        question,
        originalQuestion: followUpSelection?.sourceQuestion ?? question,
        answer: "",
        debug: null,
        error: null,
        citations: [],
        toolsUsed: [],
        toolInvocations: [],
        turnType: "default",
        followUpOptions: [],
        createdAt: Date.now(),
        isPending: true,
      },
    ]));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          history,
          followUpSelection,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw {
          message: payload?.error || "Chat request failed",
          debug: payload?.debug ?? null,
        };
      }

      setDismissedFollowUpTurnId(null);
      setTurns((currentTurns) => currentTurns.map((turn) => (
        turn.id === turnId
          ? {
            ...turn,
            answer: String(payload?.answer ?? "").trim(),
            debug: payload?.debug ?? null,
            citations: Array.isArray(payload?.citations) ? payload.citations : [],
            toolsUsed: Array.isArray(payload?.toolsUsed) ? payload.toolsUsed : [],
            toolInvocations: Array.isArray(payload?.toolInvocations) ? payload.toolInvocations : [],
            turnType: String(payload?.turnType ?? "default").trim() || "default",
            followUpOptions: Array.isArray(payload?.followUpOptions) ? payload.followUpOptions : [],
            originalQuestion: turn.originalQuestion,
            error: null,
            isPending: false,
          }
          : turn
      )));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error?.message || "Chat request failed");

      setRequestError(messageText);
      setTurns((currentTurns) => currentTurns.map((turn) => (
        turn.id === turnId
          ? {
            ...turn,
            answer: "",
            debug: error?.debug ?? null,
            error: messageText,
            toolInvocations: [],
            turnType: "default",
            followUpOptions: [],
            isPending: false,
          }
          : turn
      )));
    } finally {
      setIsSubmitting(false);
    }
  }

  useEffect(() => {
    if (!chatFeedRef.current) {
      return;
    }

    chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
  }, [turns, isSubmitting]);

  async function handleSubmit(event) {
    event.preventDefault();

    const message = prompt.trim();

    if (!message || isSubmitting || isPromptInOptionMode) {
      return;
    }

    setPrompt("");
    await submitTurn({
      question: message,
      message,
    });
  }

  async function handleFollowUpOptionClick(option) {
    if (!activeNoResultOfferTurn || isSubmitting) {
      return;
    }

    const optionId = String(option?.optionId ?? "").trim();
    const label = String(option?.label ?? "").trim();

    if (!optionId || !label) {
      return;
    }

    await submitTurn({
      question: label,
      message: label,
      followUpSelection: {
        sourceTurnId: activeNoResultOfferTurn.id,
        optionId,
        sourceQuestion: activeNoResultOfferTurn.question,
        sourceToolInvocations: Array.isArray(activeNoResultOfferTurn.toolInvocations)
          ? activeNoResultOfferTurn.toolInvocations.map((invocation) => ({
            toolName: invocation?.toolName,
            resultCount: invocation?.resultCount,
          }))
          : [],
      },
    });
  }

  async function handleAddToToolClick(event, turn, toolName) {
    event.preventDefault();
    event.stopPropagation();

    if (isSubmitting || addActionState?.status === "pending") {
      return;
    }

    const normalizedToolName = String(toolName ?? "").trim();
    const originalQuestion = String(turn?.originalQuestion ?? turn?.question ?? "").trim();
    const broaderAnswer = String(turn?.answer ?? "").trim();

    if (!normalizedToolName || !originalQuestion || !broaderAnswer) {
      setAddActionState({
        status: "error",
        turnId: turn?.id ?? null,
        toolName: normalizedToolName,
        message: "This answer does not have enough context to create a new leaf note.",
      });
      return;
    }

    setAddActionState({
      status: "pending",
      turnId: turn.id,
      toolName: normalizedToolName,
      message: "Finding the best place in the tree...",
    });

    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "preview-leaf-from-chat",
          toolName: normalizedToolName,
          originalQuestion,
          broaderAnswer,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || "Unable to add this answer to the tree.");
      }

      setAddActionState({
        status: "confirm",
        turnId: turn.id,
        toolName: normalizedToolName,
        message: `Create a new leaf note under ${payload.selectedBreadcrumb}?`,
        preview: payload,
      });
    } catch (error) {
      setAddActionState({
        status: "error",
        turnId: turn.id,
        toolName: normalizedToolName,
        message: error instanceof Error ? error.message : "Unable to add this answer to the tree.",
      });
    }
  }

  async function handleConfirmAddToTool(event, turn) {
    event.preventDefault();
    event.stopPropagation();

    if (addActionState?.status !== "confirm" || addActionState.turnId !== turn.id) {
      return;
    }

    const preview = addActionState.preview;

    setAddActionState({
      ...addActionState,
      status: "pending",
      message: "Creating new leaf note...",
    });

    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "create-leaf-from-chat",
          treeId: preview.treeId,
          toolName: addActionState.toolName,
          originalQuestion: preview.originalQuestion,
          broaderAnswer: preview.broaderAnswer,
          selectedParentNodeId: preview.selectedParentNodeId,
          selectedBreadcrumb: preview.selectedBreadcrumb,
          generatedLeafTitle: preview.generatedLeafTitle,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || "Unable to add this answer to the tree.");
      }

      setAddActionState({
        status: "success",
        turnId: turn.id,
        toolName: addActionState.toolName,
        message: `Creating \"${payload.generatedLeafTitle}\" under ${payload.selectedBreadcrumb}. Opening Notes...`,
      });

      const notesHref = `/notes?treeId=${encodeURIComponent(payload.treeId)}&nodeId=${encodeURIComponent(payload.createdNodeId)}`;
      window.open(notesHref, "_blank", "noopener,noreferrer");
    } catch (error) {
      setAddActionState({
        status: "error",
        turnId: turn.id,
        toolName: addActionState.toolName,
        message: error instanceof Error ? error.message : "Unable to add this answer to the tree.",
      });
    }
  }

  return (
    <main className={styles.pageShell}>
      <section className={`${styles.workspaceGrid} ${!includeDebug ? styles.workspaceGridSingle : ""}`}>
        <div className={styles.chatColumnSurface}>
          <section className={styles.heroCard}>
            <div className={`appPanelTopBar ${styles.promptPanelHeader}`}>
              <p className={styles.panelEyebrow}>Prompt</p>
              {isPromptInOptionMode ? null : (
                <button
                  type="submit"
                  form="chat-prompt-form"
                  className={`appCompactActionButton appCompactActionButtonNeutral ${styles.promptToolbarButton}`}
                  disabled={isSubmitting || !prompt.trim()}
                >
                  {isSubmitting ? "Thinking..." : "Send"}
                </button>
              )}
            </div>
            <form id="chat-prompt-form" onSubmit={handleSubmit} className={styles.composerForm}>
              <label className={styles.composerField}>
                {isPromptInOptionMode ? (
                  <div className={styles.followUpComposerCard}>
                    <div className={styles.followUpActionRow}>
                      {activeNoResultOfferTurn.followUpOptions.map((option) => (
                        <button
                          key={`${activeNoResultOfferTurn.id}-${option.optionId}`}
                          type="button"
                          className={styles.followUpPrimaryButton}
                          onClick={() => handleFollowUpOptionClick(option)}
                          disabled={isSubmitting}
                        >
                          {option.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        className={styles.followUpSecondaryButton}
                        onClick={() => setDismissedFollowUpTurnId(activeNoResultOfferTurn.id)}
                        disabled={isSubmitting}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Ask about a tree, node, attachment, or topic"
                    className={styles.textArea}
                    rows={4}
                  />
                )}
              </label>
            </form>
          </section>

          {requestError ? <p className={`${styles.errorMessage} ${styles.errorMessageInline}`}>{requestError}</p> : null}

          <div className={`${styles.chatPanel} ${isInitialPendingState ? styles.chatPanelInitialPending : ""}`}>
            <div ref={chatFeedRef} className={`${styles.chatFeed} ${isInitialPendingState ? styles.chatFeedInitialPending : ""}`}>
              {turns.length === 0 ? (
                <div className={styles.emptyState}>
                  <h3>Start a turn</h3>
                  <p>
                    {includeDebug
                      ? "The left side will show the conversation. The right side will show the debug trace for the selected turn."
                      : "The conversation history and grounded citations will appear here as you ask questions."}
                  </p>
                </div>
              ) : (
                displayedTurns.map((turn) => {
                  const isSelected = turn.id === selectedTurn?.id;
                  const toolBadgeState = getTurnToolBadgeState(turn);

                  return (
                    <article
                      key={turn.id}
                      className={`${styles.turnCard} ${turn.isPending ? styles.turnCardPending : ""} ${isSelected ? styles.turnCardSelected : ""}`}
                      onClick={() => setSelectedTurnId(turn.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedTurnId(turn.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className={styles.turnMetaRow}>
                        <span className={styles.turnTimestamp}>{formatTimestamp(turn.createdAt)}</span>
                        <span className={styles.turnStatus}>{turn.isPending ? "Pending" : turn.error ? "Error" : "Complete"}</span>
                      </div>

                      {!turn.isPending && !turn.error ? (
                        <div className={styles.toolChipRow}>
                          {toolBadgeState.toolLabels.map((label) => (
                            <span key={`${turn.id}-${label}`} className={styles.toolChip}>{label}</span>
                          ))}
                          {toolBadgeState.statusLabel ? (
                            <span className={styles.noToolChip}>{toolBadgeState.statusLabel}</span>
                          ) : null}
                        </div>
                      ) : null}

                      <div className={`${styles.messageBubbleAgent} ${turn.isPending ? styles.messageBubblePending : ""}`}>
                        <div className={styles.messageHeaderRow}>
                          <p className={styles.messageLabel}>Agent</p>
                          {toolBadgeState.addTargets.map((target) => (
                            <button
                              key={`${turn.id}-${target.toolName}`}
                              type="button"
                              className={`appCompactActionButton appCompactActionButtonNeutral ${styles.addToToolChipButton}`}
                              onClick={(event) => handleAddToToolClick(event, turn, target.toolName)}
                              disabled={addActionState?.status === "pending"}
                            >
                              {target.label}
                            </button>
                          ))}
                        </div>
                        <p className={`${styles.messageText} ${turn.isPending ? styles.messageTextPending : ""}`}>
                          {turn.isPending ? "Waiting for response..." : turn.error ? turn.error : turn.answer || "No answer returned."}
                        </p>
                        {addActionState?.turnId === turn.id ? (
                          <div className={styles.addActionPanel}>
                            <p className={addActionState.status === "error" ? styles.addActionError : styles.addActionStatus}>
                              {addActionState.message}
                            </p>
                            {addActionState.status === "confirm" ? (
                              <div className={styles.addActionControls}>
                                <button
                                  type="button"
                                  className={styles.addActionConfirmButton}
                                  onClick={(event) => handleConfirmAddToTool(event, turn)}
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  className={styles.addActionCancelButton}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setAddActionState(null);
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      <div className={`${styles.messageBubbleUser} ${turn.isPending ? styles.messageBubblePending : ""}`}>
                        <p className={styles.messageLabel}>User</p>
                        <p className={`${styles.messageText} ${turn.isPending ? styles.messageTextPending : ""}`}>{turn.question}</p>
                      </div>

                      {!turn.isPending && !turn.error ? <CitationBreadcrumbs citations={turn.citations} /> : null}
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {includeDebug ? (
          <aside className={`appPanelShell ${styles.debugPanel}`}>
            <div className={`appPanelTopBar ${styles.panelHeader}`}>
              <div>
                <p className={styles.panelEyebrow}>Debug</p>
                <h2 className={styles.panelTitle}>Turn inspector</h2>
              </div>
            </div>
            <div className={styles.debugBody}>
              <p className={styles.debugIntro}>
                Inspect exactly how the agent searched, curated evidence, and produced the answer.
              </p>
              <TurnDebugPanel turn={selectedTurn} />
            </div>
          </aside>
        ) : null}
      </section>
    </main>
  );
}