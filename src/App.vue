<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { ElInput, ElButton, ElSelect, ElOption, ElMessage, ElDialog } from 'element-plus'
import { Timer, Document, UserFilled, CircleCheckFilled, CircleCloseFilled, Clock, DocumentDelete, Lock } from '@element-plus/icons-vue'

const documentContent = ref('')
const userId = ref('')
const userColor = ref('')
const cursorPositions = ref<Record<string, { position: number; color: string }>>({})
const versions = ref<{ id: number; timestamp: number }[]>([])
const selectedVersion = ref('')
// WebSocket连接管理
let ws: WebSocket | null = null
let reconnectTimer: number | null = null
const RECONNECT_INTERVAL = 3000 // 3秒后尝试重连
// 消息队列，用于存储断线期间的消息
const messageQueue = ref<any[]>([])
// 新增状态变量
const onlineUsers = ref<{ id: string; color: string }[]>([])
const wsConnected = ref(false)
const showLogDialog = ref(false)
const highlightedUserId = ref<string | null>(null)
const systemLogs = ref<{ timestamp: string; message: string }[]>([])
// 日志最大显示数量
const MAX_LOGS = 10
// 文档锁定状态
const lockStatus = ref({ isLocked: false, holderId: null, autoReleaseAt: null, remainingTime: 0 })
// 解锁定时器
let unlockTimer: NodeJS.Timeout | null = null



// 处理JSON.stringify错误
const safeStringify = (data: any): string => {
  try {
    return JSON.stringify(data)
  } catch (error) {
    console.error('JSON.stringify error:', error)
    ElMessage.error('数据序列化失败，请检查输入内容')
    return ''
  }
}

// 处理JSON.parse错误
const safeParse = (data: string): any => {
  try {
    return JSON.parse(data)
  } catch (error) {
    console.error('JSON.parse error:', error)
    ElMessage.error('数据解析失败，请检查服务器响应')
    return null
  }
}

// 发送WebSocket消息
const sendMessage = (message: any) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const jsonString = safeStringify(message)
    if (jsonString) {
      try {
        ws.send(jsonString)
      } catch (error) {
        console.error('WebSocket send error:', error)
        ElMessage.error('消息发送失败，请检查网络连接')
        // 将消息加入队列，重连后发送
        messageQueue.value.push(message)
        startReconnectTimer()
      }
    }
  } else {
    console.error('WebSocket is not open')
    ElMessage.error('WebSocket连接已断开，消息将在重连后发送')
    // 将消息加入队列，重连后发送
    messageQueue.value.push(message)
    startReconnectTimer()
  }
}

// 添加系统日志
const addSystemLog = (message: string) => {
  const timestamp = new Date().toLocaleString()
  systemLogs.value.unshift({ timestamp, message })
  // 只保留最近10条日志
  if (systemLogs.value.length > MAX_LOGS) {
    systemLogs.value.pop()
  }
}

