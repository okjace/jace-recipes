// Vercel serverless function: every /api/* request is rewritten here (see vercel.json).
import { handleApi } from '../lib/app.js';

export default function handler(req, res) {
  return handleApi(req, res);
}
