const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment-timezone'); // REQUIRE THIS

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
let activeSockets = {}; // socket.id -> { username, role, isIdle: false, hasBet: false, loginTime }
let adminSessions = {}; 
let loginAttempts = {}; 
let musicState = { playing: false, trackUrl: '', title: 'Waiting for DJ...', artist: '', timestamp: 0, lastUpdate: Date.now() };
let globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
let roundBets = [];
let gameState = 'BETTING';
let timeLeft = 20;
let chatCooldowns = {};

// --- NEW SUPPORT SYSTEM STATE ---
// threads[username] = { messages: [], lastUpdate: ts, active: true }
let supportThreads = {}; 

// --- LOGGING SYSTEM (In-Memory for now) ---
let systemLogs = [];
let playerLogs = [];

function getPHT() {
    return moment().tz("Asia/Manila").format('YYYY-MM-DD HH:mm:ss');
}

function logSystem(actor, role, action, details) {
    const logEntry = {
        timestamp: getPHT(),
        actor: actor,
        role: role,
        action: action,
        details: details
    };
    systemLogs.unshift(logEntry);
    if (systemLogs.length > 200) systemLogs.pop();
    io.to('staff_room').emit('log_update_system', logEntry);
}

function logPlayer(username, action, details) {
    const logEntry = {
        timestamp: getPHT(),
        username: username,
        action: action,
        details: details
    };
    playerLogs.unshift(logEntry);
    if (playerLogs.length > 200) playerLogs.pop();
    io.to('staff_room').emit('log_update_player', logEntry);
}

function logHistory(username, message, balance) {
    if (!dbData.users[username]) return;
    if (!dbData.users[username].history) dbData.users[username].history = [];
    dbData.users[username].history.unshift(`[${getPHT()}] ${message} | BAL: ${balance}`);
    if (dbData.users[username].history.length > 50) dbData.users[username].history.pop();
}

