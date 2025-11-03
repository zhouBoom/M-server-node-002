import express from 'express';
import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { logError, withErrorHandling, withSyncErrorHandling } from './utils/errorLogger.js';
// 定义 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
// 配置CORS
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
// 存储文档内容
let documentContent = '';
const versions = [];
let versionCounter = 0;
const VERSION_SAVE_INTERVAL = 10;
let editCounter = 0;
const users = new Map();
// 生成随机颜色
const getRandomColor = () => {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
};
// 生成唯一用户ID
const generateUserId = () => {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};
// 记录版本日志
const logVersionChange = (message) => {
    withSyncErrorHandling(() => {
        const timestamp = new Date().toISOString();
        const logEntry = `${timestamp} - ${message}
`;
        const logPath = path.join(__dirname, '../server/logs');
        // 确保日志目录存在
        if (!fs.existsSync(logPath)) {
            fs.mkdirSync(logPath, { recursive: true });
        }
        fs.appendFileSync(path.join(logPath, 'version.log'), logEntry);
    }, 'Versioning.logVersionChange', { message });
};
// 保存版本快照
const saveVersionSnapshot = async () => {
    await withErrorHandling(async () => {
        versionCounter++;
        const newVersion = {
            id: versionCounter,
            content: documentContent,
            timestamp: Date.now()
        };
        versions.push(newVersion);
        logVersionChange(`Saved version v${versionCounter}`);
    }, 'Versioning.saveVersionSnapshot');
};
// 处理WebSocket连接
wss.on('connection', (socket) => {
    console.log('New client connected');
    // 为新用户生成ID和颜色
    const user = {
        id: generateUserId(),
        color: getRandomColor()
    };
    users.set(socket, user);
    // 向新连接的客户端发送当前文档内容、用户ID和颜色
    withSyncErrorHandling(() => {
        socket.send(JSON.stringify({
            type: 'init',
            content: documentContent,
            userId: user.id,
            userColor: user.color
        }));
    }, 'WebSocket.init', { userId: user.id });
    // 广播新用户加入
    withSyncErrorHandling(() => {
        wss.clients.forEach((client) => {
            if (client && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'userJoin',
                    userId: user.id,
                    userColor: user.color
                }));
            }
        });
    }, 'WebSocket.userJoin', { userId: user.id });
    // 处理客户端消息
    socket.on('message', (message) => {
        withErrorHandling(async () => {
            let data;
            try {
                data = JSON.parse(message);
            }
            catch (error) {
                logError(new Error('Invalid JSON received'), 'WebSocket.message', { message });
                return;
            }
            const user = users.get(socket);
            if (!user)
                return;
            switch (data.type) {
                case 'update':
                    documentContent = data.content;
                    editCounter++;
                    // 每10次编辑保存一个版本快照
                    if (editCounter % VERSION_SAVE_INTERVAL === 0) {
                        await saveVersionSnapshot();
                    }
                    // 广播更新到所有客户端
                    wss.clients.forEach((client) => {
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'update',
                                content: documentContent,
                                userId: user.id
                            }));
                        }
                    });
                    break;
                case 'cursorMove':
                    // 广播光标位置到所有客户端
                    wss.clients.forEach((client) => {
                        if (client && client.readyState === WebSocket.OPEN && client !== socket) {
                            client.send(JSON.stringify({
                                type: 'cursorMove',
                                userId: user.id,
                                position: data.position,
                                color: user.color
                            }));
                        }
                    });
                    break;
                case 'versionRollback':
                    const versionId = parseInt(data.versionId);
                    if (isNaN(versionId)) {
                        logError(new Error('Invalid version ID'), 'WebSocket.versionRollback', { versionId: data.versionId, userId: user.id });
                        break;
                    }
                    const version = versions.find(v => v.id === versionId);
                    if (version) {
                        documentContent = version.content;
                        editCounter = 0; // 重置编辑计数器
                        // 广播回退到的版本内容
                        wss.clients.forEach((client) => {
                            if (client && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'update',
                                    content: documentContent,
                                    userId: user.id
                                }));
                            }
                        });
                        logVersionChange(`Rolled back to version v${versionId} by user ${user.id}`);
                    }
                    else {
                        logError(new Error('Version not found'), 'WebSocket.versionRollback', { versionId, userId: user.id });
                    }
                    break;
            }
        }, 'WebSocket.message', { message });
    });
    // 处理连接关闭
    socket.on('close', () => {
        withSyncErrorHandling(() => {
            console.log('Client disconnected');
            const user = users.get(socket);
            if (user) {
                // 移除用户
                users.delete(socket);
                // 广播用户离开
                wss.clients.forEach((client) => {
                    if (client && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'userLeave',
                            userId: user.id
                        }));
                    }
                });
            }
        }, 'WebSocket.close');
    });
    // 处理连接错误
    socket.on('error', (error) => {
        logError(error, 'WebSocket.error');
    });
});
// API接口：获取版本列表
app.get('/api/versions', (_req, res) => {
    withErrorHandling(async () => {
        res.json(versions.map(v => ({
            id: v.id,
            timestamp: v.timestamp
        })));
    }, 'API.getVersions')
        .catch(() => {
        res.status(500).json({ error: 'Internal server error' });
    });
});
// API接口：获取在线用户列表
app.get('/api/users', (_req, res) => {
    withErrorHandling(async () => {
        const onlineUsers = Array.from(users.values()).map(user => ({
            id: user.id,
            color: user.color
        }));
        res.json(onlineUsers);
    }, 'API.getUsers')
        .catch(() => {
        res.status(500).json({ error: 'Internal server error' });
    });
});
// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
// 处理未捕获的异常
process.on('uncaughtException', (error) => {
    logError(error, 'Process.uncaughtException');
    console.error('Uncaught Exception:', error);
});
// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logError(error, 'Process.unhandledRejection', { promise });
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
