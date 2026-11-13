/**
 * Re-export of the shared splitter so `main/tts/*` keeps a single import path.
 * The implementation lives in `shared/` because the renderer needs exactly the
 * same sentence boundaries in order to highlight what is being spoken.
 */
export * from "../../shared/segment.ts";
