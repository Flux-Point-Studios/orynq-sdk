from copy import deepcopy
import pytest
from tests._checkpoint_metadata import decode_checkpoint_metadata


RECORD = {"p": "materios", "v": 2, "chain": "aa" * 32, "root": "bb" * 32, "manifest": "cc" * 32, "blocks": [5, 10], "leaves": 3}


def wrap(value):
    if isinstance(value, str):
        return {"string": value}
    if isinstance(value, int):
        return {"int": value}
    return {"list": [wrap(item) for item in value]}


def test_both_real_encodings_hold_a_count_and_commitments():
    detailed = {"map": [{"k": {"string": k}, "v": wrap(v)} for k, v in RECORD.items()]}
    assert decode_checkpoint_metadata(RECORD) == RECORD
    assert decode_checkpoint_metadata(detailed) == RECORD


@pytest.mark.parametrize("leaves", [[{"receipt_id": "dd" * 32}], True, 0, -1])
def test_never_treats_leaves_as_a_per_receipt_dictionary(leaves):
    with pytest.raises(ValueError):
        decode_checkpoint_metadata({**RECORD, "leaves": leaves})


def test_refuses_duplicate_or_malformed_detailed_fields():
    detailed = {"map": [{"k": {"string": k}, "v": wrap(v)} for k, v in RECORD.items()]}
    duplicate = deepcopy(detailed)
    duplicate["map"].append(duplicate["map"][0])
    with pytest.raises(ValueError, match="duplicate"):
        decode_checkpoint_metadata(duplicate)
    detailed["map"][0]["k"]["extra"] = "p"
    with pytest.raises(ValueError, match="key"):
        decode_checkpoint_metadata(detailed)
