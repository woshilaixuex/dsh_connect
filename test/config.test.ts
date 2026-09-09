import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogLevel } from '../src/log/logger.js'
import {
  getConfig,
  setConfig,
  resetConfig,
  DEFAULT_CONFIG,
} from '../src/config/config.js'

/**
 * config 单例单元测试。
 * 原则:每个用例前 resetConfig() + 清理 DSH_CONNECT_* env,保证用例间隔离。
 */

const ENV_KEYS = [
  'DSH_CONNECT_HOST', 'DSH_CONNECT_HOSTNAME', 'DSH_CONNECT_PORT',
  'DSH_CONNECT_LOG_LEVEL', 'DSH_CONNECT_LOG_PATH', 'DSH_CONNECT_CONFIG',
  'DSH_CONNECT_DOTENV',
]

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
  // 测试隔离:禁用插件根 .env 的自动注入,否则真实 .env 会污染用例
  process.env.DSH_CONNECT_DOTENV = '0'
}

beforeEach(() => {
  resetConfig()
  clearEnv()
})

describe('DEFAULT_CONFIG', () => {
  test('提供合理的默认值', () => {
    assert.equal(DEFAULT_CONFIG.hostName, '0.0.0.0')
    assert.equal(DEFAULT_CONFIG.listenPort, 8080)
    assert.equal(DEFAULT_CONFIG.logLevel, LogLevel.DEV)
  })
})

describe('getConfig', () => {
  test('无任何覆盖时返回默认值', () => {
    assert.deepEqual(getConfig(), DEFAULT_CONFIG)
  })

  test('是懒加载单例:多次调用返回同一对象', () => {
    const a = getConfig()
    const b = getConfig()
    assert.equal(a, b)
  })
})

describe('环境变量解析', () => {
  test('DSH_CONNECT_PORT 覆盖端口', () => {
    process.env.DSH_CONNECT_PORT = '9000'
    assert.equal(getConfig().listenPort, 9000)
  })

  test('DSH_CONNECT_HOST 覆盖 hostName(优先于 HOSTNAME)', () => {
    process.env.DSH_CONNECT_HOSTNAME = '0.0.0.0'
    process.env.DSH_CONNECT_HOST = '127.0.0.1'
    assert.equal(getConfig().hostName, '127.0.0.1')
  })

  test('DSH_CONNECT_LOG_LEVEL=debug 映射到 LogLevel.DEBUG', () => {
    process.env.DSH_CONNECT_LOG_LEVEL = 'debug'
    assert.equal(getConfig().logLevel, LogLevel.DEBUG)
  })

  test('非法端口回退默认值', () => {
    process.env.DSH_CONNECT_PORT = 'not-a-port'
    assert.equal(getConfig().listenPort, DEFAULT_CONFIG.listenPort)
  })

  test('越界端口(70000)回退默认值', () => {
    process.env.DSH_CONNECT_PORT = '70000'
    assert.equal(getConfig().listenPort, DEFAULT_CONFIG.listenPort)
  })

  test('非法 logLevel 回退默认值', () => {
    process.env.DSH_CONNECT_LOG_LEVEL = 'verbose'
    assert.equal(getConfig().logLevel, DEFAULT_CONFIG.logLevel)
  })
})

describe('本地配置文件', () => {
  test('配置文件可被 DSH_CONNECT_CONFIG 指定并生效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-connect-config-'))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ listenPort: 7777, logLevel: 'debug' }))
    process.env.DSH_CONNECT_CONFIG = file

    try {
      const config = getConfig()
      assert.equal(config.listenPort, 7777)
      assert.equal(config.logLevel, LogLevel.DEBUG)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('优先级', () => {
  test('env 覆盖文件配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-connect-config-'))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ listenPort: 7777 }))
    process.env.DSH_CONNECT_CONFIG = file
    process.env.DSH_CONNECT_PORT = '8888'

    try {
      assert.equal(getConfig().listenPort, 8888)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('setConfig', () => {
  test('运行时覆盖优先于 env', () => {
    process.env.DSH_CONNECT_PORT = '8888'
    setConfig({ listenPort: 9999 })
    assert.equal(getConfig().listenPort, 9999)
  })

  test('Partial 未提供的字段沿用当前值', () => {
    process.env.DSH_CONNECT_PORT = '8888'
    setConfig({ hostName: '10.0.0.1' })
    const config = getConfig()
    assert.equal(config.hostName, '10.0.0.1')
    assert.equal(config.listenPort, 8888)
  })
})

describe('resetConfig', () => {
  test('重置后重新从默认+env 计算', () => {
    setConfig({ listenPort: 9999 })
    assert.equal(getConfig().listenPort, 9999)
    resetConfig()
    assert.equal(getConfig().listenPort, DEFAULT_CONFIG.listenPort)
  })
})

describe('.env 加载', () => {
  test('DSH_CONNECT_DOTENV=0 时 .env 不注入(隔离生效)', () => {
    process.env.DSH_CONNECT_DOTENV = '0'
    resetConfig()
    // 即使插件根 .env 存在,禁用后也应回到纯默认
    assert.equal(getConfig().listenPort, DEFAULT_CONFIG.listenPort)
  })
})
