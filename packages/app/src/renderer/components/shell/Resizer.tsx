import { useEffect, useRef, useState } from "react";

/**
 * A draggable vertical splitter. Reports the horizontal pointer delta in
 * pixels as the user drags; the parent decides the sign and clamps the width.
 */
export function Resizer({ onResize }: { onResize: (dx: number) => void }) {
	const last = useRef(0);
	const callback = useRef(onResize);
	callback.current = onResize;
	const [dragging, setDragging] = useState(false);

	useEffect(() => {
		if (!dragging) return;
		const move = (e: PointerEvent) => {
			callback.current(e.clientX - last.current);
			last.current = e.clientX;
		};
		const up = () => setDragging(false);
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
	}, [dragging]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: 1px splitter handle
		<div
			className={`resizer${dragging ? " dragging" : ""}`}
			role="separator"
			aria-orientation="vertical"
			tabIndex={0}
			onPointerDown={(e) => {
				last.current = e.clientX;
				setDragging(true);
				e.preventDefault();
			}}
			onKeyDown={(e) => {
				if (e.key === "ArrowLeft") onResize(-16);
				else if (e.key === "ArrowRight") onResize(16);
			}}
		/>
	);
}
