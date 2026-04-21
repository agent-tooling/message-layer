# References

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
