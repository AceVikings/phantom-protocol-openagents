import { EventEmitter } from 'node:events'

/** Singleton bus — webhook server emits 'event', App subscribes. */
export const webhookBus = new EventEmitter()
webhookBus.setMaxListeners(20)
