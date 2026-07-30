#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re

file_path = r"d:\CocosProject\Shangrilao\assets\scripts\controller\StickyOverlayController.ts"

with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Sửa _onTopUpStart để gọi alignPositionsFromTopUpManager
old_start = """    private _onTopUpStart(): void {
        this.node.active = true;
        this.alignCoinPositions();
        this._previouslyActiveSlots.clear();"""

new_start = """    private _onTopUpStart(): void {
        this.node.active = true;
        // ★ Sync vị trí từ TopUpManager khi mới vào TopUp
        this.alignPositionsFromTopUpManager();
        this._previouslyActiveSlots.clear();"""

if old_start in content:
    content = content.replace(old_start, new_start)
    print("Updated _onTopUpStart to call alignPositionsFromTopUpManager")
else:
    print("_onTopUpStart pattern not found")

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done!")
