import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { motionMs } from "../lib/motion";

const EXIT_MS = 260;

export function Presence({ children }: { children: ReactNode }) {
  const live = isValidElement<{ className?: string }>(children) ? children : null;
  const lastLive = useRef<ReactElement<{ className?: string }> | null>(null);
  const closing = useRef(false);
  const [, rerender] = useState(0);

  if (live) {
    lastLive.current = live;
    closing.current = false;
  } else if (lastLive.current && !closing.current) {
    closing.current = true;
  }

  useEffect(() => {
    if (live || !closing.current) return;
    const timer = window.setTimeout(() => {
      lastLive.current = null;
      closing.current = false;
      rerender((value) => value + 1);
    }, motionMs(EXIT_MS));
    return () => window.clearTimeout(timer);
  }, [!!live]);

  if (live) return live;
  if (closing.current && lastLive.current) {
    const element = lastLive.current;
    return cloneElement(element, { className: `${element.props.className ?? ""} closing`.trim() });
  }
  return null;
}
