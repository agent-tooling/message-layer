# References

Local reference clones for inspiration and integration research.

Local reference clones for inspiration and integration research.

## electric-sql/electric

[ElectricSQL Electric](https://github.com/electric-sql/electric) — Postgres-native real-time sync engine.

Relevant for: live query subscriptions over HTTP (Shape API), partial replication, and sync protocol design.

```bash
# Clone locally (sparse, no blobs – source files only)
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/electric-sql/electric references/electric
```

The `references/electric/` directory is gitignored. Run the command above to materialise it locally.

## vercel-labs/json-render

[json-render](https://github.com/vercel-labs/json-render) — Generative UI framework. AI generates a JSON spec; the renderer maps it to typed, guardrailed components.

Relevant for: the `ui` message part type. Agents post a json-render spec as a message part; the Next.js client renders it via `@json-render/react` with custom shadcn-style components.

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/vercel-labs/json-render references/json-render
```

The `references/json-render/` directory is gitignored. Run the command above to materialise it locally.
