export interface Config {
  port: number;
  appUrl: string;            // public URL of the studio, e.g. https://studio.vercel.app (email links, cookie security)
  allowedOrigins: string[];  // browser origins allowed to call state-changing endpoints
  production: boolean;
  cookieSecure: boolean;
  databaseUrl?: string;      // Postgres connection string (Vercel/Neon: DATABASE_URL or POSTGRES_URL)
  resendApiKey?: string;
  emailFrom: string;
  googleClientId?: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  aiDailyLimit: number;      // AI messages per user per UTC day
  // fs-slides (private slides) accepts tokens signed with this shared secret: openssl rand -base64 48
  slidesTokenSecret?: string;
  slidesTokenIssuer: string;
  slidesTokenAudience: string;
  // Any OpenAI-compatible chat endpoint (Ollama, vLLM, LM Studio). Used when no ANTHROPIC_API_KEY is set.
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
}

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // On Vercel, fall back to the production domain Vercel provides when APP_URL is not set.
  const vercelHost = opt(env.VERCEL_PROJECT_PRODUCTION_URL);
  const appUrl = (opt(env.APP_URL) ?? (vercelHost ? `https://${vercelHost}` : 'http://localhost:3000')).replace(/\/+$/, '');
  const extra = (opt(env.ALLOWED_ORIGINS) ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const deployHost = opt(env.VERCEL_URL); // this specific deployment (preview URLs)
  return {
    port: Number(opt(env.PORT) ?? 8080),
    appUrl,
    allowedOrigins: [new URL(appUrl).origin, ...(deployHost ? [`https://${deployHost}`] : []), ...extra],
    production: env.NODE_ENV === 'production',
    cookieSecure: appUrl.startsWith('https://'),
    databaseUrl: opt(env.DATABASE_URL) ?? opt(env.POSTGRES_URL) ?? opt(env.POSTGRES_PRISMA_URL),
    resendApiKey: opt(env.RESEND_API_KEY),
    emailFrom: opt(env.EMAIL_FROM) ?? 'Pathy <onboarding@resend.dev>',
    googleClientId: opt(env.GOOGLE_CLIENT_ID),
    anthropicApiKey: opt(env.ANTHROPIC_API_KEY),
    anthropicModel: opt(env.ANTHROPIC_MODEL) ?? 'claude-sonnet-5-5',
    aiDailyLimit: Number(opt(env.AI_DAILY_LIMIT) ?? 30),
    slidesTokenSecret: opt(env.SLIDES_TOKEN_SECRET),
    slidesTokenIssuer: opt(env.AUTH_ISSUER) ?? 'pathy-studio',
    slidesTokenAudience: opt(env.AUTH_AUDIENCE) ?? 'fs-slides',
    llmBaseUrl: opt(env.LLM_BASE_URL)?.replace(/\/+$/, ''),
    llmModel: opt(env.LLM_MODEL),
    llmApiKey: opt(env.LLM_API_KEY),
  };
}
