// server.js (Revised Flow: Enter Name -> Confirm -> Pair)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);

// --- 取得公開網址 ---
const appName = process.env.FLY_APP_NAME;
const PORT = process.env.PORT || 3000;
const publicHost = appName ? `${appName}.fly.dev` : 'localhost';
const serverProtocol = appName ? 'https' : 'http';
const PUBLIC_URL = `${serverProtocol}://${publicHost}`;
const MOBILE_URL = `${PUBLIC_URL}/mobile`;

// --- 精確設定 CORS ---
const allowedOrigins = [
    PUBLIC_URL,
    `http://localhost:${PORT}`,
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
    transports: ['websocket'] // 維持強制 WebSocket
});

// --- 參與者資料結構 ---
// 使用 Map: socket.id -> { name: string, joined: boolean, confirmed: boolean, type: 'screen' | 'mobile' | 'unknown' }
const participants = new Map();
let pairingResults = []; // 儲存配對結果供後續日期分配

// --- 輔助函數 ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 取得公開的參與者資訊 (例如人數)
function getPublicParticipantState() {
    const confirmedCount = Array.from(participants.values()).filter(p => p.type === 'mobile' && p.confirmed).length;
    const joinedCount = Array.from(participants.values()).filter(p => p.type === 'mobile' && p.joined).length; // 只計算已輸入名字的手機端
    const mobileUsers = Array.from(participants.values()).filter(p => p.type === 'mobile' && p.name).map(p => ({name: p.name, confirmed: p.confirmed}));
    const totalConnections = participants.size; // 所有連線數

    return {
        totalJoined: joinedCount, // 已輸入名字的人數
        totalConfirmed: confirmedCount, // 已確認的人數
        participantsList: mobileUsers, // 可以選擇是否顯示列表
        totalConnections: totalConnections // 總連線數 (包含螢幕)
    };
}

// 廣播給大螢幕
function broadcastToScreens(event, data) {
    io.sockets.sockets.forEach(socket => {
        const pInfo = participants.get(socket.id);
        // 確保是大螢幕連線
        if (pInfo && pInfo.type === 'screen') {
             socket.emit(event, data);
        }
    });
}
// 廣播給所有手機
function broadcastToMobiles(event, data) {
     io.sockets.sockets.forEach(socket => {
        const pInfo = participants.get(socket.id);
        if (pInfo && pInfo.type === 'mobile') {
             socket.emit(event, data);
        }
    });
}

// 廣播給所有客戶端 (包含螢幕和手機)
function broadcastToAll(event, data) {
    io.emit(event, data);
}


// --- 設定靜態檔案目錄 ---
app.use(express.static('public'));

// --- 路由 ---
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/mobile', (req, res) => {
  res.sendFile(__dirname + '/public/mobile.html');
});

app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// 產生 QR code 的路由 (不變)
app.get('/qr', async (req, res) => {
    try {
        console.log(`Generating QR code for: ${MOBILE_URL}`);
        const qrCodeDataUrl = await qrcode.toDataURL(MOBILE_URL);
        res.json({ qrCodeDataUrl });
    } catch (err) {
        console.error('Error generating QR code:', err);
        res.status(500).json({ error: 'Error generating QR code' });
    }
});

// 修改：後台觸發 配對 的端點
app.get('/start-pairing', (req, res) => { // <-- URL 修改
  // 實際應用中應加入安全驗證
  console.log('Start pairing command received from admin.');
  startPairing(); // <-- 呼叫新的函數名
  res.send('Pairing process started. Results sent to clients.');
});

// 後台觸發重設的端點 (不變，但內部會呼叫新的 resetGame)
app.get('/reset', (req, res) => {
  // 實際應用中應加入安全驗證
  console.log('Reset command received from admin.');
  resetGame();
  res.send('Game reset. All participants removed, clients notified.');
});


