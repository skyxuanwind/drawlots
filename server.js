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

// --- NEW: Default Participant List ---
const defaultParticipantList = [
    '楊攸仁', '陳玥月', '何玲君', '李思賢', '吳岳軒', '吳佳羽', '施建安', '吳金融', '熊若堯', '李子萱',
    '陳邑歆', '李冬梅', '洪千貽', '倪暉雅', '李雅婷', '李侑昌', '賴奕銘', '李明憲', '張智堯', '李阡瑅',
    '温志文', '張禎娟', '段兆陽', '吳瑞文', '朱玲瑤', '林詠儀', '杜國勇', '林才達', '洪銘駿', '王杙鋌',
    '李庚育', '石昇弘', '劉耀尹', '陳致佐', '梁家菖', '張立群', '張泰祥', '李承書', '林祥禔', '王瑞謙',
    '王子伊', '陳仕良', '黃裕峰', '陳家祥', '陳志豪', '郭馥瑜', '林弘偉', '黃仲毅', '董帛融', '歐政儒',
    '陳建男'
];
console.log(`Default participant list loaded with ${defaultParticipantList.length} names.`);

// --- 資料結構 ---
// 參與者: socket.id -> { name: string, joined: boolean, confirmed: boolean, type: 'screen' | 'mobile' | 'unknown', visualCardId: number | null }
const participants = new Map();
// 視覺卡牌: { id: number, drawn: boolean, revealed: boolean } - 只用於視覺追蹤
let visualCards = [];
const TOTAL_VISUAL_CARDS = 51;
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

