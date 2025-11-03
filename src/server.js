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
let currentLock = null;
let lockTimer = null;
const LOCK_DURATION = 5000; // 5秒自动释放锁
// 记录锁日志
const logLockAction = (action, holderId, duration, autoReleaseAt, reason) => {
    withSyncErrorHandling(() => {
        const logPath = path.join(__dirname, '../server');
        const logFile = path.join(logPath, 'lock_log.json');
        // 确保日志目录存在
        if (!fs.existsSync(logPath)) {
            fs.mkdirSync(logPath, { recursive: true });
        }
        // 读取现有日志
        let logs = [];
        if (fs.existsSync(logFile)) {
            const logContent = fs.readFileSync(logFile, 'utf-8');
            if (logContent) {
                try {
                    logs = JSON.parse(logContent);
                }
                catch (parseError) {
                    console.error('Failed to parse lock log file:', parseError);
                    logs = [];
                }
            }
        }
        // 创建新日志条目
        const newLog = {
            timestamp: new Date().toISOString(),
            action,
            holderId,
            duration,
            autoReleaseAt,
            reason
        };
        // 添加新日志到开头
        logs.unshift(newLog);
        // 写入日志文件
        const logString = JSON.stringify(logs, null, 2);
        fs.writeFileSync(logFile, logString, 'utf-8');
    }, 'Lock.logLockAction', { action, holderId, duration, autoReleaseAt, reason });
};
// 获取文档锁
const acquireLock = (socket, userId) => {
    if (currentLock && currentLock.holderId !== userId) {
        return false; // 锁已被其他用户持有
    }
    // 清除之前的定时器
    if (lockTimer) {
        clearTimeout(lockTimer);
    }
    const acquiredAt = Date.now();
    const autoReleaseAt = acquiredAt + LOCK_DURATION;
    currentLock = {
        holderId: userId,
        holderSocket: socket,
        acquiredAt,
        autoReleaseAt,
        duration: LOCK_DURATION
    };
    // 设置自动释放定时器
    lockTimer = setTimeout(() => {
        releaseLock(userId, 'auto-release');
    }, LOCK_DURATION);
    // 记录锁日志
    logLockAction('acquire', userId, LOCK_DURATION, autoReleaseAt);
    // 广播锁状态变化
    broadcastLockStatus();
    return true;
};
// 释放文档锁
const releaseLock = (userId, reason) => {
    if (!currentLock || currentLock.holderId !== userId) {
        return false; // 没有锁或锁不属于该用户
    }
    // 清除定时器
    if (lockTimer) {
        clearTimeout(lockTimer);
        lockTimer = null;
    }
    // 计算实际持有时间
    const actualDuration = Date.now() - currentLock.acquiredAt;
    // 记录锁日志
    logLockAction(reason, userId, actualDuration, currentLock.autoReleaseAt, reason);
    // 释放锁
    currentLock = null;
    // 广播锁状态变化
    broadcastLockStatus();
    return true;
};
// 广播锁状态
const broadcastLockStatus = () => {
    wss.clients.forEach((client) => {
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'lockStatus',
                isLocked: !!currentLock,
                holderId: currentLock?.holderId || null,
                autoReleaseAt: currentLock?.autoReleaseAt || null,
                remainingTime: currentLock ? Math.max(0, currentLock.autoReleaseAt - Date.now()) : 0
            }));
        }
    });
};
// 检查用户是否持有锁
const isLockHolder = (userId) => {
    return currentLock && currentLock.holderId === userId;
};
// 检查用户是否可以编辑
const canEdit = (userId) => {
    return !currentLock || isLockHolder(userId);
};
// 重置锁定时器（用户有操作时调用）
const resetLockTimer = (userId) => {
    if (!currentLock || currentLock.holderId !== userId) {
        return false; // 没有锁或锁不属于该用户
    }
    // 清除之前的定时器
    if (lockTimer) {
        clearTimeout(lockTimer);
    }
    // 更新自动释放时间
    currentLock.autoReleaseAt = Date.now() + LOCK_DURATION;
    // 设置新的定时器
    lockTimer = setTimeout(() => {
        releaseLock(userId, 'auto-release');
    }, LOCK_DURATION);
    // 广播锁状态变化（更新剩余时间）
    broadcastLockStatus();
    return true;
};
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
    // 向新连接的客户端发送当前文档内容、用户ID、颜色和锁状态
    withSyncErrorHandling(() => {
        socket.send(JSON.stringify({
            type: 'init',
            content: documentContent,
            userId: user.id,
            userColor: user.color,
            lockStatus: {
                isLocked: !!currentLock,
                holderId: currentLock?.holderId || null,
                autoReleaseAt: currentLock?.autoReleaseAt || null,
                remainingTime: currentLock ? Math.max(0, currentLock.autoReleaseAt - Date.now()) : 0
            }
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
                case 'lockRequest':
                    const lockAcquired = acquireLock(socket, user.id);
                    socket.send(JSON.stringify({
                        type: 'lockResponse',
                        success: lockAcquired,
                        isLocked: !!currentLock,
                        holderId: currentLock?.holderId || null,
                        autoReleaseAt: currentLock?.autoReleaseAt || null,
                        remainingTime: currentLock ? Math.max(0, currentLock.autoReleaseAt - Date.now()) : 0
                    }));
                    break;
                case 'unlockRequest':
                    const lockReleased = releaseLock(user.id, 'manual');
                    socket.send(JSON.stringify({
                        type: 'unlockResponse',
                        success: lockReleased,
                        isLocked: !!currentLock,
                        holderId: currentLock?.holderId || null
                    }));
                    break;
                case 'update':
                    // 检查用户是否有权限编辑
                    if (!canEdit(user.id)) {
                        socket.send(JSON.stringify({
                            type: 'editDenied',
                            message: '文档已被其他用户锁定',
                            holderId: currentLock?.holderId || null,
                            remainingTime: currentLock ? Math.max(0, currentLock.autoReleaseAt - Date.now()) : 0
                        }));
                        break;
                    }
                    documentContent = data.content;
                    editCounter++;
                    // 每10次编辑保存一个版本快照
                    if (editCounter % VERSION_SAVE_INTERVAL === 0) {
                        await saveVersionSnapshot();
                    }
                    // 重置锁定时器
                    resetLockTimer(user.id);
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
                    // 检查用户是否有权限编辑
                    if (!canEdit(user.id)) {
                        socket.send(JSON.stringify({
                            type: 'editDenied',
                            message: '文档已被其他用户锁定',
                            holderId: currentLock?.holderId || null,
                            remainingTime: currentLock ? Math.max(0, currentLock.autoReleaseAt - Date.now()) : 0
                        }));
                        break;
                    }
                    const versionId = parseInt(data.versionId);
                    if (isNaN(versionId)) {
                        logError(new Error('Invalid version ID'), 'WebSocket.versionRollback', { versionId: data.versionId, userId: user.id });
                        break;
                    }
                    const version = versions.find(v => v.id === versionId);
                    if (version) {
                        documentContent = version.content;
                        editCounter = 0; // 重置编辑计数器
                        // 重置锁定时器
                        resetLockTimer(user.id);
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
                // 如果用户持有锁，释放锁
                if (currentLock && currentLock.holderId === user.id) {
                    releaseLock(user.id, 'disconnect');
                }
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
