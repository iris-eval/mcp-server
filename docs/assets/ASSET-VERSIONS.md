# Asset Versions

The ledger of every visual asset Iris ships or is represented by — in this repo and on the surfaces outside it. Walk it whenever the brand, the tagline or the dashboard chrome moves.

Why it is this thorough: the v0.5.0 rebrand replaced the tagline in *text* on roughly nineteen surfaces and missed the *pictures*. On release day the site's share image, the GitHub social preview and the README screenshot all carried retired positioning — because the previous version of this file tracked six of the image files in the repo and none of the hosted ones. An asset this ledger does not list is an asset nobody re-checks.

**Rules**

- Every image file under git is listed below. The enumeration is `git ls-files | grep -iE '\.(png|jpg|jpeg|svg|gif|webp|ico)$'`; if it prints a path that is not in a table here, the table is wrong, not the repo.
- *Last changed* is the commit that last touched the bytes (`git log -1 --format='%h %ad' --date=short -- <path>`), not the version someone remembers.
- Externally hosted assets are not in git. Their rows say where they live, who can change them, and how their state was last verified — "not verified" is an honest state and a to-do, not a status.

## In-repo assets

### Brand marks and favicons

| Asset | Last changed | What it is | Consumed by | Status (2026-09-03) |
|---|---|---|---|---|
| `docs/assets/iris-banner.svg` | 2026-08-12 · `47efe39` · PR #346 | Repo banner, teal; the tagline is baked into a `<text>` node ("Stop shipping agents on vibes") | README hero | **Current** — carries the v0.5.0 tagline. Re-edit the text node when the tagline moves; the claims scanner does not read SVG |
| `docs/assets/iris-logo-profile.svg` | 2026-03-20 · `6492498` | Square profile mark, teal | Avatars on GitHub, X and dev.to (uploaded by hand — see the hosted table) | Current |
| `website/public/iris-logo.svg` | 2026-03-17 · `ff99021` | Site logo mark | Site nav and footer | Current |
| `website/public/iris-logo-white-bg.png` | 2026-03-20 · `818ea93` | Logo on white, for surfaces that reject transparency | Directory submissions | Current |
| `website/public/favicon-16x16.png` · `favicon-32x32.png` · `apple-touch-icon.png` · `website/src/app/favicon.ico` | 2026-03-17 · `ff99021` | Site favicons | Browser tab, iOS home screen | Current |
| `dashboard/public/favicon.svg` | 2026-03-17 · `6b29f31` | Dashboard favicon | Dashboard tab | Current |

### Share images (Open Graph) — `website/public/`

| Asset | Last changed | What it is | Consumed by | Status (2026-09-03) |
|---|---|---|---|---|
| `og-social-preview.png` | 2026-09-03 · `d666445` · PR #393 | **The** share card for every page without its own: the v0.5.0 tagline, "Score every agent output for quality, safety, and cost.", the `npx` command | `website/src/lib/og.ts` → `OG_IMAGE_URL` (cache-bust `v=4`), used by `layout.tsx` for both `openGraph.images` and `twitter.images` | **Current.** Regenerated for the v0.5.0 tagline — the 0.5.0 release shipped the retired headline in this picture for three weeks. Bump `OG_CACHE_BUST` whenever the bytes change, or link scrapers keep serving the old card |
| `og-compare-arize.png` · `-braintrust.png` · `-helicone.png` · `-langfuse.png` · `-langsmith.png` | 2026-03-18 · `5249bc1` | Per-comparison cards: "Iris vs X" plus a one-line subtitle, teal | `website/src/app/compare/<slug>/page.tsx` metadata (`openGraph.images` + `twitter.images`) | Current brand, no tagline text in the image. Not regenerated since March; if a compare page's subtitle changes, its card must be regenerated |
| `og-compare-confident-ai.png` · `-deepeval.png` · `-patronus-ai.png` | 2026-07-07 · `765e778` | Same family, regenerated with the July template | Same | Current |
| `og-playground.png` | 2026-03-19 · `c548d80` | "Can you spot the agent failure?" card | `website/src/app/playground/page.tsx` metadata | Current brand; no tagline text in the image |

### Dashboard screenshots — `docs/assets/`

