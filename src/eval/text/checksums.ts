/*
 * Structural checks for the three PII patterns whose shape alone is not
 * evidence of anything.
 *
 * A sixteen-digit run is not a card number, a two-letter-plus-digits token
 * is not an international bank account, and three-two-four digits are not a
 * social security number. Each of those formats carries a check that a real
 * value satisfies and an arbitrary digit run almost never does, and applying
 * it turns a shape match into a structure match.
 *
 * Two reasons this matters now rather than later. First, precision: the
 * card pattern fires on an order id, a hash prefix or a timestamp run, and
 * every such fire is a false positive a deployment has to explain away.
 * Second, the normalisation pass (arc 3, A3-2a) folds full-width and
 * circled digits into ASCII, so text that never looked like a card number
 * can become one — `①②③④…` is a sixteen-digit run after NFKC. The fold is
 * what makes evasion detectable and the checksum is what stops the fold
 * from manufacturing findings. They ship together on purpose.
 *
 * Every function here is total and side-effect free: given a string it
 * returns a boolean, and a value it cannot parse is not valid.
 */

/**
 * The Luhn check digit, as used by every major card network. Sum the digits
 * right to left, doubling every second one and subtracting nine when the
 * double exceeds nine; a valid number is divisible by ten.
 */
export function luhn(candidate: string): boolean {
  let sum = 0;
  let double = false;
  let digits = 0;
  for (let i = candidate.length - 1; i >= 0; i--) {
    const code = candidate.charCodeAt(i);
    if (code < 48 || code > 57) {
      // Separators a card number legitimately carries; anything else means
      // this was never a card number.
      if (candidate[i] === '-' || candidate[i] === ' ') continue;
      return false;
    }
    let d = code - 48;
    digits++;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  if (digits < 13 || digits > 19) return false;
  return sum % 10 === 0;
}

/**
 * ISO 13616 mod-97: move the first four characters to the end, replace each
 * letter with its position in the alphabet plus nine, and read the result as
 * one large integer; a valid account gives a remainder of one.
 */
export function iban(candidate: string): boolean {
  const s = candidate.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of part) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * The structural rules the Social Security Administration has never issued
 * against: an area of 000, 666 or 900–999; a group of 00; a serial of 0000.
 * This is not a checksum — the number carries none — but it rejects the
 * digit runs that cannot be an SSN, which is the same job.
 *
 * The canonical fake 123-45-6789 is deliberately NOT rejected here: it is a
 * real-shaped number, it is what people paste to test the detector, and the
 * rule's own comment explains why letting it through is the honest choice.
 */
export function ssnStructure(candidate: string): boolean {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(candidate.trim());
  if (!m) return false;
  const [, area, group, serial] = m;
  if (area === '000' || area === '666' || area[0] === '9') return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}
