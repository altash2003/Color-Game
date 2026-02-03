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

if (fs.existsSync(DB_FILE)) {
    try { dbData = JSON.parse(fs.readFileSync(DB_FILE)); } 
    catch (e) { console.error(e); }
}
if (!dbData.admins) dbData.admins = {};

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2)); }

// Default Admin: admin / admin123
if (Object.keys(dbData.admins).length === 0) {
    dbData.admins["admin"] = { password: bcrypt.hashSync("admin123", 10), role: "ADMIN" };
    saveDatabase();
}

// --- STATE ---
let activeSockets = {}; 
let adminSessions = {}; 
let musicState = { playing: false, trackUrl: '', title: 'Waiting...', artist: '', timestamp: 0, lastUpdate: Date.now() };
let globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
let roundBets = [];
let gameState = 'BETTING';
let timeLeft = 20;
let supportMessages = []; // Simple support history

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
                let win = amount * (matches + 1);
                totalWin += win;
                winDetails.push({ color, win });
                if(dbData.users[username]) dbData.users[username].balance += win;
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

// --- AUTH API ---
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

app.post('/api/admin/logout', (req, res) => {
    if (req.body.token) delete adminSessions[req.body.token];
    res.json({ success: true });
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    // AUTH HANDSHAKE
    socket.on('auth_handshake', (data) => {
        if (data.type === 'admin') {
            const session = adminSessions[data.token];
            if (session) {
                activeSockets[socket.id] = { username: session.username, role: session.role };
                socket.join('staff_room');
                socket.emit('auth_success', session);
                broadcastPresence();
                socket.emit('admin_data', { users: dbData.users, support: supportMessages });
            } else socket.emit('auth_fail');
        } 
        else if (data.type === 'player') {
            const u = dbData.users[data.username];
            if (u && u.password === data.password) {
                activeSockets[socket.id] = { username: data.username, role: 'PLAYER' };
                socket.emit('login_success', { username: data.username, balance: u.balance });
                
                // Sync Music
                let seek = musicState.playing ? musicState.timestamp + (Date.now() - musicState.lastUpdate)/1000 : musicState.timestamp;
                socket.emit('music_sync', { ...musicState, seek });
                broadcastPresence();
            } else {
                socket.emit('login_error', "Invalid Credentials");
            }
        }
    });

    // REGISTER HANDLER (This fixes the Signup issue)
    socket.on('register', (data) => {
        if (dbData.users[data.username] || dbData.admins[data.username]) {
            socket.emit('login_error', "Username Taken");
            return;
        }
        dbData.users[data.username] = { password: data.password, balance: 0 };
        saveDatabase();
        
        activeSockets[socket.id] = { username: data.username, role: 'PLAYER' };
        socket.emit('login_success', { username: data.username, balance: 0 });
        
        let seek = musicState.playing ? musicState.timestamp + (Date.now() - musicState.lastUpdate)/1000 : musicState.timestamp;
        socket.emit('music_sync', { ...musicState, seek });
        broadcastPresence();
    });

    socket.on('disconnect', () => {
        delete activeSockets[socket.id];
        broadcastPresence();
    });

    function broadcastPresence() {
        const list = Object.values(activeSockets).sort((a,b) => (a.role==='PLAYER') - (b.role==='PLAYER'));
        io.emit('active_players_update', list);
    }

    // GAME
    socket.on('place_bet', (data) => {
        const u = activeSockets[socket.id];
        if (!u || u.role !== 'PLAYER' || gameState !== 'BETTING') return;
        if (dbData.users[u.username].balance >= data.amount) {
            dbData.users[u.username].balance -= data.amount;
            saveDatabase();
            roundBets.push({ socketId: socket.id, username: u.username, color: data.color, amount: data.amount });
            globalColorBets[data.color] += data.amount;
            socket.emit('update_balance', dbData.users[u.username].balance);
            io.emit('update_global_bets', globalColorBets);
        } else socket.emit('bet_error', "No Credits");
    });

    // CHAT
    socket.on('chat_msg', (msg) => {
        const u = activeSockets[socket.id];
        if(u) io.emit('chat_broadcast', { user: u.username, msg, role: u.role, type: 'public' });
    });

    socket.on('support_msg', (msg) => {
        const u = activeSockets[socket.id];
        if(u) {
            const m = { user: u.username, msg, time: Date.now() };
            supportMessages.push(m);
            io.to('staff_room').emit('support_msg', m);
            socket.emit('chat_broadcast', { user: 'You', msg, type: 'support' });
        }
    });

    // ADMIN
    socket.on('admin_chat', (msg) => {
        const u = activeSockets[socket.id];
        if(u && u.role!=='PLAYER') io.emit('chat_broadcast', { user: u.username, msg, role: u.role, type: 'public' });
    });

    socket.on('admin_music', (data) => {
        const u = activeSockets[socket.id];
        if(!u || u.role==='PLAYER') return;
        
        if (data.action === 'meta') { musicState.title = data.title; musicState.artist = data.artist; io.emit('meta_update', musicState); }
        else if (data.action === 'load') { musicState.trackUrl = data.url; musicState.playing=true; musicState.timestamp=0; musicState.lastUpdate=Date.now(); io.emit('music_sync', { ...musicState, seek:0 }); }
        else { musicState.playing = (data.action === 'play'); musicState.timestamp = data.seek; musicState.lastUpdate = Date.now(); io.emit('music_sync', { ...musicState, seek: data.seek }); }
    });
    
    socket.on('admin_add_credits', (data) => {
        if(activeSockets[socket.id]?.role === 'ADMIN' && dbData.users[data.username]) {
            dbData.users[data.username].balance += parseInt(data.amount);
            saveDatabase();
            for(let id in activeSockets) {
                if(activeSockets[id].username === data.username) io.to(id).emit('update_balance', dbData.users[data.username].balance);
            }
        }
    });
});

server.listen(process.env.PORT || 3000);
