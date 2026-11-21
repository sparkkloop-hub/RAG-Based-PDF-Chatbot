export interface HighlightMatchResult {
  matchedIndices: Set<number>;
  matchQuality: 'exact' | 'approximate' | 'none';
  firstMatchIndex: number;
}

function normalizeForMatch(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\u00AD/g, '') // soft hyphen
    .replace(/[\u2010-\u2015]/g, '-') // unicode dashes
    .replace(/-\s*\n\s*/g, '') // join hyphenated line breaks
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenize(input: string): string[] {
  return normalizeForMatch(input)
    .split(/[^a-z0-9\u0B80-\u0BFF]+/i)
    .filter((tok) => tok.length >= 2);
}

/**
 * Match a retrieved RAG chunk against the array of text strings from a PDF.js
 * page textContent.items list.
 *
 * Strategy:
 * 1. Build a normalized page string with a character -> itemIndex lookup table.
 * 2. Attempt exact normalized substring match (full chunk or strong anchor slice).
 * 3. If exact fails, run a fuzzy sliding-window token overlap matcher over the
 *    page spans and mark the result as 'approximate'.
 */
export function matchChunkToTextItems(
  itemStrings: string[],
  chunkText: string
): HighlightMatchResult {
  const empty: HighlightMatchResult = {
    matchedIndices: new Set<number>(),
    matchQuality: 'none',
    firstMatchIndex: -1,
  };

  const normalizedChunk = normalizeForMatch(chunkText);
  if (!normalizedChunk || itemStrings.length === 0) {
    return empty;
  }

  // Build normalized flat page string + char->item index map
  const charToItem: number[] = [];
  const flatChars: string[] = [];

  for (let i = 0; i < itemStrings.length; i++) {
    const normItem = normalizeForMatch(itemStrings[i]);
    if (!normItem) continue;

    if (flatChars.length > 0 && flatChars[flatChars.length - 1] !== ' ') {
      flatChars.push(' ');
      charToItem.push(i);
    }

    for (let c = 0; c < normItem.length; c++) {
      flatChars.push(normItem[c]);
      charToItem.push(i);
    }
  }

  const pageFlat = flatChars.join('');
  if (!pageFlat) return empty;

  const collectSpanIndices = (startPos: number, endPos: number): HighlightMatchResult => {
    const indices = new Set<number>();
    let first = -1;
    const clampedEnd = Math.min(endPos, charToItem.length);
    for (let pos = Math.max(0, startPos); pos < clampedEnd; pos++) {
      const idx = charToItem[pos];
      if (idx !== undefined && itemStrings[idx].trim().length > 0) {
        indices.add(idx);
        if (first === -1 || idx < first) first = idx;
      }
    }
    return {
      matchedIndices: indices,
      matchQuality: indices.size > 0 ? 'exact' : 'none',
      firstMatchIndex: first,
    };
  };

  // Stage 1A: Exact match of full normalized chunk
  const fullPos = pageFlat.indexOf(normalizedChunk);
  if (fullPos !== -1) {
    return collectSpanIndices(fullPos, fullPos + normalizedChunk.length);
  }

  // Stage 1B: Exact anchor match (handles minor PDF header/footer or page-edge trimming)
  if (normalizedChunk.length >= 48) {
    const anchorLen = Math.min(120, Math.floor(normalizedChunk.length * 0.6));
    const candidates = [
      normalizedChunk.slice(0, anchorLen).trim(),
      normalizedChunk
        .slice(
          Math.floor((normalizedChunk.length - anchorLen) / 2),
          Math.floor((normalizedChunk.length - anchorLen) / 2) + anchorLen
        )
        .trim(),
      normalizedChunk.slice(-anchorLen).trim(),
    ];

    for (const anchor of candidates) {
      if (anchor.length < 28) continue;
      const pos = pageFlat.indexOf(anchor);
      if (pos !== -1) {
        // Expand match window slightly around the exact anchor to cover surrounding chunk text
        const anchorOffsetInChunk = normalizedChunk.indexOf(anchor);
        const estStart = Math.max(0, pos - anchorOffsetInChunk);
        const estEnd = Math.min(pageFlat.length, estStart + normalizedChunk.length);
        // Check if endpoints share tokens; otherwise highlight the exact anchor cleanly
        const startProbe = normalizedChunk.slice(0, 24);
        const endProbe = normalizedChunk.slice(-24);
        const refinedStart = pageFlat.indexOf(startProbe, Math.max(0, estStart - 40));
        const refinedEnd = pageFlat.indexOf(endProbe, pos);

        if (
          refinedStart !== -1 &&
          refinedEnd !== -1 &&
          refinedEnd >= refinedStart &&
          refinedEnd - refinedStart <= normalizedChunk.length * 1.4
        ) {
          return collectSpanIndices(refinedStart, refinedEnd + endProbe.length);
        }
        return collectSpanIndices(pos, pos + anchor.length);
      }
    }
  }

  // Stage 2: Fuzzy sliding-window token overlap across PDF text items
  const chunkTokens = tokenize(chunkText);
  if (chunkTokens.length === 0) return empty;

  const chunkTokenSet = new Set(chunkTokens);
  const chunkBigrams = new Set<string>();
  for (let i = 0; i < chunkTokens.length - 1; i++) {
    chunkBigrams.add(`${chunkTokens[i]} ${chunkTokens[i + 1]}`);
  }

  // Build non-empty item entries with their token lists
  const spanEntries: { itemIndex: number; tokens: string[]; charLen: number }[] = [];
  for (let i = 0; i < itemStrings.length; i++) {
    const toks = tokenize(itemStrings[i]);
    if (toks.length > 0) {
      spanEntries.push({ itemIndex: i, tokens: toks, charLen: itemStrings[i].length });
    }
  }

  if (spanEntries.length === 0) return empty;

  const targetTokenCount = Math.max(8, Math.min(chunkTokens.length, 140));
  let bestScore = 0;
  let bestRange: [number, number] = [-1, -1];

  for (let start = 0; start < spanEntries.length; start++) {
    // Quick skip: start span must share at least one token with chunk
    if (!spanEntries[start].tokens.some((t) => chunkTokenSet.has(t))) {
      continue;
    }

    const windowUniqueHits = new Set<string>();
    let windowTotalTokens = 0;
    let bigramHits = 0;
    let prevToken: string | null = null;

    for (let end = start; end < spanEntries.length; end++) {
      const toks = spanEntries[end].tokens;
      windowTotalTokens += toks.length;

      for (const tok of toks) {
        if (chunkTokenSet.has(tok)) {
          windowUniqueHits.add(tok);
        }
        if (prevToken !== null && chunkBigrams.has(`${prevToken} ${tok}`)) {
          bigramHits++;
        }
        prevToken = tok;
      }

      // Compute recall + precision balanced score with bigram continuity bonus
      const recall = windowUniqueHits.size / chunkTokenSet.size;
      const precision = windowUniqueHits.size / Math.max(1, windowTotalTokens);
      const bigramBonus =
        chunkBigrams.size > 0 ? Math.min(0.25, (bigramHits / chunkBigrams.size) * 0.35) : 0;
      const score = recall * 0.6 + precision * 0.4 + bigramBonus;

      if (score > bestScore && windowUniqueHits.size >= Math.min(3, chunkTokenSet.size)) {
        bestScore = score;
        bestRange = [start, end];
      }

      if (windowTotalTokens >= targetTokenCount * 1.35) {
        break;
      }
    }
  }

  if (bestRange[0] === -1 || bestScore < 0.22) {
    return empty;
  }

  // Trim trailing non-matching spans at the edges of the best window
  let trimStart = bestRange[0];
  let trimEnd = bestRange[1];
  while (
    trimStart < trimEnd &&
    !spanEntries[trimStart].tokens.some((t) => chunkTokenSet.has(t))
  ) {
    trimStart++;
  }
  while (
    trimEnd > trimStart &&
    !spanEntries[trimEnd].tokens.some((t) => chunkTokenSet.has(t))
  ) {
    trimEnd--;
  }

  const matched = new Set<number>();
  const firstItemIdx = spanEntries[trimStart].itemIndex;
  const lastItemIdx = spanEntries[trimEnd].itemIndex;

  for (let idx = firstItemIdx; idx <= lastItemIdx; idx++) {
    if (itemStrings[idx].trim().length > 0) {
      matched.add(idx);
    }
  }

  return {
    matchedIndices: matched,
    matchQuality: matched.size > 0 ? 'approximate' : 'none',
    firstMatchIndex: firstItemIdx,
  };
}
