import { readJsonFile } from "./json-file.js";
import { hash32, type EntryHashes } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { AnchorRequest } from "./operator.js";

export type PlannedAnchor = AnchorRequest & { label: string };

// What scripts/anchor-mainnet.ts reads: the registry and the anchors it writes there, in order.
export interface AnchorPlan {
  registry: string;
  entries: PlannedAnchor[];
}

const HEX64 = /^[0-9a-f]{64}$/;
// A label is printed in the summary a human confirms, so it carries no character a terminal acts on.
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENTRY_FIELDS = ["label", "kind", "rootHash", "manifestHash", "merkleRoot", "attribute"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyFields = (value: Record<string, unknown>, fields: readonly string[], at: string) => {
  const unknown = Object.keys(value).find((name) => !fields.includes(name));
  if (unknown !== undefined) throw new Error(`${at}unknown field ${JSON.stringify(unknown)}`);
};
const hashField = (value: Record<string, unknown>, name: string, at: string): string => {
  const field = value[name];
  if (typeof field !== "string") throw new Error(`${at}${name} must be a string`);
  hash32(field, `${at}${name}`);
  return field;
};

// Reads a plan, refusing anything it does not define exactly: unknown fields, a kind the registry
// does not write, an attribute on kind 1 or none on kind 2, a hash that is not 32 bytes, and a
// label or an anchor that repeats, so each label names one transaction.
export function readAnchorPlan(path: string): AnchorPlan {
  const json = readJsonFile(path);
  if (!isObject(json)) throw new Error(`${path}: the plan must be an object`);
  onlyFields(json, ["registry", "entries"], `${path}: `);
  if (typeof json.registry !== "string" || !HEX64.test(json.registry)) throw new Error(`${path}: registry must be 64 lowercase hex characters`);
  if (!Array.isArray(json.entries) || json.entries.length === 0) throw new Error(`${path}: entries must be a non-empty array`);
  const labels = new Map<string, number>();
  const anchors = new Map<string, number>();
  const entries = json.entries.map((value: unknown, i): PlannedAnchor => {
    const at = `${path}: entries[${i}]: `;
    if (!isObject(value)) throw new Error(`${path}: entries[${i}] must be an object`);
    onlyFields(value, ENTRY_FIELDS, at);
    const { label, kind } = value;
    if (typeof label !== "string" || !LABEL.test(label)) throw new Error(`${at}label must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit`);
    if (kind !== 1 && kind !== 2) throw new Error(`${at}kind must be 1 or 2`);
    const entry: EntryHashes = { rootHash: hashField(value, "rootHash", at), manifestHash: hashField(value, "manifestHash", at) };
    if (value.merkleRoot !== undefined) entry.merkleRoot = hashField(value, "merkleRoot", at);
    if (kind === 1 && value.attribute !== undefined) throw new Error(`${at}a kind-1 entry takes no attribute`);
    if (kind === 2 && value.attribute === undefined) throw new Error(`${at}a kind-2 entry needs an attribute`);
    const planned: PlannedAnchor = kind === 1 ? { label, kind, entry } : { label, kind, entry, attribute: hashField(value, "attribute", at) };
    const repeated = labels.get(label);
    if (repeated !== undefined) throw new Error(`${at}label ${JSON.stringify(label)} repeats entries[${repeated}]`);
    labels.set(label, i);
    const words = [entry.rootHash, entry.manifestHash, entry.merkleRoot ?? "00".repeat(32), kind === 2 ? value.attribute : "00".repeat(32)];
    const anchor = [kind, ...words.map((word) => Buffer.from(hash32(word as string, "hash")).toString("hex"))].join("/");
    const same = anchors.get(anchor);
    if (same !== undefined) throw new Error(`${at}the same anchor as entries[${same}]`);
    anchors.set(anchor, i);
    return planned;
  });
  return { registry: json.registry, entries };
}
