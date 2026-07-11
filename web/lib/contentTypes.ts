// Coarse content-type buckets for the Content Type filter. Each paper has exactly
// one OpenAlex work type; nodes-text.json ships the raw type per node, and we bucket
// it here so re-bucketing never needs a data rebuild.
export type ContentTypeKey = "article" | "book" | "review" | "other";

export const CONTENT_TYPE_KEYS: ContentTypeKey[] = ["article", "book", "review", "other"];

export const CONTENT_TYPE_LABELS: Record<ContentTypeKey, string> = {
  article: "Article",
  book: "Book",
  review: "Review",
  other: "Other",
};

// Map a raw OpenAlex work type to its coarse bucket. book-chapter folds into Book;
// everything not article/book/review (preprint, paratext, dataset, letter, …) is Other.
export function typeToBucket(raw: string): ContentTypeKey {
  switch (raw) {
    case "article":
      return "article";
    case "book":
    case "book-chapter":
      return "book";
    case "review":
      return "review";
    default:
      return "other";
  }
}
