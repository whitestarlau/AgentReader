import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Markdown -> sanitized HTML for the exported document.
 *
 * The pipeline intentionally mirrors the renderer's `react-markdown` setup
 * (`remark-parse` + `remark-gfm`) so exported answers look like the app.
 * `rehype-sanitize` is not optional: without it `rehype-stringify` happily
 * emits `href="javascript:…"` from model output.
 */
const schema = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		// GFM task lists need the checkbox state; the default schema drops it.
		input: [...(defaultSchema.attributes?.input ?? []), "checked", "disabled", "type"],
	},
};

const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	// No allowDangerousHtml: raw HTML is dropped, matching react-markdown's default.
	.use(remarkRehype)
	.use(rehypeSanitize, schema)
	.use(rehypeStringify);

export function renderMarkdownToHtml(markdown: string): string {
	return processor.processSync(markdown).toString();
}
