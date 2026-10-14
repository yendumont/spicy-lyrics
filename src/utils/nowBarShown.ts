import Global from "../components/Global/Global.ts";
import { PageContainer } from "../components/Pages/PageView.ts";

/**
 * Whether the Now Bar is on screen right now. This is not the saved "Now Bar open" setting:
 * Fullscreen shows the Now Bar without saving it as open, so with the setting off the cover
 * is still there in Fullscreen and things placed in it must follow what is shown.
 */
export const nowBarShown = (): boolean => !!PageContainer?.classList.contains("NowBarStatus__Open");

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let watching: HTMLElement | null = null;
let last = false;

function check(): void {
  const now = nowBarShown();
  if (now === last) return;
  last = now;
  for (const callback of listeners) callback();
}

/** Follows whichever page element is current; the page can be closed and rebuilt. */
function attach(): void {
  if (!PageContainer || PageContainer === watching) {
    check();
    return;
  }
  observer?.disconnect();
  watching = PageContainer;
  observer = new MutationObserver(check);
  observer.observe(PageContainer, { attributes: true, attributeFilter: ["class"] });
  check();
}

/** Run `callback` when the Now Bar appears or goes away. */
export function onNowBarShownChange(callback: () => void): void {
  const first = listeners.size === 0;
  listeners.add(callback);
  if (!first) return;

  last = nowBarShown();
  for (const event of ["page:open", "fullscreen:open", "fullscreen:exit"]) Global.Event.listen(event, attach);
  attach();
}
