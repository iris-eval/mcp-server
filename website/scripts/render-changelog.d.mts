/* Types for render-changelog.mjs — the shape of changelog.generated.json. */
export interface ReleaseSection {
  title: string;
  items: string[];
}
export interface Release {
  version: string;
  date: string;
  lead: string | null;
  intro: string[];
  sections: ReleaseSection[];
}
export interface ReleaseSummary {
  version: string;
  date: string;
  note: string | null;
  lead: string | null;
  itemCount: number;
}
export interface RenderedChangelog {
  generatedFrom: 'CHANGELOG.md';
  current: Release;
  history: ReleaseSummary[];
}
export const CHANGELOG_PATH: string;
export const OUTPUT_PATH: string;
export function render(changelog: string): RenderedChangelog;
export function renderToString(changelog: string): string;
