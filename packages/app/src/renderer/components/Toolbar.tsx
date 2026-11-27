import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icons.tsx";

/**
 * Building blocks for the reading toolbar.
 *
 * The first version stacked bordered groups side by side — page nav, view mode,
 * zoom, read-aloud, OCR — plus two sentences of hint text. On a 1200px window
 * that is six boxes for actions used once a month, and the one action used every
 * time (朗读) looked like just another box.
 *
 * The rule now: one flat row, the frequent action on the left, everything
 * occasional behind the ⋯ menu, no boxes and no instructions.
 */

export function ReaderToolbar({ children }: { children?: ReactNode }) {
	return <div className="editor-toolbar">{children}</div>;
}

export function ToolButton({
	icon,
	label,
	title,
	active,
	disabled,
	primary,
	onClick,
}: {
	icon?: IconName;
	label?: string;
	title: string;
	active?: boolean;
	disabled?: boolean;
	primary?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={`tb-btn${label ? "" : " icon-only"}${active ? " active" : ""}${primary ? " primary" : ""}`}
			title={title}
			aria-label={label ? undefined : title}
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
		>
			{icon ? <Icon name={icon} size={13} /> : null}
			{label ? <span>{label}</span> : null}
		</button>
	);
}

export function ToolSeparator() {
	return <span className="tb-sep" aria-hidden="true" />;
}

export function ToolSpacer() {
	return <span className="tb-spacer" />;
}

export type ToolMenuItem = {
	/** Items that share a section render under one small heading. */
	section?: string;
	label: string;
	/** Shortcut or note shown on the right, e.g. "0". */
	hint?: string;
	/** Renders a check mark: the item is the currently active choice. */
	checked?: boolean;
	disabled?: boolean;
	onSelect: () => void;
};

/**
 * Overflow menu. Either a label trigger (e.g. the zoom percentage) or the
 * bare ⋯ button. Closes on outside pointer down and on Escape.
 */
export function ToolMenu({
	title,
	label,
	items,
}: {
	title: string;
	label?: string;
	items: ToolMenuItem[];
}) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointer = (e: PointerEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", onPointer);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onPointer);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	let lastSection: string | undefined;
	return (
		<div className="tb-menu-wrap" ref={wrapRef}>
			<button
				type="button"
				className={`tb-btn${label ? "" : " icon-only"}`}
				title={title}
				aria-label={label ? undefined : title}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				{label ? <span>{label}</span> : <span className="tb-more">⋯</span>}
				{label ? <span className="tb-caret">▾</span> : null}
			</button>
			{open ? (
				<div className="tb-menu" role="menu">
					{items.map((item, i) => {
						const heading = item.section && item.section !== lastSection ? item.section : null;
						lastSection = item.section ?? lastSection;
						return (
							<Fragment key={`${item.section ?? ""}:${item.label}:${i}`}>
								{heading ? <div className="tb-menu-head">{heading}</div> : null}
								<button
									type="button"
									role={item.checked === undefined ? "menuitem" : "menuitemradio"}
									aria-checked={item.checked}
									className="tb-menu-item"
									disabled={item.disabled}
									onClick={() => {
										setOpen(false);
										item.onSelect();
									}}
								>
									<span className="tb-menu-check">{item.checked ? "✓" : ""}</span>
									<span className="tb-menu-label">{item.label}</span>
									{item.hint ? <span className="tb-menu-hint">{item.hint}</span> : null}
								</button>
							</Fragment>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
