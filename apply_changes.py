file_path = r'd:\CocosProject\Shangrilao\assets\scripts\controller\UIController.ts'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add toggleCurrencyButton property after betSettingButton
content = content.replace(
    'betSettingButton: Button | null = null;',
    'betSettingButton: Button | null = null;\n\n    @property({ type: Button, tooltip: "Nút toggle hiển thị currency symbol" })\n    toggleCurrencyButton: Button | null = null;'
)

# 2. Add _showCurrencySymbol flag after _openPopupCount
content = content.replace(
    'private _openPopupCount: number = 0;',
    'private _openPopupCount: number = 0;\n    private _showCurrencySymbol: boolean = true;'
)

# 3. Add button binding in _bindUI
content = content.replace(
    "if (this.betSettingButton) {\n            this.betSettingButton.node.on('click', this._onBetSettingClick, this);\n        }\n    }",
    "if (this.betSettingButton) {\n            this.betSettingButton.node.on('click', this._onBetSettingClick, this);\n        }\n        if (this.toggleCurrencyButton) {\n            this.toggleCurrencyButton.node.on('click', this._onToggleCurrencyClick, this);\n        }\n    }"
)

# 4. Add toggle handler after _onBetSettingClick
content = content.replace(
    "private _onBetSettingClick(): void {\n        EventBus.instance.emit(GameEvents.BET_SETTING_OPEN);\n    }",
    "private _onBetSettingClick(): void {\n        EventBus.instance.emit(GameEvents.BET_SETTING_OPEN);\n    }\n\n    private _onToggleCurrencyClick(): void {\n        this._showCurrencySymbol = !this._showCurrencySymbol;\n        this._refreshBalanceLabel();\n        this._refreshBetLabel();\n    }"
)

# 5. Add helper methods after _onBalanceUpdated
content = content.replace(
    "private _onBalanceUpdated(balance: number): void {\n        const isActuallyIncreasing = balance > this._targetBalance;\n        this._targetBalance = balance;\n        this._animateBalance(this._displayedBalance, balance, isActuallyIncreasing);\n    }",
    "private _onBalanceUpdated(balance: number): void {\n        const isActuallyIncreasing = balance > this._targetBalance;\n        this._targetBalance = balance;\n        this._animateBalance(this._displayedBalance, balance, isActuallyIncreasing);\n    }\n\n    private _refreshBalanceLabel(): void {\n        if (this.balanceLabel) {\n            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';\n            this.balanceLabel.string = symbol + formatCurrencyFixed(this._displayedBalance);\n        }\n    }\n\n    private _refreshBetLabel(): void {\n        const bonusMgr = BuyBonusManager.instance;\n        const ratio = bonusMgr?.activeItemPriceRatio ?? 0;\n        const totalBet = BetManager.instance.totalBet;\n        const displayBet = ratio > 0 ? totalBet * ratio : totalBet;\n        if (this.betLabel) {\n            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';\n            this.betLabel.string = symbol + formatCurrency(displayBet);\n            this.betLabel.color = ratio > 0 ? this.betLabelWarningColor : this.betLabelNormalColor;\n        }\n    }"
)

# 6. Update start() method to use flag
content = content.replace(
    "this.balanceLabel.string = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrencyFixed(initialBalance);",
    "const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';\n            this.balanceLabel.string = symbol + formatCurrencyFixed(initialBalance);"
)

# 7. Update _onBetChanged to use flag
content = content.replace(
    "this.betLabel.string = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrency(displayBet);",
    "const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';\n            this.betLabel.string = symbol + formatCurrency(displayBet);"
)

# 8. Update _onBuyBonusTotalBetChanged to use flag
content = content.replace(
    "this.betLabel.string = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrency(info.displayBet);",
    "const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';\n            this.betLabel.string = symbol + formatCurrency(info.displayBet);"
)

# 9. Update _animateBalance to use flag (3 places)
content = content.replace(
    "this.balanceLabel.string = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrencyFixed(to);\n            return;",
    "const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';\n            this.balanceLabel.string = symbol + formatCurrencyFixed(to);\n            return;"
)

content = content.replace(
    "this.balanceLabel!.string = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrencyFixed(cur);",
    "const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';\n            this.balanceLabel!.string = symbol + formatCurrencyFixed(cur);"
)

content = content.replace(
    "this.balanceLabel!.string = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrencyFixed(to);",
    "const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';\n            this.balanceLabel!.string = symbol + formatCurrencyFixed(to);"
)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Changes applied successfully')
