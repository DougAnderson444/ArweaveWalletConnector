import { is } from 'typescript-is'

import Emitter from './Emitter.js'

type ChannelController = {
	window?: Window | null,
	promise?: Promise<unknown>,
	resolve?: (value?: unknown) => void,
	reject?: (value?: unknown) => void,
}

export type Emitting = {
	message: {
		method: string
		params: unknown
		session?: number | string | undefined
	}
	builtin: { usePopup: boolean }
	| { keepPopup: boolean }
}

export default class Bridge extends Emitter<Emitting> {
	private _url: URL
	private _appInfo?: object
	private _iframeEl?: HTMLIFrameElement | null
	private _iframe: ChannelController = {}
	private _popup: ChannelController = {}
	private _usePopup: boolean = true
	private _keepPopup: boolean = false
	private _promiseController: {
		resolve: (value?: unknown) => void,
		reject: (reason?: unknown) => void
	}[] = []
	private _pending: number[] = []

	constructor(connectToUrl: URL, appInfo?: object) {
		super()
		this._appInfo = appInfo
		this._url = connectToUrl
		this._url.hash = new URLSearchParams({
			origin: window.location.origin,
			...this._appInfo,
			session: Math.random().toString().slice(2)
		}).toString()
		window.addEventListener('message', this.listener)
		this.openIframe()
	}

	get url() { return this._url?.origin }
	get usePopup() { return this._usePopup }
	get keepPopup() { return this._keepPopup }
	set keepPopup(keep: boolean) {
		this._keepPopup = keep
		this.emit('builtin', { keepPopup: keep })
		if (keep) { this.openPopup(true) }
		else { this.closePopup() }
	}



	private listener = (e: MessageEvent) => {
		if (e.source !== this._popup.window && e.source !== this._iframe?.window) { return }
		if (e.origin !== this._url?.origin) { return }
		if (typeof e.data !== 'object') { return }
		const { method, params, id, result, error, session } = e.data as { [key: string]: unknown }
		console.info(`WalletConnector:${e.source === this._popup.window ? 'popup' : 'iframe'}`, e.data)
		if (id != null) {
			if (typeof id !== 'number' && typeof id !== 'string') { return }
			if (typeof id === 'string' && isNaN(parseInt(id))) { return }
			if (!this._promiseController[+id]) { throw 'received result to nonexistent request' }
			this._pending = this._pending.filter(x => x != id)
			if (error != null) { this._promiseController[+id].reject(error) }
			if (result != null) { this._promiseController[+id].resolve(result) }
			return
		}
		if (typeof method !== 'string') { return }

		// reserved methods
		if (method === 'ready') {
			if (e.source === this._popup.window) { this._pending = []; this._popup.resolve?.() }
			if (e.source === this._iframe.window) { this._iframe.resolve?.() }
			return
		}
		if (method === 'change') { return }

		// verified methods
		if (method === 'usePopup') {
			if (typeof params !== 'boolean') { return }
			this._usePopup = params
		}
		if (method === 'keepPopup') {
			if (typeof params !== 'boolean') { return }
			this._keepPopup = params
			if (!params) { this.closePopup() }
		}
		const emitting = { method, params, session }
		if (!is<Emitting['message']>(emitting)) { return console.warn('dropped') }
		this.emit('message', emitting)
	}



	disconnect(options?: object) {
		this.closeIframe()
		this.closePopup(true)
		window.removeEventListener('message', this.listener)
	}

	postMessage(message: object, timeout?: number) {
		const id = this._promiseController.length
		const promise = new Promise((resolve, reject) => this._promiseController.push({ resolve, reject }))
			.finally(() => this.completeRequest())
		this.deliverMessage({ ...message, id })
		if (timeout) { setTimeout(() => this._promiseController[id].reject('timeout'), timeout) }
		return promise
	}

	private openIframe() {
		if (this._iframeEl) { return }
		this._iframeEl = document.createElement('iframe')
		this._iframeEl.src = this._url.toString()
		this._iframeEl.allow = 'usb'
		this._iframeEl.style.display = 'none'
		const promise = new Promise((resolve, reject) => this._iframe = { resolve, reject })
		this._iframe.promise = promise
		const injectIframe = () => {
			document.body.appendChild(this._iframeEl as Node)
			this._iframe.window = this._iframeEl?.contentWindow
		}
		if (document.readyState === 'complete' || document.readyState === 'interactive') { injectIframe() }
		else { document.addEventListener('DOMContentLoaded', injectIframe) }
	}

	private closeIframe() {
		if (!this._iframeEl) { return }
		this._iframeEl.src = 'about:blank'
		this._iframeEl.remove()
		this._iframeEl = undefined
		this._iframe.reject?.()
		this._iframe = {}
	}

	private showIframe() {

	}

	private openPopup(force?: boolean) {
		if (this._popup.window && !this._popup.window.closed) { this._popup.window.focus(); return }
		if (!this._usePopup && !force) { return }
		window.name = 'parent'
		const popupWindow = window.open(this._url.toString(), '_blank', 'location,resizable,scrollbars,width=400,height=600')
		const promise = new Promise((resolve, reject) => this._popup = { window: popupWindow, resolve, reject })
		this._popup.promise = promise
		const timer = setInterval(() => {
			if (this._popup.window && !this._popup.window.closed) { return }
			if (this.keepPopup) { this.keepPopup = false }
			clearInterval(timer)
		}, 200)
	}

	private closePopup(force?: boolean) {
		if (!this._popup.window || this._popup.window?.closed) { return }
		if (this._keepPopup && !force) { return }
		this._popup.window.location.href = 'about:blank'
		this._popup.window.close()
		this._popup.reject?.()
		this._popup = {}
	}

	completeRequest() { setTimeout(() => !this._pending.length && this.closePopup(), 100) }

	deliverMessage(message: any) {
		if (!this._url) { throw 'Missing URL' }
		const fullMessage = { ...message, jsonrpc: '2.0' }
		this.openIframe()
		this._iframe.promise = this._iframe.promise
			?.then(() => this._iframe.window?.postMessage(fullMessage, this._url.origin))
			.catch(() => { return })
		this.openPopup()
		this._popup.promise = this._popup.promise
			?.then(() => fullMessage.id != null && this._pending.push(fullMessage.id))
			.then(() => this._popup.window?.postMessage(fullMessage, this._url.origin))
			.catch(() => { return })
	}
}
