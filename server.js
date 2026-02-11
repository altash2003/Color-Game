const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } }
function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }

let activeSockets = {}; 
app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

function broadcastRoomList(room) {
    if(!room || room === 'lobby') return;
    let list = [];
    for(let id in activeSockets) {
        if(activeSockets[id].room === room) {
            list.push({ id: id, username: activeSockets[id].username, talking: activeSockets[id].isTalking||false });
        }
    }
    io.to(room).emit('room_users_update', list);
}

// --- GAME LOOPS ---
let colorState = { status: 'BETTING', timeLeft: 20, bets: [] };
let rouletteState = { status: 'BETTING', timeLeft: 30, bets: [] };

// Roulette Loop
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        io.to('roulette').emit('roulette_timer', rouletteState.timeLeft);
        
        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'LOCKED';
            io.to('roulette').emit('roulette_state', 'LOCKED'); 
            
            setTimeout(() => {
                io.to('roulette').emit('roulette_state', 'CLOSED');
                
                setTimeout(() => {
                    rouletteState.status = 'SPINNING';
                    let n = Math.floor(Math.random() * 37);
                    io.to('roulette').emit('roulette_spin_start', n);
                    
                    // 4s Spin + 1s Pause + 3s Anim + 1s Reset
                    setTimeout(() => {
                        io.to('roulette').emit('roulette_result_log', n);
                        processRouletteWinners(n);
                        
                        setTimeout(() => {
                            rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30; rouletteState.bets = [];
                            io.to('roulette').emit('roulette_new_round');
                        }, 5000); 
                    }, 4500); 
                }, 500);
            }, 500);
        }
    }
}, 1000);

// Color Game Loop
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            io.to('colorgame').emit('game_rolling');
            setTimeout(() => {
                let r = ['RED','RED','RED']; 
                io.to('colorgame').emit('game_result', r);
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20;
                    io.to('colorgame').emit('game_reset');
                    io.to('colorgame').emit('timer_update', 20);
                }, 5000);
            }, 3000);
        } else io.to('colorgame').emit('timer_update', colorState.timeLeft);
    }
}, 1000);

function processRouletteWinners(n) {
    let totalWins = {};
    rouletteState.bets.forEach(b => {
        if(b.numbers.includes(n)) {
            let mult = 36 / b.numbers.length;
            let win = b.amount * mult;
            if(!totalWins[b.socketId]) totalWins[b.socketId] = 0;
            totalWins[b.socketId] += win;
            if(users[b.username]) users[b.username].balance += win;
        }
    });
    saveDatabase();
    // Broadcast updates
    for(let sid in totalWins) {
        let u = activeSockets[sid];
        if(u) {
            io.to(sid).emit('update_balance', users[u.username].balance);
            io.to(sid).emit('my_win_total', totalWins[sid]);
        }
    }
    io.to('roulette').emit('roulette_win', { number: n });
}

io.on('connection', (socket) => {
    socket.on('login', (d) => {
        if(users[d.username] && users[d.username].password === d.password) {
            joinRoom(socket, d.username, 'lobby');
            socket.emit('login_success', { username: d.username, balance: users[d.username].balance });
        } else socket.emit('login_error', "Invalid");
    });
    socket.on('register', (d) => {
        if(!users[d.username]) { users[d.username] = { password: d.password, balance: 1000 }; saveDatabase(); joinRoom(socket, d.username, 'lobby'); socket.emit('login_success', { username: d.username, balance: 1000 }); } 
        else socket.emit('login_error', "Taken");
    });
    socket.on('switch_room', (r) => { if(activeSockets[socket.id]) joinRoom(socket, activeSockets[socket.id].username, r); });
    socket.on('voice_data', (b) => socket.to(activeSockets[socket.id]?.room).emit('voice_receive', {id:socket.id, audio:b}));
    socket.on('voice_status', (t) => { if(activeSockets[socket.id]) { activeSockets[socket.id].isTalking = t; io.to(activeSockets[socket.id].room).emit('player_voice_update', {id:socket.id, talking:t}); } });
    socket.on('chat_msg', (d) => io.to(d.room).emit('chat_broadcast', {type:'public', user:activeSockets[socket.id].username, msg:d.msg}));

    // BETTING & REFUNDS
    socket.on('place_bet_roulette', (d) => {
        let u = activeSockets[socket.id];
        // Allow negative amounts for refunds/undo
        if(u && users[u.username] && (rouletteState.status === 'BETTING' || d.amount < 0)) {
            if(d.amount > 0 && users[u.username].balance < d.amount) return; // Check funds for pos bet
            
            users[u.username].balance -= d.amount; // Subtract bet OR Add negative (refund)
            
            if(d.amount > 0) {
                rouletteState.bets.push({ socketId: socket.id, username: u.username, numbers: d.numbers, amount: d.amount });
            } else {
                // Undo logic handled by client removing, server just refunds money here
                // Complex undo requires ID tracking, simplified to refund balance
            }
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    socket.on('roulette_clear', () => {
        let u = activeSockets[socket.id];
        if(!u || rouletteState.status !== 'BETTING') return;
        let myBets = rouletteState.bets.filter(b => b.socketId === socket.id);
        if(myBets.length > 0) {
            let refund = myBets.reduce((a,b)=>a+b.amount, 0);
            users[u.username].balance += refund;
            rouletteState.bets = rouletteState.bets.filter(b => b.socketId !== socket.id);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bets_cleared');
        }
    });

    socket.on('disconnect', () => {
        if(activeSockets[socket.id]) { let r=activeSockets[socket.id].room; delete activeSockets[socket.id]; broadcastRoomList(r); }
    });
});

function joinRoom(socket, username, room) {
    if(activeSockets[socket.id]) socket.leave(activeSockets[socket.id].room);
    activeSockets[socket.id] = { username, room, isTalking: false };
    socket.join(room);
    broadcastRoomList(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on ${PORT}`));
