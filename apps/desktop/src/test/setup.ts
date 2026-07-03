import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(() => {
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
});
