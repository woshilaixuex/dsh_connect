import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/cordis'
import {
  FileExporter,
  LogLevel,
  resolveLogDir,
  defaultLogDir,
} from '../src/log/logger.js'

/** 造一条测试 Message。 */
function makeMessage(overrides: Partial<Message> = {}): Message {
  const now = Date.now()
  return {
    sn: 1,
    ts: now,
    type: 'info',
    level: 1,
    name: 'dsh-connect/test',
    args: [],
    ...overrides,
  }
}

/** 本地日期 YYYY-MM-DD(与 FileExporter 命名一致)。 */
function localDateKey(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** 造一个假 ctx,只提供 get('dshHomePath')。 */
function makeCtx(dshHome?: string) {
  const base = dshHome ?? join(tmpdir(), 'fake-dsh-home')
  return {
    get: (key: string) => (key === 'dshHomePath' ? (...seg: string[]) => join(base, ...seg) : undefined),
  } as unknown as Parameters<typeof resolveLogDir>[0]
}

let dirs: string[] = []

beforeEach(() => {
  dirs = []
})

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-connect-logger-'))
  dirs.push(dir)
  return dir
}

describe('resolveLogDir', () => {
  test('未配置 logPath 返回 undefined(不落盘)', () => {
    assert.equal(resolveLogDir(makeCtx(), undefined), undefined)
    assert.equal(resolveLogDir(makeCtx(), ''), undefined)
  })

  test('绝对路径原样返回', () => {
    const abs = join(tmpdir(), 'my-logs')
    assert.equal(resolveLogDir(makeCtx(), abs), abs)
  })

  test('相对路径基于 dshHomePath(~/.dsh)解析', () => {
    const home = makeTempDir()
    const ctx = makeCtx(home)
    assert.equal(resolveLogDir(ctx, 'logs'), join(home, 'logs'))
    assert.equal(resolveLogDir(ctx, 'logs/sub'), join(home, 'logs', 'sub'))
  })

  test('dshHomePath 不可用时回退 os.homedir()/.dsh', () => {
    const ctx = {
      get: () => undefined,
    } as unknown as Parameters<typeof resolveLogDir>[0]
    const resolved = resolveLogDir(ctx, 'logs')
    // 一定是基于 .dsh 下的绝对路径
    assert.ok(resolved?.endsWith(join('.dsh', 'logs')))
    assert.ok(resolved && resolved.length > 0)
  })
})

describe('defaultLogDir', () => {
  test('返回 ~/.dsh/logs/dsh-connect', () => {
    const home = makeTempDir()
    const ctx = makeCtx(home)
    assert.equal(defaultLogDir(ctx), join(home, 'logs', 'dsh-connect'))
  })
})

