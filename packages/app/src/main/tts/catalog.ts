/**
 * Curated on-device models the app can fetch for the user.
 *
 * Only bundles whose licence we could actually read are listed, and the licence
 * is part of the UI: shipping an engine is fine, shipping weights trained on a
 * non-commercial dataset is not, so the user gets told before the download.
 */

export type ModelAsset = {
	/** `bundle` is a .tar.bz2 extracted into the model directory; `file` is kept as-is. */
	kind: "bundle" | "file";
	url: string;
	/** File name inside the temporary download directory. */
	name: string;
	/** Expected byte length, used for progress and integrity checks. */
	bytes: number;
};

export type ModelEntry = {
	id: string;
	name: string;
	/** Family passed to the sherpa adapter. */
	family: "vits" | "matcha" | "kokoro";
	lang: string;
	desc: string;
	/** Human-readable licence summary shown before downloading. */
	license: string;
	/** False when the weights' training data forbids commercial use. */
	commercial: boolean;
	sizeLabel: string;
	assets: ModelAsset[];
	/** For matcha bundles: the vocoder file name that must end up in the model dir. */
	vocoderName?: string;
};

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const TTS_MODELS: ModelEntry[] = [
	{
		id: "kokoro-zh",
		name: "Kokoro 多语言",
		family: "kokoro",
		lang: "zh-CN",
		desc: "82M 参数、int8 量化。103 个音色 = 中文 100 个（55 女声 + 45 男声）+ 3 个英语；音色与韵律比 VITS 系自然，速度约为实时的 1.2 倍。若听着有量化杂音，可换下面的高保真版。",
		license: "Apache-2.0（可商用）",
		commercial: true,
		sizeLabel: "147 MB",
		assets: [
			{
				kind: "bundle",
				url: `${RELEASE}/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2`,
				name: "kokoro-int8-multi-lang-v1_1.tar.bz2",
				bytes: 147_052_523,
			},
		],
	},
	{
		id: "melo-zh-en",
		name: "MeloTTS 中英混排",
		family: "vits",
		lang: "zh-CN",
		desc: "单女声，中英混排自然，适合大部分中文书。加载约 2 秒，4 线程合成速度约为实时的 4 倍。",
		license: "MIT（可商用）",
		commercial: true,
		sizeLabel: "167 MB",
		assets: [
			{
				kind: "bundle",
				url: `${RELEASE}/tts-models/vits-melo-tts-zh_en.tar.bz2`,
				name: "vits-melo-tts-zh_en.tar.bz2",
				bytes: 167_006_755,
			},
		],
	},
	{
		id: "matcha-zh-baker",
		name: "Matcha 中文（Baker）",
		family: "matcha",
		lang: "zh-CN",
		desc: "单女声，速度最快（约为实时的 20 倍以上），适合低配机器。需要额外下载 vocoder。",
		license: "训练数据仅限非商用",
		commercial: false,
		sizeLabel: "75 MB + 54 MB vocoder",
		vocoderName: "vocos-22khz-univ.onnx",
		assets: [
			{
				kind: "bundle",
				url: `${RELEASE}/tts-models/matcha-icefall-zh-baker.tar.bz2`,
				name: "matcha-icefall-zh-baker.tar.bz2",
				bytes: 75_463_556,
			},
			{
				kind: "file",
				url: `${RELEASE}/vocoder-models/vocos-22khz-univ.onnx`,
				name: "vocos-22khz-univ.onnx",
				bytes: 53_884_024,
			},
		],
	},
	{
		id: "kokoro-zh-hq",
		name: "Kokoro 中文（高保真）",
		family: "kokoro",
		lang: "zh-CN",
		desc: "同一模型的 fp32 版本：没有 int8 量化误差，声音更干净；体积、内存与合成耗时都约为 int8 版的 2.5 倍。适合对比「杂音是不是量化造成的」。",
		license: "Apache-2.0（可商用）",
		commercial: true,
		sizeLabel: "365 MB",
		assets: [
			{
				kind: "bundle",
				url: `${RELEASE}/tts-models/kokoro-multi-lang-v1_1.tar.bz2`,
				name: "kokoro-multi-lang-v1_1.tar.bz2",
				bytes: 364_855_331,
			},
		],
	},
	{
		id: "aishell3-multi",
		name: "AISHELL-3 多音色",
		family: "vits",
		lang: "zh-CN",
		desc: "174 个普通话说话人，体积只有 32MB：想换音色、比较男女声时最划算，语音偏朗读/新闻风格。",
		license: "AISHELL-3 语料（仅限非商用）",
		commercial: false,
		sizeLabel: "32 MB",
		assets: [
			{
				kind: "bundle",
				url: `${RELEASE}/tts-models/vits-icefall-zh-aishell3.tar.bz2`,
				name: "vits-icefall-zh-aishell3.tar.bz2",
				bytes: 31_559_701,
			},
		],
	},
];

export function getModel(id: string): ModelEntry | undefined {
	return TTS_MODELS.find((m) => m.id === id);
}

/** Default model when several are installed and the user has not chosen one. */
export const PREFERRED_MODEL_ID = "kokoro-zh";
