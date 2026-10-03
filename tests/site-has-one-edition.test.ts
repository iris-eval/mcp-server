/*
 * The site offers one edition: the open-source server, which is all of Iris.
 *
 * No page promotes a hosted plan, a planned plan, a waitlist or a
 * certification; the signup route and the sponsor link stay out. The two
 * operator routes over the addresses the old waitlist collected stay, and
 * the privacy policy says what is still held and why.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...files(rel));
    else if (/\.(tsx?|json)$/.test(name)) out.push(relative(root, join(root, rel)).replace(/\\/g, '/'));
  }
  return out;
}

/** What a reader sees: pages and components. Not the vendors' own words on the compare pages, and not the rendered release notes. */
const pages = files('website/src').filter((f) => !f.startsWith('website/src/lib/compare/') && !f.endsWith('changelog.generated.json'));
/** The operator's routes over addresses already collected, and the policy that says they are held. */
const HOLDS_THE_OLD_LIST = /^website\/src\/(app\/api\/waitlist-(count|export)\/|lib\/(waitlist-count|admin-auth)\.ts$|app\/privacy\/page\.tsx$)/;

describe('one edition', () => {
  it('no page promotes a hosted tier, a planned plan or a waitlist', () => {
    const promoted = /Join (?:Cloud )?Waitlist|Cloud Starter|Cloud Pro|cloud tier|hosted tier|#waitlist|Not yet priced|under consideration, not under construction|pre-SOC|enterprise customers|Cloud team dashboards/i;
    // A code comment may say what was removed; nothing rendered may.
    const rendered = (f: string): string => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of pages) expect(rendered(f), f).not.toMatch(promoted);
    for (const f of pages.filter((p) => !HOLDS_THE_OLD_LIST.test(p))) expect(rendered(f), f).not.toMatch(/waitlist/i);
    expect(read('README.md')).not.toMatch(/waitlist|under consideration, not under construction/i);
  });

  it('the signup route and the sponsor link are gone; the operator routes over the old list remain', () => {
    expect(existsSync(join(root, 'website/src/app/api/waitlist/route.ts'))).toBe(false);
    expect(existsSync(join(root, '.github/FUNDING.yml'))).toBe(false);
    expect(existsSync(join(root, 'website/src/app/api/waitlist-count/route.ts'))).toBe(true);
    expect(existsSync(join(root, 'website/src/app/api/waitlist-export/route.ts'))).toBe(true);
    // An old link still lands somewhere that answers it.
    expect(read('website/next.config.ts')).toMatch(/source: "\/waitlist",\s+destination: "\/pricing"/);
  });

  it('the pricing page and the home page each show the one edition, and the pricing page answers whether there is a hosted or paid one', () => {
    const page = read('website/src/app/pricing/page.tsx');
    expect(page).toContain('data-edition={edition.name}');
    expect(page).not.toMatch(/const tiers\b/);
    expect(page).toMatch(/q: "Is there a hosted or paid version\?",\s+a: "No\. Iris is the open-source server you run yourself, with every feature in it\./);
    const home = read('website/src/components/pricing.tsx');
    expect(home).toMatch(/The open-source server is all of Iris: MIT licensed, every feature\s+included/);
    expect(home).not.toMatch(/<form\b|fetch\(/);
    expect(read('website/src/app/page.tsx')).toContain('from "@/components/pricing"');
  });

  it('the privacy policy says the form is removed, what is still held, and that the playground stores nothing', () => {
    const privacy = read('website/src/app/privacy/page.tsx');
    expect(privacy).toMatch(/The form is removed and no new addresses are collected/);
    expect(privacy).toMatch(/we still hold the email address you gave/);
    expect(privacy).toMatch(/we delete it when you ask/);
    expect(privacy).toMatch(/Playground text:<\/strong> What you paste into the live playground is sent to our server/);
    expect(privacy).not.toMatch(/when the cloud tier launches/i);
  });

  it('the security page says Iris is self-hosted and claims no certification and no customers', () => {
    const security = read('website/src/app/security/page.tsx');
    expect(security).toMatch(/Iris is self-hosted\./);
    expect(security).toMatch(/Iris itself holds no certification\./);
    expect(security).toMatch(/no compliance certification will be claimed before it is held/);
  });
});
