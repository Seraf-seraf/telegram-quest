import { describe, expect, it } from "vitest";
import { assertPageNumber, createPage, pageOffset } from "./pagination.js";

describe("pagination", () => {
  it.each([
    [0, 5, 1, 0],
    [1, 5, 1, 1],
    [5, 5, 1, 1],
    [6, 5, 2, 2],
    [11, 5, 3, 3],
    [12, 5, 3, 3],
  ])("creates bounded pages for %i items", (count, size, requestedPage, expectedPages) => {
    const result = createPage(Array.from({ length: Math.min(count, size) }), count, requestedPage, size);
    expect(result.totalPages).toBe(expectedPages);
    expect(result.page).toBe(expectedPages === 0 ? 1 : Math.min(requestedPage, expectedPages));
  });

  it("validates page numbers and calculates safe offsets", () => {
    expect(pageOffset(3, 5)).toBe(10);
    expect(() => assertPageNumber(0)).toThrow(RangeError);
    expect(() => assertPageNumber(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => pageOffset(Number.MAX_SAFE_INTEGER, 50)).toThrow(RangeError);
  });
});