// --- GAME LOOP ---
setInterval(() => {
    if (gameState === 'BETTING') {
        timeLeft--;
        if (timeLeft <= 3 && timeLeft > 0) io.emit('countdown_beep', timeLeft);
        
        if (timeLeft <= 0) {
            gameState = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            io.emit('game_rolling');
            
            setTimeout(() => {
                io.emit('game_result', result);
                processWinners(result);
                
                // Reset Round
                roundBets = [];
                globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
                
                // Reset "Has Bet" status for everyone
                for (let id in activeSockets) {
                    if (activeSockets[id].role === 'PLAYER') activeSockets[id].hasBet = false;
                }
                broadcastPresence();

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

function processWinners(diceResult) {
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
                    logHistory(username, `WIN +${winAmount}`, dbData.users[username].balance);
                }
            } else {
                if(dbData.users[username]) logHistory(username, `LOST -${amount} on ${color}`, dbData.users[username].balance);
            }
        }
        if(totalWin > 0) {
            saveDatabase();
            io.to(data.socketId).emit('win_notification', { total: totalWin, details: winDetails });
            io.to(data.socketId).emit('update_balance', dbData.users[username].balance);
            winnersList.push({ username, amount: totalWin });
        }
    }
    if(winnersList.length > 0) io.emit('update_winners', winnersList);
}

// --- AUTH ROUTES ---
const checkRateLimit = (ip) => {
    if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, time: Date.now() };
    if (Date.now() - loginAttempts[ip].time > 60000) { loginAttempts[ip] = { count: 0, time: Date.now() }; }
    loginAttempts[ip].count++;
    return loginAttempts[ip].count <= 5;
};

app.post('/api/admin/login', (req, res) => {
    const ip = req.ip;
    if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many attempts. Wait 1 min." });

    const { username, password } = req.body;
    const adminUser = dbData.admins[username];

    if (!adminUser) return res.status(401).json({ error: "Invalid credentials" });
    if (!bcrypt.compareSync(password, adminUser.password)) return res.status(401).json({ error: "Invalid credentials" });

    const token = uuidv4();
    adminSessions[token] = { username: username, role: adminUser.role };
    
    logSystem(username, adminUser.role, "LOGIN", "Admin panel access granted");
    res.json({ token: token, username: username, role: adminUser.role });
});

app.post('/api/admin/logout', (req, res) => {
    const { token } = req.body;
    if (token) {
        const session = adminSessions[token];
        if(session) logSystem(session.username, session.role, "LOGOUT", "Admin panel logout");
        delete adminSessions[token];
    }
    res.json({ success: true });
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    // AUTH HANDSHAKE
    socket.on('auth_handshake', (authData) => {
        if (authData.type === 'admin') {
            const session = adminSessions[authData.token];
            if (session) {
                activeSockets[socket.id] = { 
                    username: session.username, 
                    role: session.role, 
                    isIdle: false, 
                    hasBet: false,
                    loginTime: Date.now()
                };
                socket.join('staff_room');
                socket.emit('auth_success', { role: session.role, username: session.username });
                broadcastPresence();
                // Send initial data for admin
                socket.emit('admin_init_data', { 
                    users: dbData.users, 
                    support: supportThreads,
                    systemLogs: systemLogs,
                    playerLogs: playerLogs
                });
            } else {
                socket.emit('auth_fail', "Invalid Session");
            }
        } else if (authData.type === 'player') {
            const { username, password } = authData;
            if (!username) return;
            
            if (!dbData.users[username]) {
                socket.emit('login_error', "User not found. Register first.");
                return;
            } else if (dbData.users[username].password !== password) {
                socket.emit('login_error', "Wrong Password");
                return;
            }
            
            activeSockets[socket.id] = { 
                username: username, 
                role: 'PLAYER',
                isIdle: false,
                hasBet: false,
                loginTime: Date.now()
            };
            socket.emit('login_success', { username, balance: dbData.users[username].balance });
            logPlayer(username, "LOGIN", "Player entered the game");
            
            // Late Join Sync
            let currentSeek = musicState.timestamp;
            if (musicState.playing) {
                currentSeek += (Date.now() - musicState.lastUpdate) / 1000;
            }
            socket.emit('music_sync', { playing: musicState.playing, seek: currentSeek, url: musicState.trackUrl, title: musicState.title, artist: musicState.artist });
            socket.emit('update_global_bets', globalColorBets);
            broadcastPresence();
        }
    });

    socket.on('register', (data) => {
        const { username, password } = data;
        if (!username || !password) return;
        
        if (dbData.users[username] || dbData.admins[username]) {
            socket.emit('login_error', "Username Taken!"); 
            return;
        }

        dbData.users[username] = { password, balance: 0, history: [] };
        saveDatabase();

        activeSockets[socket.id] = { 
            username: username, 
            role: 'PLAYER',
            isIdle: false,
            hasBet: false,
            loginTime: Date.now()
        };
        socket.emit('login_success', { username, balance: 0 });
        logPlayer(username, "REGISTER", "New account created");
        
        broadcastPresence();
    });

    socket.on('disconnect', () => {
        const user = activeSockets[socket.id];
        if (user) {
            if(user.role === 'PLAYER') logPlayer(user.username, "LOGOUT", "Disconnected");
            delete activeSockets[socket.id];
            broadcastPresence();
        }
    });

    // --- IDLE DETECTION ---
    socket.on('status_update', (status) => {
        if (!activeSockets[socket.id]) return;
        const oldStatus = activeSockets[socket.id].isIdle;
        activeSockets[socket.id].isIdle = (status === 'idle');
        
        // Log only on change
        if (activeSockets[socket.id].role === 'PLAYER' && oldStatus !== activeSockets[socket.id].isIdle) {
            logPlayer(activeSockets[socket.id].username, "STATUS", activeSockets[socket.id].isIdle ? "Went Idle" : "Returned Active");
        }
        broadcastPresence();
    });

    function broadcastPresence() {
        // Sorting Logic:
        // 1. Staff First (Admin > Mod)
        // 2. Players (Blue/Bet > Green/Online > Yellow/Idle)
        const sortedList = Object.values(activeSockets).sort((a, b) => {
            // Rank Calculation
            const getRank = (u) => {
                if (u.role === 'ADMIN') return 1000;
                if (u.role === 'MOD') return 900;
                // Players
                let score = 100;
                if (u.hasBet) score += 50; // Blue
                if (!u.isIdle) score += 20; // Green
                return score; // Idle is lowest base 100
            };
            return getRank(b) - getRank(a);
        });

        io.emit('active_players_update', sortedList);
    }

    // --- PLAYER ACTIONS ---
    socket.on('place_bet', (data) => {
        const user = activeSockets[socket.id];
        if (!user || user.role !== 'PLAYER') return;
        if (gameState !== 'BETTING') return;
        
        const cost = parseInt(data.amount);
        if (dbData.users[user.username].balance >= cost) {
            dbData.users[user.username].balance -= cost;
            saveDatabase();
            
            user.hasBet = true; // Mark as Blue status
            logPlayer(user.username, "BET", `Placed ${cost} on ${data.color}`);
            
            socket.emit('update_balance', dbData.users[user.username].balance);
            roundBets.push({ socketId: socket.id, username: user.username, color: data.color, amount: cost });
            globalColorBets[data.color] += cost;
            
            io.emit('update_global_bets', globalColorBets);
            broadcastPresence(); // Update blue dot
        } else {
            socket.emit('bet_error', "INSUFFICIENT CREDITS");
        }
    });

    // --- CHAT SYSTEM ---
    socket.on('chat_msg', (msg) => {
        const user = activeSockets[socket.id];
        if (!user) return;
        
        // Validation for Staff Color usage handled on Client, but server enforces Role
        io.emit('chat_broadcast', { user: user.username, msg: msg, role: user.role, type: 'public' });
    });

    // --- SUPPORT SYSTEM (TICKET LOGIC) ---
    socket.on('support_msg', (msg) => {
        const user = activeSockets[socket.id];
        if (!user) return;
        
        const username = user.username;
        if (!supportThreads[username]) {
            supportThreads[username] = { messages: [], active: true, lastUpdate: Date.now() };
            logPlayer(username, "SUPPORT", "Opened new ticket");
        } else {
            supportThreads[username].active = true; // Reopen if closed
        }
        
        const msgObj = { sender: 'player', user: username, msg: msg, time: getPHT() };
        supportThreads[username].messages.push(msgObj);
        supportThreads[username].lastUpdate = Date.now();

        // Notify Staff
        io.to('staff_room').emit('support_update', { username: username, thread: supportThreads[username] });
        // Echo to player
        socket.emit('chat_broadcast', { user: "You", msg: msg, type: 'support_sent' });
    });

    // --- STAFF HELPERS ---
    function isStaff() { return activeSockets[socket.id] && (activeSockets[socket.id].role === 'ADMIN' || activeSockets[socket.id].role === 'MOD'); }
    function isAdmin() { return activeSockets[socket.id] && activeSockets[socket.id].role === 'ADMIN'; }

    // --- STAFF ACTIONS ---
    socket.on('admin_chat_public', (msg) => {
        if (!isStaff()) return;
        const user = activeSockets[socket.id];
        io.emit('chat_broadcast', { user: user.username, msg: msg, role: user.role, type: 'public_staff' });
    });

    socket.on('admin_clear_chat', (scope) => {
        if (!isStaff()) return;
        const user = activeSockets[socket.id];
        logSystem(user.username, user.role, "CLEAR CHAT", `Cleared ${scope} chat`);
        io.emit('chat_cleared', scope); // scope = 'public' or 'support'
    });

    // SUPPORT REPLY
    socket.on('admin_reply_support', (data) => {
        if (!isStaff()) return;
        const staff = activeSockets[socket.id];
        const target = data.targetUser;
        
        if (!supportThreads[target]) return;

        const msgObj = { sender: 'staff', user: staff.username, msg: data.msg, time: getPHT(), role: staff.role };
        supportThreads[target].messages.push(msgObj);
        supportThreads[target].lastUpdate = Date.now();

        // Send to player
        for (let [sid, u] of Object.entries(activeSockets)) {
            if (u.username === target) {
                io.to(sid).emit('chat_broadcast', { msg: data.msg, type: 'support_reply', role: staff.role });
            }
        }
        
        // Update Admin UI
        io.to('staff_room').emit('support_update', { username: target, thread: supportThreads[target] });
    });

    // CLOSE TICKET
    socket.on('admin_close_ticket', (username) => {
        if (!isStaff()) return;
        if (supportThreads[username]) {
            supportThreads[username].active = false;
            io.to('staff_room').emit('support_update', { username: username, thread: supportThreads[username] });
            logSystem(activeSockets[socket.id].username, activeSockets[socket.id].role, "TICKET", `Closed ticket for ${username}`);
        }
    });

    // ADMIN CREDITS
    socket.on('admin_add_credits', (data) => {
        if (!isAdmin()) return;
        if (dbData.users[data.username]) {
            dbData.users[data.username].balance += parseInt(data.amount);
            saveDatabase();
            
            logSystem(activeSockets[socket.id].username, "ADMIN", "CREDITS", `Added ${data.amount} to ${data.username}`);
            
            for (let [sid, u] of Object.entries(activeSockets)) {
                if (u.username === data.username) {
                    io.to(sid).emit('update_balance', dbData.users[data.username].balance);
                    io.to(sid).emit('notification', { msg: `ADMIN ADDED ${data.amount} CREDITS!`, duration: 3000 });
                }
            }
            // Send full data update
            io.to('staff_room').emit('admin_init_data', { users: dbData.users, support: supportThreads, systemLogs: systemLogs, playerLogs: playerLogs });
        }
    });

    // MUSIC
    socket.on('admin_music_action', (data) => {
        if (!isStaff()) return;
        const user = activeSockets[socket.id];
        musicState.playing = (data.action === 'play');
        musicState.timestamp = data.seek;
        musicState.lastUpdate = Date.now();
        
        logSystem(user.username, user.role, "MUSIC", `${data.action.toUpperCase()} music`);
        io.emit('music_sync', { playing: musicState.playing, seek: musicState.timestamp, url: musicState.trackUrl, title: musicState.title, artist: musicState.artist });
    });

    socket.on('admin_announce', (msg) => {
        if (!isStaff()) return;
        const user = activeSockets[socket.id];
        logSystem(user.username, user.role, "BROADCAST", msg);
        io.emit('notification', { msg: msg, duration: 5000 });
    });
});

server.listen(process.env.PORT || 3000, () => { console.log('Server running on 3000'); });
