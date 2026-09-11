# Contributing

Keep adapters independent of company-specific workflows, repositories, task names, and credentials. Use synthetic fixtures in tests.

Before submitting a change:

```bash
npm test
npm run release:check
```

Runtime protocol changes should include a focused fake-server test. IM changes should test identity checks, idempotency, message threading, attachment limits, and failure behavior when applicable.

