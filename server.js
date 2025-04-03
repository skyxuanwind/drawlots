const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);

// --- 取得公開網址 ---
// Fly.io 會設定 FLY_APP_NAME 環境變數
const appName = process.env.FLY_APP_NAME;
const PORT = process.env.PORT || 3000; // 先定義 PORT
const publicHost = appName ? `${appName}.fly.dev` : 'localhost'; // 正確的公開主機名
const serverPort = appName ? 443 : PORT; // Fly.io 公開訪問用 443 (HTTPS) 或 80 (HTTP)，本地用 PORT
const serverProtocol = appName ? 'https' : 'http'; // Fly.io 強制 HTTPS
const PUBLIC_URL = `${serverProtocol}://${publicHost}`; // 公開基礎 URL
const MOBILE_URL = `${PUBLIC_URL}/mobile`; // 手機頁面的公開 URL


// --- 精確設定 CORS ---
const allowedOrigins = [
    PUBLIC_URL, // <--- 使用公開 URL
    // 如果需要本機測試
    `http://localhost:${PORT}`,
    // 'http://<您的本機IP>:3000' // 如有需要可取消註解並填入
];

const io = socketIo(server, {
    cors: {
        origin: function (origin, callback) {
            if (!origin || allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                console.warn(`CORS blocked for origin: ${origin}`);
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"],
    },
    transports: ['websocket'] // <--- 保持強制 WebSocket
});

// --- 卡牌資料與狀態 ---
let cards = []; // 存放所有牌的資訊 { id: number, revealed: boolean, holder: string | null, name: string }
let drawnCards = {}; // 記錄 socket.id -> card.id 的映射
// 將名字列表直接定義為陣列
const namesList = [
    "楊攸仁 髮妝造型顧問", "陳玥月 疤痕紋路修復專家", "何玲君 體態雕塑", "李思賢 保養品業", "吳岳軒 影音行銷",
    "吳佳羽 活動整合企劃", "施建安 品牌設計", "吳金融 AI策略行銷", "熊若堯 專業人像攝影", "李子萱 中英文主持",
    "陳邑歆 花藝設計", "李冬梅 財富流教練", "洪千貽 樹化玉", "倪暉雅 彩繪藝術文創工程", "李雅婷 古物精品代銷業",
    "李侑昌 法式甜點", "賴奕銘 滷味麻辣燙", "李明憲 健康餐盒", "張智堯 咖啡業", "李阡瑅 冷凍水產買賣",
    "温志文 農業生技銷售", "張禎娟 日本清酒", "段兆陽 健康住宅設計", "吳瑞文 住宅房仲", "朱玲瑤 窗簾業",
    "林詠儀 油漆工程", "杜國勇 木作裝修", "林才達 餐廳廚房油污清潔", "洪銘駿 殯葬禮儀業", "王杙鋌 海外留學",
    "李庚育 環控設備業", "石昇弘 商空設計", "劉耀尹 五金工具業", "陳致佐 水電工程", "梁家菖 商用空調",
    "張立群 進口車代表-賓士", "張泰祥 中古車買賣", "李承書 汽車鍍膜包膜", "林祥禔 Google資訊整合顧問", "王瑞謙 資訊科技顧問專業代表",
    "王子伊 頭皮.頭療spa顧問", "陳仕良 三高健康管理師", "黃裕峰 抗紅外線涼感眼鏡", "陳家祥 成人情趣保健品", "陳志豪 遠紅外線照射器材",
    "郭馥瑜 推拿觸療", "林弘偉 自行車業", "黃仲毅 保險與財務規劃顧問", "董帛融 會計師", "歐政儒 律師"
    // 確認這裡剛好是 51 個
];
const TOTAL_CARDS = namesList.length; // 根據名字列表長度決定總牌數

// --- 連線使用者 ---
const connectedUsers = new Map(); // socket.id -> { type: 'screen' | 'mobile', hasDrawn: boolean }


// --- 初始化卡牌 (修改) ---
function initializeCards() {
    cards = [];
    drawnCards = {};
    // cardAssignments 不再需要，名字直接存在 card 物件裡

    if (namesList.length === 0) {
        console.error("錯誤：名字列表是空的，無法初始化卡牌！");
        return;
    }

    // 為每個名字創建一張牌
    for (let i = 0; i < TOTAL_CARDS; i++) {
        const cardId = i + 1; // ID 從 1 開始
        const name = namesList[i];
        cards.push({ id: cardId, revealed: false, holder: null, name: name });
    }

    // 打亂卡牌順序
    cards.sort(() => Math.random() - 0.5);

    console.log(`${TOTAL_CARDS} 張卡牌已初始化並分配名字。`);
}

// 移除舊的 cardNameData，直接呼叫初始化
initializeCards();

// --- 設定靜態檔案目錄 ---
app.use(express.static('public'));

// --- 路由 (修改) ---
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/mobile', (req, res) => {
  res.sendFile(__dirname + '/public/mobile.html');
});

