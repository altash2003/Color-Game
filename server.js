const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// --- DATABASE ---
const DB_FILE = 'database.json';
let dbData = { users: {}, admins: {} };

function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE);
            dbData = JSON.parse(raw);
            if (!dbData.admins) dbData.admins = {};
        } catch (e) { console.error("DB Load Error:", e); }
    }
}
function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2)); }
loadDatabase();

if (Object.keys(dbData.admins).length === 0) {
    const hash = bcrypt.hashSync("admin123", 10);
    dbData.admins["admin"] = { password: hash, role: "ADMIN", created: Date.now() };
    saveDatabase();
}

// --- GLOBAL STATE ---
let activeSockets = {}; // { username, role, room }
let adminSessions = {};

// COLOR GAME STATE
let colorState = 'BETTING';
let colorTime = 20;
let roundBets = [];
let globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };

// ROULETTE STATE
let rouletteState = 'BETTING';
let rouletteTime = 25;
let rouletteBets = []; 
let rouletteHistory = [];
const ROULETTE_WHEEL = ["0","28","9","26","30","11","7","20","32","17","5","22","34","15","3","24","36","13","1","00","27","10","25","29","12","8","19","31","18","6","21","33","16","4","23","35","14","2"];
const ROULETTE_REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

// --- ROUTES ---
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html')); // LOBBY
app.get('/color', (req, res) => res.sendFile(__dirname + '/color.html')); // COLOR GAME
app.get('/roulette', (req, res) => res.sendFile(__dirname + '/roulette.html')); // ROULETTE
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const adminUser = dbData.admins[username];
    if (adminUser && bcrypt.compareSync(password, adminUser.password)) {
        const token = uuidv4();
        adminSessions[token] = { username, role: adminUser.role };
        res.json({ token, username, role: adminUser.role });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});

// --- HELPER: BROADCAST COUNTS ---
function broadcastCounts() {
    const counts = {
        color: Object.values(activeSockets).filter(u => u.room === 'color').length,
        roulette: Object.values(activeSockets).filter(u => u.room === 'roulette').length
    };
    io.emit('lobby_stats', counts);
}

// --- GAME LOOPS ---
// 1. COLOR GAME LOOP
setInterval(() => {
    if (colorState === 'BETTING') {
        colorTime--;
        if (colorTime <= 0) {
            colorState = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            io.emit('game_rolling'); // Send to all, but only color.html listeners care
            
            setTimeout(() => {
                io.emit('game_result', result);
                processColorWinners(result);
                roundBets = [];
                globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
                setTimeout(() => {
                    colorState = 'BETTING';
                    colorTime = 20;
                    io.emit('game_reset');
                    io.emit('update_global_bets', globalColorBets);
                }, 5000);
            }, 3000);
        } else {
            io.emit('timer_update', colorTime);
        }
    }
}, 1000);

// 2. ROULETTE LOOP
setInterval(() => {
    if (rouletteState === 'BETTING') {
        rouletteTime--;
        if (rouletteTime <= 0) {
            rouletteState = 'SPINNING';
            const winIndex = Math.floor(Math.random() * ROULETTE_WHEEL.length);
            const winVal = ROULETTE_WHEEL[winIndex];
            io.emit('roulette_state', { state: 'SPINNING', winIndex: winIndex, winVal: winVal });
            setTimeout(() => {
                processRouletteWinners(winVal);
                rouletteHistory.unshift(winVal);
                if(rouletteHistory.length > 10) rouletteHistory.pop();
                rouletteBets = [];
                rouletteState = 'BETTING';
                rouletteTime = 25;
                io.emit('roulette_state', { state: 'BETTING', history: rouletteHistory });
                io.emit('roulette_bets_update', rouletteBets);
            }, 10000);
        } else {
            io.emit('roulette_timer', rouletteTime);
        }
    }
}, 1000);

// --- WINNER PROCESSING ---
function processColorWinners(diceResult) {
    let winnersList = [];
    let userBets = {}; 
    roundBets.forEach(bet => {
        if(!userBets[bet.username]) userBets[bet.username] = { socketId: bet.socketId, bets: {} };
        if(!userBets[bet.username].bets[bet.color]) userBets[bet.username].bets[bet.color] = 0;
        userBets[bet.username].bets[bet.color] += bet.amount;
    });
    for (let [username, data] of Object.entries(userBets)) {
        let totalWin = 0;
        let winDetails = [];
        for(let [color, amount] of Object.entries(data.bets)) {
            let matches = 0;
            diceResult.forEach(die => { if(die === color) matches++; });
            if (matches > 0) {
                let winAmount = amount * (matches + 1);
                totalWin += winAmount;
                winDetails.push({ color, bet: amount, multiplier: matches+1, win: winAmount });
                if(dbData.users[username]) dbData.users[username].balance += winAmount;
            }
        }
        if(totalWin > 0) {
            saveDatabase();
            if(activeSockets[data.socketId]) {
                io.to(data.socketId).emit('win_notification', { total: totalWin, details: winDetails });
                io.to(data.socketId).emit('update_balance', dbData.users[username].balance);
            }
            winnersList.push({ username, amount: totalWin });
        }
    }
    if(winnersList.length > 0) io.emit('update_winners', winnersList);
}

function processRouletteWinners(winVal) {
    let winners = [];
    rouletteBets.forEach(bet => {
        const mult = getRouletteMultiplier(bet.betId, winVal);
        if (mult > 0) {
            const payout = bet.amount * mult;
            if(dbData.users[bet.username]) {
                dbData.users[bet.username].balance += payout;
                if(activeSockets[bet.socketId]) {
                    io.to(bet.socketId).emit('update_balance', dbData.users[bet.username].balance);
                    io.to(bet.socketId).emit('notification', { msg: `WIN: +${payout} TC`, duration: 4000 });
                }
                winners.push({ username: bet.username, amount: payout, betId: bet.betId });
            }
        }
    });
    saveDatabase();
    if(winners.length > 0) io.emit('roulette_winners', winners);
}

