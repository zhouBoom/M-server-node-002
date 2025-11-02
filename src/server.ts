import express from 'express';
import http from 'http';
import WebSocket from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 存储文档内容
let documentContent = '';

// 处理WebSocket连接
wss.on('connection', (ws: WebSocket) => {
  console.log('New client connected');

  // 向新连接的客户端发送当前文档内容
  ws.send(JSON.stringify({ type: 'init', content: documentContent }));

  // 处理客户端消息
  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'update') {
        documentContent = data.content;
        // 广播更新到所有客户端
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update', content: documentContent }));
          }
        });
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // 处理连接关闭
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});