// --- Socket.IO 連線處理 (重寫) ---
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // 暫時先不區分類型，等收到 joinGame 或 registerScreen 再確定
  participants.set(socket.id, { name: null, joined: false, confirmed: false, type: 'unknown' });
  console.log('Current participants count:', participants.size);
  // 不需要立即廣播人數，等確定類型後再廣播


  // 監聽手機端加入遊戲的事件
  socket.on('joinGame', (name) => {
      // 檢查是否已加入或確認
      const existingPInfo = participants.get(socket.id);
      if (existingPInfo && existingPInfo.joined) {
          console.warn(`User ${socket.id} (${existingPInfo.name}) tried to join again.`);
          socket.emit('joinError', '您已經加入過了！');
          return;
      }

      if (!name || typeof name !== 'string' || name.trim() === '') {
          socket.emit('joinError', '請輸入有效的名字！');
          // 如果加入失敗，保持 'unknown' 狀態或移除？考慮移除以防混淆
          // participants.delete(socket.id);
          return;
      }
      const trimmedName = name.trim();
      console.log(`User ${socket.id} attempting to join as ${trimmedName}`);

      // // 檢查名字是否已被使用 (可選)
      // let nameExists = false;
      // for (let p of participants.values()) {
      //     if (p.type === 'mobile' && p.name === trimmedName) {
      //         nameExists = true;
      //         break;
      //     }
      // }
      // if (nameExists) {
      //      socket.emit('joinError', `名字 "${trimmedName}" 已經有人使用了！`);
      //      return;
      // }

      // 記錄參與者資訊，並標記為 mobile
      participants.set(socket.id, { name: trimmedName, joined: true, confirmed: false, type: 'mobile' });
      console.log(`Participant ${trimmedName} (${socket.id}) joined.`);
      socket.emit('joinSuccess', { name: trimmedName }); // 告知加入成功
      broadcastToScreens('participantState', getPublicParticipantState()); // 更新大螢幕狀態
  });

  // 監聽手機端確認參與配對的事件
  socket.on('confirmParticipation', () => {
      const pInfo = participants.get(socket.id);
      // 必須是已加入的手機端才能確認
      if (!pInfo || pInfo.type !== 'mobile' || !pInfo.joined) {
          console.warn(`Confirm attempt from invalid user: ${socket.id}`, pInfo);
          socket.emit('confirmError', '您需要先加入才能確認！');
          return;
      }
      if (pInfo.confirmed) {
           socket.emit('alreadyConfirmed', '您已經確認過了。'); // 使用特定事件
           return; // 避免重複確認
      }

      pInfo.confirmed = true;
      console.log(`Participant ${pInfo.name} (${socket.id}) confirmed participation.`);
      socket.emit('confirmSuccess'); // 告知確認成功
      broadcastToScreens('participantState', getPublicParticipantState()); // 更新大螢幕狀態 (已確認人數)
  });

  // 監聽大螢幕註冊事件
  socket.on('registerScreen', () => {
        const pInfo = participants.get(socket.id);
        // 只有 'unknown' 狀態的連線可以註冊為螢幕
        if (pInfo && pInfo.type === 'unknown') {
            pInfo.type = 'screen';
            console.log(`Screen registered: ${socket.id}`);
            // 發送初始狀態給這個螢幕
            socket.emit('participantState', getPublicParticipantState());
            if (pairingResults.length > 0) { // 如果已有結果，發送給新連線的螢幕
                socket.emit('showPairingResults', pairingResults);
            }
        } else {
             console.warn(`Attempt to register non-unknown connection as screen: ${socket.id}`, pInfo);
        }
  });


  // 處理斷線
  socket.on('disconnect', (reason) => {
    const pInfo = participants.get(socket.id);
    if (pInfo) {
        if (pInfo.type === 'mobile' && pInfo.name) {
            console.log(`Participant ${pInfo.name} (${socket.id}) disconnected. Reason: ${reason}`);
            // 如果需要，可以在這裡加入回收邏輯 (如果尚未配對且已確認？)
            // 但目前邏輯是配對後才重要，斷線就斷線了
        } else if (pInfo.type === 'screen') {
            console.log(`Screen ${socket.id} disconnected. Reason: ${reason}`);
        } else {
             console.log(`User ${socket.id} (type: unknown) disconnected. Reason: ${reason}`);
        }
        participants.delete(socket.id); // 從 Map 中移除
        console.log('Current participants count:', participants.size);
        broadcastToScreens('participantState', getPublicParticipantState()); // 更新大螢幕狀態
    } else {
        console.log(`Disconnected user not found in participants map: ${socket.id}. Reason: ${reason}`);
    }
  });

    // 增加錯誤處理
    socket.on('error', (err) => {
        console.error(`Socket error for ${socket.id}:`, err);
    });

});


// --- 核心遊戲邏輯函數 (重寫/改名) ---

