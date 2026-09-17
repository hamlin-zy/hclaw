/**
 * cron worker 线程入口 — 只做接线
 *
 * 引擎（SchedulerEngine）在独立模块中，端口由此处注入 parentPort。
 * 协议类型见 `@shared/types/schedule`。
 */
import {parentPort} from 'worker_threads'
import {SchedulerEngine} from './SchedulerEngine'
import type {SchedulerEngineInboundMessage} from '@shared/types/schedule'

const engine = new SchedulerEngine(parentPort!)

parentPort!.on('message', (msg: SchedulerEngineInboundMessage) => {
  engine.handleMessage(msg)
})
