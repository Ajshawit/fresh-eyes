<!-- fresh-eyes -->
<!-- head: 1111111111111111111111111111111111111111 -->
<!-- base: main -->
### Fresh-eyes review — `glm-5.3:cloud`

- **CRITICAL** `server/auth.js:12` — token compared with `==`, so a numeric-looking token passes.
- **HIGH** `server/auth.js:40` — session never expires.
- **HIGH** `server/db.js:9` — query built by string concatenation.
- **MEDIUM** `lib/util.js:3` — unused import.

VERDICT: REQUEST_CHANGES

<sub>Gates merging: anything but `VERDICT: APPROVE` fails this check.</sub>
