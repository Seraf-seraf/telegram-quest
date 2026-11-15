export interface Page<T> {
  items: T[];
  page: number;
  totalItems: number;
  totalPages: number;
}

export const PAGE_SIZE = 5;

export function assertPageNumber(page: number): void {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError("Page number must be a positive safe integer.");
  }
}

export function pageOffset(page: number, pageSize: number): number {
  assertPageNumber(page);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("Page size must be a positive safe integer.");
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new RangeError("Page offset exceeds the safe integer range.");
  }
  return offset;
}

export function createPage<T>(items: T[], totalItems: number, requestedPage: number, pageSize: number): Page<T> {
  assertPageNumber(requestedPage);
  if (!Number.isSafeInteger(totalItems) || totalItems < 0) {
    throw new RangeError("Total item count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("Page size must be a positive safe integer.");
  }

  const totalPages = Math.ceil(totalItems / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
  return { items, page, totalItems, totalPages };
}
