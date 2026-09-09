import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Logger, type Context, type Exporter, type Message } from '@deepseek-ai/cordis'

/**
 * 插件业务日志级别开关。
 * DEV/DEBUG:文件全量落盘(含 warn/debug),方便开发排查。
 * PROD:文件只落盘 info/error,丢弃 warn/debug,减少噪音。
 * 用字符串值,方便从 env / patch YAML 写入。
 */
export enum LogLevel {
  DEV = 'dev',
  DEBUG = 'debug',
  PROD = 'prod',
}

/** 正式模式下允许落盘的最大 Cordis 级别(error=0, info=1)。 */
const PROD_MAX_LEVEL = 1

/** dsh home 目录(~/.dsh)下的默认日志子目录。 */
const DEFAULT_LOG_SUBDIR = join('logs', 'dsh-connect')

/**
 * 把 logPath 解析成绝对目录。
 *
 * - 空/未配置 → undefined(不落盘)
 * - 绝对路径 → 原样
 * - 相对路径 → 优先相对 dsh home(~/.dsh,通过 ctx.get('dshHomePath')),回退 os.homedir()/.dsh
 */
export function resolveLogDir(ctx: Context, logPath: string | undefined): string | undefined {
  if (!logPath) return undefined
  if (isAbsolute(logPath)) return logPath
  const dshHomePath = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  const base = dshHomePath
    ? dshHomePath('.') // ~/.dsh
    : join(homedir(), '.dsh')
  return resolve(base, logPath)
}

/** 默认日志目录(未配置 logPath 时插件也默认写这里,便于直接排查)。 */
export function defaultLogDir(ctx: Context): string {
  const dshHomePath = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  const base = dshHomePath
    ? dshHomePath('.')
    : join(homedir(), '.dsh')
  return join(base, DEFAULT_LOG_SUBDIR)
}

/**
 * 按天切分文件的日志 exporter。
 * 实现 Cordis 的 Exporter 接口;注册进 ctx.logger 后,
 * 所有 ctx.logger.* 消息都会追加到 <logDir>/dsh-connect-YYYY-MM-DD.log。
 */
export class FileExporter implements Exporter {
  private readonly logDir: string
  private currentDate = ''
  private currentFile = ''
  private readonly prodMode: boolean
  /** Logger.format 需要;留空则回退 Cordis defaultFormatters。 */
  readonly formatters: Record<string, never> = {}

  constructor(logDir: string, logLevel?: LogLevel) {
    this.logDir = logDir
    this.prodMode = logLevel === LogLevel.PROD
    mkdirSync(logDir, { recursive: true })
  }

  export(message: Message) {
    // PROD 模式只落盘 error/info,丢弃 warn/debug;DEV/DEBUG 全量。
    if (this.prodMode && message.level > PROD_MAX_LEVEL) return

    const date = new Date(message.ts)
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    const dateKey = `${yyyy}-${mm}-${dd}`

    // 跨天时切换文件
    if (dateKey !== this.currentDate) {
      this.currentDate = dateKey
      this.currentFile = join(this.logDir, `dsh-connect-${dateKey}.log`)
    }

    const time = date.toISOString()
    // 复用 Cordis 的 Logger.format:正确替换 %s/%d/%o,展开 Error,格式化对象
    // 极端输入(如循环引用对象)可能抛错,回退到朴素 join,不能影响落盘主流程。
    let text: string
    try {
      text = Logger.format(this, message)
    } catch {
      text = message.args
        .map((arg) => {
          if (arg instanceof Error) return arg.stack ?? arg.message
          if (typeof arg === 'string') return arg
          try {
            return JSON.stringify(arg)
          } catch {
            return String(arg)
          }
        })
        .join(' ')
    }
    const line = `[${time}] [${message.type.toUpperCase()}] [${message.name}] ${text}\n`

    try {
      appendFileSync(this.currentFile, line)
    } catch (error) {
      // 落盘失败不能影响主流程,只上报一次
      console.error(`[dsh-connect] 写日志文件失败 ${this.currentFile}:`, error)
    }
  }
}
