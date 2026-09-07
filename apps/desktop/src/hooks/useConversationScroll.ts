import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export function useConversationScroll(scope: string, revision: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const scrolledUp = useRef(false);
  const previousTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const away = element.scrollHeight > element.clientHeight + 1 && element.scrollHeight - element.scrollTop - element.clientHeight > 72;
    if (!away) scrolledUp.current = false;
    setShowLatest(away && scrolledUp.current);
  }, []);
  const toLatest = useCallback(() => {
    following.current = true;
    scrolledUp.current = false;
    setShowLatest(false);
    const element = scrollRef.current;
    if (element) { element.scrollTop = element.scrollHeight; previousTop.current = element.scrollTop; }
  }, []);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const away = element.scrollHeight > element.clientHeight + 1 && element.scrollHeight - element.scrollTop - element.clientHeight > 72;
    if (away && element.scrollTop < previousTop.current - 1) scrolledUp.current = true;
    previousTop.current = element.scrollTop;
    following.current = !away;
    measure();
  }, [measure]);
  const pauseFollowing = useCallback(() => { following.current = false; measure(); }, [measure]);
  useLayoutEffect(toLatest, [scope, toLatest]);
  useLayoutEffect(() => {
    if (following.current) toLatest();
    else measure();
  }, [revision, toLatest, measure]);
  useEffect(() => {
    if (!contentRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (following.current) toLatest(); else measure(); });
    observer.observe(contentRef.current);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [toLatest, measure]);
  return { scrollRef, contentRef, onScroll, showLatest, toLatest, pauseFollowing };
}
