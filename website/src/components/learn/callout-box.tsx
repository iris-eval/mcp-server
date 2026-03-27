interface CalloutBoxProps {
  variant?: "definition" | "stat" | "warning";
  title?: string;
  children: React.ReactNode;
}

const VARIANTS = {
  definition: {
    border: "border-iris-500/30",
    bg: "bg-iris-500/5",
    icon: "text-iris-500",
    label: "Definition",
  },
  stat: {
    border: "border-amber-500/30",
    bg: "bg-amber-500/5",
    icon: "text-amber-500",
    label: "Key Data",
  },
  warning: {
    border: "border-red-500/30",
    bg: "bg-red-500/5",
    icon: "text-red-500",
    label: "Warning",
  },
} as const;

export function CalloutBox({
  variant = "definition",
  title,
  children,
}: CalloutBoxProps): React.ReactElement {
  const v = VARIANTS[variant];
  return (
    <div
      className={`my-8 rounded-xl border-l-4 ${v.border} ${v.bg} px-6 py-5`}
    >
      {title ? (
        <p
          className={`mb-2 font-display text-sm font-bold uppercase tracking-widest ${v.icon}`}
        >
          {title}
        </p>
      ) : (
        <p
          className={`mb-2 font-display text-[11px] font-bold uppercase tracking-[0.2em] ${v.icon}`}
        >
          {v.label}
        </p>
      )}
      <div className="text-[15px] leading-relaxed text-text-secondary">
        {children}
      </div>
    </div>
  );
}
