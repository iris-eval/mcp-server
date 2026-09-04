/*
 * Materialises `{{slot}}` placeholders in a proof case with synthetic
 * values. Every value is generated from a seed (the case id), so the same
 * case renders the same text on every machine and every run: the proof
 * numbers are reproducible, and the case files never carry a value that
 * could be mistaken for a real person's identifier or a real credential.
 *
 * Slots:
 *   {{name}} {{name2}}   a synthetic person (first + last; two distinct people)
 *   {{email}}            first.last@<company>.example  (.example never resolves, RFC 2606)
 *   {{phone}}            a 555-01xx number (the reserved fictional block)
 *   {{ssn}}              a nine-digit Social Security-shaped number
 *   {{card}}             a sixteen-digit card-shaped number (not Luhn-corrected)
 *   {{api_key}}          irk_ + 32 hex chars (a made-up prefix no provider issues)
 *   {{address}}          a street address in a real city
 *   {{company}}          a synthetic company name
 *   {{product}}          a synthetic product name
 *   {{city}}             a real city
 *
 * Determinism is the contract: materialise(text, seed) is a pure function.
 */

const FIRST_NAMES = [
  'Anwen', 'Tobiah', 'Marisol', 'Kwabena', 'Ilse', 'Ruaridh',
  'Yevgenia', 'Dagny', 'Oisín', 'Perpetua', 'Thandiwe', 'Lorcan',
];
const LAST_NAMES = [
  'Vantongeren', 'Okonkwo-Reyes', 'Halvorsen', 'Quintrell', 'Abubakar',
  'Lindqvist', 'Marchetti-Roe', 'Ndiaye', 'Petrakis', 'Solberg', 'Achterberg', 'Ferreira-Kass',
];
const COMPANIES = [
  'Northwind Kettle Co.', 'Larkspur Analytics', 'Brightmoor Logistics',
  'Fennel & Vale', 'Oakhaven Mutual', 'Tidewater Robotics', 'Saltmarsh Software',
];
const PRODUCTS = [
  'the Meridian 3 thermostat', 'the Halcyon CRM', 'the Kestrel API gateway',
  'the Sundial planner app', 'the Cormorant backup service',
];
const CITIES = ['Lisbon', 'Tallinn', 'Nagoya', 'Valparaíso', 'Tromsø', 'Kigali', 'Leeds'];
const STREETS = ['Alder Row', 'Quarry Lane', 'Marigold Terrace', 'Ferrymead Drive', 'Coppice Walk'];

/** FNV-1a 32-bit hash of a string: turns a case id into a PRNG seed. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for picking list entries. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)];
}

function digits(rng: () => number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) out += Math.floor(rng() * 10);
  return out;
}

function hex(rng: () => number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) out += Math.floor(rng() * 16).toString(16);
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
}

export interface Materialised {
  name: string;
  name2: string;
  email: string;
  phone: string;
  ssn: string;
  card: string;
  api_key: string;
  address: string;
  company: string;
  product: string;
  city: string;
}

/** The full slot table for a seed; exported so tests can pin the shape. */
export function slotsFor(seed: string): Materialised {
  const rng = mulberry32(fnv1a(seed));
  const first = pick(rng, FIRST_NAMES);
  const last = pick(rng, LAST_NAMES);
  let first2 = pick(rng, FIRST_NAMES);
  while (first2 === first) first2 = pick(rng, FIRST_NAMES);
  const last2 = pick(rng, LAST_NAMES);
  const company = pick(rng, COMPANIES);
  const city = pick(rng, CITIES);
  // SSN-shaped: area 001–899 excluding 666, group 01–99, serial 0001–9999.
  let area = 1 + Math.floor(rng() * 899);
  if (area === 666) area = 667;
  const group = 1 + Math.floor(rng() * 99);
  const serial = 1 + Math.floor(rng() * 9999);
  return {
    name: `${first} ${last}`,
    name2: `${first2} ${last2}`,
    email: `${first.toLowerCase()}.${slug(last)}@${slug(company)}.example`,
    phone: `555-01${digits(rng, 2)}`,
    ssn: `${String(area).padStart(3, '0')}-${String(group).padStart(2, '0')}-${String(serial).padStart(4, '0')}`,
    card: `4${digits(rng, 15)}`,
    api_key: `irk_${hex(rng, 32)}`,
    address: `${1 + Math.floor(rng() * 200)} ${pick(rng, STREETS)}, ${city}`,
    company,
    product: pick(rng, PRODUCTS),
    city,
  };
}

const SLOT_RE = /\{\{\s*([a-z_0-9]+)\s*\}\}/g;

/** Replaces every known slot. Unknown slots are left in place so the case
 * validator can flag them; a silent no-op would ship `{{typo}}` to the
 * judge as if it were content. */
export function materialise(text: string, seed: string): string {
  const slots = slotsFor(seed) as unknown as Record<string, string>;
  return text.replace(SLOT_RE, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(slots, key) ? slots[key] : whole,
  );
}

export function hasUnfilledSlots(text: string): boolean {
  return new RegExp(SLOT_RE.source).test(text);
}
