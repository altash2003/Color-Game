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
// IF YOU WANT TO CHANGE DEFAULT CREDENTIALS, EDIT HERE BEFORE RUNNING FIRST TIME
if (Object.keys(dbData.admins).length === 0) {
    const hash = bcrypt.hashSync("admin123", 10); 
    dbData.admins["admin"] = { 
        password: hash, 
        role: "ADMIN", 
        created: Date.now() 
    };
    saveDatabase();
    console.log("⚠️  DEFAULT ADMIN CREATED: User: 'admin' | Pass: 'admin123'");
}

// --- GLOBAL STATE ---
let activeSockets = {}; // socket.id -> { username, role }
let adminSessions = {}; // token -> { username, role }
let loginAttempts = {}; 
let supportHistory = [];
let musicState = { playing: false, trackUrl: '', title: 'Waiting for DJ...', artist: '', timestamp: 0, lastUpdate: Date.now() };
let globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
let roundBets = [];
let gameState = 'BETTING';
let timeLeft = 20;
let chatCooldowns = {};

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

function logHistory(username, message, balance) {
    if (!dbData.users[username]) return;
    if (!dbData.users[username].history) dbData.users[username].history = [];
    dbData.users[username].history.unshift(`[${new Date().toLocaleTimeString()}] ${message} | BAL: ${balance}`);
    if (dbData.users[username].history.length > 50) dbData.users[username].history.pop();
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
    res.json({ token: token, username: username, role: adminUser.role });
});

