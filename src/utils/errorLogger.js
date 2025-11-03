import * as fs from 'fs';
import * as path from 'path';
// 错误日志配置
const ERROR_LOG_FILE = path.join(__dirname, '../../logs/error_logs.json');
const MAX_LOG_SIZE = 1024 * 1024; // 1MB
const MAX_LOG_ENTRIES = 1000; // 最多保留1000条日志
// 确保日志目录存在
const logDir = path.dirname(ERROR_LOG_FILE);
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}
/**
 * 记录错误日志
 * @param error 错误对象
 * @param module 模块名称
 * @param extra 额外信息
 */
export const logError = (error, module = 'unknown', extra) => {
    try {
        // 读取现有日志
        let logs = [];
        if (fs.existsSync(ERROR_LOG_FILE)) {
            const logContent = fs.readFileSync(ERROR_LOG_FILE, 'utf-8');
            if (logContent) {
                try {
                    logs = JSON.parse(logContent);
                }
                catch (parseError) {
                    console.error('Failed to parse error log file:', parseError);
                    logs = [];
                }
            }
        }
        // 创建新日志条目
        const newLog = {
            timestamp: new Date().toISOString(),
            message: error.message,
            stack: error.stack,
            module,
            extra
        };
        // 添加新日志到开头
        logs.unshift(newLog);
        // 限制日志数量
        if (logs.length > MAX_LOG_ENTRIES) {
            logs = logs.slice(0, MAX_LOG_ENTRIES);
        }
        // 写入日志文件
        const logString = JSON.stringify(logs, null, 2);
        fs.writeFileSync(ERROR_LOG_FILE, logString, 'utf-8');
        // 检查文件大小，如果超过限制则删除最旧的日志
        const stats = fs.statSync(ERROR_LOG_FILE);
        if (stats.size > MAX_LOG_SIZE) {
            // 删除最旧的一半日志
            logs = logs.slice(0, Math.floor(logs.length / 2));
            const trimmedLogString = JSON.stringify(logs, null, 2);
            fs.writeFileSync(ERROR_LOG_FILE, trimmedLogString, 'utf-8');
        }
    }
    catch (logError) {
        console.error('Failed to write error log:', logError);
    }
};
/**
 * 异步操作错误处理包装器
 * @param fn 异步函数
 * @param module 模块名称
 * @param extra 额外信息
 */
export const withErrorHandling = async (fn, module = 'unknown', extra) => {
    try {
        return await fn();
    }
    catch (error) {
        if (error instanceof Error) {
            logError(error, module, extra);
        }
        else {
            logError(new Error(String(error)), module, extra);
        }
        return null;
    }
};
/**
 * 同步操作错误处理包装器
 * @param fn 同步函数
 * @param module 模块名称
 * @param extra 额外信息
 */
export const withSyncErrorHandling = (fn, module = 'unknown', extra) => {
    try {
        return fn();
    }
    catch (error) {
        if (error instanceof Error) {
            logError(error, module, extra);
        }
        else {
            logError(new Error(String(error)), module, extra);
        }
        return null;
    }
};
