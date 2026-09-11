import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LogLevel } from '../log/logger.js'

/**
 * 全局业务配置。
 *
 * 取值优先级(高 → 低):
 *  1. setConfig(...) 运行时覆盖 —— 未来接入 apply(ctx, config)
 *  2. 进程环境变量 DSH_CONNECT_*(已存在的优先,不会被 .env 覆盖)
 *  3. 插件根目录 .env 文件(DSH_CONNECT_* 且进程未设置过的)
 *  4. dsh-connect.config.json(插件根目录)
 *  5. DEFAULT_CONFIG 兜底
 */
export interface Config {
  hostName: string
  /** WS 监听端口 */
  listenPort: number
  logLevel: LogLevel
  /** 日志信息记录，DEV和DEBUG都会做持久化 */
  logPath?: string
  /**
   * SQLite 数据库文件路径。
   * undefined = 用默认位置(dsh home 下);空串 = 不启用;相对路径基于 dsh home;绝对路径原样。
   */
  dbPath?: string
  /**
   * 远程任务用的模型路由(provider/model 必须成对)。
   * 不配则回退宿主默认模型(ctx.agentDefaultModel)。
   */
  agentProvider?: string
  agentModel?: string
  /** 会话空闲回收阈值(ms):超过则 dispose 常驻 agent,会话本身留在宿主。 */
  sessionIdleTimeoutMs: number
}
/**
 * 默认配置，做配置加载降级兜底
 */
export const DEFAULT_CONFIG: Config = {
  hostName: '0.0.0.0',
  listenPort: 8097,
  logLevel: LogLevel.DEV,
  sessionIdleTimeoutMs: 10 * 60 * 1000,
}

/** 本地配置文件路径,可用 env DSH_CONNECT_CONFIG 覆盖。 */
const CONFIG_FILE_ENV = 'DSH_CONNECT_CONFIG'
const CONFIG_FILE_DEFAULT = 'dsh-connect.config.json'
const ENV_PREFIX = 'DSH_CONNECT_'

/** 插件根目录:src/config/config.ts → 上两级。不依赖 process.cwd()。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 插件根目录下的 .env 文件。 */
const DOT_ENV_FILE = resolve(PLUGIN_ROOT, '.env')

/**
 * 读取插件根目录 .env,把其中 DSH_CONNECT_* 且进程尚未设置的变量注入 process.env。
 * 解析支持 KEY=VALUE、空行、# 注释(极简,不处理引号转义)。
 * 设 DSH_CONNECT_DOTENV=0 可禁用(测试隔离用)。
 */
function loadDotEnv(): void {
  if (process.env[`${ENV_PREFIX}DOTENV`] === '0') return
  if (!existsSync(DOT_ENV_FILE)) return
  try {
    const raw = readFileSync(DOT_ENV_FILE, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (!key.startsWith(ENV_PREFIX)) continue
      // 进程真实 env 优先:.env 不覆盖已存在的变量
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch (error) {
    console.warn(`[dsh-connect] 读取 .env 失败,已忽略:`, error)
  }
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) return DEFAULT_CONFIG.logLevel
  const normalized = value.trim().toLowerCase()
  if (normalized === 'dev') return LogLevel.DEV
  if (normalized === 'debug') return LogLevel.DEBUG
  if (normalized === 'prod') return LogLevel.PROD
  console.warn(`[dsh-connect] 未知 logLevel "${value}",回退 ${DEFAULT_CONFIG.logLevel}`)
  return DEFAULT_CONFIG.logLevel
}

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_CONFIG.listenPort
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.warn(`[dsh-connect] 非法端口 "${value}",回退 ${DEFAULT_CONFIG.listenPort}`)
    return DEFAULT_CONFIG.listenPort
  }
  return port
}

/** 解析毫秒时长;非法/非正数回退默认。 */
function parseDuration(value: string | undefined): number {
  if (!value) return DEFAULT_CONFIG.sessionIdleTimeoutMs
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) {
    console.warn(`[dsh-connect] 非法时长 "${value}",回退 ${DEFAULT_CONFIG.sessionIdleTimeoutMs}ms`)
    return DEFAULT_CONFIG.sessionIdleTimeoutMs
  }
  return ms
}

function readConfigFile(): Partial<Config> {
  // 默认取插件根目录的 dsh-connect.config.json;可用 DSH_CONNECT_CONFIG 覆盖(绝对/相对路径)
  const filePath = process.env[CONFIG_FILE_ENV]
    ? resolve(process.cwd(), process.env[CONFIG_FILE_ENV]!)
    : resolve(PLUGIN_ROOT, CONFIG_FILE_DEFAULT)
  if (!existsSync(filePath)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(`[dsh-connect] 配置文件 ${filePath} 顶层必须是对象,已忽略`)
      return {}
    }
    return parsed as Partial<Config>
  } catch (error) {
    console.warn(`[dsh-connect] 读取配置文件 ${filePath} 失败,已忽略:`, error)
    return {}
  }
}

function readEnv(): Partial<Config> {
  const env: Partial<Config> = {}
  const hostName = process.env[`${ENV_PREFIX}HOST`] ?? process.env[`${ENV_PREFIX}HOSTNAME`]
  if (hostName) env.hostName = hostName
  const port = process.env[`${ENV_PREFIX}PORT`]
  if (port) env.listenPort = parsePort(port)
  const logLevel = process.env[`${ENV_PREFIX}LOG_LEVEL`]
  if (logLevel) env.logLevel = parseLogLevel(logLevel)
  const logPath = process.env[`${ENV_PREFIX}LOG_PATH`]
  if (logPath) env.logPath = logPath
  const dbPath = process.env[`${ENV_PREFIX}DB_PATH`]
  // dbPath 空串也生效(语义:禁用 SQLite),区别于其它字段的「非空才覆盖」
  if (dbPath !== undefined) env.dbPath = dbPath
  const agentProvider = process.env[`${ENV_PREFIX}AGENT_PROVIDER`]
  if (agentProvider) env.agentProvider = agentProvider
  const agentModel = process.env[`${ENV_PREFIX}AGENT_MODEL`]
  if (agentModel) env.agentModel = agentModel
  const idleMs = process.env[`${ENV_PREFIX}SESSION_IDLE_MS`]
  if (idleMs) env.sessionIdleTimeoutMs = parseDuration(idleMs)
  return env
}

let current: Config | undefined

/** 读取全局配置单例(懒加载)。 */
export function getConfig(): Config {
  if (current) return current
  loadDotEnv()
  current = {
    ...DEFAULT_CONFIG,
    ...readConfigFile(),
    ...readEnv(),
  }
  return current
}

/** 运行时覆盖(未来由 apply(ctx, config) 调用)。 */
export function setConfig(patch: Partial<Config>): Config {
  current = { ...getConfig(), ...patch }
  return current
}

/** 重置单例(测试/热重载用)。 */
export function resetConfig(): void {
  current = undefined
}
