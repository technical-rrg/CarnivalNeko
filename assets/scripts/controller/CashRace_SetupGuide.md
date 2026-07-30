# Cash Race System — Hướng Dẫn Cài Đặt Trong Cocos Creator

## Tổng quan các file

| File | Vị trí | Vai trò |
|------|--------|---------|
| `CashRaceMockAPI.ts` | `assets/scripts/data/` | Mock API (dữ liệu giả lập) |
| `CashRaceWidget.ts` | `assets/scripts/controller/` | Component icon ngoài HUD |
| `CashRacePopup.ts` | `assets/scripts/controller/` | Component popup bảng xếp hạng |

---

## PHẦN 1 — Cài đặt `CashRaceWidget` (Icon HUD)

### 1.1. Cấu trúc node cần tạo trong Hierarchy

```
BtnCashRace  ← Gắn component CashRaceWidget vào đây
├── IconDefault       (Sprite — icon huy chương vàng, luôn active)
├── IconWreath        (Sprite — vòng nguyệt quế, bắt đầu inactive)
├── ProgressBar       (Sprite — circular progress bar)
├── LabelRolling      (Label — text chạy 4 giây, cần thêm UIOpacity component)
├── LabelRank         (Label — "#123" hoặc "1st")
└── LabelCountdown    (Label — "HH:MM:SS", bắt đầu inactive)
```

### 1.2. Cài đặt ProgressBar

1. Chọn node `ProgressBar`.
2. Trong **Sprite** component:
   - `Type` → **FILLED**
   - `Fill Type` → **RADIAL** (circular)
   - `Fill Start` → `0` (hoặc `0.75` nếu muốn bắt đầu từ đỉnh)
   - `Fill Range` → `0` (sẽ được set bằng code)
3. Gán sprite atlas phù hợp (vòng tròn viền màu xanh/vàng).

### 1.3. Kéo thả node vào Inspector

Chọn node `BtnCashRace` → trong **CashRaceWidget** Inspector:

| Property | Kéo node nào vào |
|----------|-----------------|
| `iconDefault` | Node `IconDefault` |
| `iconWreath` | Node `IconWreath` |
| `progressBar` | Node `ProgressBar` (Sprite component) |
| `labelRolling` | Node `LabelRolling` |
| `labelRank` | Node `LabelRank` |
| `labelCountdown` | Node `LabelCountdown` |
| `btnOpenPopup` | Chính node `BtnCashRace` (hoặc node bắt touch) |

### 1.4. Cấu hình giá trị

| Property | Giá trị gợi ý |
|----------|--------------|
| `rollingInterval` | `4` (giây) |
| `pollInterval` | `5` (giây poll API) |

---

## PHẦN 2 — Cài đặt `CashRacePopup` (Popup Bảng Xếp Hạng)

### 2.1. Cấu trúc node cần tạo

```
CashRacePopup  ← Gắn component CashRacePopup, bắt đầu INACTIVE
├── Header
│   ├── LabelTheme       (Label — "BET" / "WIN" / "LOSE")
│   ├── LabelEventName   (Label — tên sự kiện)
│   ├── LabelTimer       (Label — "00:12:34:56" — DD:HH:MM:SS)
│   ├── LabelPrizePool   (Label — "Prize Pool: 9.99M")
│   └── BtnClose         (Node có Button component — nút X)
├── BtnTop3              (Node có Button component)
│   └── LabelBtnTop3     (Label — "< TOP 3 >")
├── BtnRefresh           (Node có Button component + UIOpacity)
├── RankList
│   ├── RankRow_0        ← Dòng 1
│   │   ├── LabelRank    (Label)
│   │   ├── LabelName    (Label)
│   │   ├── LabelScore   (Label)
│   │   ├── LabelPrize   (Label — ẩn mặc định, dùng khi Top 3 mode)
│   │   └── HighlightBg  (Node có Sprite — ẩn mặc định)
│   ├── RankRow_1        ← Dòng 2 (cấu trúc giống RankRow_0)
│   ├── RankRow_2        ← Dòng 3 (YOU!)
│   ├── RankRow_3        ← Dòng 4
│   └── RankRow_4        ← Dòng 5
└── YouMarker            (Node/Label "YOU!" — ẩn mặc định)
```

### 2.2. Kéo thả vào Inspector

**Header labels:**

| Property | Kéo node nào vào |
|----------|-----------------|
| `labelTheme` | Node `LabelTheme` |
| `labelTimer` | Node `LabelTimer` |
| `labelPrizePool` | Node `LabelPrizePool` |
| `labelEventName` | Node `LabelEventName` |

**Buttons:**

| Property | Kéo node nào vào |
|----------|-----------------|
| `btnClose` | Node `BtnClose` |
| `btnTop3` | Node `BtnTop3` |
| `labelBtnTop3` | Node `LabelBtnTop3` (Label con của BtnTop3) |
| `btnRefresh` | Node `BtnRefresh` |

**Rank Rows — Mảng `rankRows` có 5 phần tử:**

Bấm dấu `+` trong mảng `rankRows` 5 lần. Mỗi phần tử `RankRowUI`:

