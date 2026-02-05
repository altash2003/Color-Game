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

// --- DATABASE & INIT ---
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

function saveDatabase() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
}

loadDatabase();

// --- SEED DEFAULT ADMIN ---
if (Object.keys(dbData.admins).length === 0) {
    const hash = bcrypt.hashSync("admin123", 10);
    dbData.admins["admin"] = { password: hash, role: "ADMIN", created: Date.now() };
    saveDatabase();
    console.log("⚠️  DEFAULT ADMIN CREATED: User: 'admin' | Pass: 'admin123'");
}

// --- GLOBAL STATE ---
let activeSockets = {};
let adminSessions = {};
let loginAttempts = {};
let supportHistory = [];
let chatCooldowns = {};

// COLOR GAME STATE
let gameState = 'BETTING';
let timeLeft = 20;
let roundBets = [];
let globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };

// ROULETTE STATE
let rouletteState = 'BETTING';
let rouletteTime = 25;
let rouletteBets = []; // { uid, socketId, username, betId, amount, timestamp }
let rouletteHistory = [];
const ROULETTE_WHEEL = ["0","28","9","26","30","11","7","20","32","17","5","22","34","15","3","24","36","13","1","00","27","10","25","29","12","8","19","31","18","6","21","33","16","4","23","35","14","2"];
const ROULETTE_REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

// --- GAME LOOPS ---

// 1. COLOR GAME LOOP
setInterval(() => {
    if (gameState === 'BETTING') {
        timeLeft--;
        if (timeLeft <= 0) {
            gameState = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            io.emit('game_rolling');
            
            setTimeout(() => {
                io.emit('game_result', result);
                processColorWinners(result);
                
                roundBets = [];
                globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
                
                setTimeout(() => {
                    gameState = 'BETTING';
                    timeLeft = 20;
                    io.emit('game_reset');
                    io.emit('update_global_bets', globalColorBets);
                }, 5000);
            }, 3000);
        } else {
            io.emit('timer_update', timeLeft);
        }
    }
}, 1000);

