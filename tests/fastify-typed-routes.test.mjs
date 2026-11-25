// Fastify in TypeScript: routes that give their type parameters first (app.post<{ Body: … }>('/x', …)) are
// endpoints like any other, and an app-wide addHook('onRequest', …) that turns callers away protects them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, scanAndBuild, readGraph, routeKeys, cleanup, openEndpoints } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

test('routes with type parameters are found, even when the types hold braces, semicolons and generics', () => {
  const r = extract([
    `import Fastify from 'fastify';`,
    `const app = Fastify();`,
    `app.get('/api/health', async () => ({ ok: true }));`,
    `app.post<{ Body: { message?: unknown; model?: unknown } }>("/api/chat", async (req, reply) => reply.send({}));`,
    `app.post<{ Params: { id: string }; Body: { action?: unknown } }>(`,
    `  "/api/orders/:id",`,
    `  async (req) => ({ ok: true }),`,
    `);`,
    `app.get<{ Querystring: { tags?: Array<string> } }>('/api/search', handler);`,
    `app.delete <{ Params: { id: string } }>('/api/notes/:id', handler);`,
  ].join('\n'), 'typescript', 'api/src/index.ts');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), [
    'GET /api/health', 'POST /api/chat', 'POST /api/orders/:id', 'GET /api/search', 'DELETE /api/notes/:id',
  ]);
  // a route's own path isn't a request this file makes
  assert.deepEqual(r.calls, []);
});

test('a typed request call in a website is still a request, not a route', () => {
  const r = extract([
    `const http = axios.create();`,
    `export const send = () => http.post<{ ok: boolean }>('/api/chat', { message: 'hi' });`,
  ].join('\n'), 'typescript', 'web/src/api.ts');
  assert.deepEqual(r.routes, []);
  assert.deepEqual(r.calls.map((c) => c.path), ['/api/chat']);
});

const arch = {
  project: { name: 'console', summary: 'Test fixture.' },
  nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'The sample server.', paths: ['**'] }],
};

/** Maps a one-repo Fastify app whose guards live in security.ts and are added by index.ts. */
function mapWith(security) {
  const root = makeProject({
    'package.json': JSON.stringify({ name: 'console', dependencies: { fastify: '^5.0.0' } }),
    'src/security.ts': security,
    'src/index.ts': [
      `import Fastify from 'fastify';`,
      `import { registerGuards } from './security.js';`,
      `const app = Fastify();`,
      `registerGuards(app);`,
      `app.post<{ Body: { message?: unknown } }>("/api/chat", async (req) => ({ ok: true }));`,
      `app.post("/api/settings", async (req) => ({ ok: true }));`,
      `app.listen({ port: 3000 });`,
    ].join('\n'),
  }, { repos: ['.'], arch });
  try {
    scanAndBuild(root);
    return readGraph(root);
  } finally {
    cleanup(root);
  }
}

const OPEN = ['POST /api/chat', 'POST /api/settings'];

test('typed routes reach the map and the open-endpoint check', () => {
  const graph = mapWith(`export function registerGuards(app) {}`);
  assert.deepEqual(routeKeys(graph), ['POST /api/chat', 'POST /api/settings']);
  assert.deepEqual(openEndpoints(graph), OPEN);
});

test('an onRequest hook that checks a token and replies 401 protects every route', () => {
  const graph = mapWith([
    `export function registerGuards(app) {`,
    `  app.addHook("onRequest", async (req, reply) => {`,
    `    if (req.headers["x-session-token"] !== TOKEN) return reply.code(401).send({ error: "bad token" });`,
    `  });`,
    `}`,
  ].join('\n'));
  assert.deepEqual(openEndpoints(graph), []);
  assert.ok(graph.health.appWide?.some((g) => g.file === 'src/security.ts'), JSON.stringify(graph.health.appWide));
});

test('a named hook counts when its name or its own code shows the check', () => {
  assert.deepEqual(openEndpoints(mapWith(`export function registerGuards(app) { app.addHook('preHandler', verifyToken); }`)), []);
  assert.deepEqual(openEndpoints(mapWith([
    `async function gate(req, reply) {`,
    `  if (!req.headers.authorization) return reply.status(403).send();`,
    `}`,
    `export function registerGuards(app) { app.addHook('onRequest', gate); }`,
  ].join('\n'))), []);
});

test('hooks that never turn a caller away are not a login check', () => {
  // logging, timing, and a hook that rejects for another reason (a bad host) leave the routes open
  for (const hook of [
    `app.addHook('onRequest', async (req) => { req.log.info({ url: req.url }); });`,
    `app.addHook('onRequest', logRequest);`,
    `app.addHook('onRequest', async (req, reply) => { if (req.url.length > 2000) return reply.code(414).send(); });`,
    `app.addHook('onSend', async (req, reply) => { if (!req.headers.authorization) reply.code(401); });`,
    `// app.addHook('onRequest', verifyToken);`,
  ]) assert.deepEqual(openEndpoints(mapWith(`export function registerGuards(app) {\n  ${hook}\n}`)), OPEN, hook);
});
