interface SectionHeadingProps {
  id: string;
  level?: 2 | 3;
  children: React.ReactNode;
}

export function SectionHeading({
  id,
  level = 2,
  children,
}: SectionHeadingProps): React.ReactElement {
  const Tag = level === 2 ? "h2" : "h3";
  const styles =
    level === 2
      ? "mt-16 mb-6 font-display text-2xl font-extrabold tracking-tight text-text-primary md:text-3xl"
      : "mt-10 mb-4 font-display text-xl font-bold tracking-tight text-text-primary md:text-2xl";

  return (
    <Tag id={id} className={`group scroll-mt-28 ${styles}`}>
      <a
        href={`#${id}`}
        className="no-underline hover:underline decoration-iris-500/40 underline-offset-4"
      >
        {children}
        <span className="ml-2 opacity-0 transition-opacity group-hover:opacity-60 text-text-muted text-[0.6em]">
          #
        </span>
      </a>
    </Tag>
  );
}
