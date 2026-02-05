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

// Default Admin
if (Object.keys(dbData.admins).length === 0) {
    const hash = bcrypt.hashSync("admin123", 10);
    dbData.admins["admin"] = { password: hash, role: "ADMIN", created: Date.now() };
    saveDatabase();
}

// --- GLOBAL STATE ---
let activeSockets = {}; // { id: { username, role, room } }
let adminSessions = {};
let musicState = { playing: false, trackUrl: '', title: 'Waiting...', artist: '', timestamp: 0 };

// --- COLOR GAME STATE ---
let colorState = 'BETTING';
let colorTime = 20;
let roundBets = [];
let globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };

// --- ROULETTE STATE ---
let rouletteState = 'BETTING';
let rouletteTime = 25;
let rouletteBets = []; // { uid, username, socketId, betId, amount, item }
let rouletteHistory = [];
const ROULETTE_WHEEL = ["0","28","9","26","30","11","7","20","32","17","5","22","34","15","3","24","36","13","1","00","27","10","25","29","12","8","19","31","18","6","21","33","16","4","23","35","14","2"];
const ROULETTE_REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

// --- ROUTES ---
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/color', (req, res) => res.sendFile(__dirname + '/color.html'));
app.get('/roulette', (req, res) => res.sendFile(__dirname + '/roulette.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// --- HELPER: BROADCAST PLAYER COUNTS ---
function broadcastLobbyStats() {
    const stats = {
        color: Object.values(activeSockets).filter(u => u.room === 'color').length,
        roulette: Object.values(activeSockets).filter(u => u.room === 'roulette').length
    };
    io.emit('lobby_stats', stats);
}

// --- GAME LOOP: COLOR GAME ---
setInterval(() => {
    if (colorState === 'BETTING') {
        colorTime--;
        if (colorTime <= 0) {
            colorState = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            io.to('color').emit('game_rolling');
            
            setTimeout(() => {
                io.to('color').emit('game_result', result);
                processColorWinners(result);
                roundBets = [];
                globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
                setTimeout(() => {
                    colorState = 'BETTING';
                    colorTime = 20;
                    io.to('color').emit('game_reset');
                    io.to('color').emit('update_global_bets', globalColorBets);
                }, 5000);
            }, 3000);
        } else {
            io.to('color').emit('timer_update', colorTime);
        }
    }
}, 1000);

// --- GAME LOOP: ROULETTE ---
setInterval(() => {
    if (rouletteState === 'BETTING') {
        rouletteTime--;
        if (rouletteTime <= 0) {
            rouletteState = 'SPINNING';
            // Pick Winner
            const winIndex = Math.floor(Math.random() * ROULETTE_WHEEL.length);
            const winVal = ROULETTE_WHEEL[winIndex];

            // Tell clients to spin to this number
            io.to('roulette').emit('roulette_spin', { winIndex, winVal });

            // Wait for client animation (approx 10s)
            setTimeout(() => {
                processRouletteWinners(winVal);
                rouletteHistory.unshift(winVal);
                if(rouletteHistory.length > 5) rouletteHistory.pop();
                
                rouletteBets = [];
                rouletteState = 'BETTING';
                rouletteTime = 25;
                
                io.to('roulette').emit('roulette_reset', rouletteHistory);
            }, 10000);
        } else {
            io.to('roulette').emit('roulette_timer', rouletteTime);
        }
    }
}, 1000);


// --- WINNER LOGIC: COLOR ---
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
            }
        }
        if(totalWin > 0) {
            if(dbData.users[username]) dbData.users[username].balance += totalWin;
            io.to(data.socketId).emit('win_notification', { total: totalWin, details: winDetails });
            io.to(data.socketId).emit('update_balance', dbData.users[username].balance);
            winnersList.push({ username, amount: totalWin });
        }
    }
    if(winnersList.length > 0) {
        saveDatabase();
        io.to('color').emit('update_winners', winnersList);
    }
}

