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

let activeSockets = {}; 
let adminSessions = {}; 
let loginAttempts = {}; 
let supportHistory = [];
let musicState = { playing: false, trackUrl: '', title: 'Waiting for DJ...', artist: '', timestamp: 0, lastUpdate: Date.now() };
let globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
let roundBets = [];
let gameState = 'BETTING';
let timeLeft = 20;
let chatCooldowns = {};

const R_WHEEL = ["0","28","9","26","30","11","7","20","32","17","5","22","34","15","3","24","36","13","1","00","27","10","25","29","12","8","19","31","18","6","21","33","16","4","23","35","14","2"];
const R_REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

// DICE LOOP
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
                processDiceWinners(result);
                roundBets = []; globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
                setTimeout(() => { gameState = 'BETTING'; timeLeft = 20; io.emit('game_reset'); io.emit('update_global_bets', globalColorBets); }, 5000);
            }, 3000);
        } else { io.emit('timer_update', timeLeft); }
    }
}, 1000);

function processDiceWinners(diceResult) {
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
                if(dbData.users[username]) dbData.users[username].balance += winAmount;
            }
        }
        if(totalWin > 0) {
            saveDatabase();
            io.to(data.socketId).emit('win_notification', { total: totalWin, details: winDetails });
            io.to(data.socketId).emit('update_balance', dbData.users[username].balance);
        }
    }
}

// ROULETTE LOGIC
function isRouletteRed(n) { return R_REDS.includes(parseInt(n)); }
function processRouletteGame(user, bets) {
    let totalCost = 0;
    bets.forEach(b => totalCost += b.quantity); // Expecting 'quantity' here!

    if (dbData.users[user.username].balance < totalCost) return { error: "Insufficient Funds" };
    dbData.users[user.username].balance -= totalCost;
    
    const winningIndex = Math.floor(Math.random() * R_WHEEL.length);
    const resultVal = R_WHEEL[winningIndex];
    const nVal = parseInt(resultVal);
    const isZero = (resultVal === "0" || resultVal === "00");

    let totalWin = 0;
    let winningEntries = [];

    bets.forEach(bet => {
        let won = false; let multiplier = 0; 
        if (bet.id === resultVal) { won = true; multiplier = 35; } 
        else if (!isZero) {
            if (bet.id === "1ST12" && nVal >= 1 && nVal <= 12) { won = true; multiplier = 2; }
            if (bet.id === "2ND12" && nVal >= 13 && nVal <= 24) { won = true; multiplier = 2; }
            if (bet.id === "3RD12" && nVal >= 25 && nVal <= 36) { won = true; multiplier = 2; }
            if (bet.id === "ROW_BOT" && nVal % 3 === 1) { won = true; multiplier = 2; }
            if (bet.id === "ROW_MID" && nVal % 3 === 2) { won = true; multiplier = 2; }
            if (bet.id === "ROW_TOP" && nVal % 3 === 0) { won = true; multiplier = 2; }
            if (bet.id === "1TO18" && nVal >= 1 && nVal <= 18) { won = true; multiplier = 1; }
            if (bet.id === "19TO36" && nVal >= 19 && nVal <= 36) { won = true; multiplier = 1; }
            if (bet.id === "EVEN" && nVal % 2 === 0) { won = true; multiplier = 1; }
            if (bet.id === "ODD" && nVal % 2 !== 0) { won = true; multiplier = 1; }
            if (bet.id === "RED" && isRouletteRed(resultVal)) { won = true; multiplier = 1; }
            if (bet.id === "BLACK" && !isRouletteRed(resultVal)) { won = true; multiplier = 1; }
        }
        if (won) {
            const payout = bet.quantity * (multiplier + 1); 
            totalWin += payout;
            winningEntries.push({ ...bet, win: payout, mult: multiplier });
        }
    });

    if (totalWin > 0) dbData.users[user.username].balance += totalWin;
    saveDatabase();
    return { success: true, winningIndex, resultVal, totalWin, winningEntries, newBalance: dbData.users[user.username].balance };
}

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

io.on('connection', (socket) => {
    socket.on('auth_handshake', (authData) => {
        if (authData.type === 'admin') { /* Admin logic omitted for brevity, same as before */ } 
        else if (authData.type === 'player') {
            const { username, password } = authData;
            if (dbData.users[username] && dbData.users[username].password === password) {
                activeSockets[socket.id] = { username, role: 'PLAYER' };
                socket.emit('login_success', { username, balance: dbData.users[username].balance });
                socket.emit('music_sync', { playing: musicState.playing, seek: 0, url: musicState.trackUrl, title: musicState.title, artist: musicState.artist });
                broadcastPresence();
            } else socket.emit('login_error', "Invalid Credentials");
        }
    });

    socket.on('register', (data) => {
        const { username, password } = data;
        if (dbData.users[username]) { socket.emit('login_error', "Taken"); return; }
        dbData.users[username] = { password, balance: 500, history: [] }; // Give starting balance
        saveDatabase();
        activeSockets[socket.id] = { username, role: 'PLAYER' };
        socket.emit('login_success', { username, balance: 500 });
        broadcastPresence();
    });

    socket.on('disconnect', () => { delete activeSockets[socket.id]; broadcastPresence(); });

    function broadcastPresence() {
        const list = Object.values(activeSockets).map(u => ({ username: u.username, role: u.role }));
        io.emit('active_players_update', list);
    }

    socket.on('place_bet', (data) => { // DICE
        const user = activeSockets[socket.id];
        if (user && dbData.users[user.username].balance >= data.amount) {
            dbData.users[user.username].balance -= parseInt(data.amount);
            saveDatabase();
            socket.emit('update_balance', dbData.users[user.username].balance);
            roundBets.push({ socketId: socket.id, username: user.username, color: data.color, amount: parseInt(data.amount) });
        }
    });

    socket.on('roulette_req_spin', (bets) => { // ROULETTE
        const user = activeSockets[socket.id];
        if (user) {
            const outcome = processRouletteGame(user, bets);
            if (!outcome.error) {
                socket.emit('update_balance', outcome.newBalance);
                socket.emit('roulette_res_spin', outcome);
            }
        }
    });

    socket.on('chat_msg', (msg) => {
        const user = activeSockets[socket.id];
        if (user) io.emit('chat_broadcast', { user: user.username, msg: msg, role: user.role, type: 'public' });
    });
});

server.listen(process.env.PORT || 3000, () => { console.log('Server running on 3000'); });
