import { expect, it } from "vitest";
import { researchScopeFromPages } from "./hosted-research";

it("derives an exact bounded website scope without widening to sibling domains", () => {
  expect(researchScopeFromPages("https://www.example.com/release#intro\nhttps://example.com:443/notes\nhttps://www.example.com/release"))
    .toEqual({ allowedDomains: ["www.example.com", "example.com"], initialUrls: ["https://www.example.com/release", "https://example.com/notes"] });
});
it.each(["", "http://example.com/", "https://example.com:8080/", "https://user:password@example.com/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://host.internal/", "https://example.com/\n".repeat(5)])("rejects an invalid starting scope: %s", value => {
  expect(() => researchScopeFromPages(value)).toThrow();
});
