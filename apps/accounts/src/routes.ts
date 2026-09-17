export function accountRoute(pathname: string) {
  if (pathname === "/oauth-consent") return "consent";
  if (pathname === "/sign-up" || pathname.startsWith("/sign-up/"))
    return "sign-up";
  if (pathname === "/sign-in" || pathname.startsWith("/sign-in/"))
    return "sign-in";
  if (pathname === "/" || pathname === "/complete") return "complete";
  return "not-found";
}
