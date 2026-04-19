const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};
const TOOL_TYPES = ['magnifier', 'slug', 'syringe', 'phone', 'beer'];

io.on('connection', (socket) => {
    console.log('유저가 연결되었습니다:', socket.id);

    socket.on('join_room', ({ name, roomCode }) => {
        socket.join(roomCode);
        
        if (!rooms[roomCode]) {
            rooms[roomCode] = { 
                players: {}, 
                readyCount: 0,
                gameState: { stage: 1, turn: null, bullets: [], revealed: [] }
            };
        }

        rooms[roomCode].players[socket.id] = {
            name: name,
            isReady: false,
            id: socket.id,
            hp: 7,             
            tools: [],         
            slugActive: false, 
            beerActive: false,
            usedHitExtraTurn: false // [추가됨] 실탄 타격 시 추가 턴 1회 사용 여부 기억
        };

        io.to(roomCode).emit('update_lobby', Object.values(rooms[roomCode].players));
        socket.roomCode = roomCode;
    });

    socket.on('toggle_ready', () => {
        const room = rooms[socket.roomCode];
        if (room && room.players[socket.id]) {
            room.players[socket.id].isReady = !room.players[socket.id].isReady;
            room.readyCount = Object.values(room.players).filter(p => p.isReady).length;
            const totalPlayers = Object.keys(room.players).length;

            io.to(socket.roomCode).emit('update_lobby', Object.values(room.players));

            if (totalPlayers >= 2 && room.readyCount === totalPlayers) {
                io.to(socket.roomCode).emit('start_game');
                startRound(socket.roomCode);
            }
        }
    });

    function startRound(roomCode) {
        const room = rooms[roomCode];
        if(!room) return;
        const state = room.gameState;
        
        let liveCount = 0, blankCount = 0;
        
        if (state.stage === 1) { 
            liveCount = 2; blankCount = 2; 
        } else if (state.stage === 2) { 
            liveCount = 3; blankCount = 2; 
        } else if (state.stage === 3) { 
            liveCount = 4; blankCount = 2; 
        } else { 
            liveCount = Math.floor(Math.random() * 4) + 2; 
            blankCount = 7 - liveCount;
        }

        let deck = [];
        for(let i=0; i<liveCount; i++) deck.push('live');
        for(let i=0; i<blankCount; i++) deck.push('blank');
        deck.sort(() => Math.random() - 0.5);

        state.bullets = deck;
        state.totalBullets = deck.length;
        state.revealed = [];

        Object.values(room.players).forEach(p => {
            const randomTool = TOOL_TYPES[Math.floor(Math.random() * TOOL_TYPES.length)];
            p.tools = [randomTool]; 
            p.slugActive = false;
            p.beerActive = false;
            p.usedHitExtraTurn = false; // [추가됨] 라운드 시작 시 추가 턴 기회 갱신
        });

        // [핵심 수정 1] 턴 주인이 새로고침 등으로 방을 나갔을 경우, 유효한 플레이어로 턴 강제 변경
        if (!state.turn || !room.players[state.turn]) {
            state.turn = Object.keys(room.players)[0];
        }

        io.to(roomCode).emit('round_started', {
            stage: state.stage,
            total: deck.length,
            live: liveCount,
            blank: blankCount,
            turn: state.turn,
            players: room.players
        });
    }

    socket.on('player_action', (actionType) => {
        socket.to(socket.roomCode).emit('enemy_action', actionType);
    });

    socket.on('use_tool', () => {
        const room = rooms[socket.roomCode];
        if(!room) return;
        const state = room.gameState;
        if (state.turn !== socket.id) return; 

        const player = room.players[socket.id];
        if (!player.tools || player.tools.length === 0) return;

        const tool = player.tools.shift(); 
        let msg = '';
        let privateMsg = null;

        if (tool === 'magnifier') {
            msg = '돋보기를 사용했습니다!';
            privateMsg = `다음 탄은 [${state.bullets[0] === 'live' ? '실탄' : '공포탄'}] 입니다.`;
        } else if (tool === 'slug') {
            player.slugActive = true;
            msg = '슬러그탄을 장전했습니다! 다음 실탄 적중 시 피해량이 2배가 됩니다.';
        } else if (tool === 'syringe') {
            player.hp = Math.min(player.hp + 1, 7);
            msg = '주사기를 사용하여 생명력을 1 회복했습니다!';
        } else if (tool === 'phone') {
            msg = '전화기를 사용했습니다!';
            if (state.bullets.length > 0) {
                const idx = Math.floor(Math.random() * state.bullets.length);
                // [핵심 로직 수정] 전화기가 무조건 '전체 탄'을 기준으로 알려주도록 변경
                const originalIndex = state.revealed.length + idx + 1;
                privateMsg = `전체 탄 중 ${originalIndex}번째 탄은 [${state.bullets[idx] === 'live' ? '실탄' : '공포탄'}] 입니다.`;
            } else {
                privateMsg = '남은 탄이 없습니다.';
            }
        } else if (tool === 'beer') {
            player.beerActive = true;
            msg = '맥주를 마셨습니다! 이번 턴에 공포탄 자해 시 생명력을 1 회복합니다.';
        }

        io.to(socket.roomCode).emit('tool_used', {
            tool: tool,
            message: msg,
            players: room.players
        });

        if (privateMsg) {
            socket.emit('tool_private', privateMsg);
        }
    });

    socket.on('shoot', (target) => {
        const room = rooms[socket.roomCode];
        if(!room) return;
        const state = room.gameState;
        
        if (state.turn !== socket.id) return;

        const bullet = state.bullets.shift();
        state.revealed.push(bullet);

        const enemyId = Object.keys(room.players).find(id => id !== socket.id);
        const me = room.players[socket.id];
        const enemy = room.players[enemyId];

        let damage = me.slugActive ? 2 : 1;
        let isBeerActive = me.beerActive;
        me.slugActive = false; 
        me.beerActive = false; 

        let nextTurn = socket.id;

        if (target === 'self') {
            if (bullet === 'live') {
                me.hp -= damage;
                nextTurn = enemyId; 
            } else {
                if (isBeerActive) {
                    me.hp = Math.min(me.hp + 1, 7);
                }
                nextTurn = socket.id; 
            }
        } else if (target === 'enemy') {
            // [핵심 로직 2] 실탄 적중 시 1회 한정으로 내 턴 유지
            if (bullet === 'live') {
                enemy.hp -= damage;
                
                if (!me.usedHitExtraTurn) {
                    nextTurn = socket.id; // 첫 타격 성공! 내 턴 한 번 더
                    me.usedHitExtraTurn = true; // 보너스 기회 썼다고 저장
                } else {
                    nextTurn = enemyId; // 두 번째 연속 타격이면 얄짤없이 턴 넘김
                }
            } else {
                nextTurn = enemyId; // 공포탄 쐈으면 무조건 턴 넘김
            }
        }

        // [핵심 추가] 턴이 상대방에게 넘어가면, 상대방의 '추가 턴 기회'를 새롭게 리셋해줌
        if (nextTurn !== socket.id && room.players[nextTurn]) {
            room.players[nextTurn].usedHitExtraTurn = false;
        }

        let gameOver = false;
        [socket.id, enemyId].forEach(id => {
            if (id && room.players[id] && room.players[id].hp <= 0) {
                gameOver = true;
                io.to(socket.roomCode).emit('game_over', { loser: id });
            }
        });

        if (gameOver) return;
        state.turn = nextTurn;

        io.to(socket.roomCode).emit('shoot_action', {
            shooter: socket.id,
            target: target,
            bullet: bullet,
            players: room.players 
        });

        setTimeout(() => {
            if (state.bullets.length === 0) {
                state.stage += 1; 
                startRound(socket.roomCode);
            } else {
                io.to(socket.roomCode).emit('state_update', {
                   turn: state.turn,
                   players: room.players,
                   total: state.totalBullets,
                   revealed: state.revealed
                });
            }
        }, 3000);
    });

    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            
            // [핵심 수정 3] 방에 아무도 안 남으면 과거 찌꺼기 데이터가 든 유령 방을 완전히 폭파
            if (Object.keys(rooms[roomCode].players).length === 0) {
                delete rooms[roomCode];
            } else {
                // 선생님이 추가하신 튕김 시 자동 패배 로직 유지!
                io.to(roomCode).emit('game_over', { loser: socket.id });
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});