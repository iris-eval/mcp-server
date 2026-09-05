import Link from "next/link";
import { EVALUATORS, PUBLIC_REPO_URL, type ProofClaims } from "@/lib/claims";

/*
 * The arc-2 blocks of the proof page. Each renders two-state from the same
 * truthbase field: measured (the block is present in `.claims.json → proof`)
 * or pending (it is not), and in both states names the file a release roll
 * regenerates and the command that reproduces it. No number here is typed;
 * every one is read from the block, and the file link beside it is the
 * measurement the claims law requires.
 */

const code = "rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[13px] text-text-primary";
const link = "font-semibold text-text-accent hover:underline";
const h2 = "mb-3 font-display text-xl font-bold text-text-primary";
const th = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted";
const td = "px-3 py-2 align-middle font-mono text-[13px] tabular-nums text-text-secondary";

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
const ci = (i: [number, number] | null | undefined): string => (i ? `[${(i[0] * 100).toFixed(1)}, ${(i[1] * 100).toFixed(1)}]` : "");

function FileLink({ path, label }: { path: string; label?: string }): React.ReactElement {
  return (
    <a href={`${PUBLIC_REPO_URL}/blob/main/${path}`} className={`${link} font-mono text-[13px]`} rel="noopener noreferrer" target="_blank">
      {label ?? path}
    </a>
  );
}

function Pending({ what, command, file }: { what: string; command: string; file: string }): React.ReactElement {
  return (
    <p className="mt-3 rounded-xl border border-border-default bg-bg-card p-4 text-[14px] leading-relaxed text-text-secondary">
      <strong className="text-text-primary">Pending.</strong> {what} is not in the truthbase for this release. It is produced by{" "}
      <code className={code}>{command}</code> and committed as <FileLink path={file} />; when a release roll carries it, this block renders the numbers.
    </p>
  );
}