// 2. ROULETTE GAME LOOP
setInterval(() => {
    if (rouletteState === 'BETTING') {
        rouletteTime--;
        
        if (rouletteTime <= 0) {
            rouletteState = 'SPINNING';
            // Pick winner
            const winIndex = Math.floor(Math.random() * ROULETTE_WHEEL.length);
            const winVal = ROULETTE_WHEEL[winIndex];
            
            io.emit('roulette_state', { state: 'SPINNING', winIndex: winIndex, winVal: winVal });
            
            // Spin duration matches client animation (approx 10s)
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


// --- LOGIC HELPER: ROULETTE PAYOUTS ---
function getRouletteMultiplier(betId, resultVal) {
    const n = parseInt(resultVal);
    const isZero = (resultVal === "0" || resultVal === "00");
    
    if (betId === resultVal) return 36; // Straight up (35:1 + stake = 36x)

    if (isZero) return 0; // If 0/00, outside bets lose

    // Outside Bets
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
                logHistory(bet.username, `ROULETTE WIN +${payout} on ${bet.betId}`, dbData.users[bet.username].balance);
                
                // Notify user
                const sock = activeSockets[bet.socketId]; // Check if still connected
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
                let multiplier = matches + 1;
                let winAmount = amount * multiplier;
                totalWin += winAmount;
                winDetails.push({ color, bet: amount, multiplier, win: winAmount });
                if(dbData.users[username]) {
                    dbData.users[username].balance += winAmount;
                    logHistory(username, `COLOR WIN +${winAmount}`, dbData.users[username].balance);
                }
            } else {
                if(dbData.users[username]) logHistory(username, `COLOR LOSS -${amount} on ${color}`, dbData.users[username].balance);
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

function logHistory(username, message, balance) {
    if (!dbData.users[username]) return;
    if (!dbData.users[username].history) dbData.users[username].history = [];
    dbData.users[username].history.unshift(`[${new Date().toLocaleTimeString()}] ${message} | BAL: ${balance}`);
    if (dbData.users[username].history.length > 50) dbData.users[username].history.pop();
}

// --- AUTH & ROUTES ---
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/roulette', (req, res) => res.sendFile(__dirname + '/roulette.html'));
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

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    // LOGIN
    socket.on('auth_handshake', (authData) => {
        if (authData.type === 'admin') {
            const session = adminSessions[authData.token];
            if (session) {
                activeSockets[socket.id] = { username: session.username, role: session.role };
                socket.join('staff_room');
                socket.emit('auth_success', { role: session.role, username: session.username });
            }
        } else if (authData.type === 'player') {
            const { username, password } = authData;
            if (!dbData.users[username] || dbData.users[username].password !== password) {
                socket.emit('login_error', "Invalid Login"); return;
            }
            activeSockets[socket.id] = { username: username, role: 'PLAYER' };
            socket.emit('login_success', { username, balance: dbData.users[username].balance });
            
            // Sync Roulette
            socket.emit('roulette_state', { state: rouletteState, history: rouletteHistory });
            socket.emit('roulette_bets_update', rouletteBets);
        }
    });

    socket.on('register', (data) => {
        if(dbData.users[data.username]) { socket.emit('login_error', "Username Taken"); return; }
        dbData.users[data.username] = { password: data.password, balance: 0, history: [] };
        saveDatabase();
        activeSockets[socket.id] = { username: data.username, role: 'PLAYER' };
        socket.emit('login_success', { username: data.username, balance: 0 });
    });

    socket.on('disconnect', () => { delete activeSockets[socket.id]; });

    // --- CHAT ---
    socket.on('chat_msg', (msg) => {
        const user = activeSockets[socket.id];
        if (!user) return;
        io.emit('chat_broadcast', { user: user.username, msg: msg, role: user.role, type: 'public' });
    });

    // --- COLOR GAME ACTIONS ---
    socket.on('place_bet', (data) => {
        const user = activeSockets[socket.id];
        if (!user || gameState !== 'BETTING') return;
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

    // --- ROULETTE ACTIONS ---
    socket.on('roulette_place_bet', (data) => {
        const user = activeSockets[socket.id];
        if (!user || rouletteState !== 'BETTING') return;
        
        // Allowed amounts check
        const allowed = [50, 100, 500, 1000, 100000];
        const amount = parseInt(data.amount);
        if(!allowed.includes(amount)) return;

        if (dbData.users[user.username].balance >= amount) {
            dbData.users[user.username].balance -= amount;
            saveDatabase();

            const betObj = {
                uid: Date.now() + Math.random(),
                socketId: socket.id,
                username: user.username,
                betId: data.betId,
                amount: amount
            };

            rouletteBets.push(betObj);
            
            socket.emit('update_balance', dbData.users[user.username].balance);
            io.emit('roulette_bets_update', rouletteBets);
        } else {
            socket.emit('notification', { msg: "Insufficient TC", duration: 2000 });
        }
    });

    socket.on('roulette_remove_bet', (uid) => {
        if (rouletteState !== 'BETTING') return;
        const user = activeSockets[socket.id];
        if (!user) return;

        const idx = rouletteBets.findIndex(b => b.uid === uid);
        if (idx !== -1) {
            const bet = rouletteBets[idx];
            // Only owner can remove
            if (bet.username === user.username) {
                dbData.users[user.username].balance += bet.amount;
                saveDatabase();
                
                rouletteBets.splice(idx, 1);
                
                socket.emit('update_balance', dbData.users[user.username].balance);
                io.emit('roulette_bets_update', rouletteBets);
            }
        }
    });

    // --- ADMIN ---
    socket.on('admin_add_credits', (data) => {
        const admin = activeSockets[socket.id];
        if (admin && (admin.role === 'ADMIN' || admin.role === 'MOD')) {
            if (dbData.users[data.username]) {
                dbData.users[data.username].balance += parseInt(data.amount);
                saveDatabase();
                io.emit('chat_broadcast', { type: 'public_staff', role: 'SYSTEM', user: 'SYSTEM', msg: `Added ${data.amount} TC to ${data.username}` });
            }
        }
    });
});

server.listen(process.env.PORT || 3000, () => { console.log('Server running on 3000'); });
