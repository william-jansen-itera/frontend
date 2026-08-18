"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

function buildHistoryFromTurns(turns) {
  return turns.flatMap((turn) => {
    const messages = [];

    if (turn.question) {
      messages.push({ role: "user", content: turn.question });
    }

    if (turn.answer) {
      messages.push({ role: "assistant", content: turn.answer });
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
                  <summary>Raw search result</summary>
                  <pre className={styles.jsonBlock}>{formatJson(toolCall.searchResult)}</pre>
                </details>

                <details className={styles.debugDetail}>
                  <summary>Tool output</summary>
                  <pre className={styles.jsonBlock}>{formatJson(toolCall.toolOutput)}</pre>
                </details>

                <details className={styles.debugDetail}>
                  <summary>Agent tool input</summary>
                  <pre className={styles.jsonBlock}>{formatJson(toolCall.agentToolInput)}</pre>
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

export default function ChatPage() {
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState([]);
  const [selectedTurnId, setSelectedTurnId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestError, setRequestError] = useState(null);
  const chatFeedRef = useRef(null);

  const selectedTurn = turns.find((turn) => turn.id === selectedTurnId) ?? turns.at(-1) ?? null;
  const displayedTurns = [...turns].reverse();

  useEffect(() => {
    if (!chatFeedRef.current) {
      return;
    }

    chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight;
  }, [turns, isSubmitting]);

  async function handleSubmit(event) {
    event.preventDefault();

    const message = prompt.trim();

    if (!message || isSubmitting) {
      return;
    }

    const turnId = `${Date.now()}`;
    const question = message;
    const history = buildHistoryFromTurns(turns);

    setPrompt("");
    setIsSubmitting(true);
    setRequestError(null);
    setSelectedTurnId(turnId);
    setTurns((currentTurns) => ([
      ...currentTurns,
      {
        id: turnId,
        question,
        answer: "",
        debug: null,
        error: null,
        citations: [],
        toolsUsed: [],
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
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw {
          message: payload?.error || "Chat request failed",
          debug: payload?.debug ?? null,
        };
      }

      setTurns((currentTurns) => currentTurns.map((turn) => (
        turn.id === turnId
          ? {
            ...turn,
            answer: String(payload?.answer ?? "").trim(),
            debug: payload?.debug ?? null,
            citations: Array.isArray(payload?.citations) ? payload.citations : [],
            toolsUsed: Array.isArray(payload?.toolsUsed) ? payload.toolsUsed : [],
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
            isPending: false,
          }
          : turn
      )));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className={styles.pageShell}>
      <section className={styles.heroCard}>
        <div className={styles.heroCopy}>
          <p className={styles.description}>
            Ask a question in natural language and inspect exactly how the agent searched, curated evidence, and produced the answer.
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.composerForm}>
          <label className={styles.composerField}>
            <span className={styles.fieldLabel}>Prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask about a tree, node, attachment, or topic"
              className={styles.textArea}
              rows={4}
            />
          </label>
          <button type="submit" className={styles.submitButton} disabled={isSubmitting || !prompt.trim()}>
            {isSubmitting ? "Thinking..." : "Send"}
          </button>
        </form>
      </section>

      {requestError ? <p className={styles.errorMessage}>{requestError}</p> : null}

      <section className={styles.workspaceGrid}>
        <div className={`appPanelShell ${styles.chatPanel}`}>
          <div className={`appPanelTopBar ${styles.panelHeader}`}>
            <div>
              <p className={styles.panelEyebrow}>Conversation</p>
              <h2 className={styles.panelTitle}>Ask history</h2>
            </div>
          </div>

          <div ref={chatFeedRef} className={styles.chatFeed}>
            {turns.length === 0 ? (
              <div className={styles.emptyState}>
                <h3>Start a turn</h3>
                <p>The left side will show the conversation. The right side will show the debug trace for the selected turn.</p>
              </div>
            ) : (
              displayedTurns.map((turn) => {
                const isSelected = turn.id === selectedTurn?.id;

                return (
                  <article
                    key={turn.id}
                    className={`${styles.turnCard} ${isSelected ? styles.turnCardSelected : ""}`}
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

                    <div className={styles.messageBubbleUser}>
                      <p className={styles.messageLabel}>User</p>
                      <p className={styles.messageText}>{turn.question}</p>
                    </div>

                    <div className={styles.messageBubbleAgent}>
                      <p className={styles.messageLabel}>Agent</p>
                      <p className={styles.messageText}>
                        {turn.isPending ? "Waiting for response..." : turn.error ? turn.error : turn.answer || "No answer returned."}
                      </p>
                    </div>

                    {!turn.isPending && !turn.error ? <CitationBreadcrumbs citations={turn.citations} /> : null}

                    {turn.toolsUsed.length > 0 ? (
                      <div className={styles.toolChipRow}>
                        {turn.toolsUsed.map((toolName) => (
                          <span key={`${turn.id}-${toolName}`} className={styles.toolChip}>{`tool: ${toolName}`}</span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>
        </div>

        <aside className={`appPanelShell ${styles.debugPanel}`}>
          <div className={`appPanelTopBar ${styles.panelHeader}`}>
            <div>
              <p className={styles.panelEyebrow}>Debug</p>
              <h2 className={styles.panelTitle}>Turn inspector</h2>
            </div>
          </div>
          <TurnDebugPanel turn={selectedTurn} />
        </aside>
      </section>
    </main>
  );
}