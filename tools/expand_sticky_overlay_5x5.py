"""Safely expand StickyOverlay.prefab from 5x3 to 5x5.

Existing serialized objects keep their original indices. New reel and coin-slot
subtrees are appended, avoiding broken Cocos `__id__` / `_prefab` references.
"""
from __future__ import annotations

import base64
import copy
import json
import shutil
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREFAB = ROOT / "assets" / "bundle" / "StickyOverlay.prefab"
BACKUP = ROOT / "assets" / "bundle" / "StickyOverlay.prefab.bak_5x3"

COLS = 5
SOURCE_ROWS = 3
TARGET_ROWS = 5
REEL_BLOCK_START = 9
REEL_BLOCK_SIZE = 42
COIN_BLOCK_START = 653
COIN_BLOCK_SIZE = 18
TOPUP_MANAGER_ID = 643
STICKY_CONTROLLER_ID = 932
GRID_NODE_ID = 8
COIN_PARENT_ID = 652
REEL_CONTROLLER_OFFSET = 39


def file_id() -> str:
    return base64.b64encode(uuid.uuid4().bytes).decode("ascii").rstrip("=")


def remap(value, id_map: dict[int, int]):
    if isinstance(value, dict):
        if len(value) == 1 and "__id__" in value:
            old_id = value["__id__"]
            return {"__id__": id_map.get(old_id, old_id)}
        return {key: remap(item, id_map) for key, item in value.items()}
    if isinstance(value, list):
        return [remap(item, id_map) for item in value]
    return value


def append_clone(data: list[dict], start: int, size: int) -> int:
    new_start = len(data)
    id_map = {start + offset: new_start + offset for offset in range(size)}
    for source in data[start : start + size]:
        clone = remap(copy.deepcopy(source), id_map)
        if clone.get("__type__") in ("cc.PrefabInfo", "cc.CompPrefabInfo"):
            clone["fileId"] = file_id()
        data.append(clone)
    return new_start


def validate(data: list[dict]) -> None:
    max_id = len(data) - 1
    invalid: list[int] = []

    def visit(value) -> None:
        if isinstance(value, dict):
            if len(value) == 1 and "__id__" in value:
                if not 0 <= value["__id__"] <= max_id:
                    invalid.append(value["__id__"])
            else:
                for child in value.values():
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(data)
    if invalid:
        raise RuntimeError(f"Invalid __id__ references: {invalid[:10]}")

    manager = data[TOPUP_MANAGER_ID]
    overlay = data[STICKY_CONTROLLER_ID]
    if len(manager["reels"]) != 25 or len(overlay["coinSlots"]) != 25:
        raise RuntimeError("Expected 25 reel and coin-slot references")

    for node in data:
        prefab_ref = node.get("__prefab") if isinstance(node, dict) else None
        if isinstance(prefab_ref, dict) and "__id__" in prefab_ref:
            target = data[prefab_ref["__id__"]]
            if target.get("__type__") not in ("cc.PrefabInfo", "cc.CompPrefabInfo"):
                raise RuntimeError(
                    f"Broken __prefab reference {prefab_ref['__id__']} "
                    f"on {node.get('__type__')}"
                )


def main() -> None:
    with PREFAB.open(encoding="utf-8") as stream:
        data = json.load(stream)

    manager = data[TOPUP_MANAGER_ID]
    overlay = data[STICKY_CONTROLLER_ID]
    if len(manager.get("reels", [])) == 25:
        validate(data)
        print("StickyOverlay is already a valid 5x5 prefab")
        return
    if len(manager.get("reels", [])) != 15:
        raise RuntimeError("Expected the original 15-reel prefab")

    if not BACKUP.exists():
        shutil.copy2(PREFAB, BACKUP)

    reel_roots: list[int] = []
    reel_controllers: list[int] = []
    coin_roots: list[int] = []

    for col in range(COLS):
        source_reel_start = REEL_BLOCK_START + (
            col * SOURCE_ROWS + SOURCE_ROWS - 1
        ) * REEL_BLOCK_SIZE
        source_coin_start = COIN_BLOCK_START + (
            col * SOURCE_ROWS + SOURCE_ROWS - 1
        ) * COIN_BLOCK_SIZE

        old_reel_nodes = [
            data[REEL_BLOCK_START + (col * SOURCE_ROWS + row) * REEL_BLOCK_SIZE]
            for row in range(SOURCE_ROWS)
        ]
        old_coin_nodes = [
            data[COIN_BLOCK_START + (col * SOURCE_ROWS + row) * COIN_BLOCK_SIZE]
            for row in range(SOURCE_ROWS)
        ]

        reel_step_y = old_reel_nodes[2]["_lpos"]["y"] - old_reel_nodes[1]["_lpos"]["y"]
        coin_step_y = old_coin_nodes[2]["_lpos"]["y"] - old_coin_nodes[1]["_lpos"]["y"]

        column_reel_roots = [
            REEL_BLOCK_START + (col * SOURCE_ROWS + row) * REEL_BLOCK_SIZE
            for row in range(SOURCE_ROWS)
        ]
        column_reel_controllers = [
            root + REEL_CONTROLLER_OFFSET for root in column_reel_roots
        ]
        column_coin_roots = [
            COIN_BLOCK_START + (col * SOURCE_ROWS + row) * COIN_BLOCK_SIZE
            for row in range(SOURCE_ROWS)
        ]

        for row in range(SOURCE_ROWS, TARGET_ROWS):
            reel_root = append_clone(
                data, source_reel_start, REEL_BLOCK_SIZE
            )
            reel_node = data[reel_root]
            reel_node["_name"] = str(col * TARGET_ROWS + row)
            reel_node["_active"] = False
            reel_node["_lpos"]["y"] = (
                old_reel_nodes[2]["_lpos"]["y"]
                + reel_step_y * (row - SOURCE_ROWS + 1)
            )
            column_reel_roots.append(reel_root)
            column_reel_controllers.append(
                reel_root + REEL_CONTROLLER_OFFSET
            )

            coin_root = append_clone(data, source_coin_start, COIN_BLOCK_SIZE)
            coin_node = data[coin_root]
            coin_node["_name"] = str(col * TARGET_ROWS + row)
            coin_node["_active"] = False
            coin_node["_lpos"]["y"] = (
                old_coin_nodes[2]["_lpos"]["y"]
                + coin_step_y * (row - SOURCE_ROWS + 1)
            )
            column_coin_roots.append(coin_root)

        for row, root in enumerate(column_reel_roots):
            data[root]["_name"] = str(col * TARGET_ROWS + row)
        for row, root in enumerate(column_coin_roots):
            data[root]["_name"] = str(col * TARGET_ROWS + row)

        reel_roots.extend(column_reel_roots)
        reel_controllers.extend(column_reel_controllers)
        coin_roots.extend(column_coin_roots)

    data[GRID_NODE_ID]["_children"] = [{"__id__": item} for item in reel_roots]
    data[COIN_PARENT_ID]["_children"] = [{"__id__": item} for item in coin_roots]
    manager["reels"] = [{"__id__": item} for item in reel_controllers]
    overlay["coinSlots"] = [{"__id__": item} for item in coin_roots]

    validate(data)
    with PREFAB.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write("\n")

    print(f"Expanded safely: {len(data)} objects, 25 reels, 25 coin slots")


if __name__ == "__main__":
    main()