// 连接到WebSocket服务器
const connectWebSocket = () => {
  try {
    ws = new WebSocket('ws://localhost:3000')

    ws.onopen = () => {
      console.log('Connected to WebSocket server')
      wsConnected.value = true
      clearReconnectTimer()
      // 获取版本列表
      fetchVersionList()
      addSystemLog('已成功连接到服务器')
      // 发送队列中的消息
      if (messageQueue.value.length > 0) {
        addSystemLog(`正在发送${messageQueue.value.length}条离线消息`)
        // 复制队列并清空，避免在发送过程中添加新消息导致问题
        const queueCopy = [...messageQueue.value]
        messageQueue.value = []
        queueCopy.forEach(msg => {
          sendMessage(msg)
        })
      }
    }

    ws.onmessage = (event) => {
      try {
        const data = safeParse(event.data)
        if (!data) return
        
        switch (data.type) {
          case 'init':
            if (data.content !== undefined) documentContent.value = data.content
            if (data.userId !== undefined) userId.value = data.userId
            if (data.userColor !== undefined) userColor.value = data.userColor
            // 获取当前在线用户列表
            fetchOnlineUsers()
            // 初始化锁定状态
            if (data.lockStatus) {
              lockStatus.value = data.lockStatus
            }
            break
          case 'update':
            if (data.content !== undefined) documentContent.value = data.content
            break
          case 'cursorMove':
            if (data.userId !== undefined && data.position !== undefined && data.color !== undefined) {
              cursorPositions.value[data.userId] = {
                position: data.position,
                color: data.color
              }
              // 5秒后移除光标位置
              setTimeout(() => {
                if (cursorPositions.value[data.userId]) {
                  delete cursorPositions.value[data.userId]
                }
              }, 5000)
            }
            break
          case 'userJoin':
            if (data.userId !== undefined && data.userColor !== undefined) {
              onlineUsers.value.push({ id: data.userId, color: data.userColor })
              ElMessage({
                message: `用户 ${data.userId} 加入`,
                type: 'success'
              })
              addSystemLog(`用户 ${data.userId} 加入文档`)
            }
            break
          case 'userLeave':
            if (data.userId !== undefined) {
              onlineUsers.value = onlineUsers.value.filter(user => user.id !== data.userId)
              ElMessage({
                message: `用户 ${data.userId} 离开`,
                type: 'warning'
              })
              if (cursorPositions.value[data.userId]) {
                delete cursorPositions.value[data.userId]
              }
              // 如果高亮的用户离开，取消高亮
              if (highlightedUserId.value === data.userId) {
                highlightedUserId.value = null
              }
              addSystemLog(`用户 ${data.userId} 离开文档`)
            }
            break
          case 'onlineUsers':
            if (data.users !== undefined) onlineUsers.value = data.users
            break
          case 'lockStatus':
            if (data.lockStatus) {
              lockStatus.value = data.lockStatus
              // 如果文档被锁定且不是当前用户锁定的，提示只读
              if (data.lockStatus.isLocked && data.lockStatus.holderId !== userId.value) {
                ElMessage.warning(`文档已被 ${data.lockStatus.holderId} 锁定，您现在处于只读模式`)
                addSystemLog(`文档已被 ${data.lockStatus.holderId} 锁定，您现在处于只读模式`)
              } else if (!data.lockStatus.isLocked && data.lockStatus.holderId === userId.value) {
                ElMessage.success('您已释放文档锁定')
                addSystemLog('您已释放文档锁定')
              }
            }
            break
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error)
        ElMessage.error('处理服务器消息失败')
        // 记录错误日志
        console.error('Invalid message received:', event.data)
      }
    }

    ws.onclose = () => {
      console.log('Disconnected from WebSocket server')
      wsConnected.value = false
      onlineUsers.value = []
      cursorPositions.value = {}
      startReconnectTimer()
      addSystemLog('与服务器连接断开')
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
      wsConnected.value = false
      startReconnectTimer()
      addSystemLog('WebSocket连接发生错误')
    }
  } catch (error) {
    console.error('Error initializing WebSocket connection:', error)
    wsConnected.value = false
    startReconnectTimer()
    addSystemLog('无法连接到服务器')
  }
}

// 启动重连定时器
const startReconnectTimer = () => {
  if (!reconnectTimer) {
    reconnectTimer = window.setInterval(() => {
      console.log('Attempting to reconnect WebSocket...')
      connectWebSocket()
    }, RECONNECT_INTERVAL)
  }
}

// 清除重连定时器
const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearInterval(reconnectTimer)
    reconnectTimer = null
  }
}



  // 重置解锁定时器
  const resetUnlockTimer = () => {
    // 清除之前的定时器
    if (unlockTimer) {
      clearTimeout(unlockTimer)
    }
    
    // 设置新的定时器，5秒后自动解锁
    unlockTimer = setTimeout(() => {
      sendMessage({ type: 'unlockRequest' })
      unlockTimer = null
    }, 5000)
  }

  // 编辑节流定时器
  let editThrottleTimer: NodeJS.Timeout | null = null
  const EDIT_THROTTLE_DELAY = 300 // 300ms节流

  // 处理文档内容变化
    const handleDocumentChange = (value: string) => {
      if (lockStatus.value.isLocked && lockStatus.value.holderId !== userId.value) {
        ElMessage.warning('文档已被锁定，无法编辑')
        return
      }

      // 如果是当前用户锁定的，重置解锁定时器
      if (lockStatus.value.isLocked && lockStatus.value.holderId === userId.value) {
        resetUnlockTimer()
      } else {
        // 如果还没有锁定，发送锁定请求
        sendMessage({ type: 'lockRequest' })
        // 设置解锁定时器
        resetUnlockTimer()
      }

      // 编辑节流
      if (editThrottleTimer) {
        clearTimeout(editThrottleTimer)
      }
      editThrottleTimer = setTimeout(() => {
        sendMessage({ 
          type: 'update', 
          content: value
        })
      }, EDIT_THROTTLE_DELAY)
    }

  // 监听光标位置变化
  const handleCursorMove = (event: Event) => {
    const textarea = event.target as HTMLTextAreaElement
    const position = textarea.selectionStart || 0
    
    sendMessage({ type: 'cursorMove', position });
  }

  // 添加光标移动事件监听
  const textarea = document.querySelector('textarea')
  if (textarea) {
    textarea.addEventListener('mousemove', handleCursorMove)
    textarea.addEventListener('keydown', handleCursorMove)
  }

  // 组件卸载时移除事件监听和清除定时器
  onUnmounted(() => {
    if (textarea) {
      textarea.removeEventListener('mousemove', handleCursorMove)
      textarea.removeEventListener('keydown', handleCursorMove)
    }
    if (ws) {
      ws.close()
    }
    clearReconnectTimer()
    // 清除解锁定时器
    if (unlockTimer) {
      clearTimeout(unlockTimer)
    }
    // 清除编辑节流定时器
    if (editThrottleTimer) {
      clearTimeout(editThrottleTimer)
    }
  })

