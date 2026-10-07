/**
 * `dsh-auto-workspace` — Host half.
 *
 * DSH resolves a new Session's working directory in exactly one place:
 *
 *     // @deepseek-ai/dsh-api-session-controller
 *     const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
 *
 * and `this.defaultCwd` is the Host process's own `process.cwd()`, captured
 * once when the Session Controller is constructed. The Web/Desktop client
 * always sends a `workspaceId`, so that fallback is normally dead — but any
 * caller that creates a chat *without* naming a project silently inherits the
 * directory DSH happened to be launched from.
 *
 * This plugin takes over that one fallback: a chat created with neither a
 * workspace nor a directory gets its own private directory under
 * `<root>/<YYYY-MM-DD>/<prefix>-NN/`, remembered per Session so reopening the
 * chat keeps working in the same place. It never registers a Workspace, so
 * these directories stay out of the sidebar's project list; DSH groups their
 * Sessions under its native "Ungrouped" bucket.
 *
 * Only Node builtins are imported: a plugin installed as a `link:`/`file:`
 * dependency is loaded through its real path, where no `node_modules` exists.
 *
 * @module dsh-auto-workspace
 */

import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'auto-workspace'

/** The Session Controller owns the single Session-creation entry point. */
export const inject = ['sessionController']

/** Human default root: `<home>/Documents/DSH` on every platform. */
export const DEFAULT_ROOT = join(homedir(), 'Documents', 'DSH')

/** Registry file name, stored inside the root it describes. */
const REGISTRY_FILE = '.dsh-auto-workspace.json'

/** Registry payload version. */
const REGISTRY_VERSION = 1

/** How many `chat-NN` names to try before giving up on a crowded date folder. */
const ALLOCATION_ATTEMPTS = 500

/**
 * Normalize the loader row's raw config. No schemastery schema is declared, so
 * unknown keys pass through harmlessly and every field is defaulted here.
 *
 * @param config - raw row config (may be undefined).
 * @returns resolved settings.
 */
function resolveConfig(config) {
	const raw = config !== null && typeof config === 'object' ? config : {}
	const root = typeof raw.root === 'string' && raw.root !== '' ? resolve(raw.root) : resolve(DEFAULT_ROOT)
	const prefix = typeof raw.directoryPrefix === 'string' && raw.directoryPrefix !== '' ? raw.directoryPrefix : 'chat'
	return {
		enabled: raw.enabled !== false,
		root,
		prefix,
		registryFile: typeof raw.registryFile === 'string' && raw.registryFile !== '' ? resolve(raw.registryFile) : join(root, REGISTRY_FILE)
	}
}

/** Two-digit zero padding. */
const pad = (value) => String(value).padStart(2, '0')

/**
 * Local calendar date used for the day folder.
 *
 * @param now - instant to format.
 * @returns `YYYY-MM-DD` in the Host's local time zone.
 */
