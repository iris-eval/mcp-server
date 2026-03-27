"use client";

import { useState, useEffect } from "react";

interface TocItem {
  id: string;
  label: string;
  level: 2 | 3;
}

interface TableOfContentsProps {
  items: TocItem[];
}

export function TableOfContents({
  items,
}: TableOfContentsProps): React.ReactElement {
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter(Boolean) as HTMLElement[];

    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );

    for (const heading of headings) {
      observer.observe(heading);
    }

    return () => observer.disconnect();
  }, [items]);

  return (
    <nav className="sticky top-28" aria-label="Table of contents">
      <p className="mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">
        On this page
      </p>
      <ul className="space-y-1 border-l border-border-subtle">
        {items.map((item) => {
          const isActive = activeId === item.id;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={`block border-l-2 py-1.5 text-[13px] leading-snug transition-colors ${
                  item.level === 3 ? "pl-6" : "pl-4"
                } ${
                  isActive
                    ? "border-iris-500 text-text-primary font-medium"
                    : "border-transparent text-text-muted hover:text-text-secondary hover:border-border-default"
                }`}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
