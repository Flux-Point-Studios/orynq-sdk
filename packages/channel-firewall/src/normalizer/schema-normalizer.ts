/**
 * @fileoverview Schema-based message normalizer for covert channel defense.
 *
 * Location: packages/channel-firewall/src/normalizer/schema-normalizer.ts
 *
 * This file implements constrained normalization of messages to reduce the
 * bandwidth available for covert channel encoding. By normalizing aspects
 * of messages that should not carry information (field ordering, whitespace,
 * casing), we reduce the number of degrees of freedom an encoder can exploit.
 *
 * Normalization rules:
 * - json-field-ordering: Sorts JSON object keys canonically using RFC 8785 (JCS)
 * - header-casing: Normalizes header names/keys to lowercase
 * - whitespace: Normalizes multiple spaces/tabs to single space, trims
 * - value-canonicalization: Normalizes number formats, boolean strings
 *
 * Works on all channel types: "output-text", "tool-args", "tool-result".
 *
 * Used by:
 * - ChannelFirewall when normalizeBeforeDetection is enabled
 * - Consumers who want to normalize messages independently
 */

import { canonicalize } from "@fluxpointstudios/poi-sdk-core";

import type {
  ChannelMessage,
  MessageSchema,
  NormalizationRule,
  NormalizationRuleType,
  NormalizedMessage,
} from "../types.js";
import {
  ChannelFirewallError,
  ChannelFirewallException,
} from "../types.js";

// =============================================================================
// DEFAULT SCHEMAS
// =============================================================================

/**
 * Default normalization schemas applied when no custom schemas are provided.
 * Each channel type gets sensible defaults.
 */
const DEFAULT_SCHEMAS: MessageSchema[] = [
  {
    channel: "output-text",
    rules: [
      { type: "whitespace" },
    ],
  },
  {
    channel: "tool-args",
    rules: [
      { type: "json-field-ordering" },
      { type: "whitespace" },
      { type: "value-canonicalization" },
    ],
  },
  {
    channel: "tool-result",
    rules: [
      { type: "json-field-ordering" },
      { type: "whitespace" },
      { type: "value-canonicalization" },
    ],
  },
];

// =============================================================================
// SCHEMA MESSAGE NORMALIZER
// =============================================================================

/**
 * Normalizes messages according to schema rules to reduce covert channel bandwidth.
 *
 * @example
 * ```typescript
 * const normalizer = new SchemaMessageNormalizer();
 * const normalized = normalizer.normalize(
 *   { content: '{"b":1,"a":2}', channel: "tool-args", timestamp: "..." },
 * );
 * // normalized.content === '{"a":2,"b":1}'
 * ```
 */
export class SchemaMessageNormalizer {
  private readonly schemas: MessageSchema[];

  /**
   * @param schemas - Optional custom schemas. If not provided, defaults are used.
   */
  constructor(schemas?: MessageSchema[]) {
    this.schemas = schemas ?? DEFAULT_SCHEMAS;
  }

