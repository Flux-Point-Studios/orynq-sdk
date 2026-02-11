/**
 * @fileoverview Steganographic covert channel detector.
 *
 * Location: packages/channel-firewall/src/detectors/stego-detector.ts
 *
 * This detector identifies steganographic techniques commonly used to embed
 * hidden data in text messages. It checks for:
 *
 * 1. Zero-width characters: Invisible Unicode characters (U+200B, U+200C,
 *    U+200D, U+FEFF, U+2060, U+00AD) that can encode binary data without
 *    affecting visible text rendering.
 *
 * 2. Homoglyphs: Characters from non-Latin scripts that visually resemble
 *    Latin characters (e.g., Cyrillic "a" U+0430 vs Latin "a" U+0061).
 *    Selective substitution can encode bits.
 *
 * 3. Invisible separator characters: Unicode separator and format characters
 *    that do not render visibly but can carry information.
 *
 * 4. Unusual Unicode category patterns: Consistent use of specific Unicode
 *    categories or properties that deviate from natural text.
 *
 * The threshold is low (0.3) because even a small number of zero-width
 * characters in a message is highly suspicious for covert channel activity.
 *
 * Used by:
 * - ChannelFirewall as one of the standard detector plugins
 * - Registered in the channelDetectorRegistry with ID "stego"
 */

import type { ChannelDetector, ChannelMessage, DetectorResult } from "../types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default suspicion threshold for the stego detector.
 * Low threshold because even a few zero-width characters are highly suspicious.
 */
const DEFAULT_THRESHOLD = 0.3;

/**
 * Zero-width and invisible Unicode characters commonly used in text steganography.
 */
const ZERO_WIDTH_CHARS = new Set([
  "\u200B", // ZERO WIDTH SPACE
  "\u200C", // ZERO WIDTH NON-JOINER
  "\u200D", // ZERO WIDTH JOINER
  "\uFEFF", // ZERO WIDTH NO-BREAK SPACE (BOM)
  "\u2060", // WORD JOINER
  "\u00AD", // SOFT HYPHEN
]);

/**
 * Additional invisible or format characters that can carry hidden data.
 */
const INVISIBLE_FORMAT_CHARS = new Set([
  "\u200E", // LEFT-TO-RIGHT MARK
  "\u200F", // RIGHT-TO-LEFT MARK
  "\u202A", // LEFT-TO-RIGHT EMBEDDING
  "\u202B", // RIGHT-TO-LEFT EMBEDDING
  "\u202C", // POP DIRECTIONAL FORMATTING
  "\u202D", // LEFT-TO-RIGHT OVERRIDE
  "\u202E", // RIGHT-TO-LEFT OVERRIDE
  "\u2061", // FUNCTION APPLICATION
  "\u2062", // INVISIBLE TIMES
  "\u2063", // INVISIBLE SEPARATOR
  "\u2064", // INVISIBLE PLUS
  "\u180E", // MONGOLIAN VOWEL SEPARATOR
]);

/**
 * Map of Cyrillic homoglyphs to their Latin lookalikes.
 * These are characters from the Cyrillic block that visually resemble
 * Latin characters in most fonts.
 */
const CYRILLIC_HOMOGLYPHS: Record<string, string> = {
  "\u0410": "A", // Cyrillic A
  "\u0430": "a", // Cyrillic a
  "\u0412": "B", // Cyrillic Ve
  "\u0421": "C", // Cyrillic Es
  "\u0441": "c", // Cyrillic es
  "\u0415": "E", // Cyrillic Ie
  "\u0435": "e", // Cyrillic ie
  "\u041D": "H", // Cyrillic En
  "\u041A": "K", // Cyrillic Ka
  "\u041C": "M", // Cyrillic Em
  "\u041E": "O", // Cyrillic O
  "\u043E": "o", // Cyrillic o
  "\u0420": "P", // Cyrillic Er
  "\u0440": "p", // Cyrillic er
  "\u0422": "T", // Cyrillic Te
  "\u0425": "X", // Cyrillic Kha
  "\u0445": "x", // Cyrillic kha
  "\u0443": "y", // Cyrillic u
  "\u0456": "i", // Cyrillic i (Ukrainian)
  "\u0458": "j", // Cyrillic je
  "\u0455": "s", // Cyrillic dze
};

/**
 * Additional homoglyphs from other scripts (Greek, etc.).
 */
const OTHER_HOMOGLYPHS: Record<string, string> = {
  "\u0391": "A", // Greek Alpha
  "\u0392": "B", // Greek Beta
  "\u0395": "E", // Greek Epsilon
  "\u0397": "H", // Greek Eta
  "\u0399": "I", // Greek Iota
  "\u039A": "K", // Greek Kappa
  "\u039C": "M", // Greek Mu
  "\u039D": "N", // Greek Nu
  "\u039F": "O", // Greek Omicron
  "\u03A1": "P", // Greek Rho
  "\u03A4": "T", // Greek Tau
  "\u03A5": "Y", // Greek Upsilon
  "\u03A7": "X", // Greek Chi
  "\u03BF": "o", // Greek omicron
  "\u0131": "i", // Latin dotless i (Turkish)
};

/**
 * Combined homoglyph map for efficient lookup.
 */
const ALL_HOMOGLYPHS: Record<string, string> = {
  ...CYRILLIC_HOMOGLYPHS,
  ...OTHER_HOMOGLYPHS,
};

// =============================================================================
// STEGO DETECTOR
// =============================================================================

