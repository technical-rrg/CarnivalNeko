import { _decorator, Component, SpriteAtlas } from 'cc';
import { Log } from './core/Logger';
const { ccclass, property } = _decorator;

@ccclass('CheckAtlas')
export class CheckAtlas extends Component {

    @property({ type: SpriteAtlas, tooltip: 'Kéo file Atlas của bạn vào đây' })
    myAtlas: SpriteAtlas = null;

    start() {
        if (!this.myAtlas) {
            Log.e("❌ Bạn chưa gắn file Atlas vào script này!");
            return;
        }

        // Lấy toàn bộ các khung hình (SpriteFrame) có trong Atlas
        const frames = this.myAtlas.getSpriteFrames();
        
        Log.d(`🔍 Đang kiểm tra Atlas... Tìm thấy tổng cộng ${frames.length} hình:`);
        Log.d("--------------------------------------------------");
        
        // Vòng lặp in ra tên thật của từng hình
        frames.forEach((frame, index) => {
            Log.d(`Hình thứ ${index + 1}: ${frame.name}`);
        });

        Log.d("--------------------------------------------------");
        Log.d("👉 Hãy copy đúng cái tên in ra ở trên để bỏ vào thẻ <img src='...' />");
    }
}