// --- NEW: Simulate All Confirmed Route (Revised Again for Full Simulation) ---
app.get('/simulate-all-confirmed', (req, res) => {
    console.log('Simulate all confirmed command received (Full Simulation).');
    let assignedToRealUserCount = 0;
    let mockParticipantsCreated = 0;
    let newlyConfirmedRealUsers = 0;

    // 1. Find actual connected mobile users who have joined but not confirmed
    const unconfirmedMobiles = [];
    participants.forEach((pInfo, socketId) => {
        // Ensure it's a real mobile user (not a previous simulation) and unconfirmed
        if (pInfo.type === 'mobile' && pInfo.joined && !pInfo.confirmed && !socketId.startsWith('simulated_')) {
             unconfirmedMobiles.push({ id: socketId, info: pInfo });
        }
    });
    console.log(`Found ${unconfirmedMobiles.length} actual unconfirmed mobile users.`);

    // 2. Iterate through ALL visual cards
    for (let i = 1; i <= TOTAL_VISUAL_CARDS; i++) {
        const cardId = i;
        const visualCard = visualCards.find(vc => vc.id === cardId);

        if (visualCard && !visualCard.drawn) {
            // Mark the card as drawn
            visualCard.drawn = true;

            // Try to assign it to an actual unconfirmed user first
            const userToAssign = unconfirmedMobiles.pop();
            if (userToAssign) {
                 userToAssign.info.confirmed = true;
                 userToAssign.info.visualCardId = cardId;
                 assignedToRealUserCount++;
                 newlyConfirmedRealUsers++;
                 console.log(`Simulated confirmation for real user ${userToAssign.info.name} (${userToAssign.id}), assigned visual card ${cardId}`);

                 // Emit events to the specific simulated user's socket
                 const userSocket = io.sockets.sockets.get(userToAssign.id);
                 if(userSocket) {
                     userSocket.emit('confirmSuccess');
                     userSocket.emit('cardAssigned', { cardId: cardId });
                     console.log(`Emitted events to simulated real user ${userToAssign.info.name}`);
                 } else {
                      console.warn(`Socket not found for simulated real user ${userToAssign.info.name} (${userToAssign.id})`);
                 }
            } else {
                // No more actual users, create a mock participant for this card
                const mockSocketId = `simulated_${cardId}`; // Create a unique mock ID
                // Avoid overwriting if a mock participant already exists (e.g., multiple clicks)
                if (!participants.has(mockSocketId)) {
                    const mockParticipantInfo = {
                        name: `模擬者 ${cardId}`,
                        joined: true,
                        confirmed: true,
                        type: 'mobile',
                        visualCardId: cardId
                    };
                    participants.set(mockSocketId, mockParticipantInfo);
                    mockParticipantsCreated++;
                    console.log(`Created mock participant for visual card ${cardId}`);
                } else {
                     console.log(`Mock participant for card ${cardId} already exists.`);
                     // Ensure the existing mock is marked confirmed if somehow it wasn't
                     const existingMock = participants.get(mockSocketId);
                     existingMock.confirmed = true;
                     existingMock.visualCardId = cardId; // Ensure card ID is linked
                     visualCard.drawn = true; // Ensure card is marked drawn
                }
            }
        }
    } // End of card iteration

    // 3. Mark any remaining actual unconfirmed users (if cards ran out first - less likely now)
    unconfirmedMobiles.forEach(user => {
        if (!user.info.confirmed) {
             user.info.confirmed = true;
             newlyConfirmedRealUsers++;
             console.log(`Marked remaining real unconfirmed user ${user.info.name} (${user.id}) as confirmed (no card assigned).`);
             const userSocket = io.sockets.sockets.get(user.id);
             if(userSocket) {
                 userSocket.emit('confirmSuccess');
             }
        }
    });

    // 4. Broadcast updated states to screens
    console.log('Broadcasting final states after full simulation.');
    broadcastToScreens('participantState', getPublicParticipantState());
    broadcastToScreens('updateCards', getPublicCardState()); // Reflects all cards drawn

    console.log(`Simulation finished. Assigned ${assignedToRealUserCount} cards to real users. Created ${mockParticipantsCreated} mock participants. Confirmed ${newlyConfirmedRealUsers} real users.`);
    res.send(`Full simulation complete. All ${TOTAL_VISUAL_CARDS} visual cards marked as drawn. Created ${mockParticipantsCreated} mock participants. Confirmed ${newlyConfirmedRealUsers} real users.`);
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

  // --- NEW: Handle Pairing and Assigning Absent Participants ---
  socket.on('pairAndAssignAbsent', (data) => {
      console.log('Received request to pair absent participants:', data);
      const absentNames = data.absentNames || [];

      if (absentNames.length === 0) {
          console.log('No absent names to pair.');
          return; // Nothing to do
      }

      // --- Pair the absent participants ---
      const shuffledAbsent = shuffleArray([...absentNames]);
      const absentPairings = [];
      let absentUnpaired = null; // Possible unpaired among absent
      // Start group numbers after the last confirmed group number
      let currentMaxGroup = 0;
      if (pairingResults.length > 0) {
           currentMaxGroup = Math.max(...pairingResults.map(p => p.group));
      }
      let absentGroupNumber = currentMaxGroup + 1;

      for (let i = 0; i < shuffledAbsent.length; i += 2) {
          const pair = [];
          const member1 = { id: `absent_${i}`, name: shuffledAbsent[i] }; // Use pseudo-ID for absent
          pair.push(member1);

          let member2 = null;
          if (i + 1 < shuffledAbsent.length) {
              member2 = { id: `absent_${i+1}`, name: shuffledAbsent[i+1] };
              pair.push(member2);
          } else {
              absentUnpaired = member1; // Track the unpaired absent person
              console.log(`Absent participant ${member1.name} is unpaired in the補位 pairing.`);
              continue; // Skip creating a pair for the unpaired
          }
           // Only add pairs with two members
           absentPairings.push({ group: absentGroupNumber++, members: pair });
      }
      console.log('Generated pairings for absent:', JSON.stringify(absentPairings, null, 2));
      if (absentUnpaired) console.log('Unpaired absent participant:', absentUnpaired.name);

      // --- Merge confirmed and absent pairings ---
      // Ensure pairingResults is an array
      const combinedPairings = (Array.isArray(pairingResults) ? pairingResults : []).concat(absentPairings);
      console.log(`Total ${combinedPairings.length} pairings (confirmed + absent) to assign dates.`);

      // --- Assign Dates to ALL Pairings ---
      if (combinedPairings.length === 0) {
          console.warn('No pairings available (neither confirmed nor absent) to assign dates.');
          broadcastToScreens('dateAssignmentError', '沒有任何配對組可分配日期。');
          return;
      }

      const dates = ['4/15', '4/22', '4/29', '5/6', '5/13', '5/20']; // Or get from config/admin later
      const shuffledCombinedPairings = shuffleArray([...combinedPairings]);
      const finalAssignments = {};
      dates.forEach(date => finalAssignments[date] = []);

      const numTotalPairings = shuffledCombinedPairings.length;
      const numDates = dates.length;
      const baseGroupsPerDate = Math.floor(numTotalPairings / numDates);
      const remainderGroups = numTotalPairings % numDates;
      let currentIndex = 0;

      for (let i = 0; i < numDates; i++) {
          const date = dates[i];
          const groupsForThisDate = baseGroupsPerDate + (i < remainderGroups ? 1 : 0);
          const endIndex = currentIndex + groupsForThisDate;
          finalAssignments[date] = shuffledCombinedPairings.slice(currentIndex, endIndex);
          currentIndex = endIndex;
      }
      console.log('Final date assignments (including absent pairings):', JSON.stringify(finalAssignments, null, 2));

      // --- Broadcast the Final Date Assignments ---
      broadcastToScreens('updateDateAssignments', { assignments: finalAssignments });
      console.log('Broadcasted final date assignments to screens.');

       // Optionally, disable the "pair absent" button on the frontend after click?
       // We can send an event back or let the frontend handle it upon receiving assignments.
  });
  // --- End Handle Pairing and Assigning Absent ---
});

// --- 核心遊戲邏輯 ---

