// Unpaid catalog probe: for each candidate service, send ONE realistic request through our real mppx client
// (src/wallet.ts: polyfill:false, guarded fetch, tempo method on 4217, USDC.e-first ordering) via
// mppx.prepareRequest(), decode the selected challenge and classify it. payment.pay() is NEVER called.
// Also checks (free GETs) whether the service publishes machine-readable docs.
//
//   DRY_RUN=1 pnpm exec tsx scripts/probe-catalog.ts [filter] > runs/catalog-probe.json
import { config } from '../src/config.ts'
import { isSideEffectHost } from '../src/policy.ts'
import { mppx } from '../src/wallet.ts' // loads the key via the existing keychain loader; never printed

if (!config.dryRun) throw new Error('refusing to run without DRY_RUN=1')

type Probe = {
  id: string
  cap: string
  method?: string
  url: string
  body?: unknown
  docs?: string[]
}
const L = (svc: string) => `https://paywithlocus.com/mpp/${svc}.md` // Locus per-service docs
const LO = (svc: string) => `https://${svc}.mpp.paywithlocus.com/openapi.json`
const MPPDEV = 'mpp.dev registry' // docs only via the mpp.dev catalog entry

export const PROBES: Probe[] = [
  // search
  {
    id: 'firecrawl-search',
    cap: 'web search',
    url: 'https://firecrawl.mpp.tempo.xyz/v1/search',
    body: { query: 'MPP machine payments', limit: 5 },
    docs: ['https://docs.firecrawl.dev/features/search.md'],
  },
  {
    id: 'parallel',
    cap: 'web search',
    url: 'https://parallelmpp.dev/api/search',
    body: { objective: 'MPP machine payments', max_results: 3 },
    docs: ['https://parallelmpp.dev/openapi.json'],
  },
  {
    id: 'perplexity',
    cap: 'web search / answers',
    url: 'https://perplexity.mpp.paywithlocus.com/perplexity/search',
    body: { query: 'tallest building in Tokyo' },
    docs: [L('perplexity'), LO('perplexity')],
  },
  {
    id: 'brave',
    cap: 'web/news/image search',
    url: 'https://brave.mpp.paywithlocus.com/brave/news-search',
    body: { q: 'Tempo blockchain' },
    docs: [L('brave'), LO('brave')],
  },
  {
    id: 'tavily',
    cap: 'web search',
    url: 'https://tavily.mpp.paywithlocus.com/tavily/search',
    body: { query: 'Tempo blockchain' },
    docs: [L('tavily'), LO('tavily')],
  },
  {
    id: 'serper',
    cap: 'Google search/places/news',
    url: 'https://mpp.orthogonal.com/serper/search',
    body: { q: 'Tempo blockchain' },
    docs: ['https://mpp.orthogonal.com/llms.txt', 'https://mpp.orthogonal.com/serper/openapi.json'],
  },
  {
    id: 'glim',
    cap: 'X/Reddit/GitHub/web search',
    url: 'https://glim.sh/api/v1/reddit/search',
    body: { query: 'espresso machine' },
    docs: ['https://glim.sh/llms.txt', 'https://glim.sh/openapi.json'],
  },
  // scrape / extract / render
  {
    id: 'firecrawl',
    cap: 'scrape to markdown',
    url: 'https://firecrawl.mpp.tempo.xyz/v1/scrape',
    body: { url: 'https://example.com', formats: ['markdown'] },
    docs: ['https://firecrawl.mpp.tempo.xyz/llms.txt', 'https://docs.firecrawl.dev/llms.txt'],
  },
  {
    id: 'minibase',
    cap: 'URL to markdown',
    url: 'https://api.minibase.md/v1/convert',
    body: { url: 'https://example.com' },
    docs: ['https://api.minibase.md/llms.txt', 'https://api.minibase.md/openapi.json'],
  },
  {
    id: 'diffbot',
    cap: 'article extraction',
    url: 'https://diffbot.mpp.paywithlocus.com/diffbot/article',
    body: { url: 'https://example.com' },
    docs: [L('diffbot'), LO('diffbot')],
  },
  {
    id: 'browserbase',
    cap: 'browser fetch/search',
    url: 'https://mpp.browserbase.com/fetch',
    body: { url: 'https://example.com' },
    docs: ['https://docs.browserbase.com/llms.txt', 'https://mpp.browserbase.com/llms.txt'],
  },
  {
    id: 'screenshotone',
    cap: 'webpage screenshot',
    url: 'https://screenshotone.mpp.paywithlocus.com/screenshotone/take',
    body: { url: 'https://example.com' },
    docs: [L('screenshotone'), LO('screenshotone')],
  },
  {
    id: 'agent402',
    cap: 'screenshot/render/utils',
    method: 'GET',
    url: 'https://agent402.tools/api/screenshot?url=https%3A%2F%2Fexample.com',
    docs: ['https://agent402.tools/llms.txt', 'https://agent402.tools/openapi.json'],
  },
  // maps / weather / geo
  {
    id: 'mapbox',
    cap: 'geocode / static map',
    url: 'https://mapbox.mpp.paywithlocus.com/mapbox/geocode-forward',
    body: { q: 'Ferry Building, San Francisco' },
    docs: [L('mapbox'), LO('mapbox')],
  },
  {
    id: 'openweather',
    cap: 'weather',
    url: 'https://openweather.mpp.paywithlocus.com/openweather/current-weather',
    body: { lat: 37.7749, lon: -122.4194, units: 'metric' },
    docs: [L('openweather'), LO('openweather')],
  },
  {
    id: 'ipinfo',
    cap: 'IP geolocation',
    url: 'https://ipinfo.mpp.paywithlocus.com/ipinfo/ip-lite',
    body: { ip: '8.8.8.8' },
    docs: [L('ipinfo'), LO('ipinfo')],
  },
  // language / audio / music
  {
    id: 'deepl',
    cap: 'translation',
    url: 'https://deepl.mpp.paywithlocus.com/deepl/translate',
    body: { text: ['Hello world'], target_lang: 'DE' },
    docs: [L('deepl'), LO('deepl')],
  },
  {
    id: 'openai-tts',
    cap: 'text to speech',
    url: 'https://openai.mpp.tempo.xyz/v1/audio/speech',
    body: { model: 'tts-1', input: 'Hello from the agent.', voice: 'alloy' },
    docs: [
      'https://openai.mpp.tempo.xyz/llms.txt',
      'https://developers.openai.com/api/docs/llms.txt',
    ],
  },
  {
    id: 'deepgram',
    cap: 'TTS / transcription',
    url: 'https://deepgram.mpp.paywithlocus.com/deepgram/speak',
    body: { text: 'Hello from the agent.' },
    docs: [L('deepgram'), LO('deepgram')],
  },
  {
    id: 'suno-lyrics',
    cap: 'lyrics generation',
    url: 'https://suno.mpp.paywithlocus.com/suno/generate-lyrics',
    body: { prompt: 'a song about paying for APIs' },
    docs: [L('suno'), LO('suno')],
  },
  {
    id: 'suno-music',
    cap: 'music generation',
    url: 'https://suno.mpp.paywithlocus.com/suno/generate-music',
    body: { prompt: 'upbeat lofi jingle', customMode: false, instrumental: true, model: 'V4' },
    docs: [L('suno')],
  },
  {
    id: 'stablevoice',
    cap: 'TTS / voice clone',
    url: 'https://stablevoice.dev/api/speech',
    body: { text: 'Hello', model: 'chatterbox-turbo', format: 'mp3' },
    docs: ['https://stablevoice.dev/llms.txt', 'https://stablevoice.dev/openapi.json'],
  },
  // image / video
  {
    id: 'fal-schnell',
    cap: 'image gen (fast)',
    url: 'https://fal.mpp.tempo.xyz/fal-ai/flux/schnell',
    body: { prompt: 'a red fox, flat vector' },
    docs: [
      'https://fal.mpp.tempo.xyz/llms.txt',
      'https://fal.mpp.tempo.xyz/openapi.json',
      'https://fal.ai/docs/llms.txt',
      'https://mpp.tempo.xyz/openapi.json',
    ],
  },
  {
    id: 'fal-video',
    cap: 'video gen',
    url: 'https://fal.mpp.tempo.xyz/fal-ai/minimax/video-01',
    body: { prompt: 'a red fox running through snow' },
    docs: ['https://fal.ai/docs/llms.txt'],
  },
  {
    id: 'openai-image',
    cap: 'image gen',
    url: 'https://openai.mpp.tempo.xyz/v1/images/generations',
    body: { model: 'gpt-image-2', prompt: 'a red fox', size: '1024x1024' },
    docs: ['https://developers.openai.com/api/docs/llms.txt'],
  },
  {
    id: 'stability',
    cap: 'image gen / edit / bg removal',
    url: 'https://stability-ai.mpp.paywithlocus.com/stability-ai/generate-core',
    body: { prompt: 'a red fox, flat vector' },
    docs: [L('stability-ai'), LO('stability-ai')],
  },
  {
    id: 'replicate',
    cap: 'run any model',
    url: 'https://replicate.mpp.paywithlocus.com/replicate/run',
    body: {
      model_owner: 'black-forest-labs',
      model_name: 'flux-schnell',
      input: { prompt: 'a red fox' },
    },
    docs: [L('replicate'), LO('replicate')],
  },
  {
    id: 'stablestudio',
    cap: 'image/video gen (async)',
    url: 'https://stablestudio.dev/api/generate/nano-banana/generate',
    body: { prompt: 'a red fox, flat vector' },
    docs: ['https://stablestudio.dev/llms.txt', 'https://stablestudio.dev/openapi.json'],
  },
  {
    id: 'stablestudio-tempo',
    cap: '(wrong host guessed by agent)',
    url: 'https://stablestudio.mpp.tempo.xyz/api/generate/nano-banana/generate',
    body: { prompt: 'a red fox' },
    docs: ['https://stablestudio.mpp.tempo.xyz/llms.txt'],
  },
  {
    id: 'qr',
    cap: 'QR code image',
    method: 'GET',
    url: 'https://qr.ivan-tempo.xyz/api/qr?data=https%3A%2F%2Fmpp.dev',
    docs: ['https://qr.ivan-tempo.xyz/llms.txt', 'https://qr.ivan-tempo.xyz/openapi.json'],
  },
  // finance / crypto
  {
    id: 'alphavantage',
    cap: 'stock quotes/fundamentals',
    url: 'https://alphavantage.mpp.paywithlocus.com/alphavantage/global-quote',
    body: { symbol: 'AAPL' },
    docs: [L('alphavantage'), LO('alphavantage')],
  },
  {
    id: 'stablefinance',
    cap: 'financials / macro',
    method: 'GET',
    url: 'https://stablefinance.dev/api/financial-metrics/snapshot?ticker=AAPL',
    docs: ['https://stablefinance.dev/llms.txt', 'https://stablefinance.dev/openapi.json'],
  },
  {
    id: 'tako',
    cap: 'data search + charts',
    url: 'https://tako.com/api/mpp/v1/search',
    body: { query: 'US inflation rate' },
    docs: ['https://tako.com/.well-known/agent.md', 'https://tako.com/openapi.json'],
  },
  {
    id: 'coingecko',
    cap: 'crypto prices',
    url: 'https://coingecko.mpp.paywithlocus.com/coingecko/simple-price',
    body: { ids: 'bitcoin,ethereum', vs_currencies: 'usd' },
    docs: [L('coingecko'), LO('coingecko')],
  },
  {
    id: 'codex',
    cap: 'onchain token data',
    url: 'https://graph.codex.io/graphql',
    body: { query: '{ __typename }' },
    docs: ['https://docs.codex.io/llms.txt'],
  },
  {
    id: 'cryptonews',
    cap: 'crypto news',
    method: 'GET',
    url: 'https://cryptonews.ivan-tempo.xyz/api/news/latest?limit=5',
    docs: [
      'https://cryptonews.ivan-tempo.xyz/llms.txt',
      'https://cryptonews.ivan-tempo.xyz/openapi.json',
    ],
  },
  {
    id: 'edgar',
    cap: 'SEC XBRL facts',
    url: 'https://edgar.mpp.paywithlocus.com/edgar/company-facts',
    body: { cik: '0000320193' },
    docs: [L('edgar'), LO('edgar')],
  },
  {
    id: 'edgar-search',
    cap: 'SEC full-text search',
    url: 'https://edgar-search.mpp.paywithlocus.com/edgar-search/search',
    body: { q: 'stablecoin' },
    docs: [L('edgar-search'), LO('edgar-search')],
  },
  // compute / knowledge
  {
    id: 'judge0',
    cap: 'code execution',
    url: 'https://judge0.mpp.paywithlocus.com/judge0/execute-code',
    body: { source_code: 'print(2+2)', language_id: 71 },
    docs: [L('judge0'), LO('judge0')],
  },
  {
    id: 'wolfram',
    cap: 'computation / facts',
    url: 'https://wolframalpha.mpp.paywithlocus.com/wolframalpha/short-answer',
    body: { i: 'distance from Earth to Mars' },
    docs: [L('wolframalpha'), LO('wolframalpha')],
  },
  {
    id: 'mathpix',
    cap: 'math OCR',
    url: 'https://mathpix.mpp.paywithlocus.com/mathpix/process-image',
    body: { src: 'https://mathpix-ocr-examples.s3.amazonaws.com/cases_hw.jpg' },
    docs: [L('mathpix')],
  },
  // health / safety / gov data
  {
    id: 'rxatlas',
    cap: 'FDA drug products',
    method: 'GET',
    url: 'https://api.rxatlas.dev/v1/drugs?q=ibuprofen&limit=1',
    docs: ['https://rxatlas.dev/llms.txt', 'https://api.rxatlas.dev/openapi.json'],
  },
  {
    id: 'trialbase',
    cap: 'clinical trials',
    method: 'GET',
    url: 'https://api.trialbase-db.org/v1/trials?q=semaglutide&limit=1',
    docs: ['https://trialbase-db.org/llms.txt', 'https://api.trialbase-db.org/openapi.json'],
  },
  {
    id: 'recallradar',
    cap: 'product recalls',
    method: 'GET',
    url: 'https://api.recallradar.dev/v1/recalls?q=stroller&limit=1',
    docs: ['https://recallradar.dev/llms.txt', 'https://api.recallradar.dev/openapi.json'],
  },
  // real estate / vehicles / commerce
  {
    id: 'rentcast',
    cap: 'home value / rent',
    url: 'https://rentcast.mpp.paywithlocus.com/rentcast/value-estimate',
    body: { address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043' },
    docs: [L('rentcast'), LO('rentcast')],
  },
  {
    id: 'apex',
    cap: 'vehicle specs',
    method: 'GET',
    url: 'https://api.apex-db.org/v1/apex?q=tesla%20model%203&limit=1',
    docs: ['https://apex-db.org/llms.txt', 'https://api.apex-db.org/openapi.json'],
  },
  {
    id: 'kicksdb',
    cap: 'sneaker prices',
    method: 'GET',
    url: 'https://kicksdb.mpp.tempo.xyz/v3/stockx/products?query=jordan%201&limit=1',
    docs: ['https://kicksdb.mpp.tempo.xyz/llms.txt', 'https://docs.kicks.dev/llms.txt'],
  },
  {
    id: 'goflightlabs',
    cap: 'flight data',
    method: 'GET',
    url: 'https://goflightlabs.mpp.tempo.xyz/flight-info-by-flight-number?flight_number=UA1',
    docs: ['https://goflightlabs.mpp.tempo.xyz/llms.txt', MPPDEV],
  },
  {
    id: 'stabletravel',
    cap: 'flight search (read)',
    method: 'GET',
    url: 'https://stabletravel.dev/api/google-flights/search?departure_id=SFO&arrival_id=JFK&outbound_date=2026-11-12&type=2',
    docs: ['https://stabletravel.dev/llms.txt', 'https://stabletravel.dev/openapi.json'],
  },
  {
    id: 'builtwith',
    cap: 'website tech stack',
    url: 'https://builtwith.mpp.paywithlocus.com/builtwith/free',
    body: { LOOKUP: 'example.com' },
    docs: [L('builtwith'), LO('builtwith')],
  },
  // social
  {
    id: 'stablesocial',
    cap: 'TikTok/IG/X/Reddit data',
    url: 'https://stablesocial.dev/api/sc/tiktok/profile',
    body: { handle: 'nasa' },
    docs: ['https://stablesocial.dev/llms.txt', 'https://stablesocial.dev/openapi.json'],
  },
  {
    id: 'twitr',
    cap: 'X/Twitter search',
    url: 'https://twitr.sh/api/tools/x_search',
    body: { q: 'stablecoins' },
    docs: ['https://twitr.sh/llms.txt', 'https://twitr.sh/openapi.json'],
  },
  {
    id: 'stableenrich',
    cap: 'people/company/places enrich',
    url: 'https://stableenrich.dev/api/exa/search',
    body: { query: 'MPP machine payments' },
    docs: ['https://stableenrich.dev/llms.txt'],
  },
  // hosting / storage (public!)
  {
    id: 'storage',
    cap: 'object storage (R2)',
    method: 'PUT',
    url: 'https://storage.mpp.tempo.xyz/mpp-agent-probe-hello.txt',
    body: 'hello',
    docs: ['https://storage.mpp.tempo.xyz/llms.txt', 'https://mpp.tempo.xyz/llms.txt'],
  },
  {
    id: 'stableupload',
    cap: 'public file/site hosting',
    url: 'https://stableupload.dev/api/upload',
    body: { filename: 'hello.txt', contentType: 'text/plain', tier: '10mb' },
    docs: ['https://stableupload.dev/llms.txt', 'https://stableupload.dev/openapi.json'],
  },
  {
    id: 'pinata',
    cap: 'IPFS pinning (public)',
    url: 'https://mpp.pinata.cloud/v1/pin/public',
    body: { name: 'hello.txt', size: 5 },
    docs: ['https://mpp.pinata.cloud/llms.txt', 'https://docs.pinata.cloud/llms.txt'],
  },
  // LLM baseline (already used by the harness)
  {
    id: 'openrouter',
    cap: 'LLM (baseline)',
    url: 'https://openrouter.mpp.tempo.xyz/v1/chat/completions',
    body: {
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    },
    docs: [MPPDEV],
  },
  // second batch: extras and cheaper variants
  {
    id: 'storage-list',
    cap: 'object storage list',
    method: 'GET',
    url: 'https://storage.mpp.tempo.xyz/',
    docs: [MPPDEV],
  },
  {
    id: 'fal-stable-video',
    cap: 'image-to-video',
    url: 'https://fal.mpp.tempo.xyz/fal-ai/stable-video',
    body: { image_url: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg' },
    docs: ['https://fal.ai/docs/llms.txt'],
  },
  {
    id: 'fal-seedance-fast',
    cap: 'text-to-video (dynamic)',
    url: 'https://fal.mpp.tempo.xyz/bytedance/seedance-2.0/fast/text-to-video',
    body: { prompt: 'a red fox running through snow', duration: '5', resolution: '480p' },
    docs: ['https://fal.ai/docs/llms.txt'],
  },
  {
    id: 'fal-veo-lite',
    cap: 'text-to-video (dynamic)',
    url: 'https://fal.mpp.tempo.xyz/fal-ai/veo3.1-lite',
    body: {
      prompt: 'a red fox running through snow',
      duration: '4s',
      resolution: '720p',
      generate_audio: false,
    },
    docs: ['https://fal.ai/docs/llms.txt'],
  },
  {
    id: 'fal-elevenlabs',
    cap: 'TTS (ElevenLabs)',
    url: 'https://fal.mpp.tempo.xyz/fal-ai/elevenlabs/tts/eleven-v3',
    body: { text: 'Hello from the agent. This call cost a fraction of a cent.' },
    docs: ['https://fal.ai/docs/llms.txt'],
  },
  {
    id: 'fal-vector',
    cap: 'SVG vector gen',
    url: 'https://fal.mpp.tempo.xyz/fal-ai/recraft/v4.1/text-to-vector',
    body: { prompt: 'a minimalist fox logo' },
    docs: ['https://fal.ai/docs/llms.txt'],
  },
  {
    id: 'fal-recraft-v3',
    cap: 'image gen w/ text',
    url: 'https://fal.mpp.tempo.xyz/fal-ai/recraft-v3',
    body: { prompt: 'a poster that says HELLO' },
    docs: ['https://fal.ai/docs/llms.txt'],
  },
  {
    id: 'fal-trellis',
    cap: '3D (unlisted path?)',
    url: 'https://fal.mpp.tempo.xyz/fal-ai/trellis',
    body: { image_url: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg' },
    docs: ['https://fal.ai/docs/llms.txt'],
  },
  // Async queue (submit → status_url → wait_for). The host is fal-queue.mpp.tempo.xyz, not fal.mpp.tempo.xyz/fal-queue/ (404).
  // fal.mpp.tempo.xyz video paths now answer 400 "submit it to https://fal-queue.mpp.tempo.xyz/<same path> and poll the returned status_url".
  // Status/result GETs (/<model>/requests/<id>[/status]) are listed without x-payment-info in mpp.tempo.xyz/openapi.json.
  {
    id: 'fal-queue-kling',
    cap: 'video via queue (dynamic)',
    url: 'https://fal-queue.mpp.tempo.xyz/fal-ai/kling-video/v3/standard/text-to-video',
    body: { prompt: 'a red fox running', duration: '5' },
    docs: ['https://mpp.tempo.xyz/openapi.json'],
  },
  {
    id: 'fal-queue-grok',
    cap: 'text-to-video (async)',
    url: 'https://fal-queue.mpp.tempo.xyz/xai/grok-imagine-video/text-to-video',
    body: { prompt: 'a red fox running through snow' },
    docs: ['https://mpp.tempo.xyz/openapi.json'],
  },
  {
    id: 'fal-queue-h3max',
    cap: 'text-to-video (async)',
    url: 'https://fal-queue.mpp.tempo.xyz/minimax/h3-max/text-to-video',
    body: { prompt: 'a red fox running through snow', duration: 6 },
    docs: ['https://mpp.tempo.xyz/openapi.json'],
  },
  {
    id: 'openrouter-tts',
    cap: 'TTS via OpenRouter',
    url: 'https://openrouter.mpp.tempo.xyz/v1/audio/speech',
    body: { model: 'openai/gpt-4o-mini-tts', input: 'Hello from the agent.', voice: 'alloy' },
    docs: ['https://mpp.tempo.xyz/openapi.json'],
  },
  {
    id: 'openai-search',
    cap: 'web search (OpenAI)',
    url: 'https://openai.mpp.tempo.xyz/v1/alpha/search',
    body: { query: 'Tempo blockchain' },
    docs: ['https://mpp.tempo.xyz/openapi.json'],
  },
  {
    id: 'mapbox-static',
    cap: 'static map image',
    url: 'https://mapbox.mpp.paywithlocus.com/mapbox/static-image',
    body: { lon: -122.3937, lat: 37.7955, zoom: 14, width: 600, height: 400 },
    docs: [L('mapbox')],
  },
  {
    id: 'wolfram-simple',
    cap: 'Wolfram image answer',
    url: 'https://wolframalpha.mpp.paywithlocus.com/wolframalpha/simple',
    body: { i: 'population of France vs Germany' },
    docs: [L('wolframalpha')],
  },
  {
    id: 'glim-x',
    cap: 'X/Twitter search',
    url: 'https://glim.sh/api/v1/twitter/search',
    body: { query: 'stablecoins min_faves:100' },
    docs: ['https://glim.sh/llms.txt'],
  },
  {
    id: 'stablesocial-reddit',
    cap: 'Reddit search',
    url: 'https://stablesocial.dev/api/sc/reddit/search',
    body: { query: 'espresso machine' },
    docs: ['https://stablesocial.dev/llms.txt'],
  },
  {
    id: 'stableenrich-maps',
    cap: 'Google Maps places',
    url: 'https://stableenrich.dev/api/google-maps/text-search/partial',
    body: { textQuery: 'coffee near Ferry Building San Francisco' },
    docs: ['https://stableenrich.dev/llms.txt'],
  },
  {
    id: 'serper-places',
    cap: 'Google Places',
    url: 'https://mpp.orthogonal.com/serper/places',
    body: { q: 'coffee near Ferry Building San Francisco' },
    docs: [MPPDEV],
  },
  {
    id: 'kicksdb-goat',
    cap: 'sneaker prices (GOAT)',
    method: 'GET',
    url: 'https://kicksdb.mpp.tempo.xyz/v3/goat/products?query=jordan%201&limit=1',
    docs: ['https://docs.kicks.dev/llms.txt'],
  },
  {
    id: 'tako-viz',
    cap: 'chart from data',
    url: 'https://tako.com/api/mpp/v1/visualize',
    body: { csv: 'year,value\n2023,1\n2024,2', query: 'line chart' },
    docs: ['https://tako.com/openapi.json'],
  },
  {
    id: 'alphavantage-news',
    cap: 'market news sentiment',
    url: 'https://alphavantage.mpp.paywithlocus.com/alphavantage/news-sentiment',
    body: { tickers: 'AAPL' },
    docs: [L('alphavantage')],
  },
  {
    id: 'deepl-rephrase',
    cap: 'rewrite',
    url: 'https://deepl.mpp.paywithlocus.com/deepl/rephrase',
    body: { text: ['hello world'] },
    docs: [L('deepl')],
  },
  {
    id: 'agent402-render',
    cap: 'browser render',
    url: 'https://agent402.tools/api/render',
    body: { url: 'https://example.com' },
    docs: ['https://agent402.tools/openapi.json'],
  },
  {
    id: 'browserbase-search',
    cap: 'web search (Browserbase)',
    url: 'https://mpp.browserbase.com/search',
    body: { query: 'Tempo blockchain' },
    docs: ['https://docs.browserbase.com/llms.txt'],
  },
  {
    id: 'apibase-weather',
    cap: 'aggregator weather',
    url: 'https://apibase.pro/api/v1/tools/weather.get_current/call',
    body: { city: 'San Francisco' },
    docs: ['https://apibase.pro/llms.txt', 'https://apibase.pro/openapi.json'],
  },
  {
    id: 'myradar',
    cap: 'weather (MyRadar)',
    method: 'GET',
    url: 'https://agents.myradar.dev/zcj/lyf0eqi5gayq/openapi.json',
    docs: ['https://agents.myradar.dev/llms.txt'],
  },
  // Mercator top hits (x402-* crawled entries): are they payable by a Tempo-only client?
  {
    id: 'merc-skycast',
    cap: 'weather (Mercator #7)',
    method: 'GET',
    url: 'https://skycast.clawca.sh/weather?city=London',
  },
  {
    id: 'merc-nimbus',
    cap: 'weather (Mercator #5)',
    method: 'GET',
    url: 'https://nimbus.clawca.sh/weather?city=London',
  },
  {
    id: 'merc-shot',
    cap: 'screenshot (Mercator #2)',
    url: 'https://shot.halowerk.com/screenshot',
    body: { url: 'https://example.com' },
  },
  {
    id: 'merc-openverbs',
    cap: 'crypto (Mercator #1)',
    url: 'https://crypto.openverbs.com/v1/protocol',
    body: { chain: 'ethereum', protocol: 'uniswap' },
  },
  {
    id: 'merc-suede',
    cap: 'image/music (Mercator #1)',
    url: 'https://app.suedeai.ai/agent/image',
    body: { prompt: 'a red fox', aspectRatio: '1:1', outputFormat: 'png' },
  },
  {
    id: 'merc-x402node',
    cap: 'stocks (Mercator #2)',
    method: 'GET',
    url: 'https://api.x402node.dev/stock/cn-index',
  },
]

type Offer = {
  method: string
  intent: string
  chainId?: number
  currency?: string
  amount?: string
  usd?: number
  feePayer?: boolean
  network?: string
}
function decodeOffer(c: { method: string; intent: string; request: Record<string, any> }): Offer {
  const r = c.request,
    md = r.methodDetails ?? {}
  const dec = r.decimals ?? 6
  return {
    method: c.method,
    intent: c.intent,
    chainId: md.chainId,
    currency: r.currency ?? r.asset,
    amount: r.amount ?? r.maxAmountRequired,
    usd: r.amount != null ? Number(r.amount) / 10 ** dec : undefined,
    feePayer: md.feePayer,
    network: r.network,
  }
}

/** Raw, unpaid look at the 402 headers (for diagnosing parse errors / wrong network). */
async function rawHeaders(p: Probe, init: RequestInit) {
  const res = await mppx.rawFetch(p.url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  })
  const www = res.headers.get('www-authenticate'),
    x402 = res.headers.get('payment-required')
  let x402Networks: string[] | undefined
  if (x402)
    try {
      x402Networks = JSON.parse(Buffer.from(x402, 'base64').toString()).accepts?.map((a: any) =>
        `${a.network}:${a.asset ?? ''}`.slice(0, 60),
      )
    } catch {
      x402Networks = ['<undecodable>']
    }
  const mppMethods = www ? [...www.matchAll(/method="([^"]+)"/g)].map((m) => m[1]) : undefined
  const body = (await res.text()).slice(0, 200)
  return {
    httpStatus: res.status,
    hasWwwAuthenticate: !!www,
    hasPaymentRequired: !!x402,
    mppMethods,
    x402Networks,
    body,
  }
}

async function docsCheck(urls: string[] = []) {
  const out: Record<string, number | string> = {}
  for (const u of urls) {
    if (!u.startsWith('http')) {
      out[u] = 'registry'
      continue
    }
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(12000) })
      const t = await r.text()
      out[u] =
        r.ok && t.length > 200 && !/^\s*<!doctype html/i.test(t)
          ? r.status
          : `${r.status}${r.ok ? ' (html/empty)' : ''}`
    } catch {
      out[u] = 'error'
    }
  }
  return out
}