// 获取版本列表
const fetchVersionList = async () => {
  try {
    const response = await fetch('http://localhost:3000/api/versions')
    const data = await response.json()
    versions.value = data
  } catch (error) {
    console.error('Error fetching version list:', error)
    ElMessage.error('获取版本列表失败，请检查网络连接')
  }
}

// 获取在线用户列表
const fetchOnlineUsers = async () => {
  try {
    const response = await fetch('http://localhost:3000/api/users')
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    const data = await response.json()
    onlineUsers.value = data
  } catch (error) {
    console.error('Error fetching online users:', error)
    ElMessage.error('获取在线用户列表失败，请检查网络连接')
  }
}

// 高亮用户光标
const highlightUserCursor = (userId: string) => {
  if (highlightedUserId.value === userId) {
    highlightedUserId.value = null
  } else {
    highlightedUserId.value = userId
    // 高亮5秒后自动取消
    setTimeout(() => {
      if (highlightedUserId.value === userId) {
        highlightedUserId.value = null
      }
    }, 5000)
  }
}

// 日志弹窗关闭处理
const handleLogDialogClose = () => {
  showLogDialog.value = false
}

// 版本回退
const rollbackToVersion = () => {
  if (!selectedVersion.value) {
    ElMessage({
      message: '请选择要回退的版本',
      type: 'warning'
    });
    return;
  }
  
  sendMessage({ 
    type: 'versionRollback', 
    versionId: selectedVersion.value
  });
}

// 格式化时间戳
const formatTimestamp = (timestamp: number) => {
  return new Date(timestamp).toLocaleString()
}

// 计算光标位置
const getCursorPosition = (position: number) => {
  // 简单的近似计算，实际应用中需要更精确的计算
  // 假设每个字符宽度为8px
  return position * 8 + 10
}

// 计算光标所在行
const getCursorLine = (position: number) => {
  // 简单的近似计算，实际应用中需要更精确的计算
  // 假设每行最多显示80个字符，行高为20px
  const line = Math.floor(position / 80) + 1
  return line * 20 + 10
}

// 计算对比色
const getContrastColor = (color: string) => {
  // 移除#号
  color = color.replace('#', '')
  
  // 转换为RGB
  const r = parseInt(color.substring(0, 2), 16)
  const g = parseInt(color.substring(2, 4), 16)
  const b = parseInt(color.substring(4, 6), 16)
  
  // 计算亮度
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  
  // 返回对比色
  return brightness > 128 ? '#000000' : '#ffffff'
}

// 组件挂载时连接WebSocket
onMounted(() => {
  connectWebSocket()
})
</script>