function getRouletteMultiplier(betId, resultVal) {
    const n = parseInt(resultVal);
    const isZero = (resultVal === "0" || resultVal === "00");
    if (betId === resultVal) return 36;
    if (isZero) return 0;
    if (betId === "1ST12" && n >= 1 && n <= 12) return 3;
    if (betId === "2ND12" && n >= 13 && n <= 24) return 3;
    if (betId === "3RD12" && n >= 25 && n <= 36) return 3;
    if (betId === "ROW_BOT" && n % 3 === 1) return 3;
    if (betId === "ROW_MID" && n % 3 === 2) return 3;
    if (betId === "ROW_TOP" && n % 3 === 0) return 3;
    if (betId === "1TO18" && n >= 1 && n <= 18) return 2;
    if (betId === "19TO36" && n >= 19 && n <= 36) return 2;
    if (betId === "EVEN" && n % 2 === 0) return 2;
    if (betId === "ODD" && n % 2 !== 0) return 2;
    const isRed = ROULETTE_REDS.includes(n);
    if (betId === "RED" && isRed) return 2;
    if (betId === "BLACK" && !isRed) return 2;
    return 0;
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    // Initial state
    activeSockets[socket.id] = { username: "Guest", role: "GUEST", room: "lobby" };
    broadcastCounts();

    // 1. ROOM MANAGEMENT
    socket.on('enter_room', (roomName) => {
        if(activeSockets[socket.id]) {
            activeSockets[socket.id].room = roomName;
            broadcastCounts();
            
            // If entering roulette, send state immediately
            if(roomName === 'roulette') {
                socket.emit('roulette_state', { state: rouletteState, history: rouletteHistory });
                socket.emit('roulette_bets_update', rouletteBets);
            }
            // If entering color, send state
            if(roomName === 'color') {
                socket.emit('music_sync', { playing: true, seek: 0, url: '', title: 'Color Game Radio', artist: 'Live' }); // Mock
                socket.emit('update_global_bets', globalColorBets);
            }
        }
    });

    // 2. AUTH
    socket.on('auth_handshake', (authData) => {
        if (authData.type === 'player') {
            const { username, password } = authData;
            if (!dbData.users[username] || dbData.users[username].password !== password) {
                socket.emit('login_error', "Invalid Login"); return;
            }
            activeSockets[socket.id].username = username;
            activeSockets[socket.id].role = 'PLAYER';
            socket.emit('login_success', { username, balance: dbData.users[username].balance });
        }
    });

    socket.on('register', (data) => {
        if(dbData.users[data.username]) { socket.emit('login_error', "Username Taken"); return; }
        dbData.users[data.username] = { password: data.password, balance: 0, history: [] };
        saveDatabase();
        activeSockets[socket.id].username = data.username;
        activeSockets[socket.id].role = 'PLAYER';
        socket.emit('login_success', { username: data.username, balance: 0 });
    });

    socket.on('disconnect', () => { 
        delete activeSockets[socket.id];
        broadcastCounts();
    });

    // 3. COLOR GAME BETS
    socket.on('place_bet', (data) => {
        const user = activeSockets[socket.id];
        if (!user || colorState !== 'BETTING' || user.role !== 'PLAYER') return;
        const cost = parseInt(data.amount);
        if (dbData.users[user.username].balance >= cost) {
            dbData.users[user.username].balance -= cost;
            saveDatabase();
            socket.emit('update_balance', dbData.users[user.username].balance);
            roundBets.push({ socketId: socket.id, username: user.username, color: data.color, amount: cost });
            globalColorBets[data.color] += cost;
            io.emit('update_global_bets', globalColorBets);
        }
    });

    // 4. ROULETTE BETS
    socket.on('roulette_place_bet', (data) => {
        const user = activeSockets[socket.id];
        if (!user || rouletteState !== 'BETTING' || user.role !== 'PLAYER') return;
        const allowed = [50, 100, 500, 1000, 100000];
        const amount = parseInt(data.amount);
        if(!allowed.includes(amount)) return;

        if (dbData.users[user.username].balance >= amount) {
            dbData.users[user.username].balance -= amount;
            saveDatabase();
            rouletteBets.push({ uid: Date.now() + Math.random(), socketId: socket.id, username: user.username, betId: data.betId, amount: amount });
            socket.emit('update_balance', dbData.users[user.username].balance);
            io.emit('roulette_bets_update', rouletteBets);
        }
    });

    socket.on('roulette_remove_bet', (uid) => {
        if (rouletteState !== 'BETTING') return;
        const user = activeSockets[socket.id];
        if (!user) return;
        const idx = rouletteBets.findIndex(b => b.uid === uid);
        if (idx !== -1 && rouletteBets[idx].username === user.username) {
            dbData.users[user.username].balance += rouletteBets[idx].amount;
            saveDatabase();
            rouletteBets.splice(idx, 1);
            socket.emit('update_balance', dbData.users[user.username].balance);
            io.emit('roulette_bets_update', rouletteBets);
        }
    });

    // 5. CHAT
    socket.on('chat_msg', (msg) => {
        const user = activeSockets[socket.id];
        if(user) io.emit('chat_broadcast', { user: user.username, msg: msg, role: user.role });
    });
});

server.listen(process.env.PORT || 3000, () => { console.log('Casino Server running on 3000'); });