describe('FileExporter', () => {
  test('DEV 模式:error/info/warn/debug 全量落盘', () => {
    const dir = makeTempDir()
    const exporter = new FileExporter(dir, LogLevel.DEV)
    const ts = Date.now()
    exporter.export(makeMessage({ ts, type: 'error', level: 0, args: ['e'] }))
    exporter.export(makeMessage({ ts, type: 'info', level: 1, args: ['i'] }))
    exporter.export(makeMessage({ ts, type: 'warn', level: 2, args: ['w'] }))
    exporter.export(makeMessage({ ts, type: 'debug', level: 3, args: ['d'] }))

    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    const content = readFileSync(join(dir, files[0]!), 'utf8')
    assert.ok(content.includes('[ERROR]'))
    assert.ok(content.includes('[INFO]'))
    assert.ok(content.includes('[WARN]'))
    assert.ok(content.includes('[DEBUG]'))
  })

  test('PROD 模式:只落 error/info,丢弃 warn/debug', () => {
    const dir = makeTempDir()
    const exporter = new FileExporter(dir, LogLevel.PROD)
    const ts = Date.now()
    exporter.export(makeMessage({ ts, type: 'error', level: 0, args: ['e'] }))
    exporter.export(makeMessage({ ts, type: 'info', level: 1, args: ['i'] }))
    exporter.export(makeMessage({ ts, type: 'warn', level: 2, args: ['w'] }))
    exporter.export(makeMessage({ ts, type: 'debug', level: 3, args: ['d'] }))

    const content = readFileSync(join(dir, `dsh-connect-${localDateKey(ts)}.log`), 'utf8')
    assert.ok(content.includes('[ERROR]'))
    assert.ok(content.includes('[INFO]'))
    assert.ok(!content.includes('[WARN]'))
    assert.ok(!content.includes('[DEBUG]'))
  })

  test('未传 logLevel 时默认全量落盘(同 DEV)', () => {
    const dir = makeTempDir()
    const exporter = new FileExporter(dir)
    const ts = Date.now()
    exporter.export(makeMessage({ ts, type: 'debug', level: 3, args: ['d'] }))
    const content = readFileSync(join(dir, `dsh-connect-${localDateKey(ts)}.log`), 'utf8')
    assert.ok(content.includes('[DEBUG]'))
  })

  test('日志文件名按本地日期切分', () => {
    const dir = makeTempDir()
    const exporter = new FileExporter(dir, LogLevel.DEV)
    const ts = Date.now()
    exporter.export(makeMessage({ ts, args: ['hello'] }))
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.equal(files[0], `dsh-connect-${localDateKey(ts)}.log`)
  })

  test('内容包含级别、名字与参数', () => {
    const dir = makeTempDir()
    const exporter = new FileExporter(dir, LogLevel.DEV)
    const ts = Date.now()
    exporter.export(makeMessage({ ts, name: 'dsh-connect/server', args: ['端口 %d', 8080] }))
    const content = readFileSync(join(dir, `dsh-connect-${localDateKey(ts)}.log`), 'utf8')
    assert.ok(content.includes('[INFO]'))
    assert.ok(content.includes('[dsh-connect/server]'))
    // Logger.format 会把 %d 替换成 8080
    assert.ok(content.includes('端口 8080'))
  })

  test('Error 参数序列化为 stack 而非 {}', () => {
    const dir = makeTempDir()
    const exporter = new FileExporter(dir, LogLevel.DEV)
    const ts = Date.now()
    exporter.export(makeMessage({ ts, type: 'error', level: 0, args: [new Error('boom')] }))
    const content = readFileSync(join(dir, `dsh-connect-${localDateKey(ts)}.log`), 'utf8')
    assert.ok(content.includes('Error: boom'))
    assert.ok(!content.includes('{}'))
  })

  test('对象参数 JSON 序列化,循环引用兜底为 String()', () => {
    const dir = makeTempDir()
    const exporter = new FileExporter(dir, LogLevel.DEV)
    const ts = Date.now()
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    exporter.export(makeMessage({ ts, args: [{ b: 2 }, circular] }))
    const content = readFileSync(join(dir, `dsh-connect-${localDateKey(ts)}.log`), 'utf8')
    assert.ok(content.includes('{"b":2}'))
  })

  test('声明 levels 放开到 debug,否则 Cordis 默认阈值 1 会拦掉 warn/debug', () => {
    const exporter = new FileExporter(makeTempDir(), LogLevel.DEV)
    // Cordis 实际过滤:(levels[name] ?? levels.default ?? loggerLevel ?? 1) < level → 丢弃
    const threshold = (exporter as { levels?: Record<string, number> }).levels?.default
    assert.equal(threshold, 3)

    const levelOf = { error: 0, info: 1, warn: 2, debug: 3 } as const
    const passes = (type: keyof typeof levelOf): boolean =>
      (exporter as { levels?: Record<string, number> }).levels!.default! >= levelOf[type]
    assert.equal(passes('error'), true)
    assert.equal(passes('info'), true)
    assert.equal(passes('warn'), true) // 曾经被默认阈值 1 拦掉
    assert.equal(passes('debug'), true) // 曾经被默认阈值 1 拦掉
  })
})
