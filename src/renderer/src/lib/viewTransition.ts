import { flushSync } from "react-dom";

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

export function withViewTransition(update: () => void): void {
  const doc = document as TransitionDocument;
  if (!doc.startViewTransition || document.documentElement.classList.contains("no-anim")) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}
