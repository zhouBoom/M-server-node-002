<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { ElInput } from 'element-plus'

const documentContent = ref('')
let ws: WebSocket | null = null

// 连接到WebSocket服务器
onMounted(() => {
  ws = new WebSocket('ws://localhost:3000')

  ws.onopen = () => {
    console.log('Connected to WebSocket server')
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.type === 'init' || data.type === 'update') {
        documentContent.value = data.content
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
})

// 监听文档内容变化并发送到服务器
watch(documentContent, (newContent) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'update', content: newContent }))
  }
})
</script>

<template>
  <div class="document-editor">
    <h1>在线文档编辑器</h1>
    <el-input
      v-model="documentContent"
      type="textarea"
      :rows="15"
      placeholder="开始编辑文档..."
      resize="none"
    />
  </div>
</template>

<style scoped>
.document-editor {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
}

textarea {
  font-size: 16px;
  line-height: 1.5;
}
</style>