async function probe(p: Probe) {
  const method = p.method ?? (p.body !== undefined ? 'POST' : 'GET')
  const body =
    p.body === undefined ? undefined : typeof p.body === 'string' ? p.body : JSON.stringify(p.body)
  const headers: Record<string, string> = body
    ? { 'content-type': typeof p.body === 'string' ? 'text/plain' : 'application/json' }
    : {}
  const init: RequestInit = { method, headers, body }
  const host = new URL(p.url).host
  const base = { id: p.id, cap: p.cap, host, method, url: p.url }
  const docs = await docsCheck(p.docs)
  if (isSideEffectHost(host)) return { ...base, status: 'SKIPPED_SIDE_EFFECT', docs }
  const t0 = Date.now()
  try {
    const prepared = await mppx.prepareRequest(p.url, {
      ...init,
      signal: AbortSignal.timeout(25000),
    })
    const latencyMs = Date.now() - t0
    const hdr = {
      www: prepared.response.headers.has('www-authenticate'),
      x402: prepared.response.headers.has('payment-required'),
    }
    if (!prepared.payment) {
      const s = prepared.response.status
      const text = (await prepared.response.text()).slice(0, 240)
      const status =
        s >= 200 && s < 300
          ? 'FREE'
          : s === 401 || s === 403
            ? 'NEEDS_ACCOUNT'
            : s === 400 || s === 422
              ? 'NO_402_VALIDATION'
              : 'DEAD'
      return { ...base, status, httpStatus: s, latencyMs, headers: hdr, body: text, docs }
    }
    const pay = prepared.payment as any // never call pay.pay()
    void prepared.response.body?.cancel().catch(() => {}) // don't await: mppx may hold a tee of the body
    const selected = decodeOffer(pay.challenge)
    const offers = (pay.challenges ?? [pay.challenge]).map(decodeOffer)
    const ours =
      selected.method === 'tempo' &&
      selected.chainId === config.chain.id &&
      selected.currency?.toLowerCase() === config.token
    const status = ours
      ? 'PAYABLE'
      : selected.method === 'tempo'
        ? 'WRONG_TOKEN_OR_CHAIN'
        : 'WRONG_NETWORK'
    return {
      ...base,
      status,
      httpStatus: 402,
      latencyMs,
      quotedUsd: selected.usd,
      feePayer: !!selected.feePayer,
      selected,
      offers,
      headers: hdr,
      overCap: (selected.usd ?? 0) > config.budget.perCallUsd,
      docs,
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    const raw = await rawHeaders(p, init).catch((e) => ({ error: String(e) }))
    const r = raw as any
    const status = /timeout|aborted/i.test(msg)
      ? 'DEAD_TIMEOUT'
      : r.hasPaymentRequired && !r.hasWwwAuthenticate
        ? 'WRONG_NETWORK'
        : r.hasWwwAuthenticate || r.hasPaymentRequired
          ? 'PARSE_ERROR'
          : 'DEAD'
    return { ...base, status, error: msg.slice(0, 400), raw, latencyMs: Date.now() - t0, docs }
  }
}

const keepAlive = setInterval(() => {}, 1000) // unref'd abort timers alone don't hold the event loop open
const filter = process.argv[2]
const list = filter ? PROBES.filter((p) => p.id.includes(filter)) : PROBES
const results: unknown[] = []
const queue = [...list]
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let p; (p = queue.shift());) {
      const r = await probe(p)
      results.push(r)
      const x = r as any
      console.error(
        `${x.status.padEnd(20)} ${x.id.padEnd(18)} ${x.quotedUsd ?? ''} ${x.error ?? ''}`.slice(
          0,
          200,
        ),
      )
    }
  }),
)
console.log(
  JSON.stringify(
    {
      probedAt: new Date().toISOString(),
      mppx: '0.13.4',
      chainId: config.chain.id,
      token: config.token,
      results,
    },
    null,
    2,
  ),
)
clearInterval(keepAlive)
process.exit(0)
