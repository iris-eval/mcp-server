/*
 * What the page area shows while a page's code is arriving (#662).
 *
 * On a local dashboard that is usually a few milliseconds, so the visible
 * part fades in only after a short delay: a fast load shows nothing rather
 * than a flash. A screen reader is told at once, through a polite status
 * region, that the page is loading; the shell around it stays usable.
 */
export function RouteLoading() {
  return (
    <div className="iris-route-loading" role="status" aria-live="polite" aria-busy="true" data-route-loading="">
      <span className="iris-route-loading__bar" aria-hidden="true" />
      <span className="iris-route-loading__text">Loading page…</span>
    </div>
  );
}
