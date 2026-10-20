import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A draggable vertical splitter. Reports the horizontal pointer delta in
 * pixels as the user drags; the parent decides the sign and clamps the width.
 *
 * Listeners are attached synchronously inside pointerdown instead of from an
 * effect keyed on `dragging`: a fast release can happen before the effect
 * runs, which used to leave the splitter permanently in drag mode.
 */
export function Resizer({ onResize }: { onResize: (dx: number) => void }) {
	const last = useRef(0);
	const callback = useRef(onResize);
	callback.current = onResize;
	const [dragging, setDragging] = useState(false);
	const cleanup = useRef<(() => void) | null>(null);

	const stop = useCallback(() => {
		cleanup.current?.();
		cleanup.current = null;
		document.body.classList.remove("resizing");
		setDragging(false);
	}, []);

	// Never leave listeners or the body class behind if the splitter unmounts
	// mid-drag (e.g. the sidebar is closed with a keyboard shortcut).
	useEffect(
		() => () => {
			cleanup.current?.();
			cleanup.current = null;
			document.body.classList.remove("resizing");
		},
		[],
	);

	const start = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		e.preventDefault();
		stop();
		last.current = e.clientX;
		setDragging(true);
		// Make iframes (EPUB) transparent to hit-testing while dragging. They
		// are separate documents, so a pointerup released over one never reaches
		// this window and the drag would stick to the cursor.
		document.body.classList.add("resizing");
		const pointerId = e.pointerId;
		try {
			e.currentTarget.setPointerCapture(pointerId);
		} catch {}

		const move = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return;
			// If pointerup was lost (released over an iframe, outside the window,
			// or during a long task), a hover move with no buttons pressed means
			// the gesture is already over.
			if (ev.pointerType !== "touch" && ev.buttons === 0) {
				stop();
				return;
			}
			callback.current(ev.clientX - last.current);
			last.current = ev.clientX;
		};
		const end = (ev: PointerEvent) => {
			if (ev.pointerId === pointerId) stop();
		};
		const onBlur = () => stop();
		const onVisibility = () => {
			if (document.hidden) stop();
		};

		const opts = { capture: true } as const;
		window.addEventListener("pointermove", move, opts);
		window.addEventListener("pointerup", end, opts);
		window.addEventListener("pointercancel", end, opts);
		window.addEventListener("blur", onBlur);
		document.addEventListener("visibilitychange", onVisibility);
		cleanup.current = () => {
			window.removeEventListener("pointermove", move, opts);
			window.removeEventListener("pointerup", end, opts);
			window.removeEventListener("pointercancel", end, opts);
			window.removeEventListener("blur", onBlur);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: 1px splitter handle
		<div
			className={`resizer${dragging ? " dragging" : ""}`}
			role="separator"
			aria-orientation="vertical"
			tabIndex={0}
			onPointerDown={start}
			onKeyDown={(e) => {
				if (e.key === "ArrowLeft") onResize(-16);
				else if (e.key === "ArrowRight") onResize(16);
			}}
		/>
	);
}
