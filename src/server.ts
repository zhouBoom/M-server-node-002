import express from 'express';
import type { Response } from 'express';
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

// 版本控制
interface Version {
  id: number;
  content: string;
  timestamp: number;
}

const versions: Version[] = [];
let versionCounter = 0;
const VERSION_SAVE_INTERVAL = 10;
let editCounter = 0;

// 用户管理
interface User {
  id: string;
  color: string;
  lastActive: number;
  style?: {
    fontFamily?: string;
    fontSize?: string;
    lineHeight?: string;
    backgroundColor?: string;
    border?: string;
    padding?: string;
  };
}

const users: Map<WebSocket, User> = new Map();
const disconnectedUsers: Map<string, User> = new Map();
const DISCONNECT_TIMEOUT = 30000; // 30秒后清除断开连接的用户

// 文档锁机制
interface Lock {
  holderId: string;
  holderSocket: WebSocket;
  acquiredAt: number;
  autoReleaseAt: number;
  duration: number;
}

let currentLock: Lock | null = null;
let lockTimer: NodeJS.Timeout | null = null;
const LOCK_DURATION = 5000; // 5秒自动释放锁

// 锁日志接口
interface LockLog {
  timestamp: string;
  action: 'acquire' | 'release' | 'auto-release' | 'manual' | 'disconnect';
  holderId: string;
  duration: number;
  autoReleaseAt: number;
  reason?: string;
}

// 记录锁日志
const logLockAction = (action: LockLog['action'], holderId: string, duration: number, autoReleaseAt: number, reason?: string) => {
  withSyncErrorHandling(() => {
    const logPath = path.join(__dirname, '../server');
    const logFile = path.join(logPath, 'lock_log.json');
    
    // 确保日志目录存在
    if (!fs.existsSync(logPath)) {
      fs.mkdirSync(logPath, { recursive: true });
    }
    
    // 读取现有日志
    let logs: LockLog[] = [];
    if (fs.existsSync(logFile)) {
      const logContent = fs.readFileSync(logFile, 'utf-8');
      if (logContent) {
        try {
          logs = JSON.parse(logContent);
        } catch (parseError) {
          console.error('Failed to parse lock log file:', parseError);
          logs = [];
        }
      }
    }
    
    // 创建新日志条目
    const newLog: LockLog = {
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
const acquireLock = (socket: WebSocket, userId: string) => {
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
const releaseLock = (userId: string, reason: 'manual' | 'auto-release' | 'disconnect') => {
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
  wss.clients.forEach((client: WebSocket) => {
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
const isLockHolder = (userId: string) => {
  return currentLock && currentLock.holderId === userId;
};

// 检查用户是否可以编辑
const canEdit = (userId: string) => {
  return !currentLock || isLockHolder(userId);
};

// 重置锁定时器（用户有操作时调用）
const resetLockTimer = (userId: string) => {
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
const getRandomColor = (): string => {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
};

// 生成唯一用户ID
const generateUserId = (): string => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

// 记录版本日志
const logVersionChange = (message: string): void => {
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
const saveVersionSnapshot = async (): Promise<void> => {
  await withErrorHandling(async () => {
    versionCounter++;
    const newVersion: Version = {
      id: versionCounter,
      content: documentContent,
      timestamp: Date.now()
    };
    versions.push(newVersion);
    logVersionChange(`Saved version v${versionCounter}`);
  }, 'Versioning.saveVersionSnapshot');
};

// 超时与重试控制
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000; // 1秒

// 处理WebSocket连接
wss.on('connection', (socket: WebSocket) => {
  console.log('New client connected');
  let retryAttempts = 0;

  // 检查是否有断开连接的用户可以恢复
  let user: User | undefined;
  for (const [userId, disconnectedUser] of disconnectedUsers.entries()) {
    // 可以根据需要添加更复杂的恢复逻辑，比如检查用户ID或其他标识
    user = disconnectedUser;
    disconnectedUsers.delete(userId);
    break;
  }
  
  // 如果没有可恢复的用户，创建新用户
  if (!user) {
    user = {
      id: generateUserId(),
      color: getRandomColor(),
      lastActive: Date.now()
    };
  } else {
    // 更新恢复用户的最后活动时间
    user.lastActive = Date.now();
  }
  
  users.set(socket, user);

  // 向新连接的客户端发送当前文档内容、用户ID、颜色、样式和锁状态
  withSyncErrorHandling(() => {
    socket.send(JSON.stringify({ 
      type: 'init', 
      content: documentContent,
      userId: user.id,
      userColor: user.color,
      userStyle: user.style,
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
    wss.clients.forEach((client: WebSocket) => {
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
  socket.on('message', (message: string) => {
    withErrorHandling(async () => {
      let data;
      try {
        data = JSON.parse(message);
      } catch (error) {
        logError(new Error('Invalid JSON received'), 'WebSocket.message', { message });
        return;
      }
      const user = users.get(socket);

      if (!user) return;

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
          
          // 冲突自动合并逻辑
          // 假设文档内容按换行符分割成段落
          const currentParagraphs = documentContent.split('\n');
          const incomingParagraphs = data.content.split('\n');
          const mergedParagraphs = [...currentParagraphs];
          
          // 合并不同段落的修改，保留最新修改的段落
          for (let i = 0; i < incomingParagraphs.length; i++) {
            if (i >= mergedParagraphs.length || incomingParagraphs[i] !== mergedParagraphs[i]) {
              mergedParagraphs[i] = incomingParagraphs[i];
            }
          }
          
          // 更新文档内容
          documentContent = mergedParagraphs.join('\n');
          editCounter++;
          
          // 每10次编辑保存一个版本快照
          if (editCounter % VERSION_SAVE_INTERVAL === 0) {
            await saveVersionSnapshot();
          }
          
          // 重置锁定时器
          resetLockTimer(user.id);
          
          // 广播更新到所有客户端
          wss.clients.forEach((client: WebSocket) => {
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
          wss.clients.forEach((client: WebSocket) => {
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
            wss.clients.forEach((client: WebSocket) => {
              if (client && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ 
                  type: 'update', 
                  content: documentContent,
                  userId: user.id
                }));
              }
            });
            
            logVersionChange(`Rolled back to version v${versionId} by user ${user.id}`);
          } else {
            logError(new Error('Version not found'), 'WebSocket.versionRollback', { versionId, userId: user.id });
          }
          break;
        
        case 'styleChange':
          // 更新用户样式
          user.style = data.style;
          
          // 广播样式变更到所有客户端
          wss.clients.forEach((client: WebSocket) => {
            if (client && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ 
                type: 'styleChange', 
                userId: user.id,
                style: data.style
              }));
            }
          });
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
        
        // 将用户添加到断开连接用户列表
        disconnectedUsers.set(user.id, user);
        
        // 移除用户
        users.delete(socket);
        
        // 广播用户离开
        wss.clients.forEach((client: WebSocket) => {
          if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ 
              type: 'userLeave', 
              userId: user.id
            }));
          }
        });
        
        // 设置定时器，30秒后清除断开连接的用户
        setTimeout(() => {
          disconnectedUsers.delete(user.id);
        }, DISCONNECT_TIMEOUT);
      }
    }, 'WebSocket.close');
  });

  // 处理连接错误
  socket.on('error', (error: Error) => {
    logError(error, 'WebSocket.error');
  });
});

// API接口：获取版本列表
app.get('/api/versions', (_req: unknown, res: Response) => {
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
app.get('/api/users', (_req: unknown, res: Response) => {
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