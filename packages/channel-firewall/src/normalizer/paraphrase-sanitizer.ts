/**
 * @fileoverview Paraphrase-based sanitization interface for covert channel defense.
 *
 * Location: packages/channel-firewall/src/normalizer/paraphrase-sanitizer.ts
 *
 * This file defines the interface for paraphrase-based sanitization. The idea is
 * that paraphrasing text (rewriting it with the same meaning but different words)
 * can disrupt some forms of covert channel encoding by changing the specific
 * word choices, formatting, and structure that an encoder relies on.
 *
 * IMPORTANT: Paraphrasing is a cost-increaser for covert channel attacks, NOT a
 * kill shot. Robust steganographic techniques (e.g., encoding in semantic meaning
 * rather than surface form) can survive paraphrasing. This should be viewed as
 * one layer of defense-in-depth, not a complete solution.
 *
 * Consumers of this package provide their own LLM-backed implementation of this
 * interface. The channel-firewall package does not include an LLM dependency.
 *
 * Used by:
 * - ChannelFirewall when a sanitizer is provided to the constructor
 * - Consumers who want to implement LLM-based paraphrasing
 */

// =============================================================================
// PARAPHRASE SANITIZER INTERFACE
// =============================================================================

/**
 * Interface for paraphrase-based sanitization.
 * Consumers provide their own LLM implementation.
 *
 * IMPORTANT: This is a cost-increaser, not a kill shot.
 * Robust steganographic techniques survive paraphrasing.
 * Use as part of defense-in-depth, not as a sole countermeasure.
 *
 * @example
 * ```typescript
 * class MyLLMSanitizer implements ParaphraseSanitizer {
 *   async sanitize(content: string): Promise<string> {
 *     return await myLLM.paraphrase(content);
 *   }
 *   isAvailable(): boolean {
 *     return true;
 *   }
 * }
 *
 * const firewall = new ChannelFirewall(config, registry, normalizer, new MyLLMSanitizer());
 * ```
 */
export interface ParaphraseSanitizer {
  /**
   * Paraphrase the content to remove potential covert channels.
   *
   * The implementation should rewrite the content preserving semantic meaning
   * while changing surface-level properties (word choice, sentence structure,
   * formatting) that could be exploited for steganographic encoding.
   *
   * @param content - The text content to paraphrase
   * @returns Paraphrased content with equivalent meaning
   * @throws Error if paraphrasing fails (the firewall will handle gracefully)
   */
  sanitize(content: string): Promise<string>;

  /**
   * Whether this sanitizer is currently available.
   * May return false if the underlying LLM service is unreachable or
   * if rate limits have been exceeded.
   *
   * @returns true if the sanitizer can process requests
   */
  isAvailable(): boolean;
}