// 新增：提供後台管理頁面
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// 產生 QR code 的路由 (修改)
app.get('/qr', async (req, res) => {
    try {
        console.log(`Generating QR code for: ${MOBILE_URL}`); // <--- 使用公開 URL
        const qrCodeDataUrl = await qrcode.toDataURL(MOBILE_URL); // <--- 使用公開 URL
        res.json({ qrCodeDataUrl });
    } catch (err) {
        console.error('Error generating QR code:', err);
        res.status(500).json({ error: 'Error generating QR code' });
    }
});

// 後台觸發翻牌的端點
app.get('/reveal', (req, res) => {
  // 實際應用中應加入安全驗證
  console.log('Reveal command received from admin.');
  revealCards();
  res.send('Reveal command sent to all connected mobile clients.');
});

// 後台觸發重設的端點
app.get('/reset', (req, res) => {
  // 實際應用中應加入安全驗證
  console.log('Reset command received from admin.');
  resetGame();
  res.send('Game reset. All cards returned, clients notified.');
});


// --- Socket.IO 連線處理 (修改) ---
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  const connectionType = socket.handshake.query.type || 'unknown';
  if (connectionType === 'screen') {
      console.log(`Screen connected: ${socket.id}`);
      connectedUsers.set(socket.id, { type: 'screen', hasDrawn: false });
      socket.emit('updateCards', getPublicCardState());
      // socket.emit('qrCodeUrl', MOBILE_URL); // <--- 移除這個事件

  } else if (connectionType === 'mobile') {
      console.log(`Mobile connected: ${socket.id}`);
      connectedUsers.set(socket.id, { type: 'mobile', hasDrawn: false });
      // 檢查是否已經抽過牌 (例如頁面刷新)
      if (drawnCards[socket.id]) {
          const cardId = drawnCards[socket.id];
          const card = cards.find(c => c.id === cardId);
          if (card) {
              socket.emit('cardDrawn', { id: card.id, revealed: card.revealed, name: card.name });
          }
      } else {
          socket.emit('welcome'); // 告訴手機端已連線，可以顯示抽牌按鈕
      }
  } else {
       console.log(`Unknown connection type from ${socket.id}. Disconnecting.`);
       socket.disconnect();
       return;
  }

  console.log('Connected users:', connectedUsers.size);


  // --- 監聽事件 ---

  // 手機請求抽牌
  socket.on('drawCard', () => {
    const userInfo = connectedUsers.get(socket.id);
    if (!userInfo || userInfo.type !== 'mobile') {
        socket.emit('errorMsg', 'Only mobile clients can draw cards.');
        return;
    }
    if (userInfo.hasDrawn) {
        socket.emit('errorMsg', 'You have already drawn a card.');
        return;
    }

    const availableCard = cards.find(card => !card.holder);
    if (availableCard) {
        availableCard.holder = socket.id; // 標記牌被占用
        drawnCards[socket.id] = availableCard.id; // 記錄誰抽了哪張牌
        userInfo.hasDrawn = true; // 標記此使用者已抽牌

        console.log(`Card ${availableCard.id} drawn by ${socket.id}`);

        // 發送牌的資訊給抽牌者 (不包含名字，revealed 為 false)
        socket.emit('cardDrawn', { id: availableCard.id, revealed: false, name: null });

        // 更新所有大螢幕的狀態
        broadcastToScreens('updateCards', getPublicCardState());
        // 通知所有客戶端剩餘牌數 (可選)
        broadcastToAll('cardsRemaining', getRemainingCardCount());

    } else {
        console.log('No cards left to draw.');
        socket.emit('errorMsg', 'Sorry, no cards left!');
    }
  });

  // 處理斷線
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const userInfo = connectedUsers.get(socket.id);

    // 如果是已抽牌的手機斷線，回收卡牌 (策略可調整)
    if (userInfo && userInfo.type === 'mobile' && userInfo.hasDrawn) {
        const drawnCardId = drawnCards[socket.id];
        if (drawnCardId) {
            const card = cards.find(c => c.id === drawnCardId);
            if (card && !card.revealed) { // 只有未翻牌時才回收
                console.log(`Recycling card ${drawnCardId} from disconnected user ${socket.id}`);
                card.holder = null; // 取消佔用
                delete drawnCards[socket.id];
                // 更新大螢幕
                broadcastToScreens('updateCards', getPublicCardState());
                // 更新剩餘牌數
                broadcastToAll('cardsRemaining', getRemainingCardCount());
            } else if (card && card.revealed) {
                console.log(`User ${socket.id} disconnected after card ${drawnCardId} was revealed. Card not recycled.`);
                 // 這裡可以選擇是否移除已翻牌的牌的佔用者標記，取決於需求
                // card.holder = null;
            }
        }
    }

    connectedUsers.delete(socket.id);
    console.log('Connected users:', connectedUsers.size);
    // 可以廣播目前連線人數給大螢幕
    broadcastToScreens('userCount', connectedUsers.size);
  });
});

