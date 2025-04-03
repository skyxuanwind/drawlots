// server.js (Revised Flow: Enter Name -> Confirm & Draw Visual Card -> Pair -> Reveal)
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
    transports: ['websocket']
});

// --- 資料結構 ---
// 參與者: socket.id -> { name: string, joined: boolean, confirmed: boolean, type: 'screen' | 'mobile' | 'unknown', visualCardId: number | null }
const participants = new Map();
// 視覺卡牌: { id: number, drawn: boolean, revealed: boolean } - 只用於視覺追蹤
let visualCards = [];
const TOTAL_VISUAL_CARDS = 50; // <-- 改回 50
let pairingResults = []; // 儲存配對結果

// --- 初始化視覺卡牌 ---
function initializeVisualCards() {
    visualCards = [];
    for (let i = 1; i <= TOTAL_VISUAL_CARDS; i++) {
        visualCards.push({ id: i, drawn: false, revealed: false });
    }
    console.log(`${TOTAL_VISUAL_CARDS} visual cards initialized.`);
}
initializeVisualCards(); // 初始化

// --- 輔助函數 ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 取得公開的參與者資訊
function getPublicParticipantState() {
    const confirmedCount = Array.from(participants.values()).filter(p => p.type === 'mobile' && p.confirmed).length;
    const joinedCount = Array.from(participants.values()).filter(p => p.type === 'mobile' && p.joined).length;
    const mobileUsers = Array.from(participants.values()).filter(p => p.type === 'mobile' && p.name).map(p => ({name: p.name, confirmed: p.confirmed}));
    const totalConnections = participants.size;

    return {
        totalJoined: joinedCount,
        totalConfirmed: confirmedCount,
        participantsList: mobileUsers,
        totalConnections: totalConnections
    };
}

// 取得公開的視覺卡牌狀態 (用於大螢幕)
function getPublicCardState() {
    // 只需 id, drawn, revealed 狀態
    return visualCards.map(card => ({
        id: card.id,
        drawn: card.drawn,
        revealed: card.revealed,
        // Name is added dynamically during reveal on the screen side if needed
    }));
}

