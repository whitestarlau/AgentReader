const isMac =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** Modifier used to start a rectangle selection: ⌥ on macOS, Alt elsewhere. */
export const MODIFIER_LABEL = isMac ? "⌥" : "Alt";

export type SelectionKind = "highlight" | "rect" | "ocr";

/** A piece of the document the user picked, ready to be injected into the AI context. */
export type Selection = {
	text: string;
	page: number;
	kind: SelectionKind;
};

export const SELECTION_LABEL: Record<SelectionKind, string> = {
	highlight: "选中",
	rect: "框选",
	ocr: "OCR",
};
