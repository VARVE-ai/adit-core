import type { AttributionEvidence } from "./attribution-evidence-store.js";
import { jsonTextValue, tokenOverlap, wordTokens } from "./attribution-evidence.js";

export type AttributionMatch = { e: AttributionEvidence; method: string; score: number };

/** Built for one file's selected write records. Unlocated fallback has a separate
 * index, shared only by files with no path evidence in the current commit. */
export class AttributionMatchIndex {
  private exact = new Map<string, AttributionEvidence[]>();
  private values = new Map<string, AttributionEvidence[]>();
  private tokens = new Map<string, Set<string>>();
  private postings = new Map<string, Set<string>>();

  constructor(records: Iterable<AttributionEvidence>, remember: (record: AttributionEvidence) => void = () => {}) {
    for (const evidence of records) {
      if (evidence.kind === "file_write") continue;
      remember(evidence);
      const matches = this.exact.get(evidence.text) || [];
      matches.push(evidence);
      this.exact.set(evidence.text, matches);
      const value = jsonTextValue(evidence.text);
      if (value) {
        const same = this.values.get(value) || [];
        same.push(evidence); this.values.set(value, same);
      }
      if (!this.tokens.has(evidence.text)) {
        const words = wordTokens(evidence.text);
        this.tokens.set(evidence.text, words);
        for (const word of words) {
          const posting = this.postings.get(word) || new Set<string>();
          posting.add(evidence.text); this.postings.set(word, posting);
        }
      }
    }
  }

  matching(text: string): AttributionMatch[] {
    const exact = this.exact.get(text) || [];
    if (exact.length) return exact.map(e => ({ e, method: "exact", score: 1 }));
    const value = jsonTextValue(text);
    return value ? [...(this.values.get(value) || []), ...(this.exact.get(value) || [])]
      .map(e => ({ e, method: "json_value", score: 1 })) : [];
  }

  approximate(text: string): AttributionMatch[] {
    const words = wordTokens(text), matches = new Set<string>(), result: AttributionMatch[] = [];
    const rare = [...words].sort((a, b) => (this.postings.get(a)?.size || 0) - (this.postings.get(b)?.size || 0))
      .slice(0, Math.floor(words.size * 0.1) + 1);
    for (const word of rare)
      for (const candidate of this.postings.get(word) || []) matches.add(candidate);
    for (const candidate of matches) {
      const other = this.tokens.get(candidate)!;
      if (Math.min(words.size, other.size) / Math.max(words.size, other.size) < 0.9) continue;
      const score = tokenOverlap(words, other);
      if (score < 0.9) continue;
      for (const e of this.exact.get(candidate) || []) result.push({ e, method: "token_overlap", score });
    }
    return result;
  }
}