// --- WINNER LOGIC: ROULETTE ---
function getRouletteMultiplier(betId, resultVal) {
    const n = parseInt(resultVal);
    const isZero = (resultVal === "0" || resultVal === "00");
    if (betId === resultVal) return 36;
    if (isZero) return 0; // Outside bets lose on zero

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
                    io.to(bet.socketId).emit('roulette_win', { amount: payout, target: bet.betId });
                }
                winners.push({ username: bet.username, amount: payout });
            }
        }
    });
    saveDatabase();
}

// --- API ---
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

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    activeSockets[socket.id] = { username: "Guest", role: "GUEST", room: "lobby" };
    broadcastLobbyStats();

    // ENTER ROOM
    socket.on('enter_room', (room) => {
        socket.join(room);
        activeSockets[socket.id].room = room;
        broadcastLobbyStats();
        
        // Send initial state based on room
        if(room === 'color') {
            socket.emit('update_global_bets', globalColorBets);
            socket.emit('active_players_update', Object.values(activeSockets).filter(u=>u.room === 'color'));
        } else if (room === 'roulette') {
            socket.emit('roulette_timer', rouletteTime);
            socket.emit('roulette_history', rouletteHistory);
        }
    });

    // AUTH
    socket.on('auth_handshake', (data) => {
        if(data.type === 'player') {
            const u = dbData.users[data.username];
            if(u && u.password === data.password) {
                activeSockets[socket.id].username = data.username;
                activeSockets[socket.id].role = 'PLAYER';
                socket.emit('login_success', { username: data.username, balance: u.balance });
                broadcastLobbyStats();
            } else {
                socket.emit('login_error', "Invalid Credentials");
            }
        }
    });

    socket.on('register', (data) => {
        if(dbData.users[data.username]) { socket.emit('login_error', "Taken"); return; }
        dbData.users[data.username] = { password: data.password, balance: 0, history: [] };
        saveDatabase();
        activeSockets[socket.id].username = data.username;
        activeSockets[socket.id].role = 'PLAYER';
        socket.emit('login_success', { username: data.username, balance: 0 });
        broadcastLobbyStats();
    });

    // BETTING: COLOR
    socket.on('place_bet', (data) => {
        const user = activeSockets[socket.id];
        if(!user || colorState !== 'BETTING') return;
        if(dbData.users[user.username].balance >= data.amount) {
            dbData.users[user.username].balance -= data.amount;
            roundBets.push({ socketId: socket.id, username: user.username, color: data.color, amount: data.amount });
            globalColorBets[data.color] += data.amount;
            saveDatabase();
            socket.emit('update_balance', dbData.users[user.username].balance);
            io.to('color').emit('update_global_bets', globalColorBets);
        }
    });

    // BETTING: ROULETTE
    socket.on('roulette_place_bet', (data) => {
        // data: { betId, amount, name, item }
        const user = activeSockets[socket.id];
        if(!user || rouletteState !== 'BETTING') return;
        if(dbData.users[user.username].balance >= data.amount) {
            dbData.users[user.username].balance -= data.amount;
            rouletteBets.push({
                uid: Date.now() + Math.random(),
                username: user.username,
                socketId: socket.id,
                betId: data.betId,
                amount: data.amount,
                item: data.item,
                name: user.username
            });
            saveDatabase();
            socket.emit('update_balance', dbData.users[user.username].balance);
            socket.emit('roulette_bet_confirmed', data); // Echo back to confirm placement
        } else {
            socket.emit('bet_error', "Insufficient Funds");
        }
    });

    socket.on('disconnect', () => {
        delete activeSockets[socket.id];
        broadcastLobbyStats();
    });

    // CHAT
    socket.on('chat_msg', (msg) => {
        const u = activeSockets[socket.id];
        if(u) io.to(u.room).emit('chat_broadcast', { user: u.username, msg, role: u.role, type: 'public' });
    });
});

server.listen(process.env.PORT || 3000, () => { console.log('Casino Server running on 3000'); });
