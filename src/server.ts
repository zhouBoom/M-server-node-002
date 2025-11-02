import * as express from 'express';
import type { Response } from 'express';
import * as http from 'http';
import * as WebSocket from 'ws';
const WebSocketServer = WebSocket.Server;
import * as fs from 'fs';
import * as path from 'path';
import * as cors from 'cors';

// 声明__dirname
const __dirname = __filename ? path.dirname(__filename) : process.cwd();


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
}

const users: Map<WebSocket, User> = new Map();

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
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${message}
`;
    const logPath = path.join(__dirname, '../server/logs');
    
    // 确保日志目录存在
    if (!fs.existsSync(logPath)) {
      fs.mkdirSync(logPath, { recursive: true });
    }
    
    fs.appendFileSync(path.join(logPath, 'version.log'), logEntry);
  } catch (error) {
    console.error('Error writing to log file:', error);
  }
};

// 保存版本快照
const saveVersionSnapshot = (): void => {
  try {
    versionCounter++;
    const newVersion: Version = {
      id: versionCounter,
      content: documentContent,
      timestamp: Date.now()
    };
    versions.push(newVersion);
    logVersionChange(`Saved version v${versionCounter}`);
  } catch (error) {
    console.error('Error saving version snapshot:', error);
  }
};

// 处理WebSocket连接
wss.on('connection', (ws: WebSocket) => {
  console.log('New client connected');

  // 为新用户生成ID和颜色
  const user: User = {
    id: generateUserId(),
    color: getRandomColor()
  };
  users.set(ws, user);

  // 向新连接的客户端发送当前文档内容、用户ID和颜色
  ws.send(JSON.stringify({ 
    type: 'init', 
    content: documentContent,
    userId: user.id,
    userColor: user.color
  }));

  // 广播新用户加入
  wss.clients.forEach((client: WebSocket) => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ 
        type: 'userJoin', 
        userId: user.id,
        userColor: user.color
      }));
    }
  });

  // 处理客户端消息
  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message);
      const user = users.get(ws);

      if (!user) return;

      switch (data.type) {
        case 'update':
          documentContent = data.content;
          editCounter++;
          
          // 每10次编辑保存一个版本快照
          if (editCounter % VERSION_SAVE_INTERVAL === 0) {
            saveVersionSnapshot();
          }
          
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
              if (client && client.readyState === WebSocket.OPEN && client !== ws) {
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
            console.error('Invalid version ID:', data.versionId);
            break;
          }
          
          const version = versions.find(v => v.id === versionId);
          
          if (version) {
            documentContent = version.content;
            editCounter = 0; // 重置编辑计数器
            
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
            console.error('Version not found:', versionId);
          }
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // 处理连接关闭
  ws.on('close', () => {
    console.log('Client disconnected');
    const user = users.get(ws);
    
    if (user) {
      // 移除用户
      users.delete(ws);
      
      // 广播用户离开
      wss.clients.forEach((client: WebSocket) => {
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ 
            type: 'userLeave', 
            userId: user.id
          }));
        }
      });
    }
  });
});

// API接口：获取版本列表
app.get('/api/versions', (_req: unknown, res: Response) => {
  res.json(versions.map(v => ({
    id: v.id,
    timestamp: v.timestamp
  })));
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});