export function VerdictMeasured({ proof }: { proof: ProofClaims }): React.ReactElement {
  const c = proof.composite;
  return (
    <section>
      <h2 className={h2}>The verdict, measured</h2>
      <p>
        A gate does not key on a rule; it keys on <code className={code}>passed</code>, the verdict the composer makes from every rule that ran. The composite corpus scores that verdict: the 24 real transcripts, promoted as they are, plus cases composed by splicing a rule family&rsquo;s case into a clean transcript so the failure classes present are true by construction. It scores the risk composer that has decided <code className={code}>passed</code> since 0.10.0 beside the arithmetic that decided it before, on the same rule results, so the change is readable rather than asserted.
      </p>
      {c ? (
        <>
          <div className="mt-4 overflow-x-auto rounded-xl border border-border-default bg-bg-card">
            <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-border-default">
                  <th scope="col" className={th}>Split</th>
                  <th scope="col" className={th}>Composer</th>
                  <th scope="col" className={th}>Accuracy vs should-ship (95% CI)</th>
                  <th scope="col" className={th}>False blocks on clean</th>
                  <th scope="col" className={th}>Missed blocks</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["test", "test"],
                    ["real transcripts", "realTranscripts"],
                  ] as const
                ).flatMap(([label, split]) =>
                  (
                    [
                      ["legacy", c.legacy],
                      [`risk, ${c.method.priorMode} prior`, c.risk],
                    ] as const
                  ).map(([name, slices]) => {
                    const s = slices[split];
                    return (
                      <tr key={`${split}-${name}`} className="border-b border-border-subtle last:border-b-0">
                        <td className={td}>{label}</td>
                        <td className={td}>{name}</td>
                        <td className={td}>
                          {pct(s.accuracy.rate)} {ci(s.accuracy.ci95)} <span className="text-text-muted">n={s.accuracy.n}</span>
                        </td>
                        <td className={td}>
                          {pct(s.falseBlock.rate)} <span className="text-text-muted">n={s.falseBlock.n}</span>
                        </td>
                        <td className={td}>
                          {pct(s.missedBlock.rate)} <span className="text-text-muted">n={s.missedBlock.n}</span>
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
            Difference from legacy on the test split, risk composer with the {c.method.priorMode} prior:{" "}
            <span className="font-mono text-[13px] text-text-primary">
              {c.difference.risk.test ? `${(c.difference.risk.test.delta * 100).toFixed(1)} points [${(c.difference.risk.test.lo * 100).toFixed(1)}, ${(c.difference.risk.test.hi * 100).toFixed(1)}]` : "—"}
            </span>{" "}
            (Newcombe 95%). An interval that straddles zero says the corpus cannot yet tell the two apart. Read per class, the plan&rsquo;s prior blocks nearly every clean case; read per output it holds the legacy false-block rate — both readings are in the file, and which one ships is a decision the numbers inform. Cases: {c.counts.cases} ({c.counts.realTranscripts} real transcripts, {c.counts.composed} composed; {c.counts.dev} dev / {c.counts.test} test by a hash of the id). Composite <span className="font-mono">{c.compositeVersion}</span> ·{" "}
            <FileLink path="proof/COMPOSITE.md" /> · <FileLink path="proof/composite-results.json" /> ·{" "}
            <code className={code}>npm run proof -- --composite</code>.
          </p>
        </>
      ) : (
        <Pending what="The composite measurement" command="npm run proof -- --composite" file="proof/composite-results.json" />
      )}
    </section>
  );
}

export function Transforms({ proof }: { proof: ProofClaims }): React.ReactElement {
  const t = proof.transforms;
  const rules = t ? [...new Set(t.rows.map((r) => r.rule))] : [];
  return (
    <section>
      <h2 className={h2}>The evasions a leak arrives in</h2>
      <p>
        The three critical rules match text. For every positive a rule caught with a span into the raw output, the text inside the span is transformed — a zero-width space, Cyrillic homoglyphs, fullwidth forms, a no-break space, a tab, a line break, swapped case — and the rule is run again. Recall per transform is the share still caught; a case the rule missed in the clear is not counted, and a transform that does not apply to a span (no letters to swap, no space to replace) is not counted for that case.
      </p>
      {t ? (
        <>
          <div className="mt-4 overflow-x-auto rounded-xl border border-border-default bg-bg-card">
            <table className="w-full min-w-[720px] border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-border-default">
                  <th scope="col" className={th}>Rule</th>
                  {t.transforms.map((x) => (
                    <th key={x.id} scope="col" className={th}>
                      {x.id.replace("_", " ")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule} className="border-b border-border-subtle last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-mono text-[13px] font-medium text-text-primary">
                      {rule}
                    </th>
                    {t.transforms.map((x) => {
                      const row = t.rows.find((r) => r.rule === rule && r.transform === x.id);
                      return (
                        <td key={x.id} className={td} title={row ? `${row.caught} of ${row.n} still caught ${ci(row.ci95)}` : undefined}>
                          {row && row.n > 0 ? (
                            <>
                              {pct(row.recall)} <span className="text-text-muted">n={row.n}</span>
                            </>
                          ) : (
                            "n/a"
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[13px] text-text-muted">
            Per-transform intervals and the dropped case ids are in <FileLink path="proof/RESULTS.md" /> (<FileLink path="proof/results.json" label="results.json → transforms" />). The table measures the rules as shipped; a normalisation pass that changes it will change these numbers.
          </p>
        </>
      ) : (
        <Pending what="The transforms table" command="npm run proof" file="proof/results.json" />
      )}
    </section>
  );
}

export function ByEntity({ proof }: { proof: ProofClaims }): React.ReactElement {
  const e = proof.entities?.find((x) => x.rule === "no_pii");
  return (
    <section>
      <h2 className={h2}>
        What <code className={code}>no_pii</code> finds, by entity
      </h2>
      <p>
        Every positive in the PII family names what it contains — by the case author, never by the detector. Per entity: <em>present</em> (cases containing it), <em>caught</em> (the rule failed the case for any reason), <em>named</em> (the rule&rsquo;s evidence named this entity). The vocabulary includes things the rule&rsquo;s definition does not cover, so a gap shows as a row with named 0 rather than as silence, and a case caught for another reason shows as the difference between caught and named.
      </p>
      {e ? (
        <div className="mt-4 overflow-x-auto rounded-xl border border-border-default bg-bg-card">
          <table className="w-full min-w-[520px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-border-default">
                <th scope="col" className={th}>Entity</th>
                <th scope="col" className={th}>Present</th>
                <th scope="col" className={th}>Caught</th>
                <th scope="col" className={th}>Named</th>
                <th scope="col" className={th}>Recall (95% CI)</th>
              </tr>
            </thead>
            <tbody>
              {e.rows.map((r) => (
                <tr key={r.entity} className="border-b border-border-subtle last:border-b-0">
                  <th scope="row" className="px-3 py-2 text-left font-mono text-[13px] font-medium text-text-primary">
                    {r.entity}
                  </th>
                  <td className={td}>{r.present}</td>
                  <td className={td}>{r.caught}</td>
                  <td className={td}>{r.named}</td>
                  <td className={td}>
                    {pct(r.recall)} {ci(r.ci95)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Pending what="The per-entity table" command="npm run proof" file="proof/results.json" />
      )}
    </section>
  );
}

export function CustomTypes({ proof }: { proof: ProofClaims }): React.ReactElement {
  const c = proof.custom;
  return (
    <section>
      <h2 className={h2}>Custom rule types — conformance</h2>
      <p>
        A custom rule is your own constraint, so its accuracy is whether the type does what its documented definition says under a declared config. One family per type, run through the same factory <code className={code}>custom_rules</code> and deployed rules go through; a disagreement here is a rule defect or a definition error, never an opinion.
      </p>
      {c ? (
        <div className="mt-4 overflow-x-auto rounded-xl border border-border-default bg-bg-card">
          <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-border-default">
                <th scope="col" className={th}>Type</th>
                <th scope="col" className={th}>Config</th>
                <th scope="col" className={th}>n</th>
                <th scope="col" className={th}>Skipped</th>
                <th scope="col" className={th}>Precision (95% CI)</th>
                <th scope="col" className={th}>Recall (95% CI)</th>
              </tr>
            </thead>
            <tbody>
              {c.types.map((t) => (
                <tr key={t.type} className="border-b border-border-subtle last:border-b-0">
                  <th scope="row" className="px-3 py-2 text-left font-mono text-[13px] font-medium text-text-primary">
                    {t.type}
                  </th>
                  <td className={`${td} whitespace-nowrap`}>{JSON.stringify(t.config)}</td>
                  <td className={td}>{t.n}</td>
                  <td className={td}>{t.skipped}</td>
                  <td className={td}>
                    {pct(t.precision)} {ci(t.ci95.precision)}
                  </td>
                  <td className={td}>
                    {pct(t.recall)} {ci(t.ci95.recall)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Pending what="The conformance table" command="npm run proof" file="proof/results.json" />
      )}
      {c ? (
        <p className="mt-3 text-[13px] text-text-muted">
          Families: <FileLink path="proof/corpus/custom" label="proof/corpus/custom/<type>.json" />. The <code className={code}>json_schema</code> family&rsquo;s definition says the schema is not consulted in this version; its cases are labelled by that.
        </p>
      ) : null}
    </section>
  );
}

export function EvaluatorOfEvaluators(): React.ReactElement {
  const m = EVALUATORS;
  return (
    <section>
      <h2 className={h2}>Evaluator of evaluators</h2>
      <p>
        Thirteen trust questions — does it work, when does it fail, what does it measure, is it calibrated, can it be gamed, can it produce false confidence, and seven more — asked of every evaluator Iris ships: the built-in rules, the custom rule types, the judge templates, the citation verifier and the verdict composer. Every cell is derived from the committed proof files by a generator, never typed; a cell reads <em>measured</em> only when a number for it exists and the evidence names the file.
      </p>
      {m ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              { k: "Evaluators", v: String(m.counts.evaluators) },
              { k: "Questions each", v: String(m.counts.questions) },
              { k: "≥ 3 questions measured", v: `${m.counts.measuredThreeOrMore} / ${m.counts.evaluators}` },
            ].map((t) => (
              <div key={t.k} className="rounded-xl border border-border-default bg-bg-card p-4">
                <dt className="text-[11px] font-bold uppercase tracking-[0.15em] text-text-muted">{t.k}</dt>
                <dd className="mt-1 font-mono text-xl font-semibold text-text-primary">{t.v}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-4 list-disc space-y-1 pl-6 text-[14px] text-text-secondary">
            {m.groups.map((g) => (
              <li key={g.id}>
                <span className="capitalize">{g.text}</span>: {m.counts.byGroup[g.id].measuredThreeOrMore} of {m.counts.byGroup[g.id].evaluators} with three or more questions measured
                {g.id === "judge" || g.id === "citations" ? " — measurable, pending a judge key that you or the maintainer supplies" : ""}.
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] text-text-muted">
            The full matrix with the evidence per cell: <FileLink path="docs/evaluators.md" />. Regenerated by <code className={code}>npm run claims:generate</code> and <code className={code}>npm run llms:render</code> at every release.
          </p>
        </>
      ) : (
        <Pending what="The matrix" command="npm run claims:generate" file=".claims.json" />
      )}
    </section>
  );
}

export function ArcTwoSections({ proof }: { proof: ProofClaims | null }): React.ReactElement | null {
  if (!proof) return null;
  return (
    <>
      <VerdictMeasured proof={proof} />
      <Transforms proof={proof} />
      <ByEntity proof={proof} />
      <CustomTypes proof={proof} />
      <EvaluatorOfEvaluators />
      <p className="text-[13px] text-text-muted">
        Related:{" "}
        <Link href="/capabilities" className={link}>
          the capability map
        </Link>{" "}
        says what Iris can judge; this page says how well.
      </p>
    </>
  );
}