app.post('/api/admin/logout', (req, res) => {
    const { token } = req.body;
    if (token) delete adminSessions[token];
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
                activeSockets[socket.id] = { username: session.username, role: session.role };
                socket.join('staff_room');
                socket.emit('auth_success', { role: session.role, username: session.username });
                broadcastPresence();
            } else {
                socket.emit('auth_fail', "Invalid Session");
            }
        } else if (authData.type === 'player') {
            const { username, password } = authData;
            if (!username) return;
            
            if (!dbData.users[username]) {
                dbData.users[username] = { password, balance: 0, history: [] };
                saveDatabase();
            } else if (dbData.users[username].password !== password) {
                socket.emit('login_error', "Wrong Password");
                return;
            }
            
            activeSockets[socket.id] = { username: username, role: 'PLAYER' };
            socket.emit('login_success', { username, balance: dbData.users[username].balance });
            
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

    socket.on('disconnect', () => {
        delete activeSockets[socket.id];
        broadcastPresence();
    });

    function broadcastPresence() {
        const sortedList = Object.values(activeSockets).sort((a, b) => {
            const roleWeight = { 'ADMIN': 3, 'MOD': 2, 'PLAYER': 1 };
            return roleWeight[b.role] - roleWeight[a.role];
        });
        io.emit('active_players_update', sortedList);
        
        const adminData = { users: dbData.users, active: activeSockets, support: supportHistory };
        io.to('staff_room').emit('admin_data_resp', adminData);
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
            socket.emit('update_balance', dbData.users[user.username].balance);
            roundBets.push({ socketId: socket.id, username: user.username, color: data.color, amount: cost });
            globalColorBets[data.color] += cost;
            io.emit('update_global_bets', globalColorBets);
        } else {
            socket.emit('bet_error', "INSUFFICIENT CREDITS");
        }
    });

    socket.on('undo_bet', () => {
        const user = activeSockets[socket.id];
        if (!user || gameState !== 'BETTING') return;
        
        // Find last bet
        let betIndex = -1;
        for (let i = roundBets.length - 1; i >= 0; i--) { 
            if (roundBets[i].username === user.username) { betIndex = i; break; } 
        }
        
        if (betIndex !== -1) {
            let bet = roundBets[betIndex];
            dbData.users[user.username].balance += bet.amount;
            globalColorBets[bet.color] -= bet.amount;
            if(globalColorBets[bet.color] < 0) globalColorBets[bet.color] = 0;
            
            roundBets.splice(betIndex, 1);
            saveDatabase();
            socket.emit('update_balance', dbData.users[user.username].balance);
            socket.emit('bet_undone', { color: bet.color, amount: bet.amount });
            io.emit('update_global_bets', globalColorBets);
        }
    });

    socket.on('clear_bets', () => {
        const user = activeSockets[socket.id];
        if (!user || gameState !== 'BETTING') return;
        
        let totalRefund = 0;
        roundBets = roundBets.filter(bet => {
            if (bet.username === user.username) {
                totalRefund += bet.amount;
                globalColorBets[bet.color] -= bet.amount;
                return false;
            }
            return true;
        });
        
        if (totalRefund > 0) {
            dbData.users[user.username].balance += totalRefund;
            saveDatabase();
            socket.emit('update_balance', dbData.users[user.username].balance);
            socket.emit('bets_cleared');
            io.emit('update_global_bets', globalColorBets);
        }
    });

    // --- CHAT ---
    socket.on('chat_msg', (msg) => {
        const user = activeSockets[socket.id];
        if (!user) return;
        if (user.role === 'PLAYER') {
            if (chatCooldowns[user.username] && Date.now() < chatCooldowns[user.username]) return;
            chatCooldowns[user.username] = Date.now() + 3000;
        }
        io.emit('chat_broadcast', { user: user.username, msg: msg, role: user.role, type: 'public' });
    });

    socket.on('support_msg', (msg) => {
        const user = activeSockets[socket.id];
        if (!user) return;
        const ticket = { user: user.username, msg, time: Date.now() };
        supportHistory.push(ticket);
        io.to('staff_room').emit('admin_support_receive', ticket);
        socket.emit('chat_broadcast', { user: "You", msg, type: 'support_sent' });
    });

    // --- STAFF HELPERS ---
    function isStaff() { return activeSockets[socket.id] && (activeSockets[socket.id].role === 'ADMIN' || activeSockets[socket.id].role === 'MOD'); }
    function isAdmin() { return activeSockets[socket.id] && activeSockets[socket.id].role === 'ADMIN'; }

    socket.on('admin_req_data', () => { if (isStaff()) broadcastPresence(); });

    socket.on('admin_chat_public', (msg) => {
        if (!isStaff()) return;
        const user = activeSockets[socket.id];
        io.emit('chat_broadcast', { user: user.username, msg: msg, role: user.role, type: 'public_staff' });
    });

    socket.on('admin_reply_support', (data) => {
        if (!isStaff()) return;
        for (let [sid, u] of Object.entries(activeSockets)) {
            if (u.username === data.targetUser) {
                io.to(sid).emit('chat_broadcast', { msg: data.msg, type: 'support_reply' });
            }
        }
        supportHistory.push({ user: `To ${data.targetUser}`, msg: data.msg, time: Date.now() });
        io.to('staff_room').emit('chat_broadcast', { user: `To ${data.targetUser}`, msg: data.msg, type: 'support_log_echo', target: data.targetUser });
    });

    // --- ADMIN ACTIONS (Money & Staff) ---
    socket.on('admin_add_credits', (data) => {
        if (!isAdmin()) return;
        if (dbData.users[data.username]) {
            dbData.users[data.username].balance += parseInt(data.amount);
            logHistory(data.username, `ADMIN ADDED +${data.amount}`, dbData.users[data.username].balance);
            saveDatabase();
            for (let [sid, u] of Object.entries(activeSockets)) {
                if (u.username === data.username) {
                    io.to(sid).emit('update_balance', dbData.users[data.username].balance);
                    io.to(sid).emit('notification', { msg: `ADMIN ADDED ${data.amount} CREDITS!`, duration: 3000 });
                }
            }
            broadcastPresence();
        }
    });

    socket.on('admin_deduct_credits', (data) => {
        if (!isAdmin()) return;
        if (dbData.users[data.username]) {
            dbData.users[data.username].balance -= parseInt(data.amount);
            if(dbData.users[data.username].balance < 0) dbData.users[data.username].balance = 0;
            logHistory(data.username, `ADMIN DEDUCTED -${data.amount}`, dbData.users[data.username].balance);
            saveDatabase();
            for (let [sid, u] of Object.entries(activeSockets)) {
                if (u.username === data.username) {
                    io.to(sid).emit('update_balance', dbData.users[data.username].balance);
                    io.to(sid).emit('notification', { msg: `WITHDRAWAL: -${data.amount} CREDITS`, duration: 3000 });
                }
            }
            broadcastPresence();
        }
    });

    socket.on('admin_add_all', (amount) => {
        if (!isAdmin()) return;
        const amt = parseInt(amount);
        for(let [sid, u] of Object.entries(activeSockets)) {
            if(u.role === 'PLAYER' && dbData.users[u.username]) {
                dbData.users[u.username].balance += amt;
                logHistory(u.username, `ADMIN GIFT +${amt}`, dbData.users[u.username].balance);
                io.to(sid).emit('update_balance', dbData.users[u.username].balance);
                io.to(sid).emit('notification', { msg: `GIFT! +${amt} CREDITS`, duration: 3000 });
            }
        }
        saveDatabase();
        broadcastPresence();
    });

    socket.on('admin_create_staff', (data) => {
        if (!isAdmin()) { socket.emit('admin_log', "Error: Permission Denied."); return; }
        const { username, password, role } = data;
        if (!username || !password || !role) return;
        if (dbData.admins[username]) { socket.emit('admin_log', "Error: Username exists."); return; }

        const hash = bcrypt.hashSync(password, 10);
        dbData.admins[username] = { password: hash, role: role, created: Date.now() };
        saveDatabase();
        socket.emit('admin_log', `Success: Created ${role} account for ${username}`);
    });

    // --- MUSIC CONTROLS ---
    socket.on('admin_update_metadata', (data) => {
        if (!isStaff()) return;
        if(data.title) musicState.title = data.title;
        if(data.artist) musicState.artist = data.artist;
        io.emit('metadata_update', musicState);
    });

    socket.on('admin_change_track', (newUrl) => {
        if (!isStaff()) return;
        musicState.trackUrl = newUrl;
        musicState.timestamp = 0;
        musicState.playing = true;
        musicState.lastUpdate = Date.now();
        io.emit('music_sync', { playing: true, seek: 0, url: newUrl, title: musicState.title, artist: musicState.artist });
    });

    socket.on('admin_music_action', (data) => {
        if (!isStaff()) return;
        musicState.playing = (data.action === 'play');
        musicState.timestamp = data.seek;
        musicState.lastUpdate = Date.now();
        io.emit('music_sync', { playing: musicState.playing, seek: musicState.timestamp, url: musicState.trackUrl, title: musicState.title, artist: musicState.artist });
    });

    socket.on('admin_announce', (msg) => {
        if (!isStaff()) return;
        io.emit('notification', { msg: msg, duration: 5000 });
    });
});

server.listen(process.env.PORT || 3000, () => { console.log('Server running on 3000'); });
