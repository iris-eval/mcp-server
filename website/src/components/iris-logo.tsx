export function IrisLogo({ size = 32, className = "" }: { size?: number; className?: string }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Outer ring */}
      <circle cx="20" cy="20" r="17" stroke="var(--iris-500)" strokeWidth="3" />
      {/* Inner iris circle */}
      <circle cx="20" cy="20" r="10" fill="var(--iris-600)" />
      {/* Pupil — deep black iris */}
      <circle cx="20" cy="20" r="4.5" fill="#0a0f0e" />
      {/* Catch light — the reflection that makes it feel alive */}
      <circle cx="17" cy="17.5" r="2" fill="white" opacity="0.6" />
    </svg>
  );
}