function localDate(now) {
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * True when `candidate` is the root itself or lives underneath it.
 *
 * @param candidate - absolute path to test.
 * @param root - absolute root path.
 * @returns whether the path belongs to this plugin's tree.
 */
function isUnderRoot(candidate, root) {
	if (typeof candidate !== 'string' || candidate === '') return false
	const normalized = resolve(candidate)
	return normalized === root || normalized.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Escape a string for literal use inside a RegExp. */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Durable `SessionId -> directory` map, kept beside the directories it maps.
 * It is a convenience layer only: losing it costs one lookup, never a Session,
 * because the authoritative copy of a Session's directory is its own persisted
 * `SessionHeader.cwd`.
 */
class DirectoryRegistry {
	/** @param file - absolute path of the JSON registry file. */
	constructor(file) {
		this.file = file
		this.entries = new Map()
		this.loaded = false
		this.writeChain = Promise.resolve()
	}

	/** Read the registry once; a missing or damaged file yields an empty map. */
	async load() {
		if (this.loaded) return
		this.loaded = true
		try {
			const parsed = JSON.parse(await readFile(this.file, 'utf8'))
			const sessions = parsed !== null && typeof parsed === 'object' ? parsed.sessions : undefined
			if (sessions === null || typeof sessions !== 'object') return
			for (const [sessionId, entry] of Object.entries(sessions)) {
				if (entry !== null && typeof entry === 'object' && typeof entry.dir === 'string') this.entries.set(sessionId, entry.dir)
			}
		} catch {
			/* absent or damaged: start empty and rebuild lazily */
		}
	}

	/**
	 * @param sessionId - Session identity.
	 * @returns the remembered directory, if any.
	 */
	async get(sessionId) {
		await this.load()
		return this.entries.get(sessionId)
	}

	/**
	 * Remember one mapping and persist it.
	 *
	 * @param sessionId - Session identity.
	 * @param dir - its working directory.
	 */
	async set(sessionId, dir) {
		await this.load()
		if (this.entries.get(sessionId) === dir) return
		this.entries.set(sessionId, dir)
		await this.flush()
	}

	/** Serialize the current map, tolerating a read-only or vanished root. */
	async flush() {
		const payload = {
			version: REGISTRY_VERSION,
			sessions: Object.fromEntries([...this.entries].map(([sessionId, dir]) => [sessionId, { dir }]))
		}
		const file = this.file
		const text = `${JSON.stringify(payload, null, 2)}\n`
		this.writeChain = this.writeChain.then(async () => {
			try {
				await mkdir(dirname(file), { recursive: true })
				const temporary = `${file}.tmp`
				await writeFile(temporary, text, 'utf8')
				await rename(temporary, file)
			} catch {
				/* the registry is a cache: never fail a chat because it could not be written */
			}
		})
		await this.writeChain
	}
}

/**
 * Pick the next free `<prefix>-NN` directory inside one date folder and create
 * it. `mkdir` without `recursive` is the atomic reservation: a losing racer
 * gets `EEXIST` and moves on.
 *
 * @param dateDir - the day folder (created when missing).
 * @param prefix - directory name prefix, e.g. `chat`.
 * @returns the absolute path of the freshly created directory.
 */
async function allocateDirectory(dateDir, prefix) {
	await mkdir(dateDir, { recursive: true })
	const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`)
	let highest = 0
	try {
		for (const entry of await readdir(dateDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const match = pattern.exec(entry.name)
			if (match !== null) highest = Math.max(highest, Number(match[1]))
		}
	} catch {
		/* an unreadable day folder still gets attempts below */
	}
	for (let index = highest + 1; index <= highest + ALLOCATION_ATTEMPTS; index += 1) {
		const candidate = join(dateDir, `${prefix}-${String(index).padStart(2, '0')}`)
		try {
			await mkdir(candidate)
			return candidate
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error
		}
	}
	throw new Error(`auto-workspace: no free "${prefix}-NN" name under "${dateDir}" after ${ALLOCATION_ATTEMPTS} attempts`)
}

/** Remove a directory only when it is still empty; never destroy user work. */
async function removeIfEmpty(dir) {
	try {
		// `rmdir` fails on a non-empty directory, which is exactly the guard we
		// want: a directory that gained content is never reclaimed.
		if ((await readdir(dir)).length === 0) await rmdir(dir)
	} catch {
		/* best effort */
	}
}

/**
 * Mount the plugin.
 *
 * @param ctx - Host context carrying the Session Controller.
 * @param config - loader row config.
 */
export function apply(ctx, config) {
	const settings = resolveConfig(config)
	if (!settings.enabled) return
	const registry = new DirectoryRegistry(settings.registryFile)

	/**
	 * Read one Session's directory from its own persisted header — the
	 * authoritative copy — without activating an Agent.
	 *
	 * @param sessionId - Session identity.
	 * @returns the recorded `cwd`, or undefined when unavailable.
	 */
	async function persistedDirectory(sessionId) {
		const query = ctx.get('sessionQuery')
		if (query === undefined || typeof query.observeSession !== 'function') return undefined
		let observation
		try {
			observation = await query.observeSession(sessionId)
			const cwd = observation?.header?.cwd
			return typeof cwd === 'string' ? cwd : undefined
		} catch {
			return undefined
		} finally {
			try {
				await observation?.[Symbol.asyncDispose]?.()
			} catch {
				/* the observation is already unusable; nothing to release */
			}
		}
	}

	/**
	 * Resolve the directory a Session that names no project should own, reusing
	 * a remembered one whenever possible.
	 *
	 * @param sessionId - requested identity, when the caller preallocated one.
	 * @returns the directory plus whether this call created it.
	 */
	const directoryFor = async (sessionId) => {
		if (sessionId !== undefined) {
			const remembered = await registry.get(sessionId)
			if (remembered !== undefined) return { dir: remembered, created: false }
			const persisted = await persistedDirectory(sessionId)
			if (persisted !== undefined && isUnderRoot(persisted, settings.root)) {
				await registry.set(sessionId, persisted)
				return { dir: persisted, created: false }
			}
			// Unknown identity: hand out a fresh directory. A mismatched adopt then
			// fails loudly as `session/conflict` rather than silently pointing the
			// Session at the wrong tree.
			ctx.logger?.warn(`auto-workspace: no remembered directory for "${sessionId}"; allocating a new one`)
		}
		return { dir: await allocateDirectory(join(settings.root, localDate(new Date())), settings.prefix), created: true }
	}

	const controller = ctx.sessionController
	if (controller === undefined || typeof controller.create !== 'function') {
		ctx.logger?.warn('auto-workspace: sessionController.create is unavailable; plugin stays inert')
		return
	}

	/**
	 * The method this plugin displaced, resolved by {@link install}. Read late,
	 * because `create` is installed before its forward target is known.
	 */
	let forward

	/**
	 * Take over the Session Controller's project-less creation path only.
	 * Requests that name a Workspace or an explicit directory are untouched.
	 *
	 * @param request - the Remote `session.create` payload.
	 * @returns the Session Controller's own result.
	 */
	const create = async function create(request) {
		const input = request !== null && typeof request === 'object' ? request : {}
		if (input.workspaceId !== undefined || input.cwd !== undefined) return forward.previous.call(forward.owner, input)
		const { dir, created } = await directoryFor(input.sessionId)
		let result
		try {
			result = await forward.previous.call(forward.owner, { ...input, cwd: dir })
		} catch (error) {
			// Only a directory this very call created may be reclaimed, and only
			// while it is still empty.
			if (created) await removeIfEmpty(dir)
			throw error
		}
		const sessionId = result?.sessionId
		if (typeof sessionId === 'string') await registry.set(sessionId, dir)
		return result
	}

	/**
	 * Install the takeover on the first owner that accepts it. The service
	 * instance is the public choice; the command controller it delegates to is
	 * a plain object and the guaranteed fallback. Assigning to a non-writable
	 * accessor throws in strict mode, so every attempt is guarded: a future DSH
	 * that reworks either shape leaves the plugin inert with a warning instead
	 * of failing its activation.
	 *
	 * @returns the owner and displaced method, or undefined when neither took.
	 */
	const install = () => {
		const candidates = [controller]
		const commands = controller.commands
		if (commands !== undefined && typeof commands === 'object' && typeof commands.create === 'function') candidates.push(commands)
		for (const owner of candidates) {
			const previous = owner.create
			try {
				owner.create = create
			} catch {
				continue
			}
			if (owner.create === create) return { owner, previous }
		}
		return undefined
	}

	forward = install()
	if (forward === undefined) {
		ctx.logger?.warn('auto-workspace: could not take over session creation; plugin stays inert')
		return
	}
	ctx.logger?.info?.(`auto-workspace: project-less chats get their own directory under ${settings.root}`)

	ctx.effect(() => () => {
		if (forward.owner.create === create) forward.owner.create = forward.previous
	}, 'auto-workspace: restore the Session Controller creation path')
}

export default { name, inject, apply }
