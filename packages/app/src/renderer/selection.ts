import { ALT_KEY } from "./platform.ts";

/** Modifier used to start a rectangle selection: ⌥ on macOS, Alt elsewhere. */
export const MODIFIER_LABEL = ALT_KEY;

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
