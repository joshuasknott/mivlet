import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const FOLLOW_DEADZONE = 72;

function awayFromBottom(element: HTMLDivElement) {
  return element.scrollHeight > element.clientHeight + 1 && element.scrollHeight - element.scrollTop - element.clientHeight > FOLLOW_DEADZONE;
}

export function useConversationScroll(scope: string, revision: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const scrolledUp = useRef(false);
  const previousTop = useRef(0);
  const anchorTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const away = awayFromBottom(element);
    if (!away) scrolledUp.current = false;
    setShowLatest(away && scrolledUp.current);
  }, []);
  const toLatest = useCallback(() => {
    following.current = true;
    scrolledUp.current = false;
    setShowLatest(false);
    const element = scrollRef.current;
    if (element) { element.scrollTop = element.scrollHeight; previousTop.current = element.scrollTop; anchorTop.current = element.scrollTop; }
  }, []);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const away = awayFromBottom(element);
    if (away && element.scrollTop < previousTop.current - 1) scrolledUp.current = true;
    previousTop.current = element.scrollTop;
    following.current = !away;
    if (!away) anchorTop.current = element.scrollTop;
    measure();
  }, [measure]);
  const align = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !following.current) { measure(); return; }
    if (Math.abs(element.scrollTop - anchorTop.current) <= FOLLOW_DEADZONE) { toLatest(); return; }
    following.current = false;
    scrolledUp.current = true;
    measure();
  }, [measure, toLatest]);
  const pauseFollowing = useCallback(() => { following.current = false; measure(); }, [measure]);
  useLayoutEffect(toLatest, [scope, toLatest]);
  useLayoutEffect(align, [revision, align]);
  useEffect(() => {
    if (!contentRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(align);
    observer.observe(contentRef.current);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [align]);
  return { scrollRef, contentRef, onScroll, showLatest, toLatest, pauseFollowing };
}