| Property | Kéo node nào vào |
|----------|-----------------|
| `labelRank` | Node `LabelRank` trong `RankRow_N` |
| `labelName` | Node `LabelName` trong `RankRow_N` |
| `labelScore` | Node `LabelScore` trong `RankRow_N` |
| `highlightBg` | Node `HighlightBg` trong `RankRow_N` |
| `labelPrize` | Node `LabelPrize` trong `RankRow_N` (có thể để trống) |

**YOU Marker:**

| Property | Kéo node nào vào |
|----------|-----------------|
| `youMarker` | Node `YouMarker` |

### 2.3. Cấu hình giá trị

| Property | Giá trị gợi ý |
|----------|--------------|
| `refreshCooldown` | `4` (giây — theo tài liệu) |
| `rollingDuration` | `1.5` (giây giật số — theo tài liệu) |
| `youHighlightColor` | `(255, 0, 128, 200)` — hồng/đỏ nổi bật |
| `top3Color` | `(255, 215, 0, 200)` — vàng |
| `normalColor` | `(0, 180, 255, 180)` — xanh dương |

---

## PHẦN 3 — Kết nối Widget ↔ Popup

Popup lắng nghe event `'CASH_RACE_OPEN_POPUP'` từ `EventBus`.  
Widget tự emit event này khi user bấm icon.

**Không cần code thêm** — chỉ cần đảm bảo cả 2 node `BtnCashRace` (Widget) và `CashRacePopup` đều tồn tại trong cùng scene.

### Nếu muốn mở popup từ code khác:

```typescript
// Cách 1: Qua EventBus
EventBus.instance.emit('CASH_RACE_OPEN_POPUP');

// Cách 2: Gọi trực tiếp component
const popup = this.cashRacePopupNode.getComponent(CashRacePopup);
popup.openPopup();
```

---

## PHẦN 4 — Luồng hoạt động

```
[User bấm BtnCashRace]
        ↓
CashRaceWidget._onTapOpenPopup()
        ↓
EventBus.emit('CASH_RACE_OPEN_POPUP', raceInfo)
        ↓
CashRacePopup._onOpenPopup(raceInfo)
        ↓
getLeaderboard(isTop3=false)  ← gọi Mock API (delay 300ms)
        ↓
_startRollingAnimation()       ← BƯỚC 1: tắt highlight
        ↓
update() — 1.5 giây            ← BƯỚC 2: giật số
        ↓
_finishRollingAnimation()      ← BƯỚC 3: gán data thật + Ting-Ting
```

---

## PHẦN 5 — Thay thế Mock API bằng Server API thực

Khi server sẵn sàng, chỉ cần sửa 2 hàm trong `CashRaceMockAPI.ts`:

```typescript
// Thay thế hàm này:
export async function getRaceInfo(): Promise<RaceInfo> {
    // Xóa: await mockDelay(); return getMockState().getRaceInfo();
    
    // Thêm: gọi API thật
    const url = ServerConfig.getUrl(ServerConfig.API.CASH_RACE_RANK);
    const resp = await fetch(url, { /* headers, body */ });
    const json = await resp.json();
    return mapServerResponseToRaceInfo(json); // mapping theo format server
}

export async function getLeaderboard(isTop3: boolean): Promise<RankItem[]> {
    // Xóa mock, thêm HTTP call tương tự
}
```

### API server cần cung cấp (note cho team backend):

| Endpoint | Method | Response |
|----------|--------|----------|
| `/Slot/{slotId}/CashRaceMyRankGetFirst` | GET | Thông tin rank + event (đã có trong ServerConfig) |
| `/Slot/{slotId}/CashRaceLeaderboard?top3=true` | GET | Mảng RankItem (cần bổ sung) |

---

## PHẦN 6 — Test nhanh (Không cần Cocos Editor)

Chạy test trong console browser bằng cách import và gọi trực tiếp:

```typescript
import { getRaceInfo, getLeaderboard } from '../data/CashRaceMockAPI';

// Test getRaceInfo
getRaceInfo().then(info => console.log('RaceInfo:', info));

// Test leaderboard nearby
getLeaderboard(false).then(rows => console.log('Nearby:', rows));

// Test Top 3
getLeaderboard(true).then(rows => console.log('Top3:', rows));
```

---

## Checklist hoàn thành

- [ ] Tạo node `BtnCashRace` với cấu trúc con đúng
- [ ] Gắn `CashRaceWidget` vào `BtnCashRace`
- [ ] Kéo thả đủ 6 property của Widget
- [ ] Cài đặt `ProgressBar` Sprite: type=FILLED, fillType=RADIAL
- [ ] Tạo node `CashRacePopup` (bắt đầu inactive)
- [ ] Gắn `CashRacePopup` vào node popup
- [ ] Tạo đủ 5 `RankRow` với cấu trúc label/highlight
- [ ] Kéo thả 5 phần tử vào mảng `rankRows`
- [ ] Kéo thả header labels, buttons, youMarker
- [ ] Test bấm icon → popup mở, leaderboard load, giật số 1.5s
- [ ] Kiểm tra console: thấy "♪ Play Ting-Ting Sound ♪" sau 1.5s
- [ ] Kiểm tra nút Refresh: bị mờ 4 giây sau khi bấm
- [ ] Kiểm tra Toggle TOP 3 ↔ Nearby hiển thị đúng
