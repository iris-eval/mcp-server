"use client";

import dynamic from "next/dynamic";

const PlaygroundShell = dynamic(
  () =>
    import("./playground-shell").then((m) => m.PlaygroundShell),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-iris-600 border-t-transparent" />
          <p className="mt-4 text-sm text-text-muted">Loading playground...</p>
        </div>
      </div>
    ),
  },
);

export function PlaygroundLoader() {
  return <PlaygroundShell />;
}