  /**
   * Normalize a message according to its channel's schema.
   *
   * @param message - The message to normalize
   * @param schemaOverride - Optional schema to use instead of the configured one
   * @returns Normalized message with metadata about applied rules
   * @throws ChannelFirewallException with NORMALIZATION_FAILED on errors
   */
  normalize(
    message: ChannelMessage,
    schemaOverride?: MessageSchema,
  ): NormalizedMessage {
    try {
      const schema =
        schemaOverride ??
        this.schemas.find((s) => s.channel === message.channel);

      // No schema for this channel - return as-is but marked as normalized
      if (!schema || schema.rules.length === 0) {
        return {
          ...message,
          normalized: true,
          originalContent: message.content,
          appliedRules: [],
        };
      }

      let content = message.content;
      const appliedRules: NormalizationRuleType[] = [];

      for (const rule of schema.rules) {
        content = this.applyRule(content, rule);
        appliedRules.push(rule.type);
      }

      return {
        ...message,
        content,
        normalized: true,
        originalContent: message.content,
        appliedRules,
      };
    } catch (error) {
      if (error instanceof ChannelFirewallException) throw error;

      throw new ChannelFirewallException(
        ChannelFirewallError.NORMALIZATION_FAILED,
        `Failed to normalize message on channel "${message.channel}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Rule Application
  // ---------------------------------------------------------------------------

  /**
   * Apply a single normalization rule to content.
   *
   * @param content - The content string to normalize
   * @param rule - The rule to apply
   * @returns Normalized content string
   */
  private applyRule(content: string, rule: NormalizationRule): string {
    switch (rule.type) {
      case "json-field-ordering":
        return this.applyJsonFieldOrdering(content);
      case "header-casing":
        return this.applyHeaderCasing(content);
      case "whitespace":
        return this.applyWhitespace(content);
      case "value-canonicalization":
        return this.applyValueCanonicalization(content);
      default:
        // Exhaustiveness check
        return content;
    }
  }

  /**
   * Sort JSON object keys canonically using RFC 8785 (JCS) via poi-sdk-core.
   *
   * If the content is valid JSON, it is parsed and re-serialized with canonical
   * key ordering. If it is not valid JSON, it is returned unchanged.
   *
   * @param content - Content that may be JSON
   * @returns Canonically ordered JSON, or original content if not JSON
   */
  private applyJsonFieldOrdering(content: string): string {
    const trimmed = content.trim();

    // Quick check: does it look like JSON?
    if (
      !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
      !(trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      return content;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      // Use poi-sdk-core canonicalize for deterministic key ordering.
      // We use removeNulls: false to preserve null values in tool payloads.
      return canonicalize(parsed, { removeNulls: false });
    } catch {
      // Not valid JSON - return unchanged
      return content;
    }
  }

  /**
   * Normalize header-like content to lowercase.
   * Applies to lines that look like "Key: Value" headers.
   * Only lowercases the key portion.
   *
   * @param content - Content that may contain header lines
   * @returns Content with header keys lowercased
   */
  private applyHeaderCasing(content: string): string {
    // Process line by line, looking for "Key: Value" patterns
    return content
      .split("\n")
      .map((line) => {
        const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (match) {
          return `${match[1]!.toLowerCase()}: ${match[2]!}`;
        }
        return line;
      })
      .join("\n");
  }

  /**
   * Normalize whitespace: collapse multiple spaces/tabs to single space, trim lines.
   *
   * @param content - Content to normalize
   * @returns Whitespace-normalized content
   */
  private applyWhitespace(content: string): string {
    return content
      .split("\n")
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .join("\n")
      .trim();
  }

  /**
   * Canonicalize values in JSON content.
   * - Number strings: "1.0" -> "1", "01" -> "1"
   * - Boolean strings: "True", "TRUE" -> "true"; "False", "FALSE" -> "false"
   * - Null strings: "None", "NULL", "null" -> null
   *
   * Only applies to JSON content. Non-JSON content is returned unchanged.
   *
   * @param content - Content that may be JSON
   * @returns Content with values canonicalized
   */
  private applyValueCanonicalization(content: string): string {
    const trimmed = content.trim();

    if (
      !(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
      !(trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      return content;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      const canonicalized = this.canonicalizeValues(parsed);
      return JSON.stringify(canonicalized);
    } catch {
      return content;
    }
  }

  /**
   * Recursively canonicalize values in a parsed JSON structure.
   *
   * @param value - Parsed JSON value
   * @returns Canonicalized value
   */
  private canonicalizeValues(value: unknown): unknown {
    if (value === null || value === undefined) return null;

    if (typeof value === "string") {
      // Boolean strings
      if (/^true$/i.test(value)) return true;
      if (/^false$/i.test(value)) return false;

      // Null-like strings
      if (/^(null|none|nil)$/i.test(value)) return null;

      // Number-like strings (but not empty strings or strings with leading zeros
      // that are clearly identifiers like "007")
      if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
        const num = Number(value);
        if (Number.isFinite(num)) return num;
      }

      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalizeValues(item));
    }

    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.canonicalizeValues(val);
      }
      return result;
    }

    return value;
  }
}
