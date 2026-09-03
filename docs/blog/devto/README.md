# Dev.to syndication snapshots

**This directory is a non-canonical snapshot. Nothing reads it.** The cross-post
workflow (`.github/workflows/devto-crosspost.yml`, which runs
`scripts/devto-crosspost.mjs`) reads only the canonical posts matching
`docs/blog/0**.md`; the files here are never consumed by that workflow, the website,
or any other build step. Correcting a post here changes nothing anywhere.

These files are **frozen copies of what was actually published to Dev.to** (with
`canonical_url` pointing back at iris-eval.com). They are a historical record of
the syndicated posts, not living documents:

- **Do not update them** when the canonical posts under `docs/blog/` change —
  the mirror's job is to record what went out, drift and all.
- New corrections happen on the canonical post (with an editor's note per the
  house style), and — if worth propagating — as an edit on Dev.to itself,
  after which the snapshot here may be refreshed to match what is live there.

The hardcoded-claim scanner allow-lists stale counts in this directory for
exactly this reason (see `scripts/claims/allow-list.json`).
