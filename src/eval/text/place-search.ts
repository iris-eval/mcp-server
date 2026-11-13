/*
 * Every place at once.
 *
 * no_injection_compliance asks of a run where the places its directives
 * named stand: in the ask, in the arguments of every call, in each reading
 * of a call that carries a copy. Asked a place at a time, that is a search
 * of the text for each place, and what a search costs is the engine's to
 * say and the text's to choose: through plain words a megabyte takes a
 * tenth of a millisecond, and through a run of the place's own characters
 * after a line of its first one 6 to 8 ms, where the engine has left its
 * fast search for a slower one. A page of 752 directives that each named a
 * path, and one call that held such a run, was 2 s of CPU for a request
 * the limit of work had charged as half a second. Charging every search
 * for the slow case would refuse what is cheap: a megabyte page saved
 * beside sixty directives is a hundred and eighty megabytes searched, and
 * a twentieth of a second of work.
 *
 * So the text is read once for all the places, by the automaton of Aho and
 * Corasick (1975): the places as a tree of their characters, and from each
 * state the state to fall back to when the next character does not go on.
 * A text of n characters takes at most 2n steps whatever the places are
 * and however many, a step is one lookup, and no input makes one step
 * dearer than another: the cost is the text's length and nothing a page
 * can arrange.
 *
 * Places are compared by UTF-16 code unit, as String.indexOf compares.
 */

/** The places of a run as one automaton: `scan` reports every place that stands in a text, each where it starts. */
export interface PlaceAutomaton {
  /** How many states the automaton has: one for each character of the places that no earlier place began with, and the start. */
  readonly states: number;
  /** Reads `text` once. `visit` is given the number of each place found (its index in the list the automaton was made from) and the offset it starts at, in the order of where each ends; a place found again inside itself is reported each time. */
  scan(text: string, visit: (place: number, start: number) => void): void;
}

/** The limit of the automaton's size: places past it are not added, and `placeAutomaton` says so. A state is a lookup's worth of memory; 262,144 of them hold eight thousand places of thirty characters that share nothing. */
export const MAX_PLACE_STATES = 262_144;

const UNITS = 0x10000;

/**
 * The automaton of `places` (distinct, none empty). `complete` is false
 * when the places together needed more than MAX_PLACE_STATES states: the
 * automaton then holds the places before the first that did not fit, and
 * a caller that needs every place has not got them.
 */
export function placeAutomaton(places: readonly string[]): PlaceAutomaton & { complete: boolean } {
  // The tree: from a state and a code unit to the next state.
  const next = new Map<number, number>();
  const parent: number[] = [0];
  const unit: number[] = [0];
  const depth: number[] = [0];
  /** The place that ends at a state, or -1. */
  const ends: number[] = [-1];
  const lengths: number[] = [];
  let complete = true;
  for (let index = 0; index < places.length; index += 1) {
    const place = places[index];
    lengths.push(place.length);
    if (parent.length + place.length > MAX_PLACE_STATES) {
      complete = false;
      break;
    }
    let state = 0;
    for (let i = 0; i < place.length; i += 1) {
      const code = place.charCodeAt(i);
      const key = state * UNITS + code;
      let to = next.get(key);
      if (to === undefined) {
        to = parent.length;
        next.set(key, to);
        parent.push(state);
        unit.push(code);
        depth.push(depth[state] + 1);
        ends.push(-1);
      }
      state = to;
    }
    if (ends[state] === -1) ends[state] = index;
  }
  const states = parent.length;
  // The states in the order of their depth: a state's fall-back is shallower than it, so it is known by then.
  const order = new Int32Array(states);
  {
    let deepest = 0;
    for (let s = 0; s < states; s += 1) if (depth[s] > deepest) deepest = depth[s];
    const from = new Int32Array(deepest + 2);
    for (let s = 0; s < states; s += 1) from[depth[s] + 1] += 1;
    for (let d = 1; d < from.length; d += 1) from[d] += from[d - 1];
    for (let s = 0; s < states; s += 1) {
      order[from[depth[s]]] = s;
      from[depth[s]] += 1;
    }
  }
  /** The state to fall back to: the longest proper suffix of what was read that some place begins with. */
  const fall = new Int32Array(states);
  /** The nearest state on the way back that ends a place, or 0: every place that ends where this state does is reached through these. */
  const ending = new Int32Array(states);
  for (let n = 1; n < states; n += 1) {
    const s = order[n];
    if (depth[s] > 1) {
      let f = fall[parent[s]];
      let to = next.get(f * UNITS + unit[s]);
      while (to === undefined && f !== 0) {
        f = fall[f];
        to = next.get(f * UNITS + unit[s]);
      }
      fall[s] = to ?? 0;
    }
    ending[s] = ends[fall[s]] !== -1 ? fall[s] : ending[fall[s]];
  }
  /** Whether some place begins with a code unit: at the start state most characters of a text are passed by this alone. */
  const begins = new Uint8Array(UNITS);
  for (let s = 1; s < states; s += 1) if (parent[s] === 0) begins[unit[s]] = 1;

  return {
    states,
    complete,
    scan(text, visit) {
      let state = 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (state === 0 && begins[code] === 0) continue;
        let to = next.get(state * UNITS + code);
        while (to === undefined && state !== 0) {
          state = fall[state];
          to = next.get(state * UNITS + code);
        }
        state = to ?? 0;
        for (let s = ends[state] !== -1 ? state : ending[state]; s !== 0; s = ending[s]) visit(ends[s], i + 1 - lengths[ends[s]]);
      }
    },
  };
}
