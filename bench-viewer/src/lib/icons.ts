/**
 * Favicon URLs for model authors and serving providers.
 *
 * OpenRouter's own model pages render company logos through Google's favicon
 * service keyed by the company's homepage — there is no icon field in its
 * public API. We do the same: a small curated slug → domain map, resolved to
 * the gstatic favicon endpoint. Unknown slugs return null and the chart falls
 * back to its plain circle mark, so a new model or provider degrades to
 * exactly the old rendering rather than a broken image.
 */

function favicon(domain: string): string {
	return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=64`;
}

/** Model-author slug (the part before the `/` in an OpenRouter model id). */
const AUTHOR_DOMAINS: Record<string, string> = {
	anthropic: 'anthropic.com',
	deepseek: 'deepseek.com',
	google: 'deepmind.google',
	'meta-llama': 'meta.com',
	mistralai: 'mistral.ai',
	moonshotai: 'moonshot.ai',
	nvidia: 'nvidia.com',
	openai: 'openai.com',
	qwen: 'qwen.ai',
	'x-ai': 'x.ai',
	'z-ai': 'z.ai'
};

/** OpenRouter provider display names, as they appear in run provenance. */
const PROVIDER_DOMAINS: Record<string, string> = {
	AkashML: 'akashml.com',
	Alibaba: 'alibabacloud.com',
	'Amazon Bedrock': 'aws.amazon.com',
	Anthropic: 'anthropic.com',
	BaseTen: 'baseten.co',
	Cerebras: 'cerebras.ai',
	CoreWeave: 'coreweave.com',
	DeepInfra: 'deepinfra.com',
	DigitalOcean: 'digitalocean.com',
	Fireworks: 'fireworks.ai',
	GMICloud: 'gmicloud.ai',
	Google: 'cloud.google.com',
	Groq: 'groq.com',
	Nebius: 'nebius.com',
	Novita: 'novita.ai',
	Nvidia: 'nvidia.com',
	OpenAI: 'openai.com',
	Parasail: 'parasail.io',
	Phala: 'phala.network',
	SambaNova: 'sambanova.ai',
	SiliconFlow: 'siliconflow.com',
	Together: 'together.ai',
	xAI: 'x.ai'
};

/** Favicon for a model id's author, or null when the author is not mapped. */
export function modelIcon(model: string | null | undefined): string | null {
	if (!model) return null;
	// Claude-backend runs record bare model names with no author prefix.
	const author = model.includes('/') ? model.split('/')[0] : 'anthropic';
	const domain = AUTHOR_DOMAINS[author];
	return domain ? favicon(domain) : null;
}

/**
 * Favicon for the provider named in a provenance string ("CoreWeave @ fp4"),
 * or null when the cell pools several providers — badging a mixed cell with
 * one provider's logo would attribute every run to it.
 */
export function providerIcon(provenance: string | null | undefined): string | null {
	if (!provenance || provenance.includes('+')) return null;
	const name = provenance.split('@')[0].trim();
	const domain = PROVIDER_DOMAINS[name];
	return domain ? favicon(domain) : null;
}
