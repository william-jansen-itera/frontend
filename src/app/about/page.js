import Link from "next/link";
import styles from "./page.module.css";

export default function About() {
  return (
    <main className="appPageShell">
      <section className={styles.heroCard}>
        <div className="appHeroCopy">
          <p className="appEyebrow">About</p>
          <h1 className={`${styles.title} appPageTitle`}>MDS is a workspace for domains of knowledge.</h1>
          <p className="appPageDescription">
            You grow a tree of notes and attachments, inspect the material, and talk to the domain. The agent searches that tree and shows the ground under the answer. When it uses broader model knowledge, you can pull the useful part back onto a leaf.
          </p>
        </div>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Grow</p>
          <h2 className={styles.cardTitle}>Build a domain one leaf at a time</h2>
          <p className={styles.cardText}>Use Notes to shape a tree that fits the way the domain is actually organized. Leaves hold the detailed notes and attachments that become the working source material.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Generate</p>
          <h2 className={styles.cardTitle}>Draft trees, branches, and leaves faster</h2>
          <p className={styles.cardText}>From Notes, use generation to draft a full tree, extend a branch with more branches, or generate leaf notes so the domain does not have to be built entirely by hand one item at a time.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Inspect</p>
          <h2 className={styles.cardTitle}>See what the material actually says</h2>
          <p className={styles.cardText}>Use Search to inspect notes and attachments directly, review highlighted matches, and jump back into the exact branch or leaf that produced them.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Talk</p>
          <h2 className={styles.cardTitle}>Ask the domain, not a blank model</h2>
          <p className={styles.cardText}>Use Agent to ask questions against the trees you built. The answer is shaped by the material in that domain instead of relying only on broad model knowledge.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Grounding</p>
          <h2 className={styles.cardTitle}>See the ground under the answer</h2>
          <p className={styles.cardText}>When the agent uses material from the tree, it shows the grounding so you can inspect the path back to the source and judge whether the answer is well supported.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Broader answers</p>
          <h2 className={styles.cardTitle}>Use outside knowledge deliberately</h2>
          <p className={styles.cardText}>When the agent steps outside the local tree and uses broader model knowledge, that path stays explicit instead of pretending everything was grounded in your material.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Capture</p>
          <h2 className={styles.cardTitle}>Pull useful answers back onto a leaf</h2>
          <p className={styles.cardText}>When a broader answer contains something worth keeping, you can turn that result into structured knowledge by adding it back into the right place in the tree.</p>
        </article>

        <article className={styles.infoCard}>
          <p className={styles.cardEyebrow}>Access</p>
          <h2 className={styles.cardTitle}>Manage access through existing identity controls</h2>
          <p className={styles.cardText}>MDS can fit into existing Microsoft identity management instead of creating a separate user system inside the workspace. Access can be governed through Azure and aligned with the way teams are already managed.</p>
        </article>
      </section>

      <section className={styles.ctaCard}>
        <div>
          <p className={styles.cardEyebrow}>Working surfaces</p>
          <h2 className={styles.cardTitle}>Open the workspace</h2>
        </div>
        <div className={styles.ctaLinks}>
          <Link href="/notes" className={styles.ctaLink}>Open Notes</Link>
          <Link href="/search" className={styles.ctaLinkSecondary}>Open Search</Link>
          <Link href="/chat" className={styles.ctaLinkSecondary}>Open Agent</Link>
        </div>
      </section>
    </main>
  );
}
