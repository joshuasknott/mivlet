import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const FOLLOW_DEADZONE = 72;
const viewPositions = new Map<string, { top: number; following: boolean }>();

function awayFromBottom(element: HTMLDivElement) {
  return element.scrollHeight > element.clientHeight + 1 && element.scrollHeight - element.scrollTop - element.clientHeight > FOLLOW_DEADZONE;
}

export function useConversationScroll(scope: string, revision: unknown, remember = false) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const scrolledUp = useRef(false);
  const previousTop = useRef(0);
  const anchorTop = useRef(0);
  const restoring = useRef<number | null>(null);
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
    if (remember) viewPositions.set(scope, { top: element.scrollTop, following: following.current });
    if (!away) anchorTop.current = element.scrollTop;
    measure();
  }, [measure, remember, scope]);
  const align = useCallback(() => {
    const element = scrollRef.current;
    if (element && restoring.current !== null && element.scrollHeight > element.clientHeight) {
      element.scrollTop = restoring.current;
      previousTop.current = element.scrollTop;
      anchorTop.current = element.scrollTop;
      restoring.current = null;
    }
    if (!element || !following.current) { measure(); return; }
    if (Math.abs(element.scrollTop - anchorTop.current) <= FOLLOW_DEADZONE) { toLatest(); return; }
    following.current = false;
    scrolledUp.current = true;
    measure();
  }, [measure, toLatest]);
  const pauseFollowing = useCallback(() => { following.current = false; measure(); }, [measure]);
  useLayoutEffect(() => {
    const saved = remember ? viewPositions.get(scope) : undefined;
    if (saved && !saved.following) {
      following.current = false; scrolledUp.current = true; restoring.current = saved.top; align();
    } else toLatest();
    return () => { const element = scrollRef.current; if (remember && element) viewPositions.set(scope, { top: element.scrollTop, following: following.current }); };
  }, [scope, remember, toLatest, align]);
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