<template>
  <el-container style="height: 100vh; overflow: hidden;">
    <!-- 顶部导航栏 -->
    <el-header class="app-header">
      <div class="header-left">
        <el-icon size="28" style="margin-right: 10px;">
          <Document />
        </el-icon>
        <h1 class="app-title">多人在线文档编辑器</h1>
      </div>
      <div class="header-right">
        <el-space>
          <el-badge :value="onlineUsers.length" type="success" :hidden="!onlineUsers.length">
            <el-icon size="20">
              <UserFilled />
            </el-icon>
          </el-badge>
          <div class="connection-status">
            <el-icon :color="wsConnected ? 'green' : 'red'" size="18">
              <CircleCheckFilled v-if="wsConnected" />
              <CircleCloseFilled v-else />
            </el-icon>
            <span>{{ wsConnected ? '已连接' : '未连接' }}</span>
          </div>
          <el-button
            type="primary"
            :icon="Clock"
            @click="showLogDialog = true"
          >
            系统日志
          </el-button>
        </el-space>
      </div>
    </el-header>

    <el-container>
      <!-- 协作者侧边栏 -->
      <el-aside width="280px" class="collaborators-sidebar">
        <el-card class="sidebar-card">
          <template #header>
            <div class="card-header">
              <el-icon size="18">
                <UserFilled />
              </el-icon>
              <span style="margin-left: 8px;">在线协作者</span>
              <el-badge :value="onlineUsers.length" type="primary" :hidden="!onlineUsers.length" class="user-count-badge" />
            </div>
          </template>
          <div class="user-list">
            <div
              v-for="user in onlineUsers"
              :key="user.id"
              class="user-item"
              :class="{ 'user-item-highlighted': highlightedUserId === user.id }"
              @click="highlightUserCursor(user.id)"
            >
              <div class="user-color-indicator" :style="{ backgroundColor: user.color }">
                <el-icon size="14" v-if="user.id === userId">
                  <UserFilled />
                </el-icon>
              </div>
              <span class="user-name">
                {{ user.id === userId ? `${user.id} (我)` : user.id }}
              </span>
            </div>
            <div v-if="onlineUsers.length === 0" class="no-users">
              <el-icon size="24" style="margin-right: 8px;">
                <UserFilled />
              </el-icon>
              <span>暂无在线用户</span>
            </div>
          </div>
        </el-card>
      </el-aside>

      <!-- 主内容区域 -->
      <el-main class="main-content">
        <el-card class="editor-card">
          <template #header>
            <div class="editor-header">
              <h2 class="editor-title">文档编辑</h2>
              <div class="version-control">
                <el-select
                  v-model="selectedVersion"
                  placeholder="选择版本"
                  style="width: 220px; margin-right: 12px"
                >
                  <el-option
                    v-for="version in versions"
                    :key="version.id"
                    :label="`v${version.id} - ${formatTimestamp(version.timestamp)}`"
                    :value="version.id.toString()"
                  />
                </el-select>
                <el-button
                  type="primary"
                  :icon="Timer"
                  @click="rollbackToVersion"
                  :disabled="!selectedVersion"
                >
                  回退版本
                </el-button>
              </div>
            </div>
          </template>

          <div class="editor-container">
            <div class="editor-wrapper">
              <div class="cursor-overlay">
                <div
                  v-for="(cursor, id) in cursorPositions"
                  :key="id"
                  class="cursor"
                  :class="{ 'cursor-highlighted': highlightedUserId === id }"
                  :style="{
                    left: `${getCursorPosition(cursor.position)}px`,
                    top: `${getCursorLine(cursor.position)}px`,
                    backgroundColor: cursor.color,
                    color: getContrastColor(cursor.color),
                    zIndex: highlightedUserId === id ? 100 : 1
                  }"
                >
                  {{ id }}
                </div>
              </div>
              <div v-if="lockStatus.isLocked && lockStatus.holderId !== userId" class="lock-overlay">
                <div class="lock-info">
                  <el-icon :size="48" style="color: #1989fa; margin-bottom: 16px;">
                    <Lock />
                  </el-icon>
                  <h3>文档已锁定</h3>
                  <p>当前由 {{ lockStatus.holderId }} 编辑中</p>
                  <p v-if="lockStatus.remainingTime > 0">自动解锁剩余时间: {{ Math.ceil(lockStatus.remainingTime / 1000) }}秒</p>
                </div>
              </div>
              <el-input
                v-model="documentContent"
                type="textarea"
                :rows="20"
                placeholder="开始编辑文档..."
                resize="none"
                class="document-input"
                @input="handleDocumentChange"
                @selectionchange="handleCursorMove"
                :disabled="lockStatus.isLocked && lockStatus.holderId !== userId"
              />
            </div>
          </div>

          <template #footer>
            <div class="current-user-info">
              <span>您的ID: {{ userId }}</span>
              <span>您的颜色: <span :style="{ color: userColor }" class="color-indicator">■</span></span>
            </div>
          </template>
        </el-card>
      </el-main>
    </el-container>

    <!-- 日志弹窗 -->
    <el-dialog
      v-model="showLogDialog"
      title="系统日志"
      width="600px"
      :before-close="handleLogDialogClose"
    >
      <div class="log-container">
        <div
          v-for="(log, index) in systemLogs"
          :key="index"
          class="log-item"
        >
          <span class="log-time">{{ log.timestamp }}</span>
          <span class="log-message">{{ log.message }}</span>
        </div>
        <div v-if="systemLogs.length === 0" class="no-logs">
          <el-icon size="24" style="margin-right: 8px;">
            <DocumentDelete />
          </el-icon>
          <span>暂无日志记录</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="showLogDialog = false">关闭</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style scoped>