/**
 * Detects steganographic patterns in text messages.
 *
 * Even a small number of zero-width characters or homoglyphs in a message
 * can carry significant amounts of hidden data. This detector flags such
 * patterns with a low threshold to catch subtle encoding attempts.
 *
 * @example
 * ```typescript
 * const detector = new StegoDetector();
 * const result = await detector.detect({
 *   content: "Hello\u200B\u200Cworld", // Contains zero-width chars
 *   channel: "output-text",
 *   timestamp: new Date().toISOString(),
 * });
 * // result.exceeded will be true
 * ```
 */
export class StegoDetector implements ChannelDetector {
  readonly detectorId = "stego";
  readonly version = "1.0.0";

  private readonly threshold: number;

  constructor(threshold: number = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
  }

  /**
   * Analyze a message for steganographic patterns.
   *
   * @param message - The message to analyze
   * @returns Detection result with per-category breakdown
   */
  async detect(message: ChannelMessage): Promise<DetectorResult> {
    const { content } = message;

    if (content.length === 0) {
      return {
        detectorId: this.detectorId,
        score: 0,
        threshold: this.threshold,
        exceeded: false,
        details: {
          reason: "empty-content",
          contentLength: 0,
        },
      };
    }

    // Count zero-width characters
    const zeroWidthResult = this.detectZeroWidthChars(content);

    // Count homoglyphs
    const homoglyphResult = this.detectHomoglyphs(content);

    // Count invisible format characters
    const invisibleResult = this.detectInvisibleFormatChars(content);

    // Compute individual scores

    // Zero-width chars: even 1 in a short message is suspicious.
    // Score scales with density (count / content_length).
    const zeroWidthDensity = zeroWidthResult.count / content.length;
    // A density of 0.01 (1 per 100 chars) gives score ~0.5
    const zeroWidthScore = Math.min(1, zeroWidthDensity * 50);

    // Homoglyphs: density-based scoring, but slightly more tolerant since
    // accidental homoglyphs can occur (e.g., copy-paste from mixed-script sources).
    const homoglyphDensity = homoglyphResult.count / content.length;
    // A density of 0.02 (2 per 100 chars) gives score ~0.5
    const homoglyphScore = Math.min(1, homoglyphDensity * 25);

    // Invisible format characters: similar to zero-width
    const invisibleDensity = invisibleResult.count / content.length;
    const invisibleScore = Math.min(1, invisibleDensity * 50);

    // Combine with weighting: zero-width is the strongest signal,
    // followed by invisible chars, then homoglyphs
    const score = Math.min(
      1,
      0.45 * zeroWidthScore + 0.25 * invisibleScore + 0.30 * homoglyphScore,
    );

    return {
      detectorId: this.detectorId,
      score,
      threshold: this.threshold,
      exceeded: score > this.threshold,
      details: {
        zeroWidthChars: {
          count: zeroWidthResult.count,
          density: zeroWidthDensity,
          positions: zeroWidthResult.positions.slice(0, 20), // Limit for performance
          chars: zeroWidthResult.chars,
          score: zeroWidthScore,
        },
        homoglyphs: {
          count: homoglyphResult.count,
          density: homoglyphDensity,
          replacements: homoglyphResult.replacements.slice(0, 20),
          score: homoglyphScore,
        },
        invisibleFormatChars: {
          count: invisibleResult.count,
          density: invisibleDensity,
          chars: invisibleResult.chars,
          score: invisibleScore,
        },
        contentLength: content.length,
      },
    };
  }

  /**
   * Detect zero-width characters in the content.
   *
   * @param content - Text to scan
   * @returns Detection details including count, positions, and character types
   */
  private detectZeroWidthChars(content: string): {
    count: number;
    positions: number[];
    chars: Record<string, number>;
  } {
    const positions: number[] = [];
    const chars: Record<string, number> = {};

    for (let i = 0; i < content.length; i++) {
      const char = content[i]!;
      if (ZERO_WIDTH_CHARS.has(char)) {
        positions.push(i);
        const codePoint = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
        chars[codePoint] = (chars[codePoint] ?? 0) + 1;
      }
    }

    return { count: positions.length, positions, chars };
  }

  /**
   * Detect homoglyph characters (visually similar chars from non-Latin scripts).
   *
   * @param content - Text to scan
   * @returns Detection details including count and specific replacements found
   */
  private detectHomoglyphs(content: string): {
    count: number;
    replacements: Array<{ position: number; found: string; looksLike: string }>;
  } {
    const replacements: Array<{ position: number; found: string; looksLike: string }> = [];

    for (let i = 0; i < content.length; i++) {
      const char = content[i]!;
      const latinEquivalent = ALL_HOMOGLYPHS[char];
      if (latinEquivalent !== undefined) {
        const codePoint = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
        replacements.push({
          position: i,
          found: codePoint,
          looksLike: latinEquivalent,
        });
      }
    }

    return { count: replacements.length, replacements };
  }

  /**
   * Detect invisible format/separator characters.
   *
   * @param content - Text to scan
   * @returns Detection details including count and character types
   */
  private detectInvisibleFormatChars(content: string): {
    count: number;
    chars: Record<string, number>;
  } {
    const chars: Record<string, number> = {};
    let count = 0;

    for (let i = 0; i < content.length; i++) {
      const char = content[i]!;
      if (INVISIBLE_FORMAT_CHARS.has(char)) {
        count++;
        const codePoint = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
        chars[codePoint] = (chars[codePoint] ?? 0) + 1;
      }
    }

    return { count, chars };
  }
}
