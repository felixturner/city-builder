/**
 * Shared high-score table - a Cloudflare Pages Function, deployed with the
 * site. Storage is the HIGHSCORES KV namespace (bound in the Pages project
 * settings), one JSON list under one key.
 *
 * GET  /api/scores          -> { scores: [{ name, score, ts }] } (top 20)
 * POST /api/scores          <- { name, score }, returns the updated top 20.
 *
 * Scores come from the client, so this can't be cheat-proof - it just refuses
 * the obviously fake: non-integers, negatives, and anything above a day of
 * survival seconds.
 */

const KEY = 'top'
const KEEP = 50 // stored; clients see the top 20
const SHOW = 20
const MAX_SCORE = 86400 // survival seconds in a day - nobody's run is longer
const MAX_NAME = 16

async function readScores(env) {
  if (!env.HIGHSCORES) return null // KV not bound yet
  return (await env.HIGHSCORES.get(KEY, 'json')) || []
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export async function onRequestGet({ env }) {
  const scores = await readScores(env)
  if (!scores) return json({ error: 'no storage bound' }, 503)
  return json({ scores: scores.slice(0, SHOW) })
}

export async function onRequestPost({ request, env }) {
  const scores = await readScores(env)
  if (!scores) return json({ error: 'no storage bound' }, 503)

  let body
  try { body = await request.json() } catch (e) { return json({ error: 'bad json' }, 400) }
  const score = body?.score
  const name = String(body?.name || '').trim().slice(0, MAX_NAME)
  if (!name || !Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
    return json({ error: 'bad score' }, 400)
  }

  scores.push({ name, score, ts: Date.now() })
  // Highest first; earlier submission wins ties.
  scores.sort((a, b) => b.score - a.score || a.ts - b.ts)
  scores.length = Math.min(scores.length, KEEP)
  await env.HIGHSCORES.put(KEY, JSON.stringify(scores))
  return json({ scores: scores.slice(0, SHOW) })
}
