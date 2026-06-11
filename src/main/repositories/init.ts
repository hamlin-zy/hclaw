/**
 * Database initialization module.
 * MUST be imported first before any other repository-dependent modules.
 *
 * Database initialization is synchronous and will block app startup if it fails.
 */
import {initDatabaseSync, runMigrations} from './sqlite'
import {createLogger} from '../agent/logger'

const logger = createLogger('db')

// Initialize database synchronously at import time
// If it fails, it throws an exception and blocks app startup
initDatabaseSync()
logger.info('init', {success: true, step: 'initDatabaseSync'})

// Run migrations synchronously
// If it fails, it throws an exception and blocks app startup
runMigrations()
logger.info('init', {success: true, step: 'runMigrations'})

logger.info('init', {success: true, message: 'database ready'})