| Asset | Last changed | What it is | Consumed by | Status (2026-09-03) |
|---|---|---|---|---|
| `dashboard-overview.png` | 2026-03-14 · `d4a37bd` (captured at v0.1.0) | The v0.1 dashboard: indigo palette, three-item nav, lands on a metrics chart | **README line 20** — the first visual on GitHub *and* on the npm package page, loaded from `raw.githubusercontent.com/iris-eval/mcp-server/main/docs/assets/dashboard-overview.png` (so it updates on merge, not on release) | **Stale and off-brand.** Pre-rebrand indigo, and it shows a product that no longer exists: since v0.5.0 the dashboard is teal and lands on Failures, which is what the README copy beneath the picture says. A v0.5-era capture is queued (docs owner). Until it lands, the README's first picture contradicts the README |
| `trace-list.png` | 2026-03-14 · `d4a37bd` (v0.1.0) | Trace list with filters | Nothing — no reference anywhere in the repo (grep, 2026-09-03) | Stale, orphaned. Replace together with the overview capture or delete |
| `trace-detail.png` | 2026-03-14 · `d4a37bd` (v0.1.0) | Trace detail with span tree | Nothing — orphaned | Stale, orphaned |
| `eval-results.png` | 2026-03-14 · `d4a37bd` (v0.1.0) | Evaluation results breakdown | Nothing — orphaned | Stale, orphaned |

## Externally hosted assets (not in git)

These are the pictures a stranger sees before they ever reach the repo. None of them update when the repo does.

| Asset | Where it lives / who can change it | Last known state | How to verify |
|---|---|---|---|
| GitHub repository social preview | github.com/iris-eval/mcp-server → Settings → Social preview (org owner) | **Replaced 2026-09-03** with the v0.5.0 card. Before that it carried a third tagline — neither the retired one nor the current one — through the whole 0.5.0 launch | `curl -s https://github.com/iris-eval/mcp-server \| grep -o 'og:image" content="[^"]*'` — the URL is a `repository-images.githubusercontent.com` hash; a new hash is a new card |
| GitHub organisation avatar | github.com/orgs/iris-eval → Settings → Profile | Not verified on 2026-09-03 | Should render `iris-logo-profile.svg`; open the org page |
| npm package page | npmjs.com/package/@iris-eval/mcp-server | Renders the README, so it shows `dashboard-overview.png` from `main` and inherits its staleness; no separately uploaded image | Open the page after the README screenshot is replaced |
| Glama listing | glama.ai/mcp/servers/iris-eval/mcp-server | Renders the README plus Glama's own generated summary and meta description, refreshed only by **Build & Release** + **Sync** from a signed-in maintainer | Open the page; the summary should match the README's rule count and tagline |
| mcp.so listing | mcp.so/server/iris/iris-eval — a manual submission that has never auto-synced; unclaimed as of 2026-09-03 | v0.1-era copy and logo state unknown | Open the page; fixing it is a re-submission, not a repo change |
| X @iris_eval avatar and header | The account (maintainer) | Not verified on 2026-09-03; the bio text still carried the retired tagline that day | Open the profile |
| dev.to profile avatar | dev.to/iris-eval (maintainer) | Bio text corrected 2026-09-03; the image was not verified | Open the profile |
| Official MCP Registry | registry.modelcontextprotocol.io | Text only — the description comes from `server.json`; no image | `curl -s https://registry.modelcontextprotocol.io/v0.1/servers/io.github.iris-eval%2Fmcp-server/versions/latest` |

## History

| Date | Change |
|---|---|
| 2026-09-03 | Ledger rebuilt to cover every tracked image and the hosted surfaces. `og-social-preview.png` regenerated (PR #393), GitHub social preview replaced, README screenshot recorded as stale and off-brand pending re-capture. |
| 2026-08-12 | `iris-banner.svg` re-edited for the v0.5.0 tagline (PR #346). The ledger at the time still recorded it at v0.1.2. |
| 2026-07-07 | Three compare cards regenerated (`confident-ai`, `deepeval`, `patronus-ai`). |
| 2026-03-14 → 03-20 | Teal rebrand: site cutover, favicons, logo marks, first compare cards. The four dashboard screenshots predate it and were never re-captured. |