/* 全局样式重置 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background-color: #f5f7fa;
  color: #333;
}

/* 主应用布局 */
.app-header {
  background-color: #fff;
  border-bottom: 1px solid #e4e7ed;
  padding: 0 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 60px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.09);
}

.header-left {
  display: flex;
  align-items: center;
}

.app-title {
  font-size: 20px;
  font-weight: 600;
  color: #1989fa;
  margin: 0;
}

.header-right {
  display: flex;
  align-items: center;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: #606266;
}

/* 侧边栏样式 */
.collaborators-sidebar {
  background-color: #fff;
  border-right: 1px solid #e4e7ed;
  padding: 16px;
  overflow-y: auto;
}

.sidebar-card {
  height: 100%;
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.05);
}

.card-header {
  display: flex;
  align-items: center;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.user-count-badge {
  margin-left: auto;
}

.user-list {
  margin-top: 12px;
}

.user-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  margin-bottom: 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.3s ease;
  background-color: #f9f9f9;
}

.user-item:hover {
  background-color: #ecf5ff;
}

.user-item-highlighted {
  background-color: #e6f7ff !important;
  border-left: 4px solid #1989fa;
}

.user-color-indicator {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.user-name {
  font-size: 14px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.no-users {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
  color: #909399;
  font-size: 14px;
}

/* 主内容区域 */
.main-content {
  padding: 24px;
  overflow-y: auto;
  background-color: #f5f7fa;
}

.editor-card {
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.05);
  background-color: #fff;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #e4e7ed;
}

.editor-title {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
  margin: 0;
}

.version-control {
  display: flex;
  align-items: center;
}

/* 编辑器样式 */
.editor-container {
  position: relative;
  padding: 20px;
}

.editor-wrapper {
  position: relative;
}

.cursor-overlay {
  position: absolute;
  top: 20px;
  left: 20px;
  width: calc(100% - 40px);
  height: calc(100% - 40px);
  pointer-events: none;
  z-index: 1;
  padding: 10px;
  font-size: 16px;
  line-height: 1.5;
}

.lock-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(255, 255, 255, 0.8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 10;
  border-radius: 6px;
}

.lock-info {
  text-align: center;
  padding: 24px;
  background-color: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
}

.lock-info h3 {
  margin: 0 0 8px 0;
  color: #303133;
  font-size: 18px;
  font-weight: 600;
}

.lock-info p {
  margin: 0 0 8px 0;
  color: #606266;
  font-size: 14px;
}

.lock-info p:last-child {
  margin-bottom: 0;
}

.cursor {
  position: absolute;
  height: 22px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 12px;
  line-height: 22px;
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
  transition: all 0.3s ease;
  transform: translateX(-50%);
}

.cursor::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 2px;
  height: 100%;
  background-color: inherit;
  animation: blink 1s infinite;
}

@keyframes blink {
  0% { opacity: 1; }
  50% { opacity: 0; }
  100% { opacity: 1; }
}

.cursor-highlighted {
  transform: translateX(-50%) scale(1.1);
  box-shadow: 0 0 12px rgba(25, 137, 250, 0.4);
}

.document-input {
  position: relative;
  z-index: 2;
  min-height: 400px;
  font-size: 16px;
  line-height: 1.6;
  border: none;
  resize: vertical;
  padding: 12px;
  background-color: #fafafa;
  border-radius: 6px;
  transition: background-color 0.3s ease;
}

.document-input:focus {
  background-color: #fff;
  outline: none;
  box-shadow: 0 0 0 2px rgba(25, 137, 250, 0.2);
}

/* 当前用户信息 */
.current-user-info {
  display: flex;
  gap: 20px;
  font-size: 14px;
  color: #606266;
  padding: 12px 20px;
  border-top: 1px solid #e4e7ed;
}

.color-indicator {
  font-size: 18px;
  vertical-align: middle;
}

/* 日志弹窗样式 */
.log-container {
  max-height: 400px;
  overflow-y: auto;
  padding-right: 8px;
}

.log-item {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.log-time {
  font-size: 12px;
  color: #909399;
  min-width: 120px;
  flex-shrink: 0;
}

.log-message {
  font-size: 14px;
  color: #303133;
  flex: 1;
  word-break: break-word;
}

.no-logs {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 0;
  color: #909399;
  font-size: 14px;
}

/* 滚动条样式 */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background-color: #f1f1f1;
}

::-webkit-scrollbar-thumb {
  background-color: #c1c1c1;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background-color: #a8a8a8;
}
</style>
