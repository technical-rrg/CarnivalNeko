#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re

file_path = r"d:\CocosProject\Shangrilao\assets\scripts\controller\StickyOverlayController.ts"

with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# 1. Thêm import TopUpManager sau SlotMachineController
old_import = "import { SlotMachineController } from './SlotMachineController';"
new_import = """import { SlotMachineController } from './SlotMachineController';
import { TopUpManager } from './TopUpManager';"""

if old_import in content:
    content = content.replace(old_import, new_import)
    print("Added TopUpManager import")
else:
    print("Import pattern not found")

# 2. Thêm hàm mới sau alignCoinPositions()
old_func = """    alignCoinPositions(): void {
        if (!this.slotMachine) {
            Log.e('[StickyOverlay] alignCoinPositions: slotMachine chưa được gán.');
            return;
        }
        for (let reelIdx = 0; reelIdx < 5; reelIdx++) {
            const reel = this.slotMachine.reels[reelIdx];
            if (!reel) continue;

            const symbolNodeIndices = [2, 3, 4]; // Top, Mid, Bot
            for (let row = 0; row < 3; row++) {
                const coinIdx = reelIdx * 3 + row;
                const slotNode = this.coinSlots[coinIdx];
                if (!slotNode) continue;

                const symbolNode = reel.symbolNodes[symbolNodeIndices[row]];
                if (!symbolNode) continue;

                slotNode.setWorldPosition(symbolNode.worldPosition);
            }
        }
    }"""

new_func = """    alignCoinPositions(): void {
        if (!this.slotMachine) {
            Log.e('[StickyOverlay] alignCoinPositions: slotMachine chưa được gán.');
            return;
        }
        for (let reelIdx = 0; reelIdx < 5; reelIdx++) {
            const reel = this.slotMachine.reels[reelIdx];
            if (!reel) continue;

            const symbolNodeIndices = [2, 3, 4]; // Top, Mid, Bot
            for (let row = 0; row < 3; row++) {
                const coinIdx = reelIdx * 3 + row;
                const slotNode = this.coinSlots[coinIdx];
                if (!slotNode) continue;

                const symbolNode = reel.symbolNodes[symbolNodeIndices[row]];
                if (!symbolNode) continue;

                slotNode.setWorldPosition(symbolNode.worldPosition);
            }
        }
    }

    /**
     * ★ Gọi khi mới vào TopUp: Sync vị trí 15 coin slot với 15 reels trong TopUpManager.
     * TopUpManager.reels có index = reel * 3 + row (row: 0=Top, 1=Mid, 2=Bot visual).
     */
    alignPositionsFromTopUpManager(): void {
        const topUpMgrs = this.node.scene?.getComponentsInChildren(TopUpManager) ?? [];
        if (topUpMgrs.length === 0) {
            Log.e('[StickyOverlay] alignPositionsFromTopUpManager: TopUpManager not found.');
            return;
        }
        const topUpMgr = topUpMgrs[0];
        
        // TopUpManager.reels: [0]=C0-Top [1]=C0-Mid [2]=C0-Bot [3]=C1-Top ... [14]=C4-Bot
        // StickyOverlay.coinSlots cần: row 0=Bot, 1=Mid, 2=Top (ngược với TopUpManager)
        for (let reelIdx = 0; reelIdx < 5; reelIdx++) {
            // Map: Sticky row 0 (Bot) → TopUp reel [2], row 1 (Mid) → [1], row 2 (Top) → [0]
            const rowMapping = [2, 1, 0]; // Sticky row → TopUp reel index offset
            
            for (let row = 0; row < 3; row++) {
                const coinIdx = reelIdx * 3 + row;
                const slotNode = this.coinSlots[coinIdx];
                if (!slotNode) continue;

                const topUpReelIdx = reelIdx * 3 + rowMapping[row];
                const topUpReel = topUpMgr.reels[topUpReelIdx];
                if (!topUpReel) continue;

                // Lấy symbol node ở giữa (index 1) của TopUpReel làm reference
                const symbolNode = topUpReel.symbolNodes[1];
                if (!symbolNode) continue;

                slotNode.setWorldPosition(symbolNode.worldPosition);
                Log.d(`[StickyOverlay] Sync slot ${coinIdx} (R${reelIdx}-Row${row}) to TopUp reel ${topUpReelIdx}`);
            }
        }
        Log.d('[StickyOverlay] alignPositionsFromTopUpManager: Done syncing 15 slots.');
    }"""

if old_func in content:
    content = content.replace(old_func, new_func)
    print("Added alignPositionsFromTopUpManager function")
else:
    print("Function pattern not found - trying alternative")
    # Thêm hàm mới sau alignCoinPositions nếu tìm thấy
    pattern = r'(alignCoinPositions\(\): void \{[^}]+\}[^}]+\})'
    match = re.search(pattern, content, re.DOTALL)
    if match:
        insert_pos = match.end()
        new_content = content[:insert_pos] + '\n\n' + new_func.split('alignCoinPositions(): void {')[1].split('    alignPositionsFromTopUpManager(): void {')[0] + '\n\n    alignPositionsFromTopUpManager(): void {\n        const topUpMgrs = this.node.scene?.getComponentsInChildren(TopUpManager) ?? [];\n        if (topUpMgrs.length === 0) {\n            Log.e(\'[StickyOverlay] alignPositionsFromTopUpManager: TopUpManager not found.\');\n            return;\n        }\n        const topUpMgr = topUpMgrs[0];\n        \n        for (let reelIdx = 0; reelIdx < 5; reelIdx++) {\n            const rowMapping = [2, 1, 0];\n            for (let row = 0; row < 3; row++) {\n                const coinIdx = reelIdx * 3 + row;\n                const slotNode = this.coinSlots[coinIdx];\n                if (!slotNode) continue;\n\n                const topUpReelIdx = reelIdx * 3 + rowMapping[row];\n                const topUpReel = topUpMgr.reels[topUpReelIdx];\n                if (!topUpReel) continue;\n\n                const symbolNode = topUpReel.symbolNodes[1];\n                if (!symbolNode) continue;\n\n                slotNode.setWorldPosition(symbolNode.worldPosition);\n                Log.d(`[StickyOverlay] Sync slot ${coinIdx} (R${reelIdx}-Row${row}) to TopUp reel ${topUpReelIdx}`);\n            }\n        }\n        Log.d(\'[StickyOverlay] alignPositionsFromTopUpManager: Done syncing 15 slots.\');\n    }' + content[insert_pos:]
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("Added function with alternative method")
    else:
        print("Could not find insertion point")

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done!")
