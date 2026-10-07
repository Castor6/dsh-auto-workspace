/**
 * `dsh-auto-workspace` — browser half.
 *
 * DSH has no "no project" chat: the sidebar always resolves a new Session to a
 * Workspace (`startSession` falls back to the most recent one), and a blank
 * Session's composer hero offers only a Workspace picker. Sessions that end up
 * outside every Workspace are already supported — `groupByWorkspace` renders
 * them under the native "Ungrouped" bucket, and a Session that belongs to no
 * Workspace makes `storedChipTitle` undefined so the hero chip reads as the
 * picker placeholder instead of a folder name — so this half only has to add
 * the *entry* and the *inheritance rule*:
 *
 * 1. The hero picker gains a clear control whenever a Workspace is selected, so
 *    "which project?" can be answered with "none". Clearing starts (or reuses)
 *    a project-less Session; the Host half hands it its own directory.
 * 2. "New session" stays project-less when the current Session is project-less,
 *    and keeps inheriting the current project otherwise.
 * 3. The dead `+` on the "Ungrouped" group header — shipped DSH renders it but
 *    its handler is a no-op for that bucket — is wired to the same flow.
 *
 * The bundle is the lazy-CJS registration form `dsh-client-modules` serves, so
 * no build step is involved: `react`, `react-dom` and
 * `@deepseek-ai/dsh-client-ui-primitives` are shell-provided seed modules.
 *
 * @module dsh-auto-workspace/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-auto-workspace',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		const { useCallback, useEffect, useRef, useState } = React

		/** Services this half requires; cordis holds the plugin until all exist. */
		const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale']

		/** The shipped namespace whose picker this plugin extends. */
		const WORKSPACE_NS = 'workspace'

		/** This plugin's own namespace, for strings DSH has no key for. */
		const NS = 'auto-workspace'

		/** Menu id reserved for the folder row; the shipped sentinel is private. */
		const ADD_FOLDER = '\u0000auto-workspace:add-folder'

		/** Menu id of the "leave the project" row. */
		const NO_PROJECT = '\u0000auto-workspace:no-project'

		/**
		 * Render the native "not started yet" Hero for project-less chats.
		 *
		 * Shipped DSH only offers that screen to a Session that belongs to a
		 * Workspace: `ConversationMainPanel` disables the composer while
		 * `chipTitle === undefined`, and `chipTitle` is only ever a Workspace
		 * title. So a project-less chat is given a **sentinel Workspace** that
		 * exists only in this browser projection: it carries no Sessions, is
		 * never registered on the Host, and therefore is not a sidebar project —
		 * its one job is to give `pendingWorkspace` a title, selected once per
		 * project-less chat through the Hero's own picker callback.
		 *
		 * The sentinel does reach the sidebar's group list, which renders a row
		 * for every Workspace including empty ones. That single row is hidden by
		 * {@link hideSentinelGroup}: it is found by its text and its container by
		 * a class-name suffix, so a DSH redesign can make it visible again — a
		 * cosmetic leak, never a broken chat.
		 *
		 * Flipping this to `false` restores the previous behaviour: no sentinel,
		 * and the per-Session shell snapshot reports a project-less chat as
		 * content-bearing so its composer still works. That fallback loses the
		 * Hero but keeps the chat usable, so it is also what runs whenever the
		 * sentinel cannot be installed.
		 */
		const HERO_FOR_PROJECT_LESS = true

		/** Reserved client-only Workspace id; never sent to the Host. */
		const SENTINEL_ID = '\u0000dsh-auto-workspace:no-project'

		/** Ages the sentinel out of `recentWorkspace`, which otherwise may pick it. */
		const SENTINEL_CREATED_AT = '1970-01-01T00:00:00.000Z'

		const zh = {
			'action.noProject': '不在工作区中工作',
			'action.noProjectAria': '不在工作区中工作：在本机的自动目录中工作'
		}

		const en = {
			'action.noProject': 'Work without a project',
			'action.noProjectAria': 'Work without a project — in a private local directory'
		}

		const CSS = [
			// Two placements share this class. The hover badge replaces the project
			// chip's own folder glyph: the shell renders that chip (it is not a
			// slot), so the glyph is hidden and an identically sized, filled circle
			// is overlaid on its measured rect. The fallback placement is an
			// ordinary flow item ordered before the chip.
			'.dsh-auto-workspace-clear{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
			'flex:none;padding:0;border:none;border-radius:999px;cursor:pointer;',
			'background:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-bg-base)}',
			'.dsh-auto-workspace-clear:hover{background:var(--dsw-alias-label-secondary)}',
			'.dsh-auto-workspace-clear:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
			'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
			'.dsh-auto-workspace-clear.dsh-auto-workspace-overlay{position:fixed;z-index:20;margin:0}',
			'.dsh-auto-workspace-clear.dsh-auto-workspace-inline{order:-1;width:18px;height:18px;margin-right:2px}'
		].join('')

		/** Inject the plugin's stylesheet once per document. */
		function ensureStyles() {
			if (typeof document === 'undefined') return
			const tagId = 'dsh-auto-workspace/client.css'
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-auto-workspace'
			tag.dataset.pluginCss = tagId
			tag.textContent = CSS
			document.head.appendChild(tag)
		}

		// #region helpers

		/**
		 * A translate that falls back to English when the shipped key is missing
		 * in this build, so a renamed dictionary degrades to readable text
		 * instead of a raw key.
		 *
		 * @param t - namespace-bound translator from the slot kit.
		 * @param key - dictionary key.
		 * @param fallback - text to use when the key is absent.
		 * @returns display text.
		 */
		function shipped(t, key, fallback) {
			try {
				const value = t(key)
				return typeof value === 'string' && value !== '' && value !== key ? value : fallback
			} catch {
				return fallback
			}
		}

		/** The Session row the main pane currently shows, from public projections. */
		function mainSession(list) {
			return Object.values(list.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)
		}

		/** The Workspace that accounts for one Session, if any. */
		function owningWorkspace(workspaces, sessionId) {
			return workspaces.items.find((item) => item.sessionIds.includes(sessionId))
		}

		/** A Session that works outside every registered Workspace. */
		function isProjectLess(row, workspaces) {
			return row !== undefined && row.cwd !== undefined && owningWorkspace(workspaces, row.id) === undefined
		}

		/**
		 * The blank project-less Session a new "no project" chat should reuse,
		 * mirroring the native reuse-blank behaviour so repeated clicks do not
		 * pile up empty directories.
		 *
		 * @param list - current Session list snapshot.
		 * @param workspaces - current Workspace snapshot.
		 * @returns a reusable summary, or undefined when a fresh chat is needed.
		 */
		function reusableBlank(list, workspaces) {
			const archived = workspaces.archivedSessionIds ?? []
			for (const id of list.ids) {
				const row = list.byId[id]
				if (row === undefined || row.blank !== true) continue
				if (row.cwd === undefined || archived.includes(id)) continue
				if (owningWorkspace(workspaces, id) !== undefined) continue
				return row
			}
			return undefined
		}

		// #endregion

		// #region sentinel workspace

		/**
		 * Keep the sentinel Workspace's sidebar row hidden.
		 *
		 * `deriveGroups` pushes a group for every Workspace in the projection,
		 * including one with no Sessions, and there is no filtering seam: the
		 * sidebar and the conversation panel read the same snapshot, so the row
		 * cannot be withheld. It is hidden here instead — found by its title, its
		 * container located by the stable `groupSection` class-name suffix — and
		 * re-hidden after every mutation, because React restores the className it
		 * owns. The scan short-circuits on the sidebar's text, so the observer
		 * stays cheap while a conversation streams.
		 *
		 * @param titleOf - resolves the sentinel's display title, and its row's label.
		 * @returns a disposer stopping the observer.
		 */
		function hideSentinelGroup(titleOf) {
			if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {}
			let queued = null
			const sweep = () => {
				queued = null
				const title = titleOf()
				const root = document.querySelector('[data-slot="sidebar.workspaces"]')
				if (root === null || typeof root.textContent !== 'string' || !root.textContent.includes(title)) return
				for (const node of root.querySelectorAll('div, span')) {
					if (node.children.length !== 0 || node.textContent !== title) continue
					const group = node.closest('[class*="groupSection"]')
					if (group !== null && group.style.display !== 'none') group.style.display = 'none'
				}
			}
			const schedule = () => {
				if (queued !== null) return
				queued = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(sweep) : setTimeout(sweep, 16)
			}
			const observer = new MutationObserver(schedule)
			observer.observe(document.body, { childList: true, subtree: true })
			sweep()
			return () => {
				observer.disconnect()
				if (queued !== null) {
					if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(queued)
					else clearTimeout(queued)
				}
			}
		}

		// #endregion

		// #region conversation phase

		/**
		 * Shipped DSH cannot offer a usable composer to a Session that belongs to
		 * no Workspace. `ConversationMainPanel` disables it whenever
		 * `chipTitle === undefined`, and `chipTitle` is only ever a Workspace
		 * title — a Session outside every Workspace makes it undefined, which is
		 * why the hero shows "choose a workspace to start" and refuses input.
		 * Putting the Session under a Workspace is precisely the sidebar project
		 * this plugin must not create, so the gate is lifted from the other side:
		 * to the conversation shell, a project-less Session reports itself as
		 * content-bearing and renders the ordinary active composer.
		 *
		 * Only the per-Session shell snapshot is adjusted. The Session list keeps
		 * the real blankness, so sidebar visibility, the native blank-session
		 * reuse and this plugin's own reuse all stay on the shipped behaviour.
		 *
		 * @param shell - the client Session snapshot store.
		 * @param isProjectLess - live predicate for the owning Session.
		 */
		function activateProjectLessShell(shell, isProjectLess) {
			const original = shell.getSnapshot
			let source
			let applied
			let result
			shell.getSnapshot = function getSnapshot() {
				const next = original.call(shell)
				const shouldApply = isProjectLess()
				if (next === source && shouldApply === applied) return result
				source = next
				applied = shouldApply
				result = shouldApply ? { ...next, blank: false, awaitingFirstTurn: false } : next
				return result
			}
		}

		// #endregion

		// #region no-project flow

		/**
		 * Start or reopen a project-less chat and navigate to it. The Host half
		 * decides the directory: a reused blank keeps its own, a fresh one is
		 * allocated under the configured root.
		 *
		 * @param ctx - the plugin context.
		 * @returns the Session identity that became the main pane.
		 */
		async function startNoProject(ctx) {
			const reusable = reusableBlank(ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot())
			const sessionId =
				reusable === undefined
					? await ctx.sessions.create({})
					: await ctx.sessions.create({ sessionId: reusable.id, cwd: reusable.cwd })
			ctx.uiWorkspace.openSession(sessionId)
			return sessionId
		}

		/** Report a failure the way the shipped browser does, without a modal. */
		function reportFailure(error) {
			console.warn('dsh-auto-workspace: could not start a project-less chat:', error)
		}

		// #endregion

		// #region hero picker

		/**
		 * Replacement occupant for `conversation.hero.workspace`: the shipped
		 * menu plus one extra affordance — a clear control that turns "which
		 * project?" into "none", the only way DSH reaches a project-less chat
		 * from a blank Session.
		 *
		 * The shipped occupant cannot simply be wrapped. A slot occupant may only
		 * render child slots it declared itself, and a child slot name may be
		 * declared once, so a shadowing occupant cannot render this entry's
		 * `…directoryFlow` hole. Its sole occupant is a renderless flow that
		 * calls `pick()` and reports the path, so folder adoption is reproduced
		 * here by calling `ctx.uiWorkspace.pickDirectory()` directly — exactly
		 * what the shipped flow resolves to.
		 *
		 * @param props - the slot's owner share, standard hooks and this plugin's
		 * injected face.
		 * @returns the picker subtree.
		 */
		function AutoWorkspacePicker(props) {
			const { open, anchorRef, selectedId, onPick, onClose, useWorkspaces, t, createWorkspace, autoWorkspace } = props
			const snapshot = useWorkspaces((state) => state)
			const workspaces = snapshot.items ?? []
			const [pickingFolder, setPickingFolder] = useState(false)
			const [failure, setFailure] = useState(null)
			const [failureOpen, setFailureOpen] = useState(false)
			const [hoverBadge, setHoverBadge] = useState(null)
			// null until probed: the inline badge shows only when the swap is known
			// to be unavailable, so a successful probe never flashes it.
			const [swapAvailable, setSwapAvailable] = useState(null)
			const badgeRef = useRef(null)

			// The sentinel is not a project the user picked, so every "is a project
			// selected?" decision treats it as none.
			const projectId = selectedId === autoWorkspace.sentinelId ? undefined : selectedId

			const getAnchorRect = useCallback(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef])

			// The sentinel is present in the projection only while a project-less
			// chat occupies the Hero, so pointing this panel's own selection at it
			// is what gives `chipTitle` a value — and so keeps the Hero and its
			// composer. Navigating away drops the sentinel again, which makes the
			// panel's own effect clear the stale selection: a project Session
			// therefore never inherits it.
			useEffect(() => {
				if (!autoWorkspace.heroEnabled() || selectedId !== undefined || autoWorkspace.sentinelId === undefined) return undefined
				const row = mainSession(autoWorkspace.sessions())
				if (row === undefined || row.cwd === undefined) return undefined
				if (owningWorkspace(autoWorkspace.workspaces(), row.id) !== undefined) return undefined
				onPick(autoWorkspace.sentinelId)
				return undefined
			}, [selectedId, autoWorkspace, onPick])

			// Hovering the project chip swaps its folder glyph for the clear badge,
			// the way the reference does. The chip is shell-rendered and carries no
			// slot, so it is found structurally: it is the sibling immediately before
			// this plugin's own slot anchor, which the slot framework renders as
			// `div[data-slot="conversation.hero.workspace"]` with `display: contents`.
			// The glyph is hidden and a smaller badge is overlaid on its measured
			// rect. Nothing here depends on a label, so it survives a language switch
			// and a reworded dictionary.
			useEffect(() => {
				if (projectId === undefined || typeof document === 'undefined') return undefined
				let hiddenGlyph = null
				const findChip = () => {
					const anchor = document.querySelector('[data-slot="conversation.hero.workspace"]')
					if (anchor === null) return null
					for (let node = anchor.previousElementSibling; node !== null; node = node.previousElementSibling) {
						if (node.tagName === 'BUTTON') return node
					}
					return null
				}
				const restoreGlyph = () => {
					if (hiddenGlyph === null) return
					hiddenGlyph.style.visibility = ''
					hiddenGlyph = null
				}
				const place = (chip) => {
					const glyph = chip.querySelector('svg')
					if (glyph === null) return false
					const rect = glyph.getBoundingClientRect()
					if (rect.width === 0 && rect.height === 0) return false
					restoreGlyph()
					hiddenGlyph = glyph
					glyph.style.visibility = 'hidden'
					// A filled circle reads heavier than the line-art glyph it replaces,
					// so it is drawn smaller than the glyph box and centred on it, at the
					// size the hero row already gives its small icons.
					const size = Math.max(12, Math.round(Math.min(rect.width, rect.height) * 0.75))
					setHoverBadge({
						left: rect.left + (rect.width - size) / 2,
						top: rect.top + (rect.height - size) / 2,
						size
					})
					return true
				}
				const clear = () => {
					restoreGlyph()
					setHoverBadge(null)
				}
				const inside = (node, container) => container !== null && node instanceof Node && container.contains(node)
				const onOver = (event) => {
					if (hiddenGlyph !== null) return
					const chip = findChip()
					if (!inside(event.target, chip)) return
					setSwapAvailable(place(chip) || swapAvailable === true)
				}
				const onOut = (event) => {
					const chip = findChip()
					const badge = badgeRef.current
					if (!inside(event.target, chip) && !inside(event.target, badge)) return
					const next = event.relatedTarget
					if (inside(next, chip) || inside(next, badge)) return
					clear()
				}
				const onResize = () => {
					const chip = findChip()
					if (hiddenGlyph !== null && chip !== null) place(chip)
				}
				setSwapAvailable(findChip() !== null)
				document.addEventListener('pointerover', onOver, true)
				document.addEventListener('pointerout', onOut, true)
				window.addEventListener('resize', onResize)
				return () => {
					document.removeEventListener('pointerover', onOver, true)
					document.removeEventListener('pointerout', onOut, true)
					window.removeEventListener('resize', onResize)
					clear()
				}
			}, [projectId])

			// The sentinel is an implementation detail, never an offerable project.
			const items = workspaces.filter((workspace) => workspace.workspaceId !== autoWorkspace.sentinelId).map((workspace) => ({
				id: workspace.workspaceId,
				label: workspace.title === undefined || workspace.title === '' ? shipped(t, 'workspace.defaultName', 'Default') : workspace.title,
				icon: React.createElement(primitives.IconFolderCloseRegular, { size: 16 }),
				disabled: pickingFolder
			}))
			const footer = [
				{
					id: ADD_FOLDER,
					label: shipped(t, 'menu.addWorkspace', 'Add folder'),
					icon: React.createElement(primitives.IconPlusOutlineRegular, { size: 16 }),
					disabled: pickingFolder
				},
				// Offered only while a project is selected — that is the state it
				// leaves. Kept beside the folder row, matching the reference order.
				...(projectId === undefined
					? []
					: [
							{
								id: NO_PROJECT,
								label: autoWorkspace.noProjectLabel,
								icon: React.createElement(primitives.IconCloseOutlineRegular, { size: 16 }),
								disabled: pickingFolder
							}
						])
			]

			const closeFailure = () => {
				setFailureOpen(false)
				setFailure(null)
			}

			/**
			 * Ask the Host for a folder and adopt it as a Workspace, mirroring the
			 * shipped directory flow: a cancelled chooser reports nothing, a failed
			 * one opens the folder-error dialog whose retry reopens the chooser.
			 */
			const chooseFolder = useCallback(() => {
				onClose()
				setFailureOpen(false)
				setFailure(null)
				setPickingFolder(true)
				autoWorkspace
					.pickFolder()
					.then((path) => {
						if (typeof path !== 'string' || path === '') return undefined
						return createWorkspace({ path }).then((workspace) => onPick(workspace.workspaceId))
					})
					.catch((reason) => {
						setFailure(reason instanceof Error ? reason.message : String(reason))
						setFailureOpen(true)
					})
					.finally(() => {
						setPickingFolder(false)
					})
			}, [onClose, autoWorkspace, createWorkspace, onPick])

			const handleSelect = (id) => {
				if (id === ADD_FOLDER) {
					chooseFolder()
					return
				}
				if (id === NO_PROJECT) {
					onClose()
					autoWorkspace.startNoProject()
					return
				}
				onPick(id)
			}

			const menu = React.createElement(primitives.Menu, {
				open,
				anchor: null,
				items,
				footer,
				selectedId: projectId,
				onSelect: handleSelect,
				onClose,
				side: 'bottom',
				portal: true,
				getAnchorRect
			})

			// The clear control exists only while a Workspace is selected: with none
			// selected the shipped chip already reads as the picker placeholder.
			const leaveProject = () => {
				onClose()
				autoWorkspace.startNoProject()
			}
			const badge = (className, style, size) =>
				React.createElement(
					'button',
					{
						ref: badgeRef,
						type: 'button',
						className: `dsh-auto-workspace-clear ${className}`,
						style,
						title: autoWorkspace.noProjectLabel,
						'aria-label': autoWorkspace.noProjectAria,
						onClick: leaveProject
					},
					React.createElement(primitives.IconCloseOutlineRegular, { size })
				)
			// Hovering the chip swaps its folder glyph for the badge; the inline
			// placement stands in only when the chip could not be located at all.
			const clear =
				projectId === undefined
					? null
					: swapAvailable === false
						? badge('dsh-auto-workspace-inline', undefined, 12)
						: hoverBadge === null
							? null
							: badge(
									'dsh-auto-workspace-overlay',
									{
										left: `${String(hoverBadge.left)}px`,
										top: `${String(hoverBadge.top)}px`,
										width: `${String(hoverBadge.size)}px`,
										height: `${String(hoverBadge.size)}px`
									},
									Math.max(8, hoverBadge.size - 4)
								)

			const dialog = !failureOpen
				? null
				: React.createElement(
						primitives.Modal,
						{
							open: true,
							onClose: closeFailure,
							title: shipped(t, 'folderError.title', 'Folder unavailable'),
							closeLabel: shipped(t, 'close', 'Close'),
							footer: React.createElement(
								React.Fragment,
								null,
								React.createElement(
									primitives.Button,
									{ variant: 'outline', onClick: closeFailure },
									shipped(t, 'cancel', 'Cancel')
								),
								React.createElement(
									primitives.Button,
									{ variant: 'primary', onClick: chooseFolder },
									shipped(t, 'folderError.retry', 'Choose again')
								)
							)
						},
						React.createElement('div', { role: 'alert' }, failure)
					)

			return React.createElement(React.Fragment, null, menu, clear, dialog)
		}

		// #endregion

		// #region ungrouped group "+" bridge

		/**
		 * The accessible name the shipped sidebar gives the "Ungrouped" group's
		 * new-session button. Derived from the same locale service, so it follows
		 * a language switch; a missing dictionary simply yields no match and the
		 * button keeps its shipped (inert) behaviour.
		 *
		 * @param t - translator bound to the shipped `workspace` namespace.
		 * @returns the expected `aria-label`, or undefined when unavailable.
		 */
		function ungroupedNewSessionLabel(t) {
			try {
				const name = t('group.ungrouped')
				const template = t('actions.newSession.aria', { name })
				return typeof template === 'string' && template !== 'actions.newSession.aria' ? template : undefined
			} catch {
				return undefined
			}
		}

		/**
		 * Shipped DSH renders the "Ungrouped" group header's new-session button
		 * but its handler is `if (group.workspaceId !== void 0)`, and that bucket
		 * has no Workspace id — so the button is inert. There is no slot inside
		 * the group header to occupy, and replacing the whole sidebar browser
		 * would mean reimplementing it, so this narrow capture-phase listener
		 * gives that one button the project-less flow. A renamed label or a
		 * restructured header just stops matching, leaving native behaviour.
		 *
		 * @param ctx - the plugin context.
		 * @param t - translator bound to the shipped `workspace` namespace.
		 * @returns a disposer removing the listener.
		 */
		function bridgeUngroupedNewSession(ctx, t) {
			if (typeof document === 'undefined') return () => {}
			const onClick = (event) => {
				const target = event.target
				if (!(target instanceof Element)) return
				const button = target.closest('button[aria-label]')
				if (button === null) return
				const expected = ungroupedNewSessionLabel(t)
				if (expected === undefined || button.getAttribute('aria-label') !== expected) return
				event.preventDefault()
				event.stopPropagation()
				startNoProject(ctx).catch(reportFailure)
			}
			document.addEventListener('click', onClick, true)
			return () => document.removeEventListener('click', onClick, true)
		}

		// #endregion

		// #region activation

		/**
		 * Mount the browser half.
		 *
		 * @param ctx - client root context carrying the slot, Session, Workspace,
		 * navigation and locale services.
		 */
		function apply(ctx) {
			ensureStyles()
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'auto-workspace: dictionaries')
			const self = ctx.locale.bind(NS)
			const shippedT = ctx.locale.bind(WORKSPACE_NS)

			// The Hero's placeholder text lives in the conversation dictionary, and
			// doubles as the sentinel's title so the chip and the hidden sidebar row
			// read identically. Resolved on first use rather than here, so a
			// dictionary that settles after this plugin mounts is still honoured.
			let resolvedSentinelTitle
			const sentinelTitle = () => {
				if (resolvedSentinelTitle === undefined) {
					resolvedSentinelTitle = shipped(ctx.locale.bind('conversation'), 'hero.chooseWorkspace', 'Choose workspace')
				}
				return resolvedSentinelTitle
			}
			let heroForProjectLess = HERO_FOR_PROJECT_LESS

			const sessions = ctx.sessions
			const workspaces = ctx.workspaces

			// Project the sentinel only while the main Session is project-less: the
			// decision lives in the projection, so navigating to a project drops it
			// and the panel's own effect clears the stale selection instead of a
			// project Session inheriting a "no project" chip. Identity is cached per
			// (source, decision) pair, which `useSyncExternalStore` requires.
			const nativeWorkspaceSnapshot = workspaces.list.getSnapshot
			let lastSource
			let lastNeeded
			let lastSnapshot
			const workspaceSnapshot = function getSnapshot() {
				const source = nativeWorkspaceSnapshot.call(workspaces.list)
				const main = mainSession(sessions.list.getSnapshot())
				const needed =
					heroForProjectLess &&
					source.phase === 'ready' &&
					main !== undefined &&
					main.cwd !== undefined &&
					!source.items.some((workspace) => workspace.sessionIds.includes(main.id))
				if (source === lastSource && needed === lastNeeded) return lastSnapshot
				lastSource = source
				lastNeeded = needed
				const alreadyPresent = source.items.some((workspace) => workspace.workspaceId === SENTINEL_ID)
				lastSnapshot =
					needed && !alreadyPresent
						? {
								...source,
								items: [...source.items, { workspaceId: SENTINEL_ID, title: sentinelTitle(), path: '', sessionIds: [], createdAt: SENTINEL_CREATED_AT }]
							}
						: source
				return lastSnapshot
			}
			try {
				workspaces.list.getSnapshot = workspaceSnapshot
			} catch {
				/* a non-writable store falls through to the flag check below */
			}
			if (workspaces.list.getSnapshot !== workspaceSnapshot) {
				heroForProjectLess = false
				console.warn('dsh-auto-workspace: cannot project the sentinel workspace; the Hero stays off and the composer fallback applies')
			}
			ctx.effect(
				() => () => {
					if (workspaces.list.getSnapshot === workspaceSnapshot) workspaces.list.getSnapshot = nativeWorkspaceSnapshot
				},
				'auto-workspace: restore workspaces.list.getSnapshot'
			)
			if (heroForProjectLess) ctx.effect(() => hideSentinelGroup(sentinelTitle), 'auto-workspace: hide the sentinel workspace row')

			const autoWorkspace = {
				noProjectLabel: shipped(self, 'action.noProject', 'Work without a project'),
				noProjectAria: shipped(self, 'action.noProjectAria', 'Work without a project — in a private local directory'),
				sentinelId: SENTINEL_ID,
				heroEnabled: () => heroForProjectLess,
				sessions: () => sessions.list.getSnapshot(),
				workspaces: () => workspaces.list.getSnapshot(),
				startNoProject: () => startNoProject(ctx).catch(reportFailure),
				pickFolder: () => ctx.uiWorkspace.pickDirectory()
			}

			/**
			 * A Session is project-less while no Workspace accounts for it. The
			 * Workspace list must be settled first, or a project Session would be
			 * mistaken for one while the list is still loading.
			 *
			 * @param sessionId - Session identity.
			 * @returns whether the Session works outside every Workspace.
			 */
			const isProjectLessSession = (sessionId) => {
				const snapshot = workspaces.list.getSnapshot()
				if (snapshot.phase !== 'ready') return false
				const summary = sessions.list.getSnapshot().byId[sessionId]
				if (summary === undefined || summary.cwd === undefined) return false
				return owningWorkspace(snapshot, sessionId) === undefined
			}

			// The composer fallback, used only when the Hero path is off: report a
			// project-less Session as content-bearing so `ConversationMainPanel`
			// renders the ordinary active composer instead of an inert Hero. The
			// Session *list* keeps the real blankness, so sidebar visibility, the
			// native blank-session reuse and this plugin's own reuse are unaffected.
			const patchedShells = new WeakSet()
			const nativeBinding = sessions.binding
			if (typeof nativeBinding === 'function') {
				const binding = function binding(sessionId) {
					const value = nativeBinding.call(sessions, sessionId)
					const shell = value?.session
					if (shell !== undefined && typeof shell.getSnapshot === 'function' && !patchedShells.has(shell)) {
						patchedShells.add(shell)
						activateProjectLessShell(shell, () => isProjectLessSession(sessionId) && !heroForProjectLess)
					}
					return value
				}
				sessions.binding = binding
				ctx.effect(
					() => () => {
						if (sessions.binding === binding) sessions.binding = nativeBinding
					},
					'auto-workspace: restore sessions.binding'
				)
			} else {
				console.warn('dsh-auto-workspace: sessions.binding is unavailable; a project-less chat may ask for a workspace')
			}

			// The hero picker, shadowing the shipped occupant for this `single`
			// seat (lowest priority renders; the default priority is 0). The
			// shipped registration stays live, so the `…directoryFlow` hole it
			// declares and the renderless flow registered into it are untouched —
			// this occupant simply cannot render that hole, which is why it adopts
			// folders through the same `pickDirectory()` call that flow uses.
			ctx.slots.inject('conversation.hero.workspace', () =>
				ctx.slots.register(
					{
						name: 'conversation.hero.workspace',
						priority: -1,
						locale: WORKSPACE_NS,
						inject: () => ({
							createWorkspace: (input) => ctx.workspaces.create(input),
							autoWorkspace
						})
					},
					AutoWorkspacePicker
				)
			)

			// Inheritance: an explicit Workspace still wins, and a project-less
			// current Session now stays project-less instead of jumping to the
			// most recently active Workspace.
			const navigation = ctx.uiWorkspace
			const nativeStartSession = navigation.startSession
			const startSession = function startSession(workspaceId) {
				if (workspaceId === SENTINEL_ID) {
					autoWorkspace.startNoProject()
					return undefined
				}
				if (workspaceId !== undefined) return nativeStartSession.call(navigation, workspaceId)
				if (isProjectLess(mainSession(sessions.list.getSnapshot()), workspaces.list.getSnapshot())) {
					autoWorkspace.startNoProject()
					return undefined
				}
				return nativeStartSession.call(navigation, workspaceId)
			}
			navigation.startSession = startSession
			ctx.effect(
				() => () => {
					if (navigation.startSession === startSession) navigation.startSession = nativeStartSession
				},
				'auto-workspace: restore uiWorkspace.startSession'
			)

			// Pointing the panel's selection at the sentinel is what asks it for a
			// chip title; the sentinel is not a real Workspace, so navigation for it
			// is a no-op rather than a rejected promise (which would clear the very
			// selection that keeps the Hero alive).
			const nativeOpenWorkspace = navigation.openWorkspace
			const openWorkspace = function openWorkspace(workspaceId, beforeOpen) {
				if (workspaceId === SENTINEL_ID) return Promise.resolve(undefined)
				return nativeOpenWorkspace.call(navigation, workspaceId, beforeOpen)
			}
			navigation.openWorkspace = openWorkspace
			ctx.effect(
				() => () => {
					if (navigation.openWorkspace === openWorkspace) navigation.openWorkspace = nativeOpenWorkspace
				},
				'auto-workspace: restore uiWorkspace.openWorkspace'
			)

			ctx.effect(() => bridgeUngroupedNewSession(ctx, shippedT), 'auto-workspace: Ungrouped new-session bridge')
		}

		// #endregion

		exports.apply = apply
		exports.inject = inject
		return module.exports
	}
})

//# sourceMappingURL=client.js.map