// 修改：合併配對與揭曉邏輯
function startPairingAndReveal() {
    // 1. 收集已確認的參與者
    const confirmedParticipants = [];
    const confirmedNames = new Set(); // 用 Set 方便快速查找
    participants.forEach((pInfo, socketId) => {
        if (pInfo.type === 'mobile' && pInfo.confirmed && pInfo.name) { // 確保有名字
            if (pInfo.visualCardId) {
                confirmedParticipants.push({ id: socketId, name: pInfo.name.trim(), visualCardId: pInfo.visualCardId });
                confirmedNames.add(pInfo.name.trim()); // 加入 Set，去除前後空白
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

    // 2. 計算配對 (只針對已確認者)
    const shuffledParticipants = shuffleArray([...confirmedParticipants]);
    pairingResults = []; // 重設配對結果
    let groupNumber = 1;
    let unpairedParticipant = null; // 可能的輪空者

    for (let i = 0; i < shuffledParticipants.length; i += 2) {
        const pair = [];
        const member1 = shuffledParticipants[i];
        pair.push({ id: member1.id, name: member1.name });

        let member2 = null;
        if (i + 1 < shuffledParticipants.length) {
            member2 = shuffledParticipants[i + 1];
            pair.push({ id: member2.id, name: member2.name });
        } else {
            // 處理輪空者
            unpairedParticipant = { id: member1.id, name: member1.name }; // 記錄輪空者資訊
            console.log(`Participant ${member1.name} (${member1.id}) is unpaired this round.`);
            // 不將輪空者加入 pairingResults，輪空者透過獨立欄位傳遞
            continue; // 跳過這次迴圈，不產生輪空者的組
        }
        pairingResults.push({ group: groupNumber++, members: pair });

        // --- 同步進行視覺卡牌揭曉準備 (這部分不變) ---
        const visualCard1 = visualCards.find(vc => vc.id === member1.visualCardId);
        if (visualCard1) { visualCard1.revealed = true; }
        if (member2) {
            const visualCard2 = visualCards.find(vc => vc.id === member2.visualCardId);
            if (visualCard2) { visualCard2.revealed = true; }
        }
    }
    console.log('Generated pairings (confirmed only):', JSON.stringify(pairingResults, null, 2));
    if (unpairedParticipant) {
         console.log(`Unpaired participant found: ${unpairedParticipant.name}`);
    }

    // --- NEW: 計算未參與者 ---
    const absentParticipants = defaultParticipantList.filter(name => !confirmedNames.has(name.trim()));
    console.log(`Absent participants (${absentParticipants.length}):`, absentParticipants);
    // --- End Calculate Absent ---


    // --- 揭曉階段 ---
    // 3. 向大螢幕廣播結果 (包含配對、輪空者、未參與者)
    broadcastToScreens('revealResults', {
        pairings: pairingResults, // 只包含實際配對的組
        unpaired: unpairedParticipant, // 實際輪空者 (null 如果沒有)
        absent: absentParticipants   // 未參與者名單
    });

    // 4. 向大螢幕廣播卡牌揭曉事件 (只針對已確認者)
    confirmedParticipants.forEach(p => {
        if (p.visualCardId) {
            broadcastToScreens('revealCard', { cardId: p.visualCardId, name: p.name });
        } else {
            console.warn(`Participant ${p.name} confirmed but missing visualCardId for reveal.`);
        }
    });
    console.log('Sent reveal commands for visual cards to screens.');

    // 5. 向手機端發送各自的配對夥伴 (只針對已確認者)
    pairingResults.forEach(pair => { // 只遍歷實際配對的組
        const member1 = pair.members[0];
        const member2 = pair.members[1]; // 這裡保證有 member2

        // 發送給 member1
        if (member1 && member1.id) {
            const socket1 = io.sockets.sockets.get(member1.id);
            if (socket1) {
                socket1.emit('yourPairing', { partner: { name: member2.name }, group: pair.group });
            } else { console.warn(`Socket not found for participant ${member1.name} (${member1.id})`); }
        }
        // 發送給 member2
        if (member2 && member2.id) {
             const socket2 = io.sockets.sockets.get(member2.id);
             if (socket2) {
                 socket2.emit('yourPairing', { partner: { name: member1.name }, group: pair.group });
             } else { console.warn(`Socket not found for participant ${member2.name} (${member2.id})`); }
         }
    });
    // 告知輪空者
     if (unpairedParticipant && unpairedParticipant.id) {
         const unpairedSocket = io.sockets.sockets.get(unpairedParticipant.id);
         if (unpairedSocket) {
              unpairedSocket.emit('yourPairing', { partner: null, group: '輪空' }); // 告知手機端輪空
         }
     }
    console.log('Sent individual pairing results (including unpaired) to mobile clients.');
    broadcastToScreens('pairingComplete');
}

// 重設遊戲
function resetGame() {
    console.log('Resetting game state...');
    participants.clear();
    pairingResults = [];
    initializeVisualCards(); // 重設視覺卡牌狀態

    broadcastToAll('gameReset'); // 會觸發前端清空顯示
    broadcastToScreens('participantState', getPublicParticipantState());
    broadcastToScreens('updateCards', getPublicCardState()); // 發送初始卡牌狀態
    // 不需要特別清空 absent list，因為 gameReset 會處理

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