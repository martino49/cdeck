import log from 'electron-log/main'
import { app } from 'electron'
import { gzipSync } from 'node:zlib'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export function setupLogging(): void {
  log.transports.file.level = 'debug'
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.console.level = app.isPackaged ? false : 'debug'
  log.transports.file.archiveLogFn = (oldFile) => {
    try {
      const file = oldFile.toString()
      const gz = `${file.replace(/\.log$/, '')}.old.log.gz`
      writeFileSync(gz, gzipSync(readFileSync(file)))
      unlinkSync(file)
    } catch (err) {
      log.warn('log rotation failed', err)
    }
  }
  log.errorHandler.startCatching({ showDialog: false })
  log.eventLogger.startLogging()
  log.info('CDeck starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch
  })
}

export function logFilePath(): string {
  return log.transports.file.getFile().toString()
}

export default log