// 廣播給大螢幕
function broadcastToScreens(event, data) {
    io.sockets.sockets.forEach(socket => {
        const pInfo = participants.get(socket.id);
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
// 廣播給所有客戶端
function broadcastToAll(event, data) {
    io.emit(event, data);
}

// --- 設定靜態檔案目錄 ---
app.use(express.static('public'));

// --- 路由 ---
app.get('/', (req, res) => { res.sendFile(__dirname + '/public/index.html'); });
app.get('/mobile', (req, res) => { res.sendFile(__dirname + '/public/mobile.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/public/admin.html'); });
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
app.get('/start-pairing', (req, res) => {
  console.log('Start pairing command received from admin.');
  startPairingAndReveal(); // <-- 改為調用新函數
  res.send('Pairing and reveal process started.');
});
app.get('/reset', (req, res) => {
  console.log('Reset command received from admin.');
  resetGame();
  res.send('Game reset. All participants and cards reset, clients notified.');
});

// --- NEW: Simulate All Confirmed Route (Revised) ---
app.get('/simulate-all-confirmed', (req, res) => {
    console.log('Simulate all confirmed command received.');
    let assignedCount = 0;
    let newlyConfirmedCount = 0;

    // 1. Find all connected mobile users who have joined but not confirmed
    const unconfirmedMobiles = [];
    participants.forEach((pInfo, socketId) => {
        if (pInfo.type === 'mobile' && pInfo.joined && !pInfo.confirmed) {
             unconfirmedMobiles.push({ id: socketId, info: pInfo });
        }
    });
    console.log(`Found ${unconfirmedMobiles.length} unconfirmed mobile users.`);

    // 2. Iterate through ALL visual cards
    visualCards.forEach(card => {
        if (!card.drawn) {
            // Mark the card as drawn REGARDLESS of user assignment
            card.drawn = true; 

            // Try to assign it to an actual unconfirmed user
            const userToAssign = unconfirmedMobiles.pop(); 
            if (userToAssign) {
                 userToAssign.info.confirmed = true;
                 userToAssign.info.visualCardId = card.id;
                 assignedCount++;
                 newlyConfirmedCount++;
                 console.log(`Simulated confirmation for ${userToAssign.info.name} (${userToAssign.id}), assigned visual card ${card.id}`);
                 
                 // Emit events to the specific simulated user's socket
                 const userSocket = io.sockets.sockets.get(userToAssign.id);
                 if(userSocket) {
                     userSocket.emit('confirmSuccess'); 
                     userSocket.emit('cardAssigned', { cardId: card.id });
                     console.log(`Emitted events to simulated user ${userToAssign.info.name}`);
                 } else {
                      console.warn(`Socket not found for simulated user ${userToAssign.info.name} (${userToAssign.id}) during simulation emission.`);
                 }
            } else {
                 // No user to assign this card to, but it's marked as drawn anyway.
                 console.log(`Visual card ${card.id} marked as drawn (no user assigned).`);
            }
        }
    });

    // 3. Mark any remaining unconfirmed users (if cards ran out first) as confirmed
    unconfirmedMobiles.forEach(user => {
        if (!user.info.confirmed) {
             user.info.confirmed = true;
             newlyConfirmedCount++;
             console.log(`Marked remaining unconfirmed user ${user.info.name} (${user.id}) as confirmed (no card assigned).`);
             const userSocket = io.sockets.sockets.get(user.id);
             if(userSocket) {
                 userSocket.emit('confirmSuccess'); // Still notify them
             }
        }
    });

    // 4. Broadcast updated states to screens
    broadcastToScreens('participantState', getPublicParticipantState());
    broadcastToScreens('updateCards', getPublicCardState()); // This now reflects ALL cards as drawn

    console.log(`Simulation finished. Assigned ${assignedCount} cards. Confirmed ${newlyConfirmedCount} users.`);
    res.send(`Simulation complete. All ${TOTAL_VISUAL_CARDS} visual cards marked as drawn. Confirmed ${newlyConfirmedCount} users.`);
});

// --- Socket.IO 連線處理 ---
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  participants.set(socket.id, { name: null, joined: false, confirmed: false, type: 'unknown', visualCardId: null });
  console.log('Current participants count:', participants.size);

  // 監聽手機端加入遊戲
  socket.on('joinGame', (name) => {
      const existingPInfo = participants.get(socket.id);
      if (existingPInfo && existingPInfo.joined) {
          socket.emit('joinError', '您已經加入過了！'); return;
      }
      if (!name || typeof name !== 'string' || name.trim() === '') {
          socket.emit('joinError', '請輸入有效的名字！'); return;
      }
      const trimmedName = name.trim();
      console.log(`User ${socket.id} attempting to join as ${trimmedName}`);
      participants.set(socket.id, { name: trimmedName, joined: true, confirmed: false, type: 'mobile', visualCardId: null });
      console.log(`Participant ${trimmedName} (${socket.id}) joined.`);
      socket.emit('joinSuccess', { name: trimmedName });
      broadcastToScreens('participantState', getPublicParticipantState());
  });

  // 監聽手機端確認參與 (抽視覺牌)
  socket.on('confirmParticipation', () => {
      const pInfo = participants.get(socket.id);
      if (!pInfo || pInfo.type !== 'mobile' || !pInfo.joined) {
          socket.emit('confirmError', '您需要先加入才能確認！'); return;
      }
      if (pInfo.confirmed) {
           socket.emit('alreadyConfirmed', '您已經確認過了。'); return;
      }

      // 尋找一張未被抽走的視覺卡牌
      const availableVisualCard = visualCards.find(card => !card.drawn);
      if (!availableVisualCard) {
           console.warn(`No visual cards left for participant ${pInfo.name} (${socket.id})`);
           socket.emit('confirmError', '抱歉，所有卡牌已被抽完！');
           return;
      }

      // 分配視覺卡牌
      availableVisualCard.drawn = true;
      pInfo.confirmed = true; // 標記已確認
      pInfo.visualCardId = availableVisualCard.id; // 記錄分配到的視覺卡牌ID

      console.log(`Participant ${pInfo.name} (${socket.id}) confirmed and drew visual card ${availableVisualCard.id}.`);
      socket.emit('confirmSuccess'); // 告知確認成功
      socket.emit('cardAssigned', { cardId: availableVisualCard.id }); // <--- 新事件：告知手機分配到的卡牌ID
      broadcastToScreens('participantState', getPublicParticipantState()); // 更新參與者狀態
      broadcastToScreens('updateCards', getPublicCardState()); // <--- 更新大螢幕卡牌狀態
  });

  // 監聽大螢幕註冊
  socket.on('registerScreen', () => {
        const pInfo = participants.get(socket.id);
        if (pInfo && pInfo.type === 'unknown') {
            pInfo.type = 'screen';
            console.log(`Screen registered: ${socket.id}`);
            socket.emit('participantState', getPublicParticipantState());
            socket.emit('updateCards', getPublicCardState()); // <--- 發送初始卡牌狀態
            if (pairingResults.length > 0) {
                socket.emit('showPairingResults', pairingResults);
                // 如果已有結果，也需要告知卡牌的最終狀態 (包含名字)
                const finalCardState = visualCards.map(vc => {
                    let cardName = null;
                    if (vc.revealed) {
                        // Find the participant who drew this card
                        for(let p of participants.values()){
                            if(p.visualCardId === vc.id){
                                cardName = p.name;
                                break;
                            }
                        }
                    }
                    return { ...vc, name: cardName };
                });
                 socket.emit('updateCards', finalCardState); // Send revealed state
                 // Optionally re-trigger reveal effect if needed, or just send final state
            }
        } else {
             console.warn(`Attempt to register non-unknown connection as screen: ${socket.id}`, pInfo);
        }
  });

  // 處理斷線
  socket.on('disconnect', (reason) => {
    const pInfo = participants.get(socket.id);
    if (pInfo) {
        console.log(`User ${socket.id} (type: ${pInfo.type}, name: ${pInfo.name}) disconnected. Reason: ${reason}`);
        // 如果是已確認但尚未配對的手機端斷線，回收視覺卡牌
        if (pInfo.type === 'mobile' && pInfo.confirmed && pInfo.visualCardId && pairingResults.length === 0) {
             const visualCard = visualCards.find(vc => vc.id === pInfo.visualCardId);
             if (visualCard && visualCard.drawn && !visualCard.revealed) {
                 visualCard.drawn = false; // 取消佔用
                 console.log(`Recycled visual card ${visualCard.id} from disconnected participant ${pInfo.name}.`);
                 broadcastToScreens('updateCards', getPublicCardState()); // 更新大螢幕卡牌狀態
             }
        }
        participants.delete(socket.id);
        console.log('Current participants count:', participants.size);
        broadcastToScreens('participantState', getPublicParticipantState());
    } else {
        console.log(`Disconnected user not found in participants map: ${socket.id}. Reason: ${reason}`);
    }
  });

  socket.on('error', (err) => {
      console.error(`Socket error for ${socket.id}:`, err);
  });
});

// --- 核心遊戲邏輯 ---

// 修改：合併配對與揭曉邏輯
function startPairingAndReveal() {
    // 1. 收集已確認的參與者
    const confirmedParticipants = [];
    participants.forEach((pInfo, socketId) => {
        if (pInfo.type === 'mobile' && pInfo.confirmed) {
            // 確保他們確實有分配到視覺卡牌 (理論上應該要有)
             if (pInfo.visualCardId) {
                confirmedParticipants.push({ id: socketId, name: pInfo.name, visualCardId: pInfo.visualCardId });
             } else {
                 console.warn(`Confirmed participant ${pInfo.name} (${socketId}) is missing a visualCardId!`);
             }
        }
    });

    if (confirmedParticipants.length < 2) {
        console.warn('Not enough confirmed participants to start pairing.');
        broadcastToScreens('pairingError', '確認人數不足 (至少需要2人)，無法開始配對！');
        return;
    }

    console.log(`Starting pairing for ${confirmedParticipants.length} participants...`);

    // 2. 隨機排序參與者 (進行配對)
    const shuffledParticipants = shuffleArray([...confirmedParticipants]);
    pairingResults = [];
    let groupNumber = 1;
    for (let i = 0; i < shuffledParticipants.length; i += 2) {
        const pair = [];
        const member1 = shuffledParticipants[i];
        pair.push({ id: member1.id, name: member1.name }); // 配對結果只需要 id 和 name

        let member2 = null;
        if (i + 1 < shuffledParticipants.length) {
            member2 = shuffledParticipants[i + 1];
            pair.push({ id: member2.id, name: member2.name });
        } else {
             pair.push({ id: null, name: '輪空' });
             console.log(`Participant ${member1.name} (${member1.id}) is unpaired this round.`);
        }
        pairingResults.push({ group: groupNumber++, members: pair });

        // --- 同步進行視覺卡牌揭曉準備 ---
        // 標記成員1的視覺卡牌為已揭曉
        const visualCard1 = visualCards.find(vc => vc.id === member1.visualCardId);
        if (visualCard1) {
            visualCard1.revealed = true;
        }
        // 標記成員2的視覺卡牌為已揭曉 (如果存在)
        if (member2) {
            const visualCard2 = visualCards.find(vc => vc.id === member2.visualCardId);
             if (visualCard2) {
                 visualCard2.revealed = true;
             }
        }
    }
    console.log('Generated pairings:', JSON.stringify(pairingResults, null, 2));

    // --- 揭曉階段 ---
    // 3. 向大螢幕廣播配對結果
    broadcastToScreens('showPairingResults', pairingResults);

    // 4. 向大螢幕廣播每張卡牌的揭曉事件 (包含名字)
    confirmedParticipants.forEach(p => {
         broadcastToScreens('revealCard', { cardId: p.visualCardId, name: p.name });
    });
    console.log('Sent reveal commands for visual cards to screens.');


    // 5. 向手機端發送各自的配對夥伴
    pairingResults.forEach(pair => {
        const member1 = pair.members[0];
        const member2 = pair.members.length > 1 ? pair.members[1] : null;

        if (member1 && member1.id) {
            const socket1 = io.sockets.sockets.get(member1.id);
            if (socket1) {
                const partner = (member2 && member2.id) ? { name: member2.name } : null;
                socket1.emit('yourPairing', { partner: partner, group: pair.group });
            } else { console.warn(`Socket not found for participant ${member1.name} (${member1.id})`); }
        }
        if (member2 && member2.id) {
            const socket2 = io.sockets.sockets.get(member2.id);
            if (socket2) {
                const partner = member1 ? { name: member1.name } : null;
                 socket2.emit('yourPairing', { partner: partner, group: pair.group });
            } else { console.warn(`Socket not found for participant ${member2.name} (${member2.id})`); }
        }
    });
    console.log('Sent individual pairing results to mobile clients.');
    broadcastToScreens('pairingComplete');
}

// 重設遊戲
function resetGame() {
    console.log('Resetting game state...');
    participants.clear();
    pairingResults = [];
    initializeVisualCards(); // 重設視覺卡牌狀態

    broadcastToAll('gameReset');
    broadcastToScreens('participantState', getPublicParticipantState());
    broadcastToScreens('updateCards', getPublicCardState()); // 發送初始卡牌狀態
    broadcastToScreens('showPairingResults', []); // 清空配對結果顯示

    console.log('Game reset complete.');
}

// --- 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server internal listening on port ${PORT}`);
  console.log(`App publicly available at: ${PUBLIC_URL}`);
  console.log(`Admin interface: ${PUBLIC_URL}/admin`);
  console.log(`Mobile page: ${MOBILE_URL}`);
});
process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (err, origin) => { console.error(`Caught exception: ${err}\n` + `Exception origin: ${origin}`); }); 