#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re

file_path = r"d:\CocosProject\Shangrilao\assets\scripts\manager\GameManager.ts"

with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Pattern to find and replace
old_pattern = r'''// Neu khong co \+1 Spin: emit gia tri tu server de dong bo\.\s*
        // Neu co \+1 Spin: TopUpAbsorbEffect se emit so chinh xac sau animation \+1\.\s*
        if \(plusOneSpinCount === 0\) \{\s*
            EventBus\.instance\.emit\(GameEvents\.TOPUP_COUNT_UPDATED, data\.respinRemaining\);\s*
        \}'''

new_code = '''// Emit spin count ngay sau khi cap nhat tu server de UI dong bo voi visual
        EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);'''

if re.search(old_pattern, content):
    content = re.sub(old_pattern, new_code, content)
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Fixed successfully!")
else:
    print("Pattern not found, trying alternative...")
    # Try simpler pattern
    old_simple = r'if \(plusOneSpinCount === 0\) \{\s*EventBus\.instance\.emit\(GameEvents\.TOPUP_COUNT_UPDATED, data\.respinRemaining\);\s*\}'
    new_simple = '// Emit spin count ngay sau khi cap nhat tu server de UI dong bo voi visual\n        EventBus.instance.emit(GameEvents.TOPUP_COUNT_UPDATED, data.respinRemaining);'
    
    if re.search(old_simple, content):
        content = re.sub(old_simple, new_simple, content)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print("Fixed with alternative pattern!")
    else:
        print("Could not find pattern to fix")
        # Print lines around plusOneSpinCount
        lines = content.split('\n')
        for i, line in enumerate(lines):
            if 'plusOneSpinCount === 0' in line:
                print(f"Found at line {i+1}:")
                for j in range(max(0, i-2), min(len(lines), i+5)):
                    print(f"{j+1}: {lines[j]}")
