import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getConfig } from './config/config.js'
import { createServer } from './server/server.js'
import { FileExporter, resolveLogDir } from './log/logger.js'

/**
 * dsh-connect 插件入口。
 *
 * 职责:
 *  1. 读取全局 config(单例 + env 解析)
 *  2. 按 logPath 配置注册文件日志 exporter(不配则不落盘)
 *  3. 启动 LAN WebSocket 代理服务(把任务转接给 dsh)
 *  4. 注册模型可见工具(暂保留脚手架 echo 示例)
 */
export const name = 'dsh-connect'
export const inject = ['tools']

export function apply(ctx: Context) {
  const logger = ctx.logger(name)
  const config = getConfig()

  logger.info('plugin loaded, config = %o', config)

  // 可选文件日志:配置了 logPath 才落盘,按天切分
  // PROD 模式只写 info/error;DEV/DEBUG 全量写
  const logDir = resolveLogDir(ctx, config.logPath)
  if (logDir) {
    const fileExporter = new FileExporter(logDir, config.logLevel)
    ctx.logger.exporter(fileExporter)
    logger.info('file logging enabled at %s (level=%s)', logDir, config.logLevel)
  }

  // 启动 WS 服务(生命周期绑定 ctx:插件卸载时自动关闭)
  const server = createServer(ctx, config)
  ctx.effect(() => () => {
    void server.dispose()
  }, 'dsh-connect.server')

  // 示例工具:保持原有 echo,验证插件工具注册链路
  ctx.tools.register(
    defineTool({
      name: 'dsh_connect',
      description: 'A tool scaffolded by dsh-dev.',
      parameters: {
        message: { type: 'string', description: 'Message to echo' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', required: true },
            echoed: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.echoed }],
      },
      async execute(args) {
        return { ok: true, echoed: args.message ?? 'Hello from dsh-connect!' }
      },
    }),
  )
}
