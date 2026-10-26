"""Decode the logical Cardano checkpoint commitment used by the smoke probe.

This is structural metadata validation, not a receipt membership proof. Leaves
are an integer count; the authenticated member list lives off chain.
"""
import re


def decode_checkpoint_metadata(value):
    if not isinstance(value, dict):
        raise ValueError("checkpoint metadata is not a map")
    if set(value) == {"map"}:
        fields = {}
        if not isinstance(value["map"], list):
            raise ValueError("checkpoint map is not a list")
        for entry in value["map"]:
            if not isinstance(entry, dict) or set(entry) != {"k", "v"}:
                raise ValueError("invalid detailed-schema entry")
            key = entry["k"]
            if not isinstance(key, dict) or set(key) != {"string"} or not isinstance(key["string"], str):
                raise ValueError("invalid detailed-schema key")
            if key["string"] in fields:
                raise ValueError("duplicate checkpoint key")
            fields[key["string"]] = _unwrap(entry["v"])
    else:
        fields = dict(value)
    if set(fields) != {"p", "v", "chain", "blocks", "leaves", "root", "manifest"}:
        raise ValueError("unexpected checkpoint fields")
    if fields["p"] != "materios" or type(fields["v"]) is not int or fields["v"] != 2:
        raise ValueError("not a Materios v2 checkpoint")
    if type(fields["leaves"]) is not int or fields["leaves"] < 1:
        raise ValueError("checkpoint leaves is an integer count, not a member list")
    blocks = fields["blocks"]
    if not isinstance(blocks, list) or len(blocks) != 2 or any(type(n) is not int or n < 0 for n in blocks) or blocks[0] > blocks[1]:
        raise ValueError("invalid checkpoint block range")
    if any(not isinstance(fields[k], str) or not re.fullmatch(r"[0-9a-f]{64}", fields[k]) for k in ("chain", "root", "manifest")):
        raise ValueError("invalid checkpoint hash")
    return fields


def _unwrap(value):
    if not isinstance(value, dict) or len(value) != 1:
        raise ValueError("invalid detailed-schema value")
    if "string" in value and isinstance(value["string"], str):
        return value["string"]
    if "int" in value and type(value["int"]) is int:
        return value["int"]
    if "list" in value and isinstance(value["list"], list):
        return [_unwrap(item) for item in value["list"]]
    raise ValueError("invalid detailed-schema type")
