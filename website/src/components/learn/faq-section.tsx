"use client";

import { useState } from "react";
import Link from "next/link";

interface FaqItem {
  question: string;
  answer: string;
  link?: { label: string; href: string };
}

interface FaqSectionProps {
  items: FaqItem[];
}

function FaqRow({ item }: { item: FaqItem }): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-border-subtle last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-4 py-5 text-left"
      >
        <span className="font-display text-[15px] font-semibold text-text-primary">
          {item.question}
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="pb-5 text-[14px] leading-relaxed text-text-secondary">
          <p>{item.answer}</p>
          {item.link && (
            <Link
              href={item.link.href}
              className="mt-2 inline-block text-iris-400 hover:text-iris-300 transition-colors"
            >
              {item.link.label} &rarr;
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export function FaqSection({ items }: FaqSectionProps): React.ReactElement {
  return (
    <div className="rounded-xl border border-border-default bg-bg-card px-6 py-2">
      {items.map((item) => (
        <FaqRow key={item.question} item={item} />
      ))}
    </div>
  );
}
