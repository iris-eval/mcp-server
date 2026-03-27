import Link from "next/link";

interface VocabularyCardProps {
  term: string;
  definition: string;
  href: string;
}

export function VocabularyCard({
  term,
  definition,
  href,
}: VocabularyCardProps): React.ReactElement {
  return (
    <Link
      href={href}
      className="group my-4 flex items-start gap-4 rounded-xl border border-border-default bg-bg-card px-5 py-4 no-underline transition-all hover:border-border-glow"
    >
      <span className="mt-0.5 shrink-0 rounded-md bg-iris-600/10 px-2 py-0.5 font-mono text-[12px] font-semibold text-iris-400">
        TERM
      </span>
      <div className="min-w-0">
        <p className="font-display text-[15px] font-bold text-text-primary group-hover:text-iris-400 transition-colors">
          {term}
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-text-muted line-clamp-2">
          {definition}
        </p>
      </div>
    </Link>
  );
}
