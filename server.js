const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json()); 
app.use(express.static(__dirname));

// --- DATABASE ---
const DB_FILE = 'database.json';
let dbData = { users: {}, admins: {} };

function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE);
            dbData = JSON.parse(raw);
            if (!dbData.admins) dbData.admins = {}; 
            if (!dbData.users) dbData.users = {}; 
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

// --- STATE ---
let activeSockets = {}; // { socketId: { username, role } }

// --- ROULETTE LOGIC ---
const R_REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const R_WHEEL = ["0","28","9","26","30","11","7","20","32","17","5","22","34","15","3","24","36","13","1","00","27","10","25","29","12","8","19","31","18","6","21","33","16","4","23","35","14","2"];

function isRouletteRed(n) { return R_REDS.includes(parseInt(n)); }

function processRouletteSpin(username, bets) {
    if (!dbData.users[username]) return { error: "User not found" };
    
    let totalBet = 0;
    bets.forEach(b => totalBet += b.amount);

    if (dbData.users[username].balance < totalBet) return { error: "Insufficient Funds" };
    
    // Deduct
    dbData.users[username].balance -= totalBet;
    
    // Spin
    const resultIndex = Math.floor(Math.random() * R_WHEEL.length);
    const resultVal = R_WHEEL[resultIndex];
    const nVal = parseInt(resultVal);
    
    let totalWin = 0;
    
    // Check wins
    bets.forEach(bet => {
        let won = false; 
        let multiplier = 0;
        
        // Exact Number
        if (bet.numbers.length === 1 && bet.numbers[0].toString() === resultVal) {
            won = true; multiplier = 35;
        } 
        // Color/Even/Odd logic (simplified for single number mapping in this version)
        // If the bet covers the winning number
        else if (bet.numbers.includes(nVal)) {
            // Calculate Multiplier based on coverage probability
            // 18 numbers (Red/Black/Even/Odd) = 1:1
            // 12 numbers (Dozens) = 2:1
            if (bet.numbers.length === 18) multiplier = 1;
            else if (bet.numbers.length === 12) multiplier = 2;
            else multiplier = Math.floor(35 / bet.numbers.length); // Rough approximation for splits
            won = true; 
        }

        if (won) {
            totalWin += bet.amount * (multiplier + 1);
        }
    });

    dbData.users[username].balance += totalWin;
    saveDatabase();

    return { 
        result: resultVal, 
        balance: dbData.users[username].balance, 
        win: totalWin 
    };
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    socket.on('login', (data) => {
        const { username, password } = data;
        
        // Auto-register for demo purposes if not exists
        if (!dbData.users[username]) {
            dbData.users[username] = { password: password, balance: 1000 };
            saveDatabase();
        }

        if (dbData.users[username].password === password) {
            activeSockets[socket.id] = { username, role: 'PLAYER' };
            socket.emit('login_success', { 
                username, 
                balance: dbData.users[username].balance,
                mySocketId: socket.id 
            });
            
            // Broadcast to everyone that a new player joined
            io.emit('player_list_update', Object.values(activeSockets));
            
            // Tell this user who is already here (for WebRTC connections)
            const others = Object.keys(activeSockets).filter(id => id !== socket.id);
            socket.emit('existing_users', others);
        } else {
            socket.emit('login_error', 'Invalid Credentials');
        }
    });

    socket.on('roulette_spin', (bets) => {
        const user = activeSockets[socket.id];
        if (!user) return;
        
        const outcome = processRouletteSpin(user.username, bets);
        socket.emit('roulette_result', outcome);
        
        // Broadcast that someone is playing (adds life to the game)
        socket.broadcast.emit('public_log', `${user.username} just spun the wheel!`);
    });

    // --- VOICE CHAT SIGNALING (WebRTC Relay) ---
    // These events forward signaling data between clients to establish P2P connections
    
    socket.on('voice_signal', (payload) => {
        io.to(payload.target).emit('voice_signal', {
            signal: payload.signal,
            callerID: socket.id
        });
    });

    socket.on('talking_status', (isTalking) => {
        const user = activeSockets[socket.id];
        if(user) {
            // Broadcast to everyone else that this specific user is talking
            socket.broadcast.emit('player_talking', { id: socket.id, isTalking });
        }
    });

    socket.on('disconnect', () => {
        const user = activeSockets[socket.id];
        delete activeSockets[socket.id];
        io.emit('player_list_update', Object.values(activeSockets));
        io.emit('user_left', socket.id); // For WebRTC cleanup
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on port ${PORT}`));
