/**
 * Marks a `.spark-scroll-under` list with `data-scrolled` while its rows sit
 * under the header above it. The header frosts and draws its bottom hairline
 * only then (see the scroll edge in styles.css): at rest nothing is under the
 * bar, so a backdrop filter there would cost compositing for no visible
 * change, and a hairline over an unscrolled list reads as a stray rule.
 *
 * One capturing listener serves every list, since scroll events do not
 * bubble. Only the list itself or its virtualized scroller counts: a code
 * block or tool output scrolled to its own top inside a scrolled chat must
 * not clear the flag.
 */
export function installScrollEdgeTracking(): void {
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const owner = target.closest<HTMLElement>(".spark-scroll-under");
      if (!owner) return;
      if (target !== owner && target.dataset.virtuosoScroller !== "true") return;
      const scrolled = target.scrollTop > 1;
      if ((owner.dataset.scrolled === "true") === scrolled) return;
      if (scrolled) owner.dataset.scrolled = "true";
      else delete owner.dataset.scrolled;
    },
    { capture: true, passive: true },
  );
}
