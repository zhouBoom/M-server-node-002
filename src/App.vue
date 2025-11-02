<script setup lang="ts">
import { ref, onMounted, watch, computed, onUnmounted } from 'vue'
import { ElInput, ElButton, ElSelect, ElOption, ElMessage } from 'element-plus'
import { ArrowDown, Timer } from '@element-plus/icons-vue'

const documentContent = ref('')
const userId = ref('')
const userColor = ref('')
const cursorPositions = ref<Record<string, { position: number; color: string }>>({})
const versions = ref<{ id: number; timestamp: number }[]>([])
const selectedVersion = ref('')
const ws: WebSocket | null = null

// 防抖函数
const debounce = (func: Function, delay: number) => {
  let timer: number | null = null
  return (...args: any[]) => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = window.setTimeout(() => {
      func.apply(null, args)
      timer = null
    }, delay)
  }
}

// 连接到WebSocket服务器
onMounted(() => {
  const ws = new WebSocket('ws://localhost:3000')

  ws.onopen = () => {
    console.log('Connected to WebSocket server')
    // 获取版本列表
    fetchVersionList()
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      switch (data.type) {
        case 'init':
          documentContent.value = data.content
          userId.value = data.userId
          userColor.value = data.userColor
          break
        case 'update':
          documentContent.value = data.content
          break
        case 'cursorMove':
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
          break
        case 'userJoin':
          ElMessage({
            message: `用户 ${data.userId} 加入`,
            type: 'success'
          })
          break
        case 'userLeave':
          ElMessage({
            message: `用户 ${data.userId} 离开`,
            type: 'warning'
          })
          if (cursorPositions.value[data.userId]) {
            delete cursorPositions.value[data.userId]
          }
          break
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error)
    }
  }

  ws.onclose = () => {
    console.log('Disconnected from WebSocket server')
  }

  ws.onerror = (error) => {
    console.error('WebSocket error:', error)
  }

  // 防抖发送更新
  const debouncedSendUpdate = debounce((content: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'update', content }))
    }
  }, 300)

  // 监听文档内容变化并发送到服务器
  watch(documentContent, (newContent) => {
    debouncedSendUpdate(newContent)
  })

  // 监听光标位置变化
  const handleCursorMove = (event: Event) => {
    const textarea = event.target as HTMLTextAreaElement
    const position = textarea.selectionStart || 0
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cursorMove', position }))
    }
  }

  // 添加光标移动事件监听
  const textarea = document.querySelector('textarea')
  if (textarea) {
    textarea.addEventListener('mousemove', handleCursorMove)
    textarea.addEventListener('keydown', handleCursorMove)
  }

  // 组件卸载时移除事件监听
  onUnmounted(() => {
    if (textarea) {
      textarea.removeEventListener('mousemove', handleCursorMove)
      textarea.removeEventListener('keydown', handleCursorMove)
    }
    if (ws) {
      ws.close()
    }
  })
})

// 获取版本列表
const fetchVersionList = async () => {
  try {
    const response = await fetch('http://localhost:3000/api/versions')
    const data = await response.json()
    versions.value = data
  } catch (error) {
    console.error('Error fetching version list:', error)
  }
}

// 版本回退
const rollbackToVersion = () => {
  if (!selectedVersion.value || !ws || ws.readyState !== WebSocket.OPEN) return
  
  ws.send(JSON.stringify({ 
    type: 'versionRollback', 
    versionId: selectedVersion.value
  }))
  
  ElMessage({
    message: `已回退到版本 v${selectedVersion.value}`,
    type: 'success'
  })
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
</script>

<template>
  <div class="document-editor">
    <div class="editor-header">
      <h1>在线文档编辑器</h1>
      <div class="version-control">
        <el-select
          v-model="selectedVersion"
          placeholder="选择版本"
          style="width: 200px; margin-right: 10px"
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
    
    <div class="editor-container">
      <div class="editor-wrapper">
        <div class="cursor-overlay">
          <div
            v-for="(cursor, id) in cursorPositions"
            :key="id"
            class="cursor"
            :style="{
              left: `${getCursorPosition(cursor.position)}px`,
              top: `${getCursorLine(cursor.position)}px`,
              backgroundColor: cursor.color,
              color: getContrastColor(cursor.color)
            }"
          >
            {{ id }}
          </div>
        </div>
        <el-input
          v-model="documentContent"
          type="textarea"
          :rows="15"
          placeholder="开始编辑文档..."
          resize="none"
          class="document-input"
        />
      </div>
    </div>
    
    <div class="user-info">
      <span>您的ID: {{ userId }}</span>
      <span>您的颜色: <span :style="{ color: userColor }">■</span></span>
    </div>
  </div>
</template>

<style scoped>
.document-editor {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.version-control {
  display: flex;
  align-items: center;
}

.editor-container {
  position: relative;
}

.editor-wrapper {
  position: relative;
}

.cursor-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
  padding: 10px;
  font-size: 16px;
  line-height: 1.5;
}

.cursor {
  position: absolute;
  height: 20px;
  padding: 0 2px;
  border-radius: 2px;
  font-size: 12px;
  line-height: 20px;
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

.document-input {
  position: relative;
  z-index: 2;
  min-height: 400px;
}

.user-info {
  margin-top: 20px;
  display: flex;
  gap: 20px;
  font-size: 14px;
  color: #666;
}

/* 辅助函数，在实际应用中需要根据字体和行高进行调整 */
.get-cursor-position {
  /* 实际应用中需要根据文本内容计算光标位置 */
}

.get-cursor-line {
  /* 实际应用中需要根据文本内容计算光标所在行 */
}

.get-contrast-color {
  /* 实际应用中需要根据背景颜色计算对比色 */
}
</style>
