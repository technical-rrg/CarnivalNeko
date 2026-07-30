#!/usr/bin/env python3
"""Extract FeatureEntryGuide subtree from Base.prefab into FeatureEntryGuide.prefab.

Only walks ownership edges (children / components / __prefab / script node refs).
Does NOT follow PrefabInfo.root/asset (those point at Base root and would pull the whole prefab).
"""
from __future__ import annotations

import json
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BASE_PATH = ROOT / "assets" / "bundle" / "Base.prefab"
OUT_PREFAB = ROOT / "assets" / "bundle" / "FeatureEntryGuide.prefab"
OUT_META = ROOT / "assets" / "bundle" / "FeatureEntryGuide.prefab.meta"
NODE_NAME = "FeatureEntryGuide"
SPINE_UUID = "dca2d3bd-2de4-4563-8765-e55a3311ebdc"


def remap_ids(obj: Any, mapping: dict[int, int]) -> Any:
    if isinstance(obj, dict):
        if "__id__" in obj and isinstance(obj["__id__"], int) and set(obj.keys()) <= {"__id__"}:
            oid = obj["__id__"]
            if oid not in mapping:
                raise KeyError(f"unmapped __id__ {oid}")
            return {"__id__": mapping[oid]}
        return {k: remap_ids(v, mapping) for k, v in obj.items()}
    if isinstance(obj, list):
        return [remap_ids(v, mapping) for v in obj]
    return obj


def add_ref(stack: list[int], visited: set[int], ref: Any) -> None:
    if isinstance(ref, dict) and isinstance(ref.get("__id__"), int):
        i = ref["__id__"]
        if i not in visited:
            stack.append(i)


def collect_owned(data: list[Any], start: int) -> set[int]:
    """Downward ownership closure from a node — safe for nested UI trees."""
    visited: set[int] = set()
    stack = [start]
    while stack:
        i = stack.pop()
        if i in visited or i < 0 or i >= len(data):
            continue
        obj = data[i]
        if obj is None:
            continue
        visited.add(i)
        t = obj.get("__type__") if isinstance(obj, dict) else None

        if t == "cc.Node":
            for c in obj.get("_children") or []:
                add_ref(stack, visited, c)
            for c in obj.get("_components") or []:
                add_ref(stack, visited, c)
            add_ref(stack, visited, obj.get("_prefab"))
            continue

        if t == "cc.PrefabInfo":
            # Do NOT follow root/asset — they point outside the subtree
            continue

        if t == "cc.CompPrefabInfo":
            continue

        if isinstance(obj, dict):
            # Component / other: follow __prefab + any __id__ node/component refs
            # except PrefabInfo root/asset keys already skipped above
            add_ref(stack, visited, obj.get("__prefab"))
            add_ref(stack, visited, obj.get("node"))
            for key, val in obj.items():
                if key in ("__prefab", "node", "root", "asset"):
                    continue
                if isinstance(val, dict) and "__id__" in val:
                    add_ref(stack, visited, val)
                elif isinstance(val, list):
                    for item in val:
                        if isinstance(item, dict) and "__id__" in item:
                            add_ref(stack, visited, item)
    return visited


def main() -> int:
    data: list[Any] = json.loads(BASE_PATH.read_text(encoding="utf-8"))

    start = None
    for i, obj in enumerate(data):
        if isinstance(obj, dict) and obj.get("__type__") == "cc.Node" and obj.get("_name") == NODE_NAME:
            start = i
            break
    if start is None:
        print(f"ERROR: node '{NODE_NAME}' not found")
        return 1

    parent_id = None
    parent_ref = data[start].get("_parent")
    if isinstance(parent_ref, dict) and isinstance(parent_ref.get("__id__"), int):
        parent_id = parent_ref["__id__"]

    closure = collect_owned(data, start)
    print(f"Found {NODE_NAME} at id={start}, parent={parent_id}, closure={len(closure)} objects")
    if len(closure) > 80:
        print("ERROR: closure suspiciously large — abort to protect Base.prefab")
        return 2

    ordered = sorted(closure)
    mapping = {old: new + 1 for new, old in enumerate(ordered)}  # 0 = Prefab header

    extracted_objs = []
    for old in ordered:
        obj = deepcopy(data[old])
        # Detach from Base parent BEFORE remap (parent id is outside closure)
        if old == start and isinstance(obj, dict):
            obj["_parent"] = None
            obj["_active"] = False
        if isinstance(obj, dict) and obj.get("__type__") == "cc.PrefabInfo":
            # root/asset point outside closure — set after structural remap of other fields
            obj["root"] = None
            obj["asset"] = None
            obj = remap_ids(obj, mapping)
            obj["root"] = {"__id__": mapping[start]}
            obj["asset"] = {"__id__": 0}
            extracted_objs.append(obj)
            continue
        obj = remap_ids(obj, mapping)
        extracted_objs.append(obj)

    prefab_header = {
        "__type__": "cc.Prefab",
        "_name": NODE_NAME,
        "_objFlags": 0,
        "__editorExtras__": {},
        "_native": "",
        "data": {"__id__": mapping[start]},
        "optimizationPolicy": 0,
        "persistent": False,
    }
    out_data = [prefab_header] + extracted_objs
    OUT_PREFAB.write_text(json.dumps(out_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PREFAB.name} ({len(out_data)} objects)")

    meta_uuid = str(uuid.uuid4())
    OUT_META.write_text(
        json.dumps(
            {
                "ver": "1.1.50",
                "importer": "prefab",
                "imported": True,
                "uuid": meta_uuid,
                "files": [".json"],
                "subMetas": {},
                "userData": {"syncNodeName": NODE_NAME},
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUT_META.name} uuid={meta_uuid}")

    # Strip from Base
    if parent_id is not None and isinstance(data[parent_id], dict):
        children = data[parent_id].get("_children") or []
        before = len(children)
        data[parent_id]["_children"] = [
            c for c in children if not (isinstance(c, dict) and c.get("__id__") == start)
        ]
        print(f"Removed child link ({before} -> {len(data[parent_id]['_children'])})")

    keep = [i for i in range(len(data)) if i not in closure]
    base_map = {old: new for new, old in enumerate(keep)}
    new_base = [remap_ids(deepcopy(data[old]), base_map) for old in keep]

    if len(new_base) < 1000:
        print(f"ERROR: Base would shrink too much ({len(new_base)}) — abort write")
        return 3

    BASE_PATH.write_text(json.dumps(new_base, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Rewrote Base.prefab: {len(data)} -> {len(new_base)} (removed {len(closure)})")

    base_raw = BASE_PATH.read_text(encoding="utf-8")
    out_raw = OUT_PREFAB.read_text(encoding="utf-8")
    print(f"Base still has FeatureEntryGuide name? {NODE_NAME in base_raw}")
    print(f"Base still has spine uuid? {SPINE_UUID in base_raw}")
    print(f"Extract has spine uuid? {SPINE_UUID in out_raw}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