// 開始配對
function startPairing() {
    // 1. 收集所有已確認參與的手機端玩家
    const confirmedParticipants = [];
    participants.forEach((pInfo, socketId) => {
        if (pInfo.type === 'mobile' && pInfo.confirmed) {
            confirmedParticipants.push({ id: socketId, name: pInfo.name });
        }
    });

    if (confirmedParticipants.length < 2) {
        console.warn('Not enough confirmed participants to start pairing.');
        // 可以考慮廣播一個訊息給管理員或大螢幕
        broadcastToScreens('pairingError', '確認人數不足 (至少需要2人)，無法開始配對！');
        return;
    }

    console.log(`Starting pairing for ${confirmedParticipants.length} participants...`);

    // 2. 隨機排序
    const shuffledParticipants = shuffleArray([...confirmedParticipants]);

    // 3. 進行兩兩配對
    pairingResults = []; // 清空舊結果
    let groupNumber = 1;
    for (let i = 0; i < shuffledParticipants.length; i += 2) {
        const pair = [];
        const member1 = shuffledParticipants[i];
        pair.push({ id: member1.id, name: member1.name }); // 包含 id 和 name

        if (i + 1 < shuffledParticipants.length) {
            const member2 = shuffledParticipants[i + 1];
            pair.push({ id: member2.id, name: member2.name });
        } else {
             // 如果人數是奇數，最後一人輪空 (可以在配對結果中標註)
             pair.push({ id: null, name: '輪空' }); // 標示輪空
             console.log(`Participant ${member1.name} (${member1.id}) is unpaired this round.`);
        }
        pairingResults.push({ group: groupNumber++, members: pair });
    }

    console.log('Generated pairings:', JSON.stringify(pairingResults, null, 2)); // 打印更易讀的結果

    // 4. 向所有大螢幕廣播完整配對結果
    broadcastToScreens('showPairingResults', pairingResults);

    // 5. 分別通知每個手機客戶端他們的配對結果
    pairingResults.forEach(pair => {
        const member1 = pair.members[0];
        const member2 = pair.members.length > 1 ? pair.members[1] : null; // 第二個成員可能是輪空標記

        // 通知成員1
        if (member1 && member1.id) { // 確保成員1是真實參與者
            const socket1 = io.sockets.sockets.get(member1.id);
            if (socket1) {
                 // 如果 member2 存在且有 id，則他是夥伴；否則輪空
                const partner = (member2 && member2.id) ? { name: member2.name } : null;
                socket1.emit('yourPairing', { partner: partner, group: pair.group });
            } else {
                 console.warn(`Socket not found for participant ${member1.name} (${member1.id})`);
            }
        }

        // 通知成員2 (如果存在且不是輪空標記)
        if (member2 && member2.id) {
            const socket2 = io.sockets.sockets.get(member2.id);
            if (socket2) {
                 // 成員2的夥伴永遠是成員1
                const partner = member1 ? { name: member1.name } : null; // 理論上 member1 總會存在
                 socket2.emit('yourPairing', { partner: partner, group: pair.group });
            } else {
                console.warn(`Socket not found for participant ${member2.name} (${member2.id})`);
            }
        }
    });
    console.log('Sent individual pairing results to mobile clients.');
    broadcastToScreens('pairingComplete'); // 告知大螢幕配對流程結束
}

// 重設遊戲
function resetGame() {
    console.log('Resetting game state...');
    participants.clear(); // 清空所有參與者
    pairingResults = []; // 清空配對結果

    // 通知所有客戶端遊戲已重設
    // 手機端收到 reset 會回到初始輸入名字狀態
    // 大螢幕收到 reset 會清除參與者和結果顯示
    broadcastToAll('gameReset'); // 使用 broadcastToAll 確保所有人都收到

    // 重設後立即廣播空的狀態給大螢幕 (因為 participants Map 已清空)
    broadcastToScreens('participantState', getPublicParticipantState());
    broadcastToScreens('showPairingResults', []);

    console.log('Game reset complete.');
}


// --- 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server internal listening on port ${PORT}`);
  console.log(`App publicly available at: ${PUBLIC_URL}`);
  console.log(`Admin interface: ${PUBLIC_URL}/admin`);
  console.log(`Mobile page: ${MOBILE_URL}`);
});

// 增加全域錯誤處理，捕捉未處理的 Promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // 這裡可以考慮是否需要優雅地關閉伺服器或其他處理
});

// 捕捉未處理的同步錯誤
process.on('uncaughtException', (err, origin) => {
  console.error(`Caught exception: ${err}\n` + `Exception origin: ${origin}`);
  // 考慮記錄錯誤後退出進程，讓 Fly.io 重啟
  // process.exit(1);
}); 