// --- 輔助函數 ---

// 新增：Fisher-Yates (Knuth) 隨機排序演算法
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // ES6 交換語法
    }
    return array;
}

// 取得公開的卡牌狀態 (隱藏 holder 和 name)
function getPublicCardState() {
    return cards.map(card => ({
        id: card.id,
        drawn: !!card.holder // 只顯示是否被抽走
    }));
}

// 取得剩餘卡牌數量
function getRemainingCardCount() {
    return cards.filter(card => !card.holder).length;
}

// 向所有客戶端廣播
function broadcastToAll(event, data) {
    io.emit(event, data);
    // console.log(`Broadcasting to all: ${event}`, data);
}

// 向所有大螢幕廣播
function broadcastToScreens(event, data) {
    connectedUsers.forEach((userInfo, socketId) => {
        if (userInfo.type === 'screen') {
            io.to(socketId).emit(event, data);
        }
    });
    // console.log(`Broadcasting to screens: ${event}`, data);
}

// 向所有手機廣播
function broadcastToMobiles(event, data) {
     connectedUsers.forEach((userInfo, socketId) => {
        if (userInfo.type === 'mobile') {
            io.to(socketId).emit(event, data);
        }
    });
    // console.log(`Broadcasting to mobiles: ${event}`, data);
}


// --- 核心遊戲邏輯函數 ---

// 翻牌 (修改以實現配對)
function revealCards() {
    let revealedCount = 0;
    const drawnCardsInfo = []; // 收集所有被抽走的牌

    // 1. 翻牌並收集被抽走的牌
    cards.forEach(card => {
        if (card.holder) { // 只要是被抽走的牌都要處理
            if (!card.revealed) {
                // 翻牌邏輯 (通知手機)
                card.revealed = true;
                const holderSocketId = card.holder;
                const mobileClient = io.sockets.sockets.get(holderSocketId);
                if (mobileClient) {
                    mobileClient.emit('revealCard', { id: card.id, revealed: true, name: card.name });
                    revealedCount++;
                } else {
                    console.warn(`Cannot find socket for holder ${holderSocketId} of card ${card.id} during reveal.`);
                }
            }
            // 將被抽走的牌（無論是否剛翻開）加入列表以供配對
            drawnCardsInfo.push({ id: card.id, name: card.name });
        }
    });
    console.log(`Revealed ${revealedCount} new cards. Total drawn cards for pairing: ${drawnCardsInfo.length}`);

    // 2. 隨機排序被抽走的牌
    const shuffledDrawnCards = shuffleArray([...drawnCardsInfo]); // 使用副本進行排序

    // 3. 進行兩兩配對
    const pairings = [];
    let groupNumber = 1;
    for (let i = 0; i < shuffledDrawnCards.length; i += 2) {
        const pair = [];
        pair.push(shuffledDrawnCards[i]); // 第一個人
        if (i + 1 < shuffledDrawnCards.length) {
            pair.push(shuffledDrawnCards[i + 1]); // 第二個人 (如果存在)
        }
        pairings.push({ group: groupNumber++, members: pair });
    }

    console.log('Generated pairings:', pairings);

    // 4. 向所有大螢幕廣播配對結果
    broadcastToScreens('showPairingResults', pairings); // 使用新的事件名稱
}

// 重設遊戲 (修改)
function resetGame() {
    console.log('Resetting game state...');
    initializeCards();

    broadcastToAll('gameReset');

    // 更新大螢幕狀態
    broadcastToScreens('updateCards', getPublicCardState());
    broadcastToScreens('userCount', connectedUsers.size);
    broadcastToScreens('showPairingResults', []); // 發送空配對結果以清除顯示

    // 通知手機端返回初始狀態
    broadcastToMobiles('welcome');
}


// --- 啟動伺服器 (修改) ---
server.listen(PORT, '0.0.0.0', () => { // <-- 監聽在 0.0.0.0
  // 監聽在 0.0.0.0 上，以便 Fly.io 可以正確轉發
  console.log(`Server internal listening on port ${PORT}`); // 顯示內部監聽端口
  console.log(`App publicly available at: ${PUBLIC_URL}`); // 顯示公開網址
  console.log(`Admin interface: ${PUBLIC_URL}/admin`); // 顯示公開後台網址
  console.log(`Mobile page: ${MOBILE_URL}`); // 顯示公開手機網址
  // 初始廣播狀態
  broadcastToScreens('updateCards', getPublicCardState());
  broadcastToScreens('userCount', connectedUsers.size);
}); 