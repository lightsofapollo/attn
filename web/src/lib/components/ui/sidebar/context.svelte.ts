import { IsMobile } from "$lib/hooks/is-mobile.svelte.js";
import { getContext, setContext } from "svelte";
import { SIDEBAR_KEYBOARD_SHORTCUT, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from "./constants.js";

type Getter<T> = () => T;

export type SidebarStateProps = {
	/**
	 * A getter function that returns the current open state of the sidebar.
	 * We use a getter function here to support `bind:open` on the `Sidebar.Provider`
	 * component.
	 */
	open: Getter<boolean>;

	/**
	 * A function that sets the open state of the sidebar. To support `bind:open`, we need
	 * a source of truth for changing the open state to ensure it will be synced throughout
	 * the sub-components and any `bind:` references.
	 */
	setOpen: (open: boolean) => void;
};

class SidebarState {
	readonly props: SidebarStateProps;
	open = $derived.by(() => this.props.open());
	openMobile = $state(false);
	setOpen: SidebarStateProps["setOpen"];
	#isMobile: IsMobile;
	state = $derived.by(() => (this.open ? "expanded" : "collapsed"));

	/** Current sidebar width in pixels during/after resize */
	widthPx = $state(0);
	/** Whether the user is actively dragging to resize */
	isResizing = $state(false);
	/** The CSS width string — uses pixel value if resized, otherwise the default CSS variable */
	sidebarWidth = $derived.by(() => this.widthPx > 0 ? `${this.widthPx}px` : "");

	constructor(props: SidebarStateProps) {
		this.setOpen = props.setOpen;
		this.#isMobile = new IsMobile();
		this.props = props;
	}

	get isMobile() {
		return this.#isMobile.current;
	}

	handleShortcutKeydown = (e: KeyboardEvent) => {
		if (e.key === SIDEBAR_KEYBOARD_SHORTCUT && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			this.toggle();
		}
	};

	setOpenMobile = (value: boolean) => {
		this.openMobile = value;
	};

	toggle = () => {
		return this.#isMobile.current
			? (this.openMobile = !this.openMobile)
			: this.setOpen(!this.open);
	};

	startResize = (e: PointerEvent) => {
		if (this.#isMobile.current) return;
		e.preventDefault();
		this.isResizing = true;

		// If we haven't captured a width yet, measure the current sidebar
		if (this.widthPx === 0) {
			const sidebarEl = document.querySelector('[data-slot="sidebar-container"]');
			if (sidebarEl) {
				this.widthPx = sidebarEl.getBoundingClientRect().width;
			}
		}

		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";

		const onPointerMove = (moveEvent: PointerEvent) => {
			const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, moveEvent.clientX));
			this.widthPx = newWidth;
		};

		const onPointerUp = () => {
			this.isResizing = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			document.removeEventListener("pointermove", onPointerMove);
			document.removeEventListener("pointerup", onPointerUp);
		};

		document.addEventListener("pointermove", onPointerMove);
		document.addEventListener("pointerup", onPointerUp);
	};
}

const SYMBOL_KEY = "scn-sidebar";

/**
 * Instantiates a new `SidebarState` instance and sets it in the context.
 *
 * @param props The constructor props for the `SidebarState` class.
 * @returns  The `SidebarState` instance.
 */
export function setSidebar(props: SidebarStateProps): SidebarState {
	return setContext(Symbol.for(SYMBOL_KEY), new SidebarState(props));
}

/**
 * Retrieves the `SidebarState` instance from the context. This is a class instance,
 * so you cannot destructure it.
 * @returns The `SidebarState` instance.
 */
export function useSidebar(): SidebarState {
	return getContext(Symbol.for(SYMBOL_KEY));
}
