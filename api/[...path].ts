// Vercel Function: every /api/* request that is not handled by a static file lands here.
// The slide routes (/api/slides, /open, /tile, /upload) never do: the browser calls the rslides service directly
// (see VITE_RENDERING_API). All logic lives in ../server/src/handler.ts, shared with the Docker server.
import { loadConfig } from '../server/src/config.js';
import { createHandler, type Handler } from '../server/src/handler.js';

let handler: Handler | undefined;
const handle = (req: Request) => (handler ??= createHandler(loadConfig()))(req);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
