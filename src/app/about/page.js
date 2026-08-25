import Link from "next/link";
import styles from "./page.module.css";

export default function About() {
  return (
    <main className={styles.pageShell}>
      <section className={styles.heroCard}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>About</p>
          <h1 className={styles.title}>A technical workspace for tree-scoped retrieval, routing, and grounded answers.</h1>
          <p className={styles.description}>
            The solution combines a tree-based authoring surface with Azure Search, Foundry-hosted model calls, and traceable chat orchestration so content can move from structured source material to inspectable answers without leaving the same application boundary.
          </p>
        </div>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Structure</p>
          <h2 className={styles.cardTitle}>Tree-first source model</h2>
          <p className={styles.cardText}>Knowledge is partitioned into trees and nodes rather than flat documents. Parent nodes preserve navigable context, leaf nodes carry detailed notes and attachments, and breadcrumb paths remain available as part of both retrieval and answer traceability.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Tool routing</p>
          <h2 className={styles.cardTitle}>One search tool per tree</h2>
          <p className={styles.cardText}>The chat layer exposes a dedicated search tool for each accessible tree. The AI model is also used ahead of time to generate concise tool descriptions by reviewing the tree structure, breadcrumb exemplars, leaf titles, and representative attachment names so later tool selection is guided by tree-specific coverage rather than hard-coded routing rules.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Retrieval</p>
          <h2 className={styles.cardTitle}>Layered evidence gathering</h2>
          <p className={styles.cardText}>Azure Search indexes node text, attachment content, OCR output, and filtered image descriptions. The search experience can stay broad for inspection, while tool-backed retrieval intentionally uses a smaller top window so the agent receives denser evidence with less post-processing.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Architecture details</p>
          <h2 className={styles.cardTitle}>Scoped, merged, and curated</h2>
          <p className={styles.cardText}>Search execution is constrained to the trees of the active application instance, raw matches from different index fields are merged by node, and the final agent input is curated before the model answers. That keeps the runtime simpler than a fallback-heavy orchestration layer while still preserving the node lineage needed for citations.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Traceability</p>
          <h2 className={styles.cardTitle}>Inspectable answer generation</h2>
          <p className={styles.cardText}>The Ask surface can expose the original query, tool calls, curated agent input, and final model output for the latest turn. When evidence is used, citations can be rendered back into breadcrumb links so the response can be followed all the way to the originating node.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Knowledge growth</p>
          <h2 className={styles.cardTitle}>Grounded locally, broadened deliberately</h2>
          <p className={styles.cardText}>The Ask workflow distinguishes between answers grounded in local tree tools and answers produced from broader model knowledge. When a turn stays outside tool use, the application can keep that broader lane explicit; when a tool is invoked, the turn shifts back to grounded mode. That distinction is not only used for debugging. It also helps users turn broader answers into structured knowledge by adding refined leaf notes back into the correct tree, so external model knowledge can be reviewed, narrowed, and absorbed into a local domain over time.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Extensibility</p>
          <h2 className={styles.cardTitle}>Add tools with their own domain knowledge</h2>
          <p className={styles.cardText}>The application is not limited to a fixed built-in prompt. As users introduce more domains of knowledge, the system adds the corresponding tools automatically. That lets the GPT model expand its grounded toolset over time and act less like a standalone generator and more like an orchestrator over explicit knowledge-bearing tools.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Runtime split</p>
          <h2 className={styles.cardTitle}>Different surfaces, different defaults</h2>
          <p className={styles.cardText}>Notes handles maintenance, Search supports evidence inspection, and Ask focuses on grounded synthesis. Those surfaces share the same indexed corpus, but they do not have identical retrieval defaults because human browsing and model-facing tool execution benefit from different result counts and presentation tradeoffs.</p>
        </article>
      </section>

      <section className={styles.ctaCard}>
        <div>
          <p className={styles.cardEyebrow}>Working surfaces</p>
          <h2 className={styles.cardTitle}>Continue from architecture into operation</h2>
        </div>
        <div className={styles.ctaLinks}>
          <Link href="/notes" className={styles.ctaLink}>Open Notes</Link>
          <Link href="/search" className={styles.ctaLinkSecondary}>Open Search</Link>
          <Link href="/chat" className={styles.ctaLinkSecondary}>Open Ask</Link>
        </div>
      </section>
    </main>
  );
}
