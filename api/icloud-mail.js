// Vercel function: https://<project>.vercel.app/api/icloud-mail
// The server is TypeScript (src/http/vercel.ts); `npm run vercel-build` bundles it before Vercel
// packages this function. See docs/CLOUD.md.
export { GET, POST, DELETE } from '../build/vercel/handler.